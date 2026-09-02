#!/usr/bin/env node
/**
 * busy-note-check.js - the busy overlay's news line, and the way back from a
 * cancelled loop scan.
 *
 * Two things nothing else covers, both about the loop/length scan's place in the
 * UI rather than about the scan itself:
 *
 *   The overlay's note line reads "Listening for the tune's loop…" while it waits
 *   for news. That line belongs to the scan and nothing else, but the overlay is
 *   shared - loading a SID and building the PRG put the same dialog up - so the
 *   placeholder has to be off unless a scan is really running behind it.
 *
 *   Cancelling the scan from the corner chip used to take the chip with it, and
 *   the only way back in was the Studio's Song tab, nowhere near where the scan
 *   had been. The chip now offers the restart where the cancel happened.
 *
 * Playwright is NOT a dependency of this repo (same as studio-smoke-check.js).
 * Install it first:
 *   npm install --no-save playwright
 *   node scripts/busy-note-check.js [--headed]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SIDS = path.join(__dirname, '..', 'SID');
const HEADED = process.argv.includes('--headed');
const TUNE = 'Blending_Mode.sid';   // no loop inside a few seconds, so the scan runs on

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
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

// What the note line is actually showing: its own text, or the placeholder the
// stylesheet supplies when it is empty and the job is listening.
const noteState = () => {
    const el = document.getElementById('busyNote');
    if (!el) return { present: false };
    const style = getComputedStyle(el);
    return {
        present: true,
        text: el.textContent.trim(),
        listening: el.classList.contains('is-listening'),
        shown: style.display !== 'none',
        placeholder: getComputedStyle(el, '::after').content,
    };
};

async function loadSid(page, file) {
    const bytes = fs.readFileSync(path.join(SIDS, file));
    await page.evaluate(({ name, b64 }) => {
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
    const pinned = '/opt/pw-browsers/chromium';
    const launch = { headless: !HEADED };
    if (fs.existsSync(pinned)) launch.executablePath = pinned;
    const browser = await chromium.launch(launch);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.uiController, null, { timeout: 20000 });

        // --- the overlay on a job that has no loop to listen for --------------
        // Driven directly: the load overlay is gone in a few hundred milliseconds,
        // which is not long enough to catch reliably, and showBusy is the whole
        // mechanism under test.
        await page.evaluate(() => window.uiController.showBusy('Loading SID File', 'Initializing...'));
        const load = await page.evaluate(noteState);
        check('a load overlay is not listening for a loop', load.present && !load.listening);
        check('...so the note line is not there at all', load.present && !load.shown,
            load.shown ? `shown, placeholder ${load.placeholder}` : '');
        await page.evaluate(() => window.uiController.hideBusy());

        // --- the overlay over a real scan -------------------------------------
        await loadSid(page, TUNE);
        await page.waitForFunction(() => window.studioModal?.isOpen, null, { timeout: 60000 });
        await page.waitForFunction(() => window.uiController.analysisRunning, null, { timeout: 30000 });
        await page.evaluate(() => {
            window.uiController.showBusy('Finding song length', 'Preparing…', () => {});
            window.uiController._ensureAnalysis({});
        });
        const scan = await page.evaluate(noteState);
        check('a scan overlay does listen for a loop', scan.listening);
        check('...and offers the placeholder until there is news',
            scan.shown && /Listening for/.test(scan.placeholder || ''),
            scan.placeholder);
        await page.evaluate(() => window.uiController.hideBusy());

        // --- a cached answer is not "listening" -------------------------------
        await page.evaluate(() => {
            window.uiController.showBusy('Finding song length', 'Preparing…');
            window.uiController.tuneAnalysis = window.uiController.tuneAnalysis || { looped: false };
            window.uiController._ensureAnalysis({});
        });
        const cached = await page.evaluate(noteState);
        check('an export that already has the answer does not claim to be listening',
            !cached.listening && !cached.shown);
        await page.evaluate(() => window.uiController.hideBusy());

        // --- cancelling from the corner chip leaves a way back in -------------
        // The chip sits below the modals by design, so this is the state it is
        // actually clickable in: the Studio closed, the scan running behind the page.
        await page.evaluate(() => {
            window.uiController.tuneAnalysis = null;
            window.uiController._analysisCancelled = false;
        });
        await loadSid(page, TUNE);
        await page.waitForFunction(() => window.studioModal?.isOpen, null, { timeout: 60000 });
        await page.waitForFunction(
            () => !document.getElementById('analysisChip')?.hidden, null, { timeout: 30000 });
        await page.evaluate(() => window.studioModal.close());
        await page.click('#analysisChipCancel');
        await page.waitForFunction(
            () => !document.getElementById('analysisChipRestart')?.hidden, null, { timeout: 20000 })
            .catch(() => {});
        const afterCancel = await page.evaluate(() => ({
            chipShown: !document.getElementById('analysisChip')?.hidden,
            restart: !document.getElementById('analysisChipRestart')?.hidden,
            text: document.getElementById('analysisChipText')?.textContent.trim(),
        }));
        check('the chip stays up after a cancel', afterCancel.chipShown, afterCancel.text);
        check('...offering "Measure again" where the cancel happened', afterCancel.restart);

        // The X is the way out of the offer, and it is the same button that made
        // the cancel: with no scan left to abort it has to dismiss the chip rather
        // than do nothing.
        await page.click('#analysisChipCancel');
        check('...and the X dismisses the stopped chip',
            await page.evaluate(() => !!document.getElementById('analysisChip')?.hidden));

        if (afterCancel.restart) {
            await page.evaluate(() => {
                window.uiController._analysisCancelled = false;
                window.uiController.startBackgroundAnalysis({ userAsked: true });
            });
            await page.waitForFunction(
                () => !document.getElementById('analysisChip')?.hidden, null, { timeout: 30000 });
            await page.click('#analysisChipCancel');
            await page.waitForFunction(
                () => !document.getElementById('analysisChipRestart')?.hidden, null, { timeout: 20000 });
            await page.click('#analysisChipRestart');
            const restarted = await page.waitForFunction(
                () => window.uiController.analysisRunning, null, { timeout: 20000 })
                .then(() => true).catch(() => false);
            check('...and taking the offer starts the scan over, Studio shut', restarted);
        }

        // --- and so does stopping it from the Studio's Song tab ---------------
        // The offer here has to survive the job settling AFTER the click: the
        // status was rewritten while the scan was still unwinding, so it could be
        // left reading "Measuring the song length…" over a scan that had stopped.
        await page.waitForFunction(() => window.uiController.analysisRunning, null, { timeout: 30000 });
        await page.evaluate(() => document.getElementById('songLengthStop').click());
        const songTab = await page.waitForFunction(() => {
            if (window.uiController.analysisRunning) return null;
            const measure = document.getElementById('songLengthMeasure');
            const stop = document.getElementById('songLengthStop');
            const status = document.getElementById('songLoopStatus');
            return { measure: !measure.hidden, stop: !stop.hidden, status: status.textContent.trim() };
        }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
        check('the Song tab offers "Measure now" once the stopped scan lets go',
            !!songTab && songTab.measure && !songTab.stop, songTab && songTab.status);
    } catch (e) {
        check('the run completed', false, String(e && e.message || e));
    } finally {
        await browser.close();
        server.close();
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
})();
