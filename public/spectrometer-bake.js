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
//   indices[segments][numKeyframes] : one byte per 25 Hz keyframe per segment,
//                            stored PLANAR (all of segment 0's indices, then all
//                            of segment 1's, ...) - see bakeFromStore
//
// On the C64, every other frame reads one index byte per segment, points at that
// segment's codebook entries, and copies them into targetBarHeights; the player's
// existing UpdateBars attack/decay animates toward that held target (which also
// serves as the 25->50 Hz interpolation).
//
// Pure JS, no DOM/Node dependencies: bakeSpectrometer() takes mono PCM and
// returns the packed bytes, so it runs identically in the browser export path
// and in a Node test harness.

// ---- constants mirrored from hvsc-visualizer.js so the bake target matches
// the on-screen spectrum exactly (the `t` value in step(), BEFORE the slow
// release smoothing - that raw target is what we hand to the C64) ----
const N = 4096;                 // fftSize (matches AnalyserNode)
const BINS = N / 2;             // frequencyBinCount
// Frequency span the bars cover. The browser visualizer uses 40..11000, but
// SID synthesis has almost no energy above ~5-6 kHz, so with only 40 bars the
// top ~8 (3.5-11 kHz) sit near-dead and the display looks left-heavy. A lower
// ceiling spreads the usable spectrum across all bars. Overridable per bake.
const F_MIN = 40, F_MAX = 5500;
const FLOOR = 0.07, SLOPE = 0.6, GAMMA = 1.5, AVG_WEIGHT = 0.65;
// MAX_DB is the level that maps to full bar height. At -12 dB, sustained SID bass
// bins clamp to the ceiling and lose all variation - the low/mid bars then pin to
// max in a flat white block. Raising it gives that loud end headroom so it varies
// instead of clipping.
const MIN_DB = -90, MAX_DB = -3, SMOOTH = 0.55;

// Peak soft-knee: below PEAK_KNEE the value is untouched; above it, it rolls off
// smoothly toward the ceiling instead of hard-clipping into a flat plateau, so a
// genuinely loud moment approaches full height without a whole row slamming to it.
const PEAK_KNEE = 0.5;
function softKnee(x) {
    if (x <= PEAK_KNEE) return x;
    return PEAK_KNEE + (1 - PEAK_KNEE) * (1 - Math.exp(-(x - PEAK_KNEE) / (1 - PEAK_KNEE)));
}

// Per-band normalization ("whitening"). Music energy falls steadily from bass to
// treble, so on the dB byte scale (with log-spaced bars) the spectrum shows as a
// near-straight ramp - tall on the left, tiny on the right - on essentially every
// tune. A fixed tilt (SLOPE above) can't flatten that for all tunes. Instead we
// normalize each band by its own "busy level" over the whole tune, so every band
// that carries signal uses the full bar height. Temporal dynamics (a band getting
// louder/quieter over time) are preserved; only the fixed frequency tilt is
// removed. Bands that are dead the whole tune stay low (gated by a global floor).
//   NORM_STRENGTH: 0 = raw spectrum (old look), 1 = full whitening (flattest)
//   NORM_PCTL    : per-band percentile used as the "busy level" reference
//   NORM_DEAD_FRAC: bands whose busy level is below this fraction of the loudest
//                   band's are treated as dead and not boosted to full height
//   NORM_HEADROOM: the band's busy level maps to THIS height, not full - so loud
//                  broadband moments sit below the top rows (matters most on the
//                  short-display players, where 85% already looks full)
const NORM_STRENGTH = 0.5, NORM_PCTL = 0.96, NORM_DEAD_FRAC = 0.18, NORM_HEADROOM = 0.72;

// Buckets in the per-band value histogram (see createRowStore). Raw row values are
// Math.pow(t, GAMMA) with t in [0,1], so the range is fixed at [0,1] and a plain
// uniform histogram is exact to +/-1/(2*HIST_BUCKETS) ~= 0.00012 - two orders of
// magnitude finer than the 1/111 step the values are eventually quantized to, so
// the percentile it reports lands on the same bar height as an exact sort.
const HIST_BUCKETS = 4096;

