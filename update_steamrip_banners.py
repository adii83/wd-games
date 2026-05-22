import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
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
        encoded_text = text.encode(encoding, errors="replace").decode(encoding)
        sys.stdout.write(encoded_text + end)
        sys.stdout.flush()

print = safe_print

INPUT_FILE = Path("steamrip_games.json")
OUTPUT_FILE = Path("steamrip_games_updated.json")
STEAMGRIDDB_API_KEY = "7b17f9a06d51df5f0c2d91873d7f2032"
API_BASE = "https://www.steamgriddb.com/api/v2"

TITLE_CLEANUP_PATTERNS = [
    r"\bonline\b",
    r"\bmultiplayer\b",
    r"\bco[- ]?op\b",
    r"\bfree download\b",
]

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
    r"\bdirector\'s\s+cut\b",
    r"\bcollector\'s\s+edition\b",
    r"\bdigital\s+deluxe\b",
]

MANUAL_GAME_IDS = {
    "resident evil 4 remake": 5332120,
    "resident evil 4": 5332120,
    "resident evil 2": 29143,
    "resident evil 2 remake": 29143,
    "resident evil 3": 5253703,
    "resident evil 3 remake": 5253703,
    "silent hill 2": 5359291,
    "silent hill 2 remake": 5359291,
    "dead space": 5338378,
    "dead space remake": 5338378,
    "system shock": 12164,
    "system shock remake": 12164,
    "resident evil biohazard hd remaster": 4793,
    "resident evil hd remaster": 4793,
    "resident evil hd": 4793,
}

def load_games(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError("JSON must contain an array of objects.")
    return data

import os

def save_games(path: Path, data: List[Dict[str, Any]]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_path, path)
    except Exception as e:
        print(f"[SAVE ERROR] Failed to atomically save file: {e}")
        # fallback to standard write if rename fails
        with path.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")


def normalize_banner_url(url: Optional[str]) -> str:
    if not url:
        return ""
    return str(url).strip()

def resolve_manual_game_id(cleaned_title: str) -> Optional[int]:
    if not cleaned_title:
        return None
    t = cleaned_title.lower().strip()
    return MANUAL_GAME_IDS.get(t)

def should_process_game(game: Dict[str, Any]) -> bool:
    original_title = game.get("title", "")
    cleaned_title = clean_title(original_title)
    if resolve_manual_game_id(cleaned_title) is not None:
        return True

    banner_url = normalize_banner_url(game.get("banner_url"))
    if not banner_url:
        return True
    if "steamstatic" in banner_url.lower():
        return False
    return True

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
        re.IGNORECASE
    )
    while True:
        new_t = pattern.sub("", t).strip()
        if new_t == t:
            break
        t = new_t
    return t

def clean_title(title: Any) -> str:
    value = strip_version_suffix(title)
    if not value:
        return ""

    value = value.replace("/", " ").replace("\\", " ")
    value = re.sub(r"\b(?:" + "|".join(TITLE_CLEANUP_PATTERNS) + r")\b", "", value, flags=re.I)
    value = re.sub(r"\(\s*\+\s*\)", "", value)
    value = re.sub(r"\+\s*\)", ")", value)
    value = re.sub(r"\(\s*\)", "", value)
    value = re.sub(r"[:\-–—]+\s*$", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value

def fetch_json_with_retry(url: str, custom_headers: Optional[Dict[str, str]] = None, max_retries: int = 5, initial_backoff: float = 2.0) -> Dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "wd-games-banner-updater/1.0",
    }
    if custom_headers:
        headers.update(custom_headers)
        
    backoff = initial_backoff
    for attempt in range(max_retries):
        try:
            request = Request(url, headers=headers)
            with urlopen(request, timeout=30) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload)
        except HTTPError as e:
            if e.code in (429, 403, 500, 502, 503, 504):
                print(f"  [API WARNING] HTTP {e.code} for URL: {url}. Retrying in {backoff:.1f}s... (Attempt {attempt+1}/{max_retries})")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise e
        except Exception as e:
            print(f"  [API WARNING] Error: {e}. Retrying in {backoff:.1f}s... (Attempt {attempt+1}/{max_retries})")
            time.sleep(backoff)
            backoff *= 2
            continue
    raise Exception(f"Failed to fetch URL after {max_retries} attempts: {url}")

