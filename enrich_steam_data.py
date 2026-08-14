"""
Enrich the PC catalog with Steam gameplay data (trailer + screenshots +
full description + requirements + genres/dev/publisher/release date).

Reads steamrip_games_updated.json (read-only, title list only), matches each
title against the Steam store (storesearch -> appdetails), and writes results
to steamrip_games_gameplay.json — a dict keyed by exact game title. That file
is fetched only by feature/index.html and feature/game.html, never by the
main index.html/js/app.js, so the main site's payload never grows.

Resumable: progress is checkpointed to STATE_FILE after every title, so
re-running this script skips titles already processed (matched or not).

Usage:
    python enrich_steam_data.py            # process everything remaining
    python enrich_steam_data.py --limit 20 # process only the next 20 (spot-check)
"""
import json
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from difflib import SequenceMatcher

# Windows terminals default to a codepage (cp1252) that can't display every
# character some game titles contain (CJK, emoji, smart quotes, etc.) —
# without this, printing them crashes the script after the actual
# progress/matching work is already done and checkpointed. Harmless either
# way on GitHub Actions' Ubuntu runner (UTF-8 by default), but this keeps
# local runs from crashing too (see split_catalog_data.py for the same fix).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATA_FILE = "steamrip_games_updated.json"
STATE_FILE = "steam_enrich_progress.json"
OUTPUT_FILE = "steamrip_games_gameplay.json"

REQUEST_DELAY = 0.25
MIN_SIMILARITY = 0.55

TRAILING_TAG_RE = re.compile(
    r"""\s*(?:
        \([^)]*\)                      # (v1.06), (Build 12345), (Multiplayer), ...
        |[+]\s*(co-?op|multiplayer|online|dlcs?)\b
    )\s*$""",
    re.IGNORECASE | re.VERBOSE,
)
TRADEMARK_RE = re.compile(r"[™®©]")
SLASH_ALT_RE = re.compile(r"\s*/\s*.*$")
REPACK_NOISE_RE = re.compile(
    r"""\b(free\s*download|full\s*version|full\s*game|repack|pre-?installed|
        cracked?|codex|plaza|skidrow|goldberg|razor1911)\b""",
    re.IGNORECASE | re.VERBOSE,
)
EDITION_SUFFIX_RE = re.compile(
    r"""\s*[-:]?\s*(digital\s+)?(deluxe|goty|game\s+of\s+the\s+year|ultimate|gold|
        complete|definitive|enhanced|legendary|premium|standard|anniversary)
        (\s+edition)?\s*$""",
    re.IGNORECASE | re.VERBOSE,
)


QUOTE_MAP = str.maketrans({
    "‘": "'", "’": "'",  # curly single quotes -> straight
    "“": '"', "”": '"',  # curly double quotes -> straight
})
# Any dash/hyphen -> space, applied LAST (after tag-stripping, which still
# needs to recognize "+Co-op" etc). Steam's search API returns zero results
# for queries containing a hyphen of any kind, or a colon with a space on
# both sides ("Title : Subtitle" — but NOT "Title: Subtitle") — confirmed
# empirically for both. Rather than rely on that fragile spacing distinction,
# colons are normalized to spaces too.
DASH_MAP = str.maketrans({"-": " ", "–": " ", "—": " ", ":": " "})


def clean_title(title):
    t = title.translate(QUOTE_MAP)
    for _ in range(4):
        new_t = TRAILING_TAG_RE.sub("", t)
        if new_t == t:
            break
        t = new_t
    t = SLASH_ALT_RE.sub("", t)
    t = TRADEMARK_RE.sub("", t)
    t = REPACK_NOISE_RE.sub("", t)
    t = t.translate(DASH_MAP)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip(" :")


def strip_edition_suffix(title):
    return EDITION_SUFFIX_RE.sub("", title).strip(" -:")


