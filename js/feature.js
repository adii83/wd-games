(function () {
    'use strict';

    // Standalone script for feature/index.html — deliberately does not import
    // or share state with js/app.js. Uses js/feature-cart.js (loaded before
    // this file) for the independent storage-picker + selection state.
    //
    // Selecting a game happens on its detail page (feature/game.html), not
    // here — cards on this page are pure navigation, like a real Steam store
    // front page. This page just discovers/browses and reflects cart state.

    const ITEMS_PER_PAGE = 24;
    const SKELETON_COUNT = 12;
    const HERO_SLIDE_COUNT = 5;
    const QUICK_LIST_COUNT = 6;
    const HERO_ROTATE_MS = 6000;

    const grid = document.getElementById('gallery-grid');
    const loadMoreBtn = document.getElementById('gallery-load-more');
    const searchInput = document.getElementById('gallery-search');
    const catalogTitle = document.getElementById('catalog-title');

    const discoverTop = document.getElementById('discover-top');
    const heroSlidesEl = document.getElementById('hero-slides');
    const heroDotsEl = document.getElementById('hero-dots');
    const heroPrevBtn = document.getElementById('hero-prev');
    const heroNextBtn = document.getElementById('hero-next');
    const quickListItemsEl = document.getElementById('quick-list-items');

    const spotlightSection = document.getElementById('spotlight-section');
    const spotlightScroll = document.getElementById('spotlight-scroll');

    const storageTypeSelect = document.getElementById('storage-type-select');
    const storageCapacitySelect = document.getElementById('storage-capacity-select');
    const storageUsedText = document.getElementById('storage-used-text');
    const storageTotalText = document.getElementById('storage-total-text');
    const storageProgressFill = document.getElementById('storage-progress-fill');

    let allGames = [];
    let filteredGames = [];
    let currentPage = 1;
    let gameplayData = {};
    let heroTimer = null;
    let heroIndex = 0;

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
        return `game.html?t=${encodeURIComponent(game.title)}`;
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

    async function loadGames() {
        renderSkeleton();
        try {
            const [gamesRes, gameplayRes] = await Promise.all([
                fetch('../steamrip_games_updated.json'),
                fetch('../steamrip_games_gameplay.json').catch(() => null),
            ]);
            if (!gamesRes.ok) throw new Error('Gagal memuat data game');
            const data = await gamesRes.json();
            gameplayData = gameplayRes && gameplayRes.ok ? await gameplayRes.json() : {};

            allGames = Array.isArray(data) ? data : [];
            filteredGames = allGames;

            renderDiscoverSections();
            renderGrid(true);
        } catch (err) {
            grid.innerHTML = `<div class="gallery-empty">Gagal memuat data game. Coba refresh halaman.</div>`;
            console.error(err);
        }
    }

    // --- Hero carousel + quick list + spotlight row ---

    function renderDiscoverSections() {
        const withGameplay = allGames.filter((g) => gameplayData[g.title]);
        if (withGameplay.length === 0) return;

        const heroGames = withGameplay
            .filter((g) => Array.isArray(gameplayData[g.title].screenshots) && gameplayData[g.title].screenshots.length)
            .slice(0, HERO_SLIDE_COUNT);
        if (heroGames.length) {
            renderHero(heroGames);
            discoverTop.style.display = '';
        }

        const quickGames = withGameplay.slice(HERO_SLIDE_COUNT, HERO_SLIDE_COUNT + QUICK_LIST_COUNT);
        if (quickGames.length) renderQuickList(quickGames);

        const trailerGames = withGameplay.filter((g) => gameplayData[g.title].trailer_hls);
        if (trailerGames.length) {
            renderSpotlight(trailerGames.slice(0, 20));
            spotlightSection.style.display = '';
        }
    }

    function renderHero(games) {
        heroSlidesEl.innerHTML = games.map((game) => {
            const gp = gameplayData[game.title];
            const bg = (gp.screenshots && gp.screenshots[0]) || game.banner_url;
            return `
                <a class="hero-slide" href="${gameHref(game)}" style="background-image: url('${bg}')">
                    <div class="hero-slide-overlay">
                        <div class="hero-slide-tags">${(gp.genres || []).slice(0, 3).map((t) => `<span>${t}</span>`).join('')}</div>
                        <h2 class="hero-slide-title">${game.title}</h2>
                        <span class="hero-slide-cta">Lihat Detail &rarr;</span>
                    </div>
                </a>
            `;
        }).join('');

        heroDotsEl.innerHTML = games.map((_, i) => `
            <button class="hero-dot" data-idx="${i}" aria-label="Slide ${i + 1}"><span class="hero-dot-fill"></span></button>
        `).join('');

        const slideEls = heroSlidesEl.querySelectorAll('.hero-slide');

        function goTo(idx) {
            heroIndex = (idx + games.length) % games.length;
            heroSlidesEl.style.transform = `translateX(-${heroIndex * 100}%)`;
            heroDotsEl.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === heroIndex));
            slideEls.forEach((s, i) => s.classList.toggle('active', i === heroIndex));
        }

        heroDotsEl.querySelectorAll('.hero-dot').forEach((dot) => {
            dot.addEventListener('click', () => {
                goTo(Number(dot.getAttribute('data-idx')));
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

    function renderQuickList(games) {
        quickListItemsEl.innerHTML = games.map((game) => {
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            return `
                <a class="quick-list-item" href="${gameHref(game)}">
                    <img src="${game.banner_url || '../assets/logo.png'}" alt="" loading="lazy">
                    <div class="quick-list-item-info">
                        <div class="quick-list-item-title">${game.title}</div>
                        <div class="quick-list-item-size">${formatSizeGB(parseSizeToGB(sizeStr))}</div>
                    </div>
                </a>
            `;
        }).join('');
    }

    function renderSpotlight(games) {
        spotlightScroll.innerHTML = games.map((game) => {
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            const gp = gameplayData[game.title];
            return `
                <a class="spotlight-card" href="${gameHref(game)}" data-trailer-hls="${gp.trailer_hls}">
                    <div class="spotlight-card-img-wrap">
                        <img src="${game.banner_url || '../assets/logo.png'}" alt="${game.title}" loading="lazy">
                        <span class="gallery-play-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
                    </div>
                    <div class="spotlight-card-title">${game.title}</div>
                    <div class="spotlight-card-size">${formatSizeGB(parseSizeToGB(sizeStr))}</div>
                </a>
            `;
        }).join('');
        attachSpotlightVideoPreview(spotlightScroll);
    }

    // Hover preview for spotlight cards: muted autoplay of the real trailer,
    // fading in over the static thumbnail. At most one video instance exists
    // at a time (destroyed on mouseleave), so this stays cheap regardless of
    // how many cards are in the row.
    function attachSpotlightVideoPreview(container) {
        let activeCard = null;
        let activeVideo = null;
        let activeHls = null;

        function cleanup() {
            if (activeHls) { activeHls.destroy(); activeHls = null; }
            if (activeVideo) { activeVideo.remove(); activeVideo = null; }
            if (activeCard) { activeCard.classList.remove('video-active'); activeCard = null; }
        }

        container.addEventListener('mouseover', (e) => {
            const card = e.target.closest('.spotlight-card[data-trailer-hls]');
            if (!card || card === activeCard || !window.Hls) return;
            cleanup();
            activeCard = card;

            const wrap = card.querySelector('.spotlight-card-img-wrap');
            const video = document.createElement('video');
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.className = 'spotlight-preview-video';
            wrap.appendChild(video);

            const src = card.getAttribute('data-trailer-hls');
            if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = src;
            } else if (window.Hls.isSupported()) {
                activeHls = new window.Hls();
                activeHls.loadSource(src);
                activeHls.attachMedia(video);
            }
            video.addEventListener('loadeddata', () => card.classList.add('video-active'), { once: true });
            video.play().catch(() => {});
            activeVideo = video;
        });

        container.addEventListener('mouseout', (e) => {
            const card = e.target.closest('.spotlight-card');
            if (!card || card !== activeCard || card.contains(e.relatedTarget)) return;
            cleanup();
        });
    }

    // --- Sustained-hover preview swap (grid + spotlight cards) ---
    // Event-delegated (one listener per container, not per card) so it stays
    // cheap even with dozens of cards on screen.

    function attachHoverPreview(container) {
        let hoverTimer = null;

        container.addEventListener('mouseover', (e) => {
            const card = e.target.closest('[data-hover-preview]');
            if (!card || card.classList.contains('previewing')) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                const img = card.querySelector('img');
                if (!img) return;
                img.dataset.originalSrc = img.dataset.originalSrc || img.src;
                card.classList.add('previewing');
                img.style.opacity = '0';
                setTimeout(() => {
                    img.src = card.getAttribute('data-hover-preview');
                    img.style.opacity = '1';
                }, 150);
            }, 600);
        });

        container.addEventListener('mouseout', (e) => {
            const card = e.target.closest('[data-hover-preview]');
            if (!card || card.contains(e.relatedTarget)) return;
            clearTimeout(hoverTimer);
            if (!card.classList.contains('previewing')) return;
            const img = card.querySelector('img');
            card.classList.remove('previewing');
            if (img && img.dataset.originalSrc) {
                img.style.opacity = '0';
                setTimeout(() => {
                    img.src = img.dataset.originalSrc;
                    img.style.opacity = '1';
                }, 150);
            }
        });
    }

    // --- Main searchable grid ---

    function applySearch() {
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const q = searchInput.value.trim().toLowerCase();

        const apply = () => {
            filteredGames = q
                ? allGames.filter((g) => (g.title || '').toLowerCase().includes(q))
                : allGames;
            catalogTitle.textContent = q ? `Hasil untuk "${searchInput.value.trim()}"` : 'Semua Game';
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
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            const sizeLabel = formatSizeGB(parseSizeToGB(sizeStr));
            const gp = gameplayData[game.title];
            const hasTrailer = Boolean(gp && gp.trailer_hls);
            const isSelected = window.FeatureCart.isSelected(game.title);
            const secondShot = gp && Array.isArray(gp.screenshots) ? gp.screenshots[1] : null;
            const tags = gp && Array.isArray(gp.genres) ? gp.genres.slice(0, 2) : [];

            const card = document.createElement('a');
            card.className = 'gallery-card' + (isSelected ? ' selected' : '');
            card.href = gameHref(game);
            card.setAttribute('data-title', game.title);
            card.style.setProperty('--i', Math.min(chunkIdx, 14));
            if (secondShot) card.setAttribute('data-hover-preview', secondShot);

            card.innerHTML = `
                <div class="gallery-card-img-wrap">
                    <img class="gallery-card-img" src="${game.banner_url || '../assets/logo.png'}" alt="${game.title}" loading="lazy" decoding="async">
                    ${hasTrailer ? `<span class="gallery-play-badge" title="Ada gameplay">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </span>` : ''}
                    ${isSelected ? `<span class="gallery-selected-badge" title="Sudah dipilih">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </span>` : ''}
                    ${tags.length ? `<div class="gallery-card-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>` : ''}
                </div>
                <div class="gallery-card-footer">
                    <div class="gallery-card-title">${game.title} · ${sizeLabel}</div>
                </div>
            `;

            fragment.appendChild(card);
        });

        grid.appendChild(fragment);
        loadMoreBtn.style.display = endIndex >= filteredGames.length ? 'none' : 'inline-block';
    }

    loadMoreBtn.addEventListener('click', () => {
        currentPage++;
        renderGrid(false);
    });

    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(applySearch, 200);
    });

    // --- Storage picker + space indicator ---

    function populateCapacityOptions() {
        storageCapacitySelect.innerHTML = window.FeatureCart.CAPACITY_TIERS
            .map((t) => `<option value="${t.value}">${t.label}</option>`)
            .join('');
    }

    function syncStoragePickerFromState() {
        const state = window.FeatureCart.getState();
        storageTypeSelect.value = state.storageType;
        storageCapacitySelect.value = String(state.capacityGB);
    }

    function updateStorageUI() {
        const state = window.FeatureCart.getState();
        const usedGB = state.selected.reduce((sum, title) => {
            const game = allGames.find((g) => g.title === title);
            if (!game) return sum;
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            return sum + parseSizeToGB(sizeStr);
        }, 0);

        const pct = state.capacityGB > 0 ? (usedGB / state.capacityGB) * 100 : 0;
        storageUsedText.textContent = formatSizeGB(usedGB);
        storageTotalText.textContent = formatSizeGB(state.capacityGB);
        storageProgressFill.style.width = `${Math.min(100, pct)}%`;
        applyStorageThreshold(pct);
    }

    function applyStorageThreshold(pct) {
        storageProgressFill.classList.remove('threshold-warn', 'threshold-danger');
        if (pct > 100) storageProgressFill.classList.add('threshold-danger');
        else if (pct >= 75) storageProgressFill.classList.add('threshold-warn');
    }

    storageTypeSelect.addEventListener('change', () => {
        window.FeatureCart.setStorage(storageTypeSelect.value, Number(storageCapacitySelect.value));
        updateStorageUI();
    });
    storageCapacitySelect.addEventListener('change', () => {
        window.FeatureCart.setStorage(storageTypeSelect.value, Number(storageCapacitySelect.value));
        updateStorageUI();
    });

    // --- Floating cart widget (shared controller in js/feature-cart-widget.js) ---

    window.FeatureCartWidget.init({
        findGame: (title) => allGames.find((g) => g.title === title),
        onRemove: (title) => {
            const card = grid.querySelector(`.gallery-card[data-title="${CSS.escape(title)}"]`);
            if (card) card.classList.remove('selected');
            updateStorageUI();
        },
    });

    window.FeatureCart.onChange(updateStorageUI);

    attachHoverPreview(grid);
    populateCapacityOptions();
    syncStoragePickerFromState();
    updateStorageUI();
    loadGames();
})();
