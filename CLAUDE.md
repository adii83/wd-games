# WD Games

Customer-facing site (`wdgames.store`) where customers pick which games they want and the site tallies total download size against a storage medium (HDD/SSD/flashdisk) they own. Selection is exported as a plain-text order list the customer pastes into the seller's Shopee chat — there is no in-app checkout.

A redesign is in progress toward a Steam-like catalog + game detail experience (trailer video, screenshots, size-fit gauge). See [REDESIGN_PLAN.md](REDESIGN_PLAN.md) for the full plan — read it before making UI changes so new work lands in the right place instead of extending the old bottom-sheet info modal.

## Stack

Plain static HTML/CSS/vanilla JS. No framework, no bundler, no `package.json`, no build step. Deployed via GitHub Pages (see `CNAME`). Edit files directly and open `index.html` / `admin.html` in a browser (or a simple static server) to see changes — nothing to compile.

A few standalone Python scripts in the repo root (`fill_ps2_banners.py`, `fix_titles.py`, `minify_jsons.py`, `sort_ps2_by_romsfun_popular.py`, `update_steamrip_banners.py`) are offline one-off data-prep tools run manually against the JSON files. They are not part of the served site and not run automatically.

## Structure

```
index.html          customer-facing catalog page
admin.html           admin panel (game CRUD, writes to GitHub directly)
css/style.css         main site styles + design tokens (:root, css/style.css:1-29)
css/admin.css         admin-panel-only styles
js/app.js              catalog logic: data loading, search/filter, selection, size math, export
js/admin.js            admin panel logic: GitHub API auth + read/write
assets/                logo, background, storage-icon images
steamrip_games_updated.json   PC games data (live — fetched by js/app.js)
ps2.json                       PS2 games data (live — fetched by js/app.js)
size_config.json               { "size_buffer_percentage": N } — global size buffer, admin-editable
CNAME                            GitHub Pages custom domain
```

`steamrip_games.json` is an older/raw source file, not fetched by the live site — don't edit it expecting it to affect the catalog.

## Data model ("the database")

There is no real database or backend. `steamrip_games_updated.json` and `ps2.json` are fetched directly by the browser at runtime and act as the data store. Each entry:

```json
{
  "title": "Crimson Desert",
  "banner_url": "https://.../library_capsule.jpg",
  "system_requirements": { "OS": "Windows 10 64-bit", "...": "..." },
  "game_info": {
    "Genre": "Action, RPG",
    "Developer": "Game Science",
    "Platform": "PC",
    "Game Size": "90  GB",
    "Released By": "Steam / Epic Games",
    "Version": "v1.0.8.14860 | Full Version",
    "Pre-Installed Game": true
  }
}
```

- `system_requirements` and `game_info` are free-form objects rendered generically as key/value lists — adding a key there is enough to have it show up in the info view, no code change needed. Don't put URLs or anything needing special rendering in these two objects; add a new top-level field instead (see `REDESIGN_PLAN.md` for the new `trailer_url`/`screenshots`/`description` fields).
- `game_info["Game Size"]` is the field the size math reads (`parseSizeToGB()` in `js/app.js`). Accepts strings like `"90 GB"` / `"530 MB"` or a raw number (PS2 entries use raw numbers). A global buffer multiplier from `size_config.json` (`size_buffer_percentage`) is applied on top.
- PS2 entries additionally have a `url` field (source page) and `game_info["Popularity Rank"]`, used to sort the PS2 list.
- PC and PS2 data are lazy-loaded independently depending on the active category filter (`ensureGamesLoaded` in `js/app.js`) — don't assume both are loaded at once.

## Admin panel

`admin.html` + `js/admin.js` is a client-side-only tool with no server: it authenticates directly against the GitHub REST API using a Personal Access Token and reads/writes `steamrip_games_updated.json` / `ps2.json` / `size_config.json` as base64 file contents via the Contents API, committing straight to `main`. Edits are staged in an in-memory array and only become permanent when "Simpan ke GitHub" runs `commitToGitHub()` (commit message pattern: `Admin Panel: Database Update via Web UI (<date>)` — this is why that message shows up repeatedly in git history).

**Known issue, independent of any feature work**: `js/admin.js` currently has a default owner/repo and an embedded/obfuscated GitHub PAT used for auto-login. Treat this as a live secret-exposure risk — flag it rather than building further features on top of it silently, and prefer prompting for a token over hardcoding one if you touch this file.

## Conventions

- Design tokens live in `css/style.css:1-29` as CSS variables (`--bg-dark`, `--accent`, `--accent-gradient`, `--radius-md`, etc.) — reuse them, don't hardcode new colors/spacing.
- Dark theme only, cyan/violet accent gradient, "Outfit" body font (Google Fonts), "Russo One" for the logo wordmark. This is a deliberate single-theme design (matches the existing site and the gaming-storefront genre) — no light mode to maintain.
- Mobile responsiveness is handled via CSS media queries (10 breakpoints between 480–1200px in `css/style.css`) plus a few JS-driven adjustments in `js/app.js` (`syncHeaderHeight()`, `getItemsPerPage()`). Check both when changing header/grid layout, not just CSS.
- `prefers-reduced-motion` is respected for stagger/hover animations — keep that when adding new animated UI.
- The export/copy flow (`buildExportText()` in `js/app.js`) is the only "checkout" — it builds a plain-text order list and copies it to the clipboard for the customer to paste into Shopee chat. There is intentionally no in-app purchase flow; don't add one without being asked.
- `js/admin.js` is cache-busted manually via a `?v=` query string on its `<script>` tag in `admin.html` — bump that version when shipping admin.js changes, since there's no build step to hash filenames.

## Current focus

Steam-style redesign (video trailer + screenshots + richer game detail view, sidebar filters). Full plan, new data fields, and rollout order are in [REDESIGN_PLAN.md](REDESIGN_PLAN.md).
