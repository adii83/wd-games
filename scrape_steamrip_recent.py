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

banner_url is looked up on Steam first (store search -> Steam CDN
library_600x900 art, falling back to SteamGridDB), matching what admin.html's
"Cari dari Steam" button does - but a provider's art is only accepted when
the provider's own name for the game passes titles_match() AND that image
isn't already another title's cover (see resolve_cover()). Taking the first
search hit unchecked is how "Minecraft" (not on Steam) ended up wearing
Minecraft Dungeons' cover. When no provider passes, steamrip's own portrait
thumbnail for that exact post is used; banner_url is left blank only if that
fails too.

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
# Titles an admin deleted via admin.html. Without this, a deleted game just
# looks "not in the database" and gets scraped straight back in. Maintained
# by track_deleted_titles.py (run by both GitHub Actions workflows).
DELETED_TITLES_FILE = Path("deleted_titles.json")
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
MIN_BANNER_TITLE_SIMILARITY = 0.78
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


_FREE_DOWNLOAD_RE = re.compile(r"\s*\bfree download\b\s*", re.IGNORECASE)


def strip_free_download(title: str) -> str:
    # "Free Download" is pure clutter steamrip's post titles carry (e.g.
    # "Satisfactory Free Download (v1.2.3.1 + Online)") - unlike the
    # "(... + Online)" tag right after it, it's never meaningful and every
    # other title in the catalog is already clean of it. Surgical removal
    # (not a full clean_title() pass) so the online/co-op tag next to it
    # survives untouched.
    if not title:
        return title
    return re.sub(r"\s+", " ", _FREE_DOWNLOAD_RE.sub(" ", title)).strip()


def clean_title(raw_title: str) -> str:
    value = html.unescape(raw_title or "")
    # Steamrip occasionally emits malformed UTF-8 as U+FFFD (�).  Leaving
    # that character in a query makes Steam's search return no result for an
    # otherwise valid title such as "Mini Airways – ATC simulator".
    value = value.replace("\ufffd", " ")
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
        items = [item for item in (payload.get("items") or []) if item.get("type") == "app"]
        ranked = sorted(
            ((title_similarity(query, item.get("name", "")), item) for item in items),
            key=lambda pair: pair[0],
            reverse=True,
        )
        for _, item in ranked:
            if titles_match(query, item.get("name", "")):
                return item
        if ranked:
            print(f"    [Steam cover rejected] {query!r} -> {ranked[0][1].get('name', '')!r} ({ranked[0][0]:.2f})")
        return None
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


