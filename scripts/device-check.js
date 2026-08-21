#!/usr/bin/env node
//
// Device-matrix layout audit. `mobile-layout-check.js` asserts the two modals
// behave at two phone widths; this one sweeps a whole matrix of real device
// profiles across every page and reports what a visitor on each would hit:
//
//   * horizontal scrolling anywhere (the page should only ever move up/down),
//   * anything clipped off the side of the viewport,
//   * tap targets under the 44px the platforms ask for,
//   * body text under 12px, and text under a 4.5:1 contrast ratio,
//   * how many HVSC rows actually fit on screen at once.
//
// Not part of `npm test`: it needs Playwright, which is not a dependency of
// this repo. Install it ad hoc and run:
//
//     npm i --no-save playwright
//     node scripts/device-check.js                 # whole matrix, all pages
//     node scripts/device-check.js --device=iphone-12
//     node scripts/device-check.js --shots=/tmp/shots   # also write PNGs
//
// Exits non-zero if any device fails a check.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

// Real CSS viewports, not the marketing pixel counts. `dpr` only affects the
// screenshots; layout is driven entirely by the CSS size.
const DEVICES = [
    { id: 'iphone-12',          name: 'iPhone 12 (portrait)',      w: 390,  h: 844,  dpr: 3, touch: true },
    { id: 'iphone-12-land',     name: 'iPhone 12 (landscape)',     w: 844,  h: 390,  dpr: 3, touch: true },
    { id: 'iphone-16-pro-max',  name: 'iPhone 16 Pro Max',         w: 440,  h: 956,  dpr: 3, touch: true },
    { id: 'ipad',               name: 'iPad 11" (portrait)',       w: 820,  h: 1180, dpr: 2, touch: true },
    { id: 'ipad-land',          name: 'iPad 11" (landscape)',      w: 1180, h: 820,  dpr: 2, touch: true },
    { id: 'laptop',             name: 'Laptop 1366x768',           w: 1366, h: 768,  dpr: 1, touch: false },
    { id: 'desktop',            name: 'Desktop 2560x1440',         w: 2560, h: 1440, dpr: 1, touch: false }
];

const PAGES = [
    { id: 'index',   url: '/index.html' },
    { id: 'hvsc',    url: '/hvsc-browser.html' },
    { id: 'about',   url: '/about.html' },
    { id: 'embed',   url: '/embed-terms.html' }
];

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
    '.sid': 'application/octet-stream', '.bin': 'application/octet-stream'
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

