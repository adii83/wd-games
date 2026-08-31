"""
Repairs a bug in scrape_steamrip_recent.py: for a long stretch of its
history, the FINAL stored title for every scraper-added PC entry was run
through clean_title() -- which strips the "+ Online"/"+ Co-op"/"+
Multiplayer" tag steamrip's own post titles carry (e.g. "Schedule I
(v0.4.3f3 + Online)") -- instead of keeping the raw page title. That tag is
exactly what js/feature.js's requiresOnline() reads to show the "Online"
badge, so any affected title silently lost its badge eligibility forever
(the info isn't recoverable from the stored JSON alone).

This re-fetches the steamrip.com page (via the "url" field every
scraper-added entry carries) for every title that currently has NO online
tag, and restores the raw page title if the page's real title has one and
is otherwise still the same game (compared via clean_title()). Titles that
already carry the tag are skipped entirely -- nothing to fix there.

Resumable: progress checkpointed to STATE_FILE after every batch, same
pattern as enrich_steam_data.py / filter_ps3_exclusives.py this repo
already uses for other long re-scrape passes.

Usage:
    python repair_online_tags.py            # process everything remaining
    python repair_online_tags.py --limit 20  # spot-check a small batch
"""
import json
import re
import sys
import time

from scrape_steamrip_recent import fetch, parse_game_post, clean_title, REQUEST_DELAY

DATA_FILE = "steamrip_games_updated.json"
STATE_FILE = "online_tag_repair_progress.json"

ONLINE_TAG_RE = re.compile(
    r"""\(([^()]*)\)\s*$""",
)


def has_online_tag(title):
    if not title:
        return False
    m = ONLINE_TAG_RE.search(title)
    return bool(m and "+" in m.group(1) and re.search(r"\b(online|multiplayer|co-?op|lan|crossplay)\b", m.group(1), re.I))


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


def save_games(games):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False, indent=2)
    import os
    os.replace(tmp, DATA_FILE)


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    with open(DATA_FILE, encoding="utf-8") as f:
        games = json.load(f)

    candidates = [g for g in games if g.get("url") and not has_online_tag(g.get("title") or "")]
    state = load_state()
    remaining = [g for g in candidates if g["url"] not in state]
    if limit:
        remaining = remaining[:limit]

    print(f"Candidates without an online tag: {len(candidates)}. Already checked: {len(candidates) - len(remaining) - sum(1 for g in candidates if g['url'] not in state) + len(remaining)}")
    print(f"This run: {len(remaining)}")

    fixed = []
    for i, g in enumerate(remaining):
        url = g["url"]
        try:
            page_html = fetch(url)
            raw_title, _, _ = parse_game_post(page_html)
        except Exception as e:
            state[url] = {"error": str(e)}
            time.sleep(REQUEST_DELAY)
            continue

        same_game = raw_title and clean_title(raw_title).lower() == clean_title(g["title"]).lower()
        recovered = bool(raw_title and has_online_tag(raw_title) and same_game)
        state[url] = {"raw_title": raw_title, "recovered": recovered}
        if recovered:
            old = g["title"]
            g["title"] = raw_title
            fixed.append((old, raw_title))

        time.sleep(REQUEST_DELAY)
        if (i + 1) % 50 == 0 or i == len(remaining) - 1:
            save_state(state)
            save_games(games)
            print(f"[{i + 1}/{len(remaining)}] checked, {len(fixed)} fixed so far", flush=True)

    save_state(state)
    save_games(games)
    print(f"\nDone. {len(fixed)} title(s) had their online/co-op/multiplayer tag restored:")
    for old, new in fixed:
        print(f"  {old!r} -> {new!r}")


if __name__ == "__main__":
    main()
