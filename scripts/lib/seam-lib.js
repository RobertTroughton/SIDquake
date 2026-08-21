#!/usr/bin/env node
//
// Shared plumbing for the two seam scripts: drive the real page to produce a
// .prg, and run that .prg in VICE. Both are fiddly enough - a hidden Studio
// panel here, an autostart mode that needs no 1541 ROM there - that neither
// script should carry its own copy.
//
// Needs Playwright and VICE, neither of which is a dependency of this repo:
//   npm install --no-save playwright
//   apt-get install -y vice xvfb
//

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SIDS = path.join(ROOT, 'SID');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
    '.sid': 'application/octet-stream', '.bin': 'application/octet-stream'
};

function serve() {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        if (url === '/hvsc-token') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: '', exp: 0 }));
            return;
        }
        const file = path.join(PUBLIC, url === '/' ? 'index.html' : url);
        if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, {
                'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp'
            });
            res.end(buf);
        });
    });
    return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

/** Drive the page: load a SID, pick a visualizer, drop a logo, export the .prg. */
async function exportPRG(opts) {
    const { chromium } = require('playwright');
    const server = await serve();
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const pinned = '/opt/pw-browsers/chromium';
    const launch = { headless: true };
    if (fs.existsSync(pinned)) launch.executablePath = pinned;
    const browser = await chromium.launch(launch);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => window.uiController, null, { timeout: 60000 });

    const sid = fs.readFileSync(path.join(SIDS, opts.sid));
    await page.evaluate(({ name, b64 }) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([arr], name, { type: 'application/octet-stream' }));
        const input = document.getElementById('fileInput');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: opts.sid, b64: sid.toString('base64') });

    await page.waitForFunction(
        () => window.uiController && window.uiController.visualizerConfig
            && !document.querySelector('.visualizer-grid.disabled'),
        null, { timeout: 120000 });

    // Pick the visualizer by its registry id.
    const picked = await page.evaluate(async (id) => {
        const cards = [...document.querySelectorAll('.visualizer-card')];
        const card = cards.find(c => (c.dataset.visualizer || c.dataset.id || '') === id);
        if (!card) return cards.map(c => c.dataset.visualizer || c.dataset.id || c.textContent.trim());
        card.click();
        return true;
    }, opts.visualizer);
    if (picked !== true) {
        await browser.close(); server.close();
        throw new Error('visualizer "' + opts.visualizer + '" not in: ' + JSON.stringify(picked));
    }
    await page.waitForTimeout(1500);

    if (opts.logo) {
        await page.evaluate(() => window.studioModal && window.studioModal.open());
        await page.waitForTimeout(800);
        // The preview frame only exists on the panel that owns the logo option,
        // and it is the panel's tab id that varies between visualizers.
        const tab = await page.evaluate(() => {
            const frame = document.querySelector('.image-preview-frame');
            const panel = frame && frame.closest('[data-studio-tab]');
            const id = panel && panel.dataset.studioTab;
            if (id) window.studioModal.activate(id);
            return id;
        });
        if (!tab) throw new Error('this visualizer has no image panel');
        await page.waitForSelector('.image-preview-frame', { state: 'visible', timeout: 30000 });
        const b64 = fs.readFileSync(opts.logo).toString('base64');
        // Dropped on the preview frame, the way a file manager delivers it -
        // that is the path that reaches the input the exporter reads.
        await page.evaluate(async (data) => {
            const bin = atob(data);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([arr], 'logo.png', { type: 'image/png' }));
            document.querySelector('.image-preview-frame').dispatchEvent(
                new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }, b64);
        await page.waitForTimeout(8000);
        const got = await page.evaluate(() => {
            const i = [...document.querySelectorAll('input[type=file]')]
                .find(e => /image|png/.test(e.accept || '') && e.files && e.files.length);
            return i ? i.id + ' <- ' + i.files[0].name : null;
        });
        if (!got) throw new Error('the logo never reached the input the exporter reads');
        console.log('  logo on ' + got);
        await page.evaluate(() => window.studioModal && window.studioModal.close());
        await page.waitForTimeout(500);
    }

    // Take the bytes straight out of the exporter rather than off a download.
    const out = await page.evaluate(async () => {
        const ui = window.uiController;
        const made = [];
        const real = ui.downloadFile.bind(ui);
        ui.downloadFile = (data, name) => {
            if (/\.prg$/i.test(name) && data && data.length) {
                made.push({ name, b64: btoa(String.fromCharCode(...new Uint8Array(data))) });
            }
        };
        try {
            await ui.exportPRGWithVisualizer();
        } finally {
            ui.downloadFile = real;
        }
        return made;
    });

    await browser.close();
    server.close();
    if (errors.length) console.log('  note: page errors: ' + errors.join(' | '));
    if (!out.length) throw new Error('export produced no .prg');
    return Buffer.from(out[0].b64, 'base64');
}

