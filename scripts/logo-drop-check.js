#!/usr/bin/env node
//
// Browser check for the logo picker: dropping or browsing to an image has to
// leave that image in the input the exporter actually reads, and an image that
// isn't screen-sized (or whose artwork sits below the rows the player displays)
// has to be placed onto the C64 screen first.
//
// A drop used to update the preview only and never touch the hidden
// <input type="file">, so the export silently fell back to the visualizer's
// default logo - the preview said one thing and the .prg contained another.
// These checks read the input back after each interaction.
//
// Not part of `npm test`: it needs Playwright, which is not a dependency of
// this repo. Install it ad hoc and run:
//
//     npm i --no-save playwright
//     node scripts/logo-drop-check.js
//
// Chromium comes from Playwright's own download, or from an existing browser
// pool pointed at by PLAYWRIGHT_BROWSERS_PATH.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SID = path.join(__dirname, '..', 'SID', 'SteelStinsen-DangerDawg.sid');
const VISUALIZER = 'Raistlin Bars With Logo';   // logo input, top 11 character rows
const BAND = 88;

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.sid': 'application/octet-stream', '.bin': 'application/octet-stream'
};

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

function serve() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const file = path.join(ROOT, rel || 'index.html');
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// Playwright resolves its bundled Chromium by exact build number; a shared pool
// (PLAYWRIGHT_BROWSERS_PATH) often holds a different one, so fall back to
// whatever chromium build is actually on disk there.
async function launch(chromium) {
    try {
        return await chromium.launch();
    } catch (err) {
        const pool = process.env.PLAYWRIGHT_BROWSERS_PATH;
        if (!pool || !fs.existsSync(pool)) throw err;
        const dir = fs.readdirSync(pool).filter(d => /^chromium-\d+$/.test(d)).sort().pop();
        if (!dir) throw err;
        const exe = path.join(pool, dir, 'chrome-linux', 'chrome');
        console.log('note: falling back to ' + exe);
        return await chromium.launch({ executablePath: exe });
    }
}

// ─── In-page helpers (stringified into the browser) ───

// Draw an image of `bg` with one `fg` rectangle in it and drop it on the logo
// preview, exactly as a file manager would.
async function dropImage(page, spec) {
    await page.evaluate(async (s) => {
        const canvas = document.createElement('canvas');
        canvas.width = s.w;
        canvas.height = s.h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = s.bg;
        ctx.fillRect(0, 0, s.w, s.h);
        ctx.fillStyle = s.fg;
        ctx.fillRect(s.box[0], s.box[1], s.box[2] - s.box[0] + 1, s.box[3] - s.box[1] + 1);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], s.name, { type: 'image/png' }));
        document.querySelector('.image-preview-frame')
            .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, spec);
    await page.waitForTimeout(1200);
}

// Open the Adjust tool, run `edit` inside it, and apply.
async function adjust(page, edit) {
    await page.evaluate(() => document.querySelector('[data-act="adjust"]').click());
    await page.waitForSelector('#logoFitModal.visible', { timeout: 15000 });
    await page.evaluate(`(${edit.toString()})()`);
    await page.evaluate(() => document.getElementById('logoFitApply').click());
    await page.waitForTimeout(1200);
}

