// Shared cart/storage-picker state for the /feature gallery + detail pages.
// Deliberately independent from index.html/js/app.js (separate localStorage
// key, never read by the main site) — but shared BETWEEN feature/index.html
// and feature/game.html so a selection made on either page is reflected on
// both, surviving full page navigation between them.

(function (window) {
    'use strict';

    const STORAGE_KEY = 'wdgames_feature_cart';

    const CAPACITY_TIERS = [
        { label: '320 GB', value: 288 },
        { label: '500 GB', value: 455 },
        { label: '1 TB', value: 920 },
    ];

    const DEFAULT_STATE = {
        storageType: 'hdd',
        capacityGB: 455,
        selected: [],
    };

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULT_STATE };
            const parsed = JSON.parse(raw);
            return {
                storageType: parsed.storageType || DEFAULT_STATE.storageType,
                capacityGB: Number.isFinite(parsed.capacityGB) ? parsed.capacityGB : DEFAULT_STATE.capacityGB,
                selected: Array.isArray(parsed.selected) ? parsed.selected : [],
            };
        } catch (e) {
            return { ...DEFAULT_STATE };
        }
    }

    let state = load();
    const listeners = new Set();

    function persist() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        listeners.forEach((cb) => cb(state));
    }

    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
            state = load();
            listeners.forEach((cb) => cb(state));
        }
    });

    window.FeatureCart = {
        CAPACITY_TIERS,

        getState() {
            return { ...state, selected: [...state.selected] };
        },

        setStorage(storageType, capacityGB) {
            state.storageType = storageType;
            state.capacityGB = capacityGB;
            persist();
        },

        isSelected(title) {
            return state.selected.includes(title);
        },

        toggle(title) {
            const idx = state.selected.indexOf(title);
            if (idx >= 0) {
                state.selected.splice(idx, 1);
            } else {
                state.selected.push(title);
            }
            persist();
            return state.selected.includes(title);
        },

        remove(title) {
            const idx = state.selected.indexOf(title);
            if (idx >= 0) {
                state.selected.splice(idx, 1);
                persist();
            }
        },

        getSelectedTitles() {
            return [...state.selected];
        },

        onChange(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },
    };
})(window);