def cover_title_key(title: str) -> str:
    value = html.unescape(str(title or "")).lower()
    value = value.replace("™", "").replace("®", "").replace("©", "")
    value = re.sub(r"\bfree\s+download\b", " ", value)
    value = re.sub(r"\s*\([^)]*(?:build|v\d|patch|update|online|multiplayer|co-?op)[^)]*\)$", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def title_similarity(left: str, right: str) -> float:
    left_key = cover_title_key(left)
    right_key = cover_title_key(right)
    left_numbers = _number_signature(left_key)
    right_numbers = _number_signature(right_key)
    if left_numbers != right_numbers and (left_numbers or right_numbers):
        return 0.0
    return difflib.SequenceMatcher(None, left_key, right_key).ratio()


# Words that don't change which game a title refers to. Everything else does:
# "Need for Speed Hot Pursuit" vs "... Remastered", "Hitman 2" vs "Hitman 2
# Silent Assassin", "Minecraft" vs "Minecraft Dungeons" are different games.
_EDITION_NOISE = {
    "the", "a", "an", "and", "game", "version", "anniversary", "edition", "deluxe", "digital", "definitive", "goty",
    "complete", "ultimate", "gold", "standard", "premium", "enhanced", "special",
}


def _game_words(title: str) -> list:
    words = (_ROMAN_MAP.get(w, w) for w in cover_title_key(title).split())
    return [str(w) for w in words if w not in _EDITION_NOISE]


def titles_match(left: str, right: str) -> bool:
    """Strict "is this the same game" check for accepting a provider's art.

    Same words once punctuation, edition noise and roman-vs-arabic numerals
    are normalized away - no fuzzy ratio. A ratio happily accepts a single
    swapped word ("Skyrim SE" vs "Skyrim VR", "Resident Evil 4 Remake" vs
    "Resident Evil 4: Otome Edition"), and a wrongly accepted match puts
    another game's cover on the card, while a wrongly rejected one just
    falls through to steamrip's own thumbnail (always the right game).
    """
    a, b = _game_words(left), _game_words(right)
    if not a or not b:
        return cover_title_key(left) == cover_title_key(right)
    # Second test catches pure spacing differences ("MotoGP 14" vs "MotoGP™14").
    return set(a) == set(b) or "".join(a) == "".join(b)


def get_verified_banner(title: str):
    """Return cover metadata only when the provider title matches the query."""
    item = search_steam_store(title)
    if item:
        appid = item["id"]
        match_title = item.get("name", "")
        cdn_url = f"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg"
        if url_exists(cdn_url):
            return {"url": cdn_url, "source": "Steam", "match_title": match_title, "confidence": title_similarity(title, match_title)}
        cover = select_best_grid(steamgriddb_grids_for_steam_appid(appid))
        if cover:
            return {"url": cover, "source": "SteamGridDB", "match_title": match_title, "confidence": title_similarity(title, match_title)}

    for candidate in steamgriddb_autocomplete(title)[:5]:
        match_title = candidate.get("name", "")
        confidence = title_similarity(title, match_title)
        if not titles_match(title, match_title):
            continue
        try:
            grids_payload = fetch_json(
                f"{STEAM_API_BASE}/grids/game/{candidate['id']}",
                headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"},
            )
            cover = select_best_grid(grids_payload.get("data") or [])
        except Exception:
            cover = None
        if cover:
            return {"url": cover, "source": "SteamGridDB", "match_title": match_title, "confidence": confidence}
    return None


# One search result on steamrip.com/?s=...: thumbnail, its size, post link,
# post title. Post pages themselves only carry landscape art for their own
# game (the portrait <img>s on a post page belong to OTHER games in the
# sidebar), so the search listing is where a post's own portrait lives.
_STEAMRIP_RESULT_RE = re.compile(
    r'<div class="slide[^"]*" data-back="([^"]+)" data-eio-rwidth="(\d+)" data-eio-rheight="(\d+)"[^>]*>\s*'
    r'<a href="([^"]+)" class="all-over-thumb-link"><span class="screen-reader-text">([^<]*)</span>'
)


def _slug(url: str) -> str:
    return (url or "").rstrip("/").rsplit("/", 1)[-1]


def parse_steamrip_cover(page_html: str, title: str, post_url: str = ""):
    key = cover_title_key(clean_title(title))
    for image, width, height, href, raw_name in _STEAMRIP_RESULT_RE.findall(page_html):
        name = clean_title(raw_name)
        same_post = bool(post_url) and _slug(href) == _slug(post_url)
        if not same_post and cover_title_key(name) != key:
            continue
        if int(height) <= int(width):
            continue  # landscape art looks cropped/wrong in the portrait card layout
        return {"url": absolutize(html.unescape(image)), "source": "steamrip", "match_title": name, "confidence": 1.0}
    return None


def steamrip_cover(title: str, post_url: str = ""):
    try:
        page = fetch(f"{SOURCE_URL}?s={quote(clean_title(title))}")
    except Exception as e:
        print(f"    [steamrip cover search failed] {title!r}: {e}")
        return None
    return parse_steamrip_cover(page, title, post_url)


def used_by_other_title(url: str, title: str, banner_owners: dict) -> bool:
    key = cover_title_key(clean_title(title))
    return any(cover_title_key(clean_title(owner)) != key for owner in banner_owners.get(url, ()))


def resolve_cover(title: str, banner_owners: dict, post_url: str = ""):
    """The one cover lookup every script shares.

    Steam/SteamGridDB (name-verified) first, steamrip's own thumbnail for
    this post second. Either is dropped if that exact image is already
    another title's cover. Returns {url, source, match_title, confidence}
    or None.
    """
    search_title = clean_title(title)
    for lookup in (get_verified_banner, lambda t: steamrip_cover(t, post_url)):
        found = lookup(search_title)
        if not found:
            continue
        if used_by_other_title(found["url"], search_title, banner_owners):
            print(f"    [cover rejected, already used by another title] {title!r} -> {found['url']}")
            continue
        return found
    return None


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


def load_deleted_titles():
    if not DELETED_TITLES_FILE.exists():
        return []
    try:
        with DELETED_TITLES_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    return [t for t in data if isinstance(t, str) and t.strip()]


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


def build_banner_owner_map(games):
    owners = {}
    for game in games:
        banner = str(game.get("banner_url") or "").strip()
        title = str(game.get("title") or "").strip()
        if banner and title:
            owners.setdefault(banner, set()).add(title)
    return owners


_ROMAN_MAP = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8,
    "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15,
}
_ROMAN_TOKEN_RE = re.compile(r"\b(" + "|".join(sorted(_ROMAN_MAP, key=len, reverse=True)) + r")\b")


