#!/usr/bin/env node
//
// Browser check for the HVSC embed's options (docs/EMBED.md): every switch,
// every piece of configurable text, the palette, and the three behaviours that
// live in hvsc-browser.js rather than in CSS (root confinement, initial sort,
// opening on a query).
//
// The point is that an option a host passes actually reaches the widget. Each
// scenario loads hvsc-embed.html with a query string and reads the resulting
// DOM: computed styles for the chrome and the palette, real listing state for
// the behaviour.
//
// The mirror under public/HVSC/ is not in the repo, but none of these checks
// need SID bytes - the listing, the chrome and the palette all come from the
// committed index. The playback engine is never asked for a tune.
//
// Not part of `npm test`: it needs Playwright, which is not a dependency of
// this repo. Install it ad hoc and run:
//
//     npm i --no-save playwright
//     node scripts/embed-options-check.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const HUBBARD = 'C64Music/MUSICIANS/H/Hubbard_Rob';

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.sid': 'application/octet-stream',
};

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

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

/** Open the embed with a query string and wait for its first listing. */
async function open(browser, base, query) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(base + 'hvsc-embed.html?' + query, { waitUntil: 'load' });
    await page.waitForFunction(
        () => document.querySelectorAll('#fileList .file-item').length > 0
            || document.querySelector('#fileList .search-empty'),
        null, { timeout: 60000 });
    return page;
}

/** Read the widget's shape: what is on screen, and in what colours. */
function readShape() {
    // The details panel, transport and spectrum are held back until a tune is
    // picked, which is a different question from whether the embedder wanted
    // them. Put the browser in its "has a tune" state so the option under test
    // is the only thing that can be hiding them.
    document.querySelector('.browser-container').classList.add('has-tune');
    document.getElementById('sidInfoPanel').classList.add('has-info');
    const shown = (sel) => {
        const el = document.querySelector(sel);
        return !!el && getComputedStyle(el).display !== 'none';
    };
    const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return {
        header: shown('.browser-header'),
        title: shown('.browser-title'),
        titleText: (document.querySelector('.browser-title-text') || {}).textContent,
        search: shown('.browser-search'),
        placeholder: (document.getElementById('hvscSearchBar') || {}).placeholder,
        listHeader: shown('#hvscListHeader'),
        nav: shown('#homeBtn'),
        sortui: shown('.hvsc-col-name'),
        year: shown('.hvsc-col-year'),
        info: shown('.sid-info-panel'),
        player: shown('.hvsc-player-container'),
        credit: shown('.sid-player-credit'),
        viz: shown('.hvsc-visualizer'),
        status: shown('.status-bar'),
        count: shown('#itemCount'),
        path: shown('#pathBar'),
        select: shown('.hvsc-choose-btn'),
        selectLabel: (document.querySelector('.hvsc-choose-label') || {}).textContent,
        infoTitle: (document.querySelector('.sid-info-panel .panel-header') || {}).textContent,
        footer: shown('.hvsc-embed-footer'),
        barBg: getComputedStyle(document.querySelector('.browser-header')).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        infoBg: getComputedStyle(document.getElementById('sidInfoContent')).backgroundColor,
        radius: getComputedStyle(document.querySelector('.hvsc-choose-btn')).borderRadius,
        font: getComputedStyle(document.body).fontFamily,
        vars: {
            accent: cssVar('--accent'),
            accentLight: cssVar('--accent-light'),
            accentDim: cssVar('--accent-dim'),
            bg: cssVar('--bg-primary'),
            border: cssVar('--border'),
            borderControl: cssVar('--border-control'),
            hueStart: cssVar('--hvsc-viz-hue-start'),
            hueEnd: cssVar('--hvsc-viz-hue-end'),
        },
    };
}

async function checkDefaults(browser, base) {
    const page = await open(browser, base, 'mode=link');
    const s = await page.evaluate(readShape);
    const on = ['header', 'title', 'search', 'listHeader', 'nav', 'sortui', 'year',
        'info', 'player', 'credit', 'viz', 'status', 'count', 'path', 'select', 'footer'];
    check(on.every(k => s[k]), 'defaults: every part of the widget is on screen',
        on.filter(k => !s[k]).join(',') || '');
    check(s.titleText === 'HVSC Browser', 'defaults: the stock heading', s.titleText);
    check(/^Search HVSC/.test(s.placeholder || ''), 'defaults: the stock placeholder', s.placeholder);
    check(s.selectLabel === 'Select', 'defaults: the stock Select label', s.selectLabel);
    check(s.infoTitle === 'SID Info', 'defaults: the stock details heading', s.infoTitle);
    check(s.vars.accent === '#d4a24c', 'defaults: the stock accent', s.vars.accent);
    await page.close();
}

