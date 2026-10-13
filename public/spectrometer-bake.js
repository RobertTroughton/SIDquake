// spectrometer-bake.js - precompute a compressed FFT-spectrometer bar-height
// stream for a tune, to be baked into an exported PRG and replayed on the C64.
//
// The C64 RaistlinBars player normally derives its 40 bars live from SID
// register writes (SIDPlayers/INC/spectrometer.asm, AnalyzeSIDRegisters). This
// module instead precomputes the *real* FFT bar heights - the same spectrum the
// HVSC browser visualizer shows (public/hvsc-visualizer.js) - and compresses
// them with Vector Quantization so the C64 can just replay them:
//
//   codebook[K][NUM_BARS]  : K prototype "column shapes", one byte per bar (0..maxHeight)
//   indices[segments][numKeyframes] : one byte per keyframe (every 1, 2 or 3
//                            raster frames, framesPerKeyframe) per segment,
//                            stored PLANAR (all of segment 0's indices, then all
//                            of segment 1's, ...) - see bakeFromStore
//
// On the C64, every keyframe reads one index byte per segment, points at that
// segment's codebook entries, and copies them into the "next" column; the
// player interpolates linearly from the current column to it over the raster
// frames in between (TickBakedFrame), and its UpdateBars attack/decay follows
// that moving target.
//
// Pure JS, no DOM/Node dependencies: bakeSpectrometer() takes mono PCM and
// returns the packed bytes, so it runs identically in the browser export path
// and in a Node test harness.
//
// The analysis lives in bake-dsp.js (FFT, bands, whitening, range fit) and the
// loop and song-end decisions in loop-detect.js. This module is the vector
// quantization, the packing and the C64 stream format (chooseSegments,
// estimateBakeBytes, tweenColumn), and the entry points the rest of the app
// imports.

import {
    F_MIN, F_MAX, FIT_MIN, FIT_MAX, FIT_MIN_OCTAVES,
    fft, computeBands, barValue, analysisSources, computeFineBands, createFineStore, fitRange, deriveBars,
    createRowStore, asRowStore, bandRefs, createFftAnalyzer, whitenQuantize, whitenRows,
    computeRowStore, computeTargets, outputStore,
} from './bake-dsp.js';
import { detectLoop, resolveKeyframes } from './loop-detect.js';

// DEFAULTS under the caller's options, leaving out any the caller passed as
// undefined: callers forward option fields one by one, and an undefined
// maxHeight that beat the default quantised every bar to NaN.
function withDefaults(options) {
    const o = { ...DEFAULTS };
    for (const k in options) if (options[k] !== undefined) o[k] = options[k];
    return o;
}

// Entries per segment codebook: the index is one byte, and the codebook is stored
// as one 256-byte page per bar.
const CODEBOOK_ENTRIES = 256;

const DEFAULTS = {
    numBars: 40,          // RaistlinBars NUM_FREQUENCY_BARS
    maxHeight: 111,       // RaistlinBars MAX_BAR_HEIGHT (0..111, one byte, no runtime scaling)
    fMin: F_MIN, fMax: F_MAX,  // bar frequency span (Hz) of the fixed grid
    fitRange: true,       // fit the stored bars' span to the tune (see FIT_MIN)
    keyframeHz: 25,       // bake keyframe rate; the C64 interpolates between keyframes
    framesPerKeyframe: 2, // 1/2/3 raster frames per keyframe -> 50/25/16.66 Hz; keyframeHz = frameHz/this
    frameHz: 50,          // PAL analysis rate
    maxSeconds: 1200,     // analysis cap (~20 min): supports 10 min tunes (loop needs 2 passes); render stops early on a loop or long silence
    minLoopSeconds: 2,    // shortest repeat we accept as a loop; rejects sub-second riffs
    outputMaxSeconds: 600, // if no loop is found, store at most this many seconds of bars, then fade off
    // split VQ: prefer 5 independently-quantized groups (numBars/5 = 8 bars each), but
    // the exporter drops to fewer segments for long non-looping tunes so they still
    // animate all the way through (fewer segments = fewer index bytes/keyframe). Only
    // divisors of numBars are valid; listed largest (best) first.
    segmentChoices: [5, 4, 2, 1],
    budgetBytes: 28672,   // RAM cap: fixed codebook (256*numBars) + index (segments bytes/keyframe)
    kmeansIters: 30,
    seed: 0x9e3779b9,
    // Height grid the codebook is stored on. The codebook is 10 KB of VQ centroids
    // and is the least compressible part of an export - TSCrunch actually EXPANDS
    // it. Storing the prototypes on a coarser grid gives the cruncher repeated
    // values to match: at step 2 the codebook packs ~4% smaller under TSCrunch and
    // ~15% under Exomizer. The cost is bounded by +/-1 on a 0..111 scale (one pixel
    // of a 112-pixel bar), against a VQ error that is already 2-4 units - and
    // because k-means assigns its final labels against the snapped prototypes, the
    // real added error is smaller than that bound. 1 = off.
    codebookStep: 2,
};

