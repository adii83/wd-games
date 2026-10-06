"""Fill PS2 covers from the libretro thumbnail set, matched by exact name.

ps2.json titles are Redump names ("187 - Ride or Die (USA) (En,Fr,Es)"), and
libretro's box art files are named after the very same Redump entries, so the
match is a name lookup, not a search - it can't land on a different game.
(The Wikipedia image search this replaces could: it gave "187 - Ride or Die"
the scan of a book called "A Ride to Khiva".)

Every entry with a libretro match gets that cover. A title with no exact
file falls back to the same game's box art from another release (same name
before the first " (", USA preferred). With no match at all the existing
cover is kept - except a Wikipedia one, which is blanked rather than trusted.

libretro's files are ~650 KB PNGs, far too heavy for a card grid, so the
stored URL goes through the wsrv.nl image proxy, which resizes to COVER_WIDTH
and re-encodes as WebP (~45 KB) on the fly and caches the result.

    python fill_ps2_covers_libretro.py            # report only
    python fill_ps2_covers_libretro.py --apply    # also write ps2.json (after a backup)
"""
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATA_FILE = Path("ps2.json")
REPO_API = "https://api.github.com/repos/libretro-thumbnails/Sony_-_PlayStation_2/git/trees/"
IMAGE_BASE = "https://thumbnails.libretro.com/Sony - PlayStation 2/Named_Boxarts/"
# ponytail: free third-party proxy; if it ever goes away, covers break until
# this script is re-run with another resizer (or the images are self-hosted).
PROXY = "https://wsrv.nl/?url={src}&w={width}&output=webp&q=80"
COVER_WIDTH = 360  # cards are ~170-260 CSS px wide; leaves room for high-DPI phones


def cover_url(name):
    return PROXY.format(src=quote(IMAGE_BASE + name + ".png", safe=""), width=COVER_WIDTH)


def fetch_json(url):
    with urlopen(Request(url, headers={"User-Agent": "wd-games-cover-filler"}), timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def libretro_name(title):
    # libretro replaces characters that aren't safe in file names with "_".
    return re.sub(r'[&*/:`<>?\\|"]', "_", title)


def base_name(name):
    return name.split(" (")[0].lower()


def list_boxarts():
    root = fetch_json(REPO_API + "master")
    sha = next(item["sha"] for item in root["tree"] if item["path"] == "Named_Boxarts")
    tree = fetch_json(REPO_API + sha)
    if tree.get("truncated"):
        raise RuntimeError("GitHub truncated the box art listing; refusing to work from a partial list.")
    return [item["path"][:-4] for item in tree["tree"] if item["path"].endswith(".png")]


def pick(title, names, by_base):
    name = libretro_name(title)
    if name in names:
        return name
    same_game = by_base.get(base_name(name), [])
    return next((n for n in same_game if "(USA" in n), same_game[0] if same_game else None)


def main():
    boxarts = list_boxarts()
    names = set(boxarts)
    by_base = {}
    for name in boxarts:
        by_base.setdefault(base_name(name), []).append(name)

    games = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    filled, kept, blanked, missing = [], [], [], []
    for game in games:
        old = game.get("banner_url") or ""
        match = pick(game["title"], names, by_base)
        if match:
            game["banner_url"] = cover_url(match)
            game["cover_source"] = "libretro"
            filled.append(f"{game['title']}  <-  {match}")
        elif "wikimedia" in old:
            game["banner_url"] = ""
            game.pop("cover_source", None)
            blanked.append(game["title"])
        if not game["banner_url"]:
            missing.append(game["title"])
        elif not match:
            kept.append(game["title"])

    print(f"libretro {len(filled)}, kept existing cover {len(kept)}, "
          f"without cover {len(missing)} (of which {len(blanked)} Wikipedia covers blanked)")
    for title in kept:
        print("  kept existing:", title)
    for title in missing:
        print("  no cover:", title)

    if "--apply" in sys.argv:
        backup = DATA_FILE.with_name(f"{DATA_FILE.name}.backup-covers-{datetime.now():%Y%m%d-%H%M%S}")
        shutil.copy2(DATA_FILE, backup)
        # ps2.json is kept minified (see minify_jsons.py).
        DATA_FILE.write_text(json.dumps(games, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("written; backup:", backup)


def _selftest():
    names = ["Disney Bolt (Europe) (En,Es,It)", "FIFA Soccer 10 (USA) (En,Fr,Es)", "Ratchet & Clank (USA)".replace("&", "_")]
    by_base = {}
    for name in names:
        by_base.setdefault(base_name(name), []).append(name)
    assert pick("Ratchet & Clank (USA)", set(names), by_base) == "Ratchet _ Clank (USA)"
    assert pick("FIFA Soccer 10 (USA)", set(names), by_base) == "FIFA Soccer 10 (USA) (En,Fr,Es)"
    assert pick("Disney Bolt (USA)", set(names), by_base) == "Disney Bolt (Europe) (En,Es,It)"
    assert pick("FIFA Soccer 11 (USA)", set(names), by_base) is None
    print("selftest OK")


if __name__ == "__main__":
    _selftest() if "--selftest" in sys.argv else main()
