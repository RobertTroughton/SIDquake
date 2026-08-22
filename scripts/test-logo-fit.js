#!/usr/bin/env node
// test-logo-fit.js - the logo placement maths in public/logo-fit.js.
//
// A player only displays the top N character rows, and charsetlab-core only
// accepts a handful of image sizes, so an uploaded logo usually has to be
// placed onto a 320x200 screen before it can be converted. Two things have to
// hold for every placement or the logo converts to something the C64 can't
// draw the way the artist meant:
//
//   * the artwork ends up inside the visible band, and
//   * it only ever moves by whole 8x8 character cells, so each cell of the
//     source still lands in one cell of the output.
//
// Usage: node scripts/test-logo-fit.js   (no dependencies, exits non-zero on failure)

const LogoFit = require('../public/logo-fit.js');

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

// An image of `bg` with one `fg` rectangle in it.
function image(w, h, bg, box, fg) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const inBox = box && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
            const c = inBox ? fg : bg;
            const p = (y * w + x) * 4;
            rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; rgba[p + 3] = 255;
        }
    }
    return { rgba, w, h };
}

const BLACK = [0, 0, 0], BLUE = [0x35, 0x28, 0x79], WHITE = [255, 255, 255];

// Where the source's content lands on the 320x200 screen once placed.
function placedBox(place) {
    const b = place.bounds, s = place.scale;
    return {
        x0: place.dx + b.x0 * s, y0: place.dy + b.y0 * s,
        x1: place.dx + (b.x1 + 1) * s - 1, y1: place.dy + (b.y1 + 1) * s - 1
    };
}
function inBand(place) {
    const p = placedBox(place);
    return p.x0 >= 0 && p.x1 <= LogoFit.W - 1 && p.y0 >= 0 && p.y1 <= place.band - 1;
}
function onGrid(place) {
    return place.dx % 8 === 0 && place.dy % 8 === 0;
}