const DEFAULTS = {
    numBars: 40,          // RaistlinBars NUM_FREQUENCY_BARS
    maxHeight: 111,       // RaistlinBars MAX_BAR_HEIGHT (0..111, one byte, no runtime scaling)
    fMin: F_MIN, fMax: F_MAX,  // bar frequency span (Hz)
    keyframeHz: 25,       // bake keyframe rate; C64 holds/animates between keyframes
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

// Choose the split-VQ segment count from the keyframe count AT THE MAXIMUM RATE
// (50 fps / one raster frame per keyframe), NOT at the selected rate. The segment
// count then depends only on the tune's real length, so it is identical across all
// three fps options: lowering the fps only removes keyframes, never adds segments.
// That keeps the memory readout monotonic (50 > 25 > 16.66 fps) and makes the figure
// shown for an fps match exactly what an export at that fps produces. refKeyframes is
// the keyframe count at 50 fps (= keyframes-at-fps * framesPerKeyframe).
function chooseSegments(o, refKeyframes) {
    const codebookBytes = 256 * o.numBars;         // fixed regardless of segment count
    for (const cand of o.segmentChoices) {
        if (o.numBars % cand === 0 && codebookBytes + cand * refKeyframes <= o.budgetBytes) return cand;
    }
    return 1;
}

// ---------------------------------------------------------------------------
// Iterative in-place radix-2 FFT (real input -> magnitude spectrum).
// re/im are Float64Array(N). Returns nothing; results left in re/im.
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr;
                     const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = i + k + len / 2;
                const xr = re[b] * cr - im[b] * ci;
                const xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr;        im[a] += xi;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}

function blackmanWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++)
        w[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))
                    + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    return w;
}

// Per-bar FFT-bin ranges, log-spaced (as in hvsc-visualizer computeBands).
function computeBands(numBars, sampleRate, fMin = F_MIN, fMaxHz = F_MAX) {
    const nyq = sampleRate / 2;
    const binHz = nyq / BINS;
    const fMax = Math.min(fMaxHz, nyq);
    const lo = new Int32Array(numBars), hi = new Int32Array(numBars);
    for (let b = 0; b < numBars; b++) {
        const f0 = fMin * Math.pow(fMax / fMin, b / numBars);
        const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / numBars);
        let l = Math.floor(f0 / binHz), h = Math.ceil(f1 / binHz);
        l = Math.max(0, Math.min(BINS - 1, l));
        h = Math.max(l + 1, Math.min(BINS, h));
        lo[b] = l; hi[b] = h;
    }
    return { lo, hi };
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
    const channel = new MessageChannel();
    const queue = [];
    channel.port1.onmessage = () => { const resolve = queue.shift(); if (resolve) resolve(); };
    return () => new Promise(resolve => { queue.push(resolve); channel.port2.postMessage(0); });
})();
const microYield = yieldToEventLoop;

// Growable store for the analyzer's per-frame rows.
//
// The rows used to be an array of one Float64Array(numBars) per frame. A 10-minute
// analysis is ~30k frames, so that is ~30k separate little heap objects scattered
// across memory, and every later pass (whitening, quantizing) walks all of them.
// One flat, geometrically-grown Float32Array instead keeps the whole set contiguous
// and halves its footprint (9.6 MB -> 4.8 MB at 10 minutes): the values are 0..1 and
// end up quantized to 0..111, so float32's ~7 digits are far more than enough.
//
// The store also carries a per-band histogram of the raw values, updated one row at
// a time as frames arrive. That is what makes the whitening percentile cheap: see
// bandRefs(). Sorting each band's column instead (the old approach) cost
// O(numBars * n log n) AND read the column with a numBars-wide stride, i.e. a fresh
// cache line for every single element - and the incremental render repeats the whole
// thing at every loop poll, so it was quadratic in the tune's length.
function createRowStore(numBars) {
    return {
        numBars,
        count: 0,
        data: new Float32Array(numBars * 1024),
        hist: new Int32Array(numBars * HIST_BUCKETS),
        push(row) {
            const nb = this.numBars;
            if ((this.count + 1) * nb > this.data.length) {
                const grown = new Float32Array(this.data.length * 2);
                grown.set(this.data);
                this.data = grown;
            }
            const off = this.count * nb;
            for (let b = 0; b < nb; b++) {
                const v = row[b];
                this.data[off + b] = v;
                let bucket = (v * HIST_BUCKETS) | 0;
                if (bucket < 0) bucket = 0; else if (bucket >= HIST_BUCKETS) bucket = HIST_BUCKETS - 1;
                this.hist[b * HIST_BUCKETS + bucket]++;
            }
            this.count++;
        },
    };
}