// Choose the split-VQ segment count from the keyframe count the stream will
// actually hold at the chosen rate: the most segments whose index fits the RAM
// budget next to the fixed codebook. A lower frame rate stores fewer keyframes,
// so it buys back spectral detail - a two-minute loop that only fits 2x20 at
// 50 fps gets the full 5x8 split at 25 fps. The memory readout is therefore not
// monotonic in fps; since the C64 interpolates between keyframes, 25 fps already
// animates smoothly, and the detail is worth more than a monotonic readout.
function chooseSegments(o, keyframes) {
    const codebookBytes = CODEBOOK_ENTRIES * o.numBars;   // fixed regardless of segment count
    for (const cand of o.segmentChoices) {
        if (o.numBars % cand === 0 && codebookBytes + cand * keyframes <= o.budgetBytes) return cand;
    }
    return 1;
}

// Yield to the event loop so a progress bar can repaint mid-bake (the bake runs
// on the main thread and is CPU-heavy).
//
// We schedule the continuation through a MessageChannel rather than
// setTimeout(0). Chrome (and other browsers) throttle timers in hidden/
// background tabs: setTimeout is clamped to >=1 s, and after ~5 minutes hidden
// it drops to "intensive throttling" - roughly once per minute. A bake that
// yields via setTimeout therefore crawls to a near-halt the moment the user
// switches to another TAB (which sets document.hidden), even though switching to
// another window/app leaves the tab visible and running at full speed. Postponing
// a message is a task, not a timer, so it escapes that throttling and the bake
// keeps running full-speed in a background tab. Falls back to setTimeout where
// MessageChannel is unavailable.
export const yieldToEventLoop = (() => {
    if (typeof MessageChannel === 'undefined') {
        return () => new Promise(r => setTimeout(r, 0));
    }
    // Node has no background tabs to be throttled in, and an open MessagePort
    // there keeps the process alive after the last render has finished, so
    // every script that imports this module has to process.exit() by hand.
    if (typeof window === 'undefined' && typeof setImmediate === 'function') {
        return () => new Promise(r => setImmediate(r));
    }
    const channel = new MessageChannel();
    const queue = [];
    channel.port1.onmessage = () => { const resolve = queue.shift(); if (resolve) resolve(); };
    return () => new Promise(resolve => { queue.push(resolve); channel.port2.postMessage(0); });
})();
const microYield = yieldToEventLoop;

