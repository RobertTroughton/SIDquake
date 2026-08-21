#!/usr/bin/env node
/**
 * test-song-end.js - how the tune analysis decides a song ENDED.
 *
 * analyzeRows (public/spectrometer-bake.js) reports one of three answers for a
 * tune: it repeats, it fades out, or nothing was resolved. The third one is the
 * one that matters here. A tune still playing where the analysis has to stop -
 * out of scan window, or out of RAM for the stored bar stream - is NOT a
 * fade-out: reporting it as one puts a made-up length on the C64 clock and
 * offers to loop the song back to a point it never reaches.
 *
 * Pure JS over synthetic bar rows: no WASM, no browser, no SID.
 * Run with `node scripts/test-song-end.js`.
 */

const NUM_BARS = 40;
const FRAME_HZ = 50;
const FPK = 2;                 // -> 25 Hz keyframes, the export default

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

// Deterministic pseudo-random walk, so "music" is loud everywhere but never
// repeats - a loop detected in the test data would make the case meaningless.
function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// `seconds` of playing, then `silentSeconds` of nothing.
function makeRows(seconds, silentSeconds = 0, seed = 1) {
    const rng = makeRng(seed);
    const rows = [];
    for (let f = 0; f < Math.round(seconds * FRAME_HZ); f++) {
        const row = new Float32Array(NUM_BARS);
        for (let b = 0; b < NUM_BARS; b++) row[b] = 0.3 + 0.7 * rng();
        rows.push(row);
    }
    for (let f = 0; f < Math.round(silentSeconds * FRAME_HZ); f++) {
        rows.push(new Float32Array(NUM_BARS));
    }
    return rows;
}

// `cycles` repeats of one `seconds`-long pattern: a tune that really loops.
function makeLoopingRows(seconds, cycles, seed = 7) {
    const one = makeRows(seconds, 0, seed);
    const rows = [];
    for (let c = 0; c < cycles; c++) for (const r of one) rows.push(r);
    return rows;
}

function analyse(bake, rows, outputMaxSeconds, extra = {}) {
    return bake.analyzeRows(rows, {
        numBars: NUM_BARS, maxHeight: 111, frameHz: FRAME_HZ, framesPerKeyframe: FPK,
        minLoopSeconds: 2, outputMaxSeconds,
        analyzedSeconds: rows.length / FRAME_HZ,
        ...extra,
    });
}

(async () => {
    const bake = await import('../public/spectrometer-bake.js');

    // --- a tune that really stops ------------------------------------------
    const faded = analyse(bake, makeRows(60, 30), 600);
    check(faded.fadedOut && !faded.truncated && !faded.looped,
        'music that stops well inside the window is a fade-out',
        JSON.stringify({ faded: faded.fadedOut, cut: faded.truncated, looped: faded.looped }));
    const endedAt = faded.loopStart / faded.keyframeHz;
    check(Math.abs(endedAt - 60) < 1, 'and it ends where the music does', `${endedAt.toFixed(1)}s`);

    // --- a tune still playing where the stream runs out --------------------
    const cut = analyse(bake, makeRows(200), 120);
    check(cut.truncated && !cut.fadedOut && !cut.looped,
        'music still playing at the stored-length cap is a cut, not a fade',
        JSON.stringify({ faded: cut.fadedOut, cut: cut.truncated, looped: cut.looped }));
    const cutAt = cut.loopStart / cut.keyframeHz;
    check(Math.abs(cutAt - 120) < 1, 'and the cut lands on the cap', `${cutAt.toFixed(1)}s`);

    // Same tune, same cap, but the render itself ran out first: still a cut.
    const cutAtWindow = analyse(bake, makeRows(90), 600, { hitCap: true });
    check(cutAtWindow.truncated && !cutAtWindow.fadedOut && cutAtWindow.cappedAtMaxSeconds,
        'and so is music still playing where the scan window ends',
        JSON.stringify({ faded: cutAtWindow.fadedOut, cut: cutAtWindow.truncated }));

    // --- a tune that repeats ------------------------------------------------
    const looped = analyse(bake, makeLoopingRows(20, 4), 600);
    check(looped.looped && !looped.truncated && !looped.fadedOut,
        'a repeating tune is neither of those',
        JSON.stringify({ faded: looped.fadedOut, cut: looped.truncated, looped: looped.looped }));

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