def fetch_json(url: str, custom_headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    return fetch_json_with_retry(url, custom_headers)

def check_url_exists(url: str) -> bool:
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=10) as response:
            return response.status == 200
    except Exception:
        return False

def search_steam_store(clean_title_text: str) -> tuple[Optional[Dict[str, Any]], bool]:
    url = f"https://store.steampowered.com/api/storesearch/?term={quote(clean_title_text)}&l=english&cc=US"
    try:
        payload = fetch_json(url, custom_headers={"User-Agent": "Mozilla/5.0"})
        items = payload.get("items") or []
        if items:
            return items[0], True
        return None, True
    except Exception as e:
        print(f"[STEAM SEARCH FAIL] {clean_title_text}: {e}")
        return None, False

def query_steamgriddb_by_steam_id(appid: int) -> Optional[Dict[str, Any]]:
    url = f"{API_BASE}/games/steam/{appid}"
    try:
        payload = fetch_json(url, custom_headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"})
        if payload.get("success") and payload.get("data"):
            return payload["data"]
        return None
    except Exception as e:
        print(f"[SGDB STEAM ID FAIL] appid={appid}: {e}")
        return None

def query_steamgriddb_autocomplete(clean_title_text: str) -> List[Dict[str, Any]]:
    url = f"{API_BASE}/search/autocomplete/{quote(clean_title_text)}"
    try:
        payload = fetch_json(url, custom_headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"})
        if payload.get("success") and payload.get("data"):
            return payload["data"]
        return []
    except Exception as e:
        print(f"[SGDB AUTOCOMPLETE FAIL] {clean_title_text}: {e}")
        return []

def fetch_sgdb_grids(game_id: int) -> List[Dict[str, Any]]:
    url = f"{API_BASE}/grids/game/{game_id}"
    try:
        payload = fetch_json(url, custom_headers={"Authorization": f"Bearer {STEAMGRIDDB_API_KEY}"})
        if payload.get("success") and payload.get("data"):
            return payload["data"]
        return []
    except Exception as e:
        print(f"[SGDB GRIDS FAIL] game_id={game_id}: {e}")
        return []

def select_best_grid(grids: List[Dict[str, Any]]) -> Optional[str]:
    if not grids:
        return None
    
    # 1. 600x900 dimension
    for g in grids:
        if g.get("width") == 600 and g.get("height") == 900:
            return g.get("url")
            
    # 2. Any vertical dimension (height > width)
    for g in grids:
        w, h = g.get("width", 0), g.get("height", 0)
        if h > w:
            return g.get("url")
            
    # 3. 342x482 (older vertical dimension)
    for g in grids:
        if g.get("width") == 342 and g.get("height") == 482:
            return g.get("url")
            
    # 4. Fallback to first available grid URL
    return grids[0].get("url")

def get_game_cover(original_title: str, existing_banner: Optional[str] = None) -> tuple[Optional[str], str]:
    cleaned = clean_title(original_title)
    if not cleaned:
        return None, "empty_title"
        
    # Check manual mapping first
    sgdb_id = resolve_manual_game_id(cleaned)
    if sgdb_id:
        grids = fetch_sgdb_grids(sgdb_id)
        cover_url = select_best_grid(grids)
        if cover_url:
            return cover_url, f"Manual SGDB ID ({sgdb_id})"
            
    # Try search terms list
    search_queries = [cleaned]
    
    # If title has "remake" in it, try without "remake"
    if "remake" in cleaned.lower():
        no_remake = re.sub(r"\bremake\b", "", cleaned, flags=re.I).strip()
        no_remake = re.sub(r"\s+", " ", no_remake)
        if no_remake and no_remake not in search_queries:
            search_queries.append(no_remake)
            
    # If title has edition suffixes, try without them
    no_edition = cleaned
    for pattern in EDITION_TERMS:
        no_edition = re.sub(pattern, "", no_edition, flags=re.I)
    no_edition = re.sub(r"\s+", " ", no_edition).strip()
    if no_edition and no_edition not in search_queries:
        search_queries.append(no_edition)
        
    # Also if the edition-stripped title has "remake" in it, try without "remake"
    if "remake" in no_edition.lower():
        no_remake_no_edition = re.sub(r"\bremake\b", "", no_edition, flags=re.I).strip()
        no_remake_no_edition = re.sub(r"\s+", " ", no_remake_no_edition)
        if no_remake_no_edition and no_remake_no_edition not in search_queries:
            search_queries.append(no_remake_no_edition)
            
    # Try searching Steam for each query in order
    steam_item = None
    for q in search_queries:
        print(f"  Searching Steam Store for: '{q}'")
        steam_item, success = search_steam_store(q)
        time.sleep(0.3)
        if steam_item:
            break

    if steam_item:
        appid = steam_item["id"]
        # Try direct Steam CDN 600x900
        steam_cdn_url = f"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg"
        if check_url_exists(steam_cdn_url):
            return steam_cdn_url, f"Steam CDN (library_600x900, appid={appid})"
        else:
            print(f"  Steam CDN library_600x900 not found for AppID {appid} ({steam_item.get('name')})")
        
        # Try SteamGridDB by Steam AppID
        sgdb_game = query_steamgriddb_by_steam_id(appid)
        time.sleep(0.3)
        if sgdb_game:
            grids = fetch_sgdb_grids(sgdb_game["id"])
            time.sleep(0.3)
            cover_url = select_best_grid(grids)
            if cover_url:
                return cover_url, f"SteamGridDB via AppID {appid}"
                
        # Try Steam store tiny_image capsule
        tiny_img = steam_item.get("tiny_image")
        if tiny_img:
            return tiny_img, f"Steam Store Capsule (appid={appid})"

    # Fallback: keep existing SteamGridDB banner if we already have one
    if existing_banner and "steamgriddb.com" in existing_banner.lower():
        return existing_banner, "Keep existing SteamGridDB cover"

    # Fallback: SteamGridDB Autocomplete by title
    candidates = query_steamgriddb_autocomplete(cleaned)
    time.sleep(0.3)
    for cand in candidates[:3]:
        cand_id = cand["id"]
        cand_name = cand["name"]
        grids = fetch_sgdb_grids(cand_id)
        time.sleep(0.3)
        cover_url = select_best_grid(grids)
        if cover_url:
            return cover_url, f"SteamGridDB Autocomplete (name='{cand_name}', id={cand_id})"
            
    return None, "not_found"

def update_games() -> None:
    source_path = OUTPUT_FILE if OUTPUT_FILE.exists() else INPUT_FILE
    print(f"Loading games from: {source_path}")
    games = load_games(source_path)
    
    updated_count = 0
    skipped_count = 0
    failed_count = 0
    
    total_games = len(games)
    print(f"Total games in database: {total_games}")
    
    for index, game in enumerate(games, start=1):
        try:
            if not isinstance(game, dict):
                skipped_count += 1
                continue
                
            if not should_process_game(game):
                skipped_count += 1
                continue
                
            original_title = game.get("title", "")
            existing_banner = game.get("banner_url", "")
            print(f"[{index}/{total_games}] Processing: {original_title}")
            
            cover_url, source = get_game_cover(original_title, existing_banner)
            
            if not cover_url:
                failed_count += 1
                print(f"  FAILED to find cover. Reason: {source}")
                continue
                
            game["banner_url"] = cover_url
            updated_count += 1
            print(f"  UPDATED: {cover_url} ({source})")
            
            # Save every 20 updates to reduce disk I/O and prevent corruption
            if updated_count % 20 == 0:
                save_games(OUTPUT_FILE, games)
            
        except Exception as error:
            failed_count += 1
            print(f"[{index}/{total_games}] ERROR: {game.get('title', 'Unknown')} -> {error}")
            
    save_games(OUTPUT_FILE, games)
    print("\nProcessing complete.")
    print(f"Updated: {updated_count}")
    print(f"Skipped: {skipped_count}")
    print(f"Failed: {failed_count}")
    print(f"Output saved to: {OUTPUT_FILE.resolve()}")

if __name__ == "__main__":
    update_games()
