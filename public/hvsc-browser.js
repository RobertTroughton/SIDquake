window.hvscBrowser = (function () {

    // HVSC is now self-hosted: raw .sid files are served statically from
    // /HVSC/... and the whole collection tree + metadata comes from the
    // single search index (hvsc-index.json). Browsing is therefore entirely
    // client-side — no per-folder network round-trips.

    const ROOT = 'C64Music';

    let currentPath = ROOT;
    let currentSelection = null;
    let entries = [];
    const scrollByPath = new Map();  // remembers file-list scroll per directory

    let hvscPlayer = null;
    let hvscInitialized = false;

    // Index / tree state
    let searchIndex = null;          // { entries: [{p,t,a,r,s}], ... } once loaded
    let searchIndexPromise = null;   // in-flight load promise
    let dirMap = null;               // Map<dirPath, {dirs:Set, files:[{name,path,meta}]}>
    let metaByPath = null;           // Map<path, {t,a,r,s}>

    // Search state
    let searchMode = false;
    let searchDebounce = null;
    let lastSearchMatches = null;    // for re-sorting search results in place
    const SEARCH_RESULT_LIMIT = 500;
    // Search results are painted a chunk at a time. A keystroke that lands
    // mid-paint abandons the rest, so typing costs one chunk per keystroke
    // rather than the whole capped list.
    const RESULT_CHUNK = 60;
    let pendingRowPaint = null;

    // Sort state (applies to files in a folder and to search results;
    // directories always list first, alphabetically). Persisted so the
    // browser reopens the way the user left it.
    let sortKey = 'name';   // 'name' | 'year'
    let sortDir = 'asc';    // 'asc' | 'desc'  (for year: asc = oldest first)
    try {
        const saved = JSON.parse(localStorage.getItem('hvsc-sort') || 'null');
        if (saved && (saved.key === 'name' || saved.key === 'year')) {
            sortKey = saved.key;
            sortDir = saved.dir === 'desc' ? 'desc' : 'asc';
        }
    } catch (e) { /* no saved sort */ }

    /** Numeric release year for sorting; NaN when unknown (sorts last). */
    function yearNum(metaOrEntry) {
        const r = (metaOrEntry && metaOrEntry.r) || '';
        const tok = r.trim().split(/\s+/)[0] || '';
        const m = tok.replace(/\?/g, '0').match(/\d{4}/);
        return m ? parseInt(m[0], 10) : NaN;
    }

    /** Human release-year label (e.g. "1988", "198?"); '' when unknown. */
    function yearLabel(metaOrEntry) {
        const r = (metaOrEntry && metaOrEntry.r) || '';
        const tok = r.trim().split(/\s+/)[0] || '';
        return /\d/.test(tok) ? tok : '';
    }

    /** Sort comparator for browse entries: directories first, then by sortKey. */
    function compareEntries(a, b) {
        if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
        if (a.isDirectory) return a.name.localeCompare(b.name); // dirs: always name-asc
        return compareFiles(a.meta, a.name, b.meta, b.name);
    }

    /** Order two files by the current sortKey/sortDir (unknown years last). */
    function compareFiles(metaA, nameA, metaB, nameB) {
        if (sortKey === 'year') {
            const ya = yearNum(metaA), yb = yearNum(metaB);
            const na = isNaN(ya), nb = isNaN(yb);
            if (na && nb) return nameA.localeCompare(nameB);
            if (na) return 1;
            if (nb) return -1;
            if (ya !== yb) return sortDir === 'asc' ? ya - yb : yb - ya;
            return nameA.localeCompare(nameB);
        }
        return sortDir === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
    }

    /** Sorted copy of search matches (index entries) by the current sort. */
    function sortMatches(list) {
        const nameOf = (e) => e.t || e.p.split('/').pop();
        return list.slice().sort((a, b) => compareFiles(a, nameOf(a), b, nameOf(b)));
    }

    // Fold case + diacritics so a plain-ASCII query matches accented metadata
    // ("bjorn" -> "Björn"). NFKD splits an accented letter into its base letter
    // plus combining marks; stripping the marks (U+0300-U+036F) leaves the base.
    function foldDiacritics(s) {
        return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    }

    // In local dev the raw HVSC .sid files aren't present until they're extracted
    // from the committed archive, so /HVSC/*.sid requests 404. Turn that bare 404
    // into an actionable hint instead of a cryptic error.
    function hvscFetchHint(message) {
        const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
        if (local && /\/HVSC\/.*\b40[43]\b/.test(message || '')) {
            return 'The HVSC .sid files are not on this local server. They are extracted '
                + 'from hvsc-data/*.7z at build time — run "npm run extract-hvsc" to '
                + 'populate public/HVSC, then reload.';
        }
        return message;
    }
    window.hvscFetchHint = hvscFetchHint;

    // List header, injected above the file list on every host page: folder
    // navigation (home/up) sits right next to the listing it acts on, and the
    // Name/Year column headers are clickable to sort (click again to flip).
    function buildListHeader() {
        if (document.getElementById('hvscListHeader')) return;
        const fileList = document.getElementById('fileList');
        if (!fileList || !fileList.parentNode) return;
        const bar = document.createElement('div');
        bar.id = 'hvscListHeader';
        bar.className = 'hvsc-listheader';
        bar.innerHTML =
            '<button type="button" class="btn hvsc-nav-btn" id="homeBtn" title="Collection root"><i class="fas fa-home"></i></button>'
            + '<button type="button" class="btn hvsc-nav-btn" id="upBtn" title="Up one folder"><i class="fas fa-level-up-alt"></i></button>'
            + '<button type="button" class="hvsc-col hvsc-col-name" data-key="name">Name <i class="fas fa-arrow-up"></i></button>'
            + '<button type="button" class="hvsc-col hvsc-col-year" data-key="year">Year <i></i></button>';
        fileList.parentNode.insertBefore(bar, fileList);
        bar.querySelector('#homeBtn').addEventListener('click', navigateHome);
        bar.querySelector('#upBtn').addEventListener('click', navigateUp);
        bar.querySelectorAll('.hvsc-col').forEach((btn) => {
            btn.addEventListener('click', () => onSortClick(btn.dataset.key));
        });
        updateListHeader();
    }

    function onSortClick(key) {
        if (key === sortKey) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            sortKey = key;
            sortDir = key === 'year' ? 'desc' : 'asc'; // year defaults to newest first
        }
        try { localStorage.setItem('hvsc-sort', JSON.stringify({ key: sortKey, dir: sortDir })); }
        catch (e) { /* ok */ }
        updateListHeader();
        reRenderCurrentView();
    }

    function updateListHeader() {
        const bar = document.getElementById('hvscListHeader');
        if (!bar) return;
        bar.querySelectorAll('.hvsc-col').forEach((btn) => {
            const active = btn.dataset.key === sortKey;
            btn.classList.toggle('active', active);
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = active
                    ? 'fas ' + (sortDir === 'asc' ? 'fa-arrow-up' : 'fa-arrow-down')
                    : '';
            }
        });
    }

    function reRenderCurrentView() {
        if (searchMode && lastSearchMatches) {
            renderSearchResults(sortMatches(lastSearchMatches), SEARCH_RESULT_LIMIT);
        } else {
            entries = listDirectory(currentPath);
            renderEntries();
            updateItemCount();
        }
    }

    // Short-lived access token (from /hvsc-token) appended to SID requests so
    // the edge guard can distinguish real playback from bulk scraping. When
    // token gating is disabled server-side, /hvsc-token returns an empty token
    // and URLs are just plain static paths.
    let accessToken = null;
    let accessTokenExp = 0;   // unix seconds
    let tokenPromise = null;

    function ensureToken() {
        const nowSec = Date.now() / 1000;
        if (accessToken && nowSec < accessTokenExp - 30) return Promise.resolve(accessToken);
        if (tokenPromise) return tokenPromise;
        tokenPromise = fetch('/hvsc-token')
            .then((r) => (r.ok ? r.json() : {}))
            .then((d) => {
                accessToken = d.token || null;
                accessTokenExp = d.exp || 0;
                tokenPromise = null;
                return accessToken;
            })
            .catch(() => { tokenPromise = null; return null; });
        return tokenPromise;
    }

    /** URL for a SID path (each segment encoded), carrying the access token. */
    function sidUrl(p) {
        let u = '/HVSC/' + p.split('/').map(encodeURIComponent).join('/');
        if (accessToken) u += '?t=' + encodeURIComponent(accessToken);
        return u;
    }

    // The SIDquake tool can't export RSID tunes (they need a real C64 env), so
    // in the tool we grey them out and block selection — but they still play in
    // the preview. When the browser is embedded elsewhere it's a general SID
    // player, so RSID is treated normally (no marking, fully selectable).
    function isEmbed() { return !!window.HVSC_EMBED; }
    function isUnsupported(meta) { return !isEmbed() && !!meta && meta.f === 'R'; }

    // ---- Shareable tune URLs ----
    // A tune can be addressed with ?tune=<path within the collection> (the
    // constant "C64Music/" prefix is optional). While the user previews tunes
    // the address bar is kept in sync via history.replaceState, so the current
    // URL is always shareable; the Share button copies a canonical main-page
    // link explicitly. Deep links are honoured by initializeHVSC on all three
    // hosts (tool modal, standalone page, embed).

    /** Index path ("C64Music/...") from a ?tune= value; null if empty. */
    function normalizeTunePath(raw) {
        if (!raw) return null;
        let p = raw.replace(/^\/+/, '').replace(/^HVSC\//, '');
        if (p !== ROOT && !p.startsWith(ROOT + '/')) p = ROOT + '/' + p;
        return p;
    }

    function getTuneParamFromUrl() {
        try { return new URLSearchParams(location.search).get('tune'); }
        catch (_) { return null; }
    }

    /** ?tune= value for an index path: drop the constant prefix, keep slashes readable. */
    function tuneParamValue(path) {
        const short = path.startsWith(ROOT + '/') ? path.substring(ROOT.length + 1) : path;
        return short.split('/').map(encodeURIComponent).join('/');
    }

    /** Copy of urlLike with the tune param set (path=null removes it). */
    function withTuneParam(urlLike, path) {
        const u = new URL(urlLike);
        u.searchParams.delete('tune');
        // Append manually instead of searchParams.set() so '/' stays literal
        // (readable URLs); URLSearchParams would escape it to %2F.
        let q = u.searchParams.toString();
        if (path) {
            const pair = 'tune=' + tuneParamValue(path);
            q = q ? q + '&' + pair : pair;
        }
        u.search = q ? '?' + q : '';
        return u.href;
    }

    /** Keep the address bar pointing at the previewed tune (not in embeds). */
    function updateShareUrl(path) {
        if (isEmbed()) return;
        try { history.replaceState(history.state, '', withTuneParam(location.href, path)); }
        catch (_) { /* e.g. file:// — non-fatal */ }
    }

    /** Remove the tune param (called when the browser modal closes). */
    function clearShareUrl() { updateShareUrl(null); }

    /** Canonical share link for a tune: the main page, which auto-opens here. */
    function shareUrlFor(path) {
        return location.origin + '/?tune=' + tuneParamValue(path);
    }

    /** Copy the share link for the current selection; flashes the button. */
    async function shareTune() {
        if (!currentSelection || currentSelection.isDirectory) return false;
        const url = shareUrlFor(currentSelection.path);
        let ok = false;
        try {
            await navigator.clipboard.writeText(url);
            ok = true;
        } catch (_) {
            try {
                const ta = document.createElement('textarea');
                ta.value = url;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (_) { /* clipboard unavailable */ }
        }
        const btn = document.getElementById('hvscShareBtn');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = ok
                ? '<i class="fas fa-check"></i> Link Copied!'
                : '<i class="fas fa-times"></i> Copy failed';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1600);
        }
        return ok;
    }

    // FNV-1a low 12 bits, the shard a tune's metadata lives in. Must match
    // scripts/build-share-meta.js and netlify/edge-functions/tune-og.js - see
    // the note there on Math.imul and on 12 bits.
    function shareShardOf(p) {
        let h = 0x811c9dc5;
        for (let i = 0; i < p.length; i++) {
            h ^= p.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return ((h >>> 0) & 0xfff).toString(16).padStart(3, '0');
    }

    // A shared link arrives with exactly one tune in mind, and waiting for the
    // ~2 MB collection index before a note is heard is the whole cost of
    // arriving that way. The share-meta shard the edge function already reads to
    // build the link preview is ~1.5 KB and holds everything playback needs, so
    // start there; the index catches up in its own time for browsing.
    async function quickPlayFromShard(rawPath) {
        const path = normalizeTunePath(rawPath);
        if (!path) return false;
        const key = path.startsWith(ROOT + '/') ? path.substring(ROOT.length + 1) : path;
        try {
            const res = await fetch('share-meta/' + shareShardOf(key) + '.json');
            if (!res.ok) return false;
            const table = await res.json();
            if (!table[key]) return false;
            deepLinkPlaying = path;
            autoplayNext = true;
            await previewSID({ path, name: path.split('/').pop(), isDirectory: false });
            return true;
        } catch (_) {
            return false;   // no shards deployed; the index path still works
        }
    }

    /**
     * Deep link: navigate to a tune's folder, select it and load its preview.
     * Returns false when the path isn't in the index (caller falls back).
     */
    async function openTuneByPath(rawPath) {
        const path = normalizeTunePath(rawPath);
        if (!path) return false;
        try { await loadSearchIndex(); } catch (_) { return false; }
        if (!metaByPath || !metaByPath.get(path)) return false;
        const slash = path.lastIndexOf('/');
        await fetchDirectory(slash === -1 ? ROOT : path.substring(0, slash));
        const entry = entries.find((e) => !e.isDirectory && e.path === path);
        if (!entry) return false;
        currentSelection = entry;
        syncChooseButton();
        const fileList = document.getElementById('fileList');
        if (fileList) {
            fileList.querySelectorAll('.file-item').forEach((item) => {
                const sel = item.dataset.path === entry.path;
                item.classList.toggle('selected', sel);
                if (sel) item.scrollIntoView({ block: 'center' });
            });
            updateRowTabStops(fileList);
        }
        // Deep-linked tunes should start playing on arrival. If the browser
        // blocks the AudioContext (no gesture yet), sid-playback.js retries
        // on the first interaction.
        // Already playing from the share-meta shard: reloading it here would
        // restart the tune from the beginning just as the index lands.
        if (deepLinkPlaying === entry.path) {
            deepLinkPlaying = null;
            updateInfoPanel(entry);
            return true;
        }
        autoplayNext = true;
        previewSID(entry);
        return true;
    }

    function initializeHVSC() {
        if (hvscInitialized) {
            // Reopening the browser: restart the visualizer so it renders a
            // fresh zero baseline (the loop was stopped when it last closed).
            startVisualizer();
            return;
        }
        hvscInitialized = true;
        wireSearch();
        buildListHeader();
        syncChooseButton();
        // Warm up the playback engine in the background while the user browses,
        // so the Play button is responsive on the very first tune instead of
        // stalling on a cold WASM/audio-worklet load.
        warmUpPlayback();
        // Fetch an access token early so the first play/download isn't delayed
        // by the token round-trip.
        ensureToken();
        // Deep links: ?tune=<path> selects and loads a specific tune (all
        // hosts); embedders can also deep-link into a folder via ?start=...
        // (window.HVSC_EMBED_START).
        const startPath = (typeof window !== 'undefined' && window.HVSC_EMBED_START) || ROOT;
        const tuneParam = (typeof window !== 'undefined' && window.HVSC_EMBED_TUNE) || getTuneParamFromUrl();
        // Sound first, listing second: don't make a shared link wait for the index.
        if (tuneParam) quickPlayFromShard(tuneParam);
        loadSearchIndex()
            .then(async () => {
                if (tuneParam && await openTuneByPath(tuneParam)) return;
                return fetchDirectory(startPath);
            })
            .catch((err) => {
                console.error('Failed to load HVSC index:', err);
                document.getElementById('fileList').innerHTML =
                    '<div class="error-message">Could not load the HVSC index. '
                    + 'Run <code>npm run build-hvsc-index</code> to generate '
                    + '<code>public/hvsc-index.json</code>.</div>';
                if (window.showError) {
                    window.showError('Failed to load HVSC index', {
                        details: err.message, duration: 0
                    });
                }
            });
    }

    async function ensurePlayerReady() {
        if (hvscPlayer) return;
        // Load all playback dependencies: WASM + playback engine + player UI
        if (window.loadScript) {
            if (typeof SIDPlayer === 'undefined') {
                await window.loadScript('sid-player.js');
            }
            if (typeof getSharedSIDPlayback === 'undefined') {
                await window.loadScript('sid-playback.js');
                // Only the legacy resid fallback lives inside sidquake.wasm;
                // the default fp engine lazily fetches sidplayfp.js itself.
                if (SIDPlayback.engineName() === 'resid') {
                    await window.loadScript('sidquake.js');
                }
            }
        }
        const container = document.getElementById('hvscPlayerContainer');
        if (container && typeof SIDPlayer !== 'undefined') {
            hvscPlayer = new SIDPlayer(container);
        }
    }

    // Preload the playback engine (scripts + WASM compile + audio worklet) in
    // the background so the first tune's Play button is responsive instead of
    // waiting on a cold init. Fire-and-forget; failures are harmless because
    // the first real playback will just initialize on demand as before.
    let warmupStarted = false;
    async function warmUpPlayback() {
        if (warmupStarted) return;
        warmupStarted = true;
        try {
            await ensurePlayerReady();
            if (typeof getSharedSIDPlayback === 'function') {
                await getSharedSIDPlayback().init();
            }
            await setupVisualizer();
            startVisualizer();
        } catch (_) {
            warmupStarted = false; // allow a later retry on real playback
        }
    }

    // Spectrum visualizer at the bottom of the browser. Set up once the
    // playback engine + its analyser exist; it animates while the modal is open
    // (idle bars when nothing plays) and is stopped when the browser closes.
    let vizReady = false;
    async function setupVisualizer() {
        if (vizReady) return;
        const canvasEl = document.getElementById('hvscVizCanvas');
        if (!canvasEl) return;
        // Load the module unless it's genuinely present (an .init method). NB:
        // don't just check `typeof hvscVisualizer === 'undefined'` — an element
        // with a matching id would shadow the global as a named-access property.
        const moduleMissing = () => typeof hvscVisualizer === 'undefined' || typeof hvscVisualizer.init !== 'function';
        if (window.loadScript && moduleMissing()) {
            await window.loadScript('hvsc-visualizer.js');
        }
        if (moduleMissing()) return;
        const pb = getSharedSIDPlayback();
        await pb.init();
        const analyser = pb.getAnalyser ? pb.getAnalyser() : null;
        if (!analyser) return;
        // Predicate so the visualizer only reads the analyser while audio is
        // actually flowing (otherwise bars sit on the idle demo wave). Uses
        // isAudible, not `playing`: with autoplay blocked pre-gesture the
        // intent is "playing" but the context is suspended and silent.
        hvscVisualizer.init(canvasEl, analyser, () => {
            try {
                const p = getSharedSIDPlayback();
                return p.isAudible ? p.isAudible() : !!p.playing;
            } catch (_) { return false; }
        });
        vizReady = true;
    }

    async function startVisualizer() {
        try { await setupVisualizer(); } catch (_) { /* non-fatal */ }
        if (vizReady && typeof hvscVisualizer !== 'undefined') {
            hvscVisualizer.reset();   // clean slate for a new tune / reopen
            hvscVisualizer.start();
        }
    }
    function stopVisualizer() {
        if (vizReady && typeof hvscVisualizer !== 'undefined') {
            hvscVisualizer.stop();
            hvscVisualizer.reset();   // wipe frozen bars on close
        }
    }

    // STIL commentary, split out of the index because it is a third of it and is
    // read one entry at a time. Folded back onto the entries when it lands, and
    // the per-entry search haystacks are dropped so they rebuild including it.
    let stilSplit = false;
    let stilPromise = null;
    let stilLoaded = false;

    function loadStil(onReady) {
        if (!stilSplit || stilLoaded) return Promise.resolve(false);
        if (!stilPromise) {
            stilPromise = fetch('hvsc-stil.json')
                .then((res) => (res.ok ? res.json() : {}))
                .then((table) => {
                    for (const e of (searchIndex && searchIndex.entries) || []) {
                        const text = table[e.p];
                        if (text) e.s = text;
                        // Built lazily and cached; drop it so commentary counts.
                        delete e._hay;
                    }
                    stilLoaded = true;
                    return true;
                })
                .catch(() => { stilPromise = null; return false; });
        }
        return onReady ? stilPromise.then((ok) => { if (ok) onReady(); return ok; }) : stilPromise;
    }

    /**
     * Say how the collection index is coming along. It is 7.5 MB, and until it
     * lands the file list is a spinner with nothing to read - which on a phone
     * is many seconds of a page that looks stuck rather than busy.
     * @param {{loaded:number,total:number}|null} at - null while the size is unknown
     */
    function indexProgress(at) {
        const box = document.querySelector('#fileList .file-list-loading');
        if (!box) return;
        let line = box.querySelector('.file-list-loading-text');
        if (!line) {
            line = document.createElement('p');
            line.className = 'file-list-loading-text';
            // Polite: it updates every chunk, and a screen reader must not read
            // out every percentage.
            line.setAttribute('aria-live', 'polite');
            box.appendChild(line);
        }
        const mb = (n) => (n / (1024 * 1024)).toFixed(1);
        line.textContent = at && at.total
            ? `Loading the collection — ${mb(at.loaded)} of ${mb(at.total)} MB`
            : 'Loading the collection…';
    }

    /** Fetch and parse an index file, reporting progress as it arrives. */
    function readIndex(url) {
        // Say something before the request has even been answered: on a slow
        // connection the wait for headers is itself several seconds of a page
        // that looks stuck.
        indexProgress(null);
        return fetch(url).then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const total = Number(res.headers.get('content-length')) || 0;
            // No body reader (or no length): fall back to a plain parse rather
            // than losing the index for the sake of a progress line.
            if (!res.body || !res.body.getReader) { indexProgress(null); return res.json(); }
            const reader = res.body.getReader();
            const chunks = [];
            let loaded = 0;
            indexProgress({ loaded: 0, total });
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
                indexProgress({ loaded, total });
            }
            const buf = new Uint8Array(loaded);
            let at = 0;
            for (const c of chunks) { buf.set(c, at); at += c.length; }
            return JSON.parse(new TextDecoder().decode(buf));
        });
    }

    function loadSearchIndex() {
        if (searchIndex) return Promise.resolve(searchIndex);
        if (searchIndexPromise) return searchIndexPromise;
        // Deep-linked pages start this fetch in an early inline script so the
        // index downloads while the UI scripts are still loading.
        //
        // The lite index is the same thing without the STIL commentary - about a
        // third of it, read one entry at a time - which loadStil() fetches
        // separately when something actually needs it. A deploy that has not run
        // build-index-split.js falls back to the full file.
        const source = window.hvscIndexPrefetch
            ? window.hvscIndexPrefetch.then((data) => { indexProgress(null); return data; })
            : readIndex('hvsc-index-lite.json')
                .catch(() => readIndex('hvsc-index.json'));
        window.hvscIndexPrefetch = null;   // adopt once; retries fetch fresh
        searchIndexPromise = source
            .then((data) => {
                searchIndex = data;
                stilSplit = !!data.stilSplit;
                buildTree(data.entries || []);
                updateVersionBadge(data.hvsc);
                return data;
            })
            .catch((err) => {
                searchIndexPromise = null;
                throw err;
            });
        return searchIndexPromise;
    }

    /** Show "HVSC #NN" in the modal header when the index records a version. */
    function updateVersionBadge(version) {
        const badge = document.getElementById('hvscVersionBadge');
        if (!badge) return;
        if (version) {
            badge.textContent = `HVSC #${version}`;
            badge.title = `This mirror is current with HVSC Update #${version}`;
            badge.hidden = false;
        } else {
            badge.hidden = true;
        }
    }

    /** Build the directory tree + path->metadata map from the flat index. */
    function buildTree(all) {
        dirMap = new Map();
        metaByPath = new Map();

        const getDir = (d) => {
            let node = dirMap.get(d);
            if (!node) { node = { dirs: new Set(), files: [] }; dirMap.set(d, node); }
            return node;
        };

        // 61,157 tunes share about 1,950 directories, and the index lists them
        // clustered by folder, so remembering the last one skips the segment
        // walk for the great majority of entries.
        let lastDir = null;
        let lastNode = null;

        for (let i = 0; i < all.length; i++) {
            const e = all[i];
            const p = e.p;
            metaByPath.set(p, e);

            const slash = p.lastIndexOf('/');
            const dir = slash === -1 ? '' : p.substring(0, slash);
            const name = slash === -1 ? p : p.substring(slash + 1);

            if (dir !== lastDir) {
                // Walk the prefix once, registering each segment under its
                // parent as it goes. Slicing and re-joining a segment array
                // here used to cost more than the rest of the index load
                // together.
                let node = getDir('');
                let at = 0;
                while (at < dir.length) {
                    let next = dir.indexOf('/', at);
                    if (next === -1) next = dir.length;
                    node.dirs.add(dir.substring(at, next));
                    node = getDir(dir.substring(0, next));
                    at = next + 1;
                }
                lastDir = dir;
                lastNode = node;
            }
            lastNode.files.push({ name, path: p, meta: e });
        }
    }

    /** List a directory from the tree as {name, path, isDirectory} entries. */
    function listDirectory(dirPath) {
        const node = dirMap && dirMap.get(dirPath);
        const out = [];
        if (!node) return out;
        node.dirs.forEach((childName) => {
            out.push({
                name: childName,
                path: dirPath ? `${dirPath}/${childName}` : childName,
                isDirectory: true,
            });
        });
        node.files.forEach((f) => {
            out.push({ name: f.name, path: f.path, isDirectory: false, meta: f.meta });
        });
        out.sort(compareEntries);
        return out;
    }

    async function fetchDirectory(path) {
        // Remember the scroll position of the directory we're leaving (only when
        // browsing, not searching), so going back up returns you to where you
        // were; going into a new directory starts at the top.
        const leavingList = document.getElementById('fileList');
        if (leavingList && !searchMode) scrollByPath.set(currentPath, leavingList.scrollTop);

        // Navigating into a directory clears any active search
        if (searchMode) {
            const input = document.getElementById('hvscSearchBar');
            const clearBtn = document.getElementById('hvscSearchClear');
            if (input) input.value = '';
            if (clearBtn) clearBtn.style.display = 'none';
            searchMode = false;
            const header = document.getElementById('filePanelHeader');
            if (header) header.textContent = 'Files & Directories';
        }

        if (path.endsWith('/')) path = path.slice(0, -1);

        try {
            await loadSearchIndex();
        } catch (err) {
            document.getElementById('fileList').innerHTML =
                '<div class="error-message">Failed to load HVSC index.</div>';
            return;
        }

        entries = listDirectory(path);
        currentPath = path;
        renderEntries();
        updateItemCount();
        updatePathBar();
        clearInfoPanel();

        // Restore the scroll position for a directory we've visited before
        // (e.g. after going back up); otherwise start at the top.
        const newList = document.getElementById('fileList');
        if (newList) newList.scrollTop = scrollByPath.has(path) ? scrollByPath.get(path) : 0;
    }

    function handleItemClick(e, entry) {
        document.querySelectorAll('.file-item').forEach(item => {
            item.classList.remove('selected');
        });

        e.currentTarget.classList.add('selected');
        updateRowTabStops();
        currentSelection = entry;
        syncChooseButton();

        if (!entry.isDirectory) {
            previewSID(entry);
        }
    }

    function updateInfoPanel(entry) {
        const content = document.getElementById('sidInfoContent');
        if (!content) return;

        const player = getSharedSIDPlayback();
        const title = player.getTitle() || '';
        const author = player.getAuthor() || '';
        const copyright = player.getCopyright() || '';
        const subtunes = player.getSubtuneCount() || 1;
        const sidCount = player.getSIDCount() || 1;
        const sidModel = player.getSIDModel();
        const isNTSC = player.isNTSC();

        const loadAddr = player.getLoadAddress();
        const initAddr = player.getInitAddress();
        const playAddr = player.getPlayAddress();
        const dataSize = player.getDataSize();

        const modelNames = { 0: 'Unknown', 1: 'MOS 6581', 2: 'MOS 8580', 3: '6581 + 8580' };
        const modelStr = modelNames[sidModel] || 'Unknown';
        const clockStr = isNTSC ? 'NTSC' : 'PAL';
        const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');
        const endAddr = loadAddr + dataSize;

        // STIL comment (from the index) if we have one for this path. When it has
        // been split out, fetch it and redraw this panel once it arrives.
        const meta = entry.meta || (metaByPath && metaByPath.get(entry.path));
        const stil = meta && meta.s ? meta.s : '';
        if (!stil && stilSplit && !stilLoaded) {
            loadStil(() => {
                if (currentSelection && currentSelection.path === entry.path) updateInfoPanel(entry);
            });
        }

        let html = '';
        if (isUnsupported(entry.meta)) html += `<div class="sid-info-note">RSID — preview only; not usable in the SIDquake tool.</div>`;
        if (title) html += `<div class="sid-info-row"><span class="sid-info-label">Title</span><span class="sid-info-value">${escapeHtml(title)}</span></div>`;
        if (author) html += `<div class="sid-info-row"><span class="sid-info-label">Author</span><span class="sid-info-value">${escapeHtml(author)}</span></div>`;
        if (copyright) html += `<div class="sid-info-row"><span class="sid-info-label">Copyright</span><span class="sid-info-value">${escapeHtml(copyright)}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">Subtunes</span><span class="sid-info-value">${subtunes}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">SID Chip</span><span class="sid-info-value">${modelStr}</span></div>`;
        if (sidCount > 1) html += `<div class="sid-info-row"><span class="sid-info-label">SID Count</span><span class="sid-info-value">${sidCount}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">Clock</span><span class="sid-info-value">${clockStr}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">Load Address</span><span class="sid-info-value">${hex(loadAddr)}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">Init Address</span><span class="sid-info-value">${hex(initAddr)}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">Play Address</span><span class="sid-info-value">${playAddr ? hex(playAddr) : 'IRQ'}</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">Memory Used</span><span class="sid-info-value">${hex(loadAddr)} - ${hex(endAddr)} (${dataSize} bytes)</span></div>`;
        html += `<div class="sid-info-row"><span class="sid-info-label">File</span><span class="sid-info-value">${escapeHtml(entry.name)}</span></div>`;
        if (stil) html += `<div class="sid-info-stil"><span class="sid-info-label">STIL</span><span class="sid-info-value">${escapeHtml(stil)}</span></div>`;
        html += `<div class="sid-info-download">`
            + `<button class="btn" onclick="hvscBrowser.downloadSID()"><i class="fas fa-download"></i> Download SID</button> `
            + `<button class="btn" id="hvscShareBtn" onclick="hvscBrowser.shareTune()" title="Copy a link that opens this tune"><i class="fas fa-share-alt"></i> Share Link</button>`
            + `</div>`;

        content.innerHTML = html;
        markInfoPanel(true);
    }

    function clearInfoPanel() {
        const content = document.getElementById('sidInfoContent');
        if (content) {
            content.innerHTML = '<div class="sid-info-placeholder">Select a SID file to view details</div>';
        }
        markInfoPanel(false);
    }

    // Whether the panel holds real details or just its placeholder — on a
    // phone the placeholder is dropped entirely so the listing gets the room.
    function markInfoPanel(hasInfo) {
        const panel = document.getElementById('sidInfoPanel');
        if (panel) panel.classList.toggle('has-info', hasInfo);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async function downloadSID() {
        if (!currentSelection || currentSelection.isDirectory) return;
        await ensureToken();
        const a = document.createElement('a');
        a.href = sidUrl(currentSelection.path);
        a.download = currentSelection.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    let autoplayNext = false;
    // Path already started from the share-meta shard, so the index-driven
    // deep-link path knows not to reload it.
    let deepLinkPlaying = null;

    async function previewSID(entry) {
        updateShareUrl(entry.path);
        await ensureToken();
        await ensurePlayerReady();
        startVisualizer();
        if (hvscPlayer) {
            const wasPlaying = hvscPlayer.isPlaying;
            const startNow = autoplayNext;
            autoplayNext = false;
            const player = getSharedSIDPlayback();
            player.setLoadCallback(() => {
                hvscPlayer.onLoaded(entry.name);
                updateInfoPanel(entry);
                if (wasPlaying || startNow) {
                    hvscPlayer.play();
                }
            });
            hvscPlayer.stop();
            hvscPlayer.takeOwnership();
            player.loadFromUrl(sidUrl(entry.path)).catch((err) => {
                console.error('HVSC preview load failed:', err);
                if (window.showError) {
                    window.showError('Could not load tune', { details: hvscFetchHint(err.message) });
                }
            });
        }
    }

    function stopPreview() {
        stopVisualizer();
        if (hvscPlayer) {
            // Clear any pending load callback to prevent late autoplay
            const player = getSharedSIDPlayback();
            player.setLoadCallback(null);
            hvscPlayer.stop();
        }
    }

    // Double-click (double-tap) opens a folder, or takes a tune — the same
    // shortcut for both, alongside the explicit Select button. Single-click on
    // a tune only selects and previews it.
    function handleItemDoubleClick(entry) {
        if (entry.isDirectory) {
            let cleanPath = entry.path;
            if (cleanPath.endsWith('/')) {
                cleanPath = cleanPath.slice(0, -1);
            }
            fetchDirectory(cleanPath);
        } else {
            selectSID();
        }
    }

    // Make a file/directory row keyboard-operable. Enter mirrors the mouse:
    // open a folder, select-and-preview a tune, and — pressed again on the tune
    // already selected — take it, the way a second click does.
    // The listing is a listbox, not a pile of buttons. Every row used to be its
    // own tab stop with no arrow keys, so reaching the Select button past 200
    // search results meant 200 presses of Tab.
    function makeRowKeyboardAccessible(item, entry) {
        item.tabIndex = -1;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected',
            currentSelection && currentSelection.path === entry.path ? 'true' : 'false');
        item.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (entry.isDirectory) handleItemDoubleClick(entry);
            else if (currentSelection && currentSelection.path === entry.path) selectSID();
            else handleItemClick(e, entry);
        });
    }

    /** The row that carries the listbox's single tab stop. */
    function rowTabStop(list) {
        return list.querySelector('.file-item.selected') || list.querySelector('.file-item');
    }

    // Roving tabindex: exactly one row is tabbable at a time, and it follows the
    // selection so returning to the list lands where the user left off.
    function updateRowTabStops(list) {
        const el = list || document.getElementById('fileList');
        if (!el) return;
        const stop = rowTabStop(el);
        for (const item of el.querySelectorAll('.file-item')) {
            item.tabIndex = item === stop ? 0 : -1;
            item.setAttribute('aria-selected', item.classList.contains('selected') ? 'true' : 'false');
        }
    }

    // Arrow keys, Home/End and type-ahead over the listing. Bound once to the
    // list itself so it survives every re-render of its rows.
    function wireListKeyboard() {
        const list = document.getElementById('fileList');
        if (!list || list.dataset.keysWired === '1') return;
        list.dataset.keysWired = '1';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', 'Tunes and folders');

        let typed = '', typedAt = 0;
        list.addEventListener('keydown', (e) => {
            const rows = [...list.querySelectorAll('.file-item')];
            if (!rows.length) return;
            const here = e.target.closest('.file-item');
            const i = here ? rows.indexOf(here) : 0;
            let next = null;
            switch (e.key) {
                case 'ArrowDown': next = rows[Math.min(i + 1, rows.length - 1)]; break;
                case 'ArrowUp': next = rows[Math.max(i - 1, 0)]; break;
                case 'Home': next = rows[0]; break;
                case 'End': next = rows[rows.length - 1]; break;
                case 'PageDown': next = rows[Math.min(i + 10, rows.length - 1)]; break;
                case 'PageUp': next = rows[Math.max(i - 10, 0)]; break;
                default: {
                    // Type-ahead: a printable key jumps to the next row starting
                    // with what has been typed in the last second.
                    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
                    const now = Date.now();
                    typed = (now - typedAt < 1000 ? typed : '') + e.key.toLowerCase();
                    typedAt = now;
                    const from = i + (typed.length > 1 ? 0 : 1);
                    const order = rows.slice(from).concat(rows.slice(0, from));
                    next = order.find(r => (r.textContent || '').trim().toLowerCase().startsWith(typed));
                    if (!next) return;
                    break;
                }
            }
            e.preventDefault();
            if (!next) return;
            for (const r of rows) r.tabIndex = r === next ? 0 : -1;
            next.focus();
            next.scrollIntoView({ block: 'nearest' });
        });
    }

    function navigateUp() {
        if (!currentPath || currentPath === '' || currentPath === ROOT) {
            return;
        }

        let cleanPath = currentPath;
        if (cleanPath.endsWith('/')) {
            cleanPath = cleanPath.slice(0, -1);
        }

        const parts = cleanPath.split('/');
        parts.pop();

        const parentPath = parts.join('/');
        fetchDirectory(parentPath || ROOT);
    }

    function navigateHome() {
        fetchDirectory(ROOT);
    }

    function updatePathBar() {
        const pathDisplay = currentPath ? '/' + currentPath : '/';
        const bar = document.getElementById('pathBar');
        if (bar) {
            // Plain-text span on current pages; tolerate the old input too.
            if (bar.tagName === 'INPUT') bar.value = pathDisplay;
            else bar.textContent = pathDisplay;
        }
        const up = document.getElementById('upBtn');
        if (up) up.disabled = !currentPath || currentPath === '' || currentPath === ROOT;
    }

    // The Select button is the main way out of the browser, so it has to say
    // whether it will do anything: live only once a tune (not a folder) is
    // selected. RSID tunes keep it live and answer with the inline note.
    function syncChooseButton() {
        const usable = !!(currentSelection && !currentSelection.isDirectory);
        document.querySelectorAll('.hvsc-choose-btn').forEach((btn) => {
            btn.disabled = !usable;
        });
    }

    function selectSID() {
        if (currentSelection && !currentSelection.isDirectory) {
            // In the SIDquake tool, RSID tunes can't be exported — don't let
            // them be chosen (they remain previewable). No pop-up: the row is
            // greyed/tagged and we show an inline note instead.
            if (isUnsupported(currentSelection.meta)) {
                notifyUnsupported();
                return;
            }
            stopPreview();
            clearShareUrl();   // browser is closing: drop the tune from the URL
            emitSelection(currentSelection);
            const modal = document.getElementById('hvscModal');
            if (modal) {
                modal.classList.remove('visible');
            }
        }
    }

    // "Cancel" in the modal's status bar: close without choosing a tune.
    function cancel() {
        stopPreview();
        clearShareUrl();
        const modal = document.getElementById('hvscModal');
        if (modal) modal.classList.remove('visible');
    }

    function notifyUnsupported() {
        const content = document.getElementById('sidInfoContent');
        if (content) {
            content.innerHTML = '<div class="sid-info-note">This is an <strong>RSID</strong> tune. '
                + 'It plays here for preview, but can’t be loaded into the SIDquake tool '
                + '(RSID needs a real C64 environment). Choose a PSID tune to use it in SIDquake.</div>';
        }
    }

    // Hand a chosen SID back to whoever is hosting the browser.
    //  - Standalone (the SIDquake modal): posts {type:'sid-selected'} to this
    //    same window, which ui.js already listens for.
    //  - Embedded (window.HVSC_EMBED set by hvsc-embed.html): posts to the
    //    parent frame using the documented embed contract, honouring the
    //    requested mode:
    //       'link' (default) -> metadata + a short-lived SID URL
    //       'file'           -> also transfers the SID bytes (ArrayBuffer)
    //       'play'           -> preview only; announces the playing tune
    function emitSelection(entry) {
        ensureToken().then(() => {
            const meta = entry.meta || (metaByPath && metaByPath.get(entry.path)) || {};
            const absUrl = new URL(sidUrl(entry.path), location.href).href;
            const base = {
                name: entry.name,
                path: entry.path,
                url: absUrl,
                title: meta.t || '',
                author: meta.a || '',
                released: meta.r || '',
                stil: meta.s || '',
            };

            const cfg = window.HVSC_EMBED;
            if (!cfg) {
                window.postMessage({
                    type: 'sid-selected', name: base.name, path: base.path, url: base.url,
                }, '*');
                return;
            }

            const target = cfg.targetOrigin || '*';
            const mode = cfg.mode || 'link';

            // With an unknown parent origin (no ?origin= and no usable referrer,
            // so targetOrigin fell back to '*'), don't broadcast usable SID data
            // to an arbitrary framing page. Refuse the data-handover modes with a
            // clear instruction, and reduce 'play' to a metadata-only announce
            // (drop the tokened URL). Embedders that set ?origin= are unaffected.
            if (target === '*') {
                if (mode === 'play') {
                    const { url, ...safe } = base;
                    window.parent.postMessage({ type: 'hvsc:playing', ...safe }, '*');
                } else {
                    window.parent.postMessage({
                        type: 'hvsc:error',
                        message: 'Embed origin not set — add ?origin=https://your-site to the '
                            + 'hvsc-embed.html URL to receive selected tunes.',
                    }, '*');
                }
                return;
            }

            if (mode === 'file') {
                fetch(absUrl)
                    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                    .then((buf) => window.parent.postMessage(
                        { type: 'hvsc:selected', mode, ...base, bytes: buf }, target, [buf]))
                    .catch(() => window.parent.postMessage(
                        { type: 'hvsc:error', message: 'Could not fetch SID', ...base }, target));
            } else if (mode === 'play') {
                window.parent.postMessage({ type: 'hvsc:playing', ...base }, target);
            } else {
                window.parent.postMessage({ type: 'hvsc:selected', mode: 'link', ...base }, target);
            }
        });
    }

    // Enter opens the selected folder; tunes are chosen via the Select button.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !currentSelection || !currentSelection.isDirectory) return;

        // Don't hijack Enter while typing in an input (e.g. the search bar),
        // or while the browser modal is closed on the host page.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const modal = document.getElementById('hvscModal');
        if (modal && !modal.classList.contains('visible')) return;

        fetchDirectory(currentSelection.path);
    });

    function wireSearch() {
        const input = document.getElementById('hvscSearchBar');
        const clearBtn = document.getElementById('hvscSearchClear');
        if (!input || input.dataset.wired === '1') return;
        input.dataset.wired = '1';

        input.addEventListener('input', () => {
            const q = input.value.trim();
            clearBtn.style.display = q ? 'inline-flex' : 'none';
            if (searchDebounce) clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => runSearch(q), 150);
        });

        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.style.display = 'none';
            if (searchDebounce) clearTimeout(searchDebounce);
            exitSearchMode();
        });
    }

    function exitSearchMode() {
        if (!searchMode) return;
        searchMode = false;
        const header = document.getElementById('filePanelHeader');
        if (header) header.textContent = 'Files & Directories';
        // Repaint the current directory so selection/state is consistent
        entries = listDirectory(currentPath);
        renderEntries();
        updateItemCount();
    }

    function renderEntries() {
        const fileList = document.getElementById('fileList');
        cancelPendingRows();
        fileList.innerHTML = '';
        entries.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'file-item' + (entry.isDirectory ? ' directory' : '');
            const icon = entry.isDirectory
                ? '<i class="fas fa-folder"></i>'
                : '<i class="fas fa-music"></i>';
            const year = entry.isDirectory ? '' : yearLabel(entry.meta);
            const unsupported = !entry.isDirectory && isUnsupported(entry.meta);
            if (unsupported) {
                item.classList.add('unsupported');
                item.title = 'RSID — plays here for preview, but can’t be used in the SIDquake tool';
            }
            const tag = unsupported ? '<span class="file-tag">RSID</span>' : '';
            item.dataset.path = entry.path;
            // Keep the current selection highlighted across re-renders (sorting
            // re-paints the list; the Select button acts on this selection).
            if (currentSelection && !entry.isDirectory && entry.path === currentSelection.path) {
                item.classList.add('selected');
            }
            item.innerHTML = `
            <span class="file-icon">${icon}</span>
            <span class="file-name">${escapeHtml(entry.name)}</span>
            ${tag}
            ${entry.isDirectory ? '' : `<span class="file-year">${escapeHtml(year)}</span>`}
        `;
            item.onclick = (e) => handleItemClick(e, entry);
            item.ondblclick = () => handleItemDoubleClick(entry);
            makeRowKeyboardAccessible(item, entry);
            fileList.appendChild(item);
        });
        wireListKeyboard();
        updateRowTabStops(fileList);
    }

    function updateItemCount() {
        const sidCount = entries.filter(e => !e.isDirectory).length;
        const dirCount = entries.filter(e => e.isDirectory).length;
        let countText;
        if (sidCount > 0 && dirCount > 0) countText = `${sidCount} SID files, ${dirCount} folders`;
        else if (sidCount > 0) countText = `${sidCount} SID file${sidCount !== 1 ? 's' : ''}`;
        else if (dirCount > 0) countText = `${dirCount} folder${dirCount !== 1 ? 's' : ''}`;
        else countText = 'Empty folder';
        document.getElementById('itemCount').textContent = countText;
    }

    async function runSearch(query) {
        if (!query) {
            exitSearchMode();
            return;
        }

        searchMode = true;
        currentSelection = null;
        syncChooseButton();
        clearInfoPanel();
        const fileList = document.getElementById('fileList');
        const header = document.getElementById('filePanelHeader');
        if (header) header.textContent = 'Search Results';

        fileList.innerHTML = '<div class="file-list-loading"><div class="file-list-spinner"></div></div>';

        let index;
        try {
            index = await loadSearchIndex();
        } catch (err) {
            fileList.innerHTML =
                '<div class="error-message">Search index not available yet. '
                + 'Browse by folder, or ask the site maintainer to run '
                + '<code>npm run build-hvsc-index</code>.</div>';
            document.getElementById('itemCount').textContent = 'Search unavailable';
            return;
        }

        // Only render the latest query's results (guards against out-of-order fetches)
        const currentInput = document.getElementById('hvscSearchBar').value.trim();
        if (currentInput !== query) return;

        // Searching is what needs the commentary. Fetch it in the background and
        // re-run once it lands, so the first results appear straight away and
        // commentary matches fold in a moment later rather than everyone paying
        // for it up front.
        loadStil(() => {
            const live = document.getElementById('hvscSearchBar');
            if (live && live.value.trim() === query) runSearch(query);
        });

        const terms = query.toLowerCase().split(/\s+/).filter(Boolean).map(foldDiacritics);
        const matches = [];
        const all = index.entries;
        const limit = SEARCH_RESULT_LIMIT;

        // Match every entry (no early cut-off) so the reported count is the true
        // total and the capped list shown is the top of the chosen sort order,
        // not whichever entries happened to come first in index/path order.
        for (let i = 0; i < all.length; i++) {
            const e = all[i];
            // Search across title, author, path AND folded STIL text. The
            // haystack is built lazily and cached on the entry (the index is
            // immutable after load), lowercased and diacritic-folded so an
            // ASCII query matches accented names.
            let hay = e._hay;
            if (hay === undefined) {
                hay = e._hay = foldDiacritics(((e.t || '') + '\x00' + (e.a || '') + '\x00'
                    + (e.p || '') + '\x00' + (e.s || '')).toLowerCase());
            }
            let ok = true;
            for (let j = 0; j < terms.length; j++) {
                if (hay.indexOf(terms[j]) === -1) { ok = false; break; }
            }
            if (ok) matches.push(e);
        }

        lastSearchMatches = matches;
        renderSearchResults(sortMatches(matches), limit);
        const total = matches.length;
        const plural = total === 1 ? 'match' : 'matches';
        let countText = `${total} ${plural}`;
        if (total > limit) countText += ` (top ${limit} shown)`;
        document.getElementById('itemCount').textContent = countText;
    }

    /** Stop any part-painted result list before the next render replaces it. */
    function cancelPendingRows() {
        if (pendingRowPaint === null) return;
        cancelAnimationFrame(pendingRowPaint);
        pendingRowPaint = null;
    }

    /** One search-result row. */
    function buildResultRow(r) {
        const fileName = r.p.split('/').pop();
        const folder = r.p.substring(0, r.p.length - fileName.length - 1);
        const titleLine = r.t || fileName;
        const authorLine = r.a || '';
        const year = yearLabel(r);

        const unsupported = isUnsupported(r);
        const item = document.createElement('div');
        item.className = 'file-item search-result' + (unsupported ? ' unsupported' : '');
        if (unsupported) item.title = 'RSID — plays here for preview, but can’t be used in the SIDquake tool';
        item.innerHTML = `
            <span class="file-icon"><i class="fas fa-music"></i></span>
            <span class="search-result-text">
                <span class="search-result-title">${escapeHtml(titleLine)}${unsupported ? ' <span class="file-tag">RSID</span>' : ''}</span>
                ${authorLine ? `<span class="search-result-author">${escapeHtml(authorLine)}</span>` : ''}
                <span class="search-result-path">${escapeHtml(folder)}</span>
            </span>
            ${year ? `<span class="file-year">${escapeHtml(year)}</span>` : ''}
        `;

        const entry = { name: fileName, path: r.p, isDirectory: false, meta: r };
        item.dataset.path = r.p;
        const isSelected = currentSelection && r.p === currentSelection.path;
        if (isSelected) item.classList.add('selected');
        item.onclick = (e) => handleItemClick(e, entry);
        item.ondblclick = () => handleItemDoubleClick(entry);
        makeRowKeyboardAccessible(item, entry);
        return { item, isSelected };
    }

    function renderSearchResults(results, limit) {
        const fileList = document.getElementById('fileList');
        cancelPendingRows();
        fileList.innerHTML = '';

        if (results.length === 0) {
            fileList.innerHTML = '<div class="search-empty">No matching SIDs found.</div>';
            return;
        }

        const shown = results.slice(0, limit);

        // The arrow keys, type-ahead and tab stop all read the list live, so a
        // list that is still filling in behaves like a finished one - the rows
        // simply arrive over the next few frames.
        function paint(from) {
            const to = Math.min(from + RESULT_CHUNK, shown.length);
            const frag = document.createDocumentFragment();
            let hasSelected = false;
            for (let i = from; i < to; i++) {
                const { item, isSelected } = buildResultRow(shown[i]);
                if (isSelected) hasSelected = true;
                frag.appendChild(item);
            }
            fileList.appendChild(frag);
            if (from === 0) wireListKeyboard();
            // Only re-run the roving tabindex when the chunk changed which row
            // should carry it: the first chunk sets it, and a later chunk only
            // matters if it brought the selected row in.
            if (from === 0 || hasSelected) updateRowTabStops(fileList);
            if (to < shown.length) {
                pendingRowPaint = requestAnimationFrame(() => paint(to));
            } else {
                pendingRowPaint = null;
            }
        }
        paint(0);
    }

    return {
        navigateUp: navigateUp,
        navigateHome: navigateHome,
        fetchDirectory: fetchDirectory,
        stopPreview: stopPreview,
        downloadSID: downloadSID,
        initializeHVSC: initializeHVSC,
        openTuneByPath: openTuneByPath,
        shareTune: shareTune,
        clearShareUrl: clearShareUrl,
        chooseSong: selectSID,     // "Choose This Song" button (same as double-click)
        cancel: cancel,
        // Share the (large) parsed index with other modules (hvsc-random.js)
        // so they don't fetch and parse a second multi-MB copy.
        getIndexPromise: () => (searchIndex ? Promise.resolve(searchIndex) : searchIndexPromise)
    };
})();