// ─── the probe, serialised into the page ───
//
// Everything below runs in the browser. It walks the rendered tree once and
// reports the accessibility and layout facts the checks assert on.
function probe() {
    const vw = window.innerWidth;
    const out = {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        overflow: [],
        smallTaps: [],
        inlineTaps: [],
        smallText: [],
        lowContrast: []
    };

    const name = (el) => el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');

    // Several kinds of overrun are by design and reach nobody's content:
    // a horizontally scrollable box (scroll to it), an ellipsis (the tail is
    // meant to be cut), a clipping parent (it can't widen the page), and a
    // decorative pointer-events:none layer (the drifting note glyphs).
    const byDesign = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
            if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') return true;
            if (cs.textOverflow === 'ellipsis') return true;
            if (cs.pointerEvents === 'none' && cs.position === 'fixed') return true;
        }
        return false;
    };
    // A control parked entirely outside the viewport (the skip link at
    // left:-9999px) is hidden, not clipped.
    const parked = (r) => r.right <= 0 || r.left >= vw;

    const visible = (el, cs) => cs.visibility !== 'hidden' && cs.display !== 'none' &&
        parseFloat(cs.opacity) > 0.01;

    // sRGB relative luminance, per WCAG.
    const lum = (rgb) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const parse = (s) => {
        const m = /rgba?\(([^)]+)\)/.exec(s);
        if (!m) return null;
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    // The first opaque background behind an element, composited through any
    // translucent layers above it.
    const backdrop = (el) => {
        const stack = [];
        for (let p = el; p; p = p.parentElement) {
            const c = parse(getComputedStyle(p).backgroundColor);
            if (!c || c.a === 0) continue;
            stack.push(c);
            if (c.a === 1) break;
        }
        if (!stack.length) return [0, 0, 0];
        let base = stack[stack.length - 1].rgb;
        for (let i = stack.length - 2; i >= 0; i--) {
            const c = stack[i];
            base = base.map((b, k) => c.rgb[k] * c.a + b * (1 - c.a));
        }
        return base;
    };
    const ratio = (a, b) => {
        const la = lum(a), lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const TAPPABLE = 'a[href], button, input, select, textarea, [role="button"], [onclick], [tabindex]:not([tabindex="-1"])';
    const seen = new Set();

    document.querySelectorAll('body, body *').forEach((el) => {
        const cs = getComputedStyle(el);
        if (!visible(el, cs)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;

        // off to the side of the viewport
        if ((r.right > vw + 1 || r.left < -1) && !parked(r) && !byDesign(el)) {
            out.overflow.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right) });
        }

        // Tap target size. A link sitting in a run of prose is sized by its
        // text and can't be padded to 44px without breaking the line, so it
        // is reported separately from a standalone control.
        if (el.matches(TAPPABLE) && r.width > 0 && r.height > 0 &&
            cs.pointerEvents !== 'none' && !parked(r) &&
            Math.min(r.width, r.height) < 44) {
            const rec = { el: name(el), w: Math.round(r.width), h: Math.round(r.height),
                text: (el.textContent || el.value || '').trim().slice(0, 24) };
            (cs.display.startsWith('inline') && !el.matches('button, input, select, textarea')
                ? out.inlineTaps : out.smallTaps).push(rec);
        }

        // text size and contrast, on leaf elements that actually hold text
        const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (!own) return;
        const px = parseFloat(cs.fontSize);
        const txt = el.textContent.trim().slice(0, 30);
        if (px < 12) out.smallText.push({ el: name(el), px: +px.toFixed(1), text: txt });

        const key = cs.color + '|' + cs.fontSize + '|' + name(el);
        if (seen.has(key)) return;
        seen.add(key);
        const fg = parse(cs.color);
        if (!fg || fg.a < 0.9) return;
        const cr = ratio(fg.rgb, backdrop(el));
        const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
        const need = large ? 3 : 4.5;
        if (cr < need) {
            out.lowContrast.push({ el: name(el), px: +px.toFixed(1), ratio: +cr.toFixed(2),
                need, text: txt });
        }
    });

    const trim = (a) => a.slice(0, 8);
    out.overflow = trim(out.overflow);
    out.smallTaps = trim(out.smallTaps);
    out.inlineTaps = trim(out.inlineTaps);
    out.smallText = trim(out.smallText);
    out.lowContrast = trim(out.lowContrast);
    return out;
}

async function auditPage(browser, base, dev, pg, shots) {
    const ctx = await browser.newContext({
        viewport: { width: dev.w, height: dev.h },
        deviceScaleFactor: dev.dpr,
        isMobile: dev.touch,
        hasTouch: dev.touch
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    const t0 = Date.now();
    await page.goto(base + pg.url, { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(2500);

    const r = await page.evaluate(probe);
    const label = `${dev.id} ${pg.id}`;

    check(r.scrollW <= r.clientW + 1, `${label}: no horizontal scroll`,
        r.scrollW > r.clientW ? `${r.scrollW}px of content in ${r.clientW}px` : '');
    check(r.overflow.length === 0, `${label}: nothing clipped off-screen`,
        r.overflow.map(o => `${o.el} [${o.left}..${o.right}]`).join(', '));
    check(r.smallTaps.length === 0, `${label}: tap targets >= 44px`,
        r.smallTaps.map(t => `${t.el} ${t.w}x${t.h}`).join(', '));
    if (r.inlineTaps.length) {
        console.log('  note   ' + label + ': small inline links  ' +
            r.inlineTaps.map(t => `${t.el} ${t.w}x${t.h}`).join(', '));
    }
    check(r.smallText.length === 0, `${label}: text >= 12px`,
        r.smallText.map(t => `${t.el} ${t.px}px`).join(', '));
    check(r.lowContrast.length === 0, `${label}: text contrast >= 4.5:1`,
        r.lowContrast.map(t => `${t.el} ${t.ratio}:1`).join(', '));
    check(errors.length === 0, `${label}: no page errors`, errors.join(' | '));
    console.log(`         load ${loadMs}ms`);

    if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `${dev.id}-${pg.id}.png`), fullPage: false });
    }

    await ctx.close();
    return { dev: dev.id, page: pg.id, loadMs, ...r, errors };
}

