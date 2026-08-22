# WD Games

Customer-facing site (`wdgames.store`) where customers pick which games they want and the site tallies total download size against a storage medium (HDD/SSD/flashdisk) they own. Selection is exported as a plain-text order list the customer pastes into the seller's Shopee chat — there is no in-app checkout.

The site is a Steam-like catalog + game detail experience (trailer video, screenshots, size-fit gauge). This landed as the main site by promoting the former `/feature` prototype to root (`index.html`/`game.html`) — see [REDESIGN_PLAN.md](REDESIGN_PLAN.md) for the original design rationale (data fields, UI/UX intent); treat its "Rollout order"/file-path details as historical, superseded by "Structure" below.

## Stack

Plain static HTML/CSS/vanilla JS. No framework, no bundler, no `package.json`, no build step. Deployed via GitHub Pages (see `CNAME`). Edit files directly and open `index.html` / `game.html` / `admin.html` in a browser (or a simple static server) to see changes — nothing to compile.

A few standalone Python scripts in the repo root (`fill_ps2_banners.py`, `fix_titles.py`, `minify_jsons.py`, `sort_ps2_by_romsfun_popular.py`, `update_steamrip_banners.py`, `update_pc_genres_from_steam.py`, `enrich_steam_data.py`, `split_gameplay_data.py`, `split_catalog_data.py`) are offline data-prep tools. They are not part of the served site and (with two exceptions, next paragraph) not run automatically — most are one-off/manual, run by hand against the JSON files.

