#!/usr/bin/env node
//
// Phone-width layout check for the two modals a visitor has to get through:
// the HVSC browser and the Studio. Both used to break on a narrow viewport in
// ways that are invisible on a desktop — a file list squeezed to zero width, a
// modal wider than the screen with the overflow clipped and unreachable — so
// this drives them in a real browser at phone widths and asserts the geometry.
//
// Not part of `npm test`: it needs Playwright, which is not a dependency of
// this repo. Install it ad hoc and run:
//
//     npm i --no-save playwright
//     node scripts/mobile-layout-check.js
//
// Chromium comes from Playwright's own download, or from an existing browser
// pool pointed at by PLAYWRIGHT_BROWSERS_PATH.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SID = path.join(__dirname, '..', 'SID', 'SteelStinsen-DangerDawg.sid');
const PHONES = [{ w: 360, h: 740 }, { w: 412, h: 883 }];
const DESKTOP = { w: 1280, h: 900 };

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

// Every descendant of `sel` that sticks out past the viewport horizontally.
// Two kinds of overrun are by design and don't count: content in a
// horizontally scrollable box (the Studio tab rail), which can be scrolled to,
// and the tail of a line truncated with an ellipsis.
function overflowingIn(sel) {
    const byDesign = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
            if (cs.textOverflow === 'ellipsis') return true;
            if (p.matches(sel)) return false;
        }
        return false;
    };
    const bad = [];
    document.querySelectorAll(sel + ', ' + sel + ' *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.right <= window.innerWidth + 1 && r.left >= -1) return;
        if (byDesign(el)) return;
        bad.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40));
    });
    return bad.slice(0, 5);
}