// deterministic PRNG so exports are reproducible (kmeans++ seeding)
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// k-means on rows of `data` (Uint8Array, numRows x dim). Returns {codebook Uint8Array(K*dim), labels Uint8Array(numRows)}.
// `snap`, if given, maps each finished centroid value onto the coarser grid the
// codebook is stored on (see codebookStep). It is applied BEFORE the final label
// assignment, so every keyframe is matched against the prototypes that actually
// ship - the quantization then costs far less error than snapping afterwards.
async function kmeans(data, numRows, dim, K, iters, seed, onTick, snap) {
    const rng = mulberry32(seed);
    const cent = new Float64Array(K * dim);
    // k-means++ init
    const first = Math.floor(rng() * numRows);
    for (let d = 0; d < dim; d++) cent[d] = data[first * dim + d];
    const dist = new Float64Array(numRows).fill(Infinity);
    for (let c = 1; c < K; c++) {
        let total = 0;
        for (let r = 0; r < numRows; r++) {
            let dd = 0;
            for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - cent[(c - 1) * dim + d]; dd += df * df; }
            if (dd < dist[r]) dist[r] = dd;
            total += dist[r];
        }
        let pick = rng() * total, idx = 0;
        for (; idx < numRows; idx++) { pick -= dist[idx]; if (pick <= 0) break; }
        if (idx >= numRows) idx = numRows - 1;
        for (let d = 0; d < dim; d++) cent[c * dim + d] = data[idx * dim + d];
    }

    const labels = new Uint8Array(numRows);
    const sums = new Float64Array(K * dim);
    const counts = new Int32Array(K);
    for (let it = 0; it < iters; it++) {
        if (onTick) await onTick(it / iters);
        sums.fill(0); counts.fill(0);
        let changed = it === 0;
        for (let r = 0; r < numRows; r++) {
            let best = 0, bestD = Infinity;
            for (let c = 0; c < K; c++) {
                let dd = 0;
                for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - cent[c * dim + d]; dd += df * df; if (dd >= bestD) break; }
                if (dd < bestD) { bestD = dd; best = c; }
            }
            if (labels[r] !== best) changed = true;
            labels[r] = best; counts[best]++;
            const off = best * dim, ro = r * dim;
            for (let d = 0; d < dim; d++) sums[off + d] += data[ro + d];
        }
        let emptied = false;
        for (let c = 0; c < K; c++) {
            if (counts[c] === 0) { // reseed empty cluster on a random row
                emptied = true;
                const r = Math.floor(rng() * numRows);
                for (let d = 0; d < dim; d++) cent[c * dim + d] = data[r * dim + d];
            } else {
                for (let d = 0; d < dim; d++) cent[c * dim + d] = sums[c * dim + d] / counts[c];
            }
        }
        // Same labels as the last pass and no reseed: the means just computed
        // are the ones this pass started from, bit for bit, so every remaining
        // pass would repeat this one exactly.
        if (!changed && !emptied) break;
    }
    const codebook = new Uint8Array(K * dim);
    for (let i = 0; i < K * dim; i++) {
        const v = Math.max(0, Math.min(255, Math.round(cent[i])));
        codebook[i] = snap ? snap(v) : v;
    }
    // final label assignment against the quantized codebook
    for (let r = 0; r < numRows; r++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < K; c++) {
            let dd = 0;
            for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - codebook[c * dim + d]; dd += df * df; }
            if (dd < bestD) { bestD = dd; best = c; }
        }
        labels[r] = best;
    }
    return { codebook, labels };
}

// Main entry: mono PCM -> packed baked spectrometer data. See bakeFromStore for
// the returned shape. (The incremental render path uses createBakeSession instead,
// so it never buffers the whole tune; this stays for tests + the offline harness.)
export async function bakeSpectrometer(pcm, sampleRate, options = {}) {
    const o = withDefaults(options);
    // The C64 reads one keyframe every framesPerKeyframe raster frames (1, 2 or
    // 3), so the keyframe rate is the frame rate divided by that - derive it
    // rather than trusting a separate default, so an accurate (PAL/NTSC) frameHz
    // carries through to the grid and the stored timing.
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const prog = o.onProgress || (() => {});
    const maxSamples = Math.floor(o.maxSeconds * sampleRate);
    const hitCap = pcm.length >= maxSamples;
    if (pcm.length > maxSamples) pcm = pcm.subarray ? pcm.subarray(0, maxSamples) : pcm.slice(0, maxSamples);

    const store = await computeRowStore(pcm, sampleRate, o.numBars, o.frameHz,
        async (f) => { prog('Analyzing spectrum', f); await microYield(); }, o.fMin, o.fMax);
    return bakeFromStore(store, o, pcm.length / sampleRate, hitCap, prog);
}

