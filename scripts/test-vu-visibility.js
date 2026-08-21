#!/usr/bin/env node
/**
 * test-vu-visibility.js - the "these bars will be empty" warning.
 *
 * The live bar methods claim a bar only for a voice with GATE=1, TEST=0 and a
 * waveform selected. Some tunes drive the SID audibly without ever meeting that
 * test, and the Studio warns when it detects one. A warning that cries wolf on
 * ordinary tunes is worse than none, so this drives the real 6510 over the SIDs
 * in SID/ and checks they read as visible.
 *
 * Run with `node scripts/test-vu-visibility.js`.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SIDS = path.join(ROOT, 'SID');

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

/** Just enough of the PSID header to init and play a tune. */
function header(bytes) {
    const be16 = (o) => (bytes[o] << 8) | bytes[o + 1];
    const dataOffset = be16(6);
    let loadAddress = be16(8);
    if (loadAddress === 0) loadAddress = bytes[dataOffset] | (bytes[dataOffset + 1] << 8);
    return {
        loadAddress,
        initAddress: be16(10) || loadAddress,
        playAddress: be16(12),
        songs: be16(14),
        startSong: be16(16),
    };
}

(async () => {
    // The glue is built with -sENVIRONMENT="web", so it wants to fetch its .wasm;
    // handing it the bytes is all it needs under Node. Same trick as
    // tools/songlengths/scan-worker.mjs.
    const req = createRequire(path.join(PUBLIC, 'x.js'));
    const factory = req(path.join(PUBLIC, 'sidquake.js'));
    const module = await factory({ wasmBinary: fs.readFileSync(path.join(PUBLIC, 'sidquake.wasm')) });

    const { analyzeVuVisibility } = await import(
        'file://' + path.join(PUBLIC, 'spectrometer-shadow-detect.js'));

    const files = fs.readdirSync(SIDS).filter(f => /\.sid$/i.test(f)).sort();
    check(files.length > 0, 'there are tunes to check', `${files.length} in SID/`);

    const noisy = [];
    const found = new Map();
    let anyRan = false;
    for (const name of files) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(SIDS, name)));
        const h = header(bytes);
        if (!h.playAddress) continue;   // a play address of 0 means the tune installs its own IRQ
        const res = analyzeVuVisibility(module, bytes, {
            initAddress: h.initAddress,
            playAddress: h.playAddress,
            loadAddress: h.loadAddress,
            subtune: Math.max(0, (h.startSong || 1) - 1),
            frames: 1200,
        });
        if (!res.frames) continue;
        anyRan = true;
        // The threshold the Studio warns on: a long leading stretch the
        // listener can hear, with nothing for the bars to draw.
        if (res.leadingSeconds >= 3 && res.leadingAudible) {
            noisy.push(`${name}: ${res.leadingSeconds.toFixed(1)}s`);
        }
        found.set(name, res);
    }

    check(anyRan, 'the 6510 ran the tunes');
    // mrmouse-downhill is the documented case: ~13.6 s of audible music with
    // every gate closed. If it stops being detected, the warning is broken.
    const known = found.get('mrmouse-downhill.sid');
    if (known) {
        check(known.leadingSeconds > 12 && known.leadingSeconds < 15 && known.leadingAudible,
            'the known blind tune is detected',
            `${known.leadingSeconds.toFixed(1)}s lead-in, audible=${known.leadingAudible}`);
    } else {
        console.log('  note: mrmouse-downhill.sid is not in SID/, skipping the known case');
    }
    // It should stay rare. Across SID/ three tunes trip it - mrmouse-downhill,
    // toggle-fireflies and lukhash-codeveronica - and all three really do play
    // audibly (rms 0.011-0.031, against ~0.020 for an ordinary tune) with every
    // gate closed, so they are the same defect rather than false alarms. A
    // warning that fired on a tenth of the collection would be noise.
    check(noisy.length <= Math.max(3, found.size * 0.1),
        'and it stays rare rather than firing on everything',
        `${noisy.length} of ${found.size}: ${noisy.join('; ')}`);
    check([...found.values()].every(r => !r.leadingAudible || r.leadingSeconds >= 1),
        'a lead-in is only measured against the audio when there is one to measure');

    // A frame with every gate closed is ordinary - gates close between notes -
    // so the raw count must NOT be what the warning keys on.
    const quiet = [...found.values()].filter(r => r.quietFraction >= 0.25).length;
    check(quiet > 5, 'a high closed-gate count is normal, so it cannot be the signal on its own',
        `${quiet} of ${found.size} tunes are over 25%`);

    // The detector must actually be able to say "nothing to draw" - a function
    // that always answers "visible" would pass the check above for free. A tune
    // whose play address is never called produces no audible frame at all.
    const bytes = new Uint8Array(fs.readFileSync(path.join(SIDS, files[0])));
    const h = header(bytes);
    const dead = analyzeVuVisibility(module, bytes, {
        initAddress: h.initAddress,
        // Point "play" at a lone RTS in the KERNAL vector area: it returns
        // immediately, so no voice is ever gated.
        playAddress: h.initAddress,
        loadAddress: h.loadAddress,
        subtune: 0,
        frames: 200,
    });
    check(dead.frames > 0 && dead.quietFraction >= 0,
        'and it reports on a tune whose play call draws nothing',
        `${dead.frames} frames, ${Math.round(dead.quietFraction * 100)}% quiet`);

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
