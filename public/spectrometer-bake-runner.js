// spectrometer-bake-runner.js - browser glue that renders a tune to PCM with
// the libsidplayfp WASM engine (public/sidplayfp.js) and hands it to
// bakeSpectrometer() to produce the compressed FFT bar-height stream that the
// baked RaistlinBars (FFT) player replays on the C64.
//
// This mirrors the offline Node render harness used to validate the codec: it
// drives audio_init / audio_load_sid / audio_generate directly (no
// AudioWorklet / realtime playback), so it can render the whole tune far
// faster than realtime.

// Loaded lazily (dynamic import) so the dev cache-buster applies to the baker too
// - a static import would resolve ./spectrometer-bake.js without the ?t= query and
// could be served stale on a local dev server.
let _bakeMod = null;
async function getBakeModule() {
    if (!_bakeMod) {
        const cb = (typeof window !== 'undefined' && window.cacheBust) || (s => s);
        _bakeMod = await import(cb('./spectrometer-bake.js'));
    }
    return _bakeMod;
}

async function loadSidplayfpModule() {
    if (typeof SIDPlayfpModule !== 'function') {
        if (typeof window !== 'undefined' && window.loadScript) {
            await window.loadScript('sidplayfp.js');
        } else {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = (window.cacheBust || (x => x))('sidplayfp.js');
                s.onload = resolve;
                s.onerror = () => reject(new Error('failed to load sidplayfp.js'));
                document.head.appendChild(s);
            });
        }
    }
    // eslint-disable-next-line no-undef
    return SIDPlayfpModule();
}

// The render (SID -> per-frame FFT rows) is the expensive stage and depends only
// on the tune + subtune + bar count, not on maxHeight. So we cache the analysed
// rows for the last tune, plus each finalized bake keyed by bar geometry: a new
// tune re-renders (stopping early once its loop is found); switching to another
// visualizer with the same bars re-runs only the cheap re-bake, or nothing if
// that geometry is already baked.
//
// The cache lives on a stable global, NOT in a module variable: the dev cache-buster
// appends ?t=<now> to every dynamic import, so ui.js (analyse) and prg-builder.js
// (export bake) load DIFFERENT module instances - a module-level cache would be empty
// in the second one and the tune would render twice. A shared global is seen by every
// instance, so the render happens once and is reused across visualizer switches.
const _cache = (() => {
    const g = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (!g.__spectrometerCache) g.__spectrometerCache = { rows: null, bakes: new Map() };
    return g.__spectrometerCache;
})();
// _cache.rows : { key, numBars, rows, frameHz, isNtsc, renderedSeconds, hitCap }
// _cache.bakes: Map geometryKey -> bake result (valid while _cache.rows.key holds)