// Incremental bake session: feed rendered PCM chunks, poll tryLoop() to stop the
// render early, then finalize(). The FFT runs once (streaming), only ~6 MB of
// per-frame rows are kept (never the whole tune), and whitening/detection reuse
// those rows - so this is what the live export drives.
export function createBakeSession(sampleRate, options = {}) {
    const o = withDefaults(options);
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const an = createFftAnalyzer(sampleRate, o.numBars, o.frameHz, o.fMin, o.fMax);
    let fedSamples = 0;
    // Scratch grid reused by every poll. It only ever grows, so after the first few
    // polls a poll allocates nothing at all, where a fresh grid per poll would be
    // ~80 allocations of several MB over a full 20-minute scan.
    let pollGrid = null;
    return {
        feed(chunk) { an.feed(chunk); fedSamples += chunk.length; },
        rows() { return an.rows; },
        fedSeconds() { return fedSamples / sampleRate; },
        // A confident loop in what's been fed so far, or null. Cheap enough to poll.
        // Detection runs at frame resolution (loop period in FRAMES) for the same
        // reason as resolveKeyframes: an odd-frame loop is invisible on the
        // keyframe grid. The caller only uses the truthiness to stop the render.
        // `hint` is the register pre-pass's state loop in frames, if it found one.
        tryLoop(hint = null) {
            const nframes = an.rows.count;
            if (nframes < 8) return null;
            pollGrid = whitenQuantize(an.rows, o.maxHeight, 1, nframes, pollGrid);
            return detectLoop(pollGrid, nframes, o.numBars, o.maxHeight, o.frameHz, o.minLoopSeconds, hint);
        },
    };
}

// Pack a final result from raw analyzer rows (createFftAnalyzer/createBakeSession).
// Kept separate so a cached row set can be re-baked at a different maxHeight (the
// rows are maxHeight-independent) without re-rendering. hitCap = the render stopped
// at the analysis cap without finding a loop.
export async function bakeRows(rows, options = {}) {
    const o = withDefaults(options);
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const store = asRowStore(rows, o.numBars);
    const analyzedSeconds = options.analyzedSeconds != null ? options.analyzedSeconds : store.count / o.frameHz;
    return bakeFromStore(store, o, analyzedSeconds, !!options.hitCap, o.onProgress || (() => {}));
}

// Lightweight analysis (#2 Analyse Tune): resolve the tune's loop / length WITHOUT
// the (expensive) vector quantization, so the UI can price the fps options fast. The
// stored duration (numKeyframes / keyframeHz) is fps-independent, so one pass at the
// default rate is enough to feed estimateBakeBytes for all three rates.
export function analyzeRows(rows, options = {}) {
    const o = withDefaults(options);
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const store = asRowStore(rows, o.numBars);
    const analyzedSeconds = options.analyzedSeconds != null ? options.analyzedSeconds : store.count / o.frameHz;
    const { nk, loopStart, lastKeyframeFrames, looped, fadedOut, truncated, analyzedKeyframes,
            loopStartFrames, loopEndFrames, musicEndFrames } = resolveKeyframes(store, o);
    // The tune's playing length in raster frames, defined the way HVSC's
    // Songlengths counts it: everything up to the point the music repeats, i.e.
    // intro PLUS one full loop (not just the loop). A tune with no detected loop
    // is measured to where the music actually stops.
    const lengthFrames = looped ? loopEndFrames : musicEndFrames;
    return {
        keyframeHz: o.keyframeHz, numKeyframes: nk, loopStart, lastKeyframeFrames, looped, fadedOut, truncated,
        analyzedKeyframes, analyzedSeconds,
        cappedAtMaxSeconds: !looped && !!options.hitCap,
        storedSeconds: nk / o.keyframeHz,
        // Frame-exact figures (see resolveKeyframes).
        loopStartFrames, loopEndFrames, musicEndFrames, lengthFrames,
        lengthSeconds: lengthFrames / o.frameHz,
        loopFrames: looped ? loopEndFrames - loopStartFrames : 0,
    };
}

