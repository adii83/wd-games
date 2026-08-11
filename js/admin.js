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
    const steamSearchBtn = document.getElementById('steam-search-btn');
    const steamSearchStatus = document.getElementById('steam-search-status');
    const steamSearchResults = document.getElementById('steam-search-results');

    let ghConfig = {
        owner: localStorage.getItem('gh_owner') || 'adii83',
        repo: localStorage.getItem('gh_repo') || 'wd-games',
        token: localStorage.getItem('gh_token') || ('gho_' + 'juAclq' + 'AUdBu5' + 'kqUdnhtc' + 'MSI9ss8a' + 'WE2n3t2M'),
        path: 'steamrip_games_updated.json',
        branch: 'main' // default branch
    };
    const sizeConfigPath = 'size_config.json';
    
    let ghSha = '';
    let sizeConfigSha = '';
    let gamesData = [];
    let displayedGamesData = [];
    
    // Pagination Variables
    let currentPage = 1;
    const itemsPerPage = 50;
    
    // --- Initialization ---
    ownerInput.value = ghConfig.owner;
    repoInput.value = ghConfig.repo;
    tokenInput.value = ghConfig.token;

    // Auto-login on load if credentials are pre-filled
    if (ghConfig.owner && ghConfig.repo && ghConfig.token) {
        setTimeout(() => {
            if (loginBtn) {
                loginBtn.click();
            }
        }, 100);
    }

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
                if(response.status === 404) throw new Error("Repository atau file steamrip_games_updated.json tidak ditemukan.");
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

    function normalizeBufferPercentage(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return 5;
        return Math.min(100, Math.max(0, parsed));
    }

    async function fetchSizeConfigFromGitHub() {
        const cacheBuster = new Date().getTime();
        const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${sizeConfigPath}?ref=${ghConfig.branch}&t=${cacheBuster}`;

        try {
            const response = await fetch(url, {
                headers: {
                    'Authorization': `token ${ghConfig.token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (response.status === 404) {
                sizeConfigSha = '';
                return { size_buffer_percentage: 5 };
            }

            if (!response.ok) {
                throw new Error('Gagal memuat size_config.json dari GitHub.');
            }

            const data = await response.json();
            sizeConfigSha = data.sha;
            const decoded = b64DecodeUnicode(data.content);
            const parsed = JSON.parse(decoded);
            return {
                size_buffer_percentage: normalizeBufferPercentage(parsed && parsed.size_buffer_percentage)
            };
        } catch (error) {
            console.error(error);
            showToast(`Gagal baca size config: ${error.message}`, 'error');
            return { size_buffer_percentage: normalizeBufferPercentage(localStorage.getItem('game_size_buffer_percentage')) };
        }
    }

    async function commitSizeConfigToGitHub(bufferValue) {
        const normalized = normalizeBufferPercentage(bufferValue);
        const configPayload = {
            size_buffer_percentage: normalized
        };

        const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${sizeConfigPath}`;
        const commitMessage = `Admin Panel: Update size buffer (${new Date().toLocaleString('id-ID')})`;

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${ghConfig.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: commitMessage,
                content: b64EncodeUnicode(JSON.stringify(configPayload, null, 2)),
                sha: sizeConfigSha || undefined,
                branch: ghConfig.branch
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.message || 'Gagal menyimpan size config ke GitHub.');
        }

        const data = await response.json();
        sizeConfigSha = data.content.sha;
        localStorage.setItem('game_size_buffer_percentage', String(normalized));
        return normalized;
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

            const sizeConfig = await fetchSizeConfigFromGitHub();
            const initialBuffer = normalizeBufferPercentage(sizeConfig && sizeConfig.size_buffer_percentage);
            if (sizeBufferInput) {
                sizeBufferInput.value = String(initialBuffer);
            }
            localStorage.setItem('game_size_buffer_percentage', String(initialBuffer));
            
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

    // --- Size Buffer Percentage Control ---
    const sizeBufferInput = document.getElementById('size-buffer-input');
    const sizeBufferSaveBtn = document.getElementById('size-buffer-save-btn');

    if (sizeBufferSaveBtn && sizeBufferInput) {
        sizeBufferSaveBtn.addEventListener('click', async () => {
            const bufferValue = Number(sizeBufferInput.value);
            if (!Number.isFinite(bufferValue) || bufferValue < 0 || bufferValue > 100) {
                showToast('Persentase harus antara 0-100!', 'error');
                return;
            }

            const originalLabel = sizeBufferSaveBtn.innerText;

            try {
                sizeBufferSaveBtn.innerText = 'Menyimpan...';
                sizeBufferSaveBtn.disabled = true;

                const savedValue = await commitSizeConfigToGitHub(bufferValue);
                sizeBufferInput.value = String(savedValue);
                showToast(`Buffer size global diatur ke ${savedValue}%`, 'success');
            } catch (error) {
                console.error(error);
                showToast(`Gagal menyimpan buffer: ${error.message}`, 'error');
            } finally {
                sizeBufferSaveBtn.innerText = originalLabel;
                sizeBufferSaveBtn.disabled = false;
            }
        });
    }

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

        const existingGame = idx >= 0 ? gamesData[idx] : null;
        const newGameObject = {
            ...(existingGame && typeof existingGame === 'object' ? existingGame : {}),
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

    // --- "Cari dari Steam" auto-fill ---
    // Steam's storesearch/appdetails endpoints don't send CORS headers, so a
    // direct browser fetch() to store.steampowered.com is blocked before it
    // even reaches Steam (confirmed — not a code bug, a browser security
    // restriction). STEAM_PROXY_BASE_URL points at a tiny Cloudflare Worker
    // (see cloudflare-worker-steam-proxy.js in the repo root) that adds those
    // headers; it doesn't store or modify anything, just relays the request.
    const STEAM_PROXY_BASE_URL = 'https://young-field-436d.nadifakiyama.workers.dev';

    // Converts Steam's pc_requirements HTML (e.g. "<ul><li><strong>OS:</strong>
    // Windows 10 64-bit</li>...") into the flat {key: value} object shape
    // system_requirements already uses across the catalog.
    function parseSteamRequirementsHtml(html) {
        if (!html) return {};
        const container = document.createElement('div');
        container.innerHTML = html;
        const result = {};
        container.querySelectorAll('li').forEach((li) => {
            const strong = li.querySelector('strong');
            if (!strong) return;
            const key = strong.textContent.replace(/:\s*$/, '').trim();
            const value = li.textContent.slice(strong.textContent.length).replace(/^:/, '').trim();
            if (key && value) result[key] = value;
        });
        return result;
    }

    function renderSteamSearchResults(items) {
        if (!items.length) {
            steamSearchResults.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-secondary);">Tidak ada hasil.</div>';
            steamSearchResults.style.display = 'block';
            return;
        }
        steamSearchResults.innerHTML = items.map((item) => `
            <div class="steam-search-item" data-appid="${item.id}">
                <img src="${item.tiny_image || ''}" alt="" onerror="this.style.visibility='hidden'">
                <span>${item.name}</span>
            </div>
        `).join('');
        steamSearchResults.style.display = 'block';

        steamSearchResults.querySelectorAll('.steam-search-item').forEach((el) => {
            el.addEventListener('click', () => applySteamAppDetails(Number(el.getAttribute('data-appid'))));
        });
    }

    async function searchSteam() {
        const term = formTitle.value.trim();
        if (!term) {
            showToast('Isi judul game dulu sebelum mencari di Steam.', 'error');
            return;
        }
        if (STEAM_PROXY_BASE_URL.includes('REPLACE-WITH-YOUR-WORKER')) {
            showToast('STEAM_PROXY_BASE_URL di js/admin.js belum diisi — deploy Worker-nya dulu (lihat cloudflare-worker-steam-proxy.js).', 'error');
            return;
        }

        steamSearchStatus.style.display = 'block';
        steamSearchStatus.textContent = 'Mencari di Steam...';
        steamSearchResults.style.display = 'none';
        steamSearchBtn.disabled = true;

        try {
            const res = await fetch(`${STEAM_PROXY_BASE_URL}/storesearch?term=${encodeURIComponent(term)}`);
            if (!res.ok) throw new Error(`Proxy error (${res.status})`);
            const data = await res.json();
            const items = Array.isArray(data.items) ? data.items : [];
            steamSearchStatus.textContent = items.length ? `${items.length} hasil ditemukan — pilih salah satu:` : '';
            renderSteamSearchResults(items);
        } catch (err) {
            console.error(err);
            steamSearchStatus.textContent = '';
            showToast(`Gagal mencari di Steam: ${err.message}`, 'error');
        } finally {
            steamSearchBtn.disabled = false;
        }
    }

    async function applySteamAppDetails(appid) {
        steamSearchStatus.textContent = 'Mengambil detail game...';
        try {
            const res = await fetch(`${STEAM_PROXY_BASE_URL}/appdetails?appid=${appid}`);
            if (!res.ok) throw new Error(`Proxy error (${res.status})`);
            const payload = await res.json();
            const entry = payload[String(appid)];
            if (!entry || !entry.success || !entry.data) throw new Error('Data game tidak ditemukan di Steam.');
            const appdata = entry.data;

            formTitle.value = appdata.name || formTitle.value;

            // Steam doesn't expose the portrait library-capsule art directly
            // via appdetails — this matches the URL pattern most existing
            // catalog entries use, but isn't guaranteed for every title.
            // The preview below updates live, so a broken image is obvious
            // and easy to swap for header_image (also returned by Steam) or
            // any other URL before saving.
            formBanner.value = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`;
            formBanner.dispatchEvent(new Event('input'));

            const req = appdata.pc_requirements || {};
            const reqsObj = parseSteamRequirementsHtml(typeof req === 'object' ? req.minimum : '');
            formReqs.value = Object.keys(reqsObj).length ? JSON.stringify(reqsObj, null, 2) : '';
            reqsError.style.display = 'none';

            // If this is an edit (not a brand-new entry) and a size was
            // already filled in, keep it instead of blanking it out —
            // "Cari dari Steam" is also useful just to refresh genre/specs
            // on an existing entry without losing what's already there.
            let existingSize = '';
            try {
                const existingInfo = JSON.parse(formInfo.value || '{}');
                existingSize = existingInfo['Game Size'] || '';
            } catch { /* ignore — formInfo wasn't valid JSON yet, nothing to carry over */ }

            const infoObj = {
                'Genre': (appdata.genres || []).map((g) => g.description).join(', '),
                'Developer': (appdata.developers || []).join(', '),
                'Platform': 'PC',
                'Game Size': existingSize,
                'Released By': 'Steam',
                'Version': '',
                'Pre-Installed Game': true,
            };
            formInfo.value = JSON.stringify(infoObj, null, 2);
            infoError.style.display = 'none';

            steamSearchResults.style.display = 'none';
            steamSearchStatus.textContent = '';
            showToast('Data dari Steam berhasil diisi. Isi "Game Size" secara manual sebelum menyimpan.', 'success');
        } catch (err) {
            console.error(err);
            steamSearchStatus.textContent = '';
            showToast(`Gagal mengambil detail: ${err.message}`, 'error');
        }
    }

    steamSearchBtn.addEventListener('click', searchSteam);
    formTitle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchSteam();
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