`admin.html` writes straight to `steamrip_games_updated.json` / `ps2.json` (and nothing else) via the GitHub API — it has no idea `*.lite.json` / `catalog/*.json` / `gameplay/*.json` / `steamrip_games_gameplay.json` exist, even though those are what the live site actually fetches (see "Data model" below). **`enrich_steam_data.py`, `split_gameplay_data.py`, and `split_catalog_data.py` are the exceptions that *do* run automatically**: `.github/workflows/regenerate-derived-data.yml` watches `steamrip_games_updated.json` / `ps2.json` / `steamrip_games_gameplay.json` for pushes to `main` and runs all three scripts in order — `enrich_steam_data.py` first (matches any title not yet in `steam_enrich_progress.json` against Steam to fetch trailer/screenshots/description, skipping titles already processed so this stays fast), then both split scripts — committing whatever changes straight back. So a brand-new title added via "Cari dari Steam" in the admin panel ends up with full gameplay data (trailer, screenshots, "Tentang Game Ini") live within a few minutes, with no manual follow-up — "Cari dari Steam" itself only fills the catalog fields (banner/system requirements/game info), it never touches `steamrip_games_gameplay.json`. `split_catalog_data.py` also prunes `catalog/*.json` files orphaned by a title rename (the old hash's file otherwise lingers forever, since nothing ever requests it again once the title — and therefore the hash — changes).

**Titles that don't get gameplay data**: `enrich_steam_data.py` matches by fuzzy title similarity against Steam's search API (`MIN_SIMILARITY = 0.55`) and only accepts `type: "game"` results — a title Steam can't find, or that's below the similarity threshold, is recorded as unmatched in `steam_enrich_progress.json` and simply has no `gameplay/<hash>.json` (graceful fallback, not an error — see "Data model" below). This is why ~8% of PC titles have no trailer/screenshots section on `game.html`.

**One consequence worth knowing**: the workflow commits directly to whichever repo received the push (in practice `adii83/wd-games`, since that's `admin.html`'s hardcoded target). If you also push to a second remote (this repo has historically been kept in sync across `adii83/wd-games` and a personal fork), that second remote won't have the bot's commit — `git fetch`/`git merge` before your next push there, the same way you'd reconcile any other divergent commit. This is expected, not an error.

## Structure

```
index.html          customer-facing catalog/gallery page (hero, Featured This Week, Update Games, search/filter grid)
game.html            per-game detail page (trailer/screenshot carousel, About, requirements, size-fit sidebar)
admin.html           admin panel (game CRUD, writes to GitHub directly)
css/feature.css        styles + design tokens for index.html/game.html — isolated :root token set, own copy on purpose (see file header)
css/style.css         design tokens + styles for admin.html ONLY — the old catalog page that used this was retired; don't assume index.html/game.html load it (they don't)
css/admin.css         admin-panel-only styles
js/feature.js           index.html logic: data loading, hero/Featured/Update Games, search/filter, selection, size math
js/feature-detail.js    game.html logic: media carousel, About/requirements tabs, size-fit sidebar
js/feature-cart.js      shared cart/storage-picker state (localStorage) between index.html and game.html
js/feature-cart-widget.js  shared floating "Game Terpilih" widget UI + copy-to-clipboard export, used by both pages
js/filter-dropdown.js   shared custom dropdown controller (Kategori/HDD/Size headers) with full-page backdrop-blur when open
js/admin.js            admin panel logic: GitHub API auth + read/write + "Cari dari Steam" auto-fill
cloudflare-worker-steam-proxy.js  deployed separately (not served by GitHub Pages) — CORS proxy for js/admin.js's Steam lookup, see "Admin panel" below
assets/                logo, background, storage-icon images
steamrip_games_updated.json   PC games data — source of truth, admin.html reads/writes this; NOT fetched live by the gallery/detail pages (see below)
ps2.json                       PS2 games data — source of truth, admin.html reads/writes this; NOT fetched live by the gallery/detail pages (see below)
steamrip_games_updated.lite.json  derived from the file above by split_catalog_data.py — title/banner_url/Genre/Game Size only; what js/feature.js and js/feature-detail.js actually fetch for the gallery listing + cart lookups
ps2.lite.json                      same, derived from ps2.json
catalog/<hash>.json             one full entry (title/banner_url/system_requirements/game_info) per PC+PS2 title, derived by split_catalog_data.py — what js/feature-detail.js fetches for the single game a game.html visit is showing
steamrip_games_gameplay.json  source-of-truth trailer/screenshots/description data, keyed by title — NOT fetched live (23MB); split_gameplay_data.py breaks it into gameplay/*.json
gameplay/<hash>.json           one small file per Steam-matched title, fetched on demand (see "Data model")
size_config.json               { "size_buffer_percentage": N } — global size buffer, admin-editable
CNAME                            GitHub Pages custom domain
.github/workflows/regenerate-derived-data.yml   auto-enriches gameplay data + regenerates *.lite.json/catalog/gameplay after a source-data push (see "Stack" above)
```

`steamrip_games.json` is an older/raw source file, not fetched by the live site — don't edit it expecting it to affect the catalog.

## Data model ("the database")

There is no real database or backend. `steamrip_games_updated.json` and `ps2.json` are the data store, edited via `admin.html`, but the live site never fetches these two files directly — they're too heavy (`system_requirements` alone is ~32% of the payload and is only ever needed by one game at a time on `game.html`). `split_catalog_data.py` derives the two lean `*.lite.json` listings (used by the gallery) and the per-game `catalog/<hash>.json` files (used by the detail page) from them — see "Structure" above. Treat `steamrip_games_updated.json`/`ps2.json` as the schema reference; each entry:

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

- `system_requirements` and `game_info` are free-form objects rendered generically as key/value lists — adding a key there is enough to have it show up in the info view, no code change needed. Don't put URLs or anything needing special rendering in these two objects; add a new top-level field instead.
- `game_info["Game Size"]` is the field the size math reads (`parseSizeToGB()` in `js/feature.js` / `js/feature-detail.js`). Accepts strings like `"90 GB"` / `"530 MB"` or a raw number (PS2 entries use raw numbers). A global buffer multiplier from `size_config.json` (`size_buffer_percentage`) is applied on top via `estimatedSizeGB()`.
- `game_info.Genre` for PC entries was reconciled against Steam's real store genre taxonomy (`update_pc_genres_from_steam.py`, sourced from `steamrip_games_gameplay.json`) — treat it as accurate per-title data, not a loose scraped tag.
- PS2 entries additionally have a `url` field (source page) and `game_info["Popularity Rank"]`, used to sort the PS2 list.
- Trailer/screenshots/description/requirements (`trailer_hls`, `trailer_thumb`, `screenshots`, `about_the_game`, `requirements_minimum`, `requirements_recommended`, `genres`, `developers`, `publishers`, `release_date`) live per-title under `gameplay/<hash>.json`, not inline on the catalog entries. `<hash>` is FNV-1a 32-bit over the title's UTF-8 bytes — the exact same hash function is duplicated in `split_gameplay_data.py` (Python), `js/feature.js`, and `js/feature-detail.js` (JS, via `TextEncoder`); if you ever change one, change all three or lookups break silently (404 → graceful fallback, not a crash, but the enrichment data won't show). Only Steam-matched PC titles have a file — PS2 titles never do (skip the fetch for `_category === 'ps2'` rather than requesting a guaranteed 404) and ~8% of PC titles don't either; UI must degrade gracefully when it's missing (already handled). `js/feature.js` only fetches the handful of titles shown in the hero/Featured This Week sections (~11 games) on `index.html`; `js/feature-detail.js` fetches just the one game `game.html` is showing. Grid/Update-Games card tags read `game_info.Genre` from the catalog instead, so the bulk of the page needs no gameplay fetch at all.
- Unlike the retired old site, `index.html`/`game.html` load PC and PS2 data together upfront (`loadGames()` in `js/feature.js`, `Promise.all` in `js/feature-detail.js`) — don't assume either is lazy/on-demand. What differs from before: both now fetch the *lite* listings, not the full catalogs. `js/feature-detail.js` additionally fetches the lite listings too (not just its own game's `catalog/<hash>.json`) — the floating cart widget needs to look up title/size for *every* selected game, not just the one the current page is showing, so `allGames` on `game.html` is still the full lite listing, same as on `index.html`.
- `catalog/<hash>.json` hashes `"<category>:<title>"` (category is `pc` or `ps2`, lowercase), not title alone — unlike `gameplay/<hash>.json`, which only ever covers PC titles and hashes title alone. This matters because ~8 titles exist identically on both catalogs (e.g. "Half-Life"); hashing category+title keeps them in separate files. If you add another per-title split file in the future for data that spans both catalogs, hash category+title the same way, not title alone.

