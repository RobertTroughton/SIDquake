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
// On the C64, every keyframe reads one index byte per segment, points at that
// segment's codebook entries, and copies them into the "next" column; the
// player interpolates linearly from the current column to it over the raster
// frames in between (TickBakedFrame), and its UpdateBars attack/decay follows
// that moving target.
//
// Pure JS, no DOM/Node dependencies: bakeSpectrometer() takes mono PCM and
// returns the packed bytes, so it runs identically in the browser export path
// and in a Node test harness.

// ---- constants mirrored from hvsc-visualizer.js so the bake target matches
// the on-screen spectrum exactly (the `t` value in step(), BEFORE the slow
// release smoothing - that raw target is what we hand to the C64) ----
const N = 4096;                 // fftSize (matches AnalyserNode)
const BINS = N / 2;             // frequencyBinCount
// Frequency span the bars cover when no per-song range is fitted (loop
// detection always measures on this fixed grid, so a tune's loop and length
// never depend on its range). The browser visualizer uses 40..11000, but SID
// synthesis has almost no energy above ~5-6 kHz, so with only 40 bars the top
// ~8 (3.5-11 kHz) sit near-dead and the display looks left-heavy. A lower
// ceiling spreads the usable spectrum across all bars. Overridable per bake.
const F_MIN = 40, F_MAX = 5500;
// Per-song range (fitRange): the bars an export stores span only the part of
// the spectrum the tune actually uses. The analyser keeps a fine semitone grid
// of every frame alongside the fixed 40 bars, and the bake takes the lowest and
// highest fine bands that are alive by the whitening's own rule (busy level at
// least NORM_DEAD_FRAC of the busiest band's) as the range. Measured over the
// SID/ fixtures, SID bass reaches down to 30-60 Hz on every tune while the top
// of the live range runs from ~3 kHz (a filtered lead) to ~6.5 kHz (noise
// drums), so a fixed 5.5 kHz ceiling was leaving up to ten bars dead on some
// tunes and clipping others. The fitted range is clamped to FIT_MIN..FIT_MAX
// and widened to at least FIT_MIN_OCTAVES so a narrow tune does not get bars
// finer than the FFT can resolve.
const FIT_MIN = 30, FIT_MAX = 12000, FIT_MIN_OCTAVES = 4;
// Bass resolution. A 4096-point window at 44.1 kHz has 10.8 Hz bins and a
// Blackman main lobe of +/-32 Hz, which is wider than a two-semitone bar below
// ~540 Hz and wider than a whole octave below 65 Hz: a bass note lit four to
// six adjacent bars. So the fine grid takes its low bands from longer windows
// - 186 ms and 371 ms - cut from the audio decimated DEC times (a two-stage
// boxcar, then every DEC-th sample), which gives a 16384-point window's bins
// for the cost of a 2048-point FFT. Each band uses the SHORTEST window whose
// main lobe (LOBE_BINS bins each side) fits inside a bar at that pitch, so the
// time smearing a long window brings (a note fades in and out over its
// length) only reaches the register nothing shorter can resolve. Measured
// over the SID/ fixtures the decimated windows match true long FFTs to ~0.1
// on the 0..111 scale, and bars within 85% of the local peak among the bottom
// twelve go from 4.8-6.4 to 2.5-4.2.
const DEC = 8, LONG_N = 2048, MID_N = 1024;
const LOBE_BINS = 3;                   // Blackman main lobe half-width, in bins
const BAR_FRACTION = 0.12;             // a two-semitone bar's width as a fraction of its pitch
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
// 50 fps gets the full 5x8 split at 25 fps. (The split used to be chosen from
// the 50 fps count at every rate, so the memory readout was monotonic in fps;
// that spent the bytes a lower rate saved on nothing. Now that the C64
// interpolates between keyframes, 25 fps already animates smoothly, and the
// detail is worth more than a monotonic readout.)
function chooseSegments(o, keyframes) {
    const codebookBytes = 256 * o.numBars;         // fixed regardless of segment count
    for (const cand of o.segmentChoices) {
        if (o.numBars % cand === 0 && codebookBytes + cand * keyframes <= o.budgetBytes) return cand;
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

// One bar's raw value from the peak and mean byte level of its bins: the
// AVG_WEIGHT blend, the noise floor, the treble tilt (`tilt` = 0 at the lowest
// bar .. 1 at the highest) and the gamma, exactly as hvsc-visualizer.js step()
// does it. Shared by the fixed grid (computeRow) and the fine-grid derivation
// (deriveBars) so both produce the same bars.
function barValue(peak, avg, tilt) {
    let t = ((1 - AVG_WEIGHT) * peak + AVG_WEIGHT * avg) / 255;
    t = (t - FLOOR) / (1 - FLOOR);
    if (t < 0) t = 0;
    t *= 1 + SLOPE * tilt;
    if (t > 1) t = 1;
    return Math.pow(t, GAMMA);
}

// ---------------------------------------------------------------------------
// Fine analysis grid. Alongside the fixed 40 bars, the analyser keeps every
// frame's spectrum on a semitone grid from FIT_MIN to FIT_MAX, as disjoint bin
// ranges (a semitone narrower than a bin, below ~190 Hz, merges into the next
// so every band holds at least one bin). Each band stores its peak and mean byte
// level, which is all the bar formula needs, so any 40-bar span over the grid
// can be derived after the render without the PCM - that is what lets the range
// be fitted to the whole tune on a streaming analysis that never keeps audio.

// The three spectra a frame is analysed into: the 4096-point window on the
// audio itself, and the mid/long windows on the decimated audio. `resolvesFrom`
// is the pitch above which the window's main lobe fits inside a bar.
function analysisSources(sampleRate) {
    const srDec = sampleRate / DEC;
    return [
        { n: N, decimated: false, binHz: sampleRate / N },
        { n: MID_N, decimated: true, binHz: srDec / MID_N },
        { n: LONG_N, decimated: true, binHz: srDec / LONG_N },
    ].map(src => ({ ...src, bins: src.n / 2, resolvesFrom: LOBE_BINS * src.binHz / BAR_FRACTION }));
}

// Every band records which source it reads (`src`) and its bin range in that
// source's grid. Where the source changes, the next band starts at the bin
// holding the previous band's top edge, so coverage stays continuous.
function computeFineBands(sampleRate) {
    const sources = analysisSources(sampleRate);
    const pick = (hz) => { for (let i = 0; i < sources.length; i++) if (hz >= sources[i].resolvesFrom) return i; return sources.length - 1; };
    const top = Math.min(FIT_MAX, sampleRate / 2);
    const src = [], lo = [], hi = [], f0 = [], f1 = [];
    let cur = pick(FIT_MIN);
    let start = Math.floor(FIT_MIN / sources[cur].binHz);
    for (let f = FIT_MIN * Math.pow(2, 1 / 12); ; f *= Math.pow(2, 1 / 12)) {
        const last = f >= top;
        const edge = last ? top : f;
        const want = pick(f / Math.pow(2, 1 / 12));
        if (want !== cur) {
            start = Math.floor(start * sources[cur].binHz / sources[want].binHz);
            cur = want;
        }
        const binHz = sources[cur].binHz, bins = sources[cur].bins;
        const end = last ? Math.min(bins, Math.ceil(edge / binHz)) : Math.floor(edge / binHz);
        if (end > start) {
            // A band's span is what its bins cover, not the nominal semitone: at
            // the bass end a bin is wider than a semitone, and the bar that
            // takes the band needs to know where its energy really came from.
            src.push(cur); lo.push(start); hi.push(end); f0.push(start * binHz); f1.push(end * binHz);
            start = end;
        }
        if (last) break;
    }
    return {
        sources, src: Int8Array.from(src), lo: Int32Array.from(lo), hi: Int32Array.from(hi),
        f0: Float64Array.from(f0), f1: Float64Array.from(f1), count: lo.length,
    };
}

// Per-frame peak/mean bytes for every fine band, plus a per-band histogram of
// the band's own bar-formula value (no tilt), which is what fitRange reads its
// busy levels from. Two bytes per band per frame: ~6 MB for a 12-minute tune.
const FINE_HIST_BUCKETS = 1024;
function createFineStore(bands) {
    return {
        bands,
        count: 0,
        data: new Uint8Array(bands.count * 2 * 1024),
        hist: new Int32Array(bands.count * FINE_HIST_BUCKETS),
        // `spectra` holds one byte spectrum per analysis source (see analysisSources).
        push(spectra) {
            const nb = this.bands.count, { src, lo, hi } = this.bands;
            if ((this.count + 1) * nb * 2 > this.data.length) {
                const grown = new Uint8Array(this.data.length * 2);
                grown.set(this.data);
                this.data = grown;
            }
            const off = this.count * nb * 2;
            for (let s = 0; s < nb; s++) {
                const byteBin = spectra[src[s]];
                let m = 0, sum = 0;
                for (let i = lo[s]; i < hi[s]; i++) { const v = byteBin[i]; if (v > m) m = v; sum += v; }
                const avg = sum / (hi[s] - lo[s]);
                this.data[off + s * 2] = Math.round(m);
                this.data[off + s * 2 + 1] = Math.round(avg);
                let bucket = (barValue(m, avg, 0) * FINE_HIST_BUCKETS) | 0;
                if (bucket >= FINE_HIST_BUCKETS) bucket = FINE_HIST_BUCKETS - 1;
                this.hist[s * FINE_HIST_BUCKETS + bucket]++;
            }
            this.count++;
        },
    };
}

// The span of the spectrum this tune actually uses: from the lowest to the
// highest fine band whose busy level (the NORM_PCTL percentile of its values
// over the whole tune, off the histogram) is at least NORM_DEAD_FRAC of the
// busiest band's - the same rule whitenQuantize uses to decide which bands
// are dead. Returns { fMin, fMax, fitted }; a tune with no live band at all
// (silence) keeps the fixed span.
function fitRange(fine, fallbackMin = F_MIN, fallbackMax = F_MAX) {
    const nb = fine.bands.count, n = fine.count;
    if (!n) return { fMin: fallbackMin, fMax: fallbackMax, fitted: false };
    const busy = new Float64Array(nb);
    let top = 0;
    for (let s = 0; s < nb; s++) {
        const rank = Math.min(n - 1, Math.floor(n * NORM_PCTL));
        const base = s * FINE_HIST_BUCKETS;
        let cum = 0, bucket = FINE_HIST_BUCKETS - 1;
        for (let k = 0; k < FINE_HIST_BUCKETS; k++) {
            cum += fine.hist[base + k];
            if (cum > rank) { bucket = k; break; }
        }
        busy[s] = (bucket + 0.5) / FINE_HIST_BUCKETS;
        if (busy[s] > top) top = busy[s];
    }
    let first = -1, last = -1;
    for (let s = 0; s < nb; s++) {
        if (busy[s] >= top * NORM_DEAD_FRAC && busy[s] > 1 / FINE_HIST_BUCKETS) { if (first < 0) first = s; last = s; }
    }
    if (first < 0) return { fMin: fallbackMin, fMax: fallbackMax, fitted: false };
    let fMin = Math.max(FIT_MIN, fine.bands.f0[first]), fMax = Math.min(FIT_MAX, fine.bands.f1[last]);
    // Widen a narrow tune to FIT_MIN_OCTAVES, upward first (the bass end is
    // where the FFT is coarsest), then downward if the top is already reached.
    const span = Math.pow(2, FIT_MIN_OCTAVES);
    if (fMax < fMin * span) fMax = Math.min(FIT_MAX, fMin * span);
    if (fMax < fMin * span) fMin = Math.max(FIT_MIN, fMax / span);
    return { fMin, fMax, fitted: true };
}

// A 40-bar row store over [fMin, fMax) derived from the fine grid: every bar
// takes the fine bands whose centre falls inside it (or, for a bar narrower
// than a band, the band that holds the bar's centre) and combines their peaks
// and width-weighted means through the same barValue formula as the fixed grid.
function deriveBars(fine, numBars, fMin, fMax) {
    const { f0, f1, count: nb } = fine.bands;
    const members = [];
    for (let b = 0; b < numBars; b++) {
        const e0 = fMin * Math.pow(fMax / fMin, b / numBars);
        const e1 = fMin * Math.pow(fMax / fMin, (b + 1) / numBars);
        const list = [];
        for (let s = 0; s < nb; s++) {
            const centre = Math.sqrt(f0[s] * f1[s]);
            if (centre >= e0 && centre < e1) list.push(s);
        }
        if (!list.length) {
            const centre = Math.sqrt(e0 * e1);
            let best = 0;
            for (let s = 0; s < nb; s++) if (centre >= f0[s]) best = s;
            list.push(best);
        }
        members.push(Int32Array.from(list));
    }
    const store = createRowStore(numBars);
    const row = new Float64Array(numBars);
    const src = fine.data;
    for (let k = 0; k < fine.count; k++) {
        const off = k * nb * 2;
        for (let b = 0; b < numBars; b++) {
            const list = members[b];
            let peak = 0, sum = 0, width = 0;
            for (let j = 0; j < list.length; j++) {
                const s = list[j], w = f1[s] - f0[s];
                const m = src[off + s * 2];
                if (m > peak) peak = m;
                sum += src[off + s * 2 + 1] * w;
                width += w;
            }
            row[b] = barValue(peak, sum / width, b / (numBars - 1));
        }
        store.push(row);
    }
    return store;
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
// A frame's windows are all centred on the same instant, the middle of its
// 4096-point window; the long decimated window reaches (LONG_N / 2) * DEC
// samples past that, so a frame can only be computed once this many samples
// past its start have arrived.
const FRAME_NEED = N / 2 + (LONG_N / 2) * DEC + DEC;

function createFftAnalyzer(sampleRate, numBars, frameHz, fMin, fMax) {
    const hop = sampleRate / frameHz;
    const { lo, hi } = computeBands(numBars, sampleRate, fMin, fMax);
    const bands = computeFineBands(sampleRate);
    // One window, FFT scratch, smoothing state and byte spectrum per source.
    const srcs = bands.sources.map(src => ({
        ...src,
        win: blackmanWindow(src.n),
        re: new Float64Array(src.n), im: new Float64Array(src.n),
        smoothed: new Float64Array(src.bins),
        byteBin: new Float64Array(src.bins),
    }));
    const spectra = srcs.map(src => src.byteBin);
    const rows = createRowStore(numBars);   // raw per-frame values (pre-whitening)
    // The fine grid rides along on the same store, so everything that caches
    // or hands on the rows carries it too (see fitRange / deriveBars).
    rows.fine = createFineStore(bands);
    const row = new Float64Array(numBars);  // scratch, copied into the store per frame
    let next = 0;             // index of the next frame to compute
    // PCM tail not yet consumed, held in a fixed buffer that is compacted in place.
    // Only a window's worth (N) plus at most one fed chunk is ever live, so the
    // buffer settles at a steady size instead of being reallocated and fully copied
    // on every 8 K-sample chunk (~1600 allocations per 5 minutes of audio).
    let buf = new Float32Array(N * 2);
    let len = 0;              // valid samples in buf
    let base = 0;             // global sample index of buf[0]
    // The decimated audio, kept the same way: a two-stage boxcar of DEC samples
    // (a triangular low-pass whose nulls sit on the multiples of the decimated
    // rate, so what aliases into the bass bands is 40-odd dB down) sampled once
    // every DEC input samples. Decimated sample k stands for input sample k*DEC.
    let dbuf = new Float32Array(LONG_N * 2);
    let dlen = 0, dbase = 0;
    const ring1 = new Float64Array(DEC), ring2 = new Float64Array(DEC);
    let sum1 = 0, sum2 = 0, phase = 0, ringPos = 0;

    const decimate = (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
            const x = chunk[i];
            sum1 += x - ring1[ringPos]; ring1[ringPos] = x;
            const y = sum1 / DEC;
            sum2 += y - ring2[ringPos]; ring2[ringPos] = y;
            ringPos = (ringPos + 1) % DEC;
            if (++phase === DEC) {
                phase = 0;
                if (dlen === dbuf.length) {
                    const grown = new Float32Array(dbuf.length * 2);
                    grown.set(dbuf);
                    dbuf = grown;
                }
                dbuf[dlen++] = sum2 / DEC;
            }
        }
    };

    // Window `src` over the samples starting at global index `from` of either
    // stream (samples before the start of the tune read as zero).
    const analyse = (src, from) => {
        const { n, re, im, win, smoothed, byteBin, bins } = src;
        const data = src.decimated ? dbuf : buf, off = from - (src.decimated ? dbase : base);
        for (let i = 0; i < n; i++) { const k = off + i; re[i] = (k >= 0 ? data[k] : 0) * win[i]; im[i] = 0; }
        fft(re, im);
        for (let i = 0; i < bins; i++) {
            const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / n;   // faster than hypot; no overflow risk here
            smoothed[i] = SMOOTH * smoothed[i] + (1 - SMOOTH) * mag;   // AnalyserNode temporal smoothing
            const db = 20 * Math.log10(smoothed[i] + 1e-12);
            const byte = (db - MIN_DB) / (MAX_DB - MIN_DB);
            byteBin[i] = byte < 0 ? 0 : byte > 1 ? 255 : byte * 255;   // getByteFrequencyData
        }
    };

    const computeRow = (start) => {   // start = global index of the frame's 4096-point window
        const centre = start + N / 2;
        for (const src of srcs) {
            analyse(src, src.decimated ? Math.round(centre / DEC) - src.n / 2 : start);
        }
        const byteBin = srcs[0].byteBin;
        for (let b = 0; b < numBars; b++) {
            let m = 0, sum = 0;
            for (let i = lo[b]; i < hi[b]; i++) { const v = byteBin[i]; if (v > m) m = v; sum += v; }
            row[b] = barValue(m, sum / (hi[b] - lo[b]), b / (numBars - 1));
        }
        rows.push(row);
        rows.fine.push(spectra);
    };

    return {
        rows,
        // Append a PCM chunk and compute every frame now fully available. The frame
        // count for `avail` samples is floor((avail - FRAME_NEED) / hop) - identical
        // to the single-shot pass - so accumulating chunks yields exactly the same
        // frames.
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
                decimate(chunk);
            }
            const avail = base + len;                     // global samples in [base, avail)
            const limit = Math.floor((avail - FRAME_NEED) / hop);  // frames whose windows all fit
            while (next < limit) { computeRow(Math.round(next * hop)); next++; }
            // Drop PCM below the next unprocessed frame's window start, compacting in
            // place (copyWithin) rather than allocating a fresh view each chunk; the
            // decimated stream keeps back to the start of that frame's long window.
            const keep = Math.min(Math.round(next * hop), avail - N);
            if (keep > base) {
                const drop = keep - base;
                buf.copyWithin(0, drop, len);
                len -= drop;
                base = keep;
            }
            const dkeep = Math.max(0, Math.round((Math.round(next * hop) + N / 2) / DEC) - LONG_N / 2);
            if (dkeep > dbase) {
                const drop = Math.min(dlen, dkeep - dbase);
                dbuf.copyWithin(0, drop, dlen);
                dlen -= drop;
                dbase += drop;
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
    const total = Math.max(0, Math.floor((pcm.length - FRAME_NEED) / hop));
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
function detectLoop(kf, nk, numBars, maxHeight, keyframeHz = 25, minLoopSeconds = 2, hint = null) {
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
// { kf, nk, step, loopStart, looped, fadedOut, truncated, analyzedKeyframes }.
//
// `out`, when given, is the row store the STORED bars come from (the per-song
// range derived by outputStore); every decision - the loop, where the music
// ends, whether it was cut - is still made on `store`, the fixed grid the
// analysis measured on, so fitting the range can never move a tune's loop or
// length away from what the UI showed. Both stores hold the same frames.
function resolveKeyframes(store, o, out = store) {
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
    // exact result is rounded onto the keyframe grid afterwards; the worst-case
    // half-keyframe wrap drift per cycle is imperceptible next to "no loop found".
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
        const periodK = Math.max(1, Math.round((loop.loopEnd - loop.loopStart) / step));
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
        kf, nk, step, loopStart, looped: !!loop, fadedOut, truncated, forcedLoop, analyzedKeyframes,
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
    const { nk, loopStart, looped, fadedOut, truncated, analyzedKeyframes,
            loopStartFrames, loopEndFrames, musicEndFrames } = resolveKeyframes(store, o);
    // The tune's playing length in raster frames, defined the way HVSC's
    // Songlengths counts it: everything up to the point the music repeats, i.e.
    // intro PLUS one full loop (not just the loop). A tune with no detected loop
    // is measured to where the music actually stops.
    const lengthFrames = looped ? loopEndFrames : musicEndFrames;
    return {
        keyframeHz: o.keyframeHz, numKeyframes: nk, loopStart, looped, fadedOut, truncated,
        analyzedKeyframes, analyzedSeconds,
        cappedAtMaxSeconds: !looped && !!options.hitCap,
        storedSeconds: nk / o.keyframeHz,
        // Frame-exact figures (see resolveKeyframes).
        loopStartFrames, loopEndFrames, musicEndFrames, lengthFrames,
        lengthSeconds: lengthFrames / o.frameHz,
        loopFrames: looped ? loopEndFrames - loopStartFrames : 0,
    };
}

// The row store the stored bars are taken from: the fixed grid itself, or -
// when the analyser kept the fine grid and the bake asks for it - a 40-bar
// grid over the span the tune actually uses. Returns { out, fMin, fMax, fitted }.
function outputStore(store, o) {
    if (o.fitRange && store.fine) {
        const r = fitRange(store.fine, o.fMin, o.fMax);
        return { out: deriveBars(store.fine, o.numBars, r.fMin, r.fMax), fMin: r.fMin, fMax: r.fMax, fitted: r.fitted };
    }
    return { out: store, fMin: o.fMin, fMax: o.fMax, fitted: false };
}

// Back half of the bake: quantize the per-frame targets to keyframes, resolve the
// loop (or fade-off), vector-quantize, and pack. Returns { codebook, indices,
// numBars, maxHeight, K, keyframeHz, numKeyframes, loopStart, looped, fadedOut,
// truncated, totalBytes, reconstruct() }.
async function bakeFromStore(store, o, analyzedSeconds, hitCap, prog) {
    const range = outputStore(store, o);
    const { kf, nk, step, loopStart, looped, fadedOut, truncated, forcedLoop, analyzedKeyframes } =
        resolveKeyframes(store, o, range.out);

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
    const SEG = chooseSegments(o, nk);
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
        // The span the stored bars cover (Hz), fitted to the tune unless the
        // analysis had no fine grid to fit it from.
        fMin: range.fMin, fMax: range.fMax, rangeFitted: range.fitted,
        keyframeHz: o.keyframeHz, numKeyframes: nk, loopStart,
        // raster frames per keyframe (1/2/3): the C64 cadence divisor the exporter patches
        framesPerKeyframe: Math.max(1, Math.round(o.frameHz / o.keyframeHz)),
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
