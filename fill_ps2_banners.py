import argparse
import json
import re
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urljoin
from urllib.request import Request, urlopen


@dataclass
class Progress:
    last_index: int
    banners_by_url: Dict[str, str]
    downloads_by_url: Dict[str, int]
    ratings_by_url: Dict[str, float]
    reviews_by_url: Dict[str, int]


def load_json(path: Path):
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_progress(path: Path) -> Progress:
    if not path.exists():
        return Progress(last_index=-1, banners_by_url={}, downloads_by_url={}, ratings_by_url={}, reviews_by_url={})

    try:
        raw = load_json(path)
        last_index = int(raw.get('last_index', -1))
        banners_by_url = raw.get('banners_by_url', {}) or {}
        # Ensure string keys/values
        banners_by_url = {str(k): str(v) for k, v in banners_by_url.items() if k and v}

        downloads_by_url = raw.get('downloads_by_url', {}) or {}
        # Ensure ints
        safe_downloads: Dict[str, int] = {}
        for k, v in downloads_by_url.items():
            try:
                safe_downloads[str(k)] = int(v)
            except Exception:
                continue

        ratings_by_url = raw.get('ratings_by_url', {}) or {}
        safe_ratings: Dict[str, float] = {}
        for k, v in ratings_by_url.items():
            try:
                safe_ratings[str(k)] = float(v)
            except Exception:
                continue

        reviews_by_url = raw.get('reviews_by_url', {}) or {}
        safe_reviews: Dict[str, int] = {}
        for k, v in reviews_by_url.items():
            try:
                safe_reviews[str(k)] = int(v)
            except Exception:
                continue

        return Progress(
            last_index=last_index,
            banners_by_url=banners_by_url,
            downloads_by_url=safe_downloads,
            ratings_by_url=safe_ratings,
            reviews_by_url=safe_reviews,
        )
    except Exception:
        # If progress file is corrupted, don't block the run
        return Progress(last_index=-1, banners_by_url={}, downloads_by_url={}, ratings_by_url={}, reviews_by_url={})


def save_progress(path: Path, progress: Progress):
    save_json(path, {
        'last_index': progress.last_index,
        'banners_by_url': progress.banners_by_url,
        'downloads_by_url': progress.downloads_by_url,
        'ratings_by_url': progress.ratings_by_url,
        'reviews_by_url': progress.reviews_by_url,
    })


def fetch_html(url: str, timeout: int = 25) -> str:
    req = Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        method='GET'
    )
    with urlopen(req, timeout=timeout) as resp:
        # Attempt best-effort decoding
        content_type = resp.headers.get('Content-Type', '')
        charset_match = re.search(r'charset=([\w\-]+)', content_type, re.IGNORECASE)
        charset = charset_match.group(1) if charset_match else 'utf-8'
        body = resp.read()
        try:
            return body.decode(charset, errors='replace')
        except Exception:
            return body.decode('utf-8', errors='replace')


