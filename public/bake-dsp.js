// bake-dsp.js - the baked spectrometer's signal processing: the streaming FFT
// analyser (windows, decimation, the fixed 40-bar grid and the fine semitone
// grid), the row stores and their value histograms, per-band whitening, and the
// per-song range fit. spectrometer-bake.js drives it and loop-detect.js reads
// the whitened grids it produces.
//
// Pure JS, no DOM/Node dependencies.

// ---- constants taken from hvsc-visualizer.js's bar target (the `t` value in
// step(), BEFORE the slow release smoothing - that raw target is what we hand
// to the C64). MAX_DB has since been raised here (see below), so the baked bar
// heights no longer match the on-screen spectrum exactly ----
const N = 4096;                 // fftSize (matches AnalyserNode)
const BINS = N / 2;             // frequencyBinCount
// Frequency span the bars cover when no per-song range is fitted (loop
// detection always measures on this fixed grid, so a tune's loop and length
// never depend on its range). The browser visualizer uses 40..11000, but SID
// synthesis has almost no energy above ~5-6 kHz, so with only 40 bars the top
// ~8 (3.5-11 kHz) sit near-dead and the display looks left-heavy. A lower
// ceiling spreads the usable spectrum across all bars. Overridable per bake.
export const F_MIN = 40, F_MAX = 5500;
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
export const FIT_MIN = 30, FIT_MAX = 12000, FIT_MIN_OCTAVES = 4;
// Bass resolution. A 4096-point window at 44.1 kHz has 10.8 Hz bins and a
// Blackman main lobe of +/-32 Hz, which is wider than a two-semitone bar below
// ~540 Hz and wider than a whole octave below 65 Hz: a bass note lit four to
// six adjacent bars. So the fine grid takes its low bands from longer windows
// - 186 ms and 371 ms - cut from the audio decimated DEC times (a two-stage
// boxcar, then every DEC-th sample), which gives a 16384-point window's bins
// for the cost of a 2048-point FFT. Each band uses the SHORTEST window whose
// main lobe half-width (LOBE_BINS bins) is no wider than a bar at that pitch -
// the 4k window from ~270 Hz, 186 ms from ~135 Hz, 371 ms below - so the time
// smearing a long window brings (a note fades in and out over its length) only
// reaches the register nothing shorter can resolve. Near each crossover the
// whole lobe still spans about three bars, but requiring it to fit inside one
// (crossovers an octave up) measured no better over SID/ - pitch spread 2.48
// bars against 2.45, with more smearing in time
// (scripts/measure-bass-resolution.mjs). Measured
// through the real pipeline over six SID/ tunes, the decimated windows match
// true long FFTs to ~0.1 on the 0..111 scale, and bars within 85% of the local
// peak among the bottom twelve go from 4.1-6.4 to 2.4-3.9.
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

