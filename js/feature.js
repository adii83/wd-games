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
    const HERO_ROTATE_MS = 6000;
    // How far into the "newest first" list (admin unshift() order) the hero
    // + Featured This Week are allowed to draw from — keeps them feeling
    // "recent" while still leaving room to shuffle a different mix in on
    // every page load.
    const NEWEST_POOL_SIZE = 30;

    const STORAGE_TYPE_LABELS = { hdd: 'HDD', ssd: 'SSD', flashdisk: 'Flashdisk' };
    // Sentinel Kategori value for the PS2 platform filter — kept out of the
    // frequency-ranked genre list so it always shows as its own fixed entry.
    const PS2_CATEGORY_VALUE = '__ps2__';

    const SELECT_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    const SUGGEST_LIMIT = 6;

    const appLoadingScreen = document.getElementById('app-loading-screen');
    const grid = document.getElementById('gallery-grid');
    const loadMoreBtn = document.getElementById('gallery-load-more');
    const searchInput = document.getElementById('gallery-search');
    const searchSuggestPanel = document.getElementById('search-suggest-panel');
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
    let gameplayData = {};
    let heroTimer = null;
    let heroIndex = 0;
    let sortMode = 'newest';
    let activeGenre = null;
    let trailerHlsInstance = null;
    // Tracks which landing sections actually have content to show, so
    // filtering (search/category) can hide them and clearing the filter
    // can bring back only the ones that were genuinely populated.
    const landingHasContent = { hero: false, featured: false, update: false };
    // Titles already shown in the "Update Games" strip — excluded from
    // "Explore Your Collection" while browsing so the same game doesn't
    // appear twice on the page.
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
        // A handful of titles exist on both PC and PS2 (e.g. "Half-Life",
        // "Grand Theft Auto: Vice City") — tag the platform in the URL so
        // game.html opens the right one instead of just the first match.
        return game._category === 'ps2' ? `${base}&c=ps2` : base;
    }

    // Buffered size: raw size times the admin-configured size_config.json
    // buffer, used everywhere a size is displayed or summed.
    function estimatedSizeGB(rawSize) {
        return parseSizeToGB(rawSize) * window.FeatureCart.getSizeBufferMultiplier();
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

    // Genres used for the Kategori filter (dropdown options + matching).
    // game_info.Genre already holds Steam's real genre list for every PC
    // title with a Steam match (update_pc_genres_from_steam.py rewrote
    // steamrip_games_updated.json directly), so this can just read it —
    // no need to special-case gameplayData here too.
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
        genreDropdown.setLabel(activeGenre === PS2_CATEGORY_VALUE ? 'Game PS2' : (activeGenre || 'Semua Kategori'));
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

    // Reveals the gallery and fades out the branded loading screen. Called
    // once loadGames() finishes (success or failure) so the screen never
    // masks an error state forever.
    function hideAppLoadingScreen() {
        if (!appLoadingScreen) return;
        appLoadingScreen.classList.add('app-loading-hidden');
        appLoadingScreen.addEventListener('transitionend', () => {
            appLoadingScreen.remove();
        }, { once: true });
    }

    async function loadGames() {
        const startedAt = Date.now();
        renderSkeleton();
        try {
            const [gamesRes, ps2Res, gameplayRes, sizeConfigRes] = await Promise.all([
                fetch('steamrip_games_updated.json'),
                fetch('ps2.json').catch(() => null),
                fetch('steamrip_games_gameplay.json').catch(() => null),
                fetch('size_config.json').catch(() => null),
            ]);
            if (!gamesRes.ok) throw new Error('Gagal memuat data game');
            const data = await gamesRes.json();
            const ps2Data = ps2Res && ps2Res.ok ? await ps2Res.json() : [];
            gameplayData = gameplayRes && gameplayRes.ok ? await gameplayRes.json() : {};

            if (sizeConfigRes && sizeConfigRes.ok) {
                const sizeConfig = await sizeConfigRes.json();
                const pct = Number(sizeConfig && sizeConfig.size_buffer_percentage);
                if (Number.isFinite(pct)) window.FeatureCart.setSizeBufferMultiplier(1 + Math.min(100, Math.max(0, pct)) / 100);
            }

            const pcGames = (Array.isArray(data) ? data : []).map((g) => ({ ...g, _category: 'pc' }));
            const ps2Games = (Array.isArray(ps2Data) ? ps2Data : []).map((g) => ({ ...g, _category: 'ps2' }));
            // PC first so hero/Featured/Update Games (which only look at the
            // front of this array) stay PC-only — those rely on Steam
            // gameplay data and a "newest" ordering that PS2 doesn't have.
            allGames = [...pcGames, ...ps2Games];

            // Hero + Featured This Week both draw from the same "newest"
            // pool, shuffled fresh on every load, and never share a game —
            // the hero picks first, Featured gets a disjoint slice of what's
            // left over.
            const newestPool = shuffle(allGames.slice(0, NEWEST_POOL_SIZE));
            const heroGames = newestPool.slice(0, HERO_SLIDE_COUNT);
            const heroTitles = new Set(heroGames.map((g) => g.title));
            const featuredGames = newestPool.filter((g) => !heroTitles.has(g.title)).slice(0, 3);

            renderHeroSection(heroGames);
            renderFeaturedWeek(featuredGames);
            renderUpdateGamesRow();
            renderGenreFilterOptions();

            // Games already shown in "Update Games" are left out of the
            // default "Explore Your Collection" view so nothing repeats.
            filteredGames = allGames.filter((g) => !updateGamesTitles.has(g.title));
            renderGrid(true);
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
        const gp = gameplayData[game.title];
        const isSelected = window.FeatureCart.isSelected(game.title);
        const tags = gp && Array.isArray(gp.genres) ? gp.genres.slice(0, 2) : [];

        const card = document.createElement('a');
        card.className = 'gallery-card' + (isSelected ? ' selected' : '');
        card.href = gameHref(game);
        card.setAttribute('data-title', game.title);
        if (Number.isFinite(options.animIndex)) card.style.setProperty('--i', Math.min(options.animIndex, 14));

        const displayTitle = cleanDisplayTitle(game.title);
        card.innerHTML = `
            <div class="gallery-card-img-wrap">
                <img class="gallery-card-img" src="${game.banner_url || 'assets/logo.png'}" alt="${displayTitle}" loading="lazy" decoding="async">
                ${options.badge || game._category === 'ps2' ? `<div class="gallery-card-badges">${options.badge ? `<span class="update-card-badge">${options.badge}</span>` : ''}${game._category === 'ps2' ? '<span class="ps2-badge">PS2</span>' : ''}</div>` : ''}
                <button class="card-select-btn${isSelected ? ' selected' : ''}" data-select-title="${game.title}" type="button" aria-label="Pilih game">
                    ${SELECT_ICON_SVG}
                </button>
                ${tags.length ? `<div class="gallery-card-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>` : ''}
            </div>
            <div class="gallery-card-footer">
                <div class="gallery-card-footer-info">
                    <div class="gallery-card-title">${displayTitle}</div>
                    <div class="gallery-card-size">${sizeLabel}</div>
                </div>
                <button class="card-select-btn card-select-btn-inline${isSelected ? ' selected' : ''}" data-select-title="${game.title}" type="button">Pilih</button>
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

    function renderHeroSection(heroGames) {
        if (heroGames.length) {
            renderHero(heroGames);
            landingHasContent.hero = true;
            discoverTop.style.display = '';
        }
    }

    // --- Featured This Week: one large card + two smaller side cards, drawn
    // from the catalog slice right after the hero pool so it reads as a
    // distinct set of games rather than repeating "Update Games". ---

    function renderFeaturedWeek(games) {
        if (!games.length) return;

        const [main, ...side] = games;
        const mainGp = gameplayData[main.title];
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
                        <button class="card-select-btn${mainSelected ? ' selected' : ''}" data-select-title="${main.title}" type="button" aria-label="Pilih game">
                            ${SELECT_ICON_SVG}
                        </button>
                    </div>
                </div>
            </div>
        `;

        const sideHtml = `<div class="featured-side-col">${side.map((game) => {
            const gp = gameplayData[game.title];
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

    function renderHero(games) {
        // Pick each slide's background once and reuse it for both the big
        // slide and its thumbnail, so a game doesn't show two different
        // screenshots in the same carousel. Randomized per game so the same
        // game shows different gameplay art across refreshes.
        const backgrounds = games.map((game) => randomBackgroundFor(game, gameplayData[game.title]));

        heroSlidesEl.innerHTML = games.map((game, i) => {
            const gp = gameplayData[game.title];
            const tags = gp && Array.isArray(gp.genres) && gp.genres.length
                ? gp.genres
                : (game.game_info && game.game_info.Genre ? game.game_info.Genre.split(',').map((s) => s.trim()) : []);
            const desc = heroDescriptionFor(game, gp);
            const trailerUrl = gp && gp.trailer_hls;

            return `
                <div class="hero-slide">
                    <div class="hero-slide-bg" style="background-image: url('${backgrounds[i]}')"></div>
                    <div class="hero-slide-overlay">
                        <span class="hero-slide-badge">Update Terbaru</span>
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
                <button class="hero-thumb" data-idx="${i}" style="background-image: url('${backgrounds[i]}')" aria-label="${displayTitle}">
                    <span class="hero-thumb-label">
                        <span class="hero-thumb-num">${String(i + 1).padStart(2, '0')}</span>
                        <span class="hero-thumb-title">${displayTitle}</span>
                    </span>
                </button>
            `;
        }).join('');

        const slideEls = heroSlidesEl.querySelectorAll('.hero-slide');

        function goTo(idx) {
            heroIndex = (idx + games.length) % games.length;
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
            const selected = window.FeatureCart.toggle(title);
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
            // content to begin with. While filtering, Update Games titles
            // are allowed back into the results (that strip is hidden
            // anyway, so nothing repeats on screen) so search stays
            // reliable across the whole catalog instead of hiding matches.
            const isFiltering = Boolean(q) || Boolean(activeGenre);

            filteredGames = allGames.filter((g) => {
                const matchesSearch = !q || (g.title || '').toLowerCase().includes(q);
                const matchesGenre = !activeGenre
                    || (activeGenre === PS2_CATEGORY_VALUE ? g._category === 'ps2' : gameGenres(g).includes(activeGenre));
                const notDuplicatingUpdateGames = isFiltering || !updateGamesTitles.has(g.title);
                return matchesSearch && matchesGenre && notDuplicatingUpdateGames;
            });

            if (sortMode === 'az') {
                filteredGames = [...filteredGames].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            }

            const labelParts = [];
            if (activeGenre) labelParts.push(activeGenre === PS2_CATEGORY_VALUE ? 'Game PS2' : activeGenre);
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
            fragment.appendChild(buildGameCard(game, { animIndex: chunkIdx }));
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
        const matches = allGames.filter((g) => (g.title || '').toLowerCase().includes(qLower));
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
            return `
                <a class="search-suggest-item" href="${gameHref(game)}">
                    <img class="search-suggest-thumb" src="${game.banner_url || 'assets/logo.png'}" alt="" loading="lazy">
                    <div class="search-suggest-info">
                        <div class="search-suggest-title">${highlightMatch(cleanDisplayTitle(game.title), q)}</div>
                        <div class="search-suggest-size">${sizeLabel}</div>
                    </div>
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

    function updateStorageUI() {
        const state = window.FeatureCart.getState();
        const usedGB = state.selected.reduce((sum, title) => {
            const game = allGames.find((g) => g.title === title);
            if (!game) return sum;
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            return sum + estimatedSizeGB(sizeStr);
        }, 0);

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

    wireDropdownItems(storageTypeDropdownPanel, storageTypeDropdown, (value) => {
        const preset = window.FeatureCart.STORAGE_PRESETS[value];
        if (!preset) return;
        // Changing storage type always resets capacity to that type's
        // default and repopulates its tier list.
        window.FeatureCart.setStorage(value, preset.defaultCapacity);
        populateCapacityOptions();
        syncStoragePickerFromState();
        updateStorageUI();

        // Flashdisk is PS2-only on the main site too — lock the Kategori
        // filter to "Game PS2" while it's selected, and release it back to
        // "Semua Kategori" when switching to HDD/SSD.
        if (preset.lockCategory === 'ps2') {
            setActiveGenre(PS2_CATEGORY_VALUE);
        } else if (activeGenre === PS2_CATEGORY_VALUE) {
            setActiveGenre(null);
        }
    });

    // --- Floating cart widget (shared controller in js/feature-cart-widget.js) ---

    window.FeatureCartWidget.init({
        findGame: (title) => allGames.find((g) => g.title === title),
        onRemove: (title) => {
            document.querySelectorAll(`[data-title="${CSS.escape(title)}"]`).forEach((card) => {
                card.classList.remove('selected');
                const btn = card.querySelector('.card-select-btn');
                if (btn) btn.classList.remove('selected');
            });
            updateStorageUI();
        },
    });

    window.FeatureCart.onChange(updateStorageUI);

    attachCardSelect(grid);
    attachCardSelect(updateScrollRow);
    attachCardSelect(featuredWeekGrid);
    populateCapacityOptions();
    syncStoragePickerFromState();
    updateStorageUI();
    loadGames();
})();
