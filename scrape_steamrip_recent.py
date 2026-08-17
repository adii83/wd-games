"""
Finds games on steamrip.com that aren't in steamrip_games_updated.json yet
and appends them as new, pending PC entries.

Two discovery sources are merged:
  - steamrip.com's homepage "Recently Added" widget (tie-block_557) — the
    newest handful of posts.
  - steamrip.com/games-list/ — steamrip's own full A-Z index of every post
    it has ever published (thousands of entries). This is what actually
    catches the backlog: many titles already on steamrip were never in our
    catalog to begin with, not just the newest ones.

For every candidate title not already in the database (matched after
normalizing both sides through clean_title() — a lot of our EXISTING
stored titles still carry raw "(Build XXXXX)"/"(vX.X)" suffixes from
whenever they were first added, so a naive exact-string compare produces
huge false-positive "missing" counts), this script fetches that game's own
steamrip.com post page and parses its System Requirements and Game Info
sections directly — steamrip's own post pages use the exact same field
names our schema does (Genre, Developer, Platform, Game Size, Released By,
Version, Pre-Installed Game), so this is far more accurate than guessing.

banner_url is the one field NOT taken from steamrip: it's looked up on
Steam instead (store search -> Steam CDN library_600x900 art, falling back
to SteamGridDB), matching what admin.html's "Cari dari Steam" button does.
If no Steam match is found, banner_url is left blank rather than falling
back to steamrip's own thumbnail.

New entries are appended to the END of the array (not unshifted to the
front) and flagged with a top-level "pending_review": true, so they do NOT
show up in index.html's hero / Featured This Week / Update Games strips
(those only ever look at the front NEWEST_POOL_SIZE games — see
js/feature.js) and sit at the end of the main grid until an admin reviews
and "Promosikan"s them from admin.html's "Recently Added" panel.

Given the number of individual pages this may need to fetch (both a
steamrip.com post page and a Steam lookup per candidate), a single run is
capped at MAX_NEW_PER_RUN new entries by default so no single run turns
into an unbounded multi-hour crawl; re-run (or let the daily scheduled run
do it) to keep working through a large backlog incrementally. Pass
--limit N to override, or --limit 0 for no cap.

Run manually:
    python scrape_steamrip_recent.py [--limit N]
"""
import argparse
import difflib
import html
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
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
GAMES_LIST_URL = "https://steamrip.com/games-list/"
RECENTLY_ADDED_BLOCK_ID = 'id="tie-block_557"'
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
STEAMGRIDDB_API_KEY = "7b17f9a06d51df5f0c2d91873d7f2032"  # same public key used by update_steamrip_banners.py
STEAM_API_BASE = "https://www.steamgriddb.com/api/v2"

REQUEST_DELAY = 0.35  # politeness delay between steamrip.com requests
MAX_NEW_PER_RUN = 150
NEAR_DUPLICATE_CUTOFF = 0.92
SAVE_EVERY = 5  # persist progress periodically so a crash mid-run doesn't lose work

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


# --- HTTP helpers ---

def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_json(url: str, headers=None) -> dict:
    req_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    req = Request(url, headers=req_headers)
    with urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def url_exists(url: str) -> bool:
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception:
        return False


# --- Title cleanup (steamrip post titles are "X Free Download (vY / Build Z / ...)") ---

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
    value = html.unescape(raw_title or "")
    value = strip_version_suffix(value)
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


def absolutize(href: str) -> str:
    if href.startswith("http"):
        return href
    return SOURCE_URL.rstrip("/") + "/" + href.lstrip("/")


# --- Discovery: homepage "Recently Added" widget ---

def extract_recently_added(page_html: str):
    block_start = page_html.find(RECENTLY_ADDED_BLOCK_ID)
    if block_start == -1:
        print("  WARNING: could not find the homepage 'Recently Added' block (tie-block_557) — steamrip's layout may have changed.")
        return []
    own_title_end = page_html.find("</h3>", block_start)
    next_block = page_html.find('class="mag-box-title the-global-title"', own_title_end)
    segment = page_html[block_start:next_block] if next_block != -1 else page_html[block_start:block_start + 40000]

    items = []
    for li_html in re.split(r'(?=<li class="post-item)', segment)[1:]:
        href_m = re.search(r'<a aria-label="[^"]*" href="([^"]+)"', li_html)
        title_m = re.search(r'class="post-title"><a[^>]*>([^<]+)</a>', li_html)
        if not (href_m and title_m):
            continue
        items.append((absolutize(href_m.group(1)), title_m.group(1).strip()))
    return items


# --- Discovery: full A-Z games list ---

def extract_games_list(page_html: str):
    items = re.findall(r'<li class="az-list-item"><a href="([^"]+)">([^<]+)</a></li>', page_html)
    return [(absolutize(href), title.strip()) for href, title in items]


