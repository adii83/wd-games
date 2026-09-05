// Shared floating cart-widget UI controller for index.html AND game.html —
// both pages render the identical #feature-cart-widget markup, so the
// render/open/close/backdrop/fly-to-cart logic lives here once instead of
// being duplicated in feature.js and feature-detail.js.

(function (window) {
    'use strict';

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

    let findGame = () => null;
    let onRemove = () => {};

    const widget = document.getElementById('feature-cart-widget');
    const btn = document.getElementById('feature-cart-btn');
    const countEl = document.getElementById('feature-cart-count');
    const panel = document.getElementById('feature-cart-panel');
    const closeBtn = document.getElementById('feature-cart-close');
    const listEl = document.getElementById('feature-cart-list');
    const backdrop = document.getElementById('feature-cart-backdrop');
    const copyBtn = document.getElementById('feature-cart-copy-btn');
    const usedEl = document.getElementById('feature-cart-used');
    const totalEl = document.getElementById('feature-cart-total');
    const remainingEl = document.getElementById('feature-cart-remaining');
    const progressFillEl = document.getElementById('feature-cart-progress-fill');

    // Seller's own Shopee affiliate link, one per storage type — opened
    // automatically right after a successful "Copy Teks" (see
    // handleCopyClick), matching whichever storage type the user currently
    // has selected. This is the seller's own referral link on the seller's
    // own button, so ordinary last-click affiliate attribution applies —
    // not the silent/hidden cookie-stuffing the owner explicitly ruled out.
    const SHOPEE_LINKS = {
        hdd: 'https://s.shopee.co.id/5q7GpJVBNj',
        flashdisk: 'https://s.shopee.co.id/LmKHHAMjs',
        ssd: 'https://s.shopee.co.id/1VyHfRF4lx',
    };

    function prefersReducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // Countdown overlay shown right after a successful "Copy Teks", before
    // handing off to Shopee — injected once into the DOM here rather than
    // as static markup in index.html/game.html, since it's identical on
    // both pages and has nothing page-specific to hook into.
    const REDIRECT_COUNTDOWN_SECONDS = 5;
    const redirectOverlay = document.createElement('div');
    redirectOverlay.className = 'shopee-redirect-overlay';
    redirectOverlay.innerHTML = `
        <div class="shopee-redirect-box">
            <div class="shopee-redirect-icon">&#10003;</div>
            <p class="shopee-redirect-text">Teks daftar game berhasil disalin!</p>
            <p class="shopee-redirect-sub">Anda akan dibawa ke Shopee dalam <span class="shopee-redirect-count">${REDIRECT_COUNTDOWN_SECONDS}</span>...</p>
            <button type="button" class="shopee-redirect-skip">Lanjut Sekarang</button>
        </div>
    `;
    document.body.appendChild(redirectOverlay);
    const redirectCountEl = redirectOverlay.querySelector('.shopee-redirect-count');
    const redirectSkipBtn = redirectOverlay.querySelector('.shopee-redirect-skip');

    function openShopeeRedirectCountdown(url) {
        // Same-tab redirect: nothing opens/navigates until the countdown
        // actually reaches zero (or "Lanjut Sekarang" is clicked). This
        // also sidesteps popup blockers entirely — they only ever gate
        // new-window/tab creation, never a plain navigation of the page
        // itself, so there's no activation-timing concern to work around
        // here the way there would be with window.open().
        let secondsLeft = REDIRECT_COUNTDOWN_SECONDS;
        redirectCountEl.textContent = secondsLeft;
        redirectOverlay.classList.add('open');

        function go() {
            clearInterval(timer);
            window.location.href = url;
        }

        const timer = setInterval(() => {
            secondsLeft -= 1;
            if (secondsLeft <= 0) {
                go();
                return;
            }
            redirectCountEl.textContent = secondsLeft;
        }, 1000);

        // Reassigning .onclick (not addEventListener) each call is enough
        // since there's only ever one overlay/button pair — no listener
        // pile-up to worry about across repeated copies.
        redirectSkipBtn.onclick = go;
    }

    // Mirrors the storage bar already shown on the page itself, just scoped
    // to this panel so users can see how full their pick is without closing
    // the cart to look at the header/footer bar.
    function syncStorageInfo(state) {
        if (!usedEl || !totalEl || !remainingEl || !progressFillEl) return;
        const usedGB = state.selected.reduce((sum, title) => {
            const game = findGame(title);
            const sizeStr = game && game.game_info ? game.game_info['Game Size'] : null;
            return sum + estimatedSizeGB(sizeStr);
        }, 0);
        const availableGB = Math.max(0, state.capacityGB - usedGB);
        const pct = state.capacityGB > 0 ? (usedGB / state.capacityGB) * 100 : 0;

        usedEl.textContent = formatSizeGB(usedGB);
        totalEl.textContent = formatSizeGB(state.capacityGB);
        remainingEl.textContent = formatSizeGB(availableGB);
        progressFillEl.style.width = `${Math.min(100, pct)}%`;

        progressFillEl.classList.remove('threshold-warn', 'threshold-danger');
        remainingEl.classList.remove('threshold-warn', 'threshold-danger', 'text-accent');
        if (pct > 100) {
            progressFillEl.classList.add('threshold-danger');
            remainingEl.classList.add('threshold-danger');
        } else if (pct >= 75) {
            progressFillEl.classList.add('threshold-warn');
            remainingEl.classList.add('threshold-warn');
        } else {
            remainingEl.classList.add('text-accent');
        }
    }

    function render() {
        if (!widget) return;
        const state = window.FeatureCart.getState();
        countEl.textContent = String(state.selected.length);
        syncStorageInfo(state);

        if (state.selected.length === 0) {
            listEl.innerHTML = `<div class="assistive-empty">Belum ada game dipilih. Buka detail game lalu tekan "Pilih Game Ini".</div>`;
            return;
        }
        listEl.innerHTML = state.selected.map((title) => {
            const game = findGame(title);
            const sizeStr = game && game.game_info ? game.game_info['Game Size'] : null;
            const sizeLabel = formatSizeGB(estimatedSizeGB(sizeStr));
            return `
                <div class="assistive-item" data-title="${title}">
                    <div>
                        <div style="font-weight: 700;">${title}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary);">${sizeLabel}</div>
                    </div>
                    <button class="assistive-remove-btn" data-remove="${title}" aria-label="Hapus">&times;</button>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('[data-remove]').forEach((removeBtn) => {
            removeBtn.addEventListener('click', () => {
                const title = removeBtn.getAttribute('data-remove');
                window.FeatureCart.remove(title);
                onRemove(title);
            });
        });
    }

    function openPanel() {
        panel.classList.add('open');
        if (backdrop) backdrop.classList.add('open');
    }

    function closePanel() {
        panel.classList.remove('open');
        if (backdrop) backdrop.classList.remove('open');
    }

    function pulseCount() {
        countEl.classList.remove('pop');
        // eslint-disable-next-line no-unused-expressions
        void countEl.offsetWidth; // restart animation
        countEl.classList.add('pop');
    }

    function flyToCart(fromEl) {
        if (!widget || !fromEl) return;
        if (prefersReducedMotion()) {
            pulseCount();
            return;
        }
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = btn.getBoundingClientRect();
        const startX = fromRect.left + fromRect.width / 2;
        const startY = fromRect.top + fromRect.height / 2;
        const endX = toRect.left + toRect.width / 2;
        const endY = toRect.top + toRect.height / 2;

        const flyer = document.createElement('div');
        flyer.className = 'cart-flyer';
        flyer.style.left = `${startX - 9}px`;
        flyer.style.top = `${startY - 9}px`;
        document.body.appendChild(flyer);

        requestAnimationFrame(() => {
            flyer.style.transform = `translate(${endX - startX}px, ${endY - startY}px) scale(0.25)`;
            flyer.style.opacity = '0.15';
        });

        flyer.addEventListener('transitionend', () => {
            flyer.remove();
            pulseCount();
        }, { once: true });
    }

    // --- Copy-text export: builds the plain-text order list (header line,
    // numbering, version-suffix stripping, PS2 suffix, total line,
    // empty-state message) and copies it for pasting into Shopee chat. ---

    function stripVersionSuffix(title) {
        if (!title) return '';
        let t = String(title).trim();
        const versionSuffixRe = /\s*\((?:\s*(?:v\s*\d|build\b|Build\b|B_\d|b_\d)[^)]*)\)\s*$/;
        while (versionSuffixRe.test(t)) {
            t = t.replace(versionSuffixRe, '').trim();
        }
        return t;
    }

    // Returns 'PS2'/'PS3' for titles that need a platform suffix to
    // disambiguate from an identically-named entry in another catalog, or
    // null if none is needed (PC titles, or any category not covered here).
    function platformSuffixFor(game) {
        if (!game) return null;
        if (game._category === 'ps2') return 'PS2';
        if (game._category === 'ps3') return 'PS3';
        const platform = game.game_info ? String(game.game_info.Platform || '').toUpperCase() : '';
        if (platform.includes('PS2')) return 'PS2';
        if (platform.includes('PS3')) return 'PS3';
        return null;
    }

    function addPlatformSuffixIfNeeded(title, game) {
        const t = String(title || '').trim();
        const suffix = platformSuffixFor(game);
        if (!suffix) return t;
        if (new RegExp(`\\(${suffix}\\)\\s*$`, 'i').test(t)) return t;
        return `${t} (${suffix})`;
    }

    function buildExportText() {
        const state = window.FeatureCart.getState();
        const selectedArr = state.selected.map((title) => findGame(title)).filter(Boolean);

        if (selectedArr.length === 0) {
            return `Daftar Game Pesanan\n\n(Belum ada game yang dipilih)`;
        }

        let totalSize = 0;
        const lines = ['Daftar Game Pesanan', ''];

        selectedArr.forEach((game, i) => {
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            totalSize += estimatedSizeGB(sizeStr);
            const title = game.title || 'Untitled';
            const labeled = addPlatformSuffixIfNeeded(stripVersionSuffix(title), game);
            lines.push(`${i + 1}. ${labeled}`);
        });

        lines.push('');
        lines.push(`Total Size: ${totalSize.toFixed(1)} GB`);
        return lines.join('\n');
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
        // Fallback for older browsers / non-secure context
        const temp = document.createElement('textarea');
        temp.value = text;
        temp.setAttribute('readonly', '');
        temp.style.position = 'fixed';
        temp.style.left = '-9999px';
        temp.style.top = '0';
        document.body.appendChild(temp);
        temp.select();
        temp.setSelectionRange(0, temp.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(temp);
        return ok;
    }

    function showToast(message, type, options) {
        document.querySelectorAll('.toast-notification').forEach((t) => t.remove());

        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type === 'error' ? 'error' : 'success'}`;
        const iconSvg = type === 'error'
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
            : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="16 12 12 8 8 12"></polyline><line x1="12" y1="16" x2="12" y2="8"></line></svg>`;
        toast.innerHTML = `${iconSvg}<span>${message}</span>`;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('show'), 10);
        if (options && options.shake && !prefersReducedMotion()) {
            // Runs slightly after the slide-in transition starts so the
            // shake doesn't fight the initial translateY(100px) -> 0 move.
            setTimeout(() => toast.classList.add('shake'), 200);
            toast.addEventListener('animationend', () => toast.classList.remove('shake'), { once: true });
        }
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    async function handleCopyClick() {
        const state = window.FeatureCart.getState();
        const usedGB = state.selected.reduce((sum, title) => {
            const game = findGame(title);
            if (!game) return sum;
            const sizeStr = game.game_info ? game.game_info['Game Size'] : null;
            return sum + estimatedSizeGB(sizeStr);
        }, 0);

        if (state.selected.length === 0) {
            showToast('Belum ada game yang dipilih.', 'error');
            return;
        }
        if (usedGB > state.capacityGB) {
            showToast('Kapasitas tidak memadai! Silakan kurangi game atau sesuaikan kapasitas penyimpanan.', 'error');
            return;
        }

        try {
            const ok = await copyTextToClipboard(buildExportText());
            if (!ok) throw new Error('Copy gagal');
            const shopeeUrl = SHOPEE_LINKS[state.storageType] || SHOPEE_LINKS.hdd;
            openShopeeRedirectCountdown(shopeeUrl);
        } catch (err) {
            console.error('Copy text error:', err);
            showToast('Gagal copy teks. Coba browser lain / pakai HTTPS.', 'error');
        }
    }

    window.FeatureCartWidget = {
        init(options) {
            findGame = (options && options.findGame) || findGame;
            onRemove = (options && options.onRemove) || onRemove;

            if (btn) btn.addEventListener('click', () => {
                panel.classList.contains('open') ? closePanel() : openPanel();
            });
            if (closeBtn) closeBtn.addEventListener('click', closePanel);
            if (backdrop) backdrop.addEventListener('click', closePanel);
            if (copyBtn) copyBtn.addEventListener('click', handleCopyClick);

            window.FeatureCart.onChange(render);
            render();
        },
        render,
        flyToCart,
        openPanel,
        closePanel,
        showToast,
    };
})(window);
