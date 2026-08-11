"""
Rewrite game_info.Genre in steamrip_games_updated.json (PC catalog) using
Steam's own official genre list wherever a Steam match already exists.

Steam genre data was already collected once by enrich_steam_data.py and
lives in steamrip_games_gameplay.json (dict keyed by exact title, each
entry has a "genres" array pulled straight from Steam's appdetails API).
This script does not call any API again — it just reconciles the two files
already on disk, so it's fast and safe to re-run at any time.

Titles with no Steam match (no entry in steamrip_games_gameplay.json, or an
empty genres list there) are left untouched — there's no better source to
fall back to, and their existing scraped Genre value is kept as-is.

Usage:
    python update_pc_genres_from_steam.py
"""
import json
import time

DATA_FILE = "steamrip_games_updated.json"
GAMEPLAY_FILE = "steamrip_games_gameplay.json"


def _atomic_replace(tmp, dest):
    import os
    for attempt in range(5):
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(1)


def main():
    with open(DATA_FILE, encoding="utf-8") as f:
        pc_games = json.load(f)
    with open(GAMEPLAY_FILE, encoding="utf-8") as f:
        gameplay = json.load(f)

    updated = 0
    unchanged_matched = 0
    no_match = 0

    for game in pc_games:
        title = game.get("title")
        entry = gameplay.get(title)
        if not entry or not entry.get("genres"):
            no_match += 1
            continue

        new_genre = ", ".join(entry["genres"])
        game_info = game.get("game_info")
        if game_info is None:
            game_info = {}
            game["game_info"] = game_info

        if game_info.get("Genre") == new_genre:
            unchanged_matched += 1
            continue

        game_info["Genre"] = new_genre
        updated += 1

    print(f"Total PC entries: {len(pc_games)}")
    print(f"Updated with real Steam genre: {updated}")
    print(f"Already matched Steam genre (no change needed): {unchanged_matched}")
    print(f"No Steam match — left untouched: {no_match}")

    # Preserve the file's existing CRLF line endings and 2-space indent so
    # the git diff only shows the Genre lines that actually changed.
    text = json.dumps(pc_games, indent=2, ensure_ascii=False).replace("\n", "\r\n")
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    _atomic_replace(tmp, DATA_FILE)
    print(f"\nWrote {DATA_FILE}.")


if __name__ == "__main__":
    main()
