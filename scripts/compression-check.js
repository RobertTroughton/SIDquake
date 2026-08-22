#!/usr/bin/env node
//
// Browser check for the export's compression: it has to keep the page alive, and
// it has to produce the same bytes wherever it runs.
//
// Both compressors are one long synchronous call - Exomizer inside its WASM
// module, TSCrunch in plain JS - and on a full-RAM export that is ten seconds and
// more. Run on the page, that is a frozen tab and Chrome offering to kill it
// mid-build, so compressor-manager.js hands the job to compressor-worker.js and
// keeps the in-page path only as a fallback. The checks below hold a heartbeat
// against the main thread while a crunch runs, and diff the worker's output
// against the fallback's.
//
// Not part of `npm test`: it needs Playwright, which is not a dependency of this
// repo. Install it ad hoc and run:
//
//     npm i --no-save playwright
//     node scripts/compression-check.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
// Around what a spectrometer export with a logo comes to, which is where the
// freeze was long enough for the browser to notice.
const BIG = 49152;

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.bin': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
};

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

function serve() {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const file = path.join(ROOT, url === '/' ? 'index.html' : url);
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, {
                'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            });
            res.end(buf);
        });
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

(async () => {
    const { chromium } = require('playwright');
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await launch(chromium);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });

    const results = await page.evaluate(async (size) => {
        await window.loadScript('compressor-manager.js');

        // A payload shaped like a real export: player code, then a baked stream's
        // worth of index bytes.
        const parts = ['prg/RaistlinBarsFFTWithLogo-code.bin', 'prg/RaistlinBars-code.bin',
            'prg/MusicalBlobs-code.bin'];
        const bufs = [];
        for (const p of parts) bufs.push(new Uint8Array(await (await fetch(p)).arrayBuffer()));
        const data = new Uint8Array(size);
        let at = 0;
        while (at < size) {
            const b = bufs[at % bufs.length];
            const n = Math.min(b.length, size - at);
            data.set(b.subarray(0, n), at);
            at += n;
        }
        for (let i = size >> 1; i < size; i++) data[i] = (i * 37 + (i >> 5) * 11) & 0xFF;

        const fnv = (bytes) => {
            let h = 0x811c9dc5;
            for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
            return (h >>> 0).toString(16);
        };

        // Beats only tick when the event loop is free, so they measure how much of
        // the crunch the page could have answered during.
        const run = async (mgr, type) => {
            let beats = 0;
            const t = performance.now();
            const beat = setInterval(() => { beats++; }, 100);
            let out = null, error = null;
            try {
                const r = await mgr.compress(data, type, 0x0801, 0x0810);
                out = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
            } catch (e) { error = String(e && e.message || e); }
            clearInterval(beat);
            const ms = Math.round(performance.now() - t);
            return { ms, beats, expected: Math.floor(ms / 100), hash: out && fnv(out),
                len: out && out.length, error };
        };

        const out = {};
        for (const type of ['exomizer', 'tscrunch']) {
            const worker = new CompressorManager();
            out[type] = { worker: await run(worker, type) };
            const inPage = new CompressorManager();
            inPage._workerBroken = true;      // force the fallback path
            out[type].page = await run(inPage, type);
            out[type].usedWorker = !!worker.worker;
        }
        return out;
    }, BIG);

    for (const type of ['exomizer', 'tscrunch']) {
        const r = results[type];
        check(r.usedWorker && !r.worker.error,
            `${type}: the crunch runs in a worker`, r.worker.error || `${r.worker.ms}ms`);
        // The page cannot answer at all while the in-page path runs, which is the
        // freeze this exists to prevent; off the main thread nearly every beat
        // lands.
        check(r.worker.expected >= 5 && r.worker.beats >= r.worker.expected * 0.8,
            `${type}: and the page keeps answering while it does`,
            `${r.worker.beats}/${r.worker.expected} beats in ${r.worker.ms}ms`);
        check(r.page.beats <= r.page.expected * 0.2,
            `${type}: where crunching on the page blocks it`,
            `${r.page.beats}/${r.page.expected} beats in ${r.page.ms}ms`);
        check(!!r.worker.hash && r.worker.hash === r.page.hash,
            `${type}: same bytes either way`,
            `${r.worker.hash} (${r.worker.len}) vs ${r.page.hash} (${r.page.len})`);
    }
    check(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '));

    await browser.close();
    server.close();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
