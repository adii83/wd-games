"""
Scrapes steamrip.com's homepage "Recently Added" widget (the section headed
"Recently Added", showing the newest repack posts with their thumbnail and a
"Build XXXXX" tag) and appends any title not already present in
steamrip_games_updated.json as a new, minimal PC entry.

New entries are:
  - appended to the END of the array (not unshifted to the front), so they
    do NOT show up in index.html's hero / Featured This Week / Update Games
    strips — those only ever look at the front NEWEST_POOL_SIZE (30) games
    (see js/feature.js). They still appear on the site, at the very end of
    "Explore Your Collection" (default 'newest' sort is just array order,
    no explicit re-sort).
  - flagged with a top-level "pending_review": true, so admin.html's
    "Recently Added" panel can find them for review/completion. Clicking
    "Promosikan" there moves an entry to the front of the array (clearing
    the flag) — the admin controls which ones surface in hero/Featured next,
    and in what order, simply by the order they promote them in.

Only the fields the "Recently Added" widget itself exposes are filled in
(title, a portrait thumbnail, and the exact repack size steamrip lists —
more accurate than Steam's own size, since Steam doesn't know this build is
a repack). Genre is a best-effort guess from steamrip's own category tags.
Everything else (Developer, system_requirements, ...) is left blank for the
admin to complete via the existing "Cari dari Steam" button per-entry.

Run manually (not part of the automated GitHub Actions pipeline — steamrip.com
sits behind Cloudflare and blocks non-browser-looking requests, which is more
likely to misbehave from a datacenter CI runner than from a real machine):

    python scrape_steamrip_recent.py
"""
import difflib
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

DATA_FILE = Path("steamrip_games_updated.json")
SOURCE_URL = "https://steamrip.com/"
RECENTLY_ADDED_BLOCK_ID = 'id="tie-block_557"'
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
# Titles within this fuzzy-match ratio of an existing title are treated as
# the same game (edition/formatting differences) and skipped rather than
# added as a near-duplicate.
NEAR_DUPLICATE_CUTOFF = 0.92

# steamrip <li class="... category-<slug> ..."> -> our Genre label. Only a
# best-effort tag pending admin review — see module docstring.
CATEGORY_GENRE_MAP = {
    "action": "Action",
    "adventure": "Adventure",
    "anime": "Anime",
    "building": "Simulation",
    "fps": "Shooter",
    "horror": "Horror",
    "indie": "Indie",
    "multiplayer": "Multiplayer",
    "open-world": "Open World",
    "racing": "Racing",
    "rpg": "RPG",
    "sci-fi": "Sci-Fi",
    "shooting": "Shooter",
    "simulation": "Simulation",
    "sports": "Sports",
    "strategy": "Strategy",
    "survival": "Survival",
    "vr": "VR",
}

EDITION_TERMS = [
    r"\b(?:digital\s+)?deluxe\s+edition\b",
    r"\bpremium\s+edition\b",
    r"\bdefinitive\s+edition\b",
    r"\bgold\s+edition\b",
    r"\bstandard\s+edition\b",
    r"\bspecial\s+edition\b",
    r"\bultimate\s+edition\b",
    r"\bcomplete\s+edition\b",
    r"\bgoty\s+edition\b",
    r"\bgame\s+of\s+the\s+year\s+edition\b",
    r"\benhanced\s+edition\b",
]


def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def strip_version_suffix(title: str) -> str:
    if not title:
        return ""
    t = str(title).strip()
    pattern = re.compile(
        r"\s*(?:\(|\[)"
        r"(?:\s*(?:"
        r"v\s*\d|"
        r"build\b|"
        r"b[_-]?\s*\d|"
        r"patch\b|"
        r"update\b|"
        r"dlc\b|"
        r"co[- ]?op\b|"
        r"multiplayer\b|"
        r"online\b|"
        r"full\b|"
        r"remake\b"
        r")[^)\]]*)"
        r"(?:\)|\])\s*$",
        re.IGNORECASE,
    )
    while True:
        new_t = pattern.sub("", t).strip()
        if new_t == t:
            break
        t = new_t
    return t