// Back half of the bake: quantize the per-frame targets to keyframes, resolve the
// loop (or fade-off), vector-quantize, and pack. Returns { codebook, indices,
// numBars, maxHeight, K, keyframeHz, numKeyframes, loopStart, looped, fadedOut,
// truncated, totalBytes, reconstruct() }.
async function bakeFromStore(store, o, analyzedSeconds, hitCap, prog) {
    const range = outputStore(store, o);
    const { kf, nk, step, loopStart, lastKeyframeFrames, looped, fadedOut, truncated, forcedLoop, analyzedKeyframes } =
        resolveKeyframes(store, o, range.out);

    // --- Split (product) vector quantization -------------------------------
    // Split the numBars-wide column into `SEG` groups of `segW` bars and quantize
    // each group with its OWN 256-entry codebook + own index. Because the segments
    // are quantized (and later replayed) independently, a slowly-drifting part of the
    // spectrum keeps getting fresh indices even while another part holds - so the
    // whole column does not freeze on one shared prototype the moment the nearest
    // full-column shape stops changing. Total codebook size is unchanged
    // (SEG * 256 * segW == 256 * numBars); the index costs SEG bytes per keyframe.
    //
    // The codebook is stored TRANSPOSED (bar-major): one 256-byte page per bar,
    // holding that bar's value for all 256 codebook entries. So bar b's value for
    // entry `index` is at codebookBase + b*256 + index - a page-aligned base means the
    // C64 reads it as `lda base_b,X` (X = index) with no multiply and a consistent
    // 4-cycle access. Total is still 256*numBars bytes (numBars pages of 256).
    //
    // Pick the most segments (best spatial detail) whose codebook + index fits the RAM
    // budget for this tune's length. Looped tunes store one short cycle so they always
    // land on the full 5-way split; a long non-looping tune drops to 4/2/1 segments so
    // it animates the whole way through instead of freezing at the cap.
    const codebookBytes = CODEBOOK_ENTRIES * o.numBars;   // unused here: chooseSegments works it out itself
    const SEG = chooseSegments(o, nk);
    const segW = o.numBars / SEG;
    const SEGK = CODEBOOK_ENTRIES;                 // entries per segment (= one page per bar)
    const codebook = new Uint8Array(o.numBars * SEGK);   // numBars bar-pages of 256
    // PLANAR index: segment s owns the whole run [s*nk .. s*nk+nk-1], so its index
    // for keyframe k is at s*nk + k. Interleaving one record per keyframe put five
    // unrelated byte streams next to each other and left the PRG cruncher nothing
    // to match; keeping each segment's indices contiguous is worth ~9% of the index
    // stream (TSCrunch and Exomizer alike) for no runtime cost - the C64 decoder
    // keeps one pointer per segment instead of one striding pointer.
    const indices = new Uint8Array(SEG * nk);
    const cbStep = Math.max(1, Math.round(o.codebookStep || 1));
    const snap = cbStep > 1
        ? (v) => Math.min(o.maxHeight, Math.round(v / cbStep) * cbStep)
        : null;
    const sub = new Uint8Array(nk * segW);
    for (let s = 0; s < SEG; s++) {
        for (let k = 0; k < nk; k++)               // gather this segment's bars, nk x segW
            for (let b = 0; b < segW; b++) sub[k * segW + b] = kf[k * o.numBars + s * segW + b];
        const r = await kmeans(sub, nk, segW, SEGK, o.kmeansIters, o.seed + s * 0x9e37,
            async (f) => { prog('Compressing', (s + f) / SEG); await microYield(); }, snap);
        // Transpose r.codebook (entry-major [e*segW + lb]) into bar-major pages.
        for (let lb = 0; lb < segW; lb++) {
            const page = (s * segW + lb) * SEGK;   // global bar (s*segW+lb) -> its 256-byte page
            for (let e = 0; e < SEGK; e++) codebook[page + e] = r.codebook[e * segW + lb];
        }
        indices.set(r.labels.subarray(0, nk), s * nk);
    }
    prog('Compressing', 1);

    return {
        codebook, indices,
        numBars: o.numBars, maxHeight: o.maxHeight, K: SEGK, segments: SEG, segmentWidth: segW,
        // The span the stored bars cover (Hz), fitted to the tune unless the
        // analysis had no fine grid to fit it from.
        fMin: range.fMin, fMax: range.fMax, rangeFitted: range.fitted,
        keyframeHz: o.keyframeHz, numKeyframes: nk, loopStart,
        // raster frames per keyframe (1/2/3): the C64 cadence divisor the exporter patches
        framesPerKeyframe: Math.max(1, Math.round(o.frameHz / o.keyframeHz)),
        // raster frames the last keyframe lasts (1..framesPerKeyframe), so a looped
        // stream's cycle is exactly the tune's period: the exporter patches it too
        lastKeyframeFrames,
        // Loop / timing info for the UI: whether a repeat was detected, how many
        // keyframes were analysed before trimming, and whether the analysis hit
        // the maxSeconds cap (tune longer than we looked at).
        looped,
        fadedOut,
        truncated,
        forcedLoop,
        analyzedKeyframes,
        analyzedSeconds,
        cappedAtMaxSeconds: !looped && hitCap,
        totalBytes: codebook.length + indices.length,
        keyframesRaw: kf,
        reconstruct() {
            const out = new Uint8Array(nk * o.numBars);
            for (let k = 0; k < nk; k++)
                for (let s = 0; s < SEG; s++) {
                    const idx = indices[s * nk + k];
                    for (let lb = 0; lb < segW; lb++) {   // bar-major: value at bar-page*256 + idx
                        const b = s * segW + lb;
                        out[k * o.numBars + b] = codebook[b * SEGK + idx];
                    }
                }
            return out;
        },
    };
}