// Accept either a row store or the legacy array-of-Float64Array form (the offline
// harness and the unit tests still build rows that way), so every downstream stage
// has exactly one shape to deal with.
function asRowStore(rows, numBars) {
    if (rows && rows.data instanceof Float32Array && typeof rows.count === 'number') return rows;
    const nb = numBars || (rows.length ? rows[0].length : 0);
    const store = createRowStore(nb);
    for (let i = 0; i < rows.length; i++) store.push(rows[i]);
    return store;
}

// Per-band "busy level" (the NORM_PCTL percentile of that band's values over the
// whole tune) read straight off the histogram: one pass over HIST_BUCKETS per band,
// independent of how many frames have been analysed. Returns { ref, floor }.
function bandRefs(store) {
    const nb = store.numBars, n = store.count;
    const ref = new Float64Array(nb);
    let globalRef = 0;
    for (let b = 0; b < nb; b++) {
        // Same rank the old col.sort() + index picked, resolved through cumulative
        // bucket counts; the bucket's centre stands in for the exact sample.
        const rank = Math.min(n - 1, Math.floor(n * NORM_PCTL));
        const base = b * HIST_BUCKETS;
        let cum = 0, bucket = HIST_BUCKETS - 1;
        for (let k = 0; k < HIST_BUCKETS; k++) {
            cum += store.hist[base + k];
            if (cum > rank) { bucket = k; break; }
        }
        const p = (bucket + 0.5) / HIST_BUCKETS;
        ref[b] = p;
        if (p > globalRef) globalRef = p;
    }
    return { ref, floor: globalRef * NORM_DEAD_FRAC };
}

