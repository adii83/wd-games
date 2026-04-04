document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const grid = document.getElementById('game-grid');
    const hddDropdown = document.getElementById('hdd-dropdown');
    const hddSelectedText = document.getElementById('selected-capacity-text');
    const hddItems = document.querySelectorAll('.dropdown-item');
    const storageUsedEl = document.getElementById('storage-used');
    const storageTotalEl = document.getElementById('storage-total');
    const storageRemainingEl = document.getElementById('storage-remaining');
    const progressBar = document.getElementById('progressBar');
    const progressEl = document.getElementById('progress-bar');
    const selectedCountEl = document.getElementById('selected-count');
    const modalOverlay = document.getElementById('info-modal');
    const closeModalBtn = document.getElementById('close-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalReqs = document.getElementById('modal-reqs');
    const modalInfo = document.getElementById('modal-info');
    const searchInput = document.getElementById('search-input');
    const categoryFilter = document.getElementById('category-filter');
    const exportBtn = document.getElementById('export-btn');
    const exportModal = document.getElementById('export-modal');
    const closeExportModalBtn = document.getElementById('close-export-modal');
    const exportTableBody = document.getElementById('export-table-body');
    const exportTotalSize = document.getElementById('export-total-size');
    const copyTextBtn = document.getElementById('copy-text-btn');
    const storageTypeLabelEl = document.getElementById('storage-type-label');
    const storageTypeSelect = document.getElementById('storage-type-select');
    const landingScreen = document.getElementById('landing-screen');
    const landingActions = document.getElementById('landing-storage-actions');

    // Floating Export Button behavior (move to bottom-left on scroll)
    const controlsEl = document.querySelector('.controls');
    let exportFloating = false;
    let exportBtnWrap = null;

    function computeExportWrapSize() {
        if (!exportBtn || !exportBtnWrap) return;
        const rect = exportBtn.getBoundingClientRect();
        document.documentElement.style.setProperty('--export-btn-w', `${Math.ceil(rect.width)}px`);
        document.documentElement.style.setProperty('--export-btn-h', `${Math.ceil(rect.height)}px`);
    }

    function flipAnimateExportButton(toggleBodyClass) {
        if (!exportBtn) return;
        const first = exportBtn.getBoundingClientRect();
        toggleBodyClass();
        // Force layout so the new position is applied
        // eslint-disable-next-line no-unused-expressions
        exportBtn.offsetWidth;
        const last = exportBtn.getBoundingClientRect();

        const dx = first.left - last.left;
        const dy = first.top - last.top;

        exportBtn.style.transform = `translate(${dx}px, ${dy}px)`;
        exportBtn.getBoundingClientRect();
        requestAnimationFrame(() => {
            exportBtn.style.transform = 'translate(0, 0)';
        });
    }

    function setExportFloating(shouldFloat) {
        if (!exportBtn) return;
        if (shouldFloat === exportFloating) return;

        exportFloating = shouldFloat;
        exportBtnWrap = exportBtnWrap || exportBtn.closest('.export-btn-wrap');
        computeExportWrapSize();

        flipAnimateExportButton(() => {
            document.body.classList.toggle('export-float', shouldFloat);
        });
    }

    function shouldFloatExportButton() {
        if (!controlsEl) return false;
        const rect = controlsEl.getBoundingClientRect();
        // Once the controls bar is fully above the viewport, float the export button
        return rect.bottom < 0;
    }

    function onScrollOrResize() {
        setExportFloating(shouldFloatExportButton());
    }

    if (exportBtn) {
        exportBtnWrap = exportBtn.closest('.export-btn-wrap');
        // Initial sizing + state
        computeExportWrapSize();
        onScrollOrResize();

        window.addEventListener('scroll', onScrollOrResize, { passive: true });
        window.addEventListener('resize', () => {
            computeExportWrapSize();
            onScrollOrResize();
        });
    }

    // Floating Selected Games Widget
    const selectedWidget = document.getElementById('selected-widget');
    const selectedWidgetBtn = document.getElementById('selected-widget-btn');
    const selectedWidgetPanel = document.getElementById('selected-widget-panel');
    const selectedWidgetClose = document.getElementById('selected-widget-close');
    const selectedWidgetList = document.getElementById('selected-widget-list');
    const selectedWidgetCount = document.getElementById('selected-widget-count');
    
    // State Tracker
    let gamesData = [];
    let displayedGamesData = []; // Filtered games based on search
    let selectedGames = new Set(); // Stores original indices of selected games

    // Filtering state
    let currentCategory = (categoryFilter && categoryFilter.value) ? categoryFilter.value : 'all';

    let currentStorageType = 'hdd';
    const storagePresets = {
        hdd: {
            label: 'HDD',
            category: 'pc',
            defaultCapacity: 455,
            capacities: [
                { text: '320 GB', value: 288 },
                { text: '500 GB', value: 455 },
                { text: '1 TB', value: 920 }
            ]
        },
        flashdisk: {
            label: 'FLASHDISK',
            category: 'ps2',
            defaultCapacity: 58,
            capacities: [
                { text: '32 GB', value: 29 },
                { text: '64 GB', value: 58 },
                { text: '128 GB', value: 116 }
            ]
        },
        ssd: {
            label: 'SSD',
            category: 'pc',
            defaultCapacity: 476,
            capacities: [
                { text: '256 GB', value: 238 },
                { text: '512 GB', value: 476 },
                { text: '1 TB', value: 953 }
            ]
        }
    };
    
    // Get initial value from active dropdown item
    let currentHddCapacity = parseInt(document.querySelector('.dropdown-item.active').getAttribute('data-value')); 
    let totalUsedGB = 0;
    
    // Pagination parameters (keep UI responsive on large datasets)
    function getItemsPerPage() {
        // Smaller batches on phones to keep DOM light
        if (window.matchMedia && window.matchMedia('(max-width: 480px)').matches) return 18;
        if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return 24;
        return 50;
    }

    let itemsPerPage = getItemsPerPage();
    let currentPage = 1;

    // Widget state
    let widgetOpen = false;

    // Load More Button
    const loadMoreBtn = document.getElementById('load-more-btn');

    // --- Core Logic ---

    // Fetch JSON Data
    async function loadGames() {
        try {
            const cacheBuster = new Date().getTime();
            const pcUrl = `steamrip_games.json?t=${cacheBuster}`;
            const ps2Url = `ps2.json?t=${cacheBuster}`;

            const [pcRes, ps2Res] = await Promise.all([
                fetch(pcUrl, { cache: 'no-store' }),
                fetch(ps2Url, { cache: 'no-store' })
            ]);

            if (!pcRes.ok && !ps2Res.ok) {
                throw new Error('Gagal mengambil data');
            }

            const pcGames = pcRes.ok ? await pcRes.json() : [];
            const ps2Games = ps2Res.ok ? await ps2Res.json() : [];

            // If ps2.json includes a "Popularity Rank" (from ROMSFUN popular list), sort by it.
            // Otherwise, keep the JSON file order as-is.
            function getPopularityRank(game) {
                const val = game && game.game_info ? game.game_info['Popularity Rank'] : null;
                const n = Number(val);
                return Number.isFinite(n) ? n : 0;
            }
            const hasPopularityRank = ps2Games.some(g => getPopularityRank(g) > 0);
            if (hasPopularityRank) {
                ps2Games.sort((a, b) => {
                    const ra = getPopularityRank(a);
                    const rb = getPopularityRank(b);
                    if (ra !== rb) {
                        if (ra === 0) return 1;
                        if (rb === 0) return -1;
                        return ra - rb;
                    }
                    return String(a && a.title ? a.title : '').localeCompare(String(b && b.title ? b.title : ''), 'id');
                });
            }

            // Merge datasets and add category labels
            gamesData = [];
            pcGames.forEach(g => gamesData.push({ ...g, _category: 'pc' }));
            ps2Games.forEach(g => gamesData.push({ ...g, _category: 'ps2' }));

            // Clean/Parse sizes for logic + add stable indices
            gamesData.forEach((game, idx) => {
                game._index = idx;

                // Default banner fallback to avoid broken images (ps2.json often has empty banner_url)
                if (!game.banner_url) {
                    game.banner_url = 'assets/logo.png';
                }

                const rawSize = (game.game_info && game.game_info['Game Size'] != null)
                    ? game.game_info['Game Size']
                    : 0;
                game._sizeGB = parseSizeToGB(rawSize);

                // Storage planner uses estimated install size (+25%)
                game._estimatedSizeGB = (Number.isFinite(game._sizeGB) ? game._sizeGB : 0) * 1.25;
            });

            // Initially, displayed dataset follows current filters
            applyFilters();
            updateStorageUI();
        } catch (error) {
            console.error(error);
            grid.innerHTML = `<div class="loading-state text-accent">Error: Data game tidak ditemukan. Pastikan steamrip_games.json berada di folder yang sama.</div>`;
        }
    }

    function applyFilters() {
        const query = (searchInput && searchInput.value ? searchInput.value : '').toLowerCase();
        const category = currentCategory || 'all';

        displayedGamesData = gamesData.filter((game) => {
            if (!game) return false;
            const matchesQuery = !query || (game.title || '').toLowerCase().includes(query);
            const matchesCategory = (category === 'all') || (game._category === category);
            return matchesQuery && matchesCategory;
        });

        renderGrid(true);
    }

    // Parse '118.5 GB' or '891 MB' into numeric Float (GB)
    function parseSizeToGB(sizeStr) {
        if (!sizeStr) return 0;
        const s = String(sizeStr).replace(',', '.').toUpperCase();
        const match = s.match(/\d+(?:\.\d+)?/);
        const num = match ? parseFloat(match[0]) : NaN;
        if (isNaN(num)) return 0;
        
        if (s.includes('MB')) return num / 1024;
        if (s.includes('KB')) return num / (1024 * 1024);
        return num; // Default GB
    }

    function formatSizeGB(sizeGB) {
        const safe = Number.isFinite(sizeGB) ? sizeGB : 0;
        const rounded = Math.round((safe + Number.EPSILON) * 10) / 10;
        return `${rounded.toFixed(1)} GB`;
    }

    // Requirement: detect MB/GB, convert to GB, add 25%, return "XX.X GB"
    function calculateEstimatedSize(sizeStr) {
        const sizeGB = parseSizeToGB(sizeStr);
        const estimatedGB = sizeGB * 1.25;
        return formatSizeGB(estimatedGB);
    }

    // Allow manual testing from DevTools console: calculateEstimatedSize('530 MB')
    window.calculateEstimatedSize = calculateEstimatedSize;

    // Update Progress Bar & Texts
    function updateStorageUI() {
        storageTotalEl.innerText = `${currentHddCapacity} GB`;
        
        totalUsedGB = 0;
        selectedGames.forEach(index => {
            const g = gamesData[index];
            totalUsedGB += g ? (Number.isFinite(g._estimatedSizeGB) ? g._estimatedSizeGB : 0) : 0;
        });

        const remaining = currentHddCapacity - totalUsedGB;
        
        // Formatting texts
        storageUsedEl.innerText = `${totalUsedGB.toFixed(1)} GB`;
        storageRemainingEl.innerText = `${remaining.toFixed(1)} GB`;
        selectedCountEl.innerText = selectedGames.size;

        // Update floating widget counter + list
        if (selectedWidgetCount) {
            selectedWidgetCount.innerText = selectedGames.size;
        }
        renderSelectedWidget();

        // Progress bar width
        let percentage = (totalUsedGB / currentHddCapacity) * 100;
        if (percentage > 100) percentage = 100;
        progressEl.style.width = `${percentage}%`;

        // Warnings
        if (remaining < 0) {
            storageRemainingEl.style.color = 'var(--danger)';
            progressEl.style.background = 'var(--danger)';
        } else if (percentage > 85) {
            storageRemainingEl.style.color = '#ffa502'; // Warning orange
            progressEl.style.background = 'linear-gradient(135deg, #ffa502, #ff4757)';
        } else {
            storageRemainingEl.style.color = 'var(--text-primary)';
            progressEl.style.background = 'var(--accent-gradient)';
        }
    }

    function setWidgetOpen(open) {
        widgetOpen = open;
        if (!selectedWidgetPanel) return;
        selectedWidgetPanel.classList.toggle('open', open);
    }

    function toggleWidget() {
        setWidgetOpen(!widgetOpen);
    }

    function renderSelectedWidget() {
        if (!selectedWidgetList) return;

        selectedWidgetList.innerHTML = '';
        const selectedIndices = Array.from(selectedGames);

        if (selectedIndices.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'assistive-empty';
            emptyEl.textContent = 'Belum ada game yang dipilih.';
            selectedWidgetList.appendChild(emptyEl);
            return;
        }

        selectedIndices.forEach((index) => {
            const game = gamesData[index];
            if (!game) return;

            const item = document.createElement('div');
            item.className = 'assistive-item';

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.flexDirection = 'column';
            left.style.gap = '2px';

            const titleEl = document.createElement('div');
            titleEl.className = 'assistive-item-title';
            titleEl.textContent = game.title || 'Untitled';

            const metaEl = document.createElement('div');
            metaEl.className = 'assistive-item-meta';
            metaEl.textContent = formatSizeGB(Number.isFinite(game._estimatedSizeGB) ? game._estimatedSizeGB : 0);

            left.appendChild(titleEl);
            left.appendChild(metaEl);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'assistive-remove';
            removeBtn.dataset.index = String(index);
            removeBtn.textContent = 'Remove';

            item.appendChild(left);
            item.appendChild(removeBtn);
            selectedWidgetList.appendChild(item);
        });
    }

    // --- Custom Dropdown Logic ---
    function setDropdownOptionsByStorageType(type) {
        const preset = storagePresets[type];
        if (!preset) return;

        hddItems.forEach((item, index) => {
            const option = preset.capacities[index] || preset.capacities[preset.capacities.length - 1];
            item.textContent = option.text;
            item.setAttribute('data-label', option.text);
            item.setAttribute('data-value', String(option.value));
            item.classList.remove('active');
        });

        // Keep visible selected text non-empty before active item is set
        if (hddSelectedText && preset.capacities[0]) {
            hddSelectedText.innerText = preset.capacities[0].text;
        }
    }

    function setCapacityByValue(capacityValue) {
        const numericValue = Number(capacityValue);
        if (!Number.isFinite(numericValue)) return;

        const matchedItem = Array.from(hddItems).find((item) => Number(item.getAttribute('data-value')) === numericValue);
        if (!matchedItem) {
            if (hddSelectedText) {
                hddSelectedText.innerText = `${Math.round(numericValue)} GB`;
            }
            currentHddCapacity = numericValue;
            return;
        }

        hddItems.forEach((i) => i.classList.remove('active'));
        matchedItem.classList.add('active');
        hddSelectedText.innerText = matchedItem.getAttribute('data-label') || matchedItem.textContent || `${Math.round(numericValue)} GB`;
        currentHddCapacity = numericValue;
    }

    function applyStoragePreset(type) {
        const preset = storagePresets[type];
        if (!preset) return;

        currentStorageType = type;
        setDropdownOptionsByStorageType(type);
        setCapacityByValue(preset.defaultCapacity);

        currentCategory = preset.category;
        if (categoryFilter) {
            categoryFilter.value = preset.category;
        }

        if (storageTypeLabelEl) {
            storageTypeLabelEl.innerText = preset.label;
        }

        if (storageTypeSelect) {
            storageTypeSelect.value = type;
        }

        applyFilters();
        updateStorageUI();
    }

    function closeLandingScreen() {
        if (!landingScreen) return;
        document.body.classList.remove('landing-active');
        landingScreen.style.display = 'none';
    }

    if (landingActions) {
        landingActions.addEventListener('click', (e) => {
            const btn = e.target.closest('.landing-choice-card');
            if (!btn) return;
            const storageType = btn.getAttribute('data-storage');
            applyStoragePreset(storageType);
            closeLandingScreen();
        });
    } else if (storageTypeLabelEl) {
        applyStoragePreset(currentStorageType);
    }

    if (storageTypeSelect) {
        storageTypeSelect.addEventListener('change', (e) => {
            applyStoragePreset(e.target.value);
            if (landingScreen && document.body.classList.contains('landing-active')) {
                closeLandingScreen();
            }
        });
    }

    hddDropdown.addEventListener('click', (e) => {
        // Toggle dropdown open/close
        hddDropdown.classList.toggle('open');
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!hddDropdown.contains(e.target)) {
            hddDropdown.classList.remove('open');
        }
    });

    // --- Selected Widget Logic ---
    if (selectedWidgetBtn && selectedWidgetPanel) {
        selectedWidgetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleWidget();
        });
    }

    if (selectedWidgetClose) {
        selectedWidgetClose.addEventListener('click', (e) => {
            e.stopPropagation();
            setWidgetOpen(false);
        });
    }

    // Click outside closes widget
    document.addEventListener('click', (e) => {
        if (!widgetOpen) return;
        if (selectedWidget && !selectedWidget.contains(e.target)) {
            setWidgetOpen(false);
        }
    });

    // ESC closes widget
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && widgetOpen) {
            setWidgetOpen(false);
        }
    });

    // Remove selected game via widget list (event delegation)
    if (selectedWidgetList) {
        selectedWidgetList.addEventListener('click', (e) => {
            const btn = e.target.closest('.assistive-remove');
            if (!btn) return;
            const idx = parseInt(btn.dataset.index);
            if (Number.isNaN(idx)) return;

            selectedGames.delete(idx);

            // If the card is currently rendered, update its UI too
            const card = grid.querySelector(`.game-card[data-index="${idx}"]`);
            if (card) {
                card.classList.remove('selected');
            }

            updateStorageUI();
        });
    }

    hddItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // Remove active from all
            hddItems.forEach(i => i.classList.remove('active'));
            // Add active to clicked
            item.classList.add('active');
            
            // Update Text
            hddSelectedText.innerText = item.getAttribute('data-label') || item.textContent || hddSelectedText.innerText;
            
            // Update Capacity Value
            currentHddCapacity = parseInt(item.getAttribute('data-value'));
            updateStorageUI();
        });
    });

    // --- Rendering ---

    function renderGrid(reset = false) {
        if (reset) {
            grid.innerHTML = '';
            currentPage = 1;
            itemsPerPage = getItemsPerPage();
        }

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const currentDataChunk = displayedGamesData.slice(startIndex, endIndex);

        if (currentDataChunk.length === 0 && reset) {
            grid.innerHTML = `<div class="loading-state">Tidak ada game yang ditemukan.</div>`;
            loadMoreBtn.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();

        currentDataChunk.forEach((game) => {
            // Kita butuh index ORISINAL dari gamesData untuk tracking selection
            const originalIndex = Number.isInteger(game._index) ? game._index : gamesData.indexOf(game);
            
            // Create Card Element
            const card = document.createElement('div');
            card.className = 'game-card';
            card.setAttribute('data-index', originalIndex);
            
            // Extract Size String for Badge
            const sizeStr = game.game_info ? game.game_info['Game Size'] : 'N/A';
            const estimatedSizeLabel = formatSizeGB(Number.isFinite(game._estimatedSizeGB) ? game._estimatedSizeGB : (parseSizeToGB(sizeStr) * 1.25));
            
            card.innerHTML = `
                <img src="${game.banner_url}" alt="${game.title}" class="card-img" loading="lazy" decoding="async">
                
                <div class="selected-overlay">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
                
                <div class="size-badge">${estimatedSizeLabel}</div>
                
                <div class="title-overlay">
                    <div class="game-title">${game.title}</div>
                </div>
                
                <div class="info-btn" data-index="${originalIndex}" title="Informasi Game">i</div>
            `;

            // Info button listener (attach per-card to avoid global querySelectorAll work)
            const infoBtn = card.querySelector('.info-btn');
            if (infoBtn) {
                infoBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openInfoModal(gamesData[originalIndex]);
                });
            }

            // Toggle Selection logic
            card.addEventListener('click', (e) => {
                // Ignore click if they pressed the info button
                if (e.target.closest('.info-btn')) return;

                if (selectedGames.has(originalIndex)) {
                    selectedGames.delete(originalIndex);
                    card.classList.remove('selected');
                } else {
                    selectedGames.add(originalIndex);
                    card.classList.add('selected');
                }
                updateStorageUI();
            });

            // Initial selection state check (for cases when searching/filtering brings back a selected card)
            if (selectedGames.has(originalIndex)) {
                card.classList.add('selected');
            }

            fragment.appendChild(card);
        });

        grid.appendChild(fragment);

        // Show or hide the Load More button based on remaining data
        if (endIndex >= displayedGamesData.length) {
            loadMoreBtn.style.display = 'none';
        } else {
            loadMoreBtn.style.display = 'inline-block';
        }
    }

    // Load More action
    loadMoreBtn.addEventListener('click', () => {
        currentPage++;
        renderGrid(false); // append mode
    });

    // --- Modal Logic ---

    function openInfoModal(game) {
        modalTitle.innerText = game.title;
        
        // System Requirements
        modalReqs.innerHTML = '';
        const reqEntries = (game && game.system_requirements)
            ? Object.entries(game.system_requirements).filter(([, val]) => String(val ?? '').trim() !== '')
            : [];
        if (reqEntries.length > 0) {
            reqEntries.forEach(([key, val]) => {
                modalReqs.innerHTML += `<li><span class="list-label">${key}</span>: ${val}</li>`;
            });
        } else {
            modalReqs.innerHTML = `<li class="text-secondary">Tidak ada data spesifikasi.</li>`;
        }

        // Game Info
        modalInfo.innerHTML = '';
        if (game.game_info) {
            for (const [key, val] of Object.entries(game.game_info)) {
                // Skip pre-installed/direct link booleans to keep clean if preferred
                if(typeof val === 'boolean') {
                    modalInfo.innerHTML += `<li><span class="list-label">${key}</span>: ${val ? 'Ya' : 'Tidak'}</li>`;
                } else {
                    modalInfo.innerHTML += `<li><span class="list-label">${key}</span>: ${val}</li>`;
                }
            }
        } else {
            modalInfo.innerHTML = `<li class="text-secondary">Tidak ada informasi tambahan.</li>`;
        }

        // Make modal overlay active
        modalOverlay.style.visibility = 'visible';
        modalOverlay.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    function closeModal() {
        modalOverlay.classList.remove('active');
        // Wait for CSS transition finish before hiding completely
        setTimeout(() => {
            if(!modalOverlay.classList.contains('active')) {
                modalOverlay.style.visibility = 'hidden';
            }
        }, 300);
        document.body.style.overflow = ''; 
    }

    closeModalBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        // If cliked exactly on the dark overlay (not inner modal), close it
        if (e.target === modalOverlay) {
            closeModal();
        }
    });

    // --- Export Modal Logic ---
    function openExportModal() {
        if (totalUsedGB > currentHddCapacity) {
            showToast("Kapasitas HDD tidak memadai! Silakan kurangi game atau sesuaikan kapasitas HDD.", "error");
            return; // Prevent export if exceeded
        }

        exportTableBody.innerHTML = '';
        let totalExportSize = 0;
        let counter = 1;

        const selectedArr = Array.from(selectedGames).map(index => gamesData[index]);
        
        if (selectedArr.length === 0) {
            exportTableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 20px;">Belum ada game yang dipilih.</td></tr>`;
        } else {
            selectedArr.forEach(game => {
                const tr = document.createElement('tr');
                const sizeStr = formatSizeGB(Number.isFinite(game._estimatedSizeGB) ? game._estimatedSizeGB : 0);
                
                tr.innerHTML = `
                    <td>${counter}</td>
                    <td>${game.title}</td>
                    <td style="color: var(--accent); font-weight: 600;">${sizeStr}</td>
                `;
                exportTableBody.appendChild(tr);
                
                totalExportSize += Number.isFinite(game._estimatedSizeGB) ? game._estimatedSizeGB : 0;
                counter++;
            });
        }

        exportTotalSize.innerText = `${totalExportSize.toFixed(1)} GB`;

        exportModal.style.visibility = 'visible';
        exportModal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeExportModal() {
        exportModal.classList.remove('active');
        setTimeout(() => {
            if(!exportModal.classList.contains('active')) {
                exportModal.style.visibility = 'hidden';
            }
        }, 300);
        document.body.style.overflow = ''; 
    }

    function buildExportText() {
        const selectedArr = Array.from(selectedGames).map(index => gamesData[index]).filter(Boolean);
        const totalSize = totalUsedGB;

        function stripVersionSuffix(title) {
            if (!title) return '';
            let t = String(title).trim();
            // Remove trailing version-like parentheses only (e.g. (v2.31), (Build 1491.50), (B_20231875 + Co-op))
            const versionSuffixRe = /\s*\((?:\s*(?:v\s*\d|build\b|Build\b|B_\d|b_\d)[^)]*)\)\s*$/;
            while (versionSuffixRe.test(t)) {
                t = t.replace(versionSuffixRe, '').trim();
            }
            return t;
        }

        function needsPs2Suffix(game) {
            if (!game) return false;
            if (game._category === 'ps2') return true;
            const platform = game.game_info ? String(game.game_info.Platform || '') : '';
            return platform.toUpperCase().includes('PS2');
        }

        function addPs2SuffixIfNeeded(title, game) {
            const t = String(title || '').trim();
            if (!needsPs2Suffix(game)) return t;
            // Avoid duplicates like "Title (PS2) (PS2)"
            if (/\(PS2\)\s*$/i.test(t)) return t;
            return `${t} (PS2)`;
        }

        if (selectedArr.length === 0) {
            return `Daftar Game Pesanan\n\n(Belum ada game yang dipilih)`;
        }

        const lines = [];
        lines.push('Daftar Game Pesanan');
        lines.push('');

        selectedArr.forEach((game, i) => {
            const title = (game && game.title) ? game.title : 'Untitled';
            const cleaned = stripVersionSuffix(title);
            const labeled = addPs2SuffixIfNeeded(cleaned, game);
            lines.push(`${i + 1}. ${labeled}`);
        });

        lines.push('');
        lines.push(`Total Size: ${totalSize.toFixed(1)} GB`);
        return lines.join('\n');
    }

    async function copyTextToClipboard(text) {
        // Modern Clipboard API
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

    exportBtn.addEventListener('click', openExportModal);
    closeExportModalBtn.addEventListener('click', closeExportModal);
    exportModal.addEventListener('click', (e) => {
        if (e.target === exportModal) {
            closeExportModal();
        }
    });

    if (copyTextBtn) {
        copyTextBtn.addEventListener('click', async () => {
            try {
                const text = buildExportText();
                const ok = await copyTextToClipboard(text);
                if (!ok) throw new Error('Copy gagal');
                showToast('Teks daftar game berhasil di-copy!', 'success');
            } catch (err) {
                console.error('Copy text error:', err);
                showToast('Gagal copy teks. Coba browser lain / pakai HTTPS.', 'error');
            }
        });
    }

    // --- Toast Notification ---
    function showToast(message, type = 'error') {
        // Destroy existing toasts to prevent spam
        const existingToasts = document.querySelectorAll('.toast-notification');
        existingToasts.forEach(toast => toast.remove());

        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        
        // Icon based on type
        const iconSvg = type === 'error' 
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
            : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="16 12 12 8 8 12"></polyline><line x1="12" y1="16" x2="12" y2="8"></line></svg>`;

        toast.innerHTML = `
            ${iconSvg}
            <span>${message}</span>
        `;
        
        document.body.appendChild(toast);

        // Animate In
        setTimeout(() => toast.classList.add('show'), 10);

        // Animate Out & Remove
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // --- Search Logic ---
    searchInput.addEventListener('input', (e) => {
        // Keep filters consistent (search + category)
        applyFilters();
    });

    if (categoryFilter) {
        categoryFilter.addEventListener('change', (e) => {
            currentCategory = e.target.value;
            applyFilters();
        });
    }

    // START
    loadGames();
});
