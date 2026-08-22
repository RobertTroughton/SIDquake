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
    // Every URL the page asks for, so a check can assert that nothing goes to a
    // third-party origin.
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
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

        // --- metadata is a form, and edits reach the header createPRG reads ---
        await page.evaluate(() => window.studioModal.activate('song'));
        await page.waitForTimeout(200);
        const meta = await page.evaluate(() => {
            const el = document.getElementById('sidAuthor');
            const isInput = el.tagName === 'INPUT';
            el.value = 'SMOKE TEST AUTHOR';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            const ui = window.uiController;
            return {
                isInput,
                labelled: !!document.querySelector('label[for="sidAuthor"]'),
                ui: ui.sidHeader.author,
                analyzer: ui.analyzer.sidHeader.author,
            };
        });
        check('Metadata fields are real labelled inputs', meta.isInput && meta.labelled,
            JSON.stringify({ isInput: meta.isInput, labelled: meta.labelled }));
        check('Typing reaches the header createPRG reads',
            meta.analyzer === 'SMOKE TEST AUTHOR' && meta.ui === 'SMOKE TEST AUTHOR',
            JSON.stringify(meta));

        const limits = await page.evaluate(() => {
            const el = document.getElementById('sidTitle');
            el.value = 'x'.repeat(30);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            const count = document.getElementById('sidTitleCount').textContent;
            // An accented character has no PETSCII equivalent and used to become
            // a space with no word said about it.
            el.value = 'Cafe\u0301 na\u00efve';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            const warn = document.getElementById('metadataWarning');
            return { count, maxlength: el.maxLength, warned: !warn.hidden, text: warn.textContent };
        });
        check('It says how much room is left', /1 left/.test(limits.count) && limits.maxlength === 31,
            JSON.stringify(limits));
        check('It warns about characters the C64 cannot show',
            limits.warned && /space/.test(limits.text), limits.text || 'no warning');

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

        // --- a shared link resolves from a shard, not the 2MB index -----------
        const shard = await page.evaluate(async () => {
            // The exact table build-share-meta.js writes, reached the way
            // hvsc-browser.js reaches it. That the four copies of this function
            // agree is scripts/test-share-shards.js's job; this one checks the
            // shard is actually there and holds what a shared link needs.
            const key = 'MUSICIANS/H/Hubbard_Rob/Commando.sid';
            const shardOf = (p) => {
                let h = 0x811c9dc5;
                for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 0x01000193); }
                return ((h >>> 0) & 0xfff).toString(16).padStart(3, '0');
            };
            const res = await fetch('share-meta/' + shardOf(key) + '.json');
            if (!res.ok) return { built: false };
            const table = await res.json();
            const bytes = (await new Response(JSON.stringify(table)).arrayBuffer()).byteLength;
            return { built: true, hasTune: !!table[key], meta: table[key], bytes };
        });
        if (!shard.built) {
            check('share-meta shards are built (npm run build-share-meta)', false, 'not found');
        } else {
            check('A shared tune resolves from its share-meta shard',
                shard.hasTune && Array.isArray(shard.meta), JSON.stringify(shard.meta));
            check('And that shard is a fraction of the index',
                shard.bytes < 8 * 1024, `${shard.bytes} B raw vs 11,700 KB`);
        }

        // --- the build reads a snapshot, not the live page --------------------
        const snapshot = await page.evaluate(async () => {
            const ui = window.uiController;
            await ui.ensurePRGExporter();
            const b = ui.prgExporter;
            const grid = document.querySelector('.bar-style-grid');
            if (!grid) return { skipped: true };
            const id = grid.dataset.configId;
            const live = document.getElementById(id).value;
            // With a snapshot installed the builder must report the snapshot's
            // value even while the control on the page says something else.
            b._optionValues = { [id]: '9' };
            const fromSnapshot = b.optionValue(id);
            b._optionValues = null;
            const fromDom = b.optionValue(id);
            return { skipped: false, live, fromSnapshot, fromDom };
        });
        if (snapshot.skipped) {
            check('the builder option snapshot is testable', false, 'no grid on this player');
        } else {
            check('The builder reads its option snapshot when it has one',
                snapshot.fromSnapshot === '9', JSON.stringify(snapshot));
            check('And falls back to the page when it does not',
                snapshot.fromDom === snapshot.live, JSON.stringify(snapshot));
        }

        // --- the quick path ---------------------------------------------------
        const quick = await page.evaluate(async () => {
            window.studioModal.close();
            await new Promise(r => setTimeout(r, 300));
            const box = document.getElementById('quickExport');
            const looks = [...document.querySelectorAll('.quick-look')];
            const before = looks.filter(l => l.classList.contains('selected')).map(l => l.dataset.id);
            // Choosing here has to move the real selection, not a parallel one.
            const other = looks.find(l => !l.classList.contains('selected'));
            if (other) other.click();
            await new Promise(r => setTimeout(r, 800));
            return {
                shown: !box.hidden,
                looks: looks.length,
                tabStops: looks.filter(l => l.tabIndex === 0).length,
                before,
                picked: other ? other.dataset.id : null,
                selected: window.uiController.selectedVisualizer?.dataSourceGroup
                    || window.uiController.selectedVisualizer?.id,
                hasButton: !!document.getElementById('quickExportBtn'),
            };
        });
        check('A loaded tune offers a quick path', quick.shown && quick.looks >= 2 && quick.hasButton,
            JSON.stringify({ shown: quick.shown, looks: quick.looks }));
        check('Its looks are one tab stop with radio behaviour', quick.tabStops === 1,
            `${quick.tabStops} tab stops`);
        check('Picking one moves the real selection',
            quick.picked === quick.selected, `${quick.picked} vs ${quick.selected}`);

        // A look built around a picture has to ask for the picture: exporting the
        // stock logo silently is the one outcome nobody wants.
        const quickLogo = await page.evaluate(async () => {
            const ui = window.uiController;
            ui._imageSelectionMemory = {};
            ui._quickImageAsked = new Set();
            const card = [...document.querySelectorAll('.quick-look')]
                .find(l => l.dataset.id === 'DefaultWithLogo');
            if (!card) return { offered: false };
            card.click();
            await new Promise(r => setTimeout(r, 1500));
            const modal = document.getElementById('galleryModal');
            const open = !!modal && modal.classList.contains('visible');
            const items = modal ? modal.querySelectorAll('.gallery-item-card').length : 0;
            if (open) window.imagePreviewManager.initGalleryModal().close();
            return { offered: true, open, items };
        });
        check('Picking a look with a logo asks which logo',
            !quickLogo.offered || (quickLogo.open && quickLogo.items > 0), JSON.stringify(quickLogo));

        // A tune the live bar methods cannot see has to say so where the choice is
        // being made. The 6510 side of the check is covered by test-vu-visibility;
        // this is about the warning reaching the quick path at all.
        const vuNote = await page.evaluate(async () => {
            const ui = window.uiController;
            ui._vuBlind = { leadingSeconds: 14, leadingAudible: true, frames: 1200 };
            ui._vuBlindFor = ui._analysisToken;
            const warn = document.getElementById('quickExportWarn');
            const pick = async (id) => {
                await ui.selectVisualizer(VISUALIZERS.find(v => v.id === id));
                await new Promise(r => setTimeout(r, 400));
                return { hidden: warn.hidden, text: warn.textContent };
            };
            const bars = await pick('RaistlinBars');
            const live = ui.selectedVisualizer?.dataSource;
            ui.selectDataSource('fft');
            ui.renderQuickExport();
            const fft = { hidden: warn.hidden };
            const text = await pick('default');
            ui._vuBlind = null;
            ui._vuBlindFor = -1;
            ui.renderQuickExport();
            return { bars, live, fft, text, cleared: warn.hidden };
        });
        check('A tune the live bars cannot see says so on the quick path',
            !vuNote.bars.hidden && /first 0:14/.test(vuNote.bars.text), JSON.stringify(vuNote.bars));
        check('...and points at the method that is unaffected',
            /best looking/i.test(vuNote.bars.text), vuNote.bars.text);
        check('...only while a live method is what would be exported',
            vuNote.live === 'realtime' && vuNote.fft.hidden && vuNote.text.hidden,
            JSON.stringify({ live: vuNote.live, fft: vuNote.fft.hidden, text: vuNote.text.hidden }));

        await page.evaluate(() => window.studioModal.open());
        await page.waitForTimeout(400);

        // --- fewer tabs -------------------------------------------------------
        const tabs = await page.evaluate(async () => {
            const ui = window.uiController;
            // The busiest player: a logo, a font, bar styles, colour effects.
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'RaistlinBarsWithLogo'));
            await new Promise(r => setTimeout(r, 900));
            const ids = window.studioModal.tabList().map(t => t.id);
            const fold = document.getElementById('methodFold');
            return {
                ids,
                hasMethodTab: ids.includes('method'),
                splitStyleTabs: ids.includes('barstyle') || ids.includes('color'),
                foldShown: fold && !fold.hidden,
                foldSaysWhich: (document.getElementById('methodFoldCurrent') || {}).textContent || '',
                methodCards: document.querySelectorAll('#methodMount .method-card').length,
            };
        });
        check('The busiest player is six tabs, not eight',
            tabs.ids.length <= 6 && !tabs.hasMethodTab && !tabs.splitStyleTabs,
            tabs.ids.join(','));
        check('How the bars are worked out folds under the grid instead',
            tabs.foldShown && tabs.methodCards >= 2, JSON.stringify(tabs));
        check('And the fold says which one is in use',
            tabs.foldSaysWhich.trim().length > 0, tabs.foldSaysWhich);

        // --- file naming ------------------------------------------------------
        const naming = await page.evaluate(() => {
            const ui = window.uiController;
            const tpl = document.getElementById('filenameTemplate');
            const before = ui.exportBaseName();
            tpl.value = '{author}-{title}';
            const templated = ui.exportBaseName();
            // A title with nothing a C64 directory can hold must not yield ".prg".
            const realTitle = ui.sidHeader.name;
            ui.sidHeader.name = '\u3042\u3044\u3046';
            ui.sidHeader.author = '\u3048\u304a';
            const unnameable = ui.exportBaseName();
            ui.sidHeader.name = realTitle;
            tpl.value = '{name}';
            return { before, templated, unnameable };
        });
        check('The file name follows its template',
            naming.templated.includes('-') && naming.templated !== naming.before,
            `${naming.before} -> ${naming.templated}`);
        check('A name with nothing usable falls back rather than producing ".prg"',
            naming.unnameable.length > 0, naming.unnameable);

        // --- the VIC bank preference ------------------------------------------
        const bank = await page.evaluate(() => {
            const ui = window.uiController;
            const sel = document.getElementById('advGfxBank');
            if (!sel) return { present: false };
            sel.value = String(0x8000);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            const saved = JSON.parse(localStorage.getItem('sidquakeAdvanced') || '{}');
            const readBack = ui.getAdvancedSettings().preferredGfxBank;
            sel.value = '';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return {
                present: true,
                stored: saved.preferredGfxBank,
                readBack,
                clearsToAuto: ui.getAdvancedSettings().preferredGfxBank,
                inAdvanced: !!document.getElementById('advancedSettings')
                    .contains(document.getElementById('advGfxBank')),
            };
        });
        check('The graphics bank can be preferred, and is remembered',
            bank.present && bank.stored === 0x8000 && bank.readBack === 0x8000,
            JSON.stringify(bank));
        check('It clears back to automatic, and lives under Advanced',
            !bank.clearsToAuto && bank.inAdvanced, JSON.stringify(bank));

        // --- settings save and reload ------------------------------------------
        const recipe = await page.evaluate(async () => {
            const ui = window.uiController;
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'RaistlinBars'));
            await new Promise(r => setTimeout(r, 700));
            // Set something distinctive through the real control, so the recipe
            // has to have picked it up the way a user's choice would be.
            const grid = document.querySelector('.bar-style-grid');
            const thumbs = [...grid.querySelectorAll('.bar-style-thumbnail')];
            ui.selectGridThumb(grid, thumbs[thumbs.length - 1]);
            const configId = grid.dataset.configId;
            const chosen = document.getElementById(configId).value;

            const saved = ui.buildRecipe();

            // Change it back, then apply the recipe and see it return.
            ui.selectGridThumb(grid, thumbs[0]);
            const reset = document.getElementById(configId).value;
            await ui.applyRecipe(saved);
            await new Promise(r => setTimeout(r, 700));
            return {
                version: saved.sidquake && saved.sidquake.recipe,
                card: saved.player && saved.player.card,
                chosen, reset,
                restored: document.getElementById(configId).value,
                note: document.getElementById('recipeNote').textContent,
            };
        });
        check('A recipe records the player and the options',
            recipe.version === 1 && recipe.card === 'RaistlinBars',
            JSON.stringify({ version: recipe.version, card: recipe.card }));
        check('Applying it puts a changed option back',
            recipe.chosen !== recipe.reset && recipe.restored === recipe.chosen,
            `chose ${recipe.chosen}, reset to ${recipe.reset}, restored ${recipe.restored}`);
        check('And it says so', /applied/i.test(recipe.note), recipe.note);

        const rejects = await page.evaluate(async () => {
            await window.uiController.applyRecipe({ nope: true });
            return document.getElementById('recipeNote').textContent;
        });
        check('A file that is not a recipe is refused', /does not look like/i.test(rejects), rejects);

        // A recipe dropped on the page applies itself, without disturbing the tune.
        const dropped = await page.evaluate(async () => {
            const ui = window.uiController;
            const grid = document.querySelector('.bar-style-grid');
            const thumbs = [...grid.querySelectorAll('.bar-style-thumbnail')];
            const configId = grid.dataset.configId;
            ui.selectGridThumb(grid, thumbs[thumbs.length - 1]);
            const chosen = document.getElementById(configId).value;
            const saved = ui.buildRecipe();
            ui.selectGridThumb(grid, thumbs[0]);
            const reset = document.getElementById(configId).value;

            const tuneBefore = ui.currentFileName;
            const file = new File([JSON.stringify(saved)], 'set.sqrecipe.json',
                { type: 'application/json' });
            await ui.acceptFiles([file]);
            await new Promise(r => setTimeout(r, 900));
            return {
                chosen, reset,
                restored: document.getElementById(configId).value,
                tuneKept: ui.currentFileName === tuneBefore,
            };
        });
        check('A settings file dropped on the page applies itself',
            dropped.chosen !== dropped.reset && dropped.restored === dropped.chosen,
            JSON.stringify(dropped));
        check('And it leaves the loaded tune alone', dropped.tuneKept === true,
            JSON.stringify(dropped));

        // What a build produced is recorded, and only while it still describes
        // the settings in front of the user.
        const builtBlock = await page.evaluate(async () => {
            const ui = window.uiController;
            const fake = new Uint8Array([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00]);
            ui._lastBuilt = {
                filename: 'x.prg', bytes: fake.length, blocks: 1,
                loadAddress: fake[0] | (fake[1] << 8), prgHash: ui.constructor.prgHash(fake),
            };
            ui._lastBuiltFrom = JSON.stringify(ui.buildRecipe());
            const withBuild = ui.buildRecipe(ui._builtIfStillCurrent());

            // Change a setting: the build no longer describes these settings.
            // Pick whichever thumbnail is not the current one - the checks above
            // leave the selection somewhere in particular.
            const grid = document.querySelector('.bar-style-grid');
            const thumbs = [...grid.querySelectorAll('.bar-style-thumbnail')];
            const configId2 = grid.dataset.configId;
            const now = document.getElementById(configId2).value;
            ui.selectGridThumb(grid, thumbs.find(t => t.dataset.value !== now) || thumbs[0]);
            const moved = document.getElementById(configId2).value !== now;
            const afterChange = ui.buildRecipe(ui._builtIfStillCurrent());
            return {
                hash: withBuild.built && withBuild.built.prgHash,
                load: withBuild.built && withBuild.built.loadAddress,
                moved,
                stillThere: !!afterChange.built,
                always: typeof ui.recipeAlways() === 'boolean',
            };
        });
        check('A recipe records what the build produced',
            builtBlock.hash && builtBlock.load === 0x0801, JSON.stringify(builtBlock));
        check('And drops it once the settings no longer match',
            builtBlock.stillThere === false, JSON.stringify(builtBlock));
        check('There is a switch for saving one with every PRG',
            builtBlock.always === true, JSON.stringify(builtBlock));

        // A settings file dropped with a set drives the whole set.
        const queueRecipe = await page.evaluate(async () => {
            const ui = window.uiController;
            const saved = ui.buildRecipe();
            saved.song = { subtune: 3, forceLoop: true, showLength: false, manualLengthSeconds: 90 };
            const file = new File([JSON.stringify(saved)], 'set.sqrecipe.json',
                { type: 'application/json' });
            await ui.acceptFiles([file]);
            await new Promise(r => setTimeout(r, 600));
            const held = !!ui._queueRecipe;

            // The song block belongs to the tune the recipe was made from, so a
            // queue replay must leave it out. (The typed-in length is a poor
            // witness: the background scan fills that field in on its own.)
            const loop = document.getElementById('forceLoopToggle');
            const applied = loop ? loop.checked : null;   // the recipe said true
            if (loop) loop.checked = false;
            await ui.applyRecipe(saved, { perTune: false, quiet: true });
            await new Promise(r => setTimeout(r, 600));
            return { held, applied, afterReplay: loop ? loop.checked : null };
        });
        check('A settings file dropped with a set is held for the run',
            queueRecipe.held === true, JSON.stringify(queueRecipe));
        check('Applying it normally carries the song settings',
            queueRecipe.applied === true, JSON.stringify(queueRecipe));
        check('And a queue replay leaves the first tune\'s song settings behind',
            queueRecipe.afterReplay === false, JSON.stringify(queueRecipe));

        // --- icons come from our own origin -----------------------------------
        const icons = await page.evaluate(async () => {
            // Wait for the deferred stylesheet to swap in.
            for (let i = 0; i < 100 && !document.fonts.check('900 16px "SIDquake Icons"'); i++) {
                await new Promise(r => setTimeout(r, 50));
            }
            const el = document.querySelector('.fa-music, .fas.fa-music');
            const cs = el ? getComputedStyle(el, '::before') : null;
            const glyph = cs ? cs.content.replace(/["']/g, '') : '';
            return {
                loaded: document.fonts.check('900 16px "SIDquake Icons"'),
                family: el ? getComputedStyle(el).fontFamily : null,
                glyph: glyph ? glyph.codePointAt(0).toString(16) : null,
                width: el ? Math.round(el.getBoundingClientRect().width) : 0,
            };
        });
        check('The icon font is the subset served from this origin',
            icons.loaded === true && /SIDquake Icons/.test(icons.family || ''),
            JSON.stringify(icons));
        check('And an icon still resolves to a real glyph',
            icons.glyph === 'f001' && icons.width > 4, JSON.stringify(icons));

        const offOrigin = requests.filter(u => /cdnjs|fontawesome/i.test(u));
        check('Nothing is fetched from cdnjs any more', offOrigin.length === 0,
            offOrigin.slice(0, 3).join(' | '));

        // --- the brands webfont is never requested ----------------------------
        const brands = await page.evaluate(() => ({
            fabUsages: document.querySelectorAll('.fab, [class*="fa-github"], [class*="fa-youtube"]').length,
            svgMarks: document.querySelectorAll('svg.brand-icon').length,
        }));
        check('No element pulls a Font Awesome brand glyph', brands.fabUsages === 0,
            `${brands.fabUsages} usages`);
        check('The GitHub and YouTube marks are inline SVG', brands.svgMarks >= 7,
            `${brands.svgMarks} marks`);

        // --- the index ships without its commentary ---------------------------
        const split = await page.evaluate(async () => {
            const lite = await fetch('hvsc-index-lite.json');
            if (!lite.ok) return { built: false };
            const data = await lite.json();
            const withStil = (data.entries || []).filter(e => e.s).length;
            const stil = await fetch('hvsc-stil.json');
            const table = stil.ok ? await stil.json() : {};
            return {
                built: true,
                flagged: data.stilSplit === true,
                entries: (data.entries || []).length,
                stilInIndex: withStil,
                stilEntries: Object.keys(table).length,
            };
        });
        if (!split.built) {
            check('the split index is built (npm run build-index-split)', false, 'not found');
        } else {
            check('The index ships without STIL commentary',
                split.flagged && split.stilInIndex === 0 && split.entries > 60000,
                JSON.stringify(split));
            check('And the commentary is a separate file',
                split.stilEntries > 20000, `${split.stilEntries} entries`);
        }

        // --- the HVSC listing is a listbox ------------------------------------
        const hvsc = await page.evaluate(async () => {
            document.getElementById('hvscBtn').click();
            // The listing needs the index; give it a while on a cold cache.
            const start = Date.now();
            while (Date.now() - start < 60000) {
                if (document.querySelectorAll('#fileList .file-item').length > 1) break;
                await new Promise(r => setTimeout(r, 250));
            }
            const list = document.getElementById('fileList');
            const rows = [...list.querySelectorAll('.file-item')];
            const before = rows.filter(r => r.tabIndex === 0).length;
            rows[0].focus();
            rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            const moved = document.activeElement !== rows[0]
                && rows.includes(document.activeElement);
            const state = {
                role: list.getAttribute('role'),
                rows: rows.length,
                tabStops: before,
                optionRole: rows.every(r => r.getAttribute('role') === 'option'),
                hasSelectedState: rows.every(r => r.hasAttribute('aria-selected')),
                moved,
                countLive: document.getElementById('itemCount').getAttribute('aria-live'),
            };
            document.getElementById('hvscModal').classList.remove('visible');
            return state;
        });
        check('The HVSC listing is a listbox of options',
            hvsc.role === 'listbox' && hvsc.optionRole && hvsc.hasSelectedState,
            JSON.stringify(hvsc));
        check('It is one tab stop, not one per row',
            hvsc.rows > 1 && hvsc.tabStops === 1, `${hvsc.rows} rows, ${hvsc.tabStops} tab stops`);
        check('Arrow keys move through it', hvsc.moved === true);
        check('The result count is announced', hvsc.countLive === 'polite', hvsc.countLive);

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
                bytes: 12698,
                span: { lo: 0x0900, hi: 0xFF3F },
                spanBytes: 0xFF3F - 0x0900 + 1,
                usedBytes: 12698,
            });
            const el = document.getElementById('exportDone');
            return {
                shown: !el.hidden,
                saysWhatItIs: /Commodore 64 program/i.test(el.textContent),
                explainsSys: /SYS 16640/.test(el.textContent),
                linksEmulator: !!el.querySelector('a[href*="vice-emu"]'),
                howToRun: !!el.querySelector('#exportDoneHow'),
                blocks: /50 disk blocks/.test(el.textContent),
                span: /\$0900-\$FF3F/.test(el.textContent),
                emptyWarning: /empty space/.test(el.textContent),
            };
        });
        check('The completion panel appears', done.shown);
        check('It says what a .prg actually is', done.saysWhatItIs);
        check('It explains the SYS address rather than just printing it', done.explainsSys);
        check('It links an emulator and how to run the file',
            done.linksEmulator && done.howToRun, JSON.stringify(done));
        check('It reports disk blocks and where the program runs',
            done.blocks && done.span, JSON.stringify(done));
        check('And warns when an uncompressed file is mostly empty space',
            done.emptyWarning, JSON.stringify(done));

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
        // Where a whole-set export puts its files.
        const dest = await page.evaluate(async () => {
            const el = document.getElementById('queueDestination');
            if (!el) return { missing: true };
            const values = [...el.options].map(o => o.value);
            const ui = window.uiController;

            // The zip route: divert the sink the way a run does, then deliver.
            const made = [];
            const realDownload = ui.downloadFile.bind(ui);
            ui.downloadFile = (data, name) => made.push({ name, len: data.length });
            await ui._deliverQueueFiles([
                { name: 'one.prg', data: new Uint8Array([1, 8, 9]) },
                { name: 'two.prg', data: new Uint8Array([1, 8, 7, 7]) },
            ]);
            ui.downloadFile = realDownload;
            return {
                values,
                offersFolder: values.includes('folder') === (typeof window.showDirectoryPicker === 'function'),
                made,
                zipHelper: typeof window.makeZip === 'function',
            };
        });
        check('A whole-set export can go somewhere other than downloads',
            !dest.missing && dest.values.includes('zip'), JSON.stringify(dest));
        check('The folder option is offered only where the browser has one',
            dest.offersFolder === true, JSON.stringify(dest));
        check('And the files arrive as one archive, not one download each',
            dest.zipHelper && dest.made.length === 1 && /\.zip$/.test(dest.made[0].name)
            && dest.made[0].len > 40, JSON.stringify(dest));

        check('The queue can be cleared', cleared.shown === false && cleared.queued === 0,
            JSON.stringify(cleared));

        // --- the drifting notes have an off switch ----------------------------
        const notes = await page.evaluate(async () => {
            const t = document.getElementById('notesToggle');
            if (!t) return { present: false };
            t.checked = false;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            const stored = localStorage.getItem('sidquakeNotesOff');
            await new Promise(r => setTimeout(r, 200));
            const gone = !document.querySelector('.floating-notes-container');
            t.checked = true;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return { present: true, stored, gone, restored: localStorage.getItem('sidquakeNotesOff') };
        });
        check('The background notes can be turned off and it sticks',
            notes.present && notes.stored === '1' && notes.restored === '0',
            JSON.stringify(notes));

        // --- one h1 per document ----------------------------------------------
        const h1Count = await page.evaluate(() => document.querySelectorAll('h1').length);
        check('The document has a single h1', h1Count === 1, `${h1Count} found`);

        // --- the rail survives typing -----------------------------------------
        const railReuse = await page.evaluate(async () => {
            window.studioModal.activate('song');
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const rail = document.getElementById('studioRail');
            const before = [...rail.querySelectorAll('.studio-tab')];
            // Panels stay mounted, so pick one that is actually showing -
            // focus() on a hidden field is a no-op.
            const field = [...document.querySelectorAll('#studioPanels input[type="text"]')]
                .find(el => el.offsetParent !== null);
            if (!field) return { skipped: 'no visible text field on the open panel' };
            field.focus();
            field.value = field.value + 'x';
            field.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const after = [...rail.querySelectorAll('.studio-tab')];
            return {
                count: after.length,
                sameNodes: before.length === after.length
                    && before.every((b, i) => b === after[i]),
                focusKept: document.activeElement === field,
                field: field.id || field.name || field.className,
                landedOn: document.activeElement.id || document.activeElement.tagName,
            };
        });
        if (railReuse.skipped) {
            console.log(`SKIP  rail reuse - ${railReuse.skipped}`);
        } else {
            check('Typing in a panel does not rebuild the tab rail',
                railReuse.sameNodes === true, JSON.stringify(railReuse));
            check('And the field keeps focus while it types',
                railReuse.focusKept === true, JSON.stringify(railReuse));
        }

        // --- a tap before ui.js is ready is not lost ---------------------------
        const earlyTap = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        try {
            // Stop the page at first paint and tap before the load chain runs.
            await earlyTap.goto(base, { waitUntil: 'domcontentloaded' });
            const tap = await earlyTap.evaluate(() => {
                const early = !window.uiController;
                document.getElementById('hvscBtn').click();
                return { early, waking: !!document.querySelector('.upload-btn.is-waking') };
            });
            if (!tap.early) {
                console.log('SKIP  early tap - ui.js was already up at first paint');
            } else {
                await earlyTap.waitForFunction(() => !!window.uiController, null, { timeout: 30000 });
                const opened = await earlyTap.waitForFunction(
                    () => document.getElementById('hvscModal').classList.contains('visible'),
                    null, { timeout: 30000 }).then(() => true).catch(() => false);
                check('A tap before the page finishes loading is acted on, not dropped',
                    opened === true, JSON.stringify(tap));
                check('And the button says the tap is coming rather than looking inert',
                    tap.waking === true, JSON.stringify(tap));
            }
        } finally {
            await earlyTap.close();
        }

        // --- a script that never arrives must read as missing -----------------
        // An element id is a window property, and <div id="studioModal"> shares
        // its name with the controller. With that script missing, every
        // `if (window.studioModal)` guard used to be handed the DIV and the
        // first call threw - which killed loading a tune, Random SID included.
        const noStudio = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        try {
            const errors = [];
            noStudio.on('pageerror', (e) => errors.push(String(e)));
            await noStudio.route('**/studio-modal.js*', (route) => route.abort());
            await noStudio.goto(base, { waitUntil: 'load' });
            await noStudio.waitForFunction(() => !!window.uiController, null, { timeout: 60000 });
            const guard = await noStudio.evaluate(() => ({
                tag: window.studioModal && window.studioModal.tagName || null,
                guardPasses: !!window.studioModal,
            }));
            await loadSid(noStudio, 'Flex-Lundia.sid');
            const loaded = await noStudio.waitForFunction(
                () => !!(window.uiController.sidHeader && window.uiController.sidHeader.name !== undefined),
                null, { timeout: 60000 }).then(() => true).catch(() => false);
            check('A missing script does not leave its element standing in for it',
                guard.tag === null && guard.guardPasses === false, JSON.stringify(guard));
            check('...so a tune still loads without the Studio',
                loaded && !errors.length, JSON.stringify({ loaded, errors }));
        } finally {
            await noStudio.close();
        }

        // --- the choice survives a reload -------------------------------------
        const remembered = await page.evaluate(async () => {
            const ui = window.uiController;
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'RaistlinBars'));
            await new Promise(r => setTimeout(r, 600));
            const grid = document.querySelector('.bar-style-grid');
            const thumbs = [...grid.querySelectorAll('.bar-style-thumbnail')];
            const configId = grid.dataset.configId;
            const now = document.getElementById(configId).value;
            ui.selectGridThumb(grid, thumbs.find(t => t.dataset.value !== now) || thumbs[0]);
            ui._rememberOptionValues({ [configId]: document.getElementById(configId).value }, {});
            let stored = null;
            try { stored = JSON.parse(localStorage.getItem('sidquakeSession')); } catch (e) { /* blocked */ }
            return {
                stored,
                chosen: document.getElementById(configId).value,
                configId,
            };
        });
        check('The player and options are written down for the next visit',
            !!remembered.stored && remembered.stored.visualizer === 'RaistlinBars'
            && remembered.stored.options[remembered.configId] === remembered.chosen,
            JSON.stringify(remembered));
        // The option sweep also catches the open tune's own fields; those must
        // not follow the user into a new session and stamp one tune's credits
        // onto the next.
        const carried = Object.keys((remembered.stored && remembered.stored.options) || {});
        check('But this tune\'s title, author and sub-tune are not',
            !carried.some(k => ['sidTitle', 'sidAuthor', 'sidCopyright', 'songSelector',
                'songLengthManual'].includes(k)), carried.join(', '));
        check('Nor the advanced settings, which have their own store',
            !carried.some(k => /^adv[A-Z]/.test(k)), carried.join(', '));

        const afterReload = await page.evaluate(async () => {
            // A fresh controller reads the same storage a reload would.
            const fresh = Object.create(UIController.prototype);
            fresh._optionMemory = {};
            fresh._imageSelectionMemory = {};
            fresh._restoreSessionMemory();
            return {
                visualizer: fresh._lastVisualizerId,
                options: fresh._optionMemory,
            };
        });
        check('And a fresh page picks them back up',
            afterReload.visualizer === 'RaistlinBars'
            && afterReload.options[remembered.configId] === remembered.chosen,
            JSON.stringify(afterReload));

        // --- memory the export must leave alone -------------------------------
        const parses = await page.evaluate(() => {
            const p = (t) => UIController.parseReservedRanges(t);
            const hex = (r) => r.map(x => `${x.start.toString(16)}-${x.end.toString(16)}`).join(' ');
            return {
                range: hex(p('$C000-$CFFF').ranges),
                bare: hex(p('$C000').ranges),
                several: hex(p('c000-cfff, 0900').ranges),
                backwards: p('$C000-$BFFF').bad,
                nonsense: p('nope').bad,
                empty: p('').ranges.length,
            };
        });
        check('Reserved memory is read the way it is written',
            parses.range === 'c000-d000' && parses.several === 'c000-d000 900-a00',
            JSON.stringify(parses));
        check('A bare address means its page, not one byte',
            parses.bare === 'c000-c100', JSON.stringify(parses));
        check('And what cannot be read is reported, not silently dropped',
            parses.backwards.length === 1 && parses.nonsense.length === 1 && parses.empty === 0,
            JSON.stringify(parses));

        const respected = await page.evaluate(async () => {
            const ui = window.uiController;
            const ex = ui.prgExporter;
            const config = ui.currentVisualizerConfig;
            const sidInfo = ex.extractSIDMusicData();
            const free = await ex.previewPlacement(config, sidInfo.loadAddress, sidInfo.data, null, []);
            // Reserve the whole page the code landed on, and it has to move.
            const page1 = free.plan.codePage;
            const held = await ex.previewPlacement(config, sidInfo.loadAddress, sidInfo.data, null,
                [{ start: page1, end: page1 + free.plan.codeBlob.length }]);
            let refused = false;
            try {
                // Reserve everything the CPU can see: nothing can be placed.
                await ex.previewPlacement(config, sidInfo.loadAddress, sidInfo.data, null,
                    [{ start: 0x0900, end: 0xD000 }, { start: 0xE000, end: 0xFFFA }]);
            } catch (e) { refused = true; }
            return { page1, moved: held.plan.codePage, refused };
        });
        check('Reserved memory is left alone by the placement',
            respected.moved !== respected.page1, JSON.stringify(respected));
        check('And reserving everything is refused rather than ignored',
            respected.refused === true, JSON.stringify(respected));

        // --- a custom fade shows what it produces, not just its swatches -------
        const fade = await page.evaluate(async () => {
            const ui = window.uiController;
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'RaistlinBars'));
            await new Promise(r => setTimeout(r, 900));
            const editor = document.querySelector('.palette-editor[data-kind="fade"]');
            if (!editor) return { skipped: 'no fade editor on this player' };
            const canvas = editor.querySelector('.palette-live-canvas');
            if (!canvas) return { missing: true };

            const colours = () => {
                const px = canvas.getContext('2d')
                    .getImageData(0, 0, canvas.width, canvas.height).data;
                const seen = new Set();
                for (let i = 0; i < px.length; i += 4) {
                    seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
                }
                return [...seen].sort().join(',');
            };
            const before = colours();

            // Change the fade by hand, the way a user fine-tuning would.
            const input = document.getElementById(editor.dataset.editorId);
            const swatches = [...editor.querySelectorAll('.palette-swatch')];
            ui.setPaletteSwatch(swatches[0], 7);
            ui.setPaletteSwatch(swatches[1], 8);
            ui.syncPaletteInput(editor);
            await new Promise(r => setTimeout(r, 100));
            return {
                before, after: colours(), values: input.value,
                distinctBefore: before.split(',').length,
            };
        });
        if (fade.skipped) {
            console.log(`SKIP  fade preview - ${fade.skipped}`);
        } else {
            check('A custom fade is previewed, not just listed as swatches',
                !fade.missing && fade.distinctBefore > 2,
                JSON.stringify({ distinct: fade.distinctBefore }));
            check('And the preview follows the colours as they are edited',
                fade.before !== fade.after, JSON.stringify({ values: fade.values }));
        }

        // --- the text lines, as the C64 will draw them ------------------------
        const textPreview = await page.evaluate(async () => {
            const ui = window.uiController;
            window.studioModal.activate('song');
            const title = document.getElementById('sidTitle');
            title.value = 'PREVIEW TEST';
            title.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 600));
            await ui.renderTextPreview();

            const row = document.getElementById('textPreviewRow');
            const canvas = document.getElementById('textPreview');
            const ctx = canvas.getContext('2d');
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            // Ink pixels per row of the title line, so "is anything drawn" and
            // "is it centred" can both be answered.
            let ink = 0, firstX = -1, lastX = -1;
            const bg = [px[0], px[1], px[2]];
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < canvas.width; x++) {
                    const o = (y * canvas.width + x) * 4;
                    if (px[o] !== bg[0] || px[o + 1] !== bg[1] || px[o + 2] !== bg[2]) {
                        ink++;
                        if (firstX < 0 || x < firstX) firstX = x;
                        if (x > lastX) lastX = x;
                    }
                }
            }

            // A title too long for 32 columns must say so.
            title.value = 'A TITLE FAR TOO LONG FOR THIRTY TWO COLUMNS OF SCREEN';
            title.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 600));
            await ui.renderTextPreview();
            const warned = document.getElementById('textPreviewNote').textContent;

            title.value = 'Lundiax';
            title.dispatchEvent(new Event('input', { bubbles: true }));
            return {
                shown: !row.hidden,
                size: `${canvas.width}x${canvas.height}`,
                ink, firstX, lastX,
                leftGap: firstX, rightGap: canvas.width - 1 - lastX,
                warned,
            };
        });
        check('The text lines are shown as the C64 will draw them',
            textPreview.shown && textPreview.size === '256x24', JSON.stringify(textPreview));
        check('With real glyphs on them', textPreview.ink > 50, `${textPreview.ink} ink pixels`);
        // 32 columns, "PREVIEW TEST" is 12: centring leaves 10 columns each side.
        check('And centred the way the export centres them',
            Math.abs(textPreview.leftGap - textPreview.rightGap) <= 8,
            `${textPreview.leftGap}px left, ${textPreview.rightGap}px right`);
        check('A line too long for the screen says so, by the name on the field',
            /^Title will not fit the 32 columns/i.test(textPreview.warned), textPreview.warned);

        // --- where it goes, before the export ---------------------------------
        const plan = await page.evaluate(async () => {
            const ui = window.uiController;
            await ui.selectVisualizer(VISUALIZERS.find(v => v.id === 'RaistlinBars'));
            await ui.renderPlacementPlan();
            const el = document.getElementById('placementPlan');
            const text = el.textContent;
            const mapShown = getComputedStyle(document.getElementById('memoryMap')).display;
            return {
                shown: !el.hidden,
                saysSys: /SYS \d+/.test(text),
                saysBank: /VIC bank [0-3]/.test(text),
                saysCode: /Player code/.test(text) && /\$[0-9A-F]{4}/.test(text),
                saysItIsAPlan: /plan, not the finished file/i.test(text),
                mapStillHidden: mapShown === 'none',
            };
        });
        check('Where the export will land is shown before it happens', plan.shown === true,
            JSON.stringify(plan));
        check('It names the SYS address, the code page and the VIC bank',
            plan.saysSys && plan.saysCode && plan.saysBank, JSON.stringify(plan));
        check('And says it is a plan rather than the finished file',
            plan.saysItIsAPlan === true, JSON.stringify(plan));
        check('The memory map still waits for a real export',
            plan.mapStillHidden === true, JSON.stringify(plan));

        // A preview must not leave the exporter thinking an export happened.
        const clean = await page.evaluate(async () => {
            const ui = window.uiController;
            const ex = ui.prgExporter;
            ex.lastSysAddress = 0x1234;
            ex.lastGfxBankPreferenceHonoured = true;
            const before = ex.builder.getInfo().components.length;
            await ui.renderPlacementPlan();
            return {
                sys: ex.lastSysAddress,
                honoured: ex.lastGfxBankPreferenceHonoured,
                components: ex.builder.getInfo().components.length,
                before,
            };
        });
        check('Previewing leaves the real exporter untouched',
            clean.sys === 0x1234 && clean.honoured === true
            && clean.components === clean.before, JSON.stringify(clean));

        // --- stopping a long scan keeps what it found -------------------------
        const stopScan = await page.evaluate(() => {
            const ui = window.uiController;
            const status = document.getElementById('songLoopStatus');
            const said = {};
            // The three ways a scan can come back with no loop read differently.
            for (const [name, extra] of [
                ['ranOut', { cappedAtMaxSeconds: true }],
                ['stopped', { stoppedEarly: true }],
                ['cut', { truncated: true, loopStartSeconds: 360 }],
                ['plain', {}],
            ]) {
                ui.tuneAnalysis = {
                    looped: false, fadedOut: false, analyzedSeconds: 360,
                    storedSeconds: 360, loopStartSeconds: 0, ...extra,
                };
                ui.updateSongLoopStatus();
                said[name] = status.textContent;
            }
            ui.tuneAnalysis = null;
            ui.updateSongLoopStatus();
            return {
                ...said,
                hasStopButton: !!document.getElementById('analysisChipStop'),
                hasStopMethod: typeof ui.stopSearching === 'function',
            };
        });
        check('A scan that ran out of window says so, rather than "no loop"',
            /as far as the scan looks/i.test(stopScan.ranOut)
            && /keep looking/i.test(stopScan.ranOut), stopScan.ranOut);
        check('A scan the user stopped says that instead',
            /You stopped the search/i.test(stopScan.stopped), stopScan.stopped);
        check('And a scan that simply found nothing still says that',
            /No repeat or fade-out found/i.test(stopScan.plain), stopScan.plain);
        check('A tune still playing where the scan stops gets no invented length',
            /still playing at 6:00/i.test(stopScan.cut)
            && /running clock with no total/i.test(stopScan.cut), stopScan.cut);

        // --- searching further, when nothing was resolved ---------------------
        const keepLooking = await page.evaluate(() => {
            const ui = window.uiController;
            const status = document.getElementById('songLoopStatus');
            const btn = document.getElementById('songLengthKeepLooking');
            const seen = {};
            ui._scanWindowOverride = 0;
            ui.tuneAnalysis = {
                looped: false, fadedOut: false, truncated: true, cappedAtMaxSeconds: true,
                analyzedSeconds: 1200, storedSeconds: 1200, loopStartSeconds: 1200,
            };
            ui.updateSongLoopStatus();
            seen.offered = !btn.hidden;
            seen.label = btn.textContent;
            seen.said = status.textContent;
            // The window in force here depends on what earlier checks set, so the
            // figure is derived rather than hardcoded: doubling it, then doubled
            // again because a loop needs two passes to confirm.
            seen.listens = ui._mmss(ui.nextScanWindowSeconds() * 2);
            // A resolved tune has nothing more to look for.
            ui.tuneAnalysis = { looped: true, storedSeconds: 120, loopStartSeconds: 0 };
            ui.updateSongLoopStatus();
            seen.hiddenWhenLooped = btn.hidden;
            // ...and neither has one that has already been searched to the cap.
            ui._scanWindowOverride = window.uiController.constructor.MAX_SCAN_WINDOW;
            ui.tuneAnalysis = {
                looped: false, fadedOut: false, truncated: true, cappedAtMaxSeconds: true,
                analyzedSeconds: 7200, storedSeconds: 7200, loopStartSeconds: 7200,
            };
            ui.updateSongLoopStatus();
            seen.hiddenAtCap = btn.hidden;
            seen.saidAtCap = status.textContent;
            ui._scanWindowOverride = 0;
            ui.tuneAnalysis = null;
            ui.updateSongLoopStatus();
            return seen;
        });
        check('A scan that resolved nothing offers to keep looking',
            keepLooking.offered && /keep looking/i.test(keepLooking.said), keepLooking.said);
        check('And says how far that would listen',
            keepLooking.label.includes(keepLooking.listens)
            && keepLooking.said.includes(keepLooking.listens),
            `${keepLooking.label} vs ${keepLooking.listens}`);
        check('It is not offered when the tune was measured', keepLooking.hiddenWhenLooped);
        check('Nor when the search is already at its limit',
            keepLooking.hiddenAtCap && !/keep looking/i.test(keepLooking.saidAtCap),
            keepLooking.saidAtCap);

        // ...and pressing it really does run a wider search, rather than leaving
        // the tune unmeasured because the old job was still letting go.
        const searchedAgain = await page.evaluate(async () => {
            const ui = window.uiController;
            const before = ui.scanWindowSeconds();
            await ui.keepLooking();
            const widened = ui.scanWindowSeconds();
            // The scan runs in the background; wait for it to settle either way.
            for (let i = 0; i < 240 && (ui.analysisRunning || !ui.tuneAnalysis); i++) {
                await new Promise(r => setTimeout(r, 500));
            }
            const after = ui.scanWindowSeconds();
            ui._scanWindowOverride = 0;
            return { before, widened, after, measured: !!ui.tuneAnalysis,
                studioOpen: window.studioModal.isOpen };
        });
        check('Keeping looking widens the search', searchedAgain.widened === searchedAgain.before * 2,
            `${searchedAgain.before} -> ${searchedAgain.widened}`);
        check('...and the wider search actually runs and lands',
            searchedAgain.measured && searchedAgain.after === searchedAgain.widened,
            JSON.stringify(searchedAgain));
        check('There is a way to stop searching and keep the answer',
            stopScan.hasStopButton && stopScan.hasStopMethod, JSON.stringify({
                b: stopScan.hasStopButton, m: stopScan.hasStopMethod }));

        // The soft stop reaches the render: start a scan, stop it, and the job
        // must resolve with a measurement rather than throwing it away.
        const softStop = await page.evaluate(async () => {
            const ui = window.uiController;
            const cb = window.cacheBust || (s => s);
            // A tune measured earlier in this run comes straight back from the
            // store, and there is nothing to stop - so start from a clean slate.
            const { clearAnalyses } = await import(cb('./analysis-store.js'));
            await clearAnalyses();
            ui.tuneAnalysis = null;
            ui._analysisJob = null;

            const p = ui._ensureAnalysis({});
            // Stop as soon as there is a scan to stop; a short tune can finish
            // before a fixed wait is up.
            let running = false;
            for (let i = 0; i < 100 && !running; i++) {
                running = ui.analysisRunning;
                if (!running) await new Promise(r => setTimeout(r, 50));
            }
            if (!running) return { skipped: 'the scan finished before it could be stopped' };
            ui.stopSearching();
            const result = await p;
            return { got: !!result, cancelled: ui._analysisCancelled };
        });
        if (softStop.skipped) {
            console.log(`SKIP  soft stop - ${softStop.skipped}`);
        } else {
            check('Stopping keeps the measurement instead of discarding it',
                softStop.got === true && softStop.cancelled === false, JSON.stringify(softStop));
        }

        // --- the collection index says how far along it is ---------------------
        // 7.5 MB behind a bare spinner is a page that looks stuck rather than
        // busy, so hold the response back and read what the list says.
        const slow = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        try {
            let release = null;
            const held = new Promise((r) => { release = r; });
            await slow.route('**/hvsc-index*.json', async (route) => {
                await held;
                await route.continue();
            });
            await slow.goto(base, { waitUntil: 'load' });
            await slow.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });
            await slow.evaluate(() => window.uiController.openHVSCBrowser());
            const said = await slow.waitForFunction(
                () => {
                    const el = document.querySelector('#fileList .file-list-loading-text');
                    return el && /Loading the collection/i.test(el.textContent) ? el.textContent : null;
                }, null, { timeout: 20000 }).then(h => h.jsonValue()).catch(() => null);
            const polite = await slow.evaluate(() => {
                const el = document.querySelector('#fileList .file-list-loading-text');
                return el ? el.getAttribute('aria-live') : null;
            });
            release();
            check('The list says what it is waiting for, not just a spinner',
                typeof said === 'string' && /collection/i.test(said), String(said));
            check('And announces it politely rather than on every chunk',
                polite === 'polite', String(polite));
        } finally {
            await slow.close();
        }

        // --- the bake worker runs one job at a time ---------------------------
        const workerJobs = await page.evaluate(async () => {
            const cb = window.cacheBust || (s => s);
            // Classic worker, same as spectrometer-bake-runner.js creates: the
            // worker importScripts() the engine glue, which a module worker cannot.
            const w = new Worker(cb('./spectrometer-bake-worker.js'));
            const bytes = window.uiController.analyzer.createModifiedSID();
            const opts = {
                subtune: 0, numBars: 40, maxHeight: 111, maxSeconds: 12,
                minLoopSeconds: 2, engine: 'resid',
            };
            const events = [];
            const done = {};
            const ready = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('worker never became ready')), 30000);
                w.onmessage = (e) => {
                    const m = e.data;
                    if (m.type === 'ready') { clearTimeout(t); resolve(); return; }
                    if (m.type === 'unsupported') { clearTimeout(t); reject(new Error(m.message)); return; }
                    if (m.type === 'progress') events.push(`p${m.id}`);
                    if (m.type === 'done') { events.push(`d${m.id}`); done[m.id] = 'done'; }
                    if (m.type === 'error') {
                        events.push(`e${m.id}:${m.name}:${m.message}`);
                        done[m.id] = m.name;
                    }
                };
            });
            w.postMessage({ type: 'init', cacheBust: '' });
            await ready;

            const copy = () => new Uint8Array(bytes).buffer;
            w.postMessage({ type: 'run', id: 1, op: 'analyze', sidBytes: copy(), options: opts });
            w.postMessage({ type: 'run', id: 2, op: 'analyze', sidBytes: copy(), options: opts });
            // Job 2 is queued behind job 1, so this abort must reach it before it
            // ever starts - the controller is registered when the message lands,
            // not when the run begins.
            w.postMessage({ type: 'abort', id: 2 });

            const t0 = performance.now();
            while (!(done[1] && done[2]) && performance.now() - t0 < 90000) {
                await new Promise(r => setTimeout(r, 100));
            }
            w.terminate();
            // Nothing from job 2 may appear before job 1 has finished.
            const firstTwo = events.findIndex(e => e.endsWith('2'));
            const oneDone = events.indexOf('d1');
            return { one: done[1], two: done[2], interleaved: firstTwo !== -1 && firstTwo < oneDone,
                     events: events.slice(0, 6).concat(events.length > 6 ? ['…'] : []) };
        }).catch(e => ({ failed: String(e && e.message || e) }));
        if (workerJobs.failed) {
            console.log(`SKIP  bake worker job order - ${workerJobs.failed}`);
        } else {
            check('The bake worker finishes one job before starting the next',
                workerJobs.interleaved === false, JSON.stringify(workerJobs));
            check('A job aborted while it is still queued never runs',
                workerJobs.two === 'AbortError', JSON.stringify(workerJobs));
        }

        // --- measurements are remembered across reloads -----------------------
        const store = await page.evaluate(async () => {
            const cb = window.cacheBust || (s => s);
            const { readAnalysis, writeAnalysis, clearAnalyses } =
                await import(cb('./analysis-store.js'));
            await clearAnalyses();
            const miss = await readAnalysis('smoke-key');
            await writeAnalysis('smoke-key', { looped: true, storedSeconds: 123.5 });
            const hit = await readAnalysis('smoke-key');
            await clearAnalyses();
            const gone = await readAnalysis('smoke-key');
            return {
                miss, hit, gone,
                roundTrip: !!hit && hit.looped === true && hit.storedSeconds === 123.5,
            };
        });
        check('A measurement survives being written and read back',
            store.miss === null && store.roundTrip === true && store.gone === null,
            JSON.stringify(store));

        // The end of it: a tune already measured is not measured again.
        const reuse = await page.evaluate(async () => {
            const ui = window.uiController;
            if (!ui.tuneAnalysis) return { skipped: 'the background scan has not finished' };
            const stored = { ...ui.tuneAnalysis };
            ui.tuneAnalysis = null;
            ui._analysisJob = null;
            let scanned = false;
            const t0 = performance.now();
            await ui._ensureAnalysis({ onProgress: () => { scanned = true; } });
            return {
                ms: Math.round(performance.now() - t0),
                scanned,
                same: !!ui.tuneAnalysis
                    && ui.tuneAnalysis.storedSeconds === stored.storedSeconds
                    && ui.tuneAnalysis.looped === stored.looped,
            };
        });
        if (reuse.skipped) {
            console.log(`SKIP  measurement reuse - ${reuse.skipped}`);
        } else {
            check('A tune already measured is not measured again',
                reuse.scanned === false && reuse.ms < 1500, JSON.stringify(reuse));
            check('And the remembered answer is the one it found',
                reuse.same === true, JSON.stringify(reuse));
        }

        const keyStable = await page.evaluate(async () => {
            const ui = window.uiController;
            const o = {
                subtune: 0, numBars: 40, maxHeight: 111,
                maxSeconds: 1200, minLoopSeconds: 2, engine: 'fp', outputMaxSeconds: 0,
            };
            const bytes = ui.analyzer.createModifiedSID();
            const before = await ui._analysisCacheKey(bytes, o);
            // Rename the tune and re-derive: the key must not move.
            const title = document.getElementById('sidTitle');
            const was = title.value;
            title.value = 'Renamed For The Check';
            title.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const after = await ui._analysisCacheKey(ui.analyzer.createModifiedSID(), o);
            title.value = was;
            title.dispatchEvent(new Event('input', { bubbles: true }));
            // A different setting must move it.
            const other = await ui._analysisCacheKey(bytes, { ...o, minLoopSeconds: 9 });
            return { before, after, other };
        });
        check('Renaming a tune does not throw its measurement away',
            !!keyStable.before && keyStable.before === keyStable.after,
            JSON.stringify(keyStable));
        check('But changing a scan setting does',
            keyStable.other !== keyStable.before, JSON.stringify(keyStable));

        // --- overlay precedence -----------------------------------------------
        const overlays = await page.evaluate(() => {
            const tagged = [...document.querySelectorAll('[data-overlay]')].map(el => el.id);
            // Anything that covers the viewport and sits above the page (z 900)
            // is an overlay and must carry the attribute, or the keyboard
            // handlers will not know to stand down for it.
            const untagged = [...document.querySelectorAll('div[id]')].filter((el) => {
                const cs = getComputedStyle(el);
                const z = parseInt(cs.zIndex, 10);
                return cs.position === 'fixed' && z >= 1000 && !el.hasAttribute('data-overlay');
            }).map(el => el.id);
            return { tagged, untagged, hasHelper: typeof window.overlayAbove === 'function' };
        });
        check('Every overlay declares itself with data-overlay',
            overlays.hasHelper && overlays.untagged.length === 0,
            JSON.stringify(overlays));

        const precedence = await page.evaluate(() => {
            // Hide everything first so the comparison is only between the two
            // being tested (a lingering toast is itself an overlay).
            const was = [...document.querySelectorAll('[data-overlay].visible')];
            for (const el of was) el.classList.remove('visible');
            const studio = document.getElementById('studioModal');
            const hvsc = document.getElementById('hvscModal');
            studio.classList.add('visible');
            hvsc.classList.add('visible');
            const out = {
                order: window.overlayOrder().map(o => `${o.id}:${o.z}`),
                hvscAboveStudio: window.overlayAbove('studioModal'),
                studioNotAboveHvsc: window.overlayAbove('hvscModal'),
            };
            hvsc.classList.remove('visible');
            out.aloneIsClear = window.overlayAbove('studioModal');
            studio.classList.remove('visible');
            for (const el of was) el.classList.add('visible');
            return out;
        });
        check('The browser layered over the Studio takes the keyboard',
            precedence.hvscAboveStudio === true && precedence.studioNotAboveHvsc === false,
            JSON.stringify(precedence));
        check('And the Studio takes it back when nothing is above it',
            precedence.aloneIsClear === false, JSON.stringify(precedence));

        // --- HVSC search paints in chunks -------------------------------------
        // The index is gitignored (npm run extract-hvsc builds it), so skip
        // rather than fail when it isn't there.
        const hasIndex = await page.evaluate(async () => {
            const r = await fetch('/hvsc-index-lite.json', { method: 'HEAD' });
            return r.ok;
        }).catch(() => false);
        if (!hasIndex) {
            console.log('SKIP  HVSC search checks - no local index');
        } else {
            await page.evaluate(() => window.uiController.openHVSCBrowser());
            await page.waitForFunction(
                () => document.querySelectorAll('#fileList .file-item').length > 0,
                null, { timeout: 120000 });

            // The directory tree is built from the flat index in one pass.
            const tree = await page.evaluate(async () => {
                const rows = () => [...document.querySelectorAll('#fileList .file-item')];
                const root = rows().map(r => r.textContent.trim());
                const dir = rows().find(r => r.classList.contains('directory'));
                const name = dir ? dir.textContent.trim() : null;
                if (dir) dir.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                await new Promise(r => setTimeout(r, 400));
                return {
                    rootDirs: root.length,
                    into: name,
                    inside: rows().length,
                    path: document.getElementById('currentPath')?.textContent || '',
                };
            });
            check('The folder tree lists the archive root', tree.rootDirs > 0,
                JSON.stringify(tree));
            check('And a folder can be opened to show what is in it',
                tree.inside > 0 && !!tree.into, JSON.stringify(tree));
            await page.evaluate(() => window.hvscBrowser.navigateHome());
            await page.waitForTimeout(200);

            // A broad query caps at 500 results. The first chunk must land in
            // the same turn the search runs; the rest arrive over later frames.
            const first = await page.evaluate(async () => {
                const input = document.getElementById('hvscSearchBar');
                input.value = 'a';
                input.dispatchEvent(new Event('input', { bubbles: true }));

                // Catch the first paint: the search is debounced, then the first
                // chunk lands in the same turn and the rest over later frames.
                // Sampling on a timer would count however many frames the timer
                // happened to span.
                const rows = () => document.querySelectorAll('#fileList .file-item').length;
                // The previous query's rows are still up until the search runs,
                // so wait for the count to CHANGE, not merely to be non-zero.
                const before = rows();
                for (let i = 0; i < 200; i++) {
                    if (rows() !== before) return rows();
                    await new Promise(r => setTimeout(r, 5));
                }
                return rows();
            });
            check('A broad search does not build every row up front',
                first > 0 && first < 500 && first % 60 === 0,
                `${first} rows in the first paint, of a 500 cap`);

            // Relevance: searching an author's name must not rank whatever
            // happens to start with "A" above their own tunes.
            const relevance = await page.evaluate(async () => {
                const input = document.getElementById('hvscSearchBar');
                input.value = 'hubbard';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 1200));
                const rows = [...document.querySelectorAll('#fileList .file-item')].slice(0, 10);
                const named = rows.map(r => ({
                    title: (r.querySelector('.search-result-title') || {}).textContent || '',
                    author: (r.querySelector('.search-result-author') || {}).textContent || '',
                }));
                const col = document.querySelector('.hvsc-col-match');
                return {
                    shown: !!col && !col.hidden,
                    active: !!col && col.classList.contains('active'),
                    top: named.slice(0, 5),
                    // "hubbard" matches 123 entries by title/author/path and
                    // thousands more only in the commentary. The strong ones
                    // must come first.
                    strong: named.filter(n => /hubbard/i.test(n.title + n.author)).length,
                    byAuthor: named.filter(n => /hubbard/i.test(n.author)).length,
                    count: rows.length,
                };
            });
            check('A search is ordered by how well it matches',
                relevance.shown && relevance.active, JSON.stringify(relevance));
            check('So a name in the title or author beats a mention in the commentary',
                relevance.count > 0 && relevance.strong === relevance.count,
                JSON.stringify(relevance));
            check('And the composer\'s own tunes are among them',
                relevance.byAuthor > 0, JSON.stringify(relevance));

            const byName = await page.evaluate(async () => {
                document.querySelector('.hvsc-col-name').click();
                await new Promise(r => setTimeout(r, 900));
                const col = document.querySelector('.hvsc-col-name');
                let stored = null;
                try { stored = JSON.parse(localStorage.getItem('hvsc-sort')); } catch (e) { /* blocked */ }
                return { active: col.classList.contains('active'), stored };
            });
            check('And the column headers still override that',
                byName.active === true && byName.stored
                && byName.stored.searchKey === 'name', JSON.stringify(byName));

            // Put it back for the checks below.
            await page.evaluate(async () => {
                document.querySelector('.hvsc-col-match').click();
                await new Promise(r => setTimeout(r, 600));
                const input = document.getElementById('hvscSearchBar');
                input.value = 'a';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 1200));
            });

            const settled = await page.evaluate(async () => {
                await new Promise(r => setTimeout(r, 1500));
                return {
                    rows: document.querySelectorAll('#fileList .file-item').length,
                    tabStops: document.querySelectorAll('#fileList .file-item[tabindex="0"]').length,
                    role: document.getElementById('fileList').getAttribute('role'),
                };
            });
            check('The rest of the capped list arrives', settled.rows === 500,
                `${settled.rows} rows`);
            check('The finished list is still a listbox with one tab stop',
                settled.role === 'listbox' && settled.tabStops === 1,
                JSON.stringify(settled));

            // Typing again mid-paint must abandon the unfinished list, not
            // leave its rows stacked under the new results.
            const retyped = await page.evaluate(async () => {
                const input = document.getElementById('hvscSearchBar');
                input.value = 'commando';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 400));
                const mid = document.querySelectorAll('#fileList .file-item').length;
                await new Promise(r => setTimeout(r, 1200));
                return { mid, after: document.querySelectorAll('#fileList .file-item').length };
            });
            check('A new query replaces the part-painted list rather than adding to it',
                retyped.after < 500 && retyped.after >= retyped.mid,
                JSON.stringify(retyped));

            await page.evaluate(() => document.getElementById('hvscModalClose').click());
        }

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

            // Back is the only close gesture on a phone; without a history entry
            // it leaves the site.
            const backCloses = await phone.evaluate(async () => {
                document.getElementById('openStudioBtn').click();
                await new Promise(r => setTimeout(r, 400));
                const opened = window.studioModal.isOpen;
                history.back();
                await new Promise(r => setTimeout(r, 500));
                return { opened, stillOpen: window.studioModal.isOpen, href: location.pathname };
            });
            check('Back closes the Studio instead of leaving the site',
                backCloses.opened && backCloses.stillOpen === false,
                JSON.stringify(backCloses));

            // The spectrum earns its rows while a tune plays, but not before
            // one is chosen: until then it has no audio to draw and the listing
            // wants the height. So it waits on the browser's has-tune flag
            // rather than being dropped on phones outright.
            const viz = await phone.evaluate(() => {
                const el = document.querySelector('.hvsc-visualizer');
                if (!el) return 'absent';
                const browser = document.querySelector('.browser-container');
                const read = () => getComputedStyle(el).display;
                browser.classList.remove('has-tune');
                const browsing = read();
                browser.classList.add('has-tune');
                const playing = read();
                browser.classList.remove('has-tune');
                return { browsing, playing };
            });
            check('The spectrum visualizer waits until a tune is chosen',
                viz !== 'absent' && viz.browsing === 'none', JSON.stringify(viz));
            check('The spectrum visualizer is not hidden on a phone once one is',
                viz !== 'absent' && viz.playing !== 'none', JSON.stringify(viz));
        } finally {
            await phone.close();
        }

        // --- the export manifest at the narrowest supported width -------------
        const tiny = await browser.newPage({ viewport: { width: 320, height: 720 } });
        try {
            await tiny.goto(base, { waitUntil: 'load' });
            await tiny.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });
            await loadSid(tiny, 'JCH-Crystalline.sid');
            await tiny.waitForFunction(() => !!window.uiController.sidHeader, null, { timeout: 60000 });
            await tiny.evaluate(() => document.getElementById('openStudioBtn').click());
            await tiny.waitForFunction(() => window.studioModal?.isOpen, null, { timeout: 20000 });
            await tiny.evaluate(() => window.studioModal.activate('export'));
            // The manifest shows a single "pick a visualizer first" row until the
            // selection lands, so wait for the real rows rather than a fixed pause.
            await tiny.waitForFunction(
                () => document.querySelectorAll('#exportManifest tr').length > 1,
                null, { timeout: 20000 });
            const fit = await tiny.evaluate(() => {
                const mf = document.getElementById('exportManifest');
                const panel = mf.closest('.studio-panel') || mf.parentElement;
                const val = mf.querySelector('.mf-val');
                return {
                    rows: mf.querySelectorAll('tr').length,
                    manifestWidth: Math.round(mf.getBoundingClientRect().width),
                    panelWidth: panel.clientWidth,
                    valueWidth: val ? Math.round(val.getBoundingClientRect().width) : 0,
                    docScroll: document.documentElement.scrollWidth,
                    docClient: document.documentElement.clientWidth,
                };
            });
            check('The export manifest fits its panel at 320px',
                fit.rows > 1 && fit.manifestWidth <= fit.panelWidth + 1, JSON.stringify(fit));
            // The label and status columns are fixed at 110px and 150px on wide
            // screens; unchecked, they leave the value a 36px sliver.
            check('The value is not crushed by the fixed label and status columns',
                fit.valueWidth >= fit.manifestWidth * 0.6, JSON.stringify(fit));
            check('And the page does not scroll sideways at 320px',
                fit.docScroll <= fit.docClient + 1, JSON.stringify(fit));
        } finally {
            await tiny.close();
        }
    } finally {
        if (!process.argv.includes('--keep')) await browser.close();
        server.close();
    }

    const failed = results.filter(r => !r.ok);
    // Repeated at the end so a truncated log still names what went wrong.
    for (const f of failed) console.log(`FAILED: ${f.name}${f.detail ? ` - ${f.detail}` : ''}`);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