// Stateful per-frame FFT analyzer. Feed PCM chunks as they render; it computes
// every frame whose Blackman window is fully covered, carrying the temporal-
// smoothing state across chunks so a chunked (incremental) render yields exactly
// the same frames as a single-shot pass. It keeps only the raw per-frame rows
// (0..1, pre-whitening) plus a small tail of un-consumed PCM - never the whole
// tune - so a 12-minute analysis costs ~6 MB, not ~130 MB of buffered audio.
//
// Fractional hop, rounded per frame (no accumulation): the C64 advances one
// keyframe every 2 raster frames, so the grid must sit on the true raster rate
// (PAL 50.1245 / NTSC 59.826), not a round 50 - a round-50 hop is ~0.25% slow and
// drifts the bars ~0.2 s per loop.
function createFftAnalyzer(sampleRate, numBars, frameHz, fMin, fMax) {
    const hop = sampleRate / frameHz;
    const { lo, hi } = computeBands(numBars, sampleRate, fMin, fMax);
    const win = blackmanWindow(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const smoothed = new Float64Array(BINS);
    const byteBin = new Float64Array(BINS);
    const rows = createRowStore(numBars);   // raw per-frame values (pre-whitening)
    const row = new Float64Array(numBars);  // scratch, copied into the store per frame
    let next = 0;             // index of the next frame to compute
    // PCM tail not yet consumed, held in a fixed buffer that is compacted in place.
    // Only a window's worth (N) plus at most one fed chunk is ever live, so the
    // buffer settles at a steady size instead of being reallocated and fully copied
    // on every 8 K-sample chunk (~1600 allocations per 5 minutes of audio).
    let buf = new Float32Array(N * 2);
    let len = 0;              // valid samples in buf
    let base = 0;             // global sample index of buf[0]

    const computeRow = (off) => {     // off = start of the window within buf
        for (let i = 0; i < N; i++) { re[i] = buf[off + i] * win[i]; im[i] = 0; }
        fft(re, im);
        for (let i = 0; i < BINS; i++) {
            const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;   // faster than hypot; no overflow risk here
            smoothed[i] = SMOOTH * smoothed[i] + (1 - SMOOTH) * mag;   // AnalyserNode temporal smoothing
            const db = 20 * Math.log10(smoothed[i] + 1e-12);
            const byte = (db - MIN_DB) / (MAX_DB - MIN_DB);
            byteBin[i] = byte < 0 ? 0 : byte > 1 ? 255 : byte * 255;   // getByteFrequencyData
        }
        for (let b = 0; b < numBars; b++) {
            let m = 0, sum = 0;
            for (let i = lo[b]; i < hi[b]; i++) { const v = byteBin[i]; if (v > m) m = v; sum += v; }
            const avg = sum / (hi[b] - lo[b]);
            let t = ((1 - AVG_WEIGHT) * m + AVG_WEIGHT * avg) / 255;
            t = (t - FLOOR) / (1 - FLOOR);
            if (t < 0) t = 0;
            t *= 1 + SLOPE * (b / (numBars - 1));
            if (t > 1) t = 1;
            row[b] = Math.pow(t, GAMMA);
        }
        rows.push(row);
    };

    return {
        rows,
        // Append a PCM chunk and compute every frame now fully available. The frame
        // count for `avail` samples is floor((avail-N)/hop) - identical to the
        // single-shot pass - so accumulating chunks yields exactly the same frames.
        feed(chunk) {
            if (chunk && chunk.length) {
                if (len + chunk.length > buf.length) {
                    let cap = buf.length;
                    while (cap < len + chunk.length) cap *= 2;
                    const grown = new Float32Array(cap);
                    grown.set(buf.subarray(0, len));
                    buf = grown;
                }
                buf.set(chunk, len);
                len += chunk.length;
            }
            const avail = base + len;                     // global samples in [base, avail)
            const limit = Math.floor((avail - N) / hop);  // frames whose window fits
            while (next < limit) { computeRow(Math.round(next * hop) - base); next++; }
            // Drop PCM below the next unprocessed frame's window start, compacting in
            // place (copyWithin) rather than allocating a fresh view each chunk.
            const keep = Math.min(Math.round(next * hop), avail - N);
            if (keep > base) {
                const drop = keep - base;
                buf.copyWithin(0, drop, len);
                len -= drop;
                base = keep;
            }
        },
    };
}

// Global per-band whitening + quantization, fused into one sequential pass over the
// row store and written straight into a 0..maxHeight byte grid.
//
// Whitening divides each band by its own busy-level (a high percentile over the whole
// tune) so every band carrying signal reaches full height, flattening the constant
// bass->treble ramp; a global floor keeps genuinely dead bands low.
//
// Fusing matters because the loop poll runs this over the whole stream every ~15 s of
// audio. Separately, the old shape allocated a Float64Array(frames*numBars) - 9.6 MB
// at 10 minutes - handed it to quantizeGrid, which allocated the byte grid on top,
// and did both the percentile gather and the normalize pass with a numBars-wide
// stride (one cache line per element). This walks the rows in memory order, reads the
// percentiles off the store's histogram, and writes bytes into a caller-owned buffer.
//
// `stride` decimates (1 = the full frame grid, `step` = the keyframe grid); `nRows`
// is how many output rows to write; `out`, if given, is reused instead of allocated.
function whitenQuantize(store, maxHeight, stride, nRows, out) {
    const nb = store.numBars, src = store.data;
    const need = nRows * nb;
    if (!out || out.length < need) out = new Uint8Array(need);
    const whiten = NORM_STRENGTH > 0 && store.count > 1;
    // Per-band divisor, resolved once rather than per element.
    let denom = null;
    if (whiten) {
        const { ref, floor } = bandRefs(store);
        denom = new Float64Array(nb);
        for (let b = 0; b < nb; b++) denom[b] = Math.max(ref[b], floor, 1e-6);
    }
    for (let k = 0; k < nRows; k++) {
        const so = k * stride * nb, oo = k * nb;
        for (let b = 0; b < nb; b++) {
            const raw = src[so + b];
            let v = raw;
            if (whiten) {
                // busy level -> NORM_HEADROOM; clamp so a quiet band's brief spike
                // (divided by its tiny floor) can't explode past the ceiling and pin
                // the bar to full white.
                let norm = raw / denom[b] * NORM_HEADROOM;
                if (norm > 1) norm = 1;
                v = softKnee((1 - NORM_STRENGTH) * raw + NORM_STRENGTH * norm);  // roll off the top instead of clipping flat
            }
            const q = Math.round(v * maxHeight);
            out[oo + b] = q < 0 ? 0 : q > maxHeight ? maxHeight : q;
        }
    }
    return out;
}

// Whitened per-frame targets as a flat Float64Array[frames*numBars]. Only the offline
// harness and the tests want the un-quantized values now; the live paths all go
// through whitenQuantize above.
function whitenRows(rows, numBars) {
    const store = asRowStore(rows, numBars);
    const nb = store.numBars, n = store.count;
    const out = new Float64Array(n * nb);
    const whiten = NORM_STRENGTH > 0 && n > 1;
    let denom = null;
    if (whiten) {
        const { ref, floor } = bandRefs(store);
        denom = new Float64Array(nb);
        for (let b = 0; b < nb; b++) denom[b] = Math.max(ref[b], floor, 1e-6);
    }
    for (let k = 0; k < n; k++) {
        const o = k * nb;
        for (let b = 0; b < nb; b++) {
            const raw = store.data[o + b];
            if (!whiten) { out[o + b] = raw; continue; }
            let norm = raw / denom[b] * NORM_HEADROOM;
            if (norm > 1) norm = 1;
            out[o + b] = softKnee((1 - NORM_STRENGTH) * raw + NORM_STRENGTH * norm);
        }
    }
    return out;
}

// Whole-PCM analysis (non-incremental path: tests + the offline harness). Thin
// wrapper over the analyzer so there's one source of truth; returns the row store.
async function computeRowStore(pcm, sampleRate, numBars, frameHz, onTick, fMin, fMax) {
    const an = createFftAnalyzer(sampleRate, numBars, frameHz, fMin, fMax);
    const hop = sampleRate / frameHz;
    const total = Math.max(0, Math.floor((pcm.length - N) / hop));
    const CHUNK = Math.max(1, Math.ceil(256 * hop));   // ~256 frames per slice for progress
    for (let s = 0; s < pcm.length; s += CHUNK) {
        const end = Math.min(pcm.length, s + CHUNK);
        an.feed(pcm.subarray(s, end));
        if (onTick) await onTick(Math.min(1, an.rows.count / (total || 1)));
    }
    return an.rows;
}

// Back-compat shim for the offline harness: whitened targets + frame count.
async function computeTargets(pcm, sampleRate, numBars, frameHz, onTick, fMin, fMax) {
    const store = await computeRowStore(pcm, sampleRate, numBars, frameHz, onTick, fMin, fMax);
    return { targets: whitenRows(store, numBars), nframes: store.count };
}

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
        for (let r = 0; r < numRows; r++) {
            let best = 0, bestD = Infinity;
            for (let c = 0; c < K; c++) {
                let dd = 0;
                for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - cent[c * dim + d]; dd += df * df; if (dd >= bestD) break; }
                if (dd < bestD) { bestD = dd; best = c; }
            }
            labels[r] = best; counts[best]++;
            const off = best * dim, ro = r * dim;
            for (let d = 0; d < dim; d++) sums[off + d] += data[ro + d];
        }
        for (let c = 0; c < K; c++) {
            if (counts[c] === 0) { // reseed empty cluster on a random row
                const r = Math.floor(rng() * numRows);
                for (let d = 0; d < dim; d++) cent[c * dim + d] = data[r * dim + d];
            } else {
                for (let d = 0; d < dim; d++) cent[c * dim + d] = sums[c * dim + d] / counts[c];
            }
        }
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
// the tail (the old approach) let both through, so we validate against the whole
// stream and pick the fundamental of the harmonic series.
// `kf` is a quantized column matrix on ANY uniform time grid with `keyframeHz`
// rows per second; callers now pass the full FRAME-rate grid (see resolveKeyframes:
// SID loop periods are integral in frames, not keyframes) and map the result back.
function detectLoop(kf, nk, numBars, maxHeight, keyframeHz = 25, minLoopSeconds = 2) {
    // Windows are wall-clock spans, scaled to the grid rate so the detector
    // behaves the same at any rows-per-second (at 25 Hz these are the original 100/50/12).
    const W = Math.max(8, Math.round(4.0 * keyframeHz));    // tail confirm window (~4 s)
    // Shortest loop we accept (~minLoopSeconds, an Advanced setting): a smaller
    // value lets tight riffs count as the loop, a larger one forces a longer
    // musical phrase before we call the tune repeated.
    const Pmin = Math.max(4, Math.round(minLoopSeconds * keyframeHz));
    const NOTE = Math.max(2, Math.round(0.48 * keyframeHz));// ~held-note span; plateau off-by-one refine
    if (nk < 2 * W + Pmin + 10) return null;

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

    // Cheap candidate: smallest period whose last ~4 s recur one period earlier.
    // This is often the true loop, but on tunes with a repeating accompaniment it
    // can be a sub-harmonic - the checks below promote it to the fundamental.
    let P0 = -1;
    for (let cand = Pmin; cand <= tail - 1; cand++) {
        if (winDiff(tail, tail - cand) <= MATCH) { P0 = cand; break; }
    }
    if (P0 < 0) return null;

    // Full-stream self-similarity at lag P: mean per-bar diff over the WHOLE
    // stream. A long render holds many loops, so the intro barely dents the mean
    // and the true period sits at the deepest minimum. A sub-harmonic is elevated
    // because its melody advances across the shorter period even where the
    // accompaniment repeats. `refine` re-locks a period to its exact local
    // minimum, undoing the off-by-one that held-note plateaus give the tail scan.
    const Pmax = Math.floor(nk / 2);                  // need >=2 periods to confirm
    if (P0 > Pmax) return null;
    const residual = (P) => { let s = 0, n = 0; for (let i = P; i < nk; i++) { s += colDiff(i, i - P); n++; } return s / n; };
    const refine = (P) => {
        let bp = P, bv = residual(P);
        for (let d = -(NOTE - 1); d <= NOTE - 1; d++) {
            const q = P + d; if (q < Pmin || q >= nk) continue;
            const v = residual(q); if (v < bv) { bv = v; bp = q; }
        }
        return bp;
    };

    // Walk P0's harmonic series and pick the fundamental: the smallest harmonic
    // whose full-stream residual is near the deepest one found. (Refine P0 first
    // so k*P0 lands on the true multiples.) When P0 is already the fundamental,
    // every harmonic matches and we keep the smallest - P0 itself.
    P0 = refine(P0);
    const harm = [];
    for (let k = 1; k * P0 <= Pmax; k++) harm.push(k * P0);
    if (!harm.length) return null;
    const rr = harm.map(residual);
    let deepest = Infinity;
    for (const r of rr) if (r < deepest) deepest = r;
    const band = deepest + Math.max(0.6, maxHeight * 0.008);   // "near the deepest"
    let P = harm[harm.length - 1];
    for (let k = 0; k < harm.length; k++) { if (rr[k] <= band) { P = harm[k]; break; } }
    P = refine(P);

    // Confirm the chosen period against the whole stream, not just the tail: a
    // genuine loop matches everywhere (bar the small intro). This rejects the
    // marginal tail-only matches the old check let through - better a safe "no
    // loop" (store the full stream) than a wrong period the C64 wraps out of sync.
    if (residual(P) > MATCH) return null;

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
    const nDiff = nk - P;
    const introNeed = Math.max(4, Math.round(W * 0.10));
    let I = 0;
    if (nDiff > 0) {
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
                for (let j = hi - 1; j >= i; j--) if (over[j]) { I = j + 1; break; }
                break;
            }
        }
    }
    if (nk - P - I < W) return null;                  // need a full confirmed cycle
    return { loopStart: I, loopEnd: I + P };
}

