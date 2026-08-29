"""
Checks every ps3.json title against Steam (same search+appdetails lookup
enrich_steam_data.py already uses for the PC catalog) to find out whether it
has a PC/Steam release ANYWHERE - not just whether it happens to already be
in this store's own steamrip_games_updated.json. String-matching PS3 titles
against only our own PC catalog (scrape_ps3_romsfun.py's normalize_title())
misses games we simply don't stock on PC yet (e.g. "Watch Dogs" was in
ps3.json untouched because our PC catalog only had "Watch Dogs Digital
Deluxe Edition" and "Watch Dogs: Legion", not plain "Watch Dogs") - this is
the actual "is it PS3-exclusive" ground-truth check instead.

Resumable: progress checkpointed to STATE_FILE after every batch, same
pattern as enrich_steam_data.py's steam_enrich_progress.json.

Usage:
    python filter_ps3_exclusives.py            # process everything remaining
    python filter_ps3_exclusives.py --limit 20 # spot-check a small batch
    python filter_ps3_exclusives.py --apply    # remove matched titles from ps3.json (only after a full run)
"""
import json
import re
import sys
import time
from difflib import SequenceMatcher

from enrich_steam_data import clean_title, search_appid, fetch_appdetails, REQUEST_DELAY

PS3_FILE = "ps3.json"
STATE_FILE = "ps3_exclusivity_progress.json"

# enrich_steam_data's MIN_SIMILARITY=0.55 is fine for "find media for a game
# we already know is on Steam" (a bad match just means missing a trailer).
# Here a bad match means DELETING inventory, so this needs to be much
# stricter: a high ratio AND matching "sequel signature" (roman numerals
# folded to digits) - otherwise "Mortal Kombat" -> "Mortal Kombat 1" (0.929)
# or "Hatsune Miku: Project DIVA" -> "...Mega Mix+" (0.82) get accepted as
# the same game when they are not. See scrape_ps3_romsfun.py's
# normalize_title() for the same guard applied to the PC-catalog pass.
CONFIDENT_SIMILARITY = 0.90
ROMAN_MAP = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8,
    "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15,
}
ROMAN_TOKEN_RE = re.compile(r"\b(" + "|".join(sorted(ROMAN_MAP, key=len, reverse=True)) + r")\b")
# Edition/version tags Steam listings commonly append that a plain PS3
# listing never carries (e.g. our "Naruto ... Storm 3" vs Steam's
# "... Storm 3 Full Burst HD") - stripped so both sides compare on the
# base game name only, same idea as GOTY/HD variants approved earlier.
EDITION_TAG_RE = re.compile(
    r"\b(hd|remaster(?:ed)?|definitive|goty|game of the year|deluxe|ultimate|"
    r"complete|enhanced|anniversary|legendary|premium|full burst|directors? cut|"
    r"special edition|standard edition|edition)\b"
)


def normalize_compare(title):
    # search_appid()'s own ratio compares against Steam's RAW result name
    # (e.g. "Watch_Dogs™") - the underscore and trademark symbol alone
    # drag a genuine 1:1 match down to 0.857, under the 0.90 bar. Redo the
    # comparison on a properly normalized form of BOTH sides instead of
    # trusting that raw score.
    t = title.lower()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = ROMAN_TOKEN_RE.sub(lambda m: str(ROMAN_MAP[m.group(1)]), t)
    t = EDITION_TAG_RE.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def number_signature(normalized_title):
    return set(re.findall(r"\d+", normalized_title))


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    import os
    os.replace(tmp, STATE_FILE)


def is_confident_match(title, matched_name):
    na, nb = normalize_compare(title), normalize_compare(matched_name)
    ratio = SequenceMatcher(None, na, nb).ratio()
    return ratio >= CONFIDENT_SIMILARITY and number_signature(na) == number_signature(nb), ratio


def check_one(title):
    cleaned = clean_title(title)
    result = search_appid(cleaned)
    time.sleep(REQUEST_DELAY)
    if not result:
        return {"has_pc": False}
    appid, matched_name, score = result
    confident, cmp_ratio = is_confident_match(title, matched_name)
    if not confident:
        return {"has_pc": False, "reason": "low_confidence", "appid": appid, "matched_name": matched_name, "score": round(score, 3), "cmp_ratio": round(cmp_ratio, 3)}
    appdata = fetch_appdetails(appid)
    time.sleep(REQUEST_DELAY)
    is_game = bool(appdata and appdata.get("type") == "game")
    return {"has_pc": is_game, "appid": appid, "matched_name": matched_name, "score": round(score, 3), "cmp_ratio": round(cmp_ratio, 3)}


