// hvsc-random.js - Random SID selector for the self-hosted HVSC collection.
// Picks a random tune straight from the search index (hvsc-index.json). If a
// curated list of path prefixes (hvsc-random.json) is present, the pick is
// restricted to tunes under those paths; otherwise the whole collection is used.

window.hvscRandom = (function () {

    let indexEntries = null;     // array of {p,t,a,r,s}
    let curatedPrefixes = [];    // optional path prefixes to bias toward
    let loadPromise = null;

    // Short-lived access token, same scheme as hvsc-browser.js. Random tunes can
    // be picked from the landing page without the browser module ever loading, so
    // this cannot rely on hvscBrowser's token closure and mirrors it instead (keep
    // the two in sync). When gating is disabled server-side /hvsc-token returns an
    // empty token and sidUrl() falls back to a plain static path (prior behaviour).
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

    function sidUrl(p) {
        let u = '/HVSC/' + p.split('/').map(encodeURIComponent).join('/');
        if (accessToken) u += '?t=' + encodeURIComponent(accessToken);
        return u;
    }

    // Curated prefixes are optional — ignore if missing. Only needed when the pick
    // is made against the FULL index; the pre-built pool is already filtered.
    async function loadCuratedPrefixes() {
        try {
            const cur = await fetch('hvsc-random.json');
            if (cur.ok) {
                const data = await cur.json();
                curatedPrefixes = (data.paths || []).map((p) =>
                    p.endsWith('/') ? p : p + '/');
            }
        } catch (_) { /* optional */ }
    }

    async function loadPaths() {
        if (indexEntries) return true;
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
            // 1. Reuse the index if the HVSC browser (or the deep-link prefetch)
            // already loaded it, instead of fetching anything at all.
            let index = null;
            const shared = window.hvscBrowser?.getIndexPromise?.();
            if (shared) {
                try { index = await shared; } catch (_) { /* fall through */ }
            }
            if (!index && window.hvscIndexPrefetch) {
                try { index = await window.hvscIndexPrefetch; } catch (_) { /* fall through */ }
            }
            if (index) {
                await loadCuratedPrefixes();
                indexEntries = index.entries || [];
                console.log(`HVSC random: ${indexEntries.length} tunes available (shared index)`);
                return true;
            }

            // 2. Otherwise take the pre-filtered pool. It holds exactly the paths
            // a random pick can return, at ~1/40th the transfer of the full index
            // — which is the whole cost of the Random SID button on a cold load.
            // Built by scripts/build-random-pool.js.
            try {
                const res = await fetch('hvsc-random-pool.json');
                if (res.ok) {
                    const pool = await res.json();
                    if (Array.isArray(pool.paths) && pool.paths.length) {
                        // Same shape the index gives us, minus the fields a random
                        // pick never reads (title/author/release/STIL).
                        indexEntries = pool.paths.map((p) => ({ p }));
                        curatedPrefixes = [];   // filtering already happened at build time
                        console.log(`HVSC random: ${indexEntries.length} tunes available (pool)`);
                        return true;
                    }
                }
            } catch (_) { /* fall through to the full index */ }

            // 3. Last resort: the full index, so a deploy without the pool file
            // still works exactly as it did before.
            await loadCuratedPrefixes();
            const res = await fetch('hvsc-index.json');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            index = await res.json();
            indexEntries = index.entries || [];
            console.log(`HVSC random: ${indexEntries.length} tunes available (full index)`);
            return true;
        })().catch((err) => {
            loadPromise = null;
            console.error('Error loading HVSC index for random:', err);
            return false;
        });
        return loadPromise;
    }

    /** Pick a random SID from the index (optionally within curated prefixes). */
    async function selectRandomSID(maxDepth = 5, onProgress = null) {
        if (!await loadPaths()) {
            throw new Error('Could not load HVSC index');
        }
        if (!indexEntries.length) {
            throw new Error('No HVSC tunes available');
        }

        let pool = indexEntries;
        if (curatedPrefixes.length) {
            const filtered = indexEntries.filter((e) =>
                curatedPrefixes.some((pre) => e.p.startsWith(pre)));
            if (filtered.length) pool = filtered;
        }

        if (onProgress) onProgress('Picking a random tune...');

        // Fetch the access token before building the URL: the edge guard 403s
        // untokened /HVSC/*.sid requests once gating is enabled, so a random pick
        // that skipped this would break the moment HVSC_TOKEN_SECRET is set.
        await ensureToken();

        const pick = pool[Math.floor(Math.random() * pool.length)];
        const name = pick.p.split('/').pop();
        const slash = pick.p.lastIndexOf('/');
        const browsePath = slash === -1 ? '' : pick.p.substring(0, slash);

        return {
            name: name,
            path: pick.p,
            url: sidUrl(pick.p),
            browsePath: browsePath
        };
    }

    return {
        loadPaths: loadPaths,
        selectRandomSID: selectRandomSID
    };
})();