const PAL_FRAME_CYCLES = 312 * 63;

/**
 * Lay out the ROM set the way VICE looks for it. The distro package ships
 * without C64 ROMs; the ones committed under roms/ are the same images under
 * different names.
 */
function romDir(dir) {
    const out = path.join(dir, 'C64');
    fs.mkdirSync(out, { recursive: true });
    const names = [
        ['kernal.bin', 'kernal-901227-03.bin'],
        ['basic.bin', 'basic-901226-01.bin'],
        ['chargen.bin', 'chargen-901225-01.bin']
    ];
    for (const [src, dst] of names) {
        fs.copyFileSync(path.join(ROOT, 'roms', src), path.join(out, dst));
    }
    return dir;
}

/** Run a .prg in VICE and grab the screen as it stands after `frames` frames. */
function renderInVice(prgPath, pngPath, frames) {
    const dir = romDir(path.dirname(prgPath));
    const args = [
        '-default',
        // The ROM set first, then VICE's own data directory - dropping the
        // latter costs it the shaders it needs to open a window at all.
        '-directory', dir + ':/usr/share/vice',
        '-VICIIfilter', '0', '-VICIIborders', '1',
        '-warp', '-autostart-warp', '-sounddev', 'dummy',
        // Injected straight into RAM: the package has no 1541 ROM, so the
        // virtual-disk autostart paths cannot load anything.
        '-autostartprgmode', '1',
        '-limitcycles', String(Math.round(frames * PAL_FRAME_CYCLES)),
        '-exitscreenshot', pngPath,
        '-autostart', prgPath
    ];
    // x64sc is a GTK binary, so it needs a display to start at all; xvfb-run
    // gives it a throwaway one on a headless box.
    const headless = !process.env.DISPLAY;
    if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
    try {
        execFileSync(headless ? 'xvfb-run' : 'x64sc',
            headless ? ['-a', 'x64sc', ...args] : args,
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    } catch (e) {
        // Tripping -limitcycles is how the run is meant to end, and VICE calls
        // that a failure. The screenshot is what says whether it worked.
        if (!fs.existsSync(pngPath)) throw e;
    }
    if (!fs.existsSync(pngPath)) throw new Error('VICE wrote no screenshot');
}

/**
 * Per-raster-line summary of a rendered frame: how many pixels on the line
 * differ from the line's most common colour. A curtain line is uniform (the
 * sprites paint it flat), a text line is sparse, a bitmap line is busy - so the
 * profile pins where each region starts and ends without knowing the artwork.
 */
function lineProfile(png) {
    const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
    const img = PNG.sync.read(fs.readFileSync(png));
    const rows = [];
    for (let y = 0; y < img.height; y++) {
        const counts = new Map();
        for (let x = 0; x < img.width; x++) {
            const p = (y * img.width + x) * 4;
            const key = (img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2];
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        let top = 0, topKey = 0;
        for (const [k, n] of counts) if (n > top) { top = n; topKey = k; }
        rows.push({ y, ink: img.width - top, bg: topKey, colours: counts.size });
    }
    return { rows, w: img.width, h: img.height };
}
module.exports = { exportPRG, romDir, renderInVice, lineProfile, serve, PAL_FRAME_CYCLES };