// Main entry: mono PCM -> packed baked spectrometer data. See bakeFromStore for
// the returned shape. (The incremental render path uses createBakeSession instead,
// so it never buffers the whole tune; this stays for tests + the offline harness.)
export async function bakeSpectrometer(pcm, sampleRate, options = {}) {
    const o = { ...DEFAULTS, ...options };
    // The C64 reads one keyframe every second raster frame, so the keyframe rate
    // is exactly half the frame rate - derive it rather than trusting a separate
    // default, so an accurate (PAL/NTSC) frameHz carries through to the grid and
    // the stored timing (decimation step stays 2).
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
    const o = { ...DEFAULTS, ...options };
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const an = createFftAnalyzer(sampleRate, o.numBars, o.frameHz, o.fMin, o.fMax);
    let fedSamples = 0;
    // Scratch grid reused by every poll. It only ever grows, so after the first few
    // polls a poll allocates nothing at all - previously each one threw away a
    // Float64Array(frames*numBars) (9.6 MB at 10 minutes) plus a fresh byte grid,
    // ~80 times over a full 20-minute scan.
    let pollGrid = null;
    return {
        feed(chunk) { an.feed(chunk); fedSamples += chunk.length; },
        rows() { return an.rows; },
        fedSeconds() { return fedSamples / sampleRate; },
        // A confident loop in what's been fed so far, or null. Cheap enough to poll.
        // Detection runs at frame resolution (loop period in FRAMES) for the same
        // reason as resolveKeyframes: an odd-frame loop is invisible on the
        // keyframe grid. The caller only uses the truthiness to stop the render.
        tryLoop() {
            const nframes = an.rows.count;
            if (nframes < 8) return null;
            pollGrid = whitenQuantize(an.rows, o.maxHeight, 1, nframes, pollGrid);
            return detectLoop(pollGrid, nframes, o.numBars, o.maxHeight, o.frameHz, o.minLoopSeconds);
        },
    };
}

