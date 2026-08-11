(function () {
    'use strict';

    // Standalone script for game.html. Uses js/feature-cart.js (loaded
    // before this file) for the shared storage-picker + selection state.

    const mainEl = document.getElementById('game-main');
    const template = document.getElementById('game-detail-template');

    const STORAGE_TYPE_LABELS = { hdd: 'HDD', ssd: 'SSD', flashdisk: 'Flashdisk' };

    const storageTypeDropdownPanel = document.querySelector('#storage-type-dropdown [data-dropdown-panel]');
    const storageCapacityDropdownPanel = document.getElementById('storage-capacity-dropdown-panel');
    const storageUsedText = document.getElementById('storage-used-text');
    const storageTotalText = document.getElementById('storage-total-text');
    const storageRemainingText = document.getElementById('storage-remaining-text');
    const storageProgressFill = document.getElementById('storage-progress-fill');

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
    let currentGame = null;
    let hlsInstance = null;

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

    // Buffered size: raw size times the admin-configured size_config.json
    // buffer.
    function estimatedSizeGB(rawSize) {
        return parseSizeToGB(rawSize) * window.FeatureCart.getSizeBufferMultiplier();
    }

    // steamrip_games_gameplay.json used to be fetched whole (23MB) just to
    // read one game's entry out of it. split_gameplay_data.py splits it into
    // one small file per title under gameplay/<hash>.json, hashed with
    // FNV-1a 32-bit over the title's UTF-8 bytes — this must match the
    // Python script's hash exactly (see js/feature.js for the same helper).
    function fnv1aHash(str) {
        const bytes = new TextEncoder().encode(str);
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }

    async function fetchGameplayEntry(game) {
        // steamrip_games_gameplay.json (the source split() runs against) is
        // Steam/PC-only — PS2 titles never have an entry, so skip the
        // request entirely instead of guaranteeing a 404 on every PS2
        // detail-page view.
        if (!game || game._category === 'ps2') return null;
        try {
            const res = await fetch(`gameplay/${fnv1aHash(game.title)}.json`);
            return res.ok ? await res.json() : null;
        } catch {
            return null;
        }
    }

    // Strips trailing version/build noise like "(Build 1491.50)",
    // "(v0.4.3f3 + Online)" from a title for display only — lookups still
    // use the raw title from the query string / catalog JSON.
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

    function renderNotFound() {
        mainEl.innerHTML = `
            <div class="gallery-empty">
                Game tidak ditemukan.<br />
                <a href="index.html" class="detail-cta" style="margin-top: 16px; display: inline-block;">Kembali ke Galeri</a>
            </div>
        `;
    }

    async function loadGame() {
        const params = new URLSearchParams(window.location.search);
        const wantedTitle = params.get('t');
        // gameHref() in js/feature.js only ever appends &c=ps2 for PS2 titles
        // and omits c= entirely for PC ones, so absence of the param means
        // "pc" — matches the old array-search fallback, which always found
        // the PC entry first for a category-less link.
        const wantedCategory = params.get('c') || 'pc';
        if (!wantedTitle) return renderNotFound();

        let base;
        try {
            // Lite listings (title/banner_url/Genre/Game Size only) power
            // the floating cart widget's lookup for OTHER selected games —
            // it needs to show/size every item in the cart, not just the
            // one game this page is displaying. The current game's own
            // full detail (system_requirements etc.) comes from its own
            // small catalog/<hash>.json, fetched alongside it, instead of
            // searching either full 3MB+/1.6MB+ catalog for one entry.
            const [liteRes, ps2LiteRes, catalogRes, sizeConfigRes] = await Promise.all([
                fetch('steamrip_games_updated.lite.json'),
                fetch('ps2.lite.json').catch(() => null),
                fetch(`catalog/${fnv1aHash(`${wantedCategory}:${wantedTitle}`)}.json`),
                fetch('size_config.json').catch(() => null),
            ]);
            if (!liteRes.ok) throw new Error('Gagal memuat data game');
            const liteData = await liteRes.json();
            const ps2LiteData = ps2LiteRes && ps2LiteRes.ok ? await ps2LiteRes.json() : [];
            const pcGames = (Array.isArray(liteData) ? liteData : []).map((g) => ({ ...g, _category: 'pc' }));
            const ps2Games = (Array.isArray(ps2LiteData) ? ps2LiteData : []).map((g) => ({ ...g, _category: 'ps2' }));
            allGames = [...pcGames, ...ps2Games];

            if (!catalogRes.ok) return renderNotFound();
            base = await catalogRes.json();
            base._category = wantedCategory;

            if (sizeConfigRes && sizeConfigRes.ok) {
                const sizeConfig = await sizeConfigRes.json();
                const pct = Number(sizeConfig && sizeConfig.size_buffer_percentage);
                if (Number.isFinite(pct)) window.FeatureCart.setSizeBufferMultiplier(1 + Math.min(100, Math.max(0, pct)) / 100);
            }
        } catch (err) {
            console.error(err);
            return renderNotFound();
        }

        const gp = await fetchGameplayEntry(base);
        const game = { ...base, ...(gp || {}) };
        renderGame(game);
    }

    function renderGame(game) {
        currentGame = game;
        document.title = `${cleanDisplayTitle(game.title)} - WD Games`;

        const frag = template.content.cloneNode(true);
        mainEl.innerHTML = '';
        mainEl.appendChild(frag);

        setupCarousel(game);
        setupHeader(game);
        setupAbout(game);
        setupRequirements(game);
        setupOrderCard(game);
        setupStoragePicker();
    }

    // --- Carousel ---

    function setupCarousel(game) {
        const items = [];
        if (game.trailer_hls) {
            items.push({
                type: 'video',
                hls: game.trailer_hls,
                thumb: game.trailer_thumb || game.banner_url,
                label: 'Trailer',
            });
        }
        (Array.isArray(game.screenshots) ? game.screenshots : []).forEach((src, idx) => {
            items.push({ type: 'image', src, label: `Screenshot ${idx + 1}` });
        });
        if (items.length === 0) {
            items.push({ type: 'image', src: game.banner_url || 'assets/logo.png', label: game.title });
        }

        const mainImg = document.getElementById('carousel-main-img');
        const mainVideo = document.getElementById('carousel-main-video');
        const playBtn = document.getElementById('carousel-play-btn');
        const mainWrap = document.getElementById('carousel-main');
        const thumbsEl = document.getElementById('carousel-thumbs');
        const prevBtn = document.getElementById('carousel-prev');
        const nextBtn = document.getElementById('carousel-next');

        let currentIndex = 0;

        function stopVideo() {
            if (hlsInstance) {
                hlsInstance.destroy();
                hlsInstance = null;
            }
            mainVideo.pause();
            mainVideo.removeAttribute('src');
            mainVideo.load();
            mainWrap.classList.remove('playing');
        }

        function showItem(idx) {
            currentIndex = (idx + items.length) % items.length;
            const item = items[currentIndex];

            stopVideo();
            mainWrap.classList.toggle('has-video', item.type === 'video');

            mainImg.src = item.type === 'video' ? (item.thumb || 'assets/logo.png') : item.src;
            mainImg.alt = item.label || game.title;

            thumbsEl.querySelectorAll('.carousel-thumb').forEach((el, i) => {
                el.classList.toggle('active', i === currentIndex);
            });
            const activeThumb = thumbsEl.querySelector(`.carousel-thumb[data-idx="${currentIndex}"]`);
            if (activeThumb) activeThumb.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }

        function playCurrentVideo() {
            const item = items[currentIndex];
            if (item.type !== 'video') return;

            mainWrap.classList.add('playing');
            // Browser autoplay policies only allow starting playback without
            // a click if the video is muted — native controls still let the
            // visitor unmute once it's running.
            mainVideo.muted = true;
            if (mainVideo.canPlayType('application/vnd.apple.mpegurl')) {
                mainVideo.src = item.hls;
            } else if (window.Hls && window.Hls.isSupported()) {
                hlsInstance = new window.Hls();
                hlsInstance.loadSource(item.hls);
                hlsInstance.attachMedia(mainVideo);
            } else {
                mainVideo.src = item.hls;
            }
            mainVideo.play().catch(() => {});
        }

        playBtn.addEventListener('click', playCurrentVideo);

        prevBtn.addEventListener('click', () => showItem(currentIndex - 1));
        nextBtn.addEventListener('click', () => showItem(currentIndex + 1));
        prevBtn.style.display = items.length > 1 ? '' : 'none';
        nextBtn.style.display = items.length > 1 ? '' : 'none';

        thumbsEl.innerHTML = '';
        if (items.length > 1) {
            items.forEach((item, idx) => {
                const thumb = document.createElement('div');
                thumb.className = 'carousel-thumb';
                thumb.setAttribute('data-idx', idx);
                thumb.innerHTML = `
                    <img src="${item.type === 'video' ? (item.thumb || 'assets/logo.png') : item.src}" alt="${item.label}" loading="lazy">
                    ${item.type === 'video' ? '<span class="carousel-thumb-play"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>' : ''}
                `;
                thumb.addEventListener('click', () => showItem(idx));
                thumbsEl.appendChild(thumb);
            });
        }

        showItem(0);
        // Trailer starts playing as soon as the game page loads — no need
        // to press play first if the game already has gameplay video.
        if (items[0].type === 'video') playCurrentVideo();
    }

    // --- Title, tags, meta box ---

    function setupHeader(game) {
        document.getElementById('game-title').textContent = cleanDisplayTitle(game.title);

        const tags = Array.isArray(game.genres) && game.genres.length
            ? game.genres
            : (game.game_info && game.game_info.Genre ? game.game_info.Genre.split(',').map((s) => s.trim()) : []);

        const tagsEl = document.getElementById('game-tags');
        tagsEl.innerHTML = tags.map((t) => `<span class="game-tag">${t}</span>`).join('');

        const metaRows = [];
        const developer = (Array.isArray(game.developers) && game.developers[0]) || (game.game_info && game.game_info.Developer);
        const publisher = Array.isArray(game.publishers) && game.publishers.length ? game.publishers.join(', ') : null;
        const releaseDate = game.release_date;

        if (developer) metaRows.push(['Developer', developer]);
        if (publisher) metaRows.push(['Publisher', publisher]);
        if (releaseDate) metaRows.push(['Rilis', releaseDate]);
        if (Number.isFinite(game.metacritic_score)) metaRows.push(['Metacritic', `${game.metacritic_score}/100`]);

        const metaBox = document.getElementById('game-meta-box');
        metaBox.innerHTML = metaRows.map(([label, val]) => `
            <div class="meta-row"><span class="meta-label">${label}</span><span class="meta-value">${val}</span></div>
        `).join('');
    }

    // --- About ---

    function setupAbout(game) {
        const el = document.getElementById('about-content');
        if (game.about_the_game) {
            el.innerHTML = game.about_the_game;
            // Browsers don't reliably honor the `autoplay` attribute on
            // <video> tags injected via innerHTML — kick playback manually.
            el.querySelectorAll('video').forEach((v) => {
                v.muted = true;
                v.play().catch(() => {});
            });
            return;
        }
        const genre = game.game_info && game.game_info.Genre;
        const developer = game.game_info && game.game_info.Developer;
        let fallback = game.title;
        if (genre) fallback += ` adalah game bergenre ${genre}`;
        if (developer) fallback += ` yang dikembangkan oleh ${developer}`;
        fallback += '.';
        el.innerHTML = `<p>${fallback}</p>`;
    }

    // --- Requirements ---

    function setupRequirements(game) {
        const el = document.getElementById('requirements-grid');

        if (game.requirements_minimum || game.requirements_recommended) {
            el.innerHTML = `
                ${game.requirements_minimum ? `<div class="req-col">${game.requirements_minimum}</div>` : ''}
                ${game.requirements_recommended ? `<div class="req-col">${game.requirements_recommended}</div>` : ''}
            `;
            return;
        }

        const reqEntries = game.system_requirements
            ? Object.entries(game.system_requirements).filter(([, val]) => String(val ?? '').trim() !== '')
            : [];

        if (reqEntries.length === 0) {
            el.innerHTML = `<div class="req-col"><p class="req-empty">Tidak ada data spesifikasi untuk game ini.</p></div>`;
            return;
        }

        el.innerHTML = `<div class="req-col"><ul class="req-flat-list">
            ${reqEntries.map(([key, val]) => `<li><strong>${key}:</strong> ${val}</li>`).join('')}
        </ul></div>`;
    }

    // --- Order / size card + selection ---

    function setupOrderCard(game) {
        const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
        document.getElementById('order-card-size').textContent = formatSizeGB(estimatedSizeGB(sizeStr));

        const facts = [];
        if (game.game_info) {
            ['Platform', 'Version', 'Released By', 'Pre-Installed Game'].forEach((key) => {
                if (game.game_info[key] === undefined || game.game_info[key] === null || game.game_info[key] === '') return;
                const val = typeof game.game_info[key] === 'boolean' ? (game.game_info[key] ? 'Ya' : 'Tidak') : game.game_info[key];
                facts.push([key, val]);
            });
        }
        if (facts.length) {
            const factsEl = document.createElement('div');
            factsEl.className = 'order-card-facts';
            factsEl.innerHTML = facts.map(([k, v]) => `<div class="meta-row"><span class="meta-label">${k}</span><span class="meta-value">${v}</span></div>`).join('');
            document.querySelector('.order-card').insertBefore(factsEl, document.getElementById('select-game-btn'));
        }

        // Two buttons share this game's selection state: the sidebar one
        // (sticky on desktop, so always in view there) and a mobile-only
        // copy near the top, since the sidebar stacks to the bottom of the
        // page on mobile instead of staying sticky.
        const selectBtns = [document.getElementById('select-game-btn'), document.getElementById('select-game-btn-top')].filter(Boolean);
        function syncSelectBtns() {
            const selected = window.FeatureCart.isSelected(game.title);
            selectBtns.forEach((btn) => {
                btn.classList.toggle('selected', selected);
                btn.textContent = selected ? 'Game Terpilih ✓' : 'Pilih Game Ini';
            });
        }
        selectBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!window.FeatureCart.isSelected(game.title) && !window.FeatureCart.canAdd(game._category)) {
                    window.FeatureCartWidget.showToast('Flashdisk cuma untuk game PS2 — ganti media penyimpanan dulu untuk pilih game PC.', 'error');
                    return;
                }
                const nowSelected = window.FeatureCart.toggle(game.title, game._category);
                syncSelectBtns();
                if (nowSelected) window.FeatureCartWidget.flyToCart(btn);
            });
        });
        syncSelectBtns();
    }

    // --- Storage picker (shared with index.html) ---

    function currentStoragePreset() {
        const state = window.FeatureCart.getState();
        return window.FeatureCart.STORAGE_PRESETS[state.storageType] || window.FeatureCart.STORAGE_PRESETS.hdd;
    }

    function capacityLabelFor(capacityGB) {
        const tier = currentStoragePreset().capacities.find((t) => t.value === capacityGB);
        return tier ? tier.label : formatSizeGB(capacityGB);
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
        });
    }

    function updateStorageUI() {
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

        const usedGB = state.selected.reduce((sum, title) => {
            const game = allGames.find((g) => g.title === title);
            if (!game) return sum;
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            return sum + estimatedSizeGB(sizeStr);
        }, 0);

        storageUsedText.textContent = formatSizeGB(usedGB);
        storageTotalText.textContent = formatSizeGB(state.capacityGB);
        const availableGB = Math.max(0, state.capacityGB - usedGB);
        storageRemainingText.textContent = formatSizeGB(availableGB);
        const pct = state.capacityGB > 0 ? (usedGB / state.capacityGB) * 100 : 0;
        storageProgressFill.style.width = `${Math.min(100, pct)}%`;
        storageProgressFill.classList.remove('threshold-warn', 'threshold-danger');
        storageRemainingText.classList.remove('threshold-warn', 'threshold-danger', 'text-accent');
        if (pct > 100) {
            storageProgressFill.classList.add('threshold-danger');
            storageRemainingText.classList.add('threshold-danger');
        } else if (pct >= 75) {
            storageProgressFill.classList.add('threshold-warn');
            storageRemainingText.classList.add('threshold-warn');
        } else {
            storageRemainingText.classList.add('text-accent');
        }
    }

    function setupStoragePicker() {
        populateCapacityOptions();
        updateStorageUI();

        wireDropdownItems(storageTypeDropdownPanel, storageTypeDropdown, (value) => {
            const preset = window.FeatureCart.STORAGE_PRESETS[value];
            if (!preset) return;
            // Changing storage type always resets capacity to that type's
            // default and repopulates its tier list.
            window.FeatureCart.setStorage(value, preset.defaultCapacity);
            populateCapacityOptions();

            // Flashdisk is PS2-only — drop any already-selected PC games
            // instead of letting them silently ride along in the cart.
            if (preset.lockCategory === 'ps2') {
                const state = window.FeatureCart.getState();
                const removed = state.selected.filter((title) => {
                    const g = allGames.find((game) => game.title === title);
                    return g && !window.FeatureCart.canAdd(g._category);
                });
                removed.forEach((title) => window.FeatureCart.remove(title));
                if (removed.length) {
                    window.FeatureCartWidget.showToast(
                        `${removed.length} game PC dihapus dari daftar — Flashdisk cuma untuk game PS2.`,
                        'error'
                    );
                }
            }
        });
        window.FeatureCart.onChange(() => {
            updateStorageUI();
            if (!currentGame) return;
            const selected = window.FeatureCart.isSelected(currentGame.title);
            [document.getElementById('select-game-btn'), document.getElementById('select-game-btn-top')].forEach((btn) => {
                if (!btn) return;
                btn.classList.toggle('selected', selected);
                btn.textContent = selected ? 'Game Terpilih ✓' : 'Pilih Game Ini';
            });
        });

        window.FeatureCartWidget.init({
            findGame: (title) => allGames.find((g) => g.title === title),
            onRemove: () => updateStorageUI(),
        });
    }

    loadGame();
})();
