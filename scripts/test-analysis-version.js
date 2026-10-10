#!/usr/bin/env node
/**
 * test-analysis-version.js - stored scan results are not read back across a
 * change to the analysis that produced them.
 *
 * ui.js caches each tune's loop/length scan (public/analysis-store.js) under a
 * key that includes ANALYSIS_VERSION, built from LOOP_DETECT_VERSION
 * (public/loop-detect.js) and PREPASS_VERSION (public/loop-prepass.js). This
 * hashes what each side answers on fixed inputs and fails when a hash moves
 * while its version stays put:
 *
 *   loop detection  detectLoop with and without a hint, and analyzeRows on
 *                   looping, fading and cut-off synthetic rows (so whitening
 *                   and the bake defaults it reads are covered too);
 *   pre-pass        findStatePeriod on synthetic hashes, and findStateLoop and
 *                   fingerprintTune on two tunes built in the test.
 *
 * A deliberate change bumps the version and pins the hash this prints in PINNED.
 * Needs public/sidquake.wasm; no browser. Run with
 * `node scripts/test-analysis-version.js`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { psid, asm } = require('./lib/psid-asm.js');

const ROOT = path.join(__dirname, '..');
const NUM_BARS = 40;
const MAX_HEIGHT = 111;
const FRAME_HZ = 50.1245;

// The hash each version answers with.
const PINNED = {
    loopDetect: { version: 1, hash: '5845ef4ec197ecc6' },
    prepass: { version: 1, hash: 'fb0bce06055eeb9a' },
};

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// `intro` frames of something else, then `cycles` repeats of `period` frames,
// as a quantized grid (the shape whitenQuantize hands detectLoop).
function loopingGrid(period, cycles, intro, seed) {
    const rng = makeRng(seed);
    const one = Uint8Array.from({ length: period * NUM_BARS }, () => 30 + Math.floor(rng() * (MAX_HEIGHT - 30)));
    const grid = new Uint8Array((intro + period * cycles) * NUM_BARS);
    for (let i = 0; i < intro * NUM_BARS; i++) grid[i] = 30 + Math.floor(rng() * (MAX_HEIGHT - 30));
    for (let c = 0; c < cycles; c++) grid.set(one, (intro + c * period) * NUM_BARS);
    return grid;
}

// Raw analyser rows: `seconds` of loud non-repeating values, then silence;
// `cycles` > 1 repeats the playing part.
function rows(seconds, silentSeconds, seed, cycles = 1) {
    const rng = makeRng(seed);
    const one = [];
    for (let f = 0; f < Math.round(seconds * FRAME_HZ); f++) {
        const row = new Float32Array(NUM_BARS);
        for (let b = 0; b < NUM_BARS; b++) row[b] = 0.3 + 0.7 * rng();
        one.push(row);
    }
    const out = [];
    for (let c = 0; c < cycles; c++) out.push(...one);
    for (let f = 0; f < Math.round(silentSeconds * FRAME_HZ); f++) out.push(new Float32Array(NUM_BARS));
    return out;
}

const digest = (parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

function loopDetectHash(detectLoop, analyzeRows) {
    const parts = [];
    const looping = loopingGrid(300, 4, 120, 3);
    const frames = (g) => g.length / NUM_BARS;
    parts.push(detectLoop(looping, frames(looping), NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2));
    const short = looping.subarray(0, (120 + 300 + 250) * NUM_BARS);
    parts.push(detectLoop(short, frames(short), NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: 120, period: 300 }));
    parts.push(detectLoop(short, frames(short), NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: 0, period: 600 }));
    const noise = loopingGrid(2000, 1, 0, 11);
    parts.push(detectLoop(noise, frames(noise), NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2));
    const analyse = (r, extra) => analyzeRows(r, {
        numBars: NUM_BARS, maxHeight: MAX_HEIGHT, frameHz: FRAME_HZ, minLoopSeconds: 2,
        outputMaxSeconds: 120, analyzedSeconds: r.length / FRAME_HZ, ...extra,
    });
    parts.push(analyse(rows(9, 0, 7, 4)));
    parts.push(analyse(rows(9, 0, 7, 3), { loopHint: { intro: 0, period: Math.round(9 * FRAME_HZ) } }));
    parts.push(analyse(rows(40, 20, 1)));
    parts.push(analyse(rows(40, 20, 1), { framesPerKeyframe: 3, forceLoop: true }));
    parts.push(analyse(rows(150, 0, 2), { hitCap: true }));
    parts.push(analyse(rows(150, 0, 2), { measureOnly: true }));
    return digest(parts);
}

function prepassHash(module, { findStatePeriod, findStateLoop, fingerprintTune }) {
    const parts = [];
    const rng = makeRng(5);
    const seq = (intro, period, n) => {
        const one = Array.from({ length: period }, () => (rng() * 0x100000000) >>> 0);
        return Uint32Array.from({ length: n }, (_, i) => (i < intro ? (rng() * 0x100000000) >>> 0 : one[(i - intro) % period]));
    };
    const h = seq(37, 23, 400);
    parts.push(findStatePeriod(h, h.length, 5, 10));
    parts.push(findStatePeriod(h, h.length, 30, 10));
    const flat = seq(0, 1, 100);
    parts.push(findStatePeriod(flat, flat.length, 4, 10));
    const noise = seq(400, 1, 400);
    parts.push(findStatePeriod(noise, noise.length, 5, 10));

    // A counter 0..54 written to $D400 and its low nibble to $D418 each call.
    const vsync = psid({ play: 0x1006, code: asm(0x1000, [
        0xa9, 0x00, 0x8d, 0x00, 0x11, 0x60,   // LDA #0 / STA $1100 / RTS
        0xae, 0x00, 0x11, 0xe8,               // LDX $1100 / INX
        0xe0, 55, 0xd0, 0x02, 0xa2, 0x00,     // CPX #55 / BNE +2 / LDX #0
        0x8e, 0x00, 0x11, 0x8e, 0x00, 0xd4,   // STX $1100 / STX $D400
        0x8a, 0x29, 0x0f, 0x8d, 0x18, 0xd4,   // TXA / AND #$0F / STA $D418
        0x60,                                 // RTS
    ]) });
    // Play address 0: init installs a $0314 handler counting 0..49 into $D400.
    const irq = psid({ play: 0, code: asm(0x1000, [
        0xa9, '<irq', 0x8d, 0x14, 0x03, 0xa9, '>irq', 0x8d, 0x15, 0x03, 0x60,
        'irq:', 0xae, 0x00, 0x11, 0xe8,
        0xe0, 50, 0xd0, 0x02, 0xa2, 0x00,
        0x8e, 0x00, 0x11, 0x8e, 0x00, 0xd4,
        0x4c, 0x31, 0xea,
    ]) });
    for (const tune of [vsync, irq]) {
        parts.push(findStateLoop(module, tune, { subtune: 0, maxFrames: 1000, minLoopFrames: 10, confirmFrames: 50 }));
        const fp = fingerprintTune(module, tune, { maxFrames: 200 });
        parts.push(fp && { ...fp, hashes: Array.from(fp.hashes) });
    }
    return digest(parts);
}

function checkPinned(name, constant, file, version, hash) {
    const pin = PINNED[name];
    if (pin.version !== version) {
        check(false, `${constant} ${version} is pinned in PINNED.${name}`,
            `pin { version: ${version}, hash: '${hash}' } in scripts/test-analysis-version.js`);
    } else if (pin.hash !== hash) {
        check(false, `${name} answers what ${constant} ${version} pinned`,
            `hash ${hash}, pinned ${pin.hash}: bump ${constant} in ${file} and pin the new hash`);
    } else {
        check(true, `${name} answers what ${constant} ${version} pinned`);
    }
}

async function main() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    const module = await factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
        print: () => {}, printErr: () => {},
    });
    const { detectLoop, LOOP_DETECT_VERSION } = await import('../public/loop-detect.js');
    const { analyzeRows } = await import('../public/spectrometer-bake.js');
    const prepass = await import('../public/loop-prepass.js');
    const { ANALYSIS_VERSION } = await import('../public/spectrometer-bake-core.js');

    console.log('analysis versions');
    checkPinned('loopDetect', 'LOOP_DETECT_VERSION', 'public/loop-detect.js',
        LOOP_DETECT_VERSION, loopDetectHash(detectLoop, analyzeRows));
    checkPinned('prepass', 'PREPASS_VERSION', 'public/loop-prepass.js',
        prepass.PREPASS_VERSION, prepassHash(module, prepass));
    check(ANALYSIS_VERSION === `${LOOP_DETECT_VERSION}.${prepass.PREPASS_VERSION}`,
        'ANALYSIS_VERSION carries both', ANALYSIS_VERSION);

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
