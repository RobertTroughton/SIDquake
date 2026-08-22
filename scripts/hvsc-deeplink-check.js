#!/usr/bin/env node
//
// Browser check for shared tune links: /?tune=<HVSC path> has to arrive with
// the tune selected, loaded and its details on screen, without the visitor
// clicking the row again.
//
// The page reaches that state two ways at once - a ~1.5 KB share-meta shard
// starts the tune immediately, and the collection index (tens of MB) selects it
// in the listing when it lands - and the two can arrive in either order. A
// quick play that starts and then fails used to leave the listing showing the
// tune with an empty details panel and nothing loaded, so the checks below run
// the orderings with the index deliberately slowed and the first .sid request
// refused.
//
// The mirror under public/HVSC/ is not in the repo, so this builds its own
// fixture: one SID from SID/ copied to a path the index knows, plus the
// share-meta shard for it. Both are removed again afterwards unless they were
// already there.
//
// Not part of `npm test`: it needs Playwright, which is not a dependency of
// this repo. Install it ad hoc and run:
//
//     npm i --no-save playwright
//     node scripts/hvsc-deeplink-check.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SOURCE_SID = path.join(__dirname, '..', 'SID', 'JCH-Crystalline.sid');
// Any path the committed index lists; the bytes served for it are ours.
const TUNE = 'MUSICIANS/H/Hubbard_Rob/Commando.sid';
// What the copied file's own header says, which is what the details panel and
// the player report once it is really loaded.
const TITLE = 'Crystalline';

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.sid': 'application/octet-stream',
};

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

/** Shard id for a tune path - the same hash build-share-meta.js writes. */
function shardOf(key) {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) & 0xfff).toString(16).padStart(3, '0');
}

/** Put one playable tune and its share-meta shard where the page expects them. */
function makeFixture() {
    const sid = path.join(ROOT, 'HVSC', 'C64Music', TUNE);
    const shard = path.join(ROOT, 'share-meta', shardOf(TUNE) + '.json');
    const made = [];
    if (!fs.existsSync(sid)) {
        fs.mkdirSync(path.dirname(sid), { recursive: true });
        fs.copyFileSync(SOURCE_SID, sid);
        made.push(sid);
    }
    if (!fs.existsSync(shard)) {
        fs.mkdirSync(path.dirname(shard), { recursive: true });
        fs.writeFileSync(shard, JSON.stringify({ [TUNE]: { t: TITLE, a: 'Test', r: '' } }));
        made.push(shard);
    }
    return () => made.forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* gone */ } });
}

// opts.indexDelay: hold the collection index back so the share-meta shard wins
// the race. opts.refuseFirstSid: answer the first .sid request with a 503, the
// way a cold edge node or an expired token can.
function serve(opts) {
    const state = { refused: false };
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        if (url === '/hvsc-token') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: '', exp: 0 }));
            return;
        }
        if (opts.refuseFirstSid && /\.sid$/.test(url) && !state.refused) {
            state.refused = true;
            res.writeHead(503);
            res.end('refused');
            return;
        }
        const file = path.join(ROOT, url === '/' ? 'index.html' : url);
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        const delay = /hvsc-index/.test(url) ? (opts.indexDelay || 0) : 0;
        fs.readFile(file, (err, buf) => setTimeout(() => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, {
                'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
                // The playback engine's WASM needs these to run at all.
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            });
            res.end(buf);
        }, delay));
    });
    return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function launch(chromium) {
    const pinned = '/opt/pw-browsers/chromium';
    if (fs.existsSync(pinned)) {
        try { return await chromium.launch({ executablePath: pinned }); } catch (e) { /* fall through */ }
    }
    try {
        return await chromium.launch();
    } catch (err) {
        const pool = process.env.PLAYWRIGHT_BROWSERS_PATH;
        if (!pool || !fs.existsSync(pool)) throw err;
        const dir = fs.readdirSync(pool).filter(d => /^chromium-\d+$/.test(d)).sort().pop();
        if (!dir) throw err;
        return await chromium.launch({ executablePath: path.join(pool, dir, 'chrome-linux', 'chrome') });
    }
}

/** Follow the link and wait for the page to settle on the tune. */
async function followLink(browser, base, keepOpen = false) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(base + '?tune=' + TUNE, { waitUntil: 'load' });
    const state = await page.evaluate(async () => {
        const read = () => {
            const panel = document.getElementById('sidInfoPanel');
            const content = document.getElementById('sidInfoContent');
            const rows = content ? [...content.querySelectorAll('.sid-info-row')] : [];
            const titleRow = rows.find(r =>
                r.querySelector('.sid-info-label')?.textContent === 'Title');
            return {
                browserOpen: !!document.getElementById('hvscModal')?.classList.contains('visible'),
                hasInfo: !!panel?.classList.contains('has-info'),
                title: titleRow?.querySelector('.sid-info-value')?.textContent || '',
                selected: !!document.querySelector('.file-item.selected'),
                loaded: !!(window.getSharedSIDPlayback && getSharedSIDPlayback().loaded),
            };
        };
        // Both routes to the tune are network-bound; give the slower one time.
        for (let i = 0; i < 60; i++) {
            const s = read();
            if (s.loaded && s.title && s.selected) return s;
            await new Promise(r => setTimeout(r, 500));
        }
        return read();
    });
    if (keepOpen) return { state, page };
    await page.close();
    return state;
}

async function scenario(browser, name, opts) {
    const server = await serve(opts);
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
        const s = await followLink(browser, base);
        check(s.browserOpen, `${name}: the collection browser opens on the tune`);
        check(s.selected, `${name}: its row is selected in the listing`);
        check(s.loaded, `${name}: the tune is loaded, not waiting for a click`);
        check(s.title === TITLE, `${name}: the details panel describes it`, s.title || '(empty)');
        check(s.hasInfo, `${name}: so the transport and details are on screen`);
    } finally {
        server.close();
    }
}

// Taking the tune out of the browser hands it to the Studio; it must not also
// start it playing over whatever the visitor does next.
async function checkChooseDoesNotPlay(browser) {
    const server = await serve({});
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
        const { state, page } = await followLink(browser, base, true);
        const playingFirst = await page.evaluate(() => getSharedSIDPlayback().playing);
        const after = await page.evaluate(async () => {
            hvscBrowser.chooseSong();
            for (let i = 0; i < 120 && !window.uiController.sidHeader; i++) {
                await new Promise(r => setTimeout(r, 250));
            }
            return {
                took: !!window.uiController.sidHeader,
                playing: getSharedSIDPlayback().playing,
            };
        });
        await page.close();
        check(state.loaded && playingFirst,
            'choosing: the preview was playing before the tune was taken',
            `loaded=${state.loaded} playing=${playingFirst}`);
        check(after.took, 'choosing: the tune reaches the tool');
        check(!after.playing, 'choosing: and it waits to be played, rather than starting itself');
    } finally {
        server.close();
    }
}

(async () => {
    const { chromium } = require('playwright');
    const cleanup = makeFixture();
    const browser = await launch(chromium);
    try {
        // Index first: the listing selects the tune before the shard has played it.
        await scenario(browser, 'index first', {});
        // Shard first: the tune is already playing when the listing arrives, and
        // the listing must not leave the details panel it cleared empty.
        await scenario(browser, 'shard first', { indexDelay: 3000 });
        // Shard first, but its play never lands.
        await scenario(browser, 'quick play refused', { indexDelay: 3000, refuseFirstSid: true });
        await checkChooseDoesNotPlay(browser);
    } finally {
        await browser.close();
        cleanup();
    }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
