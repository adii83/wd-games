"""
Split steamrip_games_gameplay.json (a single 23MB dict keyed by title) into
one small JSON file per title under gameplay/<hash>.json.

Why: index.html / game.html used to fetch the entire 23MB file on every
single page load just to read one (game.html) or a handful (hero/Featured
This Week on index.html) of entries out of it. Splitting means each page
only downloads the few KB it actually needs.

The filename is a FNV-1a 32-bit hash of the exact title string (hex,
lowercase) — not a sanitized title — because titles contain characters
that are unsafe or ambiguous as filenames (/, :, ™, curly quotes, CJK,
etc.). js/feature.js and js/feature-detail.js compute the identical hash
client-side (over the UTF-8 bytes, matching Python's str.encode('utf-8'))
so no separate title->filename index file needs to be fetched either.

Safe to re-run any time enrich_steam_data.py refreshes
steamrip_games_gameplay.json — it just overwrites the gameplay/ folder.

Usage:
    python split_gameplay_data.py
"""
import json
import os
import time

SOURCE_FILE = "steamrip_games_gameplay.json"
OUTPUT_DIR = "gameplay"


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


def main():
    with open(SOURCE_FILE, encoding="utf-8") as f:
        gameplay = json.load(f)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    hash_to_title = {}
    collisions = []
    written = 0

    for title, entry in gameplay.items():
        h = fnv1a_32(title)
        if h in hash_to_title and hash_to_title[h] != title:
            collisions.append((title, hash_to_title[h], h))
            continue
        hash_to_title[h] = title

        dest = os.path.join(OUTPUT_DIR, f"{h}.json")
        tmp = dest + ".tmp"
        # Compact (no indent) — these are fetched by the browser, not
        # hand-edited, so minimizing bytes over the wire matters more than
        # readability here.
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entry, f, ensure_ascii=False, separators=(",", ":"))
        _atomic_replace(tmp, dest)
        written += 1

    print(f"Source entries: {len(gameplay)}")
    print(f"Files written to {OUTPUT_DIR}/: {written}")
    if collisions:
        print(f"\nWARNING: {len(collisions)} hash collision(s) skipped (kept the first title, dropped the rest):")
        for title, kept, h in collisions:
            print(f"  hash {h}: kept {kept!r}, dropped {title!r}")
    else:
        print("No hash collisions.")


if __name__ == "__main__":
    main()