// Pack a final result from raw analyzer rows (createFftAnalyzer/createBakeSession).
// Kept separate so a cached row set can be re-baked at a different maxHeight (the
// rows are maxHeight-independent) without re-rendering. hitCap = the render stopped
// at the analysis cap without finding a loop.
export async function bakeRows(rows, options = {}) {
    const o = { ...DEFAULTS, ...options };
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const store = asRowStore(rows, o.numBars);
    const analyzedSeconds = options.analyzedSeconds != null ? options.analyzedSeconds : store.count / o.frameHz;
    return bakeFromStore(store, o, analyzedSeconds, !!options.hitCap, o.onProgress || (() => {}));
}

// Shared front half: decimate the per-frame targets to keyframes and resolve the
// loop (trim to intro+one cycle) or the fade-off (cap + trailing zeros to loop on).
// Both the full bake and the lightweight analysis (analyzeRows) run this - the loop /
// length figures the UI shows must match what an export actually stores. Returns
// { kf, nk, step, loopStart, looped, fadedOut, analyzedKeyframes }.
function resolveKeyframes(store, o) {
    const nframes = store.count;
    // decimate frameHz -> keyframeHz, whiten and quantize to 0..maxHeight
    const step = Math.max(1, Math.round(o.frameHz / o.keyframeHz));
    let nk = Math.floor(nframes / step);
    let kf = whitenQuantize(store, o.maxHeight, step, nk);

    // Trim redundant loop repeats: store intro + one cycle, wrap to loopStart.
    const analyzedKeyframes = nk;   // keyframes analysed before any loop trim
    let loopStart = 0;
    let fadedOut = false;
    let forcedLoop = false;         // fade path only: stream rewired to wrap to keyframe 0
    // Loop detection runs at FRAME resolution, never on the keyframe grid: SID
    // players advance on the frame interrupt, so a tune's period is always an
    // integer number of frames - but only sometimes of keyframes. A loop of an
    // odd frame count is a half-integer of 25 fps keyframes, so on the keyframe
    // grid every cycle-vs-cycle comparison is blurred by half a keyframe (~20 ms)
    // and a busy tune misses the match threshold everywhere (steel-DespaSIDo:
    // residual 4.1 on the keyframe grid vs 2.0 at frame resolution). The frame-
    // exact result is rounded onto the keyframe grid afterwards; the worst-case
    // half-keyframe wrap drift per cycle is imperceptible next to "no loop found".
    const kfF = step === 1 ? kf : whitenQuantize(store, o.maxHeight, 1, nframes);
    const nkF = step === 1 ? nk : nframes;
    const loop = detectLoop(kfF, nkF, o.numBars, o.maxHeight, o.frameHz, o.minLoopSeconds);
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
        const periodK = Math.max(1, Math.round((loop.loopEnd - loop.loopStart) / step));
        nk = Math.min(nk, loopStart + periodK);
        kf = kf.subarray(0, nk * o.numBars);
    } else {
        const NB = o.numBars;
        const silent = o.maxHeight * NB * 0.02;   // near-zero total column energy
        const budgetKf = o.budgetBytes - 256 * NB;
        const capKf = Math.max(1, Math.min(
            Math.floor((o.outputMaxSeconds || o.maxSeconds) * o.keyframeHz), budgetKf));
        let musicEnd = Math.min(nk, capKf);
        while (musicEnd > 0) {
            let e = 0; const off = (musicEnd - 1) * NB;
            for (let b = 0; b < NB; b++) e += kf[off + b];
            if (e > silent) break;
            musicEnd--;
        }
        // Forced song loop (o.forceLoop, chosen by the user for fade-out tunes):
        // keep ~1 s of silent tail so the fade can breathe, then wrap the WHOLE
        // stream back to keyframe 0 - the C64 player restarts the music on that
        // wrap, so audio and bars restart together. Default (no force): hold
        // ~0.3 s of zeros and loop on them, so the bars just fade off and stay dark.
        forcedLoop = !!o.forceLoop && musicEnd > 0;
        const HOLD = forcedLoop ? Math.max(8, Math.round(o.keyframeHz)) : 8;
        nk = musicEnd + HOLD;
        const faded = new Uint8Array(nk * NB);     // keyframes past musicEnd stay zero
        faded.set(kf.subarray(0, musicEnd * NB));
        kf = faded;
        loopStart = forcedLoop ? 0 : musicEnd;     // forced: restart at the top; else fade off
        fadedOut = true;
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
        kf, nk, step, loopStart, looped: !!loop, fadedOut, forcedLoop, analyzedKeyframes,
        loopStartFrames, loopEndFrames, musicEndFrames,
    };
}

