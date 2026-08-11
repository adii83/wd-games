"""
Split the two catalog files (steamrip_games_updated.json for PC, ps2.json
for PS2) into:

1. Lean "lite" listings — steamrip_games_updated.lite.json / ps2.lite.json —
   each entry trimmed to {title, banner_url, game_info: {Genre, "Game
   Size"}}, the only fields the gallery (index.html / js/feature.js)
   actually reads for cards, hero, Featured This Week, search, filters and
   size math. system_requirements and the rest of game_info only matter on
   the per-game detail page, so leaving them out cuts the gallery's catalog
   fetch from ~4.6MB combined down to a few hundred KB.
2. Per-game full detail files — catalog/<hash>.json — one per entry from
   *either* catalog, containing the complete original entry (title,
   banner_url, system_requirements, full game_info, plus ps2.json's extra
   "url" field where present). game.html (js/feature-detail.js) fetches
   just the one file for the game it's showing instead of the whole 4.6MB
   combined catalog.

<hash> is FNV-1a 32-bit over "<category>:<title>" (category is "pc" or
"ps2", lowercase) — NOT title alone, because a handful of titles (e.g.
"Half-Life") exist identically on both catalogs; hashing category+title
keeps those two entries in separate files instead of colliding. This must
stay byte-identical to the hash js/feature-detail.js computes client-side
(FNV-1a 32-bit over the UTF-8 bytes of the same "<category>:<title>"
string) or lookups will silently 404.

steamrip_games_updated.json and ps2.json themselves are left completely
untouched — admin.html keeps reading/writing them exactly as before, with
zero changes to its own logic.

IMPORTANT: admin.html writes straight to steamrip_games_updated.json /
ps2.json via the GitHub API and has no idea these derived files exist. Re-run
this script (and split_gameplay_data.py, if gameplay data changed too)
after every admin-panel edit, then commit + push the results — otherwise
the live site keeps serving stale data despite the admin edit having
"saved". See CLAUDE.md.

Usage:
    python split_catalog_data.py
"""
import json
import os
import time

SOURCES = [
    ("steamrip_games_updated.json", "pc", "steamrip_games_updated.lite.json"),
    ("ps2.json", "ps2", "ps2.lite.json"),
]
CATALOG_DIR = "catalog"


def fnv1a_32(s: str) -> str:
    h = 0x811c9dc5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "x")


def _atomic_replace(tmp, dest):
    for attempt in range(5):
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(1)


def _write_json_compact(path, data):
    tmp = path + ".tmp"
    # Compact (no indent) — fetched by the browser, not hand-edited, so
    # minimizing bytes over the wire matters more than readability here.
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    _atomic_replace(tmp, path)


def lite_entry(entry):
    game_info = entry.get("game_info") or {}
    return {
        "title": entry.get("title"),
        "banner_url": entry.get("banner_url"),
        "game_info": {
            "Genre": game_info.get("Genre"),
            "Game Size": game_info.get("Game Size"),
        },
    }


def main():
    os.makedirs(CATALOG_DIR, exist_ok=True)

    hash_to_key = {}
    collisions = []
    catalog_written = 0

    for source_file, category, lite_file in SOURCES:
        with open(source_file, encoding="utf-8") as f:
            entries = json.load(f)

        lite_list = []
        for entry in entries:
            title = entry.get("title")
            lite_list.append(lite_entry(entry))

            key = f"{category}:{title}"
            h = fnv1a_32(key)
            if h in hash_to_key and hash_to_key[h] != key:
                collisions.append((key, hash_to_key[h], h))
                continue
            hash_to_key[h] = key

            _write_json_compact(os.path.join(CATALOG_DIR, f"{h}.json"), entry)
            catalog_written += 1

        _write_json_compact(lite_file, lite_list)
        print(f"{source_file}: {len(entries)} entries -> {lite_file}")

    print(f"\nPer-game files written to {CATALOG_DIR}/: {catalog_written}")
    if collisions:
        print(f"\nWARNING: {len(collisions)} hash collision(s) skipped (kept the first, dropped the rest):")
        for key, kept, h in collisions:
            print(f"  hash {h}: kept {kept!r}, dropped {key!r}")
    else:
        print("No hash collisions.")


if __name__ == "__main__":
    main()
