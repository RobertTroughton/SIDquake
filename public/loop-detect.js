// loop-detect.js - where a baked spectrometer stream repeats, or where its
// music ends. detectLoop finds the loop on a quantized column grid;
// resolveKeyframes runs it on a row store and cuts the keyframes the bake
// stores to intro + one loop, or to the end of the music. The full bake and
// the lightweight analysis (spectrometer-bake.js) both go through
// resolveKeyframes, so the loop and length the UI shows are what an export
// stores.

import { whitenQuantize } from './bake-dsp.js';

// Detect a repeating loop in the quantized keyframe matrix. SID tunes replay
// deterministically, so once the audio loops the columns become exactly
// periodic. Returns { loopStart, loopEnd } (keyframes [0,loopEnd) are stored,
// and playback wraps loopEnd -> loopStart), or null if no confident loop is
// found (caller then stores everything and wraps to 0). This lets a long tune
// with, say, a 30 s intro + a repeating body store just intro+one body cycle.
//
// The period MUST equal the tune's true musical loop: the C64 wraps the bars at
// exactly this period while the music player loops at its own, so any mismatch
// makes the bars drift out of sync (a period half the true loop, say, cycles the
// bars twice as fast - seconds of drift within one musical loop). Two failure
// modes have to be avoided: (1) locking a SUB-HARMONIC - a riff shorter than the
// full loop that recurs on its own; (2) accepting a MARGINAL near-threshold
// match that only holds for a few seconds. Confirming a candidate against just
// the tail (the old approach) let both through, so we validate every candidate
// lag against the whole stream and take the fundamental of the deepest.
// `kf` is a quantized column matrix on ANY uniform time grid with `keyframeHz`
// rows per second; callers now pass the full FRAME-rate grid (see resolveKeyframes:
// SID loop periods are integral in frames, not keyframes) and map the result back.
//
// `hint`, when given, is the STATE loop the register pre-pass found for this tune
// (loop-prepass.js): { intro, period } in rows of this grid, exact. The player's
// writes repeat from `intro` every `period`, so the audible loop can only be a
// divisor of that period starting no later than that intro, and the search
// collapses to: does the audio agree at that one lag, which divisor is the
// fundamental to the ear, and where does the audible intro end. This needs only
// intro + period + the confirm window of audio rather than two full passes, which
// is what lets the render stop that much sooner. A hint the audio does not bear
// out returns null, and the caller falls back to the full search.
export function detectLoop(kf, nk, numBars, maxHeight, keyframeHz = 25, minLoopSeconds = 2, hint = null) {
    // Windows are wall-clock spans, scaled to the grid rate so the detector
    // behaves the same at any rows-per-second (at 25 Hz these are the original 100/50/12).
    const W = Math.max(8, Math.round(4.0 * keyframeHz));    // tail confirm window (~4 s)
    // Shortest loop we accept (~minLoopSeconds, an Advanced setting): a smaller
    // value lets tight riffs count as the loop, a larger one forces a longer
    // musical phrase before we call the tune repeated.
    const Pmin = Math.max(4, Math.round(minLoopSeconds * keyframeHz));
    const NOTE = Math.max(2, Math.round(0.48 * keyframeHz));// ~held-note span; plateau off-by-one refine
    if (!hint && nk < 2 * W + Pmin + 10) return null;

    // Tolerant match: SID's noise LFSR means audio isn't byte-identical across
    // loops even though the tune is deterministic, so compare on average
    // absolute bar difference, not equality.
    const MATCH = Math.max(1.0, maxHeight * 0.03);   // avg |Δ|/bar counted as "same"
    const REJECT = maxHeight * 0.18;                 // clearly different
    const colDiff = (i, j) => {
        let s = 0; const a = i * numBars, c = j * numBars;
        for (let b = 0; b < numBars; b++) s += Math.abs(kf[a + b] - kf[c + b]);
        return s / numBars;
    };
    const bail = MATCH * W;   // partial sums only grow, so past this the mean can't return under MATCH
    const winDiff = (i, j) => {                       // mean over a W-column window
        let s = 0;
        for (let x = 0; x < W; x++) {
            s += colDiff(i + x, j + x);
            // Early exit: the tail scan only cares whether the mean is <= MATCH, and
            // a wrong lag blows the budget within a few columns - returning the
            // partial mean (already > MATCH, and <= the true mean) keeps the verdict
            // identical while cutting the scan's cost several-fold.
            if (s > bail) return s / W;
        }
        return s / W;
    };

    // Require the confirm window to carry real signal (don't "loop" on silence).
    const tail = nk - W;
    let energy = 0;
    for (let x = 0; x < W; x++) for (let b = 0; b < numBars; b++) energy += kf[(tail + x) * numBars + b];
    if (energy / (W * numBars) < maxHeight * 0.06) return null;

    // Loop start = the end of the intro, i.e. the last point where the stream
    // genuinely differs from itself one period later.
    //
    // Judged over a WINDOW rather than a single column. Taking the last lone
    // column above REJECT made the whole intro hostage to one transient: on
    // The_Mighty_Bulldozer/Wonderful_Tunes_and_Graphics_tune_7, exactly 4 columns
    // of 15,180 crossed the threshold - two of them adjacent, everything either
    // side reading ~0 - and that one blip reported a 220 s intro on a tune that
    // loops from the very first frame, doubling its measured length.
    //
    // What separates the two cases is the DENSITY of mismatch nearby, not how many
    // columns in a row cross the line. Measured over the same ~4 s window used to
    // confirm the period, of the 200 columns below the decision point:
    //   the spurious 220 s intro above had 1 mismatching  (0.5%)
    //   a genuine 4 s intro (6r6-selfiesfromtheex) had 43 (21.5%)
    // so a 10% floor separates them by an order of magnitude either way. Requiring
    // a consecutive RUN instead would fail that real intro, whose columns hover
    // either side of REJECT rather than all clearing it.
    const introNeed = Math.max(4, Math.round(W * 0.10));
    const introFor = (P) => {
        const nDiff = nk - P;
        if (nDiff <= 0) return 0;
        const over = new Uint8Array(nDiff);           // 1 = this column clearly differs
        for (let i = 0; i < nDiff; i++) over[i] = colDiff(i, i + P) > REJECT ? 1 : 0;
        let run = 0;                                  // columns over REJECT in [i, i+W)
        for (let i = nDiff - 1; i >= 0; i--) {
            run += over[i];
            if (i + W < nDiff) run -= over[i + W];
            if (run >= introNeed) {
                // The intro ends at the LAST column that actually differs, not at
                // the window edge - otherwise every intro would be reported up to
                // 4 s long.
                const hi = Math.min(nDiff, i + W);
                for (let j = hi - 1; j >= i; j--) if (over[j]) return j + 1;
                return 0;
            }
        }
        return 0;
    };

    if (hint) {
        let HP = Math.round(hint.period);
        const HI = Math.max(0, Math.round(hint.intro));
        if (HP < Pmin || nk - HI - HP < W) return null;
        // A player that has finished often idles in a short cycle that is not
        // quite silent (Elder_Scrollers ticks over every 2 s after 5 minutes of
        // music). That is a state loop, but not the tune's: a loop far quieter
        // than everything before it is an ending, and the fade path's business.
        if (HI >= W) {
            const mean = (from, to) => {
                let s = 0;
                for (let i = from * numBars; i < to * numBars; i++) s += kf[i];
                return s / ((to - from) * numBars);
            };
            if (mean(HI, HI + HP) < mean(0, HI) * 0.25) return null;
        }
        // Mean per-bar diff at lag P over the stretch the state loop covers,
        // [HI, nk) - the only part of the stream that can be expected to repeat.
        const span = (P) => {
            let s = 0, n = 0;
            for (let i = HI + P; i < nk; i++) { s += colDiff(i, i - P); n++; }
            return n ? s / n : Infinity;
        };
        // A frame either side: a multispeed period is converted through the CIA
        // timer and can land a frame off the audio grid. The hinted lag keeps
        // ties, so an exact vsync period is never nudged by noise.
        let best = span(HP);
        for (const d of [-1, 1, -2, 2]) {
            const q = HP + d;
            if (q < Pmin || nk - HI - q < W) continue;
            const v = span(q);
            if (v < best) { best = v; HP = q; }
        }
        if (best > MATCH) return null;
        // The fundamental to the ear: the smallest divisor of the state period
        // the audio repeats at too. Something inaudible alternating between
        // passes doubles the state period without doubling the music.
        let P = HP;
        for (let d = Pmin; d < HP; d++) {
            if (HP % d === 0 && span(d) <= MATCH) { P = d; break; }
        }
        // The audible intro can end before the state one (a first pass that
        // differs only in something the ear does not follow), never after it.
        const I = Math.min(HI, introFor(P));
        if (nk - P - I < W) return null;
        return { loopStart: I, loopEnd: I + P };
    }

    // Full-stream self-similarity at lag P: mean per-bar diff over the WHOLE
    // stream. A long render holds many loops, so the intro barely dents the mean
    // and the true period sits at the deepest minimum. A sub-harmonic is elevated
    // because its melody advances across the shorter period even where the
    // accompaniment repeats. `refine` re-locks a period to its exact local
    // minimum, undoing the off-by-one that held-note plateaus give the tail scan.
    // Ranking candidates and re-locking one only need the SHAPE of that curve, so
    // both sample it every STRIDE columns; the accept test below is always exact.
    const Pmax = Math.floor(nk / 2);                  // need >=2 periods to confirm
    const STRIDE = Math.max(1, Math.min(4, Math.round(nk / 4000)));
    const residual = (P, stride = 1) => { let s = 0, n = 0; for (let i = P; i < nk; i += stride) { s += colDiff(i, i - P); n++; } return s / n; };
    const refine = (P) => {
        let bp = P, bv = residual(P, STRIDE);
        for (let d = -(NOTE - 1); d <= NOTE - 1; d++) {
            const q = P + d; if (q < Pmin || q >= nk) continue;
            const v = residual(q, STRIDE); if (v < bv) { bv = v; bp = q; }
        }
        return bp;
    };

    // Candidate periods: EVERY lag whose last ~4 s recur one period earlier, not
    // just the first one found. Taking the first (the old approach) assumed it was
    // either the loop or a sub-harmonic of it, so walking its harmonic series would
    // reach the truth. A decoy lag breaks that assumption outright: Miranda
    // (Mitch & Dane) repeats a phrase 38.3 s before its tail, and 38.3 s neither
    // divides nor is divided by its real 71.8 s loop, so the walk had nowhere to go
    // and a 20-minute scan reported no loop at all. Matching lags come in blocks, so
    // skip a note's width past each hit rather than logging the same period twice.
    const CAND_MAX = 48;
    const cands = [];
    for (let c = Pmin; c <= Pmax && cands.length < CAND_MAX; c++) {
        if (winDiff(tail, tail - c) <= MATCH) { cands.push(c); c += NOTE; }
    }
    if (!cands.length) return null;

    // The deepest residual among them is the tune's period; among near-ties take
    // the smallest, which is the fundamental of the series rather than a multiple
    // of it (storing a multiple would hold minutes of duplicate stream).
    const rr = cands.map((c) => residual(c, STRIDE));
    let deepest = Infinity;
    for (const r of rr) if (r < deepest) deepest = r;
    const band = deepest + Math.max(0.6, maxHeight * 0.008);   // "near the deepest"
    let P = cands[cands.length - 1];
    for (let k = 0; k < cands.length; k++) { if (rr[k] <= band) { P = cands[k]; break; } }
    P = refine(P);

    // Confirm the chosen period against the whole stream, not just the tail: a
    // genuine loop matches everywhere (bar the small intro). This rejects the
    // marginal tail-only matches the old check let through - better a safe "no
    // loop" (store the full stream) than a wrong period the C64 wraps out of sync.
    if (residual(P) > MATCH) return null;

    const I = introFor(P);
    if (nk - P - I < W) return null;                  // need a full confirmed cycle
    return { loopStart: I, loopEnd: I + P };
}