# --- Per-game post page parsing ---

def strip_tags(fragment: str) -> str:
    return re.sub(r"<[^>]+>", "", fragment)


def parse_shortcode_list(section_html: str) -> dict:
    result = {}
    for li in re.findall(r"<li>(.*?)</li>", section_html, re.S):
        text = html.unescape(strip_tags(li)).strip()
        text = re.sub(r"\s+", " ", text)
        if not text:
            continue
        if text.strip().lower().startswith("pre-installed game"):
            result["Pre-Installed Game"] = True
            continue
        if ":" in text:
            key, _, val = text.partition(":")
            key = key.strip().rstrip("*").strip()
            val = val.strip()
            if key and val:
                result[key] = val
    return result


def extract_section_list(post_html: str, heading_text: str) -> dict:
    idx = post_html.find(heading_text)
    if idx == -1:
        return {}
    # <ul> sometimes carries a class (e.g. <ul class="bb_ul">) depending on
    # when/how the post was authored — match either form. Also cap how far
    # ahead we'll look: if the nearest <ul> is implausibly far away, this
    # heading has no list of its own (or matched stray text elsewhere on
    # the page) rather than actually being followed by one.
    ul_m = re.search(r"<ul[^>]*>", post_html[idx:idx + 600])
    if not ul_m:
        return {}
    ul_start = idx + ul_m.end()
    ul_end = post_html.find("</ul>", ul_start)
    if ul_end == -1:
        return {}
    return parse_shortcode_list(post_html[ul_start:ul_end])


def parse_game_post(post_html: str):
    title_m = re.search(r'<h1 class="post-title entry-title">(.*?)</h1>', post_html, re.S)
    raw_title = html.unescape(strip_tags(title_m.group(1))).strip() if title_m else ""

    system_requirements = extract_section_list(post_html, "SYSTEM REQUIREMENTS") or None

    game_info = extract_section_list(post_html, "GAME INFO")
    game_info.setdefault("Platform", "PC")
    game_info.setdefault("Pre-Installed Game", False)

    return raw_title, system_requirements, game_info


# --- Steam banner lookup (search -> CDN art -> SteamGridDB fallback) ---

def search_steam_store(query: str):
    url = f"https://store.steampowered.com/api/storesearch/?term={quote(query)}&l=english&cc=US"
    try:
        payload = fetch_json(url)
        items = payload.get("items") or []
        return items[0] if items else None
    except Exception as e:
        print(f"    [Steam search failed] {query!r}: {e}")
        return None