// Estimate the packed size of a bake at a chosen keyframe rate, without baking.
// Drives the fps memory display (#4): the stored duration is fps-independent, so a
// single analysis at any rate gives `durationSeconds`, and this reports what each
// rate would cost. Mirrors bakeFromStore's segment-count choice so the figure
// matches an actual export.
//   durationSeconds  : stored length (intro+loop for a looped tune, else the
//                      fade-capped length).
//   framesPerKeyframe: 1 / 2 / 3  ->  50 / 25 / 16.66 Hz keyframes at PAL 50.12.
//   frameHz          : the tune's raster rate (PAL 50.1245 / NTSC 59.826).
//   freeBytes        : optional RAM ceiling; without it only budgetBytes bounds fit.
// Returns { framesPerKeyframe, keyframeHz, keyframes, segments, codebookBytes,
//           indexBytes, bytes, fits }.
export function estimateBakeBytes(durationSeconds, options = {}) {
    const o = withDefaults(options);
    const fpk = Math.max(1, Math.round(options.framesPerKeyframe || 2));
    const keyframeHz = o.frameHz / fpk;
    const keyframes = Math.max(1, Math.round(durationSeconds * keyframeHz));
    const codebookBytes = CODEBOOK_ENTRIES * o.numBars;   // fixed regardless of segment count
    const segments = chooseSegments(o, keyframes);
    const indexBytes = segments * keyframes;
    const bytes = codebookBytes + indexBytes;
    const ceiling = options.freeBytes != null ? Math.min(o.budgetBytes, options.freeBytes) : o.budgetBytes;
    return { framesPerKeyframe: fpk, keyframeHz, keyframes, segments, codebookBytes, indexBytes, bytes, fits: bytes <= ceiling };
}

// The C64's keyframe interpolation (TickBakedFrame in INC/spectrometer.asm),
// modelled bit-exactly so a test can diff the assembled player against it.
// Between keyframe columns `cur` and `next`, raster frame f (1..d-1) of a
// d-frame keyframe shows cur + f * step, in 8.8 fixed point seeded with a half
// for rounding, where step is (next - cur) * (65536 / d) >> 8 from the table
// the player builds at init (an exact multiple, so the two's-complement
// arithmetic shift is what the 6502's 24-bit accumulate produces).
export function tweenColumn(cur, next, d, f) {
    const mult = d === 2 ? 0x8000 : d === 3 ? 0x5555 : 0;
    const out = new Uint8Array(cur.length);
    for (let b = 0; b < cur.length; b++) {
        const step = ((next[b] - cur[b]) * mult) >> 8;
        out[b] = (((cur[b] << 8) + 0x80 + f * step) >> 8) & 0xFF;
    }
    return out;
}

export const _internals = {
    fft, computeBands, computeTargets, computeRowStore, kmeans, DEFAULTS,
    whitenRows, whitenQuantize, createRowStore, asRowStore, bandRefs,
    detectLoop, resolveKeyframes, computeFineBands, createFineStore, fitRange, deriveBars,
    outputStore, barValue, analysisSources, FIT_MIN, FIT_MAX, FIT_MIN_OCTAVES,
};