// ---------------------------------------------------------------------------
// Iterative in-place radix-2 FFT (real input -> magnitude spectrum).
// re/im are Float64Array(N). Returns nothing; results left in re/im.
export function fft(re, im) {
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

// Lower edge (Hz) of bar `b` of `numBars` log-spaced bars over [fMin, fMax);
// bar b + 1's lower edge is bar b's upper one.
function barEdge(fMin, fMax, b, numBars) {
    return fMin * Math.pow(fMax / fMin, b / numBars);
}

// Per-bar FFT-bin ranges, log-spaced (as in hvsc-visualizer computeBands).
export function computeBands(numBars, sampleRate, fMin = F_MIN, fMaxHz = F_MAX) {
    const nyq = sampleRate / 2;
    const binHz = nyq / BINS;
    const fMax = Math.min(fMaxHz, nyq);
    const lo = new Int32Array(numBars), hi = new Int32Array(numBars);
    for (let b = 0; b < numBars; b++) {
        const f0 = barEdge(fMin, fMax, b, numBars);
        const f1 = barEdge(fMin, fMax, b + 1, numBars);
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
export function barValue(peak, avg, tilt) {
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
// is the pitch above which the window's main-lobe half-width fits in a bar.
export function analysisSources(sampleRate) {
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
export function computeFineBands(sampleRate) {
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
export function createFineStore(bands) {
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
export function fitRange(fine, fallbackMin = F_MIN, fallbackMax = F_MAX) {
    const nb = fine.bands.count, n = fine.count;
    if (!n) return { fMin: fallbackMin, fMax: fallbackMax, fitted: false };
    const busy = new Float64Array(nb);
    let top = 0;
    for (let s = 0; s < nb; s++) {
        busy[s] = histPercentile(fine.hist, s * FINE_HIST_BUCKETS, FINE_HIST_BUCKETS, n);
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
export function deriveBars(fine, numBars, fMin, fMax) {
    const { f0, f1, count: nb } = fine.bands;
    const members = [];
    for (let b = 0; b < numBars; b++) {
        const e0 = barEdge(fMin, fMax, b, numBars);
        const e1 = barEdge(fMin, fMax, b + 1, numBars);
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
export function createRowStore(numBars) {
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
export function asRowStore(rows, numBars) {
    if (rows && rows.data instanceof Float32Array && typeof rows.count === 'number') return rows;
    const nb = numBars || (rows.length ? rows[0].length : 0);
    const store = createRowStore(nb);
    for (let i = 0; i < rows.length; i++) store.push(rows[i]);
    return store;
}

// The NORM_PCTL percentile of the `n` values counted in one band's histogram,
// hist[base .. base + buckets) over [0, 1]: the same rank the old col.sort() +
// index picked, resolved through cumulative bucket counts, with the bucket's
// centre standing in for the exact sample.
function histPercentile(hist, base, buckets, n) {
    const rank = Math.min(n - 1, Math.floor(n * NORM_PCTL));
    let cum = 0, bucket = buckets - 1;
    for (let k = 0; k < buckets; k++) {
        cum += hist[base + k];
        if (cum > rank) { bucket = k; break; }
    }
    return (bucket + 0.5) / buckets;
}

// Per-band "busy level" (the NORM_PCTL percentile of that band's values over the
// whole tune) read straight off the histogram: one pass over HIST_BUCKETS per band,
// independent of how many frames have been analysed. Returns { ref, floor }.
export function bandRefs(store) {
    const nb = store.numBars, n = store.count;
    const ref = new Float64Array(nb);
    let globalRef = 0;
    for (let b = 0; b < nb; b++) {
        const p = histPercentile(store.hist, b * HIST_BUCKETS, HIST_BUCKETS, n);
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
// keyframe every 1, 2 or 3 raster frames (framesPerKeyframe), so the grid must
// sit on the true raster rate
// (PAL 50.1245 / NTSC 59.826), not a round 50 - a round-50 hop is ~0.25% slow and
// drifts the bars ~0.2 s per loop.
// A frame's windows are all centred on the same instant, the middle of its
// 4096-point window; the long decimated window reaches (LONG_N / 2) * DEC
// samples past that, so a frame can only be computed once this many samples
// past its start have arrived.
const FRAME_NEED = N / 2 + (LONG_N / 2) * DEC + DEC;

export function createFftAnalyzer(sampleRate, numBars, frameHz, fMin, fMax) {
    const hop = sampleRate / frameHz;
    const { lo, hi } = computeBands(numBars, sampleRate, fMin, fMax);
    const bands = computeFineBands(sampleRate);
    // One window, FFT scratch, smoothing state and byte spectrum per source.
    // The input is real, so each window runs as a complex FFT of half its length
    // (even samples in re, odd in im) and the spectrum is split out afterwards;
    // twr/twi hold that split's twiddles, cos/sin(2 pi k / n).
    const srcs = bands.sources.map(src => {
        const half = src.n / 2;
        const twr = new Float64Array(half), twi = new Float64Array(half);
        for (let k = 0; k < half; k++) { twr[k] = Math.cos(2 * Math.PI * k / src.n); twi[k] = Math.sin(2 * Math.PI * k / src.n); }
        return {
            ...src,
            win: blackmanWindow(src.n),
            zr: new Float64Array(half), zi: new Float64Array(half), twr, twi,
            smoothed: new Float64Array(src.bins),
            byteBin: new Float64Array(src.bins),
        };
    });
    const spectra = srcs.map(src => src.byteBin);
    // The bins anything reads: the bars from the 4k spectrum, and each fine band
    // from its own source. Magnitude, smoothing and dB are per bin, so working
    // out only these gives the same values for a fraction of the cost (the long
    // windows are read over a few dozen of their 1024 bins).
    for (const src of srcs) { src.usedLo = src.bins; src.usedHi = 0; }
    const use = (s, a, b) => { if (a < s.usedLo) s.usedLo = a; if (b > s.usedHi) s.usedHi = b; };
    for (let b = 0; b < numBars; b++) use(srcs[0], lo[b], hi[b]);
    for (let s = 0; s < bands.count; s++) use(srcs[bands.src[s]], bands.lo[s], bands.hi[s]);
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
        const { n, zr, zi, twr, twi, win, smoothed, byteBin, usedLo, usedHi } = src;
        const data = src.decimated ? dbuf : buf, off = from - (src.decimated ? dbase : base);
        const half = n >> 1;
        for (let i = 0; i < half; i++) {
            const k = off + 2 * i;
            zr[i] = (k >= 0 ? data[k] : 0) * win[2 * i];
            zi[i] = (k + 1 >= 0 ? data[k + 1] : 0) * win[2 * i + 1];
        }
        fft(zr, zi);
        for (let i = usedLo; i < usedHi; i++) {
            // Bin i of the real input from bins i and half-i of the packed FFT:
            // X = E + W^i O, E and O the spectra of the even and odd samples.
            const m = i === 0 ? 0 : half - i;
            const ar = zr[i], ai = zi[i], br = zr[m], bi = -zi[m];
            const er = (ar + br) * 0.5, ei = (ai + bi) * 0.5;
            const or = (ai - bi) * 0.5, oi = (br - ar) * 0.5;
            const c = twr[i], s = -twi[i];
            const xr = er + c * or - s * oi, xi = ei + c * oi + s * or;
            const mag = Math.sqrt(xr * xr + xi * xi) / n;   // faster than hypot; no overflow risk here
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

// Per-band whitening divisor (the band's busy level, held up to the global
// dead-band floor), resolved once rather than per element; null when the store
// is too short to whiten.
function whitenDenoms(store) {
    if (!(NORM_STRENGTH > 0 && store.count > 1)) return null;
    const nb = store.numBars;
    const { ref, floor } = bandRefs(store);
    const denom = new Float64Array(nb);
    for (let b = 0; b < nb; b++) denom[b] = Math.max(ref[b], floor, 1e-6);
    return denom;
}

// One raw value whitened against its band's divisor. The busy level maps to
// NORM_HEADROOM, clamped so a quiet band's brief spike (divided by its tiny
// floor) can't explode past the ceiling and pin the bar to full white; the
// soft knee then rolls off the top instead of clipping flat.
function whitened(raw, denom) {
    let norm = raw / denom * NORM_HEADROOM;
    if (norm > 1) norm = 1;
    return softKnee((1 - NORM_STRENGTH) * raw + NORM_STRENGTH * norm);
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
export function whitenQuantize(store, maxHeight, stride, nRows, out) {
    const nb = store.numBars, src = store.data;
    const need = nRows * nb;
    if (!out || out.length < need) out = new Uint8Array(need);
    const denom = whitenDenoms(store);
    for (let k = 0; k < nRows; k++) {
        const so = k * stride * nb, oo = k * nb;
        for (let b = 0; b < nb; b++) {
            const raw = src[so + b];
            const v = denom ? whitened(raw, denom[b]) : raw;
            const q = Math.round(v * maxHeight);
            out[oo + b] = q < 0 ? 0 : q > maxHeight ? maxHeight : q;
        }
    }
    return out;
}

// Whitened per-frame targets as a flat Float64Array[frames*numBars]. Only the offline
// harness and the tests want the un-quantized values now; the live paths all go
// through whitenQuantize above.
export function whitenRows(rows, numBars) {
    const store = asRowStore(rows, numBars);
    const nb = store.numBars, n = store.count;
    const out = new Float64Array(n * nb);
    const denom = whitenDenoms(store);
    for (let k = 0; k < n; k++) {
        const o = k * nb;
        for (let b = 0; b < nb; b++) {
            const raw = store.data[o + b];
            out[o + b] = denom ? whitened(raw, denom[b]) : raw;
        }
    }
    return out;
}

// Whole-PCM analysis (non-incremental path: tests + the offline harness). Thin
// wrapper over the analyzer so there's one source of truth; returns the row store.
export async function computeRowStore(pcm, sampleRate, numBars, frameHz, onTick, fMin, fMax) {
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
export async function computeTargets(pcm, sampleRate, numBars, frameHz, onTick, fMin, fMax) {
    const store = await computeRowStore(pcm, sampleRate, numBars, frameHz, onTick, fMin, fMax);
    return { targets: whitenRows(store, numBars), nframes: store.count };
}

// The row store the stored bars are taken from: the fixed grid itself, or -
// when the analyser kept the fine grid and the bake asks for it - a 40-bar
// grid over the span the tune actually uses. Returns { out, fMin, fMax, fitted }.
export function outputStore(store, o) {
    if (o.fitRange && store.fine) {
        const r = fitRange(store.fine, o.fMin, o.fMax);
        return { out: deriveBars(store.fine, o.numBars, r.fMin, r.fMax), fMin: r.fMin, fMax: r.fMax, fitted: r.fitted };
    }
    return { out: store, fMin: o.fMin, fMax: o.fMax, fitted: false };
}