def steamgriddb_grids_for_steam_appid(appid: int):
    try:
        payload = fetch_json(f"{STEAM_API_BASE}/games/steam/{appid}", headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"})
        if not (payload.get("success") and payload.get("data")):
            return []
        game_id = payload["data"]["id"]
        grids_payload = fetch_json(f"{STEAM_API_BASE}/grids/game/{game_id}", headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"})
        return grids_payload.get("data") or []
    except Exception:
        return []


def select_best_grid(grids):
    if not grids:
        return None
    for g in grids:
        if g.get("width") == 600 and g.get("height") == 900:
            return g.get("url")
    for g in grids:
        if g.get("height", 0) > g.get("width", 0):
            return g.get("url")
    return grids[0].get("url")


def steamgriddb_autocomplete(title: str):
    try:
        payload = fetch_json(
            f"{STEAM_API_BASE}/search/autocomplete/{quote(title)}",
            headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"},
        )
        if payload.get("success") and payload.get("data"):
            return payload["data"]
        return []
    except Exception:
        return []


def get_steam_banner(title: str):
    # Every fallback here is verified/selected to be portrait (2:3-ish) art
    # to match the site's card layout. Steam storesearch's own "tiny_image"
    # field (231x87 landscape) used to be the last resort here, but a wrong
    # aspect ratio is worse than no banner at all, so it's not used anymore
    # (see admin.html's "Recently Added" review flow for filling these in
    # by hand instead).
    item = search_steam_store(title)
    if item:
        appid = item["id"]
        cdn_url = f"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg"
        if url_exists(cdn_url):
            return cdn_url
        grids = steamgriddb_grids_for_steam_appid(appid)
        cover = select_best_grid(grids)
        if cover:
            return cover

    # No Steam appid match, or that appid had no usable art on either CDN -
    # try SteamGridDB's own name search as a last resort before giving up.
    for candidate in steamgriddb_autocomplete(title)[:3]:
        try:
            grids_payload = fetch_json(
                f"{STEAM_API_BASE}/grids/game/{candidate['id']}",
                headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"},
            )
            grids = grids_payload.get("data") or []
        except Exception:
            grids = []
        cover = select_best_grid(grids)
        if cover:
            return cover

    return ""


# --- Database I/O ---

def load_games():
    with DATA_FILE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{DATA_FILE} must contain a JSON array.")
    return data


def save_games(games) -> None:
    # steamrip_games_updated.json is hand-edited (via admin.html, which
    # writes JSON.stringify(gamesData, null, 2)) — keep the same 2-space
    # pretty-printed format so this script's diffs stay readable.
    tmp = DATA_FILE.with_suffix(DATA_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


def build_existing_title_set(games):
    # Many existing entries still carry raw "(Build XXXXX)"/"(vX.X)" suffixes
    # baked into their stored title (added before/without this cleanup), so
    # index BOTH the raw and the clean_title()-normalized form — otherwise
    # a naive exact-match produces huge false-positive "missing" counts.
    existing = set()
    for g in games:
        raw = (g.get("title") or "")
        if not raw:
            continue
        existing.add(raw.lower())
        existing.add(clean_title(raw).lower())
    return existing


def is_new_title(title: str, existing_lower: set) -> bool:
    key = title.lower()
    if key in existing_lower:
        return False
    return not difflib.get_close_matches(key, existing_lower, n=1, cutoff=NEAR_DUPLICATE_CUTOFF)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=MAX_NEW_PER_RUN, help="Max new games to add this run (0 = no limit).")
    args = parser.parse_args()
    limit = args.limit if args.limit and args.limit > 0 else None

    games = load_games()
    existing_lower = build_existing_title_set(games)

    print("Fetching steamrip.com's 'Recently Added' widget...")
    try:
        widget_candidates = extract_recently_added(fetch(SOURCE_URL))
    except Exception as e:
        print(f"  WARNING: could not fetch homepage: {e}")
        widget_candidates = []
    print(f"  {len(widget_candidates)} entries.")

    print("Fetching steamrip.com's full A-Z games list...")
    try:
        list_candidates = extract_games_list(fetch(GAMES_LIST_URL))
    except Exception as e:
        print(f"  WARNING: could not fetch games-list page: {e}")
        list_candidates = []
    print(f"  {len(list_candidates)} entries.")

    seen_urls = set()
    merged = []
    for url, raw_title in widget_candidates + list_candidates:
        if url in seen_urls:
            continue
        seen_urls.add(url)
        merged.append((url, raw_title))

    to_process = []
    seen_clean = set()
    for url, raw_title in merged:
        title = clean_title(raw_title)
        if not title or title.lower() in seen_clean:
            continue
        if not is_new_title(title, existing_lower):
            continue
        seen_clean.add(title.lower())
        to_process.append((url, title))

    print(f"\n{len(to_process)} candidate title(s) not yet in the database.")
    if limit and len(to_process) > limit:
        print(f"Capping this run to {limit} (re-run to continue with the rest — {len(to_process) - limit} would remain).")
        to_process = to_process[:limit]

    added = []
    for i, (url, list_title) in enumerate(to_process, 1):
        try:
            post_html = fetch(url)
        except Exception as e:
            print(f"  [{i}/{len(to_process)}] SKIP (couldn't fetch page): {list_title!r}: {e}")
            time.sleep(REQUEST_DELAY)
            continue

        raw_page_title, system_requirements, game_info = parse_game_post(post_html)
        title = clean_title(raw_page_title) or list_title

        # Re-check against the on-page title too, and against titles added
        # earlier in this same run (a list-page title and a widget title
        # can both resolve to the same on-page title).
        if not is_new_title(title, existing_lower):
            print(f"  [{i}/{len(to_process)}] SKIP (already in database after re-check): {title!r}")
            time.sleep(REQUEST_DELAY)
            continue

        game_info.setdefault("Game Size", "")
        banner = get_steam_banner(title)

        entry = {
            "title": title,
            "banner_url": banner,
            "system_requirements": system_requirements,
            "game_info": game_info,
            "url": url,
            "pending_review": True,
        }
        games.append(entry)
        existing_lower.add(title.lower())
        added.append(title)

        size_note = game_info.get("Game Size") or "size unknown"
        banner_note = "Steam art found" if banner else "no Steam match — banner left blank"
        print(f"  [{i}/{len(to_process)}] ADD: {title!r} ({size_note}, {banner_note})")

        if len(added) % SAVE_EVERY == 0:
            save_games(games)

        time.sleep(REQUEST_DELAY)

    if added:
        save_games(games)
        print(f"\nAppended {len(added)} new game(s) to {DATA_FILE}, at the end of the array (pending_review).")
        print("They will NOT appear in the hero / Featured This Week / Update Games sections and sit at the")
        print("end of the main grid until reviewed. Push this change to main — the existing GitHub Actions")
        print("workflow will regenerate *.lite.json/catalog/gameplay automatically. Then review, complete,")
        print("and 'Promosikan' the ones you want featured from admin.html's 'Recently Added' panel.")
    else:
        print("\nNothing new to add.")


if __name__ == "__main__":
    main()