def clean_title(raw_title: str) -> str:
    value = strip_version_suffix(raw_title)
    if not value:
        return ""
    value = re.sub(r"\bfree download\b", "", value, flags=re.I)
    value = re.sub(r"\bonline\b", "", value, flags=re.I)
    value = re.sub(r"\bmultiplayer\b", "", value, flags=re.I)
    value = re.sub(r"\bco[- ]?op\b", "", value, flags=re.I)
    for pattern in EDITION_TERMS:
        value = re.sub(pattern, "", value, flags=re.I)
    value = re.sub(r"[:\-–—]+\s*$", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def extract_recently_added(page_html: str):
    block_start = page_html.find(RECENTLY_ADDED_BLOCK_ID)
    if block_start == -1:
        raise RuntimeError(
            "Could not find the 'Recently Added' block (tie-block_557) on steamrip.com "
            "— the page layout may have changed and this scraper needs updating."
        )
    # The widget is one <div id="tie-block_557" class="mag-box big-posts-box">
    # sibling section; the next "mag-box-title the-global-title" marks the
    # start of the following widget, so slice up to there (or end of doc).
    # Skip past this widget's OWN "Recently Added" title first, or the
    # search below matches it immediately and the slice ends up empty.
    own_title_end = page_html.find("</h3>", block_start)
    next_block = page_html.find('class="mag-box-title the-global-title"', own_title_end)
    segment = page_html[block_start:next_block] if next_block != -1 else page_html[block_start:block_start + 40000]

    items = []
    for li_html in re.split(r'(?=<li class="post-item)', segment)[1:]:
        class_attr_m = re.match(r'<li class="([^"]*)"', li_html)
        cat_slugs = re.findall(r"category-([a-z0-9-]+)", class_attr_m.group(1)) if class_attr_m else []

        href_m = re.search(r'<a aria-label="[^"]*" href="([^"]+)"', li_html)
        thumb_m = re.search(r'data-src="([^"]+\.(?:jpg|jpeg|png|webp))"', li_html)
        meta_m = re.search(r'game-meta-line">([^<]*)<', li_html)
        title_m = re.search(r'class="post-title"><a[^>]*>([^<]+)</a>', li_html)

        if not (href_m and title_m):
            continue

        raw_title = html.unescape(title_m.group(1)).strip()
        size_part = None
        if meta_m and "|" in meta_m.group(1):
            size_part = meta_m.group(1).split("|")[-1].strip()

        genres = []
        for slug in cat_slugs:
            label = CATEGORY_GENRE_MAP.get(slug)
            if label and label not in genres:
                genres.append(label)

        href = href_m.group(1)
        if not href.startswith("http"):
            href = SOURCE_URL.rstrip("/") + "/" + href.lstrip("/")
        banner = None
        if thumb_m:
            banner = thumb_m.group(1)
            if not banner.startswith("http"):
                banner = SOURCE_URL.rstrip("/") + "/" + banner.lstrip("/")

        items.append({
            "raw_title": raw_title,
            "clean_title": clean_title(raw_title),
            "url": href,
            "banner_url": banner,
            "size": size_part,
            "genres": genres,
        })
    return items


def load_games():
    with DATA_FILE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{DATA_FILE} must contain a JSON array.")
    return data


def save_games(games) -> None:
    # steamrip_games_updated.json is hand-edited (via admin.html, which
    # writes JSON.stringify(gamesData, null, 2)) — keep the same 2-space
    # pretty-printed format so this script's diffs stay readable and don't
    # reformat the whole file.
    tmp = DATA_FILE.with_suffix(DATA_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


def main() -> None:
    print(f"Fetching {SOURCE_URL} ...")
    html = fetch(SOURCE_URL)
    items = extract_recently_added(html)
    print(f"Found {len(items)} games in steamrip.com's 'Recently Added' widget.\n")

    games = load_games()
    existing_lower = {(g.get("title") or "").lower(): g.get("title") for g in games if isinstance(g, dict)}

    added = []
    for item in items:
        title = item["clean_title"]
        if not title:
            print(f"  SKIP (empty title after cleanup): {item['raw_title']!r}")
            continue

        if title.lower() in existing_lower:
            print(f"  SKIP (already in database): {title!r}")
            continue

        close = difflib.get_close_matches(title.lower(), existing_lower.keys(), n=1, cutoff=NEAR_DUPLICATE_CUTOFF)
        if close:
            print(f"  SKIP (near-duplicate of {existing_lower[close[0]]!r}): {title!r}")
            continue

        new_entry = {
            "title": title,
            "banner_url": item["banner_url"] or "",
            "system_requirements": None,
            "game_info": {
                "Genre": ", ".join(item["genres"]),
                "Developer": "",
                "Platform": "PC",
                "Game Size": item["size"] or "",
                "Released By": "Steam",
                "Version": "",
                "Pre-Installed Game": True,
            },
            "url": item["url"],
            "pending_review": True,
        }
        games.append(new_entry)
        added.append(title)
        print(f"  ADD: {title!r} ({item['size'] or 'size unknown'})")

    if added:
        save_games(games)
        print(f"\nAppended {len(added)} new game(s) to {DATA_FILE}, at the end of the array (pending_review).")
        print("They will NOT appear in the hero / Featured This Week / Update Games sections and sit at the")
        print("end of the main grid until reviewed. Push this change to main — the existing GitHub Actions")
        print("workflow will regenerate *.lite.json/catalog/gameplay automatically. Then review, complete,")
        print("and 'Promosikan' the ones you want featured from admin.html's 'Recently Added' panel.")
    else:
        print("\nNothing new to add — all 'Recently Added' titles are already in the database.")


if __name__ == "__main__":
    main()