def http_get_json(url, retries=4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            wait = min(60, 3 * (attempt + 1) ** 2)
            print(f"    ! request failed ({e}), retry in {wait}s", flush=True)
            time.sleep(wait)
    return None


def _storesearch(term):
    q = urllib.parse.quote(term)
    url = f"https://store.steampowered.com/api/storesearch/?term={q}&l=english&cc=us"
    return http_get_json(url)


def search_appid(cleaned_title):
    data = _storesearch(cleaned_title)
    target = cleaned_title

    # Steam's search can return zero results for "Title Deluxe Edition" even
    # when "Title" alone matches fine — retry once without the edition suffix,
    # and score against the *stripped* term too (scoring against the original
    # would unfairly favor an unrelated result that happens to share the
    # edition-suffix wording, e.g. "X Deluxe Edition" vs "X: Nightreign").
    if not data or not data.get("items"):
        stripped = strip_edition_suffix(cleaned_title)
        if stripped and stripped != cleaned_title:
            time.sleep(REQUEST_DELAY)
            data = _storesearch(stripped)
            target = stripped

    if not data or not data.get("items"):
        return None

    best = None
    best_score = 0.0
    target = target.lower()
    for item in data["items"]:
        if item.get("type") != "app":
            continue
        name = item.get("name", "")
        score = SequenceMatcher(None, target, name.lower()).ratio()
        if score > best_score:
            best_score = score
            best = item

    if best and best_score >= MIN_SIMILARITY:
        return best["id"], best["name"], best_score
    return None


def fetch_appdetails(appid):
    url = f"https://store.steampowered.com/api/appdetails?appids={appid}&l=english"
    data = http_get_json(url)
    if not data:
        return None
    entry = data.get(str(appid))
    if not entry or not entry.get("success"):
        return None
    return entry["data"]


def extract_fields(appdata):
    if appdata.get("type") not in ("game",):
        return None

    movies = appdata.get("movies") or []
    trailer_hls = None
    trailer_thumb = None
    if movies:
        highlight = next((m for m in movies if m.get("highlight")), movies[0])
        trailer_hls = highlight.get("hls_h264")
        trailer_thumb = highlight.get("thumbnail")

    screenshots = [s["path_full"] for s in (appdata.get("screenshots") or [])[:5]]

    req = appdata.get("pc_requirements") or {}
    if not isinstance(req, dict):
        req = {}

    metacritic = appdata.get("metacritic") or {}

    out = {
        "steam_appid": appdata.get("steam_appid"),
        "steam_name": appdata.get("name"),
        "trailer_hls": trailer_hls,
        "trailer_thumb": trailer_thumb,
        "screenshots": screenshots,
        "about_the_game": appdata.get("about_the_game") or appdata.get("short_description") or "",
        "requirements_minimum": req.get("minimum", ""),
        "requirements_recommended": req.get("recommended", ""),
        "genres": [g["description"] for g in (appdata.get("genres") or [])],
        "developers": appdata.get("developers") or [],
        "publishers": appdata.get("publishers") or [],
        "release_date": (appdata.get("release_date") or {}).get("date", ""),
    }
    if isinstance(metacritic.get("score"), int):
        out["metacritic_score"] = metacritic["score"]
    return out


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _atomic_replace(tmp, dest):
    # On Windows, os.replace() can hit a transient PermissionError if the
    # destination is briefly opened by another process (e.g. a local dev
    # server serving it to a browser). Retry a few times before giving up.
    import os
    for attempt in range(5):
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(1)


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    _atomic_replace(tmp, STATE_FILE)


def write_output(state, valid_titles):
    # state is append-only (keyed by every title ever seen, so a renamed or
    # removed title's old entry is never deleted from it) — restrict the
    # output to titles that still exist in the source catalog, or a rename
    # leaves the old title's entry in steamrip_games_gameplay.json forever,
    # orphaning a gameplay/<hash>.json file that nothing will ever request
    # again (split_gameplay_data.py prunes derived files it didn't just
    # write, but only this filters the source data itself).
    matched = {
        title: v for title, v in state.items()
        if v.get("matched") and title in valid_titles
    }
    output = {title: v["data"] for title, v in matched.items()}
    tmp = OUTPUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    _atomic_replace(tmp, OUTPUT_FILE)


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    with open(DATA_FILE, encoding="utf-8") as f:
        games = json.load(f)
    titles = [g["title"] for g in games if g.get("title")]
    valid_titles = set(titles)

    state = load_state()
    remaining = [t for t in titles if t not in state]
    if limit:
        remaining = remaining[:limit]

    total = len(titles)
    print(f"Total titles: {total}. Already processed: {len(state)}. To do this run: {len(remaining)}")

    processed_this_run = 0
    matched_this_run = 0
    for i, title in enumerate(remaining):
        cleaned = clean_title(title)
        result = search_appid(cleaned)
        time.sleep(REQUEST_DELAY)

        if not result:
            state[title] = {"matched": False, "reason": "no_search_match"}
        else:
            appid, matched_name, score = result
            appdata = fetch_appdetails(appid)
            time.sleep(REQUEST_DELAY)
            fields = extract_fields(appdata) if appdata else None
            if fields:
                state[title] = {"matched": True, "appid": appid, "score": round(score, 3), "data": fields}
                matched_this_run += 1
            else:
                state[title] = {"matched": False, "reason": "appdetails_failed_or_not_game", "appid": appid}

        processed_this_run += 1
        done = len(state)
        if processed_this_run % 25 == 0 or (i == len(remaining) - 1):
            save_state(state)
            write_output(state, valid_titles)
            pct = done / total * 100
            print(f"[{done}/{total}] ({pct:.1f}%) — this run: {processed_this_run} processed, {matched_this_run} matched. Last: '{title[:50]}' -> {'OK' if state[title]['matched'] else 'no match'}", flush=True)

    save_state(state)
    write_output(state, valid_titles)
    total_matched = sum(1 for v in state.values() if v.get("matched"))
    print(f"\nDone. {len(state)}/{total} titles processed, {total_matched} matched with gameplay data.")


if __name__ == "__main__":
    main()
