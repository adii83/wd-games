// Shared custom-dropdown controller for index.html + game.html header
// selects (Kategori / HDD / Size). Native <select> elements can't have
// a backdrop-blur applied behind their open option list — the OS/browser
// renders that list outside the page's DOM/CSS reach — so these are plain
// button + panel combos instead, all sharing one full-page blur backdrop
// (same visual treatment as the "Game Terpilih" cart panel's backdrop).

(function (window) {
    'use strict';

    const backdrop = document.getElementById('filter-dropdown-backdrop');
    let openInstance = null;

    function closeAll() {
        if (!openInstance) return;
        openInstance.root.classList.remove('open');
        openInstance.panel.classList.remove('open');
        openInstance.btn.setAttribute('aria-expanded', 'false');
        if (backdrop) backdrop.classList.remove('open');
        openInstance = null;
    }

    function open(instance) {
        if (openInstance === instance) return;
        closeAll();
        instance.root.classList.add('open');
        instance.panel.classList.add('open');
        instance.btn.setAttribute('aria-expanded', 'true');
        if (backdrop) backdrop.classList.add('open');
        openInstance = instance;
    }

    document.addEventListener('click', (e) => {
        if (openInstance && !openInstance.root.contains(e.target)) closeAll();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAll();
    });
    if (backdrop) backdrop.addEventListener('click', closeAll);

    window.FilterDropdown = {
        // root: the .filter-dropdown wrapper element, containing a
        // [data-dropdown-toggle] button, a [data-dropdown-label] span inside
        // it, and a [data-dropdown-panel] options container.
        create(root) {
            const btn = root.querySelector('[data-dropdown-toggle]');
            const label = root.querySelector('[data-dropdown-label]');
            const panel = root.querySelector('[data-dropdown-panel]');
            const instance = { root, btn, panel };

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (openInstance === instance) closeAll();
                else open(instance);
            });

            return {
                close() {
                    if (openInstance === instance) closeAll();
                },
                setLabel(text) {
                    if (label) label.textContent = text;
                },
            };
        },
    };
})(window);