OG_IMAGE_RE_1 = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
OG_IMAGE_RE_2 = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
    re.IGNORECASE,
)
TWITTER_IMAGE_RE_1 = re.compile(
    r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
TWITTER_IMAGE_RE_2 = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image["\']',
    re.IGNORECASE,
)
WP_UPLOAD_IMAGE_RE = re.compile(
    r'https?://[^\s"\']+wp-content/uploads/[^"\']+\.(?:jpg|jpeg|png|webp)',
    re.IGNORECASE,
)

DOWNLOADS_RE = re.compile(r'\b([\d,]+)\s*downloads\b', re.IGNORECASE)
RATING_REVIEWS_RE = re.compile(r'\b([0-5](?:\.\d+)?)\s*\(\s*(\d+)\s*reviews?\s*\)', re.IGNORECASE)


def extract_banner_url(html: str, page_url: str) -> Optional[str]:
    for rx in (OG_IMAGE_RE_1, OG_IMAGE_RE_2, TWITTER_IMAGE_RE_1, TWITTER_IMAGE_RE_2):
        m = rx.search(html)
        if m:
            candidate = m.group(1).strip()
            if candidate:
                return urljoin(page_url, candidate)

    # Fallback: first wp-content upload image
    m2 = WP_UPLOAD_IMAGE_RE.search(html)
    if m2:
        return m2.group(0).strip()

    return None


def parse_int_with_commas(s: str) -> Optional[int]:
    if s is None:
        return None
    t = str(s).strip().replace(',', '')
    if not t:
        return None
    if not re.fullmatch(r'\d+', t):
        return None
    return int(t)


def extract_downloads(html: str) -> Optional[int]:
    m = DOWNLOADS_RE.search(html)
    if not m:
        return None
    return parse_int_with_commas(m.group(1))


def extract_rating_reviews(html: str):
    m = RATING_REVIEWS_RE.search(html)
    if not m:
        return None, None
    try:
        rating = float(m.group(1))
    except Exception:
        rating = None
    try:
        reviews = int(m.group(2))
    except Exception:
        reviews = None
    return rating, reviews


def is_empty_banner(val) -> bool:
    if val is None:
        return True
    s = str(val).strip()
    return s == ''


def main():
    ap = argparse.ArgumentParser(
        description='Fill banner_url fields in ps2.json by scraping each game url (e.g. romsfun pages).'
    )
    ap.add_argument('--input', default='ps2.json', help='Input JSON file (default: ps2.json)')
    ap.add_argument('--output', default='', help='Output JSON file. If empty, overwrites input.')
    ap.add_argument('--progress', default='ps2_banner_progress.json', help='Progress cache file (resume support)')
    ap.add_argument('--start', type=int, default=-1, help='Start index (overrides progress). -1 means resume from progress.')
    ap.add_argument('--limit', type=int, default=0, help='Max number of items to process (0 = all)')
    ap.add_argument('--delay', type=float, default=0.35, help='Delay between requests in seconds')
    ap.add_argument('--timeout', type=int, default=25, help='Request timeout in seconds')
    ap.add_argument('--save-every', type=int, default=25, help='Save progress every N successful updates')
    ap.add_argument('--sort-by-downloads', action='store_true', help='Sort output ps2.json by downloads (descending) at the end')
    ap.add_argument('--dry-run', action='store_true', help='Do not write output JSON; only writes progress file')

    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output) if args.output else input_path
    progress_path = Path(args.progress)

    data = load_json(input_path)
    if not isinstance(data, list):
        raise SystemExit('Input JSON must be a list of objects')

    progress = load_progress(progress_path)

    # Apply cached banners if we have them
    cached_apply = 0
    for item in data:
        if not isinstance(item, dict):
            continue
        url = str(item.get('url', '')).strip()
        if not url:
            continue
        if is_empty_banner(item.get('banner_url')) and url in progress.banners_by_url:
            item['banner_url'] = progress.banners_by_url[url]
            cached_apply += 1

        # Apply cached popularity fields if present
        if isinstance(item.get('game_info'), dict):
            if url in progress.downloads_by_url and item['game_info'].get('Downloads') is None:
                item['game_info']['Downloads'] = progress.downloads_by_url[url]
            if url in progress.ratings_by_url and item['game_info'].get('Rating') is None:
                item['game_info']['Rating'] = progress.ratings_by_url[url]
            if url in progress.reviews_by_url and item['game_info'].get('Reviews') is None:
                item['game_info']['Reviews'] = progress.reviews_by_url[url]

    if cached_apply:
        print(f'Applied {cached_apply} cached banners from {progress_path}')

    if args.start >= 0:
        start_index = args.start
    else:
        start_index = max(progress.last_index + 1, 0)

    end_index_exclusive = len(data)
    if args.limit and args.limit > 0:
        end_index_exclusive = min(end_index_exclusive, start_index + args.limit)

    print(f'Processing items {start_index}..{end_index_exclusive - 1} of {len(data)}')

    updated = 0
    skipped = 0
    failed = 0

    for i in range(start_index, end_index_exclusive):
        item = data[i]
        if not isinstance(item, dict):
            skipped += 1
            progress.last_index = i
            continue

        url = str(item.get('url', '')).strip()
        if not url:
            skipped += 1
            progress.last_index = i
            continue

        has_banner = not is_empty_banner(item.get('banner_url'))
        has_downloads = isinstance(item.get('game_info'), dict) and item.get('game_info', {}).get('Downloads') is not None

        # Skip only if we already have both banner and downloads populated
        if has_banner and has_downloads:
            skipped += 1
            progress.last_index = i
            continue

        # Cached?
        if (not has_banner) and url in progress.banners_by_url:
            item['banner_url'] = progress.banners_by_url[url]
            has_banner = True

        if isinstance(item.get('game_info'), dict) and (not has_downloads) and url in progress.downloads_by_url:
            item['game_info']['Downloads'] = progress.downloads_by_url[url]
            has_downloads = True

        if has_banner and has_downloads:
            updated += 1
            progress.last_index = i
            continue

        try:
            html = fetch_html(url, timeout=args.timeout)
            banner = extract_banner_url(html, url)
            downloads = extract_downloads(html)
            rating, reviews = extract_rating_reviews(html)

            did_update = False

            if banner and (not has_banner):
                item['banner_url'] = banner
                progress.banners_by_url[url] = banner
                did_update = True

            if isinstance(item.get('game_info'), dict):
                if downloads is not None and (item['game_info'].get('Downloads') is None):
                    item['game_info']['Downloads'] = downloads
                    progress.downloads_by_url[url] = downloads
                    did_update = True
                if rating is not None and (item['game_info'].get('Rating') is None):
                    item['game_info']['Rating'] = rating
                    progress.ratings_by_url[url] = rating
                    did_update = True
                if reviews is not None and (item['game_info'].get('Reviews') is None):
                    item['game_info']['Reviews'] = reviews
                    progress.reviews_by_url[url] = reviews
                    did_update = True

            if did_update:
                updated += 1
                msg_parts = []
                if banner:
                    msg_parts.append('banner')
                if downloads is not None:
                    msg_parts.append(f'downloads={downloads}')
                if rating is not None and reviews is not None:
                    msg_parts.append(f'rating={rating} reviews={reviews}')
                suffix = ' | '.join(msg_parts) if msg_parts else 'updated'
                print(f'[{i}] OK  {item.get("title", "(no title)")} -> {suffix}')
            else:
                failed += 1
                print(f'[{i}] NOUPD {item.get("title", "(no title)")} ({url})')
        except Exception as e:
            failed += 1
            print(f'[{i}] ERR {item.get("title", "(no title)")} ({url}) :: {e}')

        progress.last_index = i

        if args.delay and args.delay > 0:
            time.sleep(args.delay)

        if updated > 0 and (updated % args.save_every == 0):
            save_progress(progress_path, progress)
            if not args.dry_run:
                save_json(output_path, data)
            print(f'Saved progress @ index {progress.last_index} | updated={updated} failed={failed} skipped={skipped}')

    # Final save
    save_progress(progress_path, progress)

    if args.sort_by_downloads:
        def get_downloads(item_obj) -> int:
            if not isinstance(item_obj, dict):
                return 0
            gi = item_obj.get('game_info')
            if not isinstance(gi, dict):
                return 0
            try:
                return int(gi.get('Downloads') or 0)
            except Exception:
                return 0

        data.sort(key=lambda x: (get_downloads(x), str(x.get('title', '')).lower()), reverse=True)

    if not args.dry_run:
        save_json(output_path, data)

    print('Done.')
    print(f'updated={updated} skipped={skipped} failed={failed}')
    if args.dry_run:
        print('Dry-run: output JSON not written.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Interrupted by user.')
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