## Admin panel

`admin.html` + `js/admin.js` is a client-side-only tool with no server: it authenticates directly against the GitHub REST API using a Personal Access Token and reads/writes `steamrip_games_updated.json` / `ps2.json` / `size_config.json` as base64 file contents via the Contents API, committing straight to `main`. Edits are staged in an in-memory array and only become permanent when "Simpan ke GitHub" runs `commitToGitHub()` (commit message pattern: `Admin Panel: Database Update via Web UI (<date>)` — this is why that message shows up repeatedly in git history).

**Known issue, deliberately accepted, not a bug to silently "fix"**: `js/admin.js` has a default owner/repo and an embedded/obfuscated GitHub PAT used for auto-login. This used to auto-login any visitor to `admin.html` with zero prompt — that specific behavior was fixed by adding a password gate (`#password-gate-container` in `admin.html`, checked client-side in `js/admin.js` against a hardcoded string, required fresh on every page load, not persisted) that has to pass before the GitHub auto-login can run. The owner explicitly chose to keep the same (already-once-exposed) PAT rather than rotate it, after being told the tradeoffs: the password check is purely client-side on a static site with no backend, so it only deters casual visitors — anyone opening DevTools/viewing source can still read the token straight out of `js/admin.js` regardless of the password. If you touch this file: don't silently remove the gate or the hardcoded token thinking it's an oversight — it's a known, explicit decision. Do flag it again if you're asked to add more sensitive functionality on top of this same auth path, since the risk compounds with what the token can do.

**Also easy to miss**: `admin.html` only ever touches `steamrip_games_updated.json` / `ps2.json` / `size_config.json` — it has no idea `*.lite.json` / `catalog/*.json` / `gameplay/*.json` / `steamrip_games_gameplay.json` exist. A GitHub Actions workflow now regenerates/enriches those automatically after every admin-panel save (see the Stack section above), so this is no longer a manual step — but it does mean there's a lag (roughly a minute for the `*.lite.json`/`catalog/*.json` regeneration, longer — depends on how many new titles need a Steam lookup — for `enrich_steam_data.py` to fill in gameplay data) between "Simpan ke GitHub" and the change actually showing live, and a failed/slow Action run would surface as that lag stretching out.