// What the exporter would find on the input, plus where the artwork ended up.
async function readInput(page, inputId) {
    return page.evaluate(async (id) => {
        const input = document.getElementById(id);
        const file = input && input.files && input.files[0];
        if (!file) return { files: 0 };
        const url = URL.createObjectURL(file);
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const { data, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Corner colour is the surround; everything else is artwork.
        const bg = [data[0], data[1], data[2]].join(',');
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = (y * w + x) * 4;
                if ([data[p], data[p + 1], data[p + 2]].join(',') === bg) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
        const note = document.querySelector('.preview-note.fit');
        return {
            files: 1, name: file.name, w, h, bg,
            box: x1 < 0 ? null : { x0, y0, x1, y1 },
            note: note && !note.hidden ? note.textContent : ''
        };
    }, inputId);
}

async function openStudioWithLogo(page) {
    await page.setInputFiles('#fileInput', SID);
    await page.waitForFunction(
        () => window.uiController && window.uiController.visualizerConfig
            && !document.querySelector('.visualizer-grid.disabled'),
        null, { timeout: 60000 });
    // Clicking a card while the Studio is still settling can be swallowed;
    // the panel for the logo input appearing is what says it took.
    let opened = false;
    for (let attempt = 0; attempt < 6 && !opened; attempt++) {
        await page.evaluate(() => window.studioModal.open());
        await page.waitForSelector('.visualizer-card', { state: 'attached', timeout: 30000 });
        await page.waitForTimeout(600 * (attempt + 1));
        await page.evaluate((name) => {
            const card = [...document.querySelectorAll('.visualizer-card')]
                .find(e => e.textContent.trim().startsWith(name));
            if (card) card.click();
        }, VISUALIZER);
        try {
            await page.waitForSelector('.image-preview-wrapper', { state: 'attached', timeout: 10000 });
            opened = true;
        } catch (e) { /* try again */ }
    }
    if (!opened) throw new Error('the Studio never reached ' + VISUALIZER + "'s logo panel");
    // Dismiss any message dialog layered over the Studio.
    await page.evaluate(() => {
        const overlay = document.getElementById('modalOverlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        const btn = overlay.querySelector('.modal-actions button');
        if (btn) btn.click(); else overlay.classList.remove('visible');
    });
    // The preview lives in a Studio panel that may not be the active one, and
    // the panels re-render as the visualizer's config and gallery arrive - wait
    // for the wrapper to still be there after everything has settled.
    await page.waitForFunction(() => !!document.querySelector('.image-preview-wrapper'),
        null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.waitForFunction(() => !!document.querySelector('.image-preview-wrapper'),
        null, { timeout: 30000 });
    return page.evaluate(() => document.querySelector('.image-preview-wrapper').dataset.inputId);
}

(async () => {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (e) {
        console.error('playwright is not installed. Run: npm i --no-save playwright');
        process.exit(1);
    }

    const server = await serve();
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await launch(chromium);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => check(false, 'page error', e.message));
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(2500);

    const inputId = await openStudioWithLogo(page);
    console.log('logo input: #' + inputId);

    // A screen-sized logo with its artwork down the middle of the screen: the
    // player only draws the top 11 rows, so it has to move up - by whole
    // character cells, and without moving sideways.
    await dropImage(page, {
        w: 320, h: 200, bg: '#000000', fg: '#ffffff',
        box: [32, 60, 287, 139], name: 'centred-logo.png'
    });
    let r = await readInput(page, inputId);
    check(r.files === 1, 'a dropped logo reaches the input the exporter reads', r.name || 'input empty');
    check(r.w === 320 && r.h === 200, 'it is stored screen-sized', r.w + 'x' + r.h);
    check(!!r.box && r.box.y1 < BAND, 'artwork below the visible rows is moved into them',
        r.box ? `y ${r.box.y0}-${r.box.y1} of ${BAND}` : 'no artwork found');
    check(!!r.box && r.box.x0 === 32 && r.box.x1 === 287, 'and is not moved sideways',
        r.box ? `x ${r.box.x0}-${r.box.x1}` : '');
    check(!!r.box && (60 - r.box.y0) % 8 === 0, 'the move is a whole number of character rows',
        r.box ? `60 -> ${r.box.y0}` : '');
    check(/auto-placed/i.test(r.note), 'the preview says what happened to it', r.note || 'no note');

    // A 320-wide strip of whole character rows is a logo too, and one that
    // already fits is passed through untouched.
    await dropImage(page, {
        w: 320, h: 88, bg: '#352879', fg: '#ffffff',
        box: [20, 12, 299, 75], name: 'strip.png'
    });
    r = await readInput(page, inputId);
    check(r.files === 1 && r.w === 320 && r.h === 88, 'a 320x88 strip is taken as it is',
        r.w + 'x' + r.h);
    check(r.note === '', 'and is not repositioned', r.note);

    // The crop tool: nudging down a row moves the artwork by exactly 8px.
    const before = r.box;
    await adjust(page, () => document.querySelector('[data-nudge="down"]').click());
    check(await page.evaluate(() => !!document.getElementById('logoFitModal')), 'the Adjust tool opens');
    r = await readInput(page, inputId);
    check(!!r.box && r.box.y0 === before.y0 + 8, 'nudging moves the logo one character row',
        r.box ? `${before.y0} -> ${r.box.y0}` : '');

    check(r.bg === '53,40,121', 'the screen around it takes the image\'s edge colour',
        'rgb(' + r.bg + ')');

    // Shrinking a logo exposes more of that screen, which is what the surround
    // colour is for. Swatch 0 is the colour taken from the image, 1 is C64
    // black, 2 is C64 white. Recolour first, so the measurement below reads the
    // whole logo against it rather than the artwork against the logo.
    await adjust(page, () => document.querySelectorAll('.logo-fit-swatch')[1].click());
    r = await readInput(page, inputId);
    check(r.bg === '0,0,0', 'the chosen surround colour fills the rest of the screen',
        'rgb(' + r.bg + ')');
    const fullWidth = r.box ? r.box.x1 - r.box.x0 + 1 : 0;

    await adjust(page, () => {
        const slider = document.getElementById('logoFitScale');
        slider.value = 50;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    r = await readInput(page, inputId);
    const halfWidth = r.box ? r.box.x1 - r.box.x0 + 1 : 0;
    check(Math.abs(halfWidth - fullWidth / 2) <= 4, 'and the size slider scales the logo',
        `${fullWidth}px -> ${halfWidth}px`);

    // A real multicolour logo, moved down the screen and given the soft
    // transparent edges a logo exported from a modern tool has. Placing it must
    // not blend those edges into the background: the converter ignores alpha,
    // and the in-between shades a blend produces fit no C64 mode at all.
    await page.evaluate(async () => {
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = 'PNG/Logos/facet-mch.png';
        });
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 200;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.fillStyle = '#000';
        x.fillRect(0, 0, 320, 200);
        x.drawImage(img, 0, 60);                       // artwork below the visible rows
        const id = x.getImageData(0, 0, 320, 200);
        const d = id.data;
        for (let y = 0; y < 199; y++) {
            for (let px = 0; px < 319; px++) {
                const i = (y * 320 + px) * 4;
                if ((d[i] | d[i + 1] | d[i + 2]) === 0) { d[i + 3] = 0; continue; }
                const n = (y * 320 + px + 1) * 4;
                if ((d[n] | d[n + 1] | d[n + 2]) === 0) d[i + 3] = 128;
            }
        }
        x.putImageData(id, 0, 0);
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'soft-edges.png', { type: 'image/png' }));
        document.querySelector('.image-preview-frame')
            .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(6000);
    const verdict = await page.evaluate(() => {
        const badge = document.querySelector('.logo-type-badge');
        const warn = document.querySelector('.preview-note.warn');
        return {
            badge: badge ? badge.textContent : '',
            unusable: !!badge && badge.classList.contains('unusable'),
            warn: warn && !warn.hidden ? warn.textContent : ''
        };
    });
    check(!verdict.unusable && !verdict.warn,
        'a soft-edged multicolour logo still converts once placed',
        verdict.warn || 'converts as ' + verdict.badge);
    check(/BMP|MC|MIXED|ECM|HI|PET/.test(verdict.badge), 'and reports the mode it converts to',
        verdict.badge || 'no badge');

    // The badge and the export run the same engine, but only this is the code
    // the export itself calls - run it over what the input now holds.
    const converted = await page.evaluate(async (id) => {
        await window.loadScript('prg-builder.js');
        const cfg = window.uiController.currentVisualizerConfig.inputs.find(i => i.id === id);
        const file = document.getElementById(id).files[0];
        try {
            const blob = await window.SIDquakePRGExporter.prototype.convertLogoPNG.call({}, file, cfg);
            return { ok: true, size: blob.length, mode: blob[CharsetLabCore.LOGO_BLOB.MODE] };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }, inputId);
    check(converted.ok, 'and the exporter converts it for real',
        converted.ok ? `${converted.size}-byte blob, logo mode ${converted.mode}` : converted.error);

    // Browsing to a file has always worked; check the fit didn't break it.
    const png = path.join(ROOT, 'PNG', 'Logos', '0-default.png');
    await page.setInputFiles('#' + inputId, png);
    await page.waitForTimeout(1500);
    r = await readInput(page, inputId);
    check(r.files === 1 && r.w === 320 && r.h === 200, 'a browsed gallery-quality logo still loads',
        r.w + 'x' + r.h);
    check(r.note === '', 'and a logo that already fits is left alone', r.note);

    // An image that is no C64 size at all (the user's 360x194): 40 columns too
    // many and a height off the character grid, so there's no offset that makes
    // it work. It has to be refused outright, leaving the logo already chosen
    // exactly as it was - that's what will be exported.
    const kept = await readInput(page, inputId);
    await dropImage(page, {
        w: 360, h: 194, bg: '#000000', fg: '#ffffff',
        box: [20, 40, 339, 150], name: 'wrong-size.png'
    });
    r = await readInput(page, inputId);
    check(r.name === kept.name && r.w === kept.w && r.h === kept.h
        && JSON.stringify(r.box) === JSON.stringify(kept.box),
        'a 360x194 image leaves the chosen logo alone', `still ${r.name} ${r.w}x${r.h}`);
    const refusal = await page.evaluate(() => {
        const warn = document.querySelector('.preview-note.warn');
        return warn && !warn.hidden ? warn.textContent : '';
    });
    check(/360×194/.test(refusal) && /320×200/.test(refusal) && /384×272/.test(refusal),
        'and says what sizes a logo can be', refusal || 'no message');

    await ctx.close();
    await browser.close();
    server.close();

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