def rescore_existing(title, entry):
    # Reuse an already-fetched search result (appid/matched_name) from a
    # prior run without re-hitting Steam - only appdetails (to confirm
    # type=="game") needs a fresh call, and only for entries that newly
    # pass the fixed comparison.
    if not entry.get("matched_name"):
        return entry
    confident, cmp_ratio = is_confident_match(title, entry["matched_name"])
    if not confident:
        entry["cmp_ratio"] = round(cmp_ratio, 3)
        return entry
    if entry.get("has_pc"):
        entry["cmp_ratio"] = round(cmp_ratio, 3)
        return entry  # already counted, appdetails already confirmed
    appdata = fetch_appdetails(entry["appid"])
    time.sleep(REQUEST_DELAY)
    entry["has_pc"] = bool(appdata and appdata.get("type") == "game")
    entry["cmp_ratio"] = round(cmp_ratio, 3)
    entry.pop("reason", None)
    return entry


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    apply_mode = "--apply" in sys.argv
    rescore_mode = "--rescore" in sys.argv

    if "--selftest" in sys.argv:
        assert is_confident_match("Watch Dogs", "Watch_Dogs™")[0]
        assert is_confident_match(
            "Naruto Shippuden: Ultimate Ninja Storm 3",
            "NARUTO SHIPPUDEN: Ultimate Ninja STORM 3 Full Burst HD",
        )[0]
        assert not is_confident_match("Mortal Kombat", "Mortal Kombat 1")[0]
        assert not is_confident_match("NBA 2K9", "NBA 2K19")[0]
        print("is_confident_match selftest OK")
        return

    if rescore_mode:
        state = load_state()
        was_true = sum(1 for v in state.values() if v.get("has_pc"))
        newly_true = []
        for i, (title, entry) in enumerate(state.items()):
            was = entry.get("has_pc")
            state[title] = rescore_existing(title, entry)
            if state[title].get("has_pc") and not was:
                newly_true.append(title)
            if (i + 1) % 200 == 0:
                save_state(state)
                print(f"[{i + 1}/{len(state)}] rescored, {len(newly_true)} newly flagged so far", flush=True)
        save_state(state)
        now_true = sum(1 for v in state.values() if v.get("has_pc"))
        print(f"Rescore done. has_pc True: {was_true} -> {now_true} (+{len(newly_true)} newly found)")
        for t in newly_true:
            print("  NEW:", t, "->", state[t].get("matched_name"))
        return

    with open(PS3_FILE, encoding="utf-8") as f:
        games = json.load(f)
    titles = [g["title"] for g in games]

    if apply_mode:
        state = load_state()
        missing = [t for t in titles if t not in state]
        if missing:
            print(f"Refusing to apply: {len(missing)} titles not yet checked (run without --apply first).")
            return
        keep = [g for g in games if not state.get(g["title"], {}).get("has_pc")]
        removed = [g["title"] for g in games if state.get(g["title"], {}).get("has_pc")]
        print(f"Removing {len(removed)} titles with a Steam/PC release, keeping {len(keep)} PS3-exclusive titles.")
        with open(PS3_FILE, "w", encoding="utf-8") as f:
            json.dump(keep, f, ensure_ascii=False, separators=(",", ":"))
        with open("ps3_exclusivity_removed.txt", "w", encoding="utf-8") as f:
            for t in removed:
                f.write(t + "\n")
        return

    state = load_state()
    remaining = [t for t in titles if t not in state]
    if limit:
        remaining = remaining[:limit]

    total = len(titles)
    print(f"Total: {total}. Already checked: {len(state)}. This run: {len(remaining)}")

    for i, title in enumerate(remaining):
        state[title] = check_one(title)
        if (i + 1) % 25 == 0 or i == len(remaining) - 1:
            save_state(state)
            done = len(state)
            has_pc_count = sum(1 for v in state.values() if v.get("has_pc"))
            print(f"[{done}/{total}] ({done/total*100:.1f}%) - {has_pc_count} found with a PC release so far", flush=True)

    save_state(state)
    print("Done checking. Run with --apply to remove titles found to have a PC release.")


if __name__ == "__main__":
    main()