def _number_signature(text: str) -> set:
    # "Mortal Kombat" vs "Mortal Kombat 11", "Sniper Elite 3" vs "Sniper
    # Elite 4", "Age of History 2" vs "Age of History 3" - a differing
    # number/roman-numeral almost always means a different installment, not
    # the same game spelled slightly differently. See is_new_title().
    t = text.lower()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = _ROMAN_TOKEN_RE.sub(lambda m: str(_ROMAN_MAP[m.group(1)]), t)
    return set(re.findall(r"\d+", t))


def is_new_title(title: str, existing_lower: set) -> bool:
    key = title.lower()
    if key in existing_lower:
        return False
    close = difflib.get_close_matches(key, existing_lower, n=1, cutoff=NEAR_DUPLICATE_CUTOFF)
    if not close:
        return True
    # A high text-similarity ratio alone isn't enough — cutoff=0.92 still
    # happily matches "Mortal Kombat 1" against an existing "Mortal Kombat
    # 11", or "Call of Duty: Black Ops II" against "...III". Only treat it
    # as a real duplicate (not new) if the number/roman-numeral signature
    # also matches; otherwise this is a different installment slipping
    # through under a near-identical name, and should still count as new.
    return _number_signature(key) != _number_signature(close[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=MAX_NEW_PER_RUN, help="Max new games to add this run (0 = no limit).")
    args = parser.parse_args()
    limit = args.limit if args.limit and args.limit > 0 else None

    games = load_games()
    existing_lower = build_existing_title_set(games)
    banner_owners = build_banner_owner_map(games)

    # Fold in admin-deleted titles (both raw and clean_title()-normalized,
    # same as build_existing_title_set) so is_new_title() treats them as
    # already-known and skips them instead of re-adding them.
    deleted_titles = load_deleted_titles()
    for t in deleted_titles:
        existing_lower.add(t.lower())
        existing_lower.add(clean_title(t).lower())
    if deleted_titles:
        print(f"Ignoring {len(deleted_titles)} admin-deleted title(s) (deleted_titles.json).")

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
        search_title = clean_title(raw_title)
        if not search_title or search_title.lower() in seen_clean:
            continue
        if not is_new_title(search_title, existing_lower):
            continue
        seen_clean.add(search_title.lower())
        to_process.append((url, raw_title))

    print(f"\n{len(to_process)} candidate title(s) not yet in the database.")
    if limit and len(to_process) > limit:
        print(f"Capping this run to {limit} (re-run to continue with the rest — {len(to_process) - limit} would remain).")
        to_process = to_process[:limit]

    added = []
    for i, (url, raw_list_title) in enumerate(to_process, 1):
        try:
            post_html = fetch(url)
        except Exception as e:
            print(f"  [{i}/{len(to_process)}] SKIP (couldn't fetch page): {raw_list_title!r}: {e}")
            time.sleep(REQUEST_DELAY)
            continue

        raw_page_title, system_requirements, game_info = parse_game_post(post_html)
        # clean_title() strips the "+ Online"/"+ Co-op"/"+ Multiplayer" tag
        # steamrip's own post titles carry (it's meant for Steam-search/dedup
        # matching, where that noise only hurts) — but the rest of the
        # database KEEPS that tag baked into the stored title (e.g. "Schedule
        # I (v0.4.3f3 + Online)"), and js/feature.js's requiresOnline() badge
        # detection depends on it surviving there. So the STORED title uses
        # the raw page title (falls back to the raw list-page title only if
        # the post page's own title didn't parse), while clean_title()'s
        # output is used only for the dedup re-check and the Steam lookup.
        stored_title = strip_free_download(raw_page_title or raw_list_title)
        search_title = clean_title(raw_page_title) or clean_title(raw_list_title)

        # Re-check against the on-page title too, and against titles added
        # earlier in this same run (a list-page title and a widget title
        # can both resolve to the same on-page title).
        if not is_new_title(search_title, existing_lower):
            print(f"  [{i}/{len(to_process)}] SKIP (already in database after re-check): {stored_title!r}")
            time.sleep(REQUEST_DELAY)
            continue

        game_info.setdefault("Game Size", "")
        banner_details = resolve_cover(search_title, banner_owners, url)
        banner = banner_details["url"] if banner_details else ""
        cover_status = "verified" if banner else "missing"

        entry = {
            "title": stored_title,
            "banner_url": banner,
            "banner_status": cover_status,
            "banner_source": banner_details.get("source", "") if banner_details and banner else "",
            "banner_match_title": banner_details.get("match_title", "") if banner_details and banner else "",
            "banner_confidence": round(float(banner_details.get("confidence", 0)), 3) if banner_details and banner else 0,
            "system_requirements": system_requirements,
            "game_info": game_info,
            "url": url,
            "pending_review": True,
        }
        games.append(entry)
        if banner:
            banner_owners.setdefault(banner, set()).add(stored_title)
        existing_lower.add(stored_title.lower())
        existing_lower.add(search_title.lower())
        added.append(stored_title)

        size_note = game_info.get("Game Size") or "size unknown"
        banner_note = f"cover from {banner_details['source']}" if banner else "no verified cover — banner left blank"
        print(f"  [{i}/{len(to_process)}] ADD: {stored_title!r} ({size_note}, {banner_note})")

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


def _selftest():
    existing = {"mortal kombat 11", "sniper elite 4", "call of duty: black ops iii", "age of history 3"}
    assert is_new_title("Mortal Kombat 1", existing) is True
    assert is_new_title("Sniper Elite 3", existing) is True
    assert is_new_title("Call of Duty: Black Ops II", existing) is True
    assert is_new_title("Age of History 2: Definitive Edition", existing) is True
    assert is_new_title("Mortal Kombat 11", existing) is False
    assert title_similarity("Minecraft", "Minecraft Dungeons") < MIN_BANNER_TITLE_SIMILARITY
    assert title_similarity("Minecraft Dungeons", "Minecraft Dungeons") == 1.0
    for ours, theirs in [
        ("Minecraft", "Minecraft Dungeons"),
        ("Ragnar", "God of War Ragnarök"),
        ("Hades", "Hades II"),
        ("DOOM", "DOOM: The Dark Ages"),
        ("The Witcher 3: Wild Hunt", "The Witcher 3: Wild Hunt Remastered"),
        ("Hitman 2", "Hitman 2: Silent Assassin"),
        ("Euro Truck Simulator", "Euro Truck Simulator 2"),
    ]:
        assert not titles_match(ours, theirs), (ours, theirs)
    assert not titles_match("The Elder Scrolls V: Skyrim SE", "The Elder Scrolls V: Skyrim VR")
    assert not titles_match("Resident Evil 4 Remake", "Resident Evil 4: Otome Edition")
    for ours, theirs in [
        ("Minecraft Dungeons", "Minecraft Dungeons"),
        ("Far Cry 5: Gold Edition", "Far Cry® 5"),
        ("Hades 2", "Hades II"),
        ("Assassin’s Creed III", "Assassin's Creed® III"),
        ("The Elder Scrolls V: Skyrim", "Elder Scrolls V: Skyrim Special Edition"),
    ]:
        assert titles_match(ours, theirs), (ours, theirs)
    listing = (
        '<div class="slide lazyload" data-back="https://steamrip.com/wp-content/uploads/a/dungeons.jpg" '
        'data-eio-rwidth="584" data-eio-rheight="800"> <a href="minecraft-dungeons-free-download-3j/" '
        'class="all-over-thumb-link"><span class="screen-reader-text">Minecraft Dungeons Free Download (v1 + Co-op)</span></a>'
        '<div class="slide lazyload" data-back="https://steamrip.com/wp-content/uploads/a/minecraft.jpg" '
        'data-eio-rwidth="584" data-eio-rheight="800"> <a href="minecraft-2d/" '
        'class="all-over-thumb-link"><span class="screen-reader-text">Minecraft Free Download (v1.20.4)</span></a>'
    )
    assert parse_steamrip_cover(listing, "Minecraft")["url"].endswith("/minecraft.jpg")
    assert parse_steamrip_cover(listing, "Minecraft Dungeons")["url"].endswith("/dungeons.jpg")
    assert parse_steamrip_cover(listing, "Minecraft Legends") is None
    owners = {"x.jpg": {"Minecraft Dungeons (v1.17.0.0 + Co-op)"}}
    assert used_by_other_title("x.jpg", "Minecraft", owners)
    assert not used_by_other_title("x.jpg", "Minecraft Dungeons", owners)
    print("is_new_title selftest OK")
    print("cover title matching selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        main()