// ─── A screen-sized logo already sitting in the band is left alone ───
{
    const img = image(320, 200, BLACK, { x0: 8, y0: 8, x1: 311, y1: 79 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(!place.needsFit, 'a 320x200 logo inside the band is not touched');
    check(place.scale === 1 && place.dx === 0 && place.dy === 0, 'and its placement is the identity',
        `scale ${place.scale} at ${place.dx},${place.dy}`);
}

// ─── A 320-wide strip of whole character rows is a native size too ───
{
    const img = image(320, 72, BLACK, { x0: 6, y0: 0, x1: 305, y1: 51 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 72 });
    check(!place.needsFit, 'a 320x72 strip is not touched');
}

// ─── Artwork goes to the top of the band, not the middle of it ───
//
// The player fills the screen below the band with bars, so slack left above the
// logo reads as the whole screen sitting low. All of it belongs below.
{
    const img = image(320, 200, BLACK, { x0: 30, y0: 104, x1: 290, y1: 159 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    const box = placedBox(place);
    check(box.y0 === 0, 'a 56px logo sits against the top of an 88px band', 'y0 ' + box.y0);
    check(88 - 1 - box.y1 === 32, 'with all the slack below it', `${88 - 1 - box.y1}px below`);

    // Artwork whose own top isn't on the character grid can only get within a
    // cell of the top - moving it the rest of the way would break its alignment.
    const off = image(320, 200, BLACK, { x0: 30, y0: 100, x1: 290, y1: 155 }, WHITE);
    const offBox = placedBox(LogoFit.plan(off.rgba, off.w, off.h, { band: 88 }));
    check(offBox.y0 > 0 && offBox.y0 < 8, 'off-grid artwork gets within a character row of the top',
        'y0 ' + offBox.y0);
}

// ─── An image that needs no fitting opens in the Adjust tool untouched ───
{
    const img = image(320, 200, BLACK, { x0: 8, y0: 8, x1: 311, y1: 79 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(!place.needsFit && place.scale === 1 && place.dx === 0 && place.dy === 0,
        'a logo already in the band starts where it is, not where auto-place would put it',
        `scale ${place.scale} at ${place.dx},${place.dy}`);
    check(place.auto.dy === -8, 'and auto-place still offers the top of the band',
        'auto dy ' + place.auto.dy);

    // A VICE grab starts on its inner screen - the crop the converter does anyway.
    const grab = image(384, 272, BLUE, null, WHITE);
    for (let y = 35; y < 235; y++) {
        for (let x = 32; x < 352; x++) {
            const inArt = x >= 60 && x <= 320 && y >= 43 && y <= 100;
            const c = inArt ? WHITE : BLACK;
            const p = (y * 384 + x) * 4;
            grab.rgba[p] = c[0]; grab.rgba[p + 1] = c[1]; grab.rgba[p + 2] = c[2];
        }
    }
    const gp = LogoFit.plan(grab.rgba, grab.w, grab.h, { band: 88 });
    check(!gp.needsFit && gp.dx === -32 && gp.dy === -35,
        'and a VICE grab starts cropped to its screen', `${gp.dx},${gp.dy}`);
}

// ─── The reported case: a 320x200 logo down the middle of the screen ───
{
    const img = image(320, 200, BLACK, { x0: 30, y0: 60, x1: 290, y1: 140 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(place.needsFit, 'a logo below the band is repositioned');
    check(place.scale === 1, 'a logo that fits the band is not scaled', 'scale ' + place.scale);
    check(place.dx === 0, 'a screen-sized logo keeps its horizontal placement', 'dx ' + place.dx);
    check(onGrid(place), 'it moves by whole character cells', `${place.dx},${place.dy}`);
    check(inBand(place), 'and lands inside the band', JSON.stringify(placedBox(place)));
}

// ─── Only sizes the C64 side is defined for are accepted ───
{
    check(LogoFit.sizeError(320, 200) === null, '320x200 is a logo');
    check(LogoFit.sizeError(384, 272) === null, '384x272 (a VICE grab) is a logo');
    check(LogoFit.sizeError(320, 88) === null, 'so is a 320-wide strip of whole character rows');
    check(LogoFit.sizeError(320, 96) === null, 'at any multiple of 8 high');
    check(!!LogoFit.sizeError(360, 194), 'a 360x194 image is flagged as needing placement',
        LogoFit.sizeError(360, 194));
    check(!!LogoFit.sizeError(320, 194), 'a height off the character grid is flagged too',
        LogoFit.sizeError(320, 194));
    check(!!LogoFit.sizeError(320, 208), 'and so is one taller than the screen');
    const msg = LogoFit.sizeError(360, 194) || '';
    check(msg.includes('360×194') && msg.includes('320×200') && msg.includes('384×272'),
        'the refusal says what was given and what is wanted');
}

// ─── A VICE grab is measured over its inner screen, not its border ───
{
    // Blue border, black screen, artwork in the top rows of the screen. Reading
    // the border as the background would make the whole screen look like
    // artwork and scale a perfectly good grab down to fit the band.
    const img = image(384, 272, BLUE, null, WHITE);
    for (let y = 35; y < 235; y++) {
        for (let x = 32; x < 352; x++) {
            const inArt = x >= 60 && x <= 320 && y >= 39 && y <= 100;
            const c = inArt ? WHITE : BLACK;
            const p = (y * 384 + x) * 4;
            img.rgba[p] = c[0]; img.rgba[p + 1] = c[1]; img.rgba[p + 2] = c[2];
        }
    }
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    const bg = place.background;
    check(bg.r === 0 && bg.g === 0 && bg.b === 0, 'the screen background is read, not the border',
        `rgb(${bg.r},${bg.g},${bg.b})`);
    check(!!place.bounds && place.bounds.x0 === 60 && place.bounds.y0 === 39,
        'and the artwork is found inside the screen', JSON.stringify(place.bounds));
    check(!place.needsFit, 'a grab with its logo in the band is left alone');
    check(place.scale === 1, 'and is never scaled', 'scale ' + place.scale);
}

// ─── Placement maths for content smaller than the screen ───
//
// Not reachable from a file any more - sizeError() refuses anything but the
// sizes above - but the Adjust tool scales a logo down to any size, and the
// result has to be centred and surrounded the same way.
{
    const img = image(240, 88, BLUE, { x0: 20, y0: 12, x1: 219, y1: 75 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(place.needsFit, 'a 240x88 logo needs placing');
    check(place.scale === 1, 'a small logo is not blown up', 'scale ' + place.scale);
    check(onGrid(place), 'it moves by whole character cells', `${place.dx},${place.dy}`);
    check(inBand(place), 'and lands inside the band', JSON.stringify(placedBox(place)));
    const bg = place.background;
    check(bg.r === BLUE[0] && bg.g === BLUE[1] && bg.b === BLUE[2],
        'the surround colour is taken from the image edges',
        `rgb(${bg.r},${bg.g},${bg.b})`);
    const box = placedBox(place);
    check(Math.abs(box.x0 - (LogoFit.W - 1 - box.x1)) <= 8, 'the artwork is centred horizontally',
        `${box.x0}px left, ${LogoFit.W - 1 - box.x1}px right`);
}

// ─── Artwork too big for the band is scaled down, never up ───
{
    const img = image(640, 400, BLACK, { x0: 8, y0: 8, x1: 631, y1: 391 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(place.needsFit, 'an oversized image needs placing');
    check(place.scale < 1, 'it is scaled down', 'scale ' + place.scale.toFixed(3));
    check(onGrid(place), 'it still moves by whole character cells', `${place.dx},${place.dy}`);
    check(inBand(place), 'and lands inside the band', JSON.stringify(placedBox(place)));
}

// ─── Art already at C64 width is clipped to the band, not squeezed into it ───
//
// The players promise "only the top N character rows are shown", and squeezing
// 11 rows of art into 9 resamples pixels the artist placed one at a time -
// enough to put a multicolour logo out of reach of every C64 mode.
{
    const img = image(320, 88, BLACK, { x0: 8, y0: 8, x1: 311, y1: 87 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 72, artBand: 72 });
    check(place.needsFit, 'a logo taller than the band needs placing');
    check(place.scale === 1, 'but it keeps its pixels', 'scale ' + place.scale);
    check(placedBox(place).y0 === 0, 'and starts at the top, so it loses its bottom rows',
        JSON.stringify(placedBox(place)));
    check(place.clipped, 'the placement says it was cut');
    const out = LogoFit.composite(img.rgba, place);
    const px = (x, y) => [out[(y * 320 + x) * 4], out[(y * 320 + x) * 4 + 1], out[(y * 320 + x) * 4 + 2]].join();
    const bg = [place.background.r, place.background.g, place.background.b].join();
    check(px(160, 71) === WHITE.join(), 'the last row of the band still holds artwork', px(160, 71));
    check(px(160, 72) === bg, 'and the first row past it is the surround colour', px(160, 72));
}

// ─── A source that is not C64-width still scales to fit ───
{
    const img = image(640, 400, BLACK, { x0: 8, y0: 8, x1: 631, y1: 391 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(place.scale < 1, 'an oversized image is still scaled to fit the band',
        'scale ' + place.scale.toFixed(3));
}

// ─── Placing a VICE grab crops its border ───
{
    const img = image(384, 272, BLUE, { x0: 40, y0: 40, x1: 340, y1: 100 }, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    const shifted = LogoFit.autoPlace(place.bounds, 384, 272, 88);
    check(shifted.dx === -32, 'placing one crops the border rather than centring the artwork',
        'dx ' + shifted.dx);
}

// ─── A blank image has nothing to place ───
{
    const img = image(320, 200, BLACK, null, WHITE);
    const place = LogoFit.plan(img.rgba, img.w, img.h, { band: 88 });
    check(place.bounds === null, 'a blank image has no content bounds');
    check(!place.needsFit, 'and is left alone');
}

// ─── Every band height a player can ask for keeps the artwork visible ───
//
// Artwork that fills its band to within a character cell can have no
// grid-aligned position wholly inside it; the placement then splits the few
// pixels that spill between the two edges rather than shifting off the grid.
{
    let bad = null;
    for (let rows = 1; rows <= 25 && !bad; rows++) {
        for (const h of [40, 88, 150, 199]) {
            const band = LogoFit.bandHeight(rows);
            const img = image(300, 220, BLACK, { x0: 5, y0: 100, x1: 294, y1: 100 + h - 1 }, WHITE);
            const place = LogoFit.plan(img.rgba, img.w, img.h, { band });
            const box = placedBox(place);
            const spill = Math.max(0, -box.y0) + Math.max(0, box.y1 - (band - 1));
            if (!onGrid(place) || box.x0 < 0 || box.x1 > LogoFit.W - 1 || spill > 7) {
                bad = `${rows} rows, ${h}px tall artwork: ${JSON.stringify(box)} in a ${band}px band`;
            }
        }
    }
    check(!bad, 'artwork of any height stays on the character grid within its band', bad || '');
}

// ─── Placing an image never invents a colour ───
//
// The converter ignores the alpha channel, so blending a semi-transparent edge
// with the background hands it in-between shades that belong to no C64 colour
// the artist used. A couple of those in a character cell is enough to fail
// every mode - including multicolour bitmap, which also needs its pixels in
// 2px pairs.
{
    const w = 200, h = 100;
    const rgba = new Uint8Array(w * h * 4);
    const RED = [0x88, 0x20, 0x00], CYAN = [0x68, 0xd0, 0xa8];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const c = x < w / 2 ? RED : CYAN;
            rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2];
            // A soft edge down the middle and a fully transparent margin.
            rgba[p + 3] = (x < 4 || x > w - 5) ? 0 : (Math.abs(x - w / 2) < 2 ? 140 : 255);
        }
    }
    const place = LogoFit.plan(rgba, w, h, { band: 88 });
    const out = LogoFit.composite(rgba, place);
    const seen = new Set();
    for (let i = 0; i < out.length; i += 4) seen.add([out[i], out[i + 1], out[i + 2]].join(','));
    const bg = place.background;
    const allowed = new Set([RED.join(','), CYAN.join(','), [bg.r, bg.g, bg.b].join(',')]);
    const strays = [...seen].filter(c => !allowed.has(c));
    check(strays.length === 0, 'placing an image introduces no colours of its own',
        strays.length ? strays.slice(0, 3).join(' / ') : `${seen.size} colours out`);

    let opaque = true;
    for (let i = 3; i < out.length; i += 4) if (out[i] !== 255) { opaque = false; break; }
    check(opaque, 'and the result is fully opaque');
}

// ─── Scaling down stays nearest-neighbour ───
{
    const w = 640, h = 400;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const on = ((x >> 1) + (y >> 1)) % 2 === 0;   // fine checkerboard: catches any averaging
            rgba[p] = on ? 255 : 0;
            rgba[p + 1] = on ? 255 : 0;
            rgba[p + 2] = on ? 255 : 0;
            rgba[p + 3] = 255;
        }
    }
    const place = LogoFit.plan(rgba, w, h, { band: 88 });
    const out = LogoFit.composite(rgba, place);
    const seen = new Set();
    for (let i = 0; i < out.length; i += 4) seen.add([out[i], out[i + 1], out[i + 2]].join(','));
    const strays = [...seen].filter(c => c !== '0,0,0' && c !== '255,255,255');
    check(strays.length === 0, 'scaling down averages nothing together',
        strays.length ? strays.slice(0, 3).join(' / ') : `${seen.size} colours out`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