async function openPage(browser, base, size) {
    const ctx = await browser.newContext({
        viewport: { width: size.w, height: size.h },
        deviceScaleFactor: 1,
        isMobile: size.w < 800,
        hasTouch: size.w < 800
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => check(false, 'page error', e.message));
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    return page;
}

async function checkHvsc(page, size) {
    await page.evaluate(() => window.uiController.openHVSCBrowser());
    await page.waitForSelector('#fileList .file-item', { timeout: 30000 });
    await page.fill('#hvscSearchBar', 'commando');
    await page.waitForFunction(() => /match/.test(document.getElementById('itemCount').textContent), null, { timeout: 30000 });
    await page.waitForTimeout(300);

    const m = await page.evaluate((of) => {
        const list = document.getElementById('fileList').getBoundingClientRect();
        const rows = document.querySelectorAll('#fileList .file-item');
        const row = rows[0] && rows[0].getBoundingClientRect();
        return {
            rows: rows.length,
            listW: Math.round(list.width),
            rowW: row ? Math.round(row.width) : 0,
            over: new Function('sel', 'return (' + of + ')(sel)')('#hvscModal')
        };
    }, overflowingIn.toString());

    const label = `hvsc @${size.w}`;
    check(m.rows > 0, label + ': search renders results', m.rows + ' rows');
    check(m.listW >= size.w * 0.5, label + ': file list keeps its width', m.listW + 'px of ' + size.w);
    check(m.rowW > 0, label + ': result rows are visible', m.rowW + 'px wide');
    check(m.over.length === 0, label + ': nothing clipped off-screen', m.over.join(', '));

    await page.evaluate(() => document.getElementById('hvscModalClose').click());
    await page.waitForTimeout(300);
}

async function checkStudio(page, size) {
    await page.setInputFiles('#fileInput', SID);
    // The grid enables as soon as the SID is analysed, but picking a visualizer
    // reads its JSON config through uiController — which is built separately.
    await page.waitForFunction(
        () => window.uiController && window.uiController.visualizerConfig
            && !document.querySelector('.visualizer-grid.disabled'),
        null, { timeout: 60000 });
    await page.evaluate(() => window.studioModal.open());
    await page.waitForTimeout(500);
    // A visualizer with both an image and text options: derives the most tabs.
    await page.evaluate(() => {
        const card = [...document.querySelectorAll('.visualizer-card')]
            .find(e => /Musical Blobs/i.test(e.textContent));
        if (card) card.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('.studio-tab').length >= 5,
        null, { timeout: 30000 });
    await page.waitForTimeout(500);

    // Loading a SID can raise a message dialog over the Studio (it layers above
    // by design); dismiss it so the hit tests below see the Studio itself.
    const dismissed = await page.evaluate(() => {
        const overlay = document.getElementById('modalOverlay');
        if (!overlay || !overlay.classList.contains('visible')) return null;
        const title = document.getElementById('modalTitle').textContent.trim();
        const btn = overlay.querySelector('.modal-actions button');
        if (btn) btn.click(); else overlay.classList.remove('visible');
        return title || '(untitled)';
    });
    if (dismissed) console.log('  note: dismissed message dialog "' + dismissed + '"');
    await page.waitForTimeout(300);

    const tabs = await page.evaluate(() => [...document.querySelectorAll('.studio-tab')]
        .map(t => t.textContent.trim().replace(/[^\w ]/g, '').trim()));
    check(tabs.length >= 5, `studio @${size.w}: visualizer derives its option tabs`, tabs.join(', '));

    for (const tab of tabs) {
        await page.evaluate((t) => {
            const el = [...document.querySelectorAll('.studio-tab')].find(x => x.textContent.trim().startsWith(t));
            if (el) el.click();
        }, tab);
        await page.waitForTimeout(400);
        const m = await page.evaluate((of) => {
            const close = document.querySelector('.studio-close').getBoundingClientRect();
            const atClose = document.elementFromPoint(
                Math.round(close.x + close.width / 2), Math.round(close.y + close.height / 2));
            return {
                over: new Function('sel', 'return (' + of + ')(sel)')('.studio-modal-content'),
                closeReachable: !!atClose && atClose.classList.contains('studio-close'),
                atClose: atClose ? atClose.tagName.toLowerCase() + '.' + String(atClose.className).slice(0, 40) : 'nothing'
            };
        }, overflowingIn.toString());
        check(m.over.length === 0, `studio @${size.w} [${tab}]: fits the viewport`, m.over.join(', '));
        check(m.closeReachable, `studio @${size.w} [${tab}]: close button not covered`, m.closeReachable ? '' : 'hit ' + m.atClose);
    }

    // The rail is left showing the last (rightmost) tab. A refresh rebuilds it
    // from scratch, which resets scrollLeft, so the active tab has to be put
    // back in view — and while tabs remain off either end, that has to show.
    await page.evaluate(() => window.studioModal.queueRefresh());
    await page.waitForTimeout(300);
    const rail = await page.evaluate(() => {
        const el = document.querySelector('.studio-rail');
        const active = el.querySelector('.studio-tab.active');
        const box = el.getBoundingClientRect(), tab = active.getBoundingClientRect();
        return {
            overflows: el.scrollWidth - el.clientWidth > 1,
            marked: el.classList.contains('more-before') || el.classList.contains('more-after'),
            activeInView: tab.left >= box.left - 1 && tab.right <= box.right + 1
        };
    });
    check(rail.activeInView, `studio @${size.w}: active tab survives a rail rebuild`);
    check(!rail.overflows || rail.marked, `studio @${size.w}: overflowing rail is marked scrollable`);
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

    for (const size of PHONES) {
        const page = await openPage(browser, base, size);
        await checkHvsc(page, size);
        await checkStudio(page, size);
        await page.context().close();
    }

    // Desktop keeps the side-by-side browser layout the narrow rules replace.
    const page = await openPage(browser, base, DESKTOP);
    await page.evaluate(() => window.uiController.openHVSCBrowser());
    await page.waitForSelector('#fileList .file-item', { timeout: 30000 });
    const wide = await page.evaluate(() => {
        const panel = document.querySelector('#hvscModal .file-panel').getBoundingClientRect();
        const info = document.getElementById('sidInfoPanel').getBoundingClientRect();
        return {
            sideBySide: Math.abs(panel.y - info.y) < 2 && info.width > 300,
            listW: Math.round(panel.width)
        };
    });
    check(wide.sideBySide, 'hvsc @1280: info panel stays beside the list', 'list ' + wide.listW + 'px');
    await page.context().close();

    await browser.close();
    server.close();

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
