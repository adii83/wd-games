document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements - Login
    const loginContainer = document.getElementById('login-container');
    const dashboardContainer = document.getElementById('dashboard-container');
    const ownerInput = document.getElementById('gh-owner');
    const repoInput = document.getElementById('gh-repo');
    const tokenInput = document.getElementById('gh-token');
    const rememberCheckbox = document.getElementById('remember-gh');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');

    // DOM Elements - Dashboard
    const repoInfo = document.getElementById('repo-info');
    const logoutBtn = document.getElementById('logout-btn');
    const adminTableBody = document.getElementById('admin-table-body');
    const totalDbCount = document.getElementById('total-db-count');
    const searchInput = document.getElementById('admin-search');
    const saveGithubBtn = document.getElementById('save-github-btn');
    const addGameBtn = document.getElementById('add-game-btn');

    // DOM Elements - Modal Form
    const gameModal = document.getElementById('game-modal');
    const closeFormBtn = document.getElementById('close-form-btn');
    const formTitle = document.getElementById('form-title');
    const formBanner = document.getElementById('form-banner');
    const formBannerPreview = document.getElementById('form-banner-preview');
    const formReqs = document.getElementById('form-reqs');
    const formInfo = document.getElementById('form-info');
    const formIndex = document.getElementById('form-index');
    const saveGameBtn = document.getElementById('save-game-btn');
    const reqsError = document.getElementById('reqs-error');
    const infoError = document.getElementById('info-error');

    let ghConfig = {
        owner: localStorage.getItem('gh_owner') || '',
        repo: localStorage.getItem('gh_repo') || 'wd-games',
        token: localStorage.getItem('gh_token') || '',
        path: 'steamrip_games.json',
        branch: 'main' // default branch
    };
    
    let ghSha = ''; 
    let gamesData = [];
    let displayedGamesData = [];
    
    // Pagination Variables
    let currentPage = 1;
    const itemsPerPage = 50;
    
    // --- Initialization ---
    ownerInput.value = ghConfig.owner;
    repoInput.value = ghConfig.repo;
    tokenInput.value = ghConfig.token;

    // Decode Base64 safely (handles UTF-8)
    function b64DecodeUnicode(str) {
        return decodeURIComponent(atob(str).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    }

    // Encode Base64 safely (handles UTF-8)
    function b64EncodeUnicode(str) {
        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
        }));
    }

    // --- GitHub API Functions ---
    async function fetchGitHubData() {
        const cacheBuster = new Date().getTime();
        const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${ghConfig.path}?ref=${ghConfig.branch}&t=${cacheBuster}`;
        try {
            const response = await fetch(url, {
                headers: {
                    'Authorization': `token ${ghConfig.token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if(!response.ok) {
                if(response.status === 404) throw new Error("Repository atau file steamrip_games.json tidak ditemukan.");
                if(response.status === 401) throw new Error("Token (PAT) tidak valid / Unauthorized.");
                throw new Error("Gagal mengambil data dari GitHub API.");
            }

            const data = await response.json();
            ghSha = data.sha; 
            
            try {
                // Try decoding standard GitHub base64
                const decodedContent = b64DecodeUnicode(data.content);
                gamesData = JSON.parse(decodedContent);
            } catch (parseErr) {
                console.warn("Base64 decode failed, falling back to raw download URL...", parseErr);
                // Fallback: If file is too large or base64 is malformed, fetch the raw file directly
                const rawResponse = await fetch(data.download_url + `?t=${cacheBuster}`, { cache: 'no-store' });
                if (!rawResponse.ok) throw new Error("Gagal mengambil data raw dari GitHub.");
                gamesData = await rawResponse.json();
            }

            displayedGamesData = gamesData;

            return true;
        } catch (error) {
            console.error(error);
            loginError.innerText = error.message;
            loginError.style.display = 'block';
            return false;
        }
    }

    async function commitToGitHub() {
        const jsonString = JSON.stringify(gamesData, null, 2);
        const encodedContent = b64EncodeUnicode(jsonString);

        const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${ghConfig.path}`;
        const commitMessage = `Admin Panel: Database Update via Web UI (${new Date().toLocaleString('id-ID')})`;

        try {
            saveGithubBtn.innerHTML = 'Memproses...';
            saveGithubBtn.disabled = true;

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${ghConfig.token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: commitMessage,
                    content: encodedContent,
                    sha: ghSha,
                    branch: ghConfig.branch
                })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.message || "Gagal menyimpan ke GitHub.");
            }

            const data = await response.json();
            ghSha = data.content.sha; // Update SHA for next commit
            
            showToast("Berhasil disimpan! Website akan terupdate secara otomatis dalam beberapa menit.", "success");
        } catch (error) {
            console.error(error);
            showToast(`Error: ${error.message}`, "error");
        } finally {
            saveGithubBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> Simpan ke GitHub`;
            saveGithubBtn.disabled = false;
        }
    }

    // --- Authentication ---
    loginBtn.addEventListener('click', async () => {
        ghConfig.owner = ownerInput.value.trim();
        ghConfig.repo = repoInput.value.trim();
        ghConfig.token = tokenInput.value.trim();

        if (!ghConfig.owner || !ghConfig.repo || !ghConfig.token) {
            loginError.innerText = "Semua kolom wajib diisi!";
            loginError.style.display = 'block';
            return;
        }

        loginBtn.innerHTML = "Menghubungkan...";
        loginBtn.disabled = true;
        loginError.style.display = 'none';

        const success = await fetchGitHubData();

        if (success) {
            // Save or clear credentials based on checkbox
            if (rememberCheckbox.checked) {
                localStorage.setItem('gh_owner', ghConfig.owner);
                localStorage.setItem('gh_repo', ghConfig.repo);
                localStorage.setItem('gh_token', ghConfig.token);
            } else {
                localStorage.removeItem('gh_owner');
                localStorage.removeItem('gh_repo');
                localStorage.removeItem('gh_token');
            }
            
            repoInfo.innerText = `Connected: ${ghConfig.owner}/${ghConfig.repo} | Branch: ${ghConfig.branch}`;
            loginContainer.style.display = 'none';
            dashboardContainer.style.display = 'block';
            
            renderAdminTable();
        }

        loginBtn.innerHTML = "Connect & Load Database";
        loginBtn.disabled = false;
    });

    logoutBtn.addEventListener('click', () => {
        // Clear runtime config
        ghConfig.token = '';
        ghConfig.owner = '';
        ghConfig.repo = '';
        
        // Return to login
        dashboardContainer.style.display = 'none';
        loginContainer.style.display = 'flex';
        
        // Visually clear token for security if not remembered, else retain UI
        if (!rememberCheckbox.checked) {
            tokenInput.value = '';
            ownerInput.value = '';
            repoInput.value = '';
        } else {
            tokenInput.value = ''; // Always clear token input functionally on logout for security
        }
    });

    // --- Data Rendering ---
    function renderAdminTable(append = false) {
        totalDbCount.innerText = displayedGamesData.length;

        if (!append) {
            adminTableBody.innerHTML = '';
            currentPage = 1;
        }

        if (displayedGamesData.length === 0) {
            adminTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px;">Data tidak ditemukan.</td></tr>`;
            document.getElementById('admin-load-more').style.display = 'none';
            return;
        }

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const pageData = displayedGamesData.slice(startIndex, endIndex);

        pageData.forEach((game) => {
            const originalIndex = gamesData.indexOf(game);
            const sizeStr = game.game_info && game.game_info['Game Size'] ? game.game_info['Game Size'] : 'N/A';
            const tr = document.createElement('tr');
            
            tr.innerHTML = `
                <td>${originalIndex + 1}</td>
                <td style="font-weight:600;">${game.title}</td>
                <td><img src="${game.banner_url}" class="game-thumb" onerror="this.src='https://via.placeholder.com/60x80?text=No+Img'"></td>
                <td class="text-accent">${sizeStr}</td>
                <td>
                    <div class="action-btns">
                        <button class="action-btn btn-edit" data-index="${originalIndex}">Edit</button>
                        <button class="action-btn btn-del" data-index="${originalIndex}">Hapus</button>
                    </div>
                </td>
            `;
            adminTableBody.appendChild(tr);
        });

        // Re-attach event listeners for dynamic buttons
        document.querySelectorAll('.btn-edit').forEach(btn => {
            // Remove previous listener to prevent duplicates if appending
            btn.replaceWith(btn.cloneNode(true));
        });
        document.querySelectorAll('.btn-del').forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });

        document.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', (e) => openGameModal(parseInt(e.target.getAttribute('data-index'))));
        });
        document.querySelectorAll('.btn-del').forEach(btn => {
            btn.addEventListener('click', (e) => deleteGame(parseInt(e.target.getAttribute('data-index'))));
        });

        // Handle Load More visibility
        const loadMoreBtn = document.getElementById('admin-load-more');
        if (endIndex < displayedGamesData.length) {
            loadMoreBtn.style.display = 'inline-block';
        } else {
            loadMoreBtn.style.display = 'none';
        }
    }

    document.getElementById('admin-load-more').addEventListener('click', () => {
        currentPage++;
        renderAdminTable(true);
    });

    // --- Search ---
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        if (query.trim() === '') {
            displayedGamesData = gamesData;
        } else {
            displayedGamesData = gamesData.filter(g => g.title.toLowerCase().includes(query));
        }
        renderAdminTable();
    });

    // --- CRUD Logic ---
    function deleteGame(index) {
        if (confirm(`Peringatan: Apakah Anda yakin ingin menghapus game "${gamesData[index].title}" secara LOKAL? (Klik "Simpan ke GitHub" untuk menerapkan ke server)`)) {
            gamesData.splice(index, 1);
            searchInput.dispatchEvent(new Event('input'));
            showToast("Game dihapus secara lokal.", "success");
        }
    }

    function openGameModal(index = -1) {
        formIndex.value = index;
        reqsError.style.display = 'none';
        infoError.style.display = 'none';
        formBannerPreview.style.display = 'none';

        if (index >= 0) {
            document.getElementById('form-modal-title').innerText = "Edit Game";
            const game = gamesData[index];
            formTitle.value = game.title || '';
            formBanner.value = game.banner_url || '';
            if(game.banner_url) {
                formBannerPreview.src = game.banner_url;
                formBannerPreview.style.display = 'block';
            }
            formReqs.value = game.system_requirements ? JSON.stringify(game.system_requirements, null, 2) : '';
            formInfo.value = game.game_info ? JSON.stringify(game.game_info, null, 2) : '';
        } else {
            document.getElementById('form-modal-title').innerText = "Tambah Game Baru";
            formTitle.value = '';
            formBanner.value = '';
            formReqs.value = '';
            formInfo.value = '';
        }

        gameModal.style.visibility = 'visible';
        gameModal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeModal() {
        gameModal.classList.remove('active');
        setTimeout(() => {
            if(!gameModal.classList.contains('active')) {
                gameModal.style.visibility = 'hidden';
            }
        }, 300);
        document.body.style.overflow = ''; 
    }

    function parseJSONField(valueStr, errorEl) {
        if (!valueStr.trim()) return {}; 
        try {
            const parsed = JSON.parse(valueStr);
            errorEl.style.display = 'none';
            return parsed;
        } catch (e) {
            errorEl.style.display = 'block';
            return null;
        }
    }

    saveGameBtn.addEventListener('click', () => {
        const title = formTitle.value.trim();
        const banner = formBanner.value.trim();
        const idx = parseInt(formIndex.value);

        if (!title || !banner) {
            showToast("Judul dan Banner URL tidak boleh kosong!", "error");
            return;
        }

        const reqsObj = parseJSONField(formReqs.value, reqsError);
        const infoObj = parseJSONField(formInfo.value, infoError);

        if (reqsObj === null || infoObj === null) {
            showToast("Format JSON salah! Silakan periksa kembali.", "error");
            return; 
        }

        const newGameObject = {
            title: title,
            banner_url: banner,
            system_requirements: Object.keys(reqsObj).length > 0 ? reqsObj : null,
            game_info: Object.keys(infoObj).length > 0 ? infoObj : null
        };

        if (idx >= 0) {
            gamesData[idx] = newGameObject;
            showToast("Ubah Data Lokal: Berhasil disimpan!", "success");
        } else {
            gamesData.unshift(newGameObject); 
            showToast("Tambah Data Lokal: Berhasil disimpan!", "success");
        }

        closeModal();
        searchInput.dispatchEvent(new Event('input')); 
    });

    addGameBtn.addEventListener('click', () => openGameModal(-1));
    closeFormBtn.addEventListener('click', closeModal);
    gameModal.addEventListener('click', (e) => {
        if (e.target === gameModal) {
            closeModal();
        }
    });

    formBanner.addEventListener('input', (e) => {
        if(e.target.value.trim()) {
            formBannerPreview.src = e.target.value;
            formBannerPreview.style.display = 'block';
        } else {
            formBannerPreview.style.display = 'none';
        }
    });

    saveGithubBtn.addEventListener('click', () => {
        if (confirm("Ingin menerapkan perubahan LOKAL ini ke server GitHub secara LIVE?")) {
            commitToGitHub();
        }
    });

    // --- Toast Engine ---
    function showToast(message, type = 'error') {
        const existingToasts = document.querySelectorAll('.toast-notification');
        existingToasts.forEach(t => t.remove());

        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        const iconSvg = type === 'error' 
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
            : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="16 12 12 8 8 12"></polyline><line x1="12" y1="16" x2="12" y2="8"></line></svg>`;

        toast.innerHTML = `${iconSvg}<span>${message}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
});
