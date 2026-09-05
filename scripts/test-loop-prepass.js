#!/usr/bin/env node
/**
 * test-loop-prepass.js - the register pre-pass against real tunes.
 *
 * findStateLoop (public/loop-prepass.js) steps a tune's player on the 6510
 * analyser in sidquake.wasm and reports where its SID writes start repeating
 * and with what period, to the frame. The periods below are HVSC's published
 * song lengths for tunes that loop from the top (Songlengths.md5, PAL 50.1245 Hz
 * frames), so this is the pre-pass against an independent measurement - and it
 * covers a vsync tune, CIA-timed multispeed at 2x / 3x / 8x, and a 2SID tune.
 *
 * Needs public/sidquake.wasm; no browser. Run with `node scripts/test-loop-prepass.js`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAL_HZ = 50.1245;

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

// file -> [HVSC length in seconds, expected calls per frame]. Every one of these
// loops from within a second of the top, so HVSC's length IS the period.
const CASES = [
    ['JCH-Crystalline.sid',        214.347, 1],
    ['acrouzet-soulspace.sid',     229.828, 1],
    ['celticdesign-7-3.sid',       176.202, 1],
    ['Distant_Dissonance.sid',     183.863, 1],
    ['Phat_Frog_2SID.sid',         169.0,   1],
    ['flex-eurogubbe.sid',         203.654, 2],
    ['Blending_Mode.sid',          211.637, 3],
    ['trident-cheap.sid',          46.0,    8],
];

async function main() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    const module = await factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
        print: () => {}, printErr: () => {},
    });
    const { findStateLoop, parseSidHeader } = await import('../public/loop-prepass.js');

    console.log('findStateLoop: period and intro of tunes with a known length');
    for (const [file, hvscSeconds, callsPerFrame] of CASES) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'SID', file)));
        const h = parseSidHeader(bytes);
        const r = findStateLoop(module, bytes, {
            subtune: Math.max(0, h.startSong - 1), isNtsc: h.isNtsc,
            maxFrames: Math.round(1200 * PAL_HZ),
            minLoopFrames: Math.round(2 * PAL_HZ), confirmFrames: Math.round(6 * PAL_HZ),
        });
        const period = r ? r.periodFrames / PAL_HZ : null;
        const intro = r ? r.introFrames / PAL_HZ : null;
        // Half a second either way: HVSC's times are quoted to the millisecond but
        // measured by ear against a player, and a multispeed period is converted
        // through the CIA timer's exact share of a frame.
        check(r && Math.abs(period - hvscSeconds) <= 0.5,
            `${file}: period matches HVSC`, r ? `${period.toFixed(3)}s vs ${hvscSeconds}s` : 'no state loop');
        check(r && intro <= 1.0, `${file}: loops from the top`, r ? `intro ${intro.toFixed(2)}s` : '-');
        check(r && r.callsPerFrame === callsPerFrame, `${file}: ${callsPerFrame} play call(s) per frame`,
            r ? `${r.callsPerFrame}` : '-');
    }

    console.log('findStateLoop: a tune that does not repeat inside the window');
    {
        // Parallax (Galway) is 11:23 to HVSC; two passes do not fit in 20 minutes.
        const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'SID', 'martingalway-parallax-multisong.sid')));
        const h = parseSidHeader(bytes);
        const r = findStateLoop(module, bytes, {
            subtune: Math.max(0, h.startSong - 1), isNtsc: h.isNtsc,
            maxFrames: Math.round(1200 * PAL_HZ),
            minLoopFrames: Math.round(2 * PAL_HZ), confirmFrames: Math.round(6 * PAL_HZ),
        });
        check(r === null, 'no state loop is claimed', r ? `${(r.periodFrames / PAL_HZ).toFixed(1)}s` : '');
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