// Cheap FNV-1a content hash so a fresh Uint8Array of the same tune still hits.
function tuneKey(bytes, subtune, sampleRate, maxSeconds, minLoopSeconds) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    // minLoopSeconds (x10 -> integer) is part of the key: it changes the render's
    // loop early-exit point, so a different threshold must re-render, not reuse.
    for (const e of [subtune, sampleRate, maxSeconds, bytes.length, Math.round((minLoopSeconds || 2) * 10)]) {
        h ^= (e | 0); h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

// sidBytes: Uint8Array of a valid .sid file (e.g. analyzer.createModifiedSID()).
// options: { subtune, sampleRate=44100, maxSeconds, outputMaxSeconds, numBars,
//            maxHeight, onProgress(label, fraction, extra) } . extra (render stage
//            only) = { seconds, totalSeconds, loopFound? } - elapsed tune time
//            scanned vs the search cap, so the UI can show time instead of a %
//            (the render stops early on a confirmed loop, making a bare % jumpy).
// Returns the bake result { codebook, indices, K, numBars, ... }.
// Render this tune to FFT rows once (incrementally, stopping as soon as a loop is
// confirmed) and cache them. Re-render only for a new tune or a different bar count.
// Both the full bake and the loop-only analysis share this - the render is ~90% of
// the cost, so pricing the fps options and then exporting reuse one render.
async function ensureRows(sidBytes, options = {}) {
    const sampleRate = options.sampleRate || 44100;
    const maxSeconds = options.maxSeconds || 720;
    const numBars = options.numBars || 40;
    const maxHeight = options.maxHeight || 111;
    const subtune = options.subtune || 0;
    const minLoopSeconds = options.minLoopSeconds || 2;
    const onProgress = options.onProgress || (() => {});
    const key = tuneKey(sidBytes, subtune, sampleRate, maxSeconds, minLoopSeconds);
    const bake = await getBakeModule();
    if (!_cache.rows || _cache.rows.key !== key || _cache.rows.numBars !== numBars) {
        _cache.rows = await renderAndAnalyze(sidBytes, bake, { sampleRate, maxSeconds, subtune, numBars, maxHeight, minLoopSeconds, onProgress, signal: options.signal });
        _cache.rows.key = key;
        _cache.bakes.clear();
    }
    return { bake, numBars, maxHeight };
}

export async function renderAndBakeSpectrometer(sidBytes, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const { bake, numBars, maxHeight } = await ensureRows(sidBytes, options);

    // Cache the packed bake per geometry AND keyframe rate: the same rendered rows
    // re-bake to different sizes at 50/25/16.66 Hz, so fps must be part of the key.
    // forceLoop rewires a fade-out tune's stream (wrap to keyframe 0 instead of
    // holding dark), so it must be part of the key too or toggling the option
    // between exports would silently reuse the wrong stream.
    const framesPerKeyframe = Math.max(1, Math.round(options.framesPerKeyframe || 2));
    // outputMaxSeconds caps a non-looping tune's stored length, which changes both
    // the keyframe count and the segment split, so it has to key the cache too.
    const geomKey = `${numBars}x${maxHeight}x${framesPerKeyframe}x${options.outputMaxSeconds || 0}` +
        `${options.forceLoop ? '-loop' : ''}`;
    if (_cache.bakes.has(geomKey)) return _cache.bakes.get(geomKey);

    const result = await bake.bakeRows(_cache.rows.rows, {
        numBars, maxHeight, frameHz: _cache.rows.frameHz, framesPerKeyframe,
        outputMaxSeconds: options.outputMaxSeconds,
        minLoopSeconds: options.minLoopSeconds,
        forceLoop: !!options.forceLoop,
        analyzedSeconds: _cache.rows.renderedSeconds,
        hitCap: _cache.rows.hitCap,
        onProgress,
    });
    _cache.bakes.set(geomKey, result);
    return result;
}

// Analysis-only entry point (#2/#3): render + loop detection ONLY - no vector
// quantization - and return just the timing summary the UI needs (length, loop
// point, keyframe count) to price the fps options before any PRG is generated. The
// heavy render is cached, so the later export bake for the same tune/bars reuses it.
// `storedSeconds` is the fps-independent stored duration - pass it to
// estimateBakeBytes() to price each fps option (#4).
export async function analyzeSpectrometer(sidBytes, options = {}) {
    const { bake } = await ensureRows(sidBytes, options);
    const r = bake.analyzeRows(_cache.rows.rows, {
        numBars: options.numBars, maxHeight: options.maxHeight,
        frameHz: _cache.rows.frameHz, framesPerKeyframe: options.framesPerKeyframe,
        minLoopSeconds: options.minLoopSeconds,
        outputMaxSeconds: options.outputMaxSeconds,
        analyzedSeconds: _cache.rows.renderedSeconds, hitCap: _cache.rows.hitCap,
    });
    return {
        looped: r.looped,
        fadedOut: r.fadedOut,
        loopStart: r.loopStart,               // keyframes
        numKeyframes: r.numKeyframes,
        keyframeHz: r.keyframeHz,
        frameHz: _cache.rows.frameHz,
        isNtsc: _cache.rows.isNtsc || 0,
        storedSeconds: r.storedSeconds,                        // intro+loop, or fade-capped
        loopStartSeconds: r.loopStart / r.keyframeHz,          // where the repeat begins
        loopSeconds: (r.numKeyframes - r.loopStart) / r.keyframeHz,
        analyzedSeconds: r.analyzedSeconds,
        cappedAtMaxSeconds: r.cappedAtMaxSeconds,
    };
}

// Thrown when the caller aborts a render via options.signal (an AbortSignal).
// Named 'AbortError' so callers can tell a user cancel from a genuine failure.
function abortError() {
    const e = new Error('Analysis cancelled');
    e.name = 'AbortError';
    return e;
}

// Render the tune through libsidplayfp (far faster than realtime), feeding each
// chunk into an incremental FFT/bake session. Polls for a confident loop every
// few seconds of audio and STOPS the render the moment one is found - so a tune
// that loops early costs a fraction of the full analysis window. Returns the
// session's rows + timing (never the whole PCM: only ~6 MB of frame rows are kept).
async function renderAndAnalyze(sidBytes, bake, options = {}) {
    const { sampleRate, maxSeconds, subtune, numBars, maxHeight, minLoopSeconds, onProgress, signal } = options;
    if (signal && signal.aborted) throw abortError();

    const module = await loadSidplayfpModule();
    const cwrap = module.cwrap;
    const api = {
        init:       cwrap('audio_init', null, ['number']),
        load:       cwrap('audio_load_sid', 'number', ['number', 'number']),
        setSubtune: cwrap('audio_set_subtune', null, ['number']),
        setSampling: cwrap('audio_set_sampling_method', null, ['number']),
        generate:   cwrap('audio_generate', 'number', ['number', 'number']),
        isNtsc:     cwrap('audio_get_is_ntsc', 'number', []),
        cleanup:    cwrap('audio_cleanup', null, []),
    };

    api.init(sampleRate);
    // Fast sampling (method 0): the bake only reads a 40-bar spectrum up to ~5.5 kHz,
    // so audio fidelity is irrelevant here - and the render is ~90% of the bake time.
    // Fast vs the default interpolate is a free ~10% off every bake. (No-op on an
    // older engine that lacks the export.)
    try { if (api.setSampling) api.setSampling(0); } catch (e) { /* best-effort */ }
    const sidPtr = module._malloc(sidBytes.length);
    module.HEAPU8.set(sidBytes, sidPtr);
    const loaded = api.load(sidPtr, sidBytes.length);
    if (module._free) module._free(sidPtr);
    if (loaded < 0) throw new Error(`spectrometer bake: audio_load_sid failed (${loaded})`);
    if (subtune) api.setSubtune(subtune);
    // PAL vs NTSC decides the raster grid the bars are baked on (the C64 replays
    // one keyframe per 2 raster frames): PAL 50.1245 Hz, NTSC 59.826 Hz - not a
    // round 50, or the bars drift ~0.2 s per loop.
    const isNtsc = api.isNtsc() ? 1 : 0;
    const frameHz = isNtsc ? 59.826 : 50.1245;

    const session = bake.createBakeSession(sampleRate, { numBars, maxHeight, frameHz, maxSeconds, minLoopSeconds });

    const CHUNK = 8192;
    const bufPtr = module._malloc(CHUNK * 2);   // int16 samples
    const chunk = new Float32Array(CHUNK);
    const total = Math.floor(maxSeconds * sampleRate);
    const CHECK = Math.floor(sampleRate * 15);  // poll for a loop every ~15 s of audio
    // A proposed loop is not accepted the moment it appears. detectLoop needs only
    // TWO passes of a period to propose it, and two passes is a repeat, not a loop:
    // an A-A-B tune (plays a phrase twice, then develops) looks exactly like a loop
    // until B arrives. Stopping the render on first sight then freezes that mistake,
    // because the detector never gets to see the audio that would refute it -
    // Blending_Mode.sid proposes a 7.2 s loop at the 15 s poll and correctly reports
    // "no loop" at every poll from 20 s on.
    //
    // So a candidate must survive until the stream holds CONFIRM_CYCLES passes plus
    // detectLoop's own ~4 s tail window, and must still be the same period at a later
    // poll. Confirming is only worth what it costs: CONFIRM_CAP_SECONDS bounds the
    // extra audio rendered, so short loops (where the false-positive risk lives, and
    // where confirming is cheap) get the full check, while a tune that repeats a
    // multi-minute phrase is taken near enough on first sight.
    const CONFIRM_CYCLES = 3;
    const CONFIRM_TAIL = 4;             // seconds; matches detectLoop's confirm window
    const CONFIRM_CAP_SECONDS = 60;     // most extra audio we'll render to confirm
    let pending = null;                 // { period, firstSeen } of the standing candidate
    // A tune that runs into ~10 s of unbroken digital silence has ended - stop the
    // render there (the fade-off path then trims the dead tail and wraps the timer
    // at the last musical frame, so the on-screen clock sticks instead of ticking
    // on into nothing). We only start counting once real audio has been heard, so a
    // few silent seconds of intro can never trip it.
    const SILENCE_LEVEL = 0.004;                // |sample| under this ~= silence (~-48 dB)
    const SILENCE_STOP = Math.floor(sampleRate * 10);
    let rendered = 0, sinceYield = 0, sinceCheck = 0, foundLoop = false;
    let silentRun = 0, sawSignal = false, foundSilence = false;
    // Free the WASM buffer and release the audio engine even if we bail early (a
    // user cancel throws mid-render), so the next analysis starts from a clean slate.
    try {
        while (rendered < total) {
            const want = Math.min(CHUNK, total - rendered);
            const got = api.generate(bufPtr, want);
            if (got <= 0) break;
            // Re-derive the view each iteration in case the heap grew/detached.
            const view = new Int16Array(module.HEAPU8.buffer, bufPtr, got);
            let peak = 0;
            for (let i = 0; i < got; i++) {
                const s = view[i] / 32768;
                chunk[i] = s;
                const a = s < 0 ? -s : s;
                if (a > peak) peak = a;
            }
            session.feed(chunk.subarray(0, got));
            rendered += got;
            // Long-silence early exit (only after the tune has actually made sound).
            if (peak >= SILENCE_LEVEL) { sawSignal = true; silentRun = 0; }
            else if (sawSignal && (silentRun += got) >= SILENCE_STOP) {
                foundSilence = true;
                onProgress('Silence detected — the tune has ended', 1,
                    { seconds: rendered / sampleRate, totalSeconds: maxSeconds, loopFound: true });
                break;
            }
            if ((sinceCheck += got) >= CHECK) {
                sinceCheck = 0;
                const loop = session.tryLoop();
                const secs = rendered / sampleRate;
                if (!loop) {
                    // The candidate was refuted by the audio since the last poll (an
                    // A-A-B tune reaching B). Drop it and keep scanning.
                    pending = null;
                } else {
                    const period = Math.max(1, loop.loopEnd - loop.loopStart) / frameHz;
                    if (!pending || Math.abs(period - pending.period) > Math.max(0.1, period * 0.02)) {
                        pending = { period, firstSeen: secs };
                    }
                    const confirmedAt = Math.min(
                        (loop.loopStart / frameHz) + CONFIRM_CYCLES * period + CONFIRM_TAIL,
                        pending.firstSeen + CONFIRM_CAP_SECONDS);
                    if (secs >= confirmedAt) {
                        foundLoop = true;
                        // Explain the early exit: we found the tune's repeat point, so there's
                        // no need to render the rest - one loop is all the visualization needs.
                        // loopFound lets the UI hold this message on screen for a beat.
                        onProgress('Loop found — no need to scan any further', 1,
                            { seconds: secs, totalSeconds: maxSeconds, loopFound: true });
                        break;
                    }
                    onProgress('Possible loop found — checking it holds', rendered / total,
                        { seconds: secs, totalSeconds: maxSeconds });
                }
            }
            if ((sinceYield += got) >= sampleRate * 4) {
                sinceYield = 0;
                onProgress('Analysing SID music', rendered / total,
                    { seconds: rendered / sampleRate, totalSeconds: maxSeconds });
                // MessageChannel-based yield (see spectrometer-bake.js): unlike
                // setTimeout(0), it isn't throttled when the tab is backgrounded, so
                // a render started before the user tabs away keeps running full-speed.
                await bake.yieldToEventLoop();
                // The user pressed Cancel while we were yielded: stop now (finally
                // cleans up) and let the caller decide what a cancel means.
                if (signal && signal.aborted) throw abortError();
            }
        }
    } finally {
        if (module._free) module._free(bufPtr);
        try { api.cleanup(); } catch (e) { /* best-effort */ }
    }

    return {
        numBars, frameHz, isNtsc,
        rows: session.rows(),
        renderedSeconds: session.fedSeconds(),
        hitCap: !foundLoop && rendered >= total,
    };
}
