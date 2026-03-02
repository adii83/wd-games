import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.request import Request, urlopen
from urllib.parse import urljoin


def load_json(path: Path):
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path: Path, data):
    with path.open('w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def normalize_url(url: str) -> str:
    u = (url or '').strip()
    if not u:
        return ''
    # normalize scheme + host casing
    u = re.sub(r'^http://', 'https://', u, flags=re.IGNORECASE)
    u = re.sub(r'^https://www\.', 'https://', u, flags=re.IGNORECASE)
    # strip fragments and trailing slash
    u = u.split('#', 1)[0].rstrip('/')
    return u


def fetch_html(url: str, timeout: int = 25, retries: int = 4, backoff: float = 1.2) -> str:
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = Request(
                url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                                  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                method='GET',
            )
            with urlopen(req, timeout=timeout) as resp:
                content_type = resp.headers.get('Content-Type', '')
                m = re.search(r'charset=([\w\-]+)', content_type, re.IGNORECASE)
                charset = m.group(1) if m else 'utf-8'
                body = resp.read()
                try:
                    return body.decode(charset, errors='replace')
                except Exception:
                    return body.decode('utf-8', errors='replace')
        except Exception as e:
            last_err = e
            if attempt < retries:
                sleep_s = backoff ** attempt
                print(f'WARN: fetch failed (attempt {attempt}/{retries}) {url} :: {e} | sleeping {sleep_s:.1f}s')
                time.sleep(sleep_s)

    raise last_err if last_err else RuntimeError('fetch_html failed')


# Match href links to PS2 ROM pages
ROM_LINK_RE = re.compile(
    r'href=["\'](?P<href>(?:https?://romsfun\.com)?/roms/playstation-2/[^"\']+?\.html)["\']',
    re.IGNORECASE,
)
LAST_PAGE_RE = re.compile(r'/browse-all-roms/page/(\d+)/[^"\'>\s]*', re.IGNORECASE)


def extract_rom_links_in_order(html: str, base_url: str) -> List[str]:
    links: List[str] = []
    seen: Set[str] = set()
    for m in ROM_LINK_RE.finditer(html):
        href = m.group('href')
        abs_url = href
        if abs_url.startswith('/'):
            abs_url = urljoin(base_url, abs_url)
        abs_url = normalize_url(abs_url)
        if not abs_url:
            continue
        if abs_url in seen:
            continue
        seen.add(abs_url)
        links.append(abs_url)
    return links


def detect_last_page(html: str) -> Optional[int]:
    # Pagination links can contain encoded ampersands (&amp;) or extra params.
    # We only trust page numbers from links that mention both consoles[0]=8 and sort=popular.
    pages: List[int] = []
    for m in LAST_PAGE_RE.finditer(html):
        try:
            page_num = int(m.group(1))
        except Exception:
            continue

        # Check nearby text for the required filters
        snippet = html[max(0, m.start() - 120): m.end() + 120]
        snippet_l = snippet.lower()
        if 'consoles%5b0%5d=8' in snippet_l and 'sort=popular' in snippet_l:
            pages.append(page_num)

    return max(pages) if pages else None


def main():
    ap = argparse.ArgumentParser(
        description='Reorder ps2.json to match ROMSFUN browse-all-roms popular ordering (console=PS2 sort=popular).'
    )
    ap.add_argument('--input', default='ps2.json', help='Input ps2 JSON file (default: ps2.json)')
    ap.add_argument('--output', default='', help='Output file path (default: overwrite input)')
    ap.add_argument('--delay', type=float, default=0.2, help='Delay between page requests in seconds')
    ap.add_argument('--timeout', type=int, default=25, help='Timeout per request in seconds')
    ap.add_argument('--max-pages', type=int, default=0, help='Max pages to crawl (0 = auto from last-page link)')
    ap.add_argument('--write-rank', action='store_true', help='Write Popularity Rank into game_info')

    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output) if args.output else input_path

    data = load_json(input_path)
    if not isinstance(data, list):
        raise SystemExit('ps2.json must be a list of objects')

    # Build lookup of our existing URLs
    our_urls: Set[str] = set()
    for item in data:
        if isinstance(item, dict):
            our_urls.add(normalize_url(str(item.get('url', ''))))
    our_urls.discard('')

    base = 'https://romsfun.com/browse-all-roms/?q&consoles%5B0%5D=8&sort=popular'
    print(f'Crawling popular listing: {base}')

    html1 = fetch_html(base, timeout=args.timeout)
    last_page = detect_last_page(html1)
    if args.max_pages and args.max_pages > 0:
        max_pages = args.max_pages
    else:
        max_pages = last_page or 1

    print(f'Detected last page: {last_page} | max_pages={max_pages}')

    rank_by_url: Dict[str, int] = {}
    rank = 1

    def process_page_html(html: str, page_url: str):
        nonlocal rank
        links = extract_rom_links_in_order(html, page_url)
        for link in links:
            if link in rank_by_url:
                continue
            if link in our_urls:
                rank_by_url[link] = rank
                rank += 1

    process_page_html(html1, base)

    # Crawl subsequent pages
    for page in range(2, max_pages + 1):
        if len(rank_by_url) >= len(our_urls):
            break
        page_url = f'https://romsfun.com/browse-all-roms/page/{page}/?q&consoles%5B0%5D=8&sort=popular'
        try:
            html = fetch_html(page_url, timeout=args.timeout)
            process_page_html(html, page_url)
            if page % 10 == 0:
                print(f'Page {page}/{max_pages} | matched {len(rank_by_url)}/{len(our_urls)}')
        except Exception as e:
            print(f'WARN: failed page {page}: {e}')

        if args.delay and args.delay > 0:
            time.sleep(args.delay)

    print(f'Matched {len(rank_by_url)} of {len(our_urls)} URLs from popular list')

    # Sort ps2 list by rank, then keep stable for unranked items
    for idx, item in enumerate(data):
        if isinstance(item, dict):
            item['_orig_index'] = idx

    def sort_key(item):
        if not isinstance(item, dict):
            return (10**12, 10**12, '')
        u = normalize_url(str(item.get('url', '')))
        r = rank_by_url.get(u)
        if r is None:
            # Put unranked after ranked; keep original order
            return (10**9, int(item.get('_orig_index', 10**12)), str(item.get('title', '')).lower())
        return (r, 0, str(item.get('title', '')).lower())

    data.sort(key=sort_key)

    # Optionally store rank into game_info
    if args.write_rank:
        for item in data:
            if not isinstance(item, dict):
                continue
            u = normalize_url(str(item.get('url', '')))
            r = rank_by_url.get(u)
            if r is None:
                continue
            gi = item.get('game_info')
            if not isinstance(gi, dict):
                gi = {}
                item['game_info'] = gi
            gi['Popularity Rank'] = r

    # Remove helper field
    for item in data:
        if isinstance(item, dict) and '_orig_index' in item:
            del item['_orig_index']

    save_json(output_path, data)
    print(f'Wrote sorted file: {output_path}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Interrupted by user')
        sys.exit(130)
