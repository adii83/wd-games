"""
Scrapes romsfun.com's "browse all roms" listing, filtered to PS3
(consoles[0]=15 - the term-id found on the site's own console-filter
checkbox), and builds ps3.json from scratch with the same schema as
ps2.json.

Unlike ps2.json (which has no from-scratch scraper anywhere in this repo -
fill_ps2_banners.py and sort_ps2_by_romsfun_popular.py only ever operate on
entries that already exist), this script builds the whole catalog directly
from the listing pages: title, cover thumbnail, genre tag, and file size are
all shown right there per row, so there's no need to visit each of the
~2,800 individual game pages - just the ~281 listing pages (10 games/page).

The listing is already sorted "popular", so the position a title is
encountered in IS its popularity rank - no separate reordering pass needed
(unlike ps2.json's Popularity Rank, which required a dedicated script
because the original scrape apparently didn't capture rank).

Usage:
    python scrape_ps3_romsfun.py
"""
import html
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def safe_print(*args, **kwargs):
    sep = kwargs.get("sep", " ")
    text = sep.join(str(arg) for arg in args)
    end = kwargs.get("end", "\n")
    try:
        sys.stdout.write(text + end)
        sys.stdout.flush()
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", "utf-8") or "utf-8"
        sys.stdout.write(text.encode(encoding, errors="replace").decode(encoding) + end)
        sys.stdout.flush()


print = safe_print

OUTPUT_FILE = Path("ps3.json")
PC_CATALOG_FILE = Path("steamrip_games_updated.json")
PS3_CONSOLE_TERM_ID = 15  # data-term-id="15" on romsfun.com's "PS3" console-filter checkbox
BASE_URL = f"https://romsfun.com/browse-all-roms/?q&consoles%5B0%5D={PS3_CONSOLE_TERM_ID}&sort=popular"
PAGE_URL_TMPL = f"https://romsfun.com/browse-all-roms/page/{{page}}/?q&consoles%5B0%5D={PS3_CONSOLE_TERM_ID}&sort=popular"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
REQUEST_DELAY = 0.4
SAVE_EVERY_PAGES = 10


def fetch_html(url: str, retries: int = 4, backoff: float = 1.2) -> str:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    for attempt in range(retries):
        try:
            req = Request(url, headers=headers, method="GET")
            with urlopen(req, timeout=25) as resp:
                raw = resp.read()
                charset = "utf-8"
                content_type = resp.headers.get("Content-Type", "")
                m = re.search(r"charset=([\w-]+)", content_type)
                if m:
                    charset = m.group(1)
                return raw.decode(charset, errors="replace")
        except (HTTPError, URLError) as e:
            if attempt == retries - 1:
                raise
            sleep_s = backoff ** attempt
            print(f"  [warn] fetch failed ({e}), retrying in {sleep_s:.1f}s...")
            time.sleep(sleep_s)
    raise RuntimeError("unreachable")


def detect_total_pages(first_page_html: str) -> int:
    pages = [int(m) for m in re.findall(r"/browse-all-roms/page/(\d+)/", first_page_html)]
    return max(pages) if pages else 1


def detect_total_count(first_page_html: str):
    m = re.search(r"([\d,]+)\s*ROM found", first_page_html)
    if not m:
        return None
    return int(m.group(1).replace(",", ""))


ITEM_SPLIT_RE = re.compile(r'(?=<div class="bg-white rounded-xl p-3 flex gap-4 shadow-md transition items-center">)')
TITLE_RE = re.compile(r'<h3 class="font-black mb-2 text-gray-900">\s*<a href="([^"]+)"[^>]*>\s*(.*?)\s*</a>', re.S)
THUMB_RE = re.compile(r'<img src="([^"]+)"\s+alt="[^"]*"\s+class="w-full h-full object-cover">')
TAG_RE = re.compile(r'<a class="px-4 py-1 rounded-full text-romfun-pink[^"]*"[^>]*>([^<]+)</a>')
# The size badge is the *second* "badge badge-info" span and carries the
# extra inline-flex/items-center classes; the first (downloads count) does
# not - that distinction is what separates the two without relying on order.
# Unit formatting is inconsistent on the site itself - sometimes "29.91 G"
# (space, single letter), sometimes "11GB" (no space, trailing B) - the "B?"
# and optional "\s*" handle both.
SIZE_BADGE_RE = re.compile(
    r'<span class="badge badge-info text-xs inline-flex items-center">.*?</span>\s*([\d.,]+)\s*([GMK])B?\s*</span>',
    re.S,
)


