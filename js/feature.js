(function () {
    'use strict';

    // Standalone script for index.html. Uses js/feature-cart.js (loaded
    // before this file) for the storage-picker + selection state.
    //
    // Cards can be selected directly via their checkmark button (added to
    // the cart without opening the detail page); clicking anywhere else on
    // a card navigates to game.html as usual.

    const ITEMS_PER_PAGE = 24;
    const SKELETON_COUNT = 12;
    const HERO_SLIDE_COUNT = 8;
    const HERO_ROTATE_MS = 3000;
    // How far into the "newest first" list (admin unshift() order) the hero
    // + Featured This Week are allowed to draw from — keeps them feeling
    // "recent" while still leaving room to shuffle a different mix in on
    // every page load.
    const NEWEST_POOL_SIZE = 30;

    const STORAGE_TYPE_LABELS = { hdd: 'HDD', ssd: 'SSD', flashdisk: 'Flashdisk' };
    // Sentinel Kategori value for the PS2 platform filter — kept out of the
    // frequency-ranked genre list so it always shows as its own fixed entry.
    const PS2_CATEGORY_VALUE = '__ps2__';
    // Same idea for PS3 — a separate catalog/category, but (unlike PS2) not
    // tied to the Flashdisk storage-type lock: PS3 titles are large enough
    // that Flashdisk isn't realistic for them, so they're selectable under
    // HDD/SSD like PC titles. canAdd() in feature-cart.js already blocks any
    // non-'ps2' category from Flashdisk, so no change needed there.
    const PS3_CATEGORY_VALUE = '__ps3__';
    // Same idea for the "needs internet/Online" filter (see requiresOnline())
    // — not a real Genre value, just a fixed shortcut in the dropdown.
    const ONLINE_CATEGORY_VALUE = '__online__';
    // Same idea for the "Low Spek" filter (see isLowSpec()) — PC-only, PS2/PS3
    // carry no system_requirements at all so they never match it.
    const LOW_SPEC_CATEGORY_VALUE = '__lowspec__';

    const SELECT_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    const SUGGEST_LIMIT = 3;

    const appLoadingScreen = document.getElementById('app-loading-screen');
    const landingScreen = document.getElementById('landing-screen');
    const landingActions = document.getElementById('landing-storage-actions');
    const grid = document.getElementById('gallery-grid');
    const loadMoreBtn = document.getElementById('gallery-load-more');
    const searchInput = document.getElementById('gallery-search');
    const searchSuggestPanel = document.getElementById('search-suggest-panel');
    const searchFab = document.getElementById('search-fab');
    const searchFabBtn = document.getElementById('search-fab-btn');
    const catalogTitle = document.getElementById('catalog-title');
    const catalogSection = document.getElementById('catalog-section');
    const catalogSortSelect = document.getElementById('catalog-sort-select');
    const genreDropdownPanel = document.getElementById('genre-dropdown-panel');

    const discoverTop = document.getElementById('discover-top');
    const heroSlidesEl = document.getElementById('hero-slides');
    const heroThumbsEl = document.getElementById('hero-thumbs');
    const heroPrevBtn = document.getElementById('hero-prev');
    const heroNextBtn = document.getElementById('hero-next');

    const featuredWeekSection = document.getElementById('featured-week-section');
    const featuredWeekGrid = document.getElementById('featured-week-grid');

    const updateGamesSection = document.getElementById('update-games-section');
    const updateScrollRow = document.getElementById('update-scroll-row');
    const updateGamesSeeAll = document.getElementById('update-games-see-all');

    const trailerModalBackdrop = document.getElementById('trailer-modal-backdrop');
    const trailerModalVideo = document.getElementById('trailer-modal-video');
    const trailerModalClose = document.getElementById('trailer-modal-close');

    const tutorialBtn = document.getElementById('tutorial-btn');
    const tutorialModalBackdrop = document.getElementById('tutorial-modal-backdrop');
    const tutorialModalClose = document.getElementById('tutorial-modal-close');

    const storageTypeDropdownPanel = document.querySelector('#storage-type-dropdown [data-dropdown-panel]');
    const storageCapacityDropdownPanel = document.getElementById('storage-capacity-dropdown-panel');
    const storageProgressFill = document.getElementById('storage-progress-fill');
    const storageFooterUsed = document.getElementById('storage-footer-used');
    const storageFooterTotal = document.getElementById('storage-footer-total');
    const storageFooterRemaining = document.getElementById('storage-footer-remaining');

    const genreDropdown = window.FilterDropdown.create(document.getElementById('genre-dropdown'));
    const storageTypeDropdown = window.FilterDropdown.create(document.getElementById('storage-type-dropdown'));
    const storageCapacityDropdown = window.FilterDropdown.create(document.getElementById('storage-capacity-dropdown'));

    // Wires click-to-select on a dropdown's option buttons: marks the
    // clicked one active, updates the trigger label, closes the panel, then
    // hands the picked value to the caller.
    function wireDropdownItems(panelEl, dropdownInstance, onSelect) {
        panelEl.querySelectorAll('.filter-dropdown-item').forEach((item) => {
            item.addEventListener('click', () => {
                panelEl.querySelectorAll('.filter-dropdown-item').forEach((i) => i.classList.toggle('active', i === item));
                dropdownInstance.setLabel(item.textContent);
                dropdownInstance.close();
                onSelect(item.getAttribute('data-value'), item);
            });
        });
    }

    let allGames = [];
    let filteredGames = [];
    let currentPage = 1;
    let heroTimer = null;
    let heroIndex = 0;
    let sortMode = 'newest';
    let activeGenre = null;
    let trailerHlsInstance = null;
    // Tracks which landing sections actually have content to show, so
    // filtering (search/category) can hide them and clearing the filter
    // can bring back only the ones that were genuinely populated.
    const landingHasContent = { hero: false, featured: false, update: false };
    // Titles shown in the "Update Games" strip — also shown in "Explore Your
    // Collection" (not excluded), badged "Baru" there too so it's clear
    // which ones are the same recently-added games.
    let updateGamesTitles = new Set();

    function parseSizeToGB(sizeVal) {
        if (typeof sizeVal === 'number' && Number.isFinite(sizeVal)) return sizeVal;
        if (typeof sizeVal !== 'string') return 0;
        const match = sizeVal.trim().match(/([\d.]+)\s*(GB|MB)/i);
        if (!match) return 0;
        const num = parseFloat(match[1]);
        return match[2].toUpperCase() === 'MB' ? num / 1024 : num;
    }

    function formatSizeGB(gb) {
        if (!Number.isFinite(gb) || gb <= 0) return 'N/A';
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
    }

    function gameHref(game) {
        const base = `game.html?t=${encodeURIComponent(game.title)}`;
        // A handful of titles exist identically across catalogs (e.g.
        // "Half-Life", "Grand Theft Auto: Vice City" on PC vs PS2, or
        // "God of War Collection" on PS2 vs PS3) — tag the category in the
        // URL for anything non-PC so game.html opens the right one instead
        // of just the first match.
        return game._category !== 'pc' ? `${base}&c=${game._category}` : base;
    }

    // Buffered size: raw size times the admin-configured size_config.json
    // buffer, used everywhere a size is displayed or summed.
    function estimatedSizeGB(rawSize) {
        return parseSizeToGB(rawSize) * window.FeatureCart.getSizeBufferMultiplier();
    }

    // --- Per-game gameplay data (trailer/screenshots/about/rating) ---
    // steamrip_games_gameplay.json used to be fetched whole (23MB) on every
    // page load just so the hero/Featured This Week sections (a handful of
    // games) could read a bit of extra data. split_gameplay_data.py splits
    // it into one small file per title under gameplay/<hash>.json, hashed
    // with FNV-1a 32-bit over the title's UTF-8 bytes (matching the Python
    // script exactly, so no separate title->filename index needs fetching).
    // Fetched lazily, only for the specific games that need it.
    function fnv1aHash(str) {
        const bytes = new TextEncoder().encode(str);
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }

    const gameplayCache = new Map();

    async function fetchGameplayEntry(title) {
        if (gameplayCache.has(title)) return gameplayCache.get(title);
        const promise = fetch(`gameplay/${fnv1aHash(title)}.json`)
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null);
        gameplayCache.set(title, promise);
        const data = await promise;
        gameplayCache.set(title, data);
        return data;
    }

    async function fetchGameplayForGames(games) {
        const map = {};
        await Promise.all(games.map(async (g) => {
            map[g.title] = await fetchGameplayEntry(g.title);
        }));
        return map;
    }

    // Strips trailing version/build noise like "(Build 1491.50)",
    // "(v0.4.3f3 + Online)", "(v1.0.29315)" from a title for display only —
    // the raw title (used for hrefs, data-title, cart lookups) is untouched
    // so it still matches exactly what's in the catalog JSON.
    function cleanDisplayTitle(title) {
        if (!title) return title;
        let t = title;
        for (let i = 0; i < 4; i++) {
            const next = t.replace(/\s*\([^)]*\)\s*$/, '');
            if (next === t) break;
            t = next;
        }
        t = t.replace(/\s*[+]\s*(co-?op|multiplayer|online|dlcs?)\s*$/i, '');
        return t.trim();
    }

    // Steamrip titles tag an added networked feature as a trailing
    // "(... + Online/Multiplayer/Co-op/LAN)" group (the same group
    // cleanDisplayTitle strips for display) — reusing that same shape here
    // to flag which games need an internet connection to use that feature,
    // without false-positiving on titles that just contain the word (e.g.
    // "CarX Drift Racing Online").
    function requiresOnline(title) {
        if (!title) return false;
        const m = title.match(/\(([^()]*)\)\s*$/);
        return Boolean(m && /[+]/.test(m[1]) && /\b(online|multiplayer|co-?op|lan|crossplay)\b/i.test(m[1]));
    }

    // "Low Spek" filter: RAM minimum <=4GB AND Graphics requirement doesn't
    // name a heavy-tier GPU. Computed Python-side (split_catalog_data.py) from
    // the full system_requirements and baked into the lite listing as a plain
    // boolean, because the lite JSON this page fetches deliberately excludes
    // system_requirements entirely (~32% of the full catalog's payload) — see
    // CLAUDE.md's "Data model" section. PS2/PS3 entries have no
    // system_requirements at all so this is always false for them.
    function isLowSpec(game) {
        return Boolean(game.is_low_spec);
    }

    // Fisher-Yates — used so the hero/Featured pick differs on every page
    // load instead of always showing the same games in the same order.
    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // Picks a random screenshot for backgrounds instead of always the same
    // index, so a given game's hero/card art also varies across refreshes.
    function randomBackgroundFor(game, gp) {
        const shots = gp && Array.isArray(gp.screenshots) ? gp.screenshots : [];
        if (shots.length) return shots[Math.floor(Math.random() * shots.length)];
        return game.banner_url || 'assets/logo.png';
    }

    // Genres used for the Kategori filter (dropdown options + matching) and
    // card tags. game_info.Genre already holds Steam's real genre list for
    // every PC title with a Steam match (update_pc_genres_from_steam.py
    // rewrote steamrip_games_updated.json directly), so this can just read
    // it — no need to fetch the separate per-game gameplay data for it.
    function gameGenres(game) {
        return game.game_info && game.game_info.Genre
            ? game.game_info.Genre.split(',').map((s) => s.trim()).filter(Boolean)
            : [];
    }

    // Sets the Kategori filter (used both by the dropdown's own item clicks
    // and by the Flashdisk -> PS2 category lock below) and keeps the
    // dropdown's label/active state in sync either way.
    function setActiveGenre(value) {
        activeGenre = value || null;
        genreDropdown.setLabel(
            activeGenre === PS2_CATEGORY_VALUE ? 'Game PS2'
                : activeGenre === PS3_CATEGORY_VALUE ? 'Game PS3'
                    : activeGenre === ONLINE_CATEGORY_VALUE ? 'Online'
                        : activeGenre === LOW_SPEC_CATEGORY_VALUE ? 'Low Spek'
                            : (activeGenre || 'Kategori')
        );
        genreDropdownPanel.querySelectorAll('.filter-dropdown-item').forEach((item) => {
            item.classList.toggle('active', (item.getAttribute('data-value') || null) === activeGenre);
        });
        applyFilters();
    }

    // Populates the compact "Kategori" dropdown: "Semua Kategori", a fixed
    // "Game PS2" platform shortcut, then the most common genres across the
    // whole catalog (PC + PS2 both carry a Genre field), most-frequent first.
    function renderGenreFilterOptions() {
        const counts = new Map();
        allGames.forEach((game) => {
            gameGenres(game).forEach((genre) => {
                counts.set(genre, (counts.get(genre) || 0) + 1);
            });
        });

        const topGenres = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([genre]) => genre);

        genreDropdownPanel.innerHTML = [
            `<button type="button" class="filter-dropdown-item${activeGenre === null ? ' active' : ''}" data-value="">Semua Kategori</button>`,
            `<button type="button" class="filter-dropdown-item${activeGenre === PS2_CATEGORY_VALUE ? ' active' : ''}" data-value="${PS2_CATEGORY_VALUE}">Game PS2</button>`,
            `<button type="button" class="filter-dropdown-item${activeGenre === PS3_CATEGORY_VALUE ? ' active' : ''}" data-value="${PS3_CATEGORY_VALUE}">Game PS3</button>`,
            `<button type="button" class="filter-dropdown-item${activeGenre === ONLINE_CATEGORY_VALUE ? ' active' : ''}" data-value="${ONLINE_CATEGORY_VALUE}">Online</button>`,
            `<button type="button" class="filter-dropdown-item${activeGenre === LOW_SPEC_CATEGORY_VALUE ? ' active' : ''}" data-value="${LOW_SPEC_CATEGORY_VALUE}">Low Spek</button>`,
            ...topGenres.map((g) => `<button type="button" class="filter-dropdown-item${activeGenre === g ? ' active' : ''}" data-value="${g}">${g}</button>`),
        ].join('');

        wireDropdownItems(genreDropdownPanel, genreDropdown, (value) => {
            setActiveGenre(value);
        });
    }

    function renderSkeleton() {
        grid.innerHTML = Array.from({ length: SKELETON_COUNT }).map(() => `
            <div class="gallery-card skeleton-card">
                <div class="gallery-card-img-wrap skeleton-shimmer"></div>
                <div class="gallery-card-footer">
                    <div class="skeleton-line skeleton-shimmer"></div>
                </div>
            </div>
        `).join('');
    }

    // Fades out the branded loading screen and — instead of revealing the
    // gallery directly — hands off to the mandatory storage-type picker.
    // Called once loadGames() finishes (success or failure) so the loading
    // screen never masks an error state forever.
    function hideAppLoadingScreen() {
        if (appLoadingScreen) {
            appLoadingScreen.classList.add('app-loading-hidden');
            appLoadingScreen.addEventListener('transitionend', () => {
                appLoadingScreen.remove();
            }, { once: true });
        }
        if (landingScreen) landingScreen.classList.add('visible');
    }

    // The gallery itself stays behind body.landing-active (non-interactive,
    // covered by the picker) until a storage type is actually chosen —
    // required every visit, not just the first ever one.
    if (landingActions) {
        landingActions.addEventListener('click', (e) => {
            const btn = e.target.closest('.landing-choice-card');
            if (!btn) return;
            const storageType = btn.getAttribute('data-storage');
            applyStorageType(storageType);
            document.body.classList.remove('landing-active');
            if (landingScreen) landingScreen.classList.remove('visible');
        });
    }

    async function loadGames() {
        const startedAt = Date.now();
        renderSkeleton();
        try {
            // Lean listings (title/banner_url/Genre/Game Size only) — the
            // gallery never needs system_requirements or the rest of
            // game_info, so it fetches these instead of the full catalogs
            // (see split_catalog_data.py). game.html fetches the full
            // per-game entry separately, on demand.
            const [gamesRes, ps2Res, ps3Res, sizeConfigRes] = await Promise.all([
                fetch('steamrip_games_updated.lite.json'),
                fetch('ps2.lite.json').catch(() => null),
                fetch('ps3.lite.json').catch(() => null),
                fetch('size_config.json').catch(() => null),
            ]);
            if (!gamesRes.ok) throw new Error('Gagal memuat data game');
            const data = await gamesRes.json();
            const ps2Data = ps2Res && ps2Res.ok ? await ps2Res.json() : [];
            const ps3Data = ps3Res && ps3Res.ok ? await ps3Res.json() : [];

            if (sizeConfigRes && sizeConfigRes.ok) {
                const sizeConfig = await sizeConfigRes.json();
                const pct = Number(sizeConfig && sizeConfig.size_buffer_percentage);
                if (Number.isFinite(pct)) window.FeatureCart.setSizeBufferMultiplier(1 + Math.min(100, Math.max(0, pct)) / 100);
            }

            const pcGames = (Array.isArray(data) ? data : []).map((g) => ({ ...g, _category: 'pc' }));
            const ps2Games = (Array.isArray(ps2Data) ? ps2Data : []).map((g) => ({ ...g, _category: 'ps2' }));
            const ps3Games = (Array.isArray(ps3Data) ? ps3Data : []).map((g) => ({ ...g, _category: 'ps3' }));
            // PC first so hero/Featured/Update Games (which only look at the
            // front of this array) stay PC-only — those rely on Steam
            // gameplay data and a "newest" ordering that PS2/PS3 don't have.
            allGames = [...pcGames, ...ps2Games, ...ps3Games];

            // The storage bar was already rendered once at page init (before
            // this fetch resolved), using an empty allGames — any items
            // already in the cart from a previous visit computed as 0 GB
            // used until the user touched a select button and re-triggered
            // FeatureCart's onChange. Refresh it now that lookups actually
            // work, so it's correct without needing that nudge.
            updateStorageUI();

            // Hero + Featured This Week both draw from the same "newest"
            // pool, shuffled fresh on every load, and never share a game —
            // the hero picks first, Featured gets a disjoint slice of what's
            // left over.
            const newestPool = shuffle(allGames.slice(0, NEWEST_POOL_SIZE));
            const heroGames = newestPool.slice(0, HERO_SLIDE_COUNT);
            const heroTitles = new Set(heroGames.map((g) => g.title));
            const featuredGames = newestPool.filter((g) => !heroTitles.has(g.title)).slice(0, 3);

            renderUpdateGamesRow();
            renderGenreFilterOptions();

            // Update Games' titles are also shown here, badged "Baru" (see
            // renderGrid) — not excluded, so the collection stays complete.
            filteredGames = allGames;
            renderGrid(true);

            // Hero + Featured This Week each need a bit of extra per-game
            // gameplay data (trailer/screenshot/rating) — fetched on demand
            // for just those ~11 games (see fetchGameplayForGames above)
            // instead of blocking on it. Deliberately not awaited: the grid
            // is already visible by this point, so these two sections pop
            // in a moment later without holding up first paint.
            renderHeroSection(heroGames).catch((err) => console.error(err));
            renderFeaturedWeek(featuredGames).catch((err) => console.error(err));
        } catch (err) {
            grid.innerHTML = `<div class="gallery-empty">Gagal memuat data game. Coba refresh halaman.</div>`;
            console.error(err);
        } finally {
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready.catch(() => {});
            }
            const MIN_LOADING_MS = 500;
            const elapsed = Date.now() - startedAt;
            if (elapsed < MIN_LOADING_MS) {
                await new Promise((resolve) => setTimeout(resolve, MIN_LOADING_MS - elapsed));
            }
            hideAppLoadingScreen();
        }
    }

    // --- Shared game-card builder (used by the main grid + Update Games strip) ---

    function buildGameCard(game, opts) {
        const options = opts || {};
        const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
        const sizeLabel = formatSizeGB(estimatedSizeGB(sizeStr));
        const isSelected = window.FeatureCart.isSelected(game.title);
        const tags = gameGenres(game).slice(0, 2);

        const card = document.createElement('a');
        card.className = 'gallery-card' + (isSelected ? ' selected' : '');
        card.href = gameHref(game);
        card.setAttribute('data-title', game.title);
        if (Number.isFinite(options.animIndex)) card.style.setProperty('--i', Math.min(options.animIndex, 14));

        const displayTitle = cleanDisplayTitle(game.title);
        const isOnline = requiresOnline(game.title);
        card.innerHTML = `
            <div class="gallery-card-img-wrap">
                <img class="gallery-card-img" src="${game.banner_url || 'assets/logo.png'}" alt="${displayTitle}" loading="lazy" decoding="async">
                ${options.badge || game._category === 'ps2' || game._category === 'ps3' || isOnline ? `<div class="gallery-card-badges">${options.badge ? `<span class="update-card-badge">${options.badge}</span>` : ''}${game._category === 'ps2' ? '<span class="ps2-badge">PS2</span>' : ''}${game._category === 'ps3' ? '<span class="ps3-badge">PS3</span>' : ''}${isOnline ? '<span class="online-badge">Online</span>' : ''}</div>` : ''}
                <button class="card-select-btn${isSelected ? ' selected' : ''}" data-select-title="${game.title}" data-select-category="${game._category}" type="button" aria-label="Pilih game">
                    ${SELECT_ICON_SVG}
                </button>
                ${tags.length ? `<div class="gallery-card-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>` : ''}
            </div>
            <div class="gallery-card-footer">
                <div class="gallery-card-footer-info">
                    <div class="gallery-card-title">${displayTitle}</div>
                    <div class="gallery-card-size">${sizeLabel}</div>
                </div>
                <button class="card-select-btn card-select-btn-inline${isSelected ? ' selected' : ''}" data-select-title="${game.title}" data-select-category="${game._category}" type="button">Pilih</button>
            </div>
        `;
        return card;
    }

    // --- Hero carousel ---

    function stripHtml(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return (div.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function heroDescriptionFor(game, gp) {
        if (gp && gp.about_the_game) {
            const text = stripHtml(gp.about_the_game);
            if (text) return text.length > 170 ? `${text.slice(0, 170).trim()}…` : text;
        }
        const genre = game.game_info && game.game_info.Genre;
        const developer = game.game_info && game.game_info.Developer;
        let fallback = `${game.title} tersedia di WD Games`;
        if (genre) fallback += ` — genre ${genre}`;
        if (developer) fallback += `, dikembangkan oleh ${developer}`;
        return `${fallback}.`;
    }

    async function renderHeroSection(heroGames) {
        if (!heroGames.length) return;
        const gpMap = await fetchGameplayForGames(heroGames);
        renderHero(heroGames, gpMap);
        landingHasContent.hero = true;
        discoverTop.style.display = '';
    }

    // --- Featured This Week: one large card + two smaller side cards, drawn
    // from the catalog slice right after the hero pool so it reads as a
    // distinct set of games rather than repeating "Update Games". ---

    async function renderFeaturedWeek(games) {
        if (!games.length) return;
        const gpMap = await fetchGameplayForGames(games);

        const [main, ...side] = games;
        const mainGp = gpMap[main.title];
        const mainBg = randomBackgroundFor(main, mainGp);
        const mainTag = (mainGp && Array.isArray(mainGp.genres) && mainGp.genres[0])
            || (main.game_info && main.game_info.Genre ? main.game_info.Genre.split(',')[0].trim() : 'Game');
        const mainSize = formatSizeGB(estimatedSizeGB(main.game_info ? main.game_info['Game Size'] : null));
        const mainSelected = window.FeatureCart.isSelected(main.title);
        const rating = mainGp && Number.isFinite(mainGp.metacritic_score) ? (mainGp.metacritic_score / 20).toFixed(1) : null;

        const mainHtml = `
            <div class="featured-main-card" data-title="${main.title}" style="background-image: url('${mainBg}')">
                <div class="featured-main-content">
                    <span class="featured-tag">${mainTag}</span>
                    <h3 class="featured-main-title">${cleanDisplayTitle(main.title)}</h3>
                    <div class="featured-meta-row">
                        <span>${mainSize}</span>
                        ${rating ? `<span class="featured-rating">★ ${rating}</span>` : ''}
                    </div>
                    <div class="featured-actions">
                        <a class="hero-cta-primary" href="${gameHref(main)}">Lihat Detail</a>
                        <button class="card-select-btn${mainSelected ? ' selected' : ''}" data-select-title="${main.title}" data-select-category="${main._category}" type="button" aria-label="Pilih game">
                            ${SELECT_ICON_SVG}
                        </button>
                    </div>
                </div>
            </div>
        `;

        const sideHtml = `<div class="featured-side-col">${side.map((game) => {
            const gp = gpMap[game.title];
            const bg = randomBackgroundFor(game, gp);
            const sizeLabel = formatSizeGB(estimatedSizeGB(game.game_info ? game.game_info['Game Size'] : null));
            return `
                <a class="featured-side-card" href="${gameHref(game)}" style="background-image: url('${bg}')">
                    <div class="featured-side-content">
                        <div class="featured-side-title">${cleanDisplayTitle(game.title)}</div>
                        <div class="featured-side-size">${sizeLabel}</div>
                    </div>
                </a>
            `;
        }).join('')}</div>`;

        featuredWeekGrid.innerHTML = mainHtml + sideHtml;
        landingHasContent.featured = true;
        featuredWeekSection.style.display = '';
    }

    function renderUpdateGamesRow() {
        const games = allGames.slice(0, HERO_SLIDE_COUNT);
        if (!games.length) return;
        updateScrollRow.innerHTML = '';
        const fragment = document.createDocumentFragment();
        games.forEach((game, idx) => {
            fragment.appendChild(buildGameCard(game, { animIndex: idx, badge: 'Baru' }));
        });
        updateScrollRow.appendChild(fragment);
        updateGamesTitles = new Set(games.map((g) => g.title));
        landingHasContent.update = true;
        updateGamesSection.style.display = '';
        setupUpdateGamesAutoScroll(updateScrollRow);
    }

    // Auto-advances the Update Games strip one card at a time — pauses the
    // moment the user touches/scrolls/clicks it, and only resumes on its own
    // after a stretch of no interaction, so it never fights a user actively
    // browsing the row.
    const UPDATE_SCROLL_INTERVAL_MS = 3000;
    const UPDATE_SCROLL_RESUME_IDLE_MS = 5000;

    function setupUpdateGamesAutoScroll(container) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        let autoTimer = null;
        let resumeTimer = null;

        function step() {
            const card = container.querySelector('.gallery-card');
            const cardWidth = card ? card.getBoundingClientRect().width : 200;
            const gap = 12;
            const maxScroll = container.scrollWidth - container.clientWidth;
            const next = container.scrollLeft + cardWidth + gap;
            container.scrollTo({ left: next >= maxScroll - 4 ? 0 : next, behavior: 'smooth' });
        }

        function startAuto() {
            stopAuto();
            autoTimer = setInterval(step, UPDATE_SCROLL_INTERVAL_MS);
        }

        function stopAuto() {
            if (autoTimer) clearInterval(autoTimer);
            autoTimer = null;
        }

        function onInteract() {
            stopAuto();
            clearTimeout(resumeTimer);
            resumeTimer = setTimeout(startAuto, UPDATE_SCROLL_RESUME_IDLE_MS);
        }

        container.addEventListener('pointerdown', onInteract);
        container.addEventListener('touchstart', onInteract, { passive: true });
        container.addEventListener('wheel', onInteract, { passive: true });

        startAuto();
    }

    // --- Trailer modal (hero "Tonton Trailer") ---

    function openTrailerModal(hlsUrl) {
        trailerModalBackdrop.classList.add('open');
        if (trailerModalVideo.canPlayType('application/vnd.apple.mpegurl')) {
            trailerModalVideo.src = hlsUrl;
        } else if (window.Hls && window.Hls.isSupported()) {
            trailerHlsInstance = new window.Hls();
            trailerHlsInstance.loadSource(hlsUrl);
            trailerHlsInstance.attachMedia(trailerModalVideo);
        } else {
            trailerModalVideo.src = hlsUrl;
        }
        trailerModalVideo.play().catch(() => {});
    }

    function closeTrailerModal() {
        trailerModalBackdrop.classList.remove('open');
        trailerModalVideo.pause();
        trailerModalVideo.removeAttribute('src');
        trailerModalVideo.load();
        if (trailerHlsInstance) {
            trailerHlsInstance.destroy();
            trailerHlsInstance = null;
        }
    }

    trailerModalClose.addEventListener('click', closeTrailerModal);
    trailerModalBackdrop.addEventListener('click', (e) => {
        if (e.target === trailerModalBackdrop) closeTrailerModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && trailerModalBackdrop.classList.contains('open')) closeTrailerModal();
    });

    // --- Tutorial modal (cara order + arti label Online) ---

    function openTutorialModal() {
        tutorialModalBackdrop.classList.add('open');
    }

    function closeTutorialModal() {
        tutorialModalBackdrop.classList.remove('open');
    }

    tutorialBtn.addEventListener('click', openTutorialModal);
    tutorialModalClose.addEventListener('click', closeTutorialModal);
    tutorialModalBackdrop.addEventListener('click', (e) => {
        if (e.target === tutorialModalBackdrop) closeTutorialModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && tutorialModalBackdrop.classList.contains('open')) closeTutorialModal();
    });

    function renderHero(games, gpMap) {
        // Pick each slide's background once and reuse it for both the big
        // slide and its thumbnail, so a game doesn't show two different
        // screenshots in the same carousel. Randomized per game so the same
        // game shows different gameplay art across refreshes.
        //
        // These are full 1920x1080 Steam screenshots (300KB-1MB each) — not
        // lazy-loadable via CSS background-image the way <img loading=lazy>
        // is, so applying all of them up front would fetch every slide's
        // image immediately regardless of whether the carousel ever reaches
        // it. Instead the HTML below leaves background-image unset and
        // applyHeroBg() (below) fills it in only for the active slide plus
        // one ahead, applying more as the carousel actually rotates there.
        const backgrounds = games.map((game) => randomBackgroundFor(game, gpMap[game.title]));

        heroSlidesEl.innerHTML = games.map((game, i) => {
            const gp = gpMap[game.title];
            const tags = gp && Array.isArray(gp.genres) && gp.genres.length
                ? gp.genres
                : gameGenres(game);
            const desc = heroDescriptionFor(game, gp);
            const trailerUrl = gp && gp.trailer_hls;

            return `
                <div class="hero-slide">
                    <div class="hero-slide-bg"></div>
                    <div class="hero-slide-overlay">
                        <div class="hero-slide-tags">${tags.slice(0, 3).map((t) => `<span>${t}</span>`).join('')}</div>
                        <h2 class="hero-slide-title">${cleanDisplayTitle(game.title)}</h2>
                        <p class="hero-slide-desc">${desc}</p>
                        <div class="hero-cta-row">
                            <a class="hero-cta-primary" href="${gameHref(game)}">
                                Lihat Detail
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                            </a>
                            ${trailerUrl ? `<button type="button" class="hero-cta-secondary" data-trailer-hls="${trailerUrl}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                <span class="hero-cta-label">Tonton Trailer</span>
                            </button>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        heroSlidesEl.querySelectorAll('[data-trailer-hls]').forEach((btn) => {
            btn.addEventListener('click', () => openTrailerModal(btn.getAttribute('data-trailer-hls')));
        });

        // Thumbnail rail doubles as the slide picker — each thumb previews
        // the next game rather than being a bare dot.
        heroThumbsEl.innerHTML = games.map((game, i) => {
            const displayTitle = cleanDisplayTitle(game.title);
            return `
                <button class="hero-thumb" data-idx="${i}" aria-label="${displayTitle}">
                    <span class="hero-thumb-label">
                        <span class="hero-thumb-num">${String(i + 1).padStart(2, '0')}</span>
                        <span class="hero-thumb-title">${displayTitle}</span>
                    </span>
                </button>
            `;
        }).join('');

        const slideEls = heroSlidesEl.querySelectorAll('.hero-slide');
        const thumbEls = heroThumbsEl.querySelectorAll('.hero-thumb');
        const loadedBg = new Set();

        function applyHeroBg(idx) {
            if (loadedBg.has(idx)) return;
            loadedBg.add(idx);
            const url = backgrounds[idx];
            const slideBg = slideEls[idx] && slideEls[idx].querySelector('.hero-slide-bg');
            if (slideBg) slideBg.style.backgroundImage = `url('${url}')`;
            if (thumbEls[idx]) thumbEls[idx].style.backgroundImage = `url('${url}')`;
        }

        function goTo(idx) {
            heroIndex = (idx + games.length) % games.length;
            applyHeroBg(heroIndex);
            // Preload the next slide's image now so it's already cached by
            // the time auto-rotate or a manual "next" click reaches it.
            applyHeroBg((heroIndex + 1) % games.length);
            heroSlidesEl.style.transform = `translateX(-${heroIndex * 100}%)`;
            heroThumbsEl.querySelectorAll('.hero-thumb').forEach((t, i) => t.classList.toggle('active', i === heroIndex));
            slideEls.forEach((s, i) => s.classList.toggle('active', i === heroIndex));
            scrollThumbRowTo(heroThumbsEl.querySelector('.hero-thumb.active'));
        }

        // Scrolls the thumbnail rail horizontally only — Element.scrollIntoView()
        // with block:'nearest' can still bubble up to the page's vertical
        // scroll container when the rail itself has no vertical overflow,
        // which was auto-scrolling the whole page to the top on every hero
        // rotation. Adjusting scrollLeft directly avoids touching page scroll.
        function scrollThumbRowTo(thumb) {
            if (!thumb) return;
            const thumbLeft = thumb.offsetLeft;
            const thumbRight = thumbLeft + thumb.offsetWidth;
            const viewLeft = heroThumbsEl.scrollLeft;
            const viewRight = viewLeft + heroThumbsEl.clientWidth;
            if (thumbLeft < viewLeft) {
                heroThumbsEl.scrollTo({ left: thumbLeft - 8, behavior: 'smooth' });
            } else if (thumbRight > viewRight) {
                heroThumbsEl.scrollTo({ left: thumbRight - heroThumbsEl.clientWidth + 8, behavior: 'smooth' });
            }
        }

        heroThumbsEl.querySelectorAll('.hero-thumb').forEach((thumb) => {
            thumb.addEventListener('click', () => {
                goTo(Number(thumb.getAttribute('data-idx')));
                restartHeroTimer();
            });
        });
        heroPrevBtn.addEventListener('click', () => { goTo(heroIndex - 1); restartHeroTimer(); });
        heroNextBtn.addEventListener('click', () => { goTo(heroIndex + 1); restartHeroTimer(); });

        function restartHeroTimer() {
            clearInterval(heroTimer);
            heroTimer = setInterval(() => goTo(heroIndex + 1), HERO_ROTATE_MS);
        }

        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Pause auto-advance while the user's cursor is over the carousel —
        // the CSS handles pausing the per-dot progress-bar animation itself
        // (:hover + animation-play-state), this just stops the JS timer.
        document.getElementById('hero-carousel').addEventListener('mouseenter', () => clearInterval(heroTimer));
        document.getElementById('hero-carousel').addEventListener('mouseleave', () => {
            if (!prefersReducedMotion) restartHeroTimer();
        });

        // Touch-swipe navigation — the mobile layout hides the nav arrows
        // and thumbnail rail (see css/feature.css) and relies entirely on
        // dragging the slide itself instead.
        let touchStartX = 0;
        let touchStartY = 0;
        let touchDeltaX = 0;
        let isSwiping = false;
        const heroCarouselEl = document.getElementById('hero-carousel');

        heroCarouselEl.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            touchStartX = t.clientX;
            touchStartY = t.clientY;
            touchDeltaX = 0;
            isSwiping = false;
            clearInterval(heroTimer);
        }, { passive: true });

        heroCarouselEl.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            const dx = t.clientX - touchStartX;
            const dy = t.clientY - touchStartY;
            if (!isSwiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
                isSwiping = true;
            }
            if (isSwiping) {
                touchDeltaX = dx;
                // Only a confirmed horizontal swipe hijacks the gesture —
                // this keeps vertical page scrolling untouched otherwise.
                e.preventDefault();
            }
        }, { passive: false });

        heroCarouselEl.addEventListener('touchend', () => {
            if (isSwiping && Math.abs(touchDeltaX) > 40) {
                goTo(touchDeltaX < 0 ? heroIndex + 1 : heroIndex - 1);
            }
            isSwiping = false;
            touchDeltaX = 0;
            if (!prefersReducedMotion) restartHeroTimer();
        });

        goTo(0);
        if (!prefersReducedMotion) restartHeroTimer();
    }

    // Cards can be selected straight from their checkmark button, without
    // opening the detail page first — clicking anywhere else on the card
    // still navigates there as usual.
    function attachCardSelect(container) {
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.card-select-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();

            const title = btn.getAttribute('data-select-title');
            const category = btn.getAttribute('data-select-category');

            if (!window.FeatureCart.isSelected(title)) {
                const state = window.FeatureCart.getState();
                const game = allGames.find((g) => g.title === title);
                const sizeStr = game && game.game_info ? game.game_info['Game Size'] : null;
                const addedGB = estimatedSizeGB(sizeStr);
                const overBy = (computeUsedGB(state) + addedGB) - state.capacityGB;
                if (overBy > 0) {
                    window.FeatureCartWidget.showToast(
                        `Kapasitas tidak cukup! "${cleanDisplayTitle(title)}" (${formatSizeGB(addedGB)}) melebihi sisa ruang sekitar ${formatSizeGB(overBy)}. Silakan hapus game lain dari daftar terlebih dahulu untuk menambahkan game ini.`,
                        'error',
                        { shake: true }
                    );
                    return;
                }
            }

            if (!window.FeatureCart.isSelected(title) && !window.FeatureCart.canAdd(category)) {
                window.FeatureCartWidget.showToast('Flashdisk cuma untuk game PS2 — ganti media penyimpanan dulu untuk pilih game PC.', 'error');
                return;
            }

            const selected = window.FeatureCart.toggle(title, category);
            const card = btn.closest('.gallery-card');
            if (card) {
                card.classList.toggle('selected', selected);
                card.querySelectorAll('.card-select-btn').forEach((b) => b.classList.toggle('selected', selected));
            } else {
                btn.classList.toggle('selected', selected);
            }
            if (selected) window.FeatureCartWidget.flyToCart(btn);
        });
    }

    // --- Main searchable grid ---

    function applyFilters() {
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const q = searchInput.value.trim().toLowerCase();

        const apply = () => {
            // Searching or picking a category focuses the page on just the
            // matching games — hide the hero/Featured/Update Games "landing"
            // sections instead of making people scroll past them. Clearing
            // the filter brings back only the sections that actually had
            // content to begin with.
            const isFiltering = Boolean(q) || Boolean(activeGenre);

            filteredGames = allGames.filter((g) => {
                const matchesSearch = !q || (g.title || '').toLowerCase().includes(q);
                const matchesGenre = !activeGenre
                    || (activeGenre === PS2_CATEGORY_VALUE ? g._category === 'ps2'
                        : activeGenre === PS3_CATEGORY_VALUE ? g._category === 'ps3'
                            : activeGenre === ONLINE_CATEGORY_VALUE ? requiresOnline(g.title)
                                : activeGenre === LOW_SPEC_CATEGORY_VALUE ? isLowSpec(g)
                                    : gameGenres(g).includes(activeGenre));
                return matchesSearch && matchesGenre;
            });

            if (sortMode === 'az') {
                filteredGames = [...filteredGames].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            }

            const labelParts = [];
            if (activeGenre) labelParts.push(activeGenre === PS2_CATEGORY_VALUE ? 'Game PS2' : activeGenre === PS3_CATEGORY_VALUE ? 'Game PS3' : activeGenre === ONLINE_CATEGORY_VALUE ? 'Online' : activeGenre === LOW_SPEC_CATEGORY_VALUE ? 'Low Spek' : activeGenre);
            if (q) labelParts.push(`"${searchInput.value.trim()}"`);
            catalogTitle.textContent = labelParts.length ? `Hasil untuk ${labelParts.join(' · ')}` : 'Explore Your Collection';

            discoverTop.style.display = !isFiltering && landingHasContent.hero ? '' : 'none';
            featuredWeekSection.style.display = !isFiltering && landingHasContent.featured ? '' : 'none';
            updateGamesSection.style.display = !isFiltering && landingHasContent.update ? '' : 'none';

            renderGrid(true);
            grid.classList.remove('grid-transitioning');
        };

        if (prefersReducedMotion) {
            apply();
            return;
        }
        grid.classList.add('grid-transitioning');
        setTimeout(apply, 150);
    }

    function renderGrid(reset) {
        if (reset) {
            grid.innerHTML = '';
            currentPage = 1;
        }

        if (filteredGames.length === 0) {
            grid.innerHTML = `<div class="gallery-empty">Tidak ada game yang ditemukan.</div>`;
            loadMoreBtn.style.display = 'none';
            return;
        }

        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const chunk = filteredGames.slice(startIndex, endIndex);

        const fragment = document.createDocumentFragment();
        chunk.forEach((game, chunkIdx) => {
            const badge = updateGamesTitles.has(game.title) ? 'Baru' : undefined;
            fragment.appendChild(buildGameCard(game, { animIndex: chunkIdx, badge }));
        });

        grid.appendChild(fragment);
        loadMoreBtn.style.display = endIndex >= filteredGames.length ? 'none' : 'inline-block';
    }

    loadMoreBtn.addEventListener('click', () => {
        currentPage++;
        renderGrid(false);
    });

    // --- Search-as-you-type suggestions dropdown ---
    // Runs on every keystroke (no debounce — it's a cheap in-memory scan
    // over an already-loaded array) so the popup feels instant, separate
    // from the debounced full-grid filter below.

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function highlightMatch(title, query) {
        const idx = title.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return escapeHtml(title);
        const before = escapeHtml(title.slice(0, idx));
        const match = escapeHtml(title.slice(idx, idx + query.length));
        const after = escapeHtml(title.slice(idx + query.length));
        return `${before}<mark>${match}</mark>${after}`;
    }

    let suggestActiveIndex = -1;

    function closeSuggestions() {
        searchSuggestPanel.classList.remove('open');
        searchSuggestPanel.innerHTML = '';
        suggestActiveIndex = -1;
        searchInput.setAttribute('aria-expanded', 'false');
    }

    function suggestItems() {
        return Array.from(searchSuggestPanel.querySelectorAll('.search-suggest-item'));
    }

    function setActiveSuggestIndex(idx) {
        const items = suggestItems();
        if (!items.length) return;
        suggestActiveIndex = (idx + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('active', i === suggestActiveIndex));
        items[suggestActiveIndex].scrollIntoView({ block: 'nearest' });
    }

    function renderSuggestions(rawQuery) {
        const q = rawQuery.trim();
        if (!q) {
            closeSuggestions();
            return;
        }

        const qLower = q.toLowerCase();
        const flashdiskLocked = window.FeatureCart.getState().storageType === 'flashdisk';
        const matches = allGames.filter((g) => (g.title || '').toLowerCase().includes(qLower)
            && (!flashdiskLocked || g._category === 'ps2'));
        suggestActiveIndex = -1;

        if (matches.length === 0) {
            searchSuggestPanel.innerHTML = `<div class="search-suggest-empty">Tidak ada game dengan kata "${escapeHtml(q)}"</div>`;
            searchSuggestPanel.classList.add('open');
            searchInput.setAttribute('aria-expanded', 'true');
            return;
        }

        const shown = matches.slice(0, SUGGEST_LIMIT);
        const itemsHtml = shown.map((game) => {
            const sizeLabel = formatSizeGB(estimatedSizeGB(game.game_info ? game.game_info['Game Size'] : null));
            const isSelected = window.FeatureCart.isSelected(game.title);
            return `
                <a class="search-suggest-item" href="${gameHref(game)}" data-title="${game.title}">
                    <img class="search-suggest-thumb" src="${game.banner_url || 'assets/logo.png'}" alt="" loading="lazy">
                    <div class="search-suggest-info">
                        <div class="search-suggest-title">${highlightMatch(cleanDisplayTitle(game.title), q)}</div>
                        <div class="search-suggest-size">${sizeLabel}</div>
                    </div>
                    <button class="card-select-btn card-select-btn-inline${isSelected ? ' selected' : ''}" data-select-title="${game.title}" data-select-category="${game._category}" type="button">Pilih</button>
                </a>
            `;
        }).join('');

        const footerHtml = matches.length > SUGGEST_LIMIT
            ? `<button type="button" class="search-suggest-footer" id="search-suggest-see-all">Lihat semua ${matches.length} hasil untuk "${escapeHtml(q)}"</button>`
            : '';

        searchSuggestPanel.innerHTML = itemsHtml + footerHtml;
        searchSuggestPanel.classList.add('open');
        searchInput.setAttribute('aria-expanded', 'true');

        const seeAllBtn = document.getElementById('search-suggest-see-all');
        if (seeAllBtn) {
            seeAllBtn.addEventListener('click', () => {
                closeSuggestions();
                catalogSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    }

    searchInput.addEventListener('keydown', (e) => {
        if (!searchSuggestPanel.classList.contains('open')) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveSuggestIndex(suggestActiveIndex + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveSuggestIndex(suggestActiveIndex - 1);
        } else if (e.key === 'Enter') {
            const items = suggestItems();
            if (suggestActiveIndex >= 0 && items[suggestActiveIndex]) {
                e.preventDefault();
                window.location.href = items[suggestActiveIndex].getAttribute('href');
            }
        } else if (e.key === 'Escape') {
            closeSuggestions();
        }
    });

    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim()) renderSuggestions(searchInput.value);
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.gallery-search-wrap')) closeSuggestions();
    });

    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
        renderSuggestions(searchInput.value);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(applyFilters, 200);
    });

    catalogSortSelect.addEventListener('change', () => {
        sortMode = catalogSortSelect.value;
        applyFilters();
    });

    updateGamesSeeAll.addEventListener('click', (e) => {
        e.preventDefault();
        catalogSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // --- Storage picker + space indicator ---

    function currentStoragePreset() {
        const state = window.FeatureCart.getState();
        return window.FeatureCart.STORAGE_PRESETS[state.storageType] || window.FeatureCart.STORAGE_PRESETS.hdd;
    }

    // Capacity options are type-dependent (HDD/SSD/Flashdisk each have their
    // own tier list) — repopulated whenever the storage type changes, not
    // just once at init.
    function populateCapacityOptions() {
        storageCapacityDropdownPanel.innerHTML = currentStoragePreset().capacities
            .map((t) => `<button type="button" class="filter-dropdown-item" data-value="${t.value}">${t.label}</button>`)
            .join('');
        wireDropdownItems(storageCapacityDropdownPanel, storageCapacityDropdown, (value) => {
            const state = window.FeatureCart.getState();
            window.FeatureCart.setStorage(state.storageType, Number(value));
            updateStorageUI();
        });
    }

    function syncStoragePickerFromState() {
        const state = window.FeatureCart.getState();

        const typeLabel = STORAGE_TYPE_LABELS[state.storageType] || state.storageType.toUpperCase();
        storageTypeDropdown.setLabel(typeLabel);
        storageTypeDropdownPanel.querySelectorAll('.filter-dropdown-item').forEach((item) => {
            item.classList.toggle('active', item.getAttribute('data-value') === state.storageType);
        });

        const capacityLabel = capacityLabelFor(state.capacityGB);
        storageCapacityDropdown.setLabel(capacityLabel);
        storageCapacityDropdownPanel.querySelectorAll('.filter-dropdown-item').forEach((item) => {
            item.classList.toggle('active', Number(item.getAttribute('data-value')) === state.capacityGB);
        });
    }

    function capacityLabelFor(capacityGB) {
        const tier = currentStoragePreset().capacities.find((t) => t.value === capacityGB);
        return tier ? tier.label : formatSizeGB(capacityGB);
    }

    // Shared by updateStorageUI() and the over-capacity check in
    // attachCardSelect() below, so both agree on exactly the same total.
    function computeUsedGB(state) {
        return state.selected.reduce((sum, title) => {
            const game = allGames.find((g) => g.title === title);
            if (!game) return sum;
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            return sum + estimatedSizeGB(sizeStr);
        }, 0);
    }

    function updateStorageUI() {
        const state = window.FeatureCart.getState();
        const usedGB = computeUsedGB(state);

        const pct = state.capacityGB > 0 ? (usedGB / state.capacityGB) * 100 : 0;
        storageProgressFill.style.width = `${Math.min(100, pct)}%`;
        applyStorageThreshold(pct);

        const availableGB = Math.max(0, state.capacityGB - usedGB);
        storageFooterUsed.textContent = formatSizeGB(usedGB);
        storageFooterTotal.textContent = formatSizeGB(state.capacityGB);
        storageFooterRemaining.textContent = formatSizeGB(availableGB);
        storageFooterRemaining.classList.remove('threshold-warn', 'threshold-danger', 'text-accent');
        if (pct > 100) storageFooterRemaining.classList.add('threshold-danger');
        else if (pct >= 75) storageFooterRemaining.classList.add('threshold-warn');
        else storageFooterRemaining.classList.add('text-accent');
    }

    function applyStorageThreshold(pct) {
        storageProgressFill.classList.remove('threshold-warn', 'threshold-danger');
        if (pct > 100) storageProgressFill.classList.add('threshold-danger');
        else if (pct >= 75) storageProgressFill.classList.add('threshold-warn');
    }

    // Card/select-button "selected" state is baked into the HTML string at
    // render time (buildGameCard, Featured This Week) rather than read live
    // — fine for clicks made right here, since attachCardSelect() also
    // toggles the class directly, but it means a selection made elsewhere
    // (game.html, another tab, or a bfcache-restored back navigation) never
    // reaches already-rendered cards. Re-run this on every cart change to
    // keep them honest.
    function syncSelectionUI() {
        document.querySelectorAll('[data-select-title]').forEach((btn) => {
            const selected = window.FeatureCart.isSelected(btn.getAttribute('data-select-title'));
            btn.classList.toggle('selected', selected);
        });
        document.querySelectorAll('.gallery-card[data-title], .featured-main-card[data-title]').forEach((card) => {
            card.classList.toggle('selected', window.FeatureCart.isSelected(card.getAttribute('data-title')));
        });
    }

    // Removes any already-selected games that are no longer allowed once
    // Flashdisk (PS2-only) becomes the active storage type — otherwise a PC
    // game picked earlier under HDD/SSD would silently ride along in the
    // cart/export list even though Flashdisk can't actually hold it.
    function purgeIncompatibleSelections() {
        const state = window.FeatureCart.getState();
        const removed = state.selected.filter((title) => {
            const game = allGames.find((g) => g.title === title);
            return game && !window.FeatureCart.canAdd(game._category);
        });
        removed.forEach((title) => window.FeatureCart.remove(title));
        if (removed.length) {
            window.FeatureCartWidget.showToast(
                `${removed.length} game PC dihapus dari daftar — Flashdisk cuma untuk game PS2.`,
                'error'
            );
        }
    }

    function applyStorageType(value) {
        const preset = window.FeatureCart.STORAGE_PRESETS[value];
        if (!preset) return;
        // Changing storage type always resets capacity to that type's
        // default and repopulates its tier list.
        window.FeatureCart.setStorage(value, preset.defaultCapacity);
        populateCapacityOptions();
        syncStoragePickerFromState();
        updateStorageUI();

        // Flashdisk is PS2-only on the main site too — lock the Kategori
        // filter to "Game PS2" while it's selected (and the dropdown itself,
        // so the user can't just pick a different category right back out
        // of it), and release both when switching to HDD/SSD.
        if (preset.lockCategory === 'ps2') {
            setActiveGenre(PS2_CATEGORY_VALUE);
            genreDropdown.setDisabled(true);
            purgeIncompatibleSelections();
        } else {
            genreDropdown.setDisabled(false);
            if (activeGenre === PS2_CATEGORY_VALUE) setActiveGenre(null);
        }
    }

    wireDropdownItems(storageTypeDropdownPanel, storageTypeDropdown, applyStorageType);

    // --- Floating cart widget (shared controller in js/feature-cart-widget.js) ---

    window.FeatureCartWidget.init({
        findGame: (title) => allGames.find((g) => g.title === title),
        onRemove: (title) => {
            document.querySelectorAll(`[data-title="${CSS.escape(title)}"]`).forEach((card) => {
                card.classList.remove('selected');
                card.querySelectorAll('.card-select-btn').forEach((btn) => btn.classList.remove('selected'));
            });
            updateStorageUI();
        },
    });

    window.FeatureCart.onChange(updateStorageUI);
    window.FeatureCart.onChange(syncSelectionUI);

    // --- Floating search button (shows once the user has scrolled down a
    // bit, since the header stays sticky but its search field can still be
    // fiddly to reach on a long mobile page) ---
    if (searchFab && searchFabBtn) {
        let searchFabVisible = false;
        function updateSearchFabVisibility() {
            const shouldShow = window.scrollY > 400;
            if (shouldShow === searchFabVisible) return;
            searchFabVisible = shouldShow;
            searchFab.classList.toggle('visible', shouldShow);
        }
        window.addEventListener('scroll', updateSearchFabVisibility, { passive: true });
        updateSearchFabVisibility();

        searchFabBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            setTimeout(() => {
                if (searchInput) searchInput.focus();
            }, 300);
        });
    }

    attachCardSelect(grid);
    attachCardSelect(updateScrollRow);
    attachCardSelect(featuredWeekGrid);
    attachCardSelect(searchSuggestPanel);
    populateCapacityOptions();
    syncStoragePickerFromState();
    updateStorageUI();
    loadGames();
})();
