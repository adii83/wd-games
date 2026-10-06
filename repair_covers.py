"""Repair wrong or missing covers across the PC catalog.

Targets every entry whose banner_url is empty, or is shared with a
differently-titled game (which means at least one of them is wearing another
game's cover). Each target goes back through the scraper's own
resolve_cover(), so the rules are identical to what new scrapes get.

Two steps, so what gets written is exactly what was reviewed:

    python repair_covers.py            # look everything up, write cover_repair_report.json
    python repair_covers.py --apply    # write that report's "changed" rows to steamrip_games_updated.json

An entry only ever changes when a replacement was found: if every source
fails (network trouble, game unknown everywhere) the old cover stays and the
entry is listed as "unresolved" in the report. Delete a row from the report
before --apply to skip it.
"""
import json
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

from scrape_steamrip_recent import (
    REQUEST_DELAY,
    build_banner_owner_map,
    clean_title,
    cover_title_key,
    resolve_cover,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATA_FILE = Path("steamrip_games_updated.json")
REPORT_FILE = Path("cover_repair_report.json")


def find_targets(games):
    owners = build_banner_owner_map(games)
    shared = {
        url for url, titles in owners.items()
        if len({cover_title_key(clean_title(t)) for t in titles}) > 1
    }
    return [g for g in games if g.get("title") and (not g.get("banner_url") or g["banner_url"] in shared)]


def build_report(games):
    targets = find_targets(games)
    target_ids = {id(g) for g in targets}
    # Covers held by targets are up for grabs again: whichever member of a
    # shared group really owns the art re-claims it below, the rest get
    # rejected by resolve_cover()'s own "already used" check.
    owners = build_banner_owner_map([g for g in games if id(g) not in target_ids])

    report = []
    for i, game in enumerate(targets, 1):
        title, old = game["title"], game.get("banner_url") or ""
        found = resolve_cover(title, owners, game.get("url") or "")
        new = found["url"] if found else old
        if new:
            owners.setdefault(new, set()).add(title)
        status = "unresolved" if not found else ("kept" if new == old else "changed")
        report.append({
            "title": title,
            "status": status,
            "old": old,
            "new": new,
            "source": found["source"] if found else "",
            "matched_name": found["match_title"] if found else "",
        })
        print(f"[{i}/{len(targets)}] {status}: {title!r}" + (f" <- {found['source']}" if found else ""))
        time.sleep(REQUEST_DELAY)
    return report


def apply_report(games, report):
    changes = {(r["title"], r["old"]): r for r in report if r["status"] == "changed"}
    applied = 0
    for game in games:
        row = changes.get((game.get("title"), game.get("banner_url") or ""))
        if not row:
            continue
        game["banner_url"] = row["new"]
        game["banner_status"] = "verified"
        game["banner_source"] = row["source"]
        game["banner_match_title"] = row["matched_name"]
        applied += 1

    backup = DATA_FILE.with_name(f"{DATA_FILE.name}.backup-covers-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(DATA_FILE, backup)
    temporary = DATA_FILE.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(games, handle, ensure_ascii=False, indent=2)
    temporary.replace(DATA_FILE)
    print(json.dumps({"applied": applied, "backup": str(backup)}, ensure_ascii=False))


def main():
    with DATA_FILE.open(encoding="utf-8") as handle:
        games = json.load(handle)

    if "--apply" in sys.argv:
        apply_report(games, json.loads(REPORT_FILE.read_text(encoding="utf-8")))
        return

    report = build_report(games)
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {s: sum(1 for r in report if r["status"] == s) for s in ("changed", "kept", "unresolved")}
    summary["report"] = str(REPORT_FILE)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
