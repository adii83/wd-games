// Shared cart/storage-picker state for the gallery + detail pages. Shared
// BETWEEN index.html and game.html so a selection made on either page is
// reflected on both, surviving full page navigation between them.

(function (window) {
    'use strict';

    const STORAGE_KEY = 'wdgames_feature_cart';

    // Capacities, defaults, and the Flashdisk -> PS2-only category lock per
    // storage type.
    const STORAGE_PRESETS = {
        hdd: {
            label: 'HDD',
            lockCategory: null,
            defaultCapacity: 455,
            capacities: [
                { label: '320 GB', value: 288 },
                { label: '500 GB', value: 455 },
                { label: '1 TB', value: 920 },
            ],
        },
        flashdisk: {
            label: 'Flashdisk',
            lockCategory: 'ps2',
            defaultCapacity: 58,
            capacities: [
                { label: '32 GB', value: 29 },
                { label: '64 GB', value: 58 },
                { label: '128 GB', value: 116 },
            ],
        },
        ssd: {
            label: 'SSD',
            lockCategory: null,
            defaultCapacity: 476,
            capacities: [
                { label: '256 GB', value: 238 },
                { label: '512 GB', value: 476 },
                { label: '1 TB', value: 953 },
            ],
        },
    };

    const DEFAULT_STATE = {
        storageType: 'hdd',
        capacityGB: 455,
        selected: [],
    };

    // Same "estimated size" buffer as the main site (size_config.json,
    // admin-editable) — set once at page load via setSizeBufferMultiplier().
    let sizeBufferMultiplier = 1.05;

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
        STORAGE_PRESETS,

        getSizeBufferMultiplier() {
            return sizeBufferMultiplier;
        },

        setSizeBufferMultiplier(multiplier) {
            if (Number.isFinite(multiplier) && multiplier > 0) sizeBufferMultiplier = multiplier;
        },

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

        // Flashdisk only ever carries PS2 games (that's the whole point of
        // the Flashdisk option on this site) — a PC title can't be added
        // while it's the active storage type. Category is optional so
        // existing callers that don't pass one (nothing to enforce against)
        // keep working; every selection entry point should pass it.
        canAdd(category) {
            return !(state.storageType === 'flashdisk' && category && category !== 'ps2');
        },

        toggle(title, category) {
            const idx = state.selected.indexOf(title);
            if (idx >= 0) {
                state.selected.splice(idx, 1);
                persist();
                return false;
            }
            if (!this.canAdd(category)) return false;
            state.selected.push(title);
            persist();
            return true;
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
