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
 *   With a HINT from the register pre-pass (public/loop-prepass.js: the frame the
 *   player's state repeats from and its exact period), detectLoop has one pass of
 *   audio and one lag to work with. It must still find the audible fundamental
 *   (a divisor of the state period), the audible intro (never later than the
 *   state one), and reject a hint the audio does not bear out. findStatePeriod
 *   is the pure half of that pre-pass, checked here on synthetic fingerprints;
 *   scripts/test-loop-prepass.js runs the real thing on real tunes.
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

    console.log('detectLoop with a state-loop hint: one pass of audio is enough');
    {
        // The register pre-pass proved the state repeats from I every P; the
        // render holds intro + one period + the confirm window, nothing like the
        // two passes the unhinted search needs, and the answer must still come out.
        const P = 3600, I = 900, W = Math.round(4.0 * FRAME_HZ);
        const grid = makeLooping(P, 5, I);
        const short = grid.subarray(0, (I + P + W + 100) * NUM_BARS);
        const hint = { intro: I, period: P };
        const noHint = detectSeconds(detectLoop, short);
        check(noHint === null, 'without the hint, one pass is not enough to claim a loop');
        const got = detectLoop(short, short.length / NUM_BARS, NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, hint);
        check(got && got.loopEnd - got.loopStart === P, 'with it, the period is the hinted one',
            got ? `${got.loopEnd - got.loopStart} frames` : 'no loop');
        check(got && Math.abs(got.loopStart - I) <= 5, 'and the intro is measured where the music repeats',
            got ? `${got.loopStart} vs ${I}` : '-');
    }

    console.log('detectLoop with a hint: the audible loop can be shorter than the state loop');
    {
        // Something inaudible alternates between passes, so the player's state
        // takes two passes to come round while the bars repeat every pass. The
        // hint says 2P; the answer has to be P.
        const P = 2000, W = Math.round(4.0 * FRAME_HZ);
        const grid = makeLooping(P, 4);
        const short = grid.subarray(0, (2 * P + W + 100) * NUM_BARS);
        const got = detectLoop(short, short.length / NUM_BARS, NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: 0, period: 2 * P });
        check(got && got.loopEnd - got.loopStart === P, 'the fundamental divisor of the hinted period wins',
            got ? `${got.loopEnd - got.loopStart} frames` : 'no loop');
    }

    console.log('detectLoop with a hint: the audible intro can end before the state intro');
    {
        // A first pass that differs only in something the ear does not follow
        // shows up as a long state intro. The audio repeats from the top.
        const P = 2500, W = Math.round(4.0 * FRAME_HZ), HI = 900;
        const grid = makeLooping(P, 4);
        const short = grid.subarray(0, (HI + P + W + 100) * NUM_BARS);
        const got = detectLoop(short, short.length / NUM_BARS, NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: HI, period: P });
        check(got && got.loopStart === 0, 'the intro is where the bars repeat from, not where the state does',
            got ? `${got.loopStart}` : 'no loop');
    }

    console.log('detectLoop with a hint the audio does not bear out');
    {
        const W = Math.round(4.0 * FRAME_HZ);
        const grid = makeGrid(Math.round(120 * FRAME_HZ));
        fillPattern(grid, 0, grid.length / NUM_BARS, 9);
        const got = detectLoop(grid, grid.length / NUM_BARS, NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: 0, period: 2000 });
        check(got === null, 'a wrong hint is rejected, not believed', got ? 'claimed a loop' : '');
        const silent = makeLooping(2000, 3);
        silent.fill(0, (silent.length / NUM_BARS - W - 20) * NUM_BARS);
        const got2 = detectLoop(silent, silent.length / NUM_BARS, NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: 0, period: 2000 });
        check(got2 === null, 'a silent confirm window proves nothing', got2 ? 'claimed a loop' : '');

        // Five minutes of music, then the player ticks over in a faint 2 s cycle
        // for ever: a state loop, but the tune has ended.
        const music = Math.round(300 * FRAME_HZ), tick = 100;
        const idle = makeGrid(music + tick * 4 + W);
        fillPattern(idle, 0, music, 13);
        const one = makeGrid(tick);
        // Loud enough to pass the tail's own energy floor, far below the music.
        for (let f = 0; f < tick; f++) for (let b = 0; b < NUM_BARS; b++) one[f * NUM_BARS + b] = 10 + (f + b) % 5;
        for (let c = 0; c * tick < tick * 4 + W; c++) idle.set(one.subarray(0, Math.min(tick, idle.length / NUM_BARS - music - c * tick) * NUM_BARS), (music + c * tick) * NUM_BARS);
        const got3 = detectLoop(idle, idle.length / NUM_BARS, NUM_BARS, MAX_HEIGHT, FRAME_HZ, 2, { intro: music, period: tick });
        check(got3 === null, 'a faint idle cycle after the music is an ending, not the loop', got3 ? 'claimed a loop' : '');
    }

    console.log('findStatePeriod: where a fingerprint stream first repeats');
    {
        const { findStatePeriod } = await import('../public/loop-prepass.js');
        const rng = makeRng(77);
        const seq = (n) => { const h = new Uint32Array(n); for (let i = 0; i < n; i++) h[i] = (rng() * 0x100000000) >>> 0; return h; };
        const tile = (intro, one, cycles) => {
            const h = new Uint32Array(intro.length + one.length * cycles);
            h.set(intro, 0);
            for (let c = 0; c < cycles; c++) h.set(one, intro.length + c * one.length);
            return h;
        };
        const P = 3000, I = 700;
        const h = tile(seq(I), seq(P), 4);
        const r = findStatePeriod(h, h.length, 100, 200);
        check(r && r.period === P && r.intro === I, 'intro and period are exact',
            r ? `intro ${r.intro} period ${r.period}` : 'nothing');

        // A phrase played four times in a row at the END of the scanned span is
        // a repeat, not the loop: the true period explains the stream from the
        // intro on, the riff only its own last passes.
        const riff = seq(150);
        const loopWithRiff = new Uint32Array(P);
        loopWithRiff.set(seq(P - 4 * 150), 0);
        for (let k = 0; k < 4; k++) loopWithRiff.set(riff, P - 4 * 150 + k * 150);
        const h2 = tile(seq(I), loopWithRiff, 3);
        const r2 = findStatePeriod(h2, h2.length, 100, 200);
        check(r2 && r2.period === P, 'a riff repeated at the end of the span does not pass for the loop',
            r2 ? `period ${r2.period}` : 'nothing');

        const h3 = seq(20000);
        check(findStatePeriod(h3, h3.length, 100, 200) === null, 'a stream that never repeats reports nothing');

        // Two passes plus the confirm entries have to be seen: one and a bit is a repeat.
        const h4 = tile(seq(0), seq(P), 2);
        check(findStatePeriod(h4, h4.length, 100, 200) === null, 'two bare passes are not enough');
        const h5 = tile(seq(0), seq(P), 2);
        const h5x = new Uint32Array(h5.length + 200); h5x.set(h5); h5x.set(h5.subarray(0, 200), h5.length);
        const r5 = findStatePeriod(h5x, h5x.length, 100, 200);
        check(r5 && r5.period === P && r5.intro === 0, 'two passes plus the confirm entries are', r5 ? `period ${r5.period}` : 'nothing');
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