// How much of the HVSC list a visitor can actually see at once — the thing
// that makes the browser usable or not on a phone.
async function auditHvscDensity(browser, base, dev, shots) {
    const ctx = await browser.newContext({
        viewport: { width: dev.w, height: dev.h },
        deviceScaleFactor: dev.dpr, isMobile: dev.touch, hasTouch: dev.touch
    });
    const page = await ctx.newPage();
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    let rows = null;
    try {
        await page.evaluate(() => window.uiController.openHVSCBrowser());
        await page.waitForSelector('#fileList .file-item', { timeout: 30000 });
        await page.waitForTimeout(600);
        rows = await page.evaluate(() => {
            const list = document.getElementById('fileList');
            const lr = list.getBoundingClientRect();
            const items = [...document.querySelectorAll('#fileList .file-item')];
            if (!items.length) return null;
            const ih = items[0].getBoundingClientRect().height;
            const visible = items.filter((el) => {
                const r = el.getBoundingClientRect();
                return r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1;
            }).length;
            return { visible, itemH: Math.round(ih), listH: Math.round(lr.height),
                viewH: window.innerHeight };
        });
        if (shots) {
            fs.mkdirSync(shots, { recursive: true });
            await page.screenshot({ path: path.join(shots, `${dev.id}-hvsc-open.png`) });
        }
    } catch (e) {
        console.log(`  note  ${dev.id}: HVSC browser did not open (${e.message.split('\n')[0]})`);
    }
    await ctx.close();
    if (!rows) return null;
    check(rows.visible >= 6, `${dev.id} hvsc: shows a useful number of tunes at once`,
        `${rows.visible} rows of ${rows.itemH}px in a ${rows.listH}px list (${rows.viewH}px viewport)`);
    return { dev: dev.id, ...rows };
}

(async () => {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (e) {
        console.error('playwright is not installed. Run: npm i --no-save playwright');
        process.exit(1);
    }

    const args = process.argv.slice(2);
    const only = (args.find(a => a.startsWith('--device=')) || '').split('=')[1];
    const onlyPage = (args.find(a => a.startsWith('--page=')) || '').split('=')[1];
    const shots = (args.find(a => a.startsWith('--shots=')) || '').split('=')[1];
    const json = (args.find(a => a.startsWith('--json=')) || '').split('=')[1];

    const devices = only ? DEVICES.filter(d => d.id === only) : DEVICES;
    const pages = onlyPage ? PAGES.filter(p => p.id === onlyPage) : PAGES;
    if (!devices.length) { console.error('unknown device: ' + only); process.exit(2); }

    const server = await serve();
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await launch(chromium);

    const report = [];
    for (const dev of devices) {
        console.log('\n' + dev.name + '  ' + dev.w + 'x' + dev.h + ' @' + dev.dpr + 'x');
        for (const pg of pages) {
            if (!fs.existsSync(path.join(ROOT, pg.url.replace(/^\//, '')))) continue;
            report.push(await auditPage(browser, base, dev, pg, shots));
        }
        if (!onlyPage || onlyPage === 'index') {
            const d = await auditHvscDensity(browser, base, dev, shots);
            if (d) report.push({ kind: 'hvsc-density', ...d });
        }
    }

    await browser.close();
    server.close();

    if (json) fs.writeFileSync(json, JSON.stringify(report, null, 2));
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