// Lightweight analysis (#2 Analyse Tune): resolve the tune's loop / length WITHOUT
// the (expensive) vector quantization, so the UI can price the fps options fast. The
// stored duration (numKeyframes / keyframeHz) is fps-independent, so one pass at the
// default rate is enough to feed estimateBakeBytes for all three rates.
export function analyzeRows(rows, options = {}) {
    const o = { ...DEFAULTS, ...options };
    o.keyframeHz = o.frameHz / (o.framesPerKeyframe || 2);
    const store = asRowStore(rows, o.numBars);
    const analyzedSeconds = options.analyzedSeconds != null ? options.analyzedSeconds : store.count / o.frameHz;
    const { nk, loopStart, looped, fadedOut, analyzedKeyframes,
            loopStartFrames, loopEndFrames, musicEndFrames } = resolveKeyframes(store, o);
    // The tune's playing length in raster frames, defined the way HVSC's
    // Songlengths counts it: everything up to the point the music repeats, i.e.
    // intro PLUS one full loop (not just the loop). A tune with no detected loop
    // is measured to where the music actually stops.
    const lengthFrames = looped ? loopEndFrames : musicEndFrames;
    return {
        keyframeHz: o.keyframeHz, numKeyframes: nk, loopStart, looped, fadedOut,
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
// totalBytes, reconstruct() }.
async function bakeFromStore(store, o, analyzedSeconds, hitCap, prog) {
    const { kf, nk, step, loopStart, looped, fadedOut, forcedLoop, analyzedKeyframes } =
        resolveKeyframes(store, o);

    // --- Split (product) vector quantization -------------------------------
    // Split the numBars-wide column into `SEG` groups of `segW` bars and quantize
    // each group with its OWN 256-entry codebook + own index. Because the segments
    // are quantized (and later replayed) independently, a slowly-drifting part of the
    // spectrum keeps getting fresh indices even while another part holds - so the
    // whole column no longer freezes on one shared prototype the moment the nearest
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
    const codebookBytes = 256 * o.numBars;         // fixed regardless of segment count
    // Segment count keys off the 50 fps keyframe count (nk * step) so the same tune
    // gets the same split at every fps - only the index length shrinks at lower rates.
    const SEG = chooseSegments(o, nk * step);
    const segW = o.numBars / SEG;
    const SEGK = 256;                              // entries per segment (= one page per bar)
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
        keyframeHz: o.keyframeHz, numKeyframes: nk, loopStart,
        // raster frames per keyframe (1/2/3): the C64 cadence divisor the exporter patches
        framesPerKeyframe: Math.max(1, Math.round(o.frameHz / o.keyframeHz)),
        // Loop / timing info for the UI: whether a repeat was detected, how many
        // keyframes were analysed before trimming, and whether the analysis hit
        // the maxSeconds cap (tune longer than we looked at).
        looped,
        fadedOut,
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
// rate would cost. Mirrors bakeFromStore' segment-count choice so the figure
// matches an actual export.
//   durationSeconds  : stored length (intro+loop for a looped tune, else the
//                      fade-capped length).
//   framesPerKeyframe: 1 / 2 / 3  ->  50 / 25 / 16.66 Hz keyframes at PAL 50.12.
//   frameHz          : the tune's raster rate (PAL 50.1245 / NTSC 59.826).
//   freeBytes        : optional RAM ceiling; without it only budgetBytes bounds fit.
// Returns { framesPerKeyframe, keyframeHz, keyframes, segments, codebookBytes,
//           indexBytes, bytes, fits }.
export function estimateBakeBytes(durationSeconds, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const fpk = Math.max(1, Math.round(options.framesPerKeyframe || 2));
    const keyframeHz = o.frameHz / fpk;
    const keyframes = Math.max(1, Math.round(durationSeconds * keyframeHz));
    const codebookBytes = 256 * o.numBars;             // fixed regardless of segment count
    // Segments are chosen from the 50 fps keyframe count so the split is the same at
    // every rate: index bytes then scale purely with keyframes, so memory is monotonic
    // in fps (50 > 25 > 16.66) and matches an actual export at the chosen fps.
    const segments = chooseSegments(o, keyframes * fpk);
    const indexBytes = segments * keyframes;
    const bytes = codebookBytes + indexBytes;
    const ceiling = options.freeBytes != null ? Math.min(o.budgetBytes, options.freeBytes) : o.budgetBytes;
    return { framesPerKeyframe: fpk, keyframeHz, keyframes, segments, codebookBytes, indexBytes, bytes, fits: bytes <= ceiling };
}

export const _internals = {
    fft, computeBands, computeTargets, computeRowStore, kmeans, DEFAULTS,
    whitenRows, whitenQuantize, createRowStore, asRowStore, bandRefs,
    detectLoop, resolveKeyframes,
};
