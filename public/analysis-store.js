// analysis-store.js - remember what a loop/length scan found, across reloads.
//
// The scan is the slow part of using SIDquake: rendering a tune until its loop
// is confirmed takes seconds to minutes. The bake core caches the rendered rows
// in memory, but a page reload loses them, and the queue re-measures every tune
// on every run.
//
// What comes out of the scan is a couple of hundred bytes - looped, faded out,
// loop point, frame rate, lengths - and for every export that is not a baked
// spectrometer, that summary IS the whole answer. So it is worth keeping.
//
// Everything here fails quietly. IndexedDB is unavailable in a private window,
// blocked by some settings, and can throw at any point; a cache that cannot be
// read is simply a cache miss.
const DB_NAME = 'sidquake';
const STORE = 'analysis';
const DB_VERSION = 1;
// Bump when the shape of a stored summary changes, so old entries are ignored
// rather than handed back with fields the caller no longer expects.
const SCHEMA = 1;
// Entries are tiny; this is about not growing without bound over years of use.
const MAX_ENTRIES = 500;

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        let req;
        try { req = indexedDB.open(DB_NAME, DB_VERSION); }
        catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const os = db.createObjectStore(STORE, { keyPath: 'key' });
                os.createIndex('usedAt', 'usedAt');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
    }).catch(() => null);
    return dbPromise;
}

function asPromise(request) {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

/** The stored summary for `key`, or null. */
export async function readAnalysis(key) {
    const db = await openDb();
    if (!db || !key) return null;
    try {
        const tx = db.transaction(STORE, 'readonly');
        const row = await asPromise(tx.objectStore(STORE).get(key));
        if (!row || row.schema !== SCHEMA) return null;
        // Touch it so pruning drops what nobody uses. Best-effort: a failure
        // here only costs this entry its place in the queue, not the answer.
        try {
            const wtx = db.transaction(STORE, 'readwrite');
            wtx.objectStore(STORE).put({ ...row, usedAt: Date.now() });
        } catch (e) { /* ignore */ }
        return row.value;
    } catch (e) {
        return null;
    }
}

/** Remember `value` under `key`. Never throws. */
export async function writeAnalysis(key, value) {
    const db = await openDb();
    if (!db || !key || !value) return;
    try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, schema: SCHEMA, usedAt: Date.now(), value });
        await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
    } catch (e) { /* a cache that cannot be written is just a cache miss later */ }
    prune(db);
}

/** Drop the least recently used entries once the store outgrows MAX_ENTRIES. */
async function prune(db) {
    try {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        const count = await asPromise(os.count());
        if (!count || count <= MAX_ENTRIES) return;
        let over = count - MAX_ENTRIES;
        const cursorReq = os.index('usedAt').openCursor();
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || over <= 0) return;
            cursor.delete();
            over--;
            cursor.continue();
        };
    } catch (e) { /* ignore */ }
}

/** Forget everything. Exposed for a user-facing "clear cached measurements". */
export async function clearAnalyses() {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    } catch (e) { /* ignore */ }
}
