// loop-prepass.js - find where a tune's PLAYER repeats, from its SID register
// writes, before any audio is rendered.
//
// A SID player is a deterministic program stepped once per frame (or N times per
// frame on a CIA timer). Once its state comes round, every write it makes comes
// round with it, so the sequence of per-frame write fingerprints is exactly
// periodic from that point on. The 6510 analyser in sidquake.wasm runs a play
// call in microseconds, so twenty minutes of tune cost about a second here,
// where rendering the same twenty minutes of audio costs minutes.
//
// What comes out is the STATE loop: the frame the player's state first repeats
// from, and the period it repeats with, both exact. That is not the same thing
// as the loop a listener hears, and it is not what the exporter stores:
//
//   - the state period can be a MULTIPLE of the audible one, when something the
//     ear does not follow alternates between passes (a pulse width, a filter
//     value on a silent voice);
//   - the state intro can be LONGER than the audible one, when the first pass
//     starts from init values and later passes carry state over from the loop's
//     end - Axel F (6R6) spends its first 18 s with voice 2's pulse width on a
//     different phase and nothing else, and sounds identical throughout.
//
// So the audio pass still decides. What this buys it is the answer's SHAPE in
// advance: the audible period divides the state period, and the audible intro
// ends no later than the state one, so the render needs intro + one period + a
// confirm window rather than three passes of the loop, and detectLoop tests a
// handful of divisors at one known lag rather than every lag against the tail
// (loop-detect.js, detectLoop's `hint`). A tune whose audio does not
// repeat where its state does - a player reading a timer the analyser does not
// model, say - fails that check and gets the full audio search as before.
//
// Nothing here is trusted on its own: a state loop that the audio does not
// confirm is discarded, and a tune this cannot drive (an init that never
// returns, a BASIC tune, a play routine that runs past the cycle cap) simply
// reports null and costs the audio pass nothing.

import { parseSidHeader } from './psid.js';
import { PLAY_CYCLE_CAP, makeAnalyserApi, startTune } from './analyser-session.js';

// Version of the state loops this finds. It is part of the key scan results
// are cached under (analysis-store.js, via ANALYSIS_VERSION in
// spectrometer-bake-core.js), so bump it whenever a change here or in
// analyser-session.js moves what findStateLoop answers;
// scripts/test-analysis-version.js fails until it is bumped.
export const PREPASS_VERSION = 1;

// Load the tune into the analyser's RAM, run init for `subtune`, and fingerprint
// `maxFrames` worth of play calls: one FNV-1a hash per call over the addresses
// written, in order, and the value each one holds when the call returns.
// Registers a call does not touch are carried by the calls before it, so a
// sequence of these hashes repeats exactly when the player's output repeats.
//
// Returns { hashes, calls, callsPerFrame, framesPerCall } or null when the tune
// cannot be driven this way. framesPerCall is exact for a vsync tune (1) and for
// a CIA-timed one is the timer's share of a frame, so a period in calls converts
// to raster frames without assuming the timer divides the frame evenly.
export function fingerprintTune(module, sidBytes, { subtune = 0, maxFrames, isNtsc = false } = {}) {
    const h = parseSidHeader(sidBytes);
    if (!h || h.isBasic) return null;
    const api = makeAnalyserApi(module);
    const { play, callsPerFrame, framesPerCall } = startTune(module, api, sidBytes, h, { subtune, isNtsc });
    if (!play) return null;

    const maxCalls = Math.max(1, Math.floor(maxFrames / framesPerCall));
    const hashes = new Uint32Array(maxCalls);
    let calls = 0;
    for (; calls < maxCalls; calls++) {
        api.record(1);
        if (!play(PLAY_CYCLE_CAP)) return null;
        let x = 0x811c9dc5;
        const len = api.seqLen();
        for (let i = 0; i < len; i++) {
            const addr = api.seqItem(i);
            x ^= addr; x = Math.imul(x, 0x01000193);
            // The master volume nibble is left out: a player that fades at the
            // end of its loop tends to carry the fade counter into the next
            // pass, so $D418 comes round one step different every time and the
            // state never repeats at all (Blue_Earth_Turned_into_Grey, Elysoun)
            // although the music does. A level that genuinely differs between
            // passes still fails the audio check, which is what decides.
            const mask = (addr & 0x1f) === 0x18 ? 0xf0 : 0xff;
            x ^= api.rd(addr) & mask; x = Math.imul(x, 0x01000193);
        }
        hashes[calls] = x >>> 0;
    }
    return { hashes, calls, callsPerFrame, framesPerCall };
}

