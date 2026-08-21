#!/usr/bin/env node
/**
 * test-c64-render.js - the C64 preview draws what the C64 will draw.
 *
 * The Studio shows a converted logo as the machine will render it, from the
 * same fields buildLogoBlob ships. A preview that quietly disagrees with the
 * export is worse than none, so this converts images that are already valid C64
 * pictures and checks the render comes back identical to what went in: any
 * misreading of the VIC's rules - colour-RAM bit 3, the ECM background bits, a
 * bitmap's screen nibbles - shows up as differing pixels.
 *
 * Run with `node scripts/test-c64-render.js`.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'public', 'c64-palette.js'));   // defines globalThis.C64_PALETTE_RGB
const CharsetLabCore = require(path.join(ROOT, 'public', 'charsetlab-core.js'));

const PAL = globalThis.C64_PALETTE_RGB;
const W = 320, H = 200;

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

/** An RGBA image built from C64 colour indices, one index per pixel. */
function toRGBA(indices) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const c = PAL[indices[i] & 0x0f];
        out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
    return out;
}

/** Colour index per pixel, back out of an RGBA buffer. */
function toIndices(rgba) {
    const out = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < 16; c++) {
            const p = PAL[c];
            const d = (rgba[i * 4] - p[0]) ** 2 + (rgba[i * 4 + 1] - p[1]) ** 2
                + (rgba[i * 4 + 2] - p[2]) ** 2;
            if (d < bestD) { bestD = d; best = c; }
        }
        out[i] = best;
    }
    return out;
}

/**
 * A picture that obeys one mode's cell rules exactly, so a correct converter
 * reproduces it byte for byte and a correct renderer puts it back.
 *
 * @param {'hires'|'mc'|'ecm'|'mixed'} kind
 */
function makePicture(kind) {
    const px = new Uint8Array(W * H).fill(0);
    // A deterministic pattern - no randomness, so a failure is reproducible.
    for (let cy = 0; cy < 25; cy++) {
        for (let cx = 0; cx < 40; cx++) {
            const cell = cy * 40 + cx;
            if (kind === 'hires') {
                // Two colours per 8x8 cell: background 0 plus one ink.
                const ink = 1 + (cell % 15);
                for (let ry = 0; ry < 8; ry++) {
                    for (let rx = 0; rx < 8; rx++) {
                        const on = ((rx + ry + cell) & 3) === 0;
                        px[(cy * 8 + ry) * W + cx * 8 + rx] = on ? ink : 0;
                    }
                }
            } else if (kind === 'mc') {
                // Multicolour: 2px-wide pixels, one shared background plus two
                // shared colours plus one free per cell.
                const free = 1 + (cell % 7);
                const table = [0, 6, 14, free];   // bg, mc1, mc2, per-cell
                for (let ry = 0; ry < 8; ry++) {
                    for (let rx = 0; rx < 4; rx++) {
                        const v = table[(rx + ry + cell) & 3];
                        px[(cy * 8 + ry) * W + cx * 8 + rx * 2] = v;
                        px[(cy * 8 + ry) * W + cx * 8 + rx * 2 + 1] = v;
                    }
                }
            } else if (kind === 'ecm') {
                // Four global backgrounds, one ink per cell, and at most 64
                // distinct glyphs - so the pattern is drawn from a small set.
                const backgrounds = [0, 6, 11, 12];
                const bgc = backgrounds[cell & 3];
                const ink = 1 + (cell % 15);
                const pattern = cell % 16;
                for (let ry = 0; ry < 8; ry++) {
                    for (let rx = 0; rx < 8; rx++) {
                        const on = ((rx + ry + pattern) & 3) === 0;
                        px[(cy * 8 + ry) * W + cx * 8 + rx] = on ? ink : bgc;
                    }
                }
            } else {
                // Mixed: hires and multicolour cells side by side, which is what
                // colour-RAM bit 3 exists to distinguish.
                const hires = (cx & 1) === 0;
                for (let ry = 0; ry < 8; ry++) {
                    if (hires) {
                        const ink = 1 + (cell % 7);
                        for (let rx = 0; rx < 8; rx++) {
                            px[(cy * 8 + ry) * W + cx * 8 + rx] =
                                ((rx + ry + cell) & 3) === 0 ? ink : 0;
                        }
                    } else {
                        const table = [0, 6, 14, 1 + (cell % 7)];
                        for (let rx = 0; rx < 4; rx++) {
                            const v = table[(rx + ry + cell) & 3];
                            px[(cy * 8 + ry) * W + cx * 8 + rx * 2] = v;
                            px[(cy * 8 + ry) * W + cx * 8 + rx * 2 + 1] = v;
                        }
                    }
                }
            }
        }
    }
    return px;
}

function roundTrip(name, kind, modes) {
    const source = makePicture(kind);
    const report = CharsetLabCore.analyse(toRGBA(source), W, H, { shift: false, modes });
    const r = report.chosen;
    if (!r) {
        check(false, `${name}: converts at all`, CharsetLabCore.failureReason(report));
        return null;
    }
    const rendered = CharsetLabCore.renderResult(r);
    if (!rendered) { check(false, `${name}: renders at all`); return null; }
    check(rendered.width === W && rendered.height === H, `${name}: renders a full screen`,
        `${rendered.width}x${rendered.height}`);

    const got = toIndices(rendered.rgba);
    let wrong = 0, firstAt = -1;
    for (let i = 0; i < W * H; i++) {
        if (got[i] !== source[i]) { wrong++; if (firstAt < 0) firstAt = i; }
    }
    check(wrong === 0, `${name}: comes back pixel for pixel (${r.mode})`,
        wrong ? `${wrong} of ${W * H} differ, first at ${firstAt % W},${Math.floor(firstAt / W)} `
            + `(wanted ${source[firstAt]}, got ${got[firstAt]})` : `${r.mode}`);
    return r;
}

// Hires characters: bit set -> colour RAM, clear -> $d021.
roundTrip('hires characters', 'hires', ['hires']);
// Multicolour characters: pixel pairs, colour-RAM bit 3 marks the cell.
roundTrip('multicolour characters', 'mc', ['mixed']);
// Mixed: hires and multicolour cells in one picture, told apart by colour-RAM
// bit 3 - the rule most easily got wrong.
roundTrip('mixed cells', 'mixed', ['mixed']);
// ECM: the top two screen bits pick one of four global backgrounds.
roundTrip('ECM', 'ecm', ['ecm']);
// The bitmap modes carry their colours in the screen nibbles instead.
roundTrip('hires bitmap', 'hires', ['bitmap-hires']);
roundTrip('multicolour bitmap', 'mc', ['bitmap-mc']);

// A result that did not fit renders as nothing rather than as garbage.
check(CharsetLabCore.renderResult(null) === null, 'nothing to render gives nothing back');
check(CharsetLabCore.renderResult({ ok: false }) === null, 'and so does a result that did not fit');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
