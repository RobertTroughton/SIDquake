#!/usr/bin/env node
/**
 * build-social-card.js - render public/social-card.png (the og:image).
 *
 * Facebook/Twitter/Discord won't render an SVG in a link preview, so the
 * logo Pepto made for us (sidquake-logo-landscape.svg) has to be baked into a
 * PNG at the 1200x630 size the scrapers expect. This renders the card in
 * headless Chromium so the layout uses the real site colours and the real SVG,
 * rather than a hand-drawn bitmap that drifts out of date.
 *
 * Run: node scripts/build-social-card.js
 * Needs Playwright + a Chromium (dev-only; the generated PNG is committed, so
 * this is not part of the Netlify build).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'public', 'sidquake-logo-landscape.svg');
const OUT = path.join(ROOT, 'public', 'social-card.png');

const WIDTH = 1200;
const HEIGHT = 630;

function loadChromium() {
    for (const mod of ['playwright', 'playwright-core']) {
        try { return require(mod).chromium; } catch { /* try the next one */ }
    }
    throw new Error('Playwright not found - install it (npm i -D playwright) to regenerate the social card.');
}

const page = (svg) => `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&family=Space+Mono:wght@700&display=swap');
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    background: linear-gradient(135deg, #0c0c0f 0%, #1a1520 50%, #0c0c0f 100%);
    font-family: 'Space Grotesk', system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 34px; position: relative; overflow: hidden;
  }
  /* Same scanline wash as the site header. */
  .scanlines {
    position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(0deg,
      transparent, transparent 2px,
      rgba(212, 162, 76, 0.02) 2px, rgba(212, 162, 76, 0.02) 4px);
  }
  .glow {
    position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%);
    width: 900px; height: 420px; border-radius: 50%;
    background: radial-gradient(ellipse, rgba(212, 162, 76, 0.10) 0%, transparent 70%);
  }
  .inner { position: relative; display: flex; flex-direction: column; align-items: center; gap: 34px; }
  .badge {
    font-family: 'Space Mono', monospace; font-weight: 700;
    font-size: 17px; letter-spacing: 6px; color: #d4a24c; opacity: 0.75;
  }
  .logo { width: 880px; display: block; }
  .tagline { font-size: 30px; color: #dcdde0; letter-spacing: 0.3px; text-align: center; }
  .rule { width: 640px; height: 1px; background: linear-gradient(90deg, transparent, #d4a24c, transparent); opacity: 0.5; }
  .url { font-family: 'Space Mono', monospace; font-size: 19px; letter-spacing: 3px; color: #8e909a; }
</style>
<div class="scanlines"></div>
<div class="glow"></div>
<div class="inner">
  <div class="badge">GENESIS PROJECT PRESENTS</div>
  <div class="logo">${svg}</div>
  <div class="rule"></div>
  <div class="tagline">Analyse SID tunes, browse HVSC, export C64 PRGs<br>with visualiser effects</div>
  <div class="url">sidquake.c64demo.com</div>
</div>`;

(async () => {
    const chromium = loadChromium();
    // Strip the SVG's fixed size so it scales to the .logo box.
    const svg = fs.readFileSync(LOGO, 'utf8').replace('<svg ', '<svg width="100%" height="auto" ');

    const browser = await chromium.launch(
        process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    try {
        const p = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
        await p.setContent(page(svg), { waitUntil: 'networkidle' });
        // Give the webfonts a moment; the card still renders if they never load.
        await p.evaluate(() => document.fonts.ready).catch(() => {});
        await p.screenshot({ path: OUT });
    } finally {
        await browser.close();
    }
    console.log(`Wrote ${path.relative(ROOT, OUT)} (${WIDTH}x${HEIGHT})`);
})();
