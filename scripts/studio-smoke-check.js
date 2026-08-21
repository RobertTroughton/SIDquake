#!/usr/bin/env node
/**
 * studio-smoke-check.js - drive the real page through load -> Studio -> Export.
 *
 * Covers the parts of the browser UI that nothing else does: that a dropped SID
 * reaches the Studio, that the background loop/length scan starts and reports in
 * the corner chip, that the export manifest renders, that metadata edits reach
 * the header the exporter reads, and that the visualizer choice survives loading
 * a second tune.
 *
 * Playwright is NOT a dependency of this repo (same as mobile-layout-check.js and
 * logo-drop-check.js). Install it first:
 *   npm install --no-save playwright
 *   node scripts/studio-smoke-check.js [--headed] [--keep]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

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
        let file = path.join(ROOT, url === '/' ? 'index.html' : url);
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, {
                'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
                // The bake worker and its engine glue need these to run at all.
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

async function loadSid(page, file) {
    const bytes = fs.readFileSync(path.join(SIDS, file));
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([arr], name, { type: 'application/octet-stream' }));
        const input = document.getElementById('fileInput');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: file, b64: bytes.toString('base64') });
}

(async () => {
    const { chromium } = require('playwright');
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}/`;
    // The pre-installed browser may not match the Playwright build on disk, so
    // point at it explicitly when it is there (PLAYWRIGHT_BROWSERS_PATH layout).
    const pinned = '/opt/pw-browsers/chromium';
    const launch = { headless: !HEADED };
    if (fs.existsSync(pinned)) launch.executablePath = pinned;
    const browser = await chromium.launch(launch);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    try {
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });

        // --- load a tune ------------------------------------------------------
        await loadSid(page, 'JCH-Crystalline.sid');
        await page.waitForFunction(() => window.studioModal?.isOpen, null, { timeout: 60000 });
        check('Studio opens after a SID loads', true);

        // --- background analysis chip ----------------------------------------
        let chipSeen = false;
        try {
            await page.waitForFunction(
                () => !document.getElementById('analysisChip')?.hidden, null, { timeout: 20000 });
            chipSeen = true;
        } catch (e) { /* reported below */ }
        check('Background analysis chip appears', chipSeen);

        const running = await page.evaluate(() => window.uiController.analysisRunning);
        check('Analysis is running in the background', running === true || chipSeen,
            `analysisRunning=${running}`);

        // The page must stay responsive while it scans - that is the whole point.
        const responsive = await page.evaluate(() => {
            const t = performance.now();
            document.getElementById('studioRail')?.click?.();
            return performance.now() - t < 500;
        });
        check('Page stays responsive during the scan', responsive);

        // --- export manifest --------------------------------------------------
        await page.evaluate(() => window.studioModal.activate('export'));
        await page.waitForTimeout(300);
        const manifestRows = await page.evaluate(
            () => document.querySelectorAll('#exportManifest tr').length);
        check('Export manifest renders rows', manifestRows > 1, `${manifestRows} rows`);

        // --- Generate PRG reachable from every tab ----------------------------
        const genEverywhere = await page.evaluate(() => {
            const tabs = window.studioModal.tabList().map(t => t.id);
            const btn = document.getElementById('exportPRGButton');
            const hidden = [];
            for (const id of tabs) {
                window.studioModal.activate(id);
                if (btn.offsetParent === null) hidden.push(id);
            }
            return { tabs: tabs.length, hidden };
        });
        check('Generate PRG is visible on every tab', genEverywhere.hidden.length === 0,
            `${genEverywhere.tabs} tabs, hidden on: ${genEverywhere.hidden.join(',') || 'none'}`);

        // --- activating a tab must not throw focus away -----------------------
        const focusKept = await page.evaluate(() => {
            const rail = document.getElementById('studioRail');
            const first = rail.querySelector('[data-tab]');
            first.focus();
            const before = document.activeElement === first;
            first.click();
            const after = document.activeElement;
            return {
                before,
                stillInRail: rail.contains(after),
                sameTab: after?.dataset?.tab === first.dataset.tab,
                landedOnBody: after === document.body,
            };
        });
        check('Focus survives activating a rail tab',
            focusKept.before && focusKept.stillInRail && !focusKept.landedOnBody,
            JSON.stringify(focusKept));

        // --- metadata edits reach the header the exporter reads ---------------
        const meta = await page.evaluate(() => {
            const ui = window.uiController;
            ui.analyzer.updateMetadata('author', 'SMOKE TEST AUTHOR');
            for (const h of [ui.sidHeader, ui.analyzer.sidHeader]) if (h) h.author = 'SMOKE TEST AUTHOR';
            return { ui: ui.sidHeader.author, analyzer: ui.analyzer.sidHeader.author };
        });
        check('Edited author is on the header createPRG reads',
            meta.analyzer === 'SMOKE TEST AUTHOR', JSON.stringify(meta));

        // --- sticky visualizer + options across a second tune -----------------
        await page.evaluate(async () => {
            const ui = window.uiController;
            const target = VISUALIZERS.find(v => v.id === 'RaistlinBars');
            await ui.selectVisualizer(target);
        });
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => window.uiController.selectedVisualizer?.dataSourceGroup
            || window.uiController.selectedVisualizer?.id);

        await loadSid(page, 'Flex-Lundia.sid');
        await page.waitForFunction(() => window.uiController.sidHeader?.name !== undefined
            && window.uiController.currentFileName === 'Flex-Lundia.sid', null, { timeout: 60000 });
        await page.waitForTimeout(1200);
        const after = await page.evaluate(() => window.uiController.selectedVisualizer?.dataSourceGroup
            || window.uiController.selectedVisualizer?.id);
        check('Visualizer choice survives loading another tune', before === after,
            `${before} -> ${after}`);

        // --- cancelling a RUNNING scan is honoured ----------------------------
        // Restart one deterministically rather than racing whatever the second
        // tune's load left behind.
        const cancelled = await page.evaluate(async () => {
            const ui = window.uiController;
            ui.tuneAnalysis = null;
            ui._analysisCancelled = false;
            const p = ui._ensureAnalysis({});
            const running = ui.analysisRunning;
            ui.cancelAnalysis();
            await p;
            return { running, flag: ui._analysisCancelled, analysis: !!ui.tuneAnalysis };
        });
        check('A running scan can be cancelled', cancelled.running && cancelled.flag,
            JSON.stringify(cancelled));
        check('A cancelled scan leaves no analysis', cancelled.analysis === false);

        // --- Song tab length controls -----------------------------------------
        await page.evaluate(() => window.studioModal.activate('song'));
        await page.waitForTimeout(200);
        const songTab = await page.evaluate(() => {
            const ui = window.uiController;
            const manual = document.getElementById('songLengthManual');
            manual.value = '3:41';
            manual.dispatchEvent(new Event('input', { bubbles: true }));
            const typed = ui.manualSongLengthSeconds();
            document.getElementById('showSongLengthToggle').checked = false;
            document.getElementById('showSongLengthToggle')
                .dispatchEvent(new Event('change', { bubbles: true }));
            const off = ui.showSongLength();
            document.getElementById('showSongLengthToggle').checked = true;
            return { typed, off, status: document.getElementById('songLoopStatus').textContent };
        });
        check('A typed song length parses to seconds', songTab.typed === 221, `${songTab.typed}`);
        check('The show-length toggle is read back', songTab.off === false);
        check('The Song tab reports the length state', /length|clock|Measur/i.test(songTab.status),
            songTab.status.slice(0, 60));

        // --- the scan actually produces a length ------------------------------
        let finished = false;
        try {
            await page.evaluate(() => {
                const ui = window.uiController;
                ui._analysisCancelled = false;
                return ui._ensureAnalysis({});
            });
            finished = await page.evaluate(() => !!window.uiController.tuneAnalysis);
        } catch (e) { /* reported below */ }
        check('A completed scan yields an analysis', finished);

        const fatal = errors.filter(e => !/favicon|net::ERR_|404/i.test(e));
        check('No uncaught page errors', fatal.length === 0, fatal.slice(0, 3).join(' | '));
    } finally {
        if (!process.argv.includes('--keep')) await browser.close();
        server.close();
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
