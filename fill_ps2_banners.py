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


def load_json(path: Path):
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_progress(path: Path) -> Progress:
    if not path.exists():
        return Progress(last_index=-1, banners_by_url={})

    try:
        raw = load_json(path)
        last_index = int(raw.get('last_index', -1))
        banners_by_url = raw.get('banners_by_url', {}) or {}
        # Ensure string keys/values
        banners_by_url = {str(k): str(v) for k, v in banners_by_url.items() if k and v}
        return Progress(last_index=last_index, banners_by_url=banners_by_url)
    except Exception:
        # If progress file is corrupted, don't block the run
        return Progress(last_index=-1, banners_by_url={})


def save_progress(path: Path, progress: Progress):
    save_json(path, {
        'last_index': progress.last_index,
        'banners_by_url': progress.banners_by_url,
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

        if not is_empty_banner(item.get('banner_url')):
            skipped += 1
            progress.last_index = i
            continue

        # Cached?
        if url in progress.banners_by_url:
            item['banner_url'] = progress.banners_by_url[url]
            updated += 1
            progress.last_index = i
            continue

        try:
            html = fetch_html(url, timeout=args.timeout)
            banner = extract_banner_url(html, url)
            if banner:
                item['banner_url'] = banner
                progress.banners_by_url[url] = banner
                updated += 1
                print(f'[{i}] OK  {item.get("title", "(no title)")} -> {banner}')
            else:
                failed += 1
                print(f'[{i}] NOIMG {item.get("title", "(no title)")} ({url})')
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
