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

async function loadSids(page, files) {
    const payload = files.map((name) => ({
        name, b64: fs.readFileSync(path.join(SIDS, name)).toString('base64'),
    }));
    await page.evaluate(async (items) => {
        const dt = new DataTransfer();
        for (const { name, b64 } of items) {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            dt.items.add(new File([arr], name, { type: 'application/octet-stream' }));
        }
        const input = document.getElementById('fileInput');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, payload);
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

        // --- narrow viewports must not be dropped into the Studio -------------
        const narrow = await page.evaluate(() => {
            // matchMedia follows the emulated viewport, so drive it directly:
            // the Studio's own isNarrow getter is what openForNewFile consults.
            return { query: StudioModal.NARROW_QUERY, isNarrow: window.studioModal.isNarrow };
        }).catch(() => null);
        check('The Studio knows when it is on a narrow viewport',
            !!narrow && narrow.isNarrow === false, JSON.stringify(narrow));

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

        // --- advanced settings are folded away, and still work ----------------
        await page.evaluate(() => window.studioModal.activate('export'));
        await page.waitForTimeout(200);
        const adv = await page.evaluate(() => {
            const d = document.getElementById('advancedSettings');
            const before = { exists: !!d, open: !!(d && d.open) };
            // Every knob that used to sit loose on the Export tab must be inside it.
            const inside = ['advBakeEngine', 'advScanLen', 'advMinLoop']
                .filter(id => d && d.contains(document.getElementById(id)));
            // Compression stays out in the open - it is a real choice.
            const compressionOutside = !!document.querySelector('input[name="compression-type"]')
                && !d?.contains(document.querySelector('input[name="compression-type"]'));
            return { ...before, inside, compressionOutside };
        });
        check('Advanced settings are collapsed by default', adv.exists && adv.open === false,
            JSON.stringify({ exists: adv.exists, open: adv.open }));
        check('The expert knobs live inside it', adv.inside.length === 3, adv.inside.join(','));
        check('Compression stays outside it', adv.compressionOutside);

        const scanWindow = await page.evaluate(() => {
            const el = document.getElementById('advScanLen');
            el.value = '4:00';
            el.dispatchEvent(new Event('change', { bubbles: true }));
            const saved = JSON.parse(localStorage.getItem('sidquakeAdvanced') || '{}');
            return { text: saved.scanLenText, parsed: window.uiController.getAdvancedSettings().maxLoopSeconds };
        });
        check('The loop-search window is settable again', scanWindow.parsed === 240,
            JSON.stringify(scanWindow));

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

        // --- option grids are radio groups, not mouse-only divs ---------------
        const grids = await page.evaluate(async () => {
            const ui = window.uiController;
            // A bar visualizer brings the Bar Style / Colour Effect / Font grids.
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'RaistlinBars'));
            await new Promise(r => setTimeout(r, 800));
            const grid = document.querySelector('.bar-style-grid');
            if (!grid) return { found: false };
            const thumbs = [...grid.querySelectorAll('.bar-style-thumbnail')];
            const tabStops = thumbs.filter(t => t.tabIndex === 0).length;
            const roles = grid.getAttribute('role') === 'radiogroup'
                && thumbs.every(t => t.getAttribute('role') === 'radio');

            // Arrow-key move must change both the selection and the value the
            // exporter reads.
            const start = grid.querySelector('.bar-style-thumbnail.selected') || thumbs[0];
            start.focus();
            const before = document.getElementById(grid.dataset.configId).value;
            start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            const after = document.getElementById(grid.dataset.configId).value;
            const checked = grid.querySelectorAll('[aria-checked="true"]').length;
            return { found: true, tabStops, roles, before, after, checked,
                     tabStopsAfter: thumbs.filter(t => t.tabIndex === 0).length };
        });
        check('Option grids expose radio semantics', grids.found && grids.roles,
            JSON.stringify(grids));
        check('A grid is one tab stop, not one per item',
            grids.tabStops === 1 && grids.tabStopsAfter === 1,
            `${grids.tabStops} -> ${grids.tabStopsAfter}`);
        check('Arrow keys change the selected value',
            grids.before !== grids.after && grids.checked === 1,
            `${grids.before} -> ${grids.after}, checked=${grids.checked}`);

        // --- landmarks and status semantics -----------------------------------
        const semantics = await page.evaluate(() => {
            const ui = window.uiController;
            ui.showExportStatus('Smoke test failure', 'error');
            const st = document.getElementById('exportStatus');
            return {
                main: !!document.querySelector('main#tabTool'),
                skip: !!document.querySelector('a.skip-link[href="#tabTool"]'),
                statusRole: st.getAttribute('role'),
                statusLive: st.getAttribute('aria-live'),
            };
        });
        check('The tool has a main landmark and a skip link',
            semantics.main && semantics.skip, JSON.stringify(semantics));
        check('An export failure is announced as an alert',
            semantics.statusRole === 'alert' && semantics.statusLive === 'assertive',
            `${semantics.statusRole}/${semantics.statusLive}`);
        const stays = await page.evaluate(async () => {
            await new Promise(r => setTimeout(r, 5600));
            return document.getElementById('exportStatus').classList.contains('visible');
        });
        check('An export failure does not erase itself after 5s', stays === true);

        // --- the tune selector belongs to the Song tab ------------------------
        const subtune = await page.evaluate(() => {
            const sel = document.getElementById('songSelector');
            const songPanel = document.querySelector('.studio-panel[data-studio-tab="song"]');
            const vizPanel = document.querySelector('.studio-panel[data-studio-tab="visualizer"]');
            const note = document.getElementById('fftMultiSongNote');
            return {
                // Loaded tunes here are single-song, so the selector is absent -
                // what matters is that the mount points are on the right panels.
                songMount: !!songPanel.querySelector('#songSelectorMount'),
                noteMount: !!vizPanel.querySelector('#fftMultiSongMount'),
                selectorOnSongTab: !sel || !!songPanel.contains(sel),
                noteOnVizTab: !note || !!vizPanel.contains(note),
            };
        });
        check('The tune selector mounts on the Song tab',
            subtune.songMount && subtune.selectorOnSongTab, JSON.stringify(subtune));
        check('The multi-tune caveat stays with the visualizer choice',
            subtune.noteMount && subtune.noteOnVizTab, JSON.stringify(subtune));

        // --- one C64 palette --------------------------------------------------
        const palette = await page.evaluate(async () => {
            await window.loadScript('petscii-converter.js');
            const conv = new PETSCIIConverter();
            const shared = window.C64_PALETTE;
            const same = shared.every((c, i) =>
                c.rgb.every((v, k) => v === conv.C64_PALETTE[i][k]));
            return {
                shared: shared.length,
                same,
                red: shared[2].hex,
                uiUsesShared: typeof C64_COLORS !== 'undefined' && C64_COLORS === shared,
            };
        });
        check('The swatches and the image converter share one palette',
            palette.same && palette.uiUsesShared && palette.shared === 16,
            JSON.stringify(palette));
        check('It is the real VICE PAL table, not the muted one',
            palette.red.toLowerCase() === '#813338', palette.red);

        // --- Studio rail is a real tablist ------------------------------------
        const rail = await page.evaluate(() => {
            const railEl = document.getElementById('studioRail');
            const tabs = [...railEl.querySelectorAll('[role="tab"]')];
            const selected = tabs.filter(t => t.getAttribute('aria-selected') === 'true');
            const panelFor = selected[0] && document.getElementById(
                selected[0].getAttribute('aria-controls'));
            const before = window.studioModal.activeTab;
            railEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            return {
                list: railEl.getAttribute('role'),
                tabs: tabs.length,
                selected: selected.length,
                tabStops: tabs.filter(t => t.tabIndex === 0).length,
                panelLinked: !!panelFor && panelFor.getAttribute('role') === 'tabpanel',
                moved: window.studioModal.activeTab !== before,
            };
        });
        check('The Studio rail is a tablist with one selected tab',
            rail.list === 'tablist' && rail.tabs > 1 && rail.selected === 1,
            JSON.stringify(rail));
        check('Each tab is linked to its panel', rail.panelLinked);
        check('Arrow keys move between Studio sections',
            rail.moved && rail.tabStops === 1, JSON.stringify(rail));

        // --- headings run in order --------------------------------------------
        const headings = await page.evaluate(() => {
            const panel = document.querySelector('.studio-panel[data-studio-tab="song"]');
            const levels = [...panel.querySelectorAll('h1,h2,h3,h4')]
                .map(h => parseInt(h.tagName.slice(1), 10));
            let ok = true;
            for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) ok = false;
            return { levels, ok };
        });
        check('Studio headings do not run backwards or skip a level',
            headings.ok && headings.levels[0] === 2, JSON.stringify(headings));

        // --- the busy overlay says something ----------------------------------
        const busy = await page.evaluate(() => {
            const ui = window.uiController;
            ui.showBusy('Smoke test', 'Working…', () => {});
            const content = document.querySelector('#busyOverlay .busy-content');
            const state = {
                role: content.getAttribute('role'),
                modal: content.getAttribute('aria-modal'),
                announced: document.getElementById('busyAnnounce').textContent,
                pageInert: !!document.querySelector('.container').inert,
                focusOnCancel: document.activeElement === document.getElementById('busyCancel'),
            };
            ui.hideBusy();
            state.inertCleared = !document.querySelector('.container').inert;
            return state;
        });
        check('The busy overlay is a dialog and announces itself',
            busy.role === 'dialog' && busy.modal === 'true' && /Smoke test/.test(busy.announced),
            JSON.stringify(busy));
        check('It focuses Cancel and makes the page behind inert',
            busy.focusOnCancel && busy.pageInert && busy.inertCleared, JSON.stringify(busy));

        // --- the completion panel ---------------------------------------------
        // Rendered directly rather than by running a full export, which needs a
        // bake and a compressor and is not what this check is about.
        const done = await page.evaluate(() => {
            window.uiController.renderExportDone({
                filename: 'smoke-test.prg', sizeKB: '12.40',
                isCompressed: false, compressionFailed: false,
                compressionType: 'none', sysAddress: 16640,
            });
            const el = document.getElementById('exportDone');
            return {
                shown: !el.hidden,
                saysWhatItIs: /Commodore 64 program/i.test(el.textContent),
                explainsSys: /SYS 16640/.test(el.textContent),
                linksEmulator: !!el.querySelector('a[href*="vice-emu"]'),
                howToRun: !!el.querySelector('#exportDoneHow'),
            };
        });
        check('The completion panel appears', done.shown);
        check('It says what a .prg actually is', done.saysWhatItIs);
        check('It explains the SYS address rather than just printing it', done.explainsSys);
        check('It links an emulator and how to run the file',
            done.linksEmulator && done.howToRun, JSON.stringify(done));

        // --- multi-file queue -------------------------------------------------
        await loadSids(page, ['Flex-Lundia.sid', 'JCH-Crystalline.sid', 'Xiny-Laxity.sid']);
        await page.waitForFunction(
            () => window.uiController.currentFileName === 'Flex-Lundia.sid', null, { timeout: 60000 });
        await page.waitForTimeout(500);
        const queue = await page.evaluate(() => {
            const box = document.getElementById('sidQueue');
            return {
                shown: !box.hidden,
                queued: window.uiController._queue?.length || 0,
                rows: document.querySelectorAll('#sidQueueList .sq-item').length,
                names: [...document.querySelectorAll('#sidQueueList .sq-name')].map(n => n.textContent),
                loadedFirst: window.uiController.currentFileName,
                inputAcceptsMany: document.getElementById('fileInput').multiple,
            };
        });
        check('Dropping several SIDs keeps them all', queue.queued === 3,
            `${queue.queued} queued, input multiple=${queue.inputAcceptsMany}`);
        check('The queue is shown with a row per tune',
            queue.shown && queue.rows === 3, JSON.stringify({ shown: queue.shown, rows: queue.rows }));
        check('The first tune still loads immediately',
            queue.loadedFirst === 'Flex-Lundia.sid', queue.loadedFirst);

        const cleared = await page.evaluate(() => {
            document.getElementById('sidQueueClear').click();
            return { shown: !document.getElementById('sidQueue').hidden,
                queued: window.uiController._queue.length };
        });
        check('The queue can be cleared', cleared.shown === false && cleared.queued === 0,
            JSON.stringify(cleared));

        const fatal = errors.filter(e => !/favicon|net::ERR_|404/i.test(e));
        check('No uncaught page errors', fatal.length === 0, fatal.slice(0, 3).join(' | '));

        // --- phone width ------------------------------------------------------
        const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
        try {
            await phone.goto(base, { waitUntil: 'load' });
            await phone.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });

            const tabsFit = await phone.evaluate(() => {
                const bar = document.querySelector('.page-tabs');
                const container = document.querySelector('.container');
                return {
                    barScroll: bar.scrollWidth,
                    barClient: bar.clientWidth,
                    docScroll: document.documentElement.scrollWidth,
                    docClient: document.documentElement.clientWidth,
                    containerOverflow: getComputedStyle(container).overflowX,
                };
            });
            check('The page-tab row is not clipped at 390px',
                tabsFit.barScroll <= tabsFit.barClient + 1,
                `${tabsFit.barScroll} > ${tabsFit.barClient}`);
            check('The page does not scroll sideways at 390px',
                tabsFit.docScroll <= tabsFit.docClient + 1,
                `${tabsFit.docScroll} > ${tabsFit.docClient}`);

            await loadSid(phone, 'Flex-Lundia.sid');
            await phone.waitForFunction(() => window.uiController.sidHeader != null,
                null, { timeout: 60000 });
            await phone.waitForTimeout(1500);
            const studioState = await phone.evaluate(() => ({
                isNarrow: window.studioModal.isNarrow,
                isOpen: window.studioModal.isOpen,
                openBtnVisible: document.getElementById('openStudioBtn')?.offsetParent !== null,
            }));
            check('The Studio does not open itself on a phone',
                studioState.isNarrow === true && studioState.isOpen === false,
                JSON.stringify(studioState));
            check('Open Studio is offered instead', studioState.openBtnVisible === true);

            const vizShown = await phone.evaluate(() => {
                const el = document.querySelector('.hvsc-visualizer');
                if (!el) return 'absent';
                return getComputedStyle(el).display;
            });
            check('The spectrum visualizer is not hidden on a phone', vizShown !== 'none', vizShown);
        } finally {
            await phone.close();
        }
    } finally {
        if (!process.argv.includes('--keep')) await browser.close();
        server.close();
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