async function checkChromeOff(browser, base) {
    const q = 'header=0&badge=0&search=0&nav=0&sortui=0&year=0&info=0&player=0'
        + '&credit=0&viz=0&status=0&count=0&path=0&select=0';
    const page = await open(browser, base, q);
    const s = await page.evaluate(readShape);
    const off = ['header', 'search', 'listHeader', 'nav', 'sortui', 'year',
        'info', 'player', 'credit', 'viz', 'status', 'count', 'path', 'select'];
    check(off.every(k => !s[k]), 'switches: everything switched off is gone',
        off.filter(k => s[k]).join(',') || '');
    check(s.footer, 'switches: the attribution footer stays regardless');
    await page.close();
}

async function checkText(browser, base) {
    const page = await open(browser, base,
        'title=Tune%20picker&placeholder=Find%20a%20tune&selectlabel=Use%20this'
        + '&infotitle=About%20this%20tune');
    const s = await page.evaluate(readShape);
    check(s.titleText === 'Tune picker', 'text: the heading', s.titleText);
    check(s.placeholder === 'Find a tune', 'text: the search placeholder', s.placeholder);
    check(s.selectLabel === 'Use this', 'text: the Select button', s.selectLabel);
    check(s.infoTitle === 'About this tune', 'text: the details panel heading', s.infoTitle);
    await page.close();

    const bare = await open(browser, base, 'title=&search=0');
    const b = await bare.evaluate(readShape);
    check(!b.title && !b.header, 'text: an empty title collapses the header with the search box');
    await bare.close();
}