**"Cari dari Steam" auto-fill**: the game form's title field has a search button that queries Steam (via `storesearch`/`appdetails`) and auto-fills Banner URL / System Requirements / Game Info — everything except `Game Info["Game Size"]`, which is deliberately left blank for manual entry (Steam's API doesn't know the size of a repacked/pre-installed build, which is what this catalog actually distributes). This only fills the catalog entry itself — it does **not** touch `steamrip_games_gameplay.json` (trailer/screenshots/"Tentang Game Ini" on `game.html`); that's a separate lookup (`enrich_steam_data.py`) the GitHub Actions workflow runs automatically after the save lands on `main`, so a newly-added title's gameplay section fills in a little after the rest of the entry does, not instantly. This **requires a small external CORS proxy** — Steam's API sends no `Access-Control-Allow-Origin` header, so a direct browser `fetch()` to `store.steampowered.com` is blocked outright (confirmed: fails before the request even reaches Steam; public CORS-proxy services were tried and are unreliable/paywalled, not a viable fallback). `cloudflare-worker-steam-proxy.js` (repo root) is a stateless pass-through Worker that adds the missing headers — deploy it once (free Cloudflare tier, instructions in the file's header comment) and paste the resulting `*.workers.dev` URL into `STEAM_PROXY_BASE_URL` near the top of the "Cari dari Steam" section in `js/admin.js` (already deployed and wired in; if it ever needs redeploying, `STEAM_PROXY_BASE_URL` is the only thing to update). If that constant is ever reset to the `REPLACE-WITH-YOUR-WORKER` placeholder, the button shows a clear error toast instead of silently failing.

## Conventions

- Design tokens for `index.html`/`game.html` live at the top of `css/feature.css` as CSS variables (`--bg-dark`, `--accent`, `--accent-gradient`, `--radius-md`, etc.) — reuse them, don't hardcode new colors/spacing. `css/feature.css` deliberately keeps its own copy of these tokens instead of importing `css/style.css`, so the two pages' styling never breaks each other — don't try to "de-duplicate" them into one shared file. `css/style.css` has its own separate (currently near-identical) token set used only by `admin.html`.
- Dark theme only, cyan/violet accent gradient, "Outfit" body font (Google Fonts), "Russo One" for the logo wordmark. This is a deliberate single-theme design (matches the existing site and the gaming-storefront genre) — no light mode to maintain.
- Mobile responsiveness is handled via CSS media queries in `css/feature.css`. Check both CSS and `js/feature.js`/`js/feature-detail.js` when changing header/grid layout, since some header/dropdown behavior is JS-driven.
- `prefers-reduced-motion` is respected for stagger/hover/spinner animations — keep that when adding new animated UI.
- The export/copy flow (`buildExportText()` in `js/feature-cart-widget.js`, shared by both pages via the floating "Game Terpilih" widget) is the only "checkout" — it builds a plain-text order list and copies it to the clipboard for the customer to paste into Shopee chat. There is intentionally no in-app purchase flow; don't add one without being asked.
- `js/admin.js` is cache-busted manually via a `?v=` query string on its `<script>` tag in `admin.html` — bump that version when shipping admin.js changes, since there's no build step to hash filenames.
- Custom dropdowns (Kategori/HDD/Size in the header) are plain button+panel components (`js/filter-dropdown.js`), not native `<select>` — this is intentional so their open state can drive a full-page backdrop-blur (native `<select>` option lists can't be styled/blurred-behind via CSS). Follow the same pattern for any new header dropdown. Instances now also support `.setDisabled(bool)` (used to lock the Kategori dropdown while Flashdisk is active).
- `index.html` shows a mandatory `#landing-screen` storage-type picker every visit (right after the loading screen) — `body.landing-active` blocks the rest of the page until HDD/Flashdisk/SSD is chosen. Picking Flashdisk locks the whole session to PS2 only: `window.FeatureCart.canAdd(category)` is the single source of truth for whether a title can be added (checked before every `toggle()` call across `js/feature.js` and `js/feature-detail.js`), and switching to Flashdisk purges any already-selected PC titles from the cart. If you add a new place where a game can be selected, gate it through `canAdd()` too or this restriction gets a hole in it.

## Current focus

The Steam-style redesign (video trailer + screenshots + richer game detail view, filter dropdowns) has landed as the live main site (`index.html`/`game.html`). [REDESIGN_PLAN.md](REDESIGN_PLAN.md) still documents the original design intent but its file paths/rollout order are historical — see "Structure" above for what actually exists now.
