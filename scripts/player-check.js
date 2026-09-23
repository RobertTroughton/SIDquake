#!/usr/bin/env node
/**
 * player-check.js - loading and playing on the real page, the parts that only a
 * browser can show:
 *
 *   - a file the analyser rejects (here an RSID) leaves the previous tune in
 *     place: its name, its header and the tune in the player;
 *   - Play after Pause carries on where it stopped rather than starting over;
 *   - loading a tune and pressing Play initialises the C64 once (the load),
 *     rather than again for a subtune the engine is already on;
 *   - changing the chip re-initialises the tune once, and it plays on;
 *   - the clock shows what has been heard: the engine runs ahead by what the
 *     worklet still has queued, and that is subtracted;
 *   - the VU-visibility answer is filed under the tune it was worked out for,
 *     not one that loaded while it was being worked out;
 *   - a tune with play address 0 is refused at export with a reason, rather
 *     than exported as a program that calls $0000.
 *
 * Playwright is NOT a dependency of this repo. Install it first:
 *   npm install --no-save playwright
 *   node scripts/player-check.js [--headed]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { psid, asm } = require('./lib/psid-asm.js');

const ROOT = path.join(__dirname, '..', 'public');
const SIDS = path.join(__dirname, '..', 'SID');
const HEADED = process.argv.includes('--headed');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.sid': 'application/octet-stream',
};

function serve() {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        if (url === '/hvsc-token') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: '', exp: 0 }));
            return;
        }
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

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function dropFile(page, name, bytes) {
    await page.evaluate(({ name, b64 }) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([arr], name, { type: 'application/octet-stream' }));
        const input = document.getElementById('fileInput');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name, b64: Buffer.from(bytes).toString('base64') });
}

(async () => {
    const { chromium } = require('playwright');
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}/`;
    const pinned = '/opt/pw-browsers/chromium';
    const launch = { headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] };
    if (fs.existsSync(pinned)) launch.executablePath = pinned;
    const browser = await chromium.launch(launch);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });

        // --- a rejected file leaves the previous tune loaded -------------------
        await dropFile(page, 'dane-copperbooze.sid', fs.readFileSync(path.join(SIDS, 'dane-copperbooze.sid')));
        await page.waitForFunction(() => window.studioModal?.isOpen, null, { timeout: 60000 });
        const before = await page.evaluate(() => ({
            file: window.uiController.currentFileName,
            title: window.uiController.sidHeader?.name,
            player: window.uiController.mainPlayer?._lastLoadedFilename,
        }));
        const rsid = Buffer.from(fs.readFileSync(path.join(SIDS, 'dane-copperbooze.sid')));
        rsid.write('RSID', 0, 'latin1');
        await dropFile(page, 'rejected.sid', rsid);
        await sleep(1500);
        const after = await page.evaluate(() => ({
            file: window.uiController.currentFileName,
            title: window.uiController.sidHeader?.name,
            player: window.uiController.mainPlayer?._lastLoadedFilename,
        }));
        check('A rejected file leaves the previous tune loaded',
            after.file === before.file && after.title === before.title && after.player === before.player,
            JSON.stringify({ before, after }));

        // --- a fresh load is not re-initialised by the first Play --------------
        const inits = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const p = window.uiController.mainPlayer;
            const pb = getSharedSIDPlayback();
            let calls = 0;
            const real = pb.api.audio_set_subtune;
            pb.api.audio_set_subtune = (n) => { calls++; return real(n); };
            try {
                await p.loadFromBinary(p._lastLoadedData.slice(), p._lastLoadedFilename);
                for (let i = 0; i < 50 && !p.loaded; i++) await sleep(100);
                await p.play();
                await sleep(300);
                p.stop();
            } finally { pb.api.audio_set_subtune = real; }
            return { calls };
        });
        // stop() rewinds once at the end; the load and first Play add none.
        check('Load then Play initialises the C64 only for the load',
            inits.calls === 1, JSON.stringify(inits));

        // --- a chip change restarts the tune on the new chip ---------------------
        const chip = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const p = window.uiController.mainPlayer;
            const pb = getSharedSIDPlayback();
            await p.play();
            for (let i = 0; i < 60 && pb.getPlayTime() < 2; i++) await sleep(100);
            const before = pb.api.audio_get_play_time();
            pb.setModel(8580);
            const after = pb.api.audio_get_play_time();
            const model = pb.api.audio_get_sid_model();
            await sleep(500);
            const later = pb.api.audio_get_play_time();
            pb.setModel(0);
            p.stop();
            return { before, after, later, model };
        });
        check('A chip change restarts the tune on that chip, and it plays on',
            chip.before >= 2 && chip.after < 0.5 && chip.model === 8580 && chip.later > chip.after,
            JSON.stringify(chip));

        // --- Play after Pause carries on ---------------------------------------
        const resume = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const p = window.uiController.mainPlayer;
            const pb = getSharedSIDPlayback();
            await p.play();
            for (let i = 0; i < 100 && pb.getPlayTime() < 3; i++) await sleep(100);
            const lead = pb.api.audio_get_play_time() - (pb.getAudibleTime() + 1);
            const queued = pb._queuedSamples;
            p.pause();
            const paused = pb.getPlayTime();
            await p.play();
            await sleep(600);
            const resumed = pb.getPlayTime();
            p.stop();
            return { paused, resumed, lead, queued };
        });
        check('Play after Pause carries on from where it stopped',
            resume.paused >= 3 && resume.resumed >= resume.paused, JSON.stringify(resume));
        // getAudibleTime floors to whole seconds, so +1 bounds it from above.
        check('The clock trails the engine by what is queued',
            resume.queued > 0 && resume.lead > -1, JSON.stringify(resume));

        // --- the VU answer belongs to the tune it was worked out for -----------
        const vu = await page.evaluate(async () => {
            const ui = window.uiController;
            ui._vuBlindFor = -1;
            const pending = ui.checkVuVisibility();
            ui._analysisToken++;            // another tune arrives while it is working
            await pending;
            return { filedUnder: ui._vuBlindFor, current: ui._analysisToken };
        });
        check('A VU answer is not filed under a tune that loaded meanwhile',
            vu.filedUnder !== vu.current, JSON.stringify(vu));

        // --- play address 0 is refused at export ---------------------------------
        const code = asm(0x1000, [
            0xa9, '<irq', 0x8d, 0x14, 0x03, 0xa9, '>irq', 0x8d, 0x15, 0x03, 0x60,
            'irq:', 0x8d, 0x00, 0xd4, 0x4c, 0x31, 0xea,
        ]);
        await dropFile(page, 'irq-player.sid', psid({ play: 0, code }));
        // Wait for the whole load - analysis, then the Studio opening for it -
        // so nothing it does lands after the visualizer is picked below.
        await page.waitForFunction(() => {
            const ui = window.uiController;
            return ui.currentFileName === 'irq-player.sid' && ui.sidHeader?.playAddress === 0
                && !ui.elements.busyOverlay.classList.contains('visible') && window.studioModal?.isOpen;
        }, null, { timeout: 60000 });
        await sleep(500);
        const refused = await page.evaluate(async () => {
            const ui = window.uiController;
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'default'));
            ui._fileSink = () => {};
            await ui.exportPRGWithVisualizer();
            return { ok: ui._lastExportOk, message: ui._lastExportMessage || '' };
        });
        check('A tune with play address 0 is refused at export, with a reason',
            refused.ok === false && /no play address/i.test(refused.message), JSON.stringify(refused));
    } finally {
        await browser.close();
        server.close();
    }

    const failed = results.filter(r => !r.ok);
    for (const f of failed) console.log(`FAILED: ${f.name}${f.detail ? ` - ${f.detail}` : ''}`);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