async function checkPalette(browser, base) {
    const page = await open(browser, base,
        'bg=101820&bar=182430&accent=3fe07f&border=294050&infobg=0a1018'
        + '&viz1=3fe07f&viz2=66ccff&radius=0&font=Georgia,serif');
    const s = await page.evaluate(readShape);
    check(s.bodyBg === 'rgb(16, 24, 32)', 'palette: the page background', s.bodyBg);
    check(s.barBg === 'rgb(24, 36, 48)', 'palette: the header bar', s.barBg);
    check(s.infoBg === 'rgb(10, 16, 24)', 'palette: the details panel', s.infoBg);
    check(s.vars.accent === '#3fe07f', 'palette: the accent', s.vars.accent);
    check(/^#/.test(s.vars.accentLight) && s.vars.accentLight !== '#3fe07f',
        'palette: a lighter accent is derived from it', s.vars.accentLight);
    check(/^rgba\(63, ?224, ?127/.test(s.vars.accentDim),
        'palette: and its translucent tint', s.vars.accentDim);
    check(s.vars.border === '#294050' && s.vars.borderControl !== '#294050',
        'palette: the control outline is derived from the border',
        s.vars.border + ' / ' + s.vars.borderControl);
    check(s.vars.hueStart === '144' && s.vars.hueEnd === '200',
        'palette: the spectrum ramp takes the hue of each end colour',
        s.vars.hueStart + '->' + s.vars.hueEnd);
    check(s.radius === '0px', 'palette: radius=0 squares the controls', s.radius);
    check(/Georgia/.test(s.font), 'palette: the font family', s.font);
    await page.close();

    const light = await open(browser, base, 'theme=light');
    const l = await light.evaluate(readShape);
    check(l.vars.bg === '#f4f5f7', 'palette: theme=light repaints the surfaces', l.vars.bg);
    check(l.vars.accent === '#9a6b12', 'palette: and brings its own accent', l.vars.accent);
    check(parseInt(l.vars.accentLight.slice(1), 16) < parseInt(l.vars.accent.slice(1), 16),
        'palette: on a light ground the emphasised accent darkens rather than fades',
        l.vars.accent + ' -> ' + l.vars.accentLight);
    await light.close();

    const override = await open(browser, base, 'theme=light&accent=c0392b');
    const o = await override.evaluate(readShape);
    check(o.vars.bg === '#f4f5f7' && o.vars.accent === '#c0392b',
        'palette: a single colour still overrides the preset',
        o.vars.bg + ' / ' + o.vars.accent);
    await override.close();

    // A value that isn't a colour must be dropped, not pasted into the page.
    const bad = await open(browser, base, 'accent=url(javascript:1)&bg=%23nothex');
    const b = await bad.evaluate(readShape);
    check(b.vars.accent === '#d4a24c' && b.vars.bg === '#0c0c0f',
        'palette: values that are not colours are refused',
        b.vars.accent + ' / ' + b.vars.bg);
    await bad.close();
}

async function checkRoot(browser, base) {
    const page = await open(browser, base, 'root=MUSICIANS/H/Hubbard_Rob');
    const s = await page.evaluate((root) => {
        const paths = [...document.querySelectorAll('#fileList .file-item')]
            .map(i => i.dataset.path);
        return {
            upDisabled: document.getElementById('upBtn').disabled,
            listed: paths.every(p => p.startsWith(root + '/')),
            count: paths.length,
            path: document.getElementById('pathBar').textContent,
        };
    }, HUBBARD);
    check(s.count > 0 && s.listed, 'root: the listing opens inside the subtree',
        s.path + ' (' + s.count + ')');
    check(s.upDisabled, 'root: Up is dead at the top of it');

    const searched = await page.evaluate(async (root) => {
        hvscBrowser.search('a');
        for (let i = 0; i < 60; i++) {
            const rows = [...document.querySelectorAll('#fileList .search-result')];
            if (rows.length) {
                return {
                    rows: rows.length,
                    inside: rows.every(r => r.dataset.path.startsWith(root + '/')),
                };
            }
            await new Promise(r => setTimeout(r, 200));
        }
        return { rows: 0, inside: false };
    }, HUBBARD);
    check(searched.rows > 0 && searched.inside,
        'root: a search only matches inside it', searched.rows + ' rows');

    // A folder outside the subtree is not somewhere the widget can be sent.
    const escaped = await page.evaluate(async () => {
        await hvscBrowser.fetchDirectory('C64Music/DEMOS');
        return document.getElementById('pathBar').textContent;
    }).catch(() => null);
    if (escaped !== null) {
        check(escaped === '/' + HUBBARD, 'root: navigating outside it lands back at the top', escaped);
    }
    await page.close();
}

async function checkQueryAndSort(browser, base) {
    const page = await open(browser, base, 'q=hubbard&sort=year&dir=asc');
    const s = await page.evaluate(async () => {
        for (let i = 0; i < 60; i++) {
            const rows = [...document.querySelectorAll('#fileList .search-result')];
            if (rows.length > 3) {
                const years = rows.map(r => (r.querySelector('.file-year') || {}).textContent)
                    .filter(Boolean).map(Number).filter(n => n);
                return {
                    rows: rows.length,
                    query: document.getElementById('hvscSearchBar').value,
                    count: document.getElementById('itemCount').textContent,
                    ascending: years.every((y, i2) => i2 === 0 || y >= years[i2 - 1]),
                    years: years.slice(0, 4),
                };
            }
            await new Promise(r => setTimeout(r, 200));
        }
        return { rows: 0 };
    });
    check(s.rows > 0 && s.query === 'hubbard',
        'q: the widget opens with the search already run', s.count);
    check(s.ascending, 'sort: oldest first, as asked', JSON.stringify(s.years));
    await page.close();

    const byName = await open(browser, base, 'start=MUSICIANS/H/Hubbard_Rob&sort=name&dir=desc');
    const n = await byName.evaluate(() => [...document.querySelectorAll('#fileList .file-item')]
        .filter(i => !i.classList.contains('directory'))
        .map(i => i.querySelector('.file-name').textContent));
    check(n.length > 2 && n[0].localeCompare(n[1]) >= 0,
        'sort: a folder listing honours dir=desc too', n.slice(0, 3).join(', '));
    await byName.close();
}

(async () => {
    const { chromium } = require('playwright');
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await launch(chromium);
    try {
        await checkDefaults(browser, base);
        await checkChromeOff(browser, base);
        await checkText(browser, base);
        await checkPalette(browser, base);
        await checkRoot(browser, base);
        await checkQueryAndSort(browser, base);
    } finally {
        await browser.close();
        server.close();
    }
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll embed option checks passed');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
