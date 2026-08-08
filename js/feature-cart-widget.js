// Shared floating cart-widget UI controller for feature/index.html AND
// feature/game.html — both pages render the identical #feature-cart-widget
// markup, so the render/open/close/backdrop/fly-to-cart logic lives here
// once instead of being duplicated in feature.js and feature-detail.js.

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

    let findGame = () => null;
    let onRemove = () => {};

    const widget = document.getElementById('feature-cart-widget');
    const btn = document.getElementById('feature-cart-btn');
    const countEl = document.getElementById('feature-cart-count');
    const panel = document.getElementById('feature-cart-panel');
    const closeBtn = document.getElementById('feature-cart-close');
    const listEl = document.getElementById('feature-cart-list');
    const backdrop = document.getElementById('feature-cart-backdrop');

    function prefersReducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function render() {
        if (!widget) return;
        const state = window.FeatureCart.getState();
        countEl.textContent = String(state.selected.length);

        if (state.selected.length === 0) {
            listEl.innerHTML = `<div class="assistive-empty">Belum ada game dipilih. Buka detail game lalu tekan "Pilih Game Ini".</div>`;
            return;
        }
        listEl.innerHTML = state.selected.map((title) => {
            const game = findGame(title);
            const sizeStr = game && game.game_info ? game.game_info['Game Size'] : null;
            const sizeLabel = formatSizeGB(parseSizeToGB(sizeStr));
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

    window.FeatureCartWidget = {
        init(options) {
            findGame = (options && options.findGame) || findGame;
            onRemove = (options && options.onRemove) || onRemove;

            if (btn) btn.addEventListener('click', () => {
                panel.classList.contains('open') ? closePanel() : openPanel();
            });
            if (closeBtn) closeBtn.addEventListener('click', closePanel);
            if (backdrop) backdrop.addEventListener('click', closePanel);

            window.FeatureCart.onChange(render);
            render();
        },
        render,
        flyToCart,
        closePanel,
    };
})(window);
