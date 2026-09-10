"""
Maintains deleted_titles.json — the list of games an admin has deleted from
steamrip_games_updated.json.

Why this exists: scrape_steamrip_recent.py only knows what's *currently* in
the database. When an admin deletes a game via admin.html, that game just
looks "missing" to the scraper, so the next scrape run adds it straight
back. The scraper folds this list into its "already known" set (see
is_new_title()), so a deleted game stays deleted.

The list is rebuilt from git history every time, so it's self-correcting:

    python track_deleted_titles.py            # rebuild deleted_titles.json
    python track_deleted_titles.py --purge    # also drop tombstoned titles
                                              # from steamrip_games_updated.json

Both GitHub Actions workflows that can change steamrip_games_updated.json
run the no-arg form and commit the result. --purge is a one-off cleanup for
entries a buggy scrape already put back — review the diff before committing.

Everything is compared through clean_title() (the same normalization the
scraper dedups on), so version-suffix / "+ Online" churn in the stored
titles doesn't look like a delete. Walking commits oldest -> newest:
  - a title's clean_title() disappears from the JSON  -> added to the list
  - it reappears via an "Admin Panel" / human commit  -> removed (admin
    changed their mind — an intentional restore)
  - it reappears via a "scrape" commit               -> stays on the list
    (that reappearance IS the bug this guards against)

ponytail: commit classification is a message-prefix check. If a future
scrape workflow uses a different commit subject, add it to
SCRAPE_COMMIT_PREFIXES or its re-adds will silently clear tombstones.
"""
import json
import subprocess
import sys
from pathlib import Path

from scrape_steamrip_recent import clean_title

DATA_FILE = Path("steamrip_games_updated.json")
TOMBSTONE_FILE = Path("deleted_titles.json")

SCRAPE_COMMIT_PREFIXES = (
    "Add steamrip.com Recently Added scrape",
)


def _titles_from_json_text(text):
    data = json.loads(text)
    if not isinstance(data, list):
        return []
    return [g["title"] for g in data if isinstance(g, dict) and g.get("title")]


def _key(title):
    # clean_title() is the scraper's own dedup normalization; also fold away
    # trademark glyphs so "EA SPORTS™ Madden NFL 27" -> "EA SPORTS Madden
    # NFL 27" reads as a rename, not a delete + re-add.
    k = clean_title(title).lower()
    for ch in "™®©":
        k = k.replace(ch, "")
    return " ".join(k.split())


def _clean_map(titles):
    """{normalized key: first display title seen} — the key is what we compare
    on, the value is what we store so the file stays readable."""
    out = {}
    for t in titles:
        key = _key(t)
        if key:
            out.setdefault(key, clean_title(t))
    return out


def titles_at(ref):
    res = subprocess.run(
        ["git", "show", f"{ref}:{DATA_FILE.as_posix()}"],
        capture_output=True, text=True, encoding="utf-8",
    )
    if res.returncode != 0:
        return None
    try:
        return _titles_from_json_text(res.stdout)
    except Exception:
        return None


def is_scrape_commit(subject):
    s = (subject or "").lstrip()
    return any(s.startswith(p) for p in SCRAPE_COMMIT_PREFIXES)


def history_commits():
    """(sha, subject) for every commit that touched DATA_FILE, oldest first."""
    res = subprocess.run(
        ["git", "log", "--format=%H%x1f%s", "--reverse", "--", DATA_FILE.as_posix()],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    out = []
    for line in res.stdout.splitlines():
        if "\x1f" in line:
            sha, _, subject = line.partition("\x1f")
            out.append((sha, subject))
    return out


def _walk(revisions):
    """revisions: iterable of (is_scrape_commit, [titles]) oldest first.
    -> {normalized key: display title} of deleted, not-intentionally-restored games."""
    tombstoned = {}
    prev = None
    for is_scrape, titles in revisions:
        cmap = _clean_map(titles)
        if prev is not None:
            for key in prev.keys() - cmap.keys():          # disappeared
                tombstoned[key] = prev[key]
            if not is_scrape:
                for key in cmap.keys() - prev.keys():       # reappeared, on purpose
                    tombstoned.pop(key, None)
        prev = cmap
    return tombstoned


def rebuild_tombstones():
    """-> {normalized key: display title} of deleted, not-intentionally-restored games."""
    def revisions():
        for sha, subject in history_commits():
            titles = titles_at(sha)
            if titles is not None:
                yield is_scrape_commit(subject), titles
    return _walk(revisions())


def save_tombstones(tombstoned):
    ordered = sorted(tombstoned.values(), key=str.lower)
    with open(TOMBSTONE_FILE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return ordered


def load_tombstone_keys():
    if not TOMBSTONE_FILE.exists():
        return set()
    try:
        data = json.loads(TOMBSTONE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return set()
    return {_key(t) for t in data if isinstance(t, str) and t.strip()}


def purge_from_db(tombstoned):
    """Drop tombstoned games from steamrip_games_updated.json — a buggy scrape
    may have re-added some before this guard existed."""
    games = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    dead = set(tombstoned.keys())
    kept, removed = [], []
    for g in games:
        title = (g.get("title") or "") if isinstance(g, dict) else ""
        if title and _key(title) in dead:
            removed.append(title)
        else:
            kept.append(g)
    if removed:
        # Match admin.html's writer: JSON.stringify(data, null, 2), no
        # trailing newline, LF endings.
        with open(DATA_FILE, "w", encoding="utf-8", newline="\n") as f:
            json.dump(kept, f, ensure_ascii=False, indent=2)
    return removed


def _selftest():
    assert _key("EA SPORTS™ Madden NFL 27") == _key("EA SPORTS Madden NFL 27")
    assert _key("eFootball PES 2021 Free Download (v1.05)") == "efootball pes 2021"
    assert is_scrape_commit("Add steamrip.com Recently Added scrape (2026-09-10)")
    assert not is_scrape_commit("Admin Panel: Database Update via Web UI (9/9/2026)")

    admin, scrape = False, True
    # deleted by admin, re-added by a later scrape -> stays tombstoned
    t = _walk([(admin, ["Game A", "Game B"]), (admin, ["Game A"]), (scrape, ["Game A", "Game B"])])
    assert set(t) == {"game b"}, t
    # deleted by admin, then admin restores it -> not tombstoned
    t = _walk([(admin, ["Game A", "Game B"]), (admin, ["Game A"]), (admin, ["Game A", "Game B"])])
    assert t == {}, t
    # version-suffix churn is not a delete
    t = _walk([(admin, ["Game A (v1)"]), (scrape, ["Game A (v2 + Online)"])])
    assert t == {}, t
    print("track_deleted_titles selftest OK")


def main():
    if "--selftest" in sys.argv[1:]:
        _selftest()
        return
    purge = "--purge" in sys.argv[1:]

    before = load_tombstone_keys()
    tombstoned = rebuild_tombstones()
    saved = save_tombstones(tombstoned)

    added = sorted((t for k, t in tombstoned.items() if k not in before), key=str.lower)
    dropped = sorted(before - tombstoned.keys())
    print(f"deleted_titles.json: {len(saved)} title(s) "
          f"(+{len(added)} / -{len(dropped)} vs previous).")
    for t in added:
        print(f"  + {t}")
    for k in dropped:
        print(f"  - {k}")

    if purge:
        removed = purge_from_db(tombstoned)
        print(f"\nPurged {len(removed)} tombstoned title(s) from {DATA_FILE}:")
        for t in removed:
            print(f"  x {t}")


if __name__ == "__main__":
    main()
