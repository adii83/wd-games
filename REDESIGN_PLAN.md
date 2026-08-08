# WD Games — redesign plan (Steam-style catalog + detail view)

Status: planning. Written after auditing the current codebase (see "Current state" below). Companion visual mockup was published as a Claude artifact during planning — ask for the link again if lost, or just build from this doc + [CLAUDE.md](CLAUDE.md).

## Goal

Keep the core value prop (pick games → see total GB vs. your drive capacity → copy an order list for Shopee chat) but replace the plain poster-grid + text-only info modal with a Steam-like experience:

- Catalog cards that hint at video (hover play badge) instead of static posters only.
- A rich per-game detail view: trailer/gameplay video hero, screenshot filmstrip, tabbed About / Screenshots / System requirements, and a size-fit gauge against the user's selected storage plan.
- Sidebar filters (platform, genre, size range) instead of a single dropdown.

No backend exists and none should be introduced — this stays a static site (GitHub Pages) with the two JSON files as the "database" and the existing GitHub-API-based admin panel as the only write path.

## Current state (as of this plan)

- Static HTML/CSS/vanilla JS, no framework, no build step, no `package.json`. Deployed to `wdgames.store` via GitHub Pages (`CNAME`).
- Data: `steamrip_games_updated.json` (PC) and `ps2.json` (PS2), fetched client-side by [js/app.js](js/app.js). Schema per entry: `title`, `banner_url` (single poster image — the only media field that exists today), `system_requirements` (free-form object), `game_info` (free-form object; `Game Size` is the field the size math reads, via `parseSizeToGB()` in `js/app.js`). A global size buffer multiplier lives in `size_config.json`.
- Catalog UI: `index.html` + `js/app.js`. Landing screen forces a storage-medium pick, sticky header shows a live GB progress bar, grid of `.game-card` posters (click to select), floating selected-list widget, "Ekspor List" → `#export-modal` → "Copy Teks" builds a plain-text order list and copies it to clipboard (no in-app checkout — hands off to Shopee chat manually).
- Detail view today: clicking the "i" button opens a bottom-sheet `#info-modal` that just lists `system_requirements` and `game_info` as key/value `<li>` items. No images beyond the card poster, no video.
- Admin panel: `admin.html` + `js/admin.js`, client-side only, no server. Authenticates directly against the GitHub REST API with a PAT (currently stored in `localStorage`, with a **default token embedded/obfuscated in `js/admin.js` — flagged as a real secret-exposure risk, should be removed/rotated independent of this redesign**). Edits are staged in memory, "Simpan ke GitHub" commits `steamrip_games_updated.json` / `ps2.json` / `size_config.json` straight to `main` via the Contents API.
- Design tokens already exist in `css/style.css:1-29` (dark theme, cyan/violet accent gradient, "Outfit" body font, "Russo One" logo font) — the redesign should extend these tokens, not replace them.

## New data fields required

Both `steamrip_games_updated.json` and `ps2.json` need new optional fields per entry. Keep them **top-level**, not nested in `game_info`, since `game_info` is rendered generically as a flat list today and mixing in URLs would leak into that list.

```json
{
  "title": "Crimson Desert",
  "banner_url": "...",
  "trailer_url": "https://www.youtube.com/watch?v=XXXXXXXXXXX",
  "screenshots": ["https://.../shot1.jpg", "https://.../shot2.jpg"],
  "description": "Short paragraph, 2-4 sentences.",
  "system_requirements": { "...": "..." },
  "game_info": { "...": "..." }
}
```