// The earliest point from which a sequence repeats, and the period it repeats
// with: the smallest I such that h[i] === h[i + P] for every i in [I, n - P), for
// some P >= minPeriod, where the repeat is seen over at least two full periods
// plus `confirm` more entries. Among periods that repeat from the same I the
// smallest wins, which is the fundamental: any other period of the same suffix
// is a multiple of it.
//
// Picking the earliest repeat rather than the shortest period is what keeps a
// phrase played three or four times in a row at the END of the scanned span
// from being reported as the loop - the true period explains the stream from
// the intro on, and a riff only explains its last few passes.
//
// Done in one pass with the prefix function of the reversed stream: the
// longest border of the suffix h[n-L..n) gives that suffix's smallest period
// directly, and every other period it has over that length is a multiple of
// it (Fine and Wilf), so each candidate intro costs O(1) after the O(n) table.
// Testing every lag against the tail instead is quadratic where it matters
// most - a player that has stopped and idles on identical frames matches at
// every lag - and a multispeed tune has up to 16 entries per frame.
export function findStatePeriod(hashes, n, minPeriod, confirm) {
    const minP = Math.max(1, minPeriod);
    if (n < 2 * minP + confirm) return null;
    // pi[j]: longest proper border of R[0..j], R being the stream reversed, i.e.
    // of the suffix h[n-1-j..n). Its smallest period is (j + 1) - pi[j].
    const pi = new Int32Array(n);
    for (let j = 1, k = 0; j < n; j++) {
        const c = hashes[n - 1 - j];
        while (k > 0 && c !== hashes[n - 1 - k]) k = pi[k - 1];
        if (c === hashes[n - 1 - k]) k++;
        pi[j] = k;
    }
    for (let L = n; L >= 2 * minP + confirm; L--) {
        const p = L - pi[L - 1];
        const P = p * Math.ceil(minP / p);
        if (2 * P + confirm <= L) return { period: P, intro: n - L };
    }
    return null;
}

// Run the pre-pass for one tune. Returns { introFrames, periodFrames, callsPerFrame,
// scannedFrames } - the state loop in raster frames - or null when no state loop
// is seen inside `maxFrames` (two passes plus `confirmFrames` have to fit) or the
// tune cannot be driven. `module` is an initialised sidquake.wasm instance; the
// analyser CPU it uses is separate from that module's audio engine.
export function findStateLoop(module, sidBytes, {
    subtune = 0, maxFrames, isNtsc = false, minLoopFrames = 100, confirmFrames = 200,
} = {}) {
    const fp = fingerprintTune(module, sidBytes, { subtune, maxFrames, isNtsc });
    if (!fp) return null;
    const toCalls = (frames) => Math.max(1, Math.round(frames / fp.framesPerCall));
    const found = findStatePeriod(fp.hashes, fp.calls, toCalls(minLoopFrames), toCalls(confirmFrames));
    if (!found) return null;
    return {
        introFrames: Math.round(found.intro * fp.framesPerCall),
        periodFrames: Math.max(1, Math.round(found.period * fp.framesPerCall)),
        callsPerFrame: fp.callsPerFrame,
        scannedFrames: Math.round(fp.calls * fp.framesPerCall),
    };
}
