document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const grid = document.getElementById('game-grid');
    const hddDropdown = document.getElementById('hdd-dropdown');
    const hddSelectedText = document.getElementById('dropdown-selected-text').querySelector('span:nth-child(2)');
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
    const exportBtn = document.getElementById('export-btn');
    const exportModal = document.getElementById('export-modal');
    const closeExportModalBtn = document.getElementById('close-export-modal');
    const exportTableBody = document.getElementById('export-table-body');
    const exportTotalSize = document.getElementById('export-total-size');
    const downloadImgBtn = document.getElementById('download-img-btn');
    const exportCaptureArea = document.getElementById('export-capture-area');
    
    // State Tracker
    let gamesData = [];
    let displayedGamesData = []; // Filtered games based on search
    let selectedGames = new Set(); // Stores original indices of selected games
    
    // Get initial value from active dropdown item
    let currentHddCapacity = parseInt(document.querySelector('.dropdown-item.active').getAttribute('data-value')); 
    let totalUsedGB = 0;
    
    // Pagination parameters
    let itemsPerPage = 50;
    let currentPage = 1;

    // Load More Button
    const loadMoreBtn = document.getElementById('load-more-btn');

    // --- Core Logic ---

    // Fetch JSON Data
    async function loadGames() {
        try {
            const cacheBuster = new Date().getTime();
            const response = await fetch(`steamrip_games.json?t=${cacheBuster}`, { cache: "no-store" });
            if (!response.ok) throw new Error("Gagal mengambil data");
            
            gamesData = await response.json();
            
            // Clean/Parse sizes for logic
            gamesData.forEach(game => {
                if (game.game_info && game.game_info['Game Size']) {
                    game._sizeGB = parseSizeToGB(game.game_info['Game Size']);
                } else {
                    game._sizeGB = 0; // fallback
                }
            }); // <-- FIXED: Added missing closing bracket and parenthesis
            
            // Initially, displayed dataset is the full dataset
            displayedGamesData = gamesData;

            renderGrid(true);
        } catch (error) {
            console.error(error);
            grid.innerHTML = `<div class="loading-state text-accent">Error: Data game tidak ditemukan. Pastikan steamrip_games.json berada di folder yang sama.</div>`;
        }
    }

    // Parse '118.5 GB' or '891 MB' into numeric Float (GB)
    function parseSizeToGB(sizeStr) {
        if (!sizeStr) return 0;
        const s = sizeStr.toUpperCase();
        const num = parseFloat(s.replace(/[^0-9.]/g, ''));
        if (isNaN(num)) return 0;
        
        if (s.includes('MB')) return num / 1024;
        if (s.includes('KB')) return num / (1024 * 1024);
        return num; // Default GB
    }

    // Update Progress Bar & Texts
    function updateStorageUI() {
        storageTotalEl.innerText = `${currentHddCapacity} GB`;
        
        totalUsedGB = 0;
        selectedGames.forEach(index => {
            totalUsedGB += gamesData[index]._sizeGB;
        });

        const remaining = currentHddCapacity - totalUsedGB;
        
        // Formatting texts
        storageUsedEl.innerText = `${totalUsedGB.toFixed(1)} GB`;
        storageRemainingEl.innerText = `${remaining.toFixed(1)} GB`;
        selectedCountEl.innerText = selectedGames.size;

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

    // --- Custom Dropdown Logic ---
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

    hddItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // Remove active from all
            hddItems.forEach(i => i.classList.remove('active'));
            // Add active to clicked
            item.classList.add('active');
            
            // Update Text
            hddSelectedText.innerText = item.innerText;
            
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
        }

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const currentDataChunk = displayedGamesData.slice(startIndex, endIndex);

        if (currentDataChunk.length === 0 && reset) {
            grid.innerHTML = `<div class="loading-state">Tidak ada game yang ditemukan.</div>`;
            loadMoreBtn.style.display = 'none';
            return;
        }

        currentDataChunk.forEach((game) => {
            // Kita butuh index ORISINAL dari gamesData untuk tracking selection
            const originalIndex = gamesData.indexOf(game);
            
            // Create Card Element
            const card = document.createElement('div');
            card.className = 'game-card';
            card.setAttribute('data-index', originalIndex);
            
            // Extract Size String for Badge
            const sizeStr = game.game_info ? game.game_info['Game Size'] : 'N/A';
            
            card.innerHTML = `
                <img src="${game.banner_url}" alt="${game.title}" class="card-img" loading="lazy">
                
                <div class="selected-overlay">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
                
                <div class="size-badge">${sizeStr}</div>
                
                <div class="title-overlay">
                    <div class="game-title">${game.title}</div>
                </div>
                
                <div class="info-btn" data-index="${originalIndex}" title="Informasi Game">i</div>
            `;

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

            grid.appendChild(card);
        });

        // Add event listeners to NEW info buttons exclusively
        // This targets recently added cards to avoid double listeners
        const newInfoBtns = Array.from(grid.querySelectorAll('.info-btn')).slice(startIndex);
        newInfoBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(btn.getAttribute('data-index'));
                openInfoModal(gamesData[idx]);
            });
        });

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
        if (game.system_requirements) {
            for (const [key, val] of Object.entries(game.system_requirements)) {
                modalReqs.innerHTML += `<li><span class="list-label">${key}</span>: ${val}</li>`;
            }
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
                const sizeStr = game.game_info ? game.game_info['Game Size'] : 'N/A';
                
                tr.innerHTML = `
                    <td>${counter}</td>
                    <td>${game.title}</td>
                    <td style="color: var(--accent); font-weight: 600;">${sizeStr}</td>
                `;
                exportTableBody.appendChild(tr);
                
                totalExportSize += game._sizeGB;
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

    exportBtn.addEventListener('click', openExportModal);
    closeExportModalBtn.addEventListener('click', closeExportModal);
    exportModal.addEventListener('click', (e) => {
        if (e.target === exportModal) {
            closeExportModal();
        }
    });

    // --- HTML to Image Download Logic ---
    if(downloadImgBtn && exportCaptureArea) {
        downloadImgBtn.addEventListener('click', () => {
            const originalText = downloadImgBtn.innerHTML;
            downloadImgBtn.innerHTML = 'Memproses...';
            downloadImgBtn.disabled = true;

            // Force desktop layout for high quality export
            const originalWidth = exportCaptureArea.style.width;
            const originalMaxWidth = exportCaptureArea.style.maxWidth;
            const originalOverflow = exportCaptureArea.style.overflowX;
            
            // Apply fixed width to prevent text squishing on mobile
            exportCaptureArea.style.width = '800px';
            exportCaptureArea.style.maxWidth = '800px';
            exportCaptureArea.style.overflowX = 'hidden';

            // Use html2canvas to capture the table container area
            html2canvas(exportCaptureArea, {
                backgroundColor: '#14161c', // Match theme bg-card
                scale: 2, // Higher resolution
                windowWidth: 800 // Trick html2canvas into thinking the window is wider
            }).then(canvas => {
                // Restore original styles
                exportCaptureArea.style.width = originalWidth;
                exportCaptureArea.style.maxWidth = originalMaxWidth;
                exportCaptureArea.style.overflowX = originalOverflow;

                // Convert canvas to image URL
                const imgData = canvas.toDataURL('image/png');
                
                // Create a temporary link element
                const link = document.createElement('a');
                link.download = `WD-Games-Pesanan-${new Date().getTime()}.png`;
                link.href = imgData;
                
                // Trigger download
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                // Reset button state
                downloadImgBtn.innerHTML = originalText;
                downloadImgBtn.disabled = false;
                
                showToast("Gambar tabel berhasil di-download!", "success");
            }).catch(err => {
                console.error("Error capturing image:", err);

                // Restore original styles cleanly if error occurs
                exportCaptureArea.style.width = originalWidth;
                exportCaptureArea.style.maxWidth = originalMaxWidth;
                exportCaptureArea.style.overflowX = originalOverflow;

                downloadImgBtn.innerHTML = originalText;
                downloadImgBtn.disabled = false;
                showToast("Gagal men-download gambar.", "error");
            });
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
        const query = e.target.value.toLowerCase();
        
        if (query.trim() === '') {
            displayedGamesData = gamesData;
        } else {
            displayedGamesData = gamesData.filter(game => 
                game.title.toLowerCase().includes(query)
            );
        }
        
        // Reset view back to page 1 with new data
        renderGrid(true);
    });

    // START
    loadGames();
});