- `trailer_url`: plain YouTube/Vimeo URL (simplest — no video hosting needed on a static/GitHub-Pages site). Store the raw watch URL; derive the embed URL in JS (`getYouTubeEmbedUrl()` helper — convert `watch?v=` / `youtu.be/` to `embed/`).
- `screenshots`: array of image URLs (same hotlinking approach already used for `banner_url` — Steam CDN / romsfun.com already serve these, or reuse Steam's `appdetails` API screenshot list where available).
- `description`: optional; fall back to a generated sentence from `game_info` (`Genre`, `Developer`) if absent, so old entries without it don't show an empty About tab.
- All three fields are optional — the UI must degrade gracefully (no trailer → show banner as static hero with no play button; no screenshots → hide filmstrip/tab; no description → fallback text).

### Backfill idea (optional, do later)

Most catalog titles are real Steam releases. `steamrip_games_updated.json` entries could be matched to a Steam `appid` and the public `https://store.steampowered.com/api/appdetails?appids=<id>` endpoint pulled (offline, via a Python script like the existing `fix_titles.py`/`fill_ps2_banners.py`) to auto-fill `trailer_url`, `screenshots`, and `description` for the PC catalog in bulk. PS2 titles have no such API and would stay manual/optional via the admin panel.

## UI/UX changes

### 1. Catalog grid (`index.html`, `js/app.js`, `css/style.css`)

- Add a small circular play-badge overlay (top-left, matches mockup) on any card whose entry has `trailer_url`. Purely a visual affordance — clicking the card still opens selection; clicking the badge opens the detail view instead.
- Replace the single category `<select>` with a filter rail: platform chips (All/PC/PS2 — already exists as data), genre chips (derive the distinct set from `game_info.Genre`, comma-split), and a size-range control. This is additive filtering on top of the existing search/category logic in `ensureGamesLoaded`/`renderGrid` — not a rewrite of the data loading.
- Keep the landing-screen storage picker, sticky capacity header, and floating selected-list widget as-is — they're the site's core mechanic and already work well.

### 2. Game detail view (replaces `#info-modal`)

Promote the existing bottom-sheet info modal into a full Steam-like panel:

- **Header**: video hero. If `trailer_url` exists, embed it (click-to-play, not autoplay — respect data usage on a downloads-focused audience) with `banner_url` as the poster/thumbnail until played. If no trailer, just show `banner_url` full-bleed as today.
- **Filmstrip**: thumbnail row of `screenshots` (if present) below the hero; clicking a thumbnail swaps the hero to that image.
- **Tabs**: About (description + `game_info` facts), Screenshots (grid), System requirements (existing `system_requirements` list, styled as a table instead of a flat `<li>` list).
- **Side panel**: size card — install size in GB, buffer-adjusted size (reuse `parseSizeToGB()` + `size_config.json` buffer, already computed elsewhere in `js/app.js`), and a small gauge comparing it against the user's currently selected capacity (reuse the same numbers already driving the sticky header progress bar). "Add to my list" button mirrors the existing card-click select/deselect logic — same state, just a second entry point.
- Keep this as a modal/sheet (not a route) — no router needed for a static site; reuse the existing modal-overlay pattern already in `css/style.css` (`.bottom-sheet`) but widen it substantially on desktop.

### 3. Admin panel (`admin.html`, `js/admin.js`)

- Add form fields: `Trailer URL` (single text input, next to the existing `#form-banner` field around `admin.html:260-325`), `Screenshots` (textarea, one URL per line, split/join to array on save), `Description` (textarea).
- Add a live preview: small embedded thumbnail/play icon for the trailer URL, same pattern as the existing `#form-banner-preview`.
- No schema migration needed server-side (there is no server) — just make sure `commitToGitHub()` continues to serialize the new optional keys without breaking existing entries that don't have them.
- **Separately from this redesign**: rotate/remove the embedded GitHub PAT in `js/admin.js` and stop defaulting to a hardcoded owner/repo/token — this is a live secret-exposure issue independent of the UI work.

## Rollout order

1. **Schema + sample data** — add `trailer_url`/`screenshots`/`description` to a handful of popular PC entries by hand (or via a small Python backfill script) so the new UI has real data to render against during development.
2. **Detail view** — build the new Steam-style detail panel against that sample data, with graceful fallbacks for entries still missing the new fields (i.e. every PS2 entry, most PC entries, on day one).
3. **Catalog grid tweaks** — play-badge overlay, filter rail.
4. **Admin panel fields** — so new/edited entries can carry the new data going forward.
5. **(Optional) bulk backfill script** — Steam `appdetails` scrape for PC titles.
6. **Cross-device pass** — re-check the mobile breakpoints listed in [CLAUDE.md](CLAUDE.md) once the detail view and filter rail exist, since both are new DOM/CSS that the existing 10 media queries don't account for yet.

## Explicitly out of scope

- No backend/server, no database migration — stays static JSON + GitHub API.
- No in-app checkout — the copy-to-clipboard → Shopee chat handoff stays exactly as-is.
- No self-hosted video — trailers are always external embeds (YouTube/Vimeo), never uploaded files, to avoid repo bloat and hosting cost on a free static host.
