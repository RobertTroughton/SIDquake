#!/usr/bin/env node
/**
 * test-loop-detect.js - which period the loop detector settles on, and when the
 * render is allowed to stop on it.
 *
 * Two halves, both pure JS over synthetic bar grids (no WASM, no SID, no browser):
 *
 *   detectLoop (public/spectrometer-bake.js) has to name the tune's REAL musical
 *   period. Too short and the C64 wraps the bars several times per musical loop;
 *   too long and the export stores minutes of duplicate stream. The two ways to
 *   get it wrong are a decoy lag (a phrase that recurs inside the loop at a lag
 *   unrelated to the period) and a sub-harmonic (an accompaniment that repeats
 *   twice per loop while the melody does not).
 *
 *   loopConfirmSeconds (public/spectrometer-bake-core.js) decides how much audio
 *   must be rendered before a proposed period is believed. Two passes of a phrase
 *   is a repeat, not a loop, so a candidate that appears late has to survive
 *   proportionally more music before the render stops on it.
 *
 * Run with `node scripts/test-loop-detect.js`.
 */

const NUM_BARS = 40;
const MAX_HEIGHT = 111;
const FRAME_HZ = 50.1245;

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

// A grid is a flat Uint8Array of `frames` columns of NUM_BARS bytes, the same
// shape whitenQuantize hands detectLoop.
function makeGrid(frames) {
    return new Uint8Array(frames * NUM_BARS);
}

// One musical "pattern": `frames` columns of loud, non-repeating movement. Bars
// [barFrom, barTo) only, so a caller can give the accompaniment and the melody
// different periods.
function fillPattern(grid, at, frames, seed, barFrom = 0, barTo = NUM_BARS) {
    const rng = makeRng(seed);
    for (let f = 0; f < frames; f++) {
        for (let b = barFrom; b < barTo; b++) {
            grid[(at + f) * NUM_BARS + b] = 30 + Math.floor(rng() * (MAX_HEIGHT - 30));
        }
    }
}

// `cycles` repeats of `period` frames of music, after `intro` frames of something
// else. `decorate(pattern)` may rewrite the pattern before it is tiled, so a
// decoy stays perfectly periodic.
function makeLooping(period, cycles, intro = 0, seed = 3, decorate = null) {
    const one = makeGrid(period);
    fillPattern(one, 0, period, seed);
    if (decorate) decorate(one);
    const grid = makeGrid(intro + period * cycles);
    if (intro) fillPattern(grid, 0, intro, seed + 99);
    for (let c = 0; c < cycles; c++) grid.set(one, (intro + c * period) * NUM_BARS);
    return grid;
}

const detectSeconds = (detectLoop, grid, minLoopSeconds = 2) => {
    const frames = grid.length / NUM_BARS;
    const r = detectLoop(grid, frames, NUM_BARS, MAX_HEIGHT, FRAME_HZ, minLoopSeconds);
    return r ? { period: (r.loopEnd - r.loopStart) / FRAME_HZ, intro: r.loopStart / FRAME_HZ } : null;
};