def parse_size_to_gb(number_str: str, unit: str) -> float:
    value = float(number_str.replace(",", ""))
    unit = unit.upper()
    if unit == "M":
        return value / 1024
    if unit == "K":
        return value / (1024 * 1024)
    return value  # "G"


def parse_listing_page(page_html: str):
    items = []
    for block in ITEM_SPLIT_RE.split(page_html)[1:]:
        title_m = TITLE_RE.search(block)
        if not title_m:
            continue
        url = title_m.group(1).strip()
        title = html.unescape(title_m.group(2).strip())

        thumb_m = THUMB_RE.search(block)
        banner_url = thumb_m.group(1) if thumb_m else ""

        tags = TAG_RE.findall(block)
        genre = ", ".join(html.unescape(t.strip()) for t in tags)

        size_m = SIZE_BADGE_RE.search(block)
        game_size = parse_size_to_gb(size_m.group(1), size_m.group(2)) if size_m else 0.0

        items.append({
            "title": title,
            "url": url,
            "banner_url": banner_url,
            "genre": genre,
            "game_size": game_size,
        })
    return items


SUFFIX_RE = re.compile(r"\s*[\(\[][^)\]]*[\)\]]\s*$")


def normalize_title(title: str) -> str:
    # Strips trailing "(...)"/"[...]" (version/edition noise) so e.g. a PC
    # entry stored as "God of War Collection (Remastered)" still matches
    # the PS3 listing's plain "God of War Collection".
    t = title.strip()
    while True:
        new_t = SUFFIX_RE.sub("", t).strip()
        if new_t == t:
            break
        t = new_t
    return t.lower()


def load_pc_titles() -> set:
    # PC and PS3 releases of the same game only need the store to sell one
    # copy - keep PC first, so PS3 only fills the gap of what's PC-only.
    if not PC_CATALOG_FILE.exists():
        return set()
    with PC_CATALOG_FILE.open("r", encoding="utf-8") as f:
        pc_games = json.load(f)
    return {normalize_title(g["title"]) for g in pc_games if g.get("title")}


def save_games(games) -> None:
    tmp = OUTPUT_FILE.with_suffix(OUTPUT_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUTPUT_FILE)


def main():
    print("Fetching page 1...")
    first_html = fetch_html(BASE_URL)
    total_pages = detect_total_pages(first_html)
    total_count = detect_total_count(first_html)
    print(f"Detected {total_pages} pages, {total_count if total_count is not None else '?'} ROMs reported by the site.")

    pc_titles = load_pc_titles()
    print(f"Loaded {len(pc_titles)} PC titles - PS3 titles already on PC will be skipped.")

    games = []
    rank = 0
    skipped_pc_dupes = 0
    seen_urls = set()

    def process(page_html):
        nonlocal rank, skipped_pc_dupes
        for item in parse_listing_page(page_html):
            if item["url"] in seen_urls:
                continue
            seen_urls.add(item["url"])
            if normalize_title(item["title"]) in pc_titles:
                skipped_pc_dupes += 1
                continue
            rank += 1
            games.append({
                "title": item["title"],
                "banner_url": item["banner_url"],
                "url": item["url"],
                "system_requirements": {},
                "game_info": {
                    "Genre": item["genre"],
                    "Developer": "",
                    "Platform": "PS3",
                    "Game Size": item["game_size"],
                    "Released By": "",
                    "Version": "",
                    "Pre-Installed Game": False,
                    "Popularity Rank": rank,
                },
            })

    process(first_html)
    print(f"  page 1/{total_pages}: {len(games)} total so far")

    for page in range(2, total_pages + 1):
        time.sleep(REQUEST_DELAY)
        try:
            page_html = fetch_html(PAGE_URL_TMPL.format(page=page))
        except Exception as e:
            print(f"  [error] page {page} failed after retries: {e} - skipping")
            continue
        process(page_html)
        print(f"  page {page}/{total_pages}: {len(games)} total so far")

        if page % SAVE_EVERY_PAGES == 0:
            save_games(games)

    save_games(games)
    print(f"\nDone. {len(games)} PS3 titles written to {OUTPUT_FILE.resolve()} ({skipped_pc_dupes} skipped as already on PC).")
    if total_count is not None and len(games) != total_count:
        print(f"NOTE: site reported {total_count} ROMs but {len(games)} were collected - "
              f"romsfun's catalog may have changed between page-count detection and now, "
              f"or some rows failed to parse. Re-run to pick up anything missed (URLs already "
              f"in the output are skipped as duplicates on a fresh full run only if you clear "
              f"the file first; this run does not resume/merge with a prior ps3.json).")


if __name__ == "__main__":
    main()