// Shared front half: decimate the per-frame targets to keyframes and resolve the
// loop (trim to intro+one cycle) or the fade-off (cap + trailing zeros to loop on).
// Both the full bake and the lightweight analysis (analyzeRows) run this - the loop /
// length figures the UI shows must match what an export actually stores. Returns
// { kf, nk, step, loopStart, looped, fadedOut, truncated, analyzedKeyframes }.
//
// `out`, when given, is the row store the STORED bars come from (the per-song
// range derived by outputStore); every decision - the loop, where the music
// ends, whether it was cut - is still made on `store`, the fixed grid the
// analysis measured on, so fitting the range can never move a tune's loop or
// length away from what the UI showed. Both stores hold the same frames.
export function resolveKeyframes(store, o, out = store) {
    const nframes = store.count;
    // decimate frameHz -> keyframeHz, whiten and quantize to 0..maxHeight
    const step = Math.max(1, Math.round(o.frameHz / o.keyframeHz));
    let nk = Math.floor(nframes / step);
    let kf = whitenQuantize(out, o.maxHeight, step, nk);
    // The fixed grid at keyframe rate, for the fade decisions below.
    const kfD = out === store ? kf : whitenQuantize(store, o.maxHeight, step, nk);

    // Trim redundant loop repeats: store intro + one cycle, wrap to loopStart.
    const analyzedKeyframes = nk;   // keyframes analysed before any loop trim
    let loopStart = 0;
    let lastKeyframeFrames = step;  // raster frames the stream's last keyframe lasts on the C64
    let fadedOut = false;
    let truncated = false;          // still playing where the stream had to stop
    let forcedLoop = false;         // fade path only: stream rewired to wrap to keyframe 0
    // Loop detection runs at FRAME resolution, never on the keyframe grid: SID
    // players advance on the frame interrupt, so a tune's period is always an
    // integer number of frames - but only sometimes of keyframes. A loop of an
    // odd frame count is a half-integer of 25 fps keyframes, so on the keyframe
    // grid every cycle-vs-cycle comparison is blurred by half a keyframe (~20 ms)
    // and a busy tune misses the match threshold everywhere (steel-DespaSIDo:
    // residual 4.1 on the keyframe grid vs 2.0 at frame resolution). The frame-
    // exact period is stored as ceil(P / step) keyframes with the last one
    // shortened to whatever is left (lastKeyframeFrames, 1..step), so the C64's
    // stored cycle lasts exactly P frames. Rounding it to whole keyframes instead
    // moved the bars against the music on every pass, and the error adds up:
    // a 101-frame loop at 25 fps was ~6 s out after ten minutes.
    const kfF = step === 1 ? kf : whitenQuantize(store, o.maxHeight, 1, nframes);
    const nkF = step === 1 ? nk : nframes;
    // o.loopHint: the state loop the register pre-pass found for these rows, in
    // frames. The render was stopped on it, so the rows hold intro + one period
    // + a confirm window rather than the two passes the unhinted search needs.
    const loop = detectLoop(kfF, nkF, o.numBars, o.maxHeight, o.frameHz, o.minLoopSeconds, o.loopHint || null);
    // Frame-exact loop bounds, kept alongside the keyframe-rounded ones. The C64
    // stream only needs the keyframe grid, but the song-length tool
    // (tools/songlengths) wants the raster-frame counts the detector actually found,
    // because a SID player's period is an integer number of frames and rounding it
    // onto the keyframe grid throws away up to half a keyframe per cycle.
    let loopStartFrames = 0, loopEndFrames = 0, musicEndFrames = 0;
    if (loop) {
        loopStartFrames = loop.loopStart;
        loopEndFrames = loop.loopEnd;
        loopStart = Math.min(nk - 1, Math.round(loop.loopStart / step));
        const P = loop.loopEnd - loop.loopStart;
        const periodK = Math.max(1, Math.ceil(P / step));
        if (loopStart + periodK <= nk) lastKeyframeFrames = P - (periodK - 1) * step;
        nk = Math.min(nk, loopStart + periodK);
        kf = kf.subarray(0, nk * o.numBars);
    } else {
        const NB = o.numBars;
        const silent = o.maxHeight * NB * 0.02;   // near-zero total column energy
        const budgetKf = o.budgetBytes - 256 * NB;
        // o.measureOnly: nothing is being stored, so neither the stored-length
        // choice nor the C64 RAM budget has any say in how far the music is
        // followed. Capping a MEASUREMENT with them reported a tune that plays
        // past the cap as ending exactly there.
        const capKf = o.measureOnly ? nk : Math.max(1, Math.min(
            Math.floor((o.outputMaxSeconds || o.maxSeconds) * o.keyframeHz), budgetKf));
        const lastKf = Math.min(nk, capKf);
        let musicEnd = lastKf;
        while (musicEnd > 0) {
            let e = 0; const off = (musicEnd - 1) * NB;
            for (let b = 0; b < NB; b++) e += kfD[off + b];
            if (e > silent) break;
            musicEnd--;
        }
        // Trailing silence means the tune really ended. Music still playing at the
        // last keyframe we can hold means it was CUT there - the render ran out of
        // window, or the stream ran out of RAM. That is not an ending, and calling
        // it one puts a made-up length on the C64 clock and offers a loop back to a
        // point the tune never reaches.
        truncated = musicEnd > 0 && musicEnd === lastKf;
        // Forced song loop (o.forceLoop, chosen by the user for fade-out tunes):
        // keep ~1 s of silent tail so the fade can breathe, then wrap the WHOLE
        // stream back to keyframe 0 - the C64 player restarts the music on that
        // wrap, so audio and bars restart together. Default (no force): hold
        // ~0.3 s of zeros and loop on them, so the bars just fade off and stay dark.
        forcedLoop = !!o.forceLoop && musicEnd > 0 && !truncated;
        const HOLD = forcedLoop ? Math.max(8, Math.round(o.keyframeHz)) : 8;
        nk = musicEnd + HOLD;
        const faded = new Uint8Array(nk * NB);     // keyframes past musicEnd stay zero
        faded.set(kf.subarray(0, musicEnd * NB));
        kf = faded;
        loopStart = forcedLoop ? 0 : musicEnd;     // forced: restart at the top; else fade off
        fadedOut = !truncated;
        // Frame-exact end of the music, found on the frame grid rather than by
        // scaling musicEnd back up - same reason as the loop bounds above.
        musicEndFrames = Math.min(nkF, musicEnd * step + step);
        while (musicEndFrames > 0) {
            let e = 0; const off = (musicEndFrames - 1) * NB;
            for (let b = 0; b < NB; b++) e += kfF[off + b];
            if (e > silent) break;
            musicEndFrames--;
        }
    }
    return {
        kf, nk, step, loopStart, lastKeyframeFrames, looped: !!loop, fadedOut, truncated, forcedLoop, analyzedKeyframes,
        loopStartFrames, loopEndFrames, musicEndFrames,
    };
}