async function main() {
    const bake = await import('../public/spectrometer-bake.js');
    const core = await import('../public/spectrometer-bake-core.js');
    const { detectLoop } = bake._internals;
    const { loopConfirmSeconds } = core;
    const near = (a, b, tol = 0.1) => a != null && Math.abs(a - b) <= tol;

    console.log('detectLoop: a plain repeating tune');
    {
        const P = 3600;                                  // 71.8 s
        const got = detectSeconds(detectLoop, makeLooping(P, 5));
        check(near(got && got.period, P / FRAME_HZ), 'reports the period it was built with',
            got ? `${got.period.toFixed(2)}s` : 'no loop');
        check(near(got && got.intro, 0), 'no intro on a tune that loops from frame 0');
    }

    console.log('detectLoop: an intro in front of the loop');
    {
        const P = 2000, I = 900;
        const got = detectSeconds(detectLoop, makeLooping(P, 5, I));
        check(near(got && got.period, P / FRAME_HZ), 'period unaffected by the intro',
            got ? `${got.period.toFixed(2)}s` : 'no loop');
        check(near(got && got.intro, I / FRAME_HZ, 0.5), 'intro measured to where the repeat starts',
            got ? `${got.intro.toFixed(2)}s` : '-');
    }

    console.log('detectLoop: a decoy phrase inside the loop');
    {
        // Miranda (Mitch & Dane) in miniature. Its last 4 s also recur 38.3 s
        // earlier - a phrase repeated inside the loop - and 38.3 s neither divides
        // nor is divided by the real 71.8 s period, so anchoring on the first lag
        // that matches the tail and walking ITS harmonics can never reach the
        // truth: the tune came back as "no loop" after a full 20-minute scan.
        const P = 3600, cycles = 5, W = Math.round(4.0 * FRAME_HZ), decoyLag = 1920;
        const frames = P * cycles;
        const grid = makeLooping(P, cycles, 0, 11, (one) => {
            const tailPos = (frames - W) % P;
            const decoyPos = (frames - W - decoyLag) % P;
            for (let x = 0; x < W; x++) {
                const from = ((tailPos + x) % P) * NUM_BARS, to = ((decoyPos + x) % P) * NUM_BARS;
                for (let b = 0; b < NUM_BARS; b++) one[to + b] = one[from + b];
            }
        });
        const got = detectSeconds(detectLoop, grid);
        check(near(got && got.period, P / FRAME_HZ), 'the true period wins over the decoy lag',
            got ? `${got.period.toFixed(2)}s` : 'no loop');
    }

    console.log('detectLoop: an accompaniment that repeats twice per loop');
    {
        // Half the bars carry a P/2 riff, the other half a melody that only comes
        // round every P. Locking the riff would cycle the bars twice as fast as
        // the music, so the fundamental has to win.
        const P = 3000;
        const one = makeGrid(P);
        fillPattern(one, 0, P / 2, 21, 0, NUM_BARS / 2);
        for (let f = 0; f < P / 2; f++) {
            for (let b = 0; b < NUM_BARS / 2; b++) one[(P / 2 + f) * NUM_BARS + b] = one[f * NUM_BARS + b];
        }
        fillPattern(one, 0, P, 22, NUM_BARS / 2, NUM_BARS);
        const cycles = 5;
        const grid = makeGrid(P * cycles);
        for (let c = 0; c < cycles; c++) grid.set(one, c * P * NUM_BARS);
        const got = detectSeconds(detectLoop, grid);
        check(near(got && got.period, P / FRAME_HZ), 'reports the melody\'s period, not the riff\'s',
            got ? `${got.period.toFixed(2)}s` : 'no loop');
    }

    console.log('detectLoop: music that never repeats');
    {
        const grid = makeGrid(Math.round(300 * FRAME_HZ));
        fillPattern(grid, 0, grid.length / NUM_BARS, 5);
        check(detectSeconds(detectLoop, grid) === null, 'no loop claimed on a non-repeating stream');
    }

    console.log('detectLoop: silence at the end');
    {
        const P = 2000;
        const grid = makeLooping(P, 4);
        const frames = grid.length / NUM_BARS;
        grid.fill(0, (frames - Math.round(6 * FRAME_HZ)) * NUM_BARS);
        check(detectSeconds(detectLoop, grid) === null, 'a silent tail is an ending, not a loop');
    }

    console.log('loopConfirmSeconds: how long a candidate must hold up');
    {
        // A short period seen almost immediately: three passes plus the detector's
        // own tail window is the whole requirement, so the render stops quickly.
        const quick = loopConfirmSeconds(0, 8, 30);
        check(quick > 30 && quick <= 50, 'an 8 s loop first seen at 30 s is settled inside a minute',
            `${quick.toFixed(1)}s`);

        // The same period first seen deep into a tune is the dangerous case: a
        // riff that has been going for a while looks exactly like a loop. It has
        // to keep looking like one for half as long again.
        const late = loopConfirmSeconds(0, 8, 165);
        check(late >= 165 + 80, 'the same loop first seen at 165 s must hold for another ~80 s',
            `${late.toFixed(1)}s`);

        // Nothing is ever taken on first sight, whatever the arithmetic says.
        for (const [period, seen] of [[2, 200], [8, 45], [40, 400]]) {
            check(loopConfirmSeconds(0, period, seen) > seen,
                `a ${period} s loop first seen at ${seen} s is not accepted on the spot`);
        }

        // A multi-minute phrase is taken near enough on sight: three passes of it
        // would cost more render than the answer is worth.
        const long = loopConfirmSeconds(0, 200, 410);
        check(long <= 410 + 95, 'a 200 s loop does not cost three more passes to confirm',
            `+${(long - 410).toFixed(1)}s`);
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
