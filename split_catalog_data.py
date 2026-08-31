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
import re
import sys
import time

# Windows terminals default to a codepage (cp1252) that can't display every
# character some game titles contain (CJK, emoji, etc.) — without this,
# printing them crashes the script after the actual file-writing work is
# already done. Harmless either way on GitHub Actions' Ubuntu runner
# (UTF-8 by default), but this keeps local runs from crashing too.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SOURCES = [
    ("steamrip_games_updated.json", "pc", "steamrip_games_updated.lite.json"),
    ("ps2.json", "ps2", "ps2.lite.json"),
    ("ps3.json", "ps3", "ps3.lite.json"),
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


# "Low Spek" Kategori filter (js/feature.js): RAM minimum <=4GB AND the
# Graphics requirement doesn't name a heavy-tier GPU. Computed here (not
# client-side) because the lite listing deliberately excludes
# system_requirements entirely to keep the gallery's payload small — only
# this precomputed boolean gets baked into the lite entry instead.
# ponytail: GPU "heavy" list is a manual keyword heuristic, not a real
# benchmark tier lookup - repack-site requirement text has no structured
# tier data to key off. Upgrade path if misclassifications turn up: curate
# an explicit exclude-list of titles rather than growing this regex forever.
_HEAVY_GPU_RE = re.compile(
    r"\b(rtx|gtx\s*9[6-9]\d|gtx\s*1\d{3}|rx\s*[4-9]\d{2}|rx\s*[5-9]\d{3}|vega|radeon\s*vii|arc\s*a7\d0)\b",
    re.IGNORECASE,
)
_LOW_SPEC_RAM_LIMIT_GB = 4


def _parse_size_to_gb(value):
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return 0
    m = re.search(r"([\d.]+)\s*(GB|MB)", value, re.IGNORECASE)
    if not m:
        return 0
    n = float(m.group(1))
    return n / 1024 if m.group(2).upper() == "MB" else n


def is_low_spec(entry):
    sr = entry.get("system_requirements") or {}
    memory = sr.get("Memory")
    if not memory:
        return False
    ram_gb = _parse_size_to_gb(memory)
    if not ram_gb or ram_gb > _LOW_SPEC_RAM_LIMIT_GB:
        return False
    graphics = sr.get("Graphics")
    if graphics and _HEAVY_GPU_RE.search(graphics):
        return False
    return True


def lite_entry(entry):
    game_info = entry.get("game_info") or {}
    lite = {
        "title": entry.get("title"),
        "banner_url": entry.get("banner_url"),
        "game_info": {
            "Genre": game_info.get("Genre"),
            "Game Size": game_info.get("Game Size"),
        },
        "is_low_spec": is_low_spec(entry),
    }
    # Admin's "Online" override (js/admin.js) — a real bool means "force
    # this badge on/off"; the key is simply absent for "auto-detect from
    # title" (js/feature.js's requiresOnline() treats those the same way).
    if isinstance(entry.get("online_override"), bool):
        lite["online_override"] = entry["online_override"]
    return lite


def main():
    os.makedirs(CATALOG_DIR, exist_ok=True)

    hash_to_key = {}
    collisions = []
    duplicate_titles = []
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
            if h in hash_to_key:
                # Same category+title appearing twice in the source data
                # (e.g. two PS2 entries that happen to share a title) is a
                # different problem than an actual hash collision — the hash
                # function did its job, the *source data* is ambiguous.
                # Either way, only one of them can occupy catalog/<hash>.json,
                # so the later entry silently wins; at least make that loud
                # instead of leaving it invisible in the output.
                if hash_to_key[h] == key:
                    duplicate_titles.append(key)
                else:
                    collisions.append((key, hash_to_key[h], h))
                    continue
            hash_to_key[h] = key

            _write_json_compact(os.path.join(CATALOG_DIR, f"{h}.json"), entry)
            catalog_written += 1

        _write_json_compact(lite_file, lite_list)
        print(f"{source_file}: {len(entries)} entries -> {lite_file}")

    print(f"\nPer-game files written to {CATALOG_DIR}/: {catalog_written} ({len(hash_to_key)} unique)")
    if duplicate_titles:
        print(f"\nNOTE: {len(duplicate_titles)} title(s) appear more than once in the source data — only the last occurrence's data survives in catalog/ (same title -> same file):")
        for key in duplicate_titles:
            print(f"  {key!r}")
    if collisions:
        print(f"\nWARNING: {len(collisions)} hash collision(s) skipped (kept the first, dropped the rest):")
        for key, kept, h in collisions:
            print(f"  hash {h}: kept {kept!r}, dropped {key!r}")
    else:
        print("No hash collisions.")

    # A title edit (admin panel or otherwise) changes that entry's hash,
    # which creates a new file but leaves the old hash's file behind with
    # stale data — nothing ever pointed at the new hash, and nothing will
    # ever ask for the old one again either. Delete anything in catalog/
    # that isn't a hash we just wrote.
    valid_files = {f"{h}.json" for h in hash_to_key}
    removed = 0
    for name in os.listdir(CATALOG_DIR):
        if name.endswith(".json") and name not in valid_files:
            os.remove(os.path.join(CATALOG_DIR, name))
            removed += 1
    if removed:
        print(f"Removed {removed} orphaned file(s) left over from title changes.")


def _selftest():
    low = {"system_requirements": {"Memory": "4 GB RAM", "Graphics": "GeForce 9800GT"}}
    assert is_low_spec(low) is True
    high_ram = {"system_requirements": {"Memory": "16 GB RAM", "Graphics": "GeForce 9800GT"}}
    assert is_low_spec(high_ram) is False
    heavy_gpu = {"system_requirements": {"Memory": "4 GB RAM", "Graphics": "NVIDIA GeForce RTX 3060"}}
    assert is_low_spec(heavy_gpu) is False
    no_data = {"system_requirements": {}}
    assert is_low_spec(no_data) is False
    mb_ram = {"system_requirements": {"Memory": "512 MB RAM"}}
    assert is_low_spec(mb_ram) is True
    print("is_low_spec selftest OK")

    assert "online_override" not in lite_entry({"title": "X"})
    assert lite_entry({"title": "X", "online_override": True})["online_override"] is True
    assert lite_entry({"title": "X", "online_override": False})["online_override"] is False
    print("lite_entry online_override selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        main()
