// spectrometer-bake-core.js - engine-agnostic render + analyse + bake pipeline for
// the baked FFT spectrometer. This is the part that does the work; it has no DOM
// dependency, so the same code runs inside the Web Worker
// (spectrometer-bake-worker.js) and, when Workers are unavailable, directly on the
// page (spectrometer-bake-runner.js falls back to it).
//
// The caller supplies `loadEngine(name)`, which resolves to an initialised
// Emscripten module exposing the audio_* API. Both SID engines expose the same
// surface, so everything below is written against that and never names a module:
//
//   'fp' (default) - libsidplayfp + reSIDfp (sidplayfp.wasm), the same engine that
//                    drives playback. It runs a real C64 with KERNAL/CIA behind it,
//                    so it plays everything.
//   'resid'        - the lightweight reSID core inside sidquake.wasm. Measured ~2.1x
//                    faster end to end (the render is ~90% of a bake), but it has no
//                    C64 environment, so it is NOT equivalent - see below.
//
// Why 'fp' is the default despite being twice as slow. Measured over 40 tunes,
// analysing each on both engines:
//
//   29/40  identical loop verdict and stored length
//    8/40  same verdict, different stored length (they agree on the loop PERIOD but
//          disagree where the intro ends, so one stores more bars than the other -
//          which can cost a level of spectral detail in the export)
//    3/40  different verdict outright (one finds a loop, the other doesn't)
//   plus 2 tunes that render as pure SILENCE through reSID, because their player
//          needs the C64 environment reSID hasn't got
//
// So reSID gets a materially different bake on roughly a quarter of tunes. That is
// too much to inflict by default on output the user can't easily eyeball, so the
// speed is opt-in. The silence case is caught automatically (renderWithFallback).
//
// The two engines' filters differ, so they produce different spectra and therefore
// different baked bars - which is why the engine is part of the cache key below and
// of the analysis the UI shows.

import * as bake from './spectrometer-bake.js';

export const DEFAULT_ENGINE = 'fp';
export const ENGINES = ['resid', 'fp'];
export const normalizeEngine = (e) => (ENGINES.includes(e) ? e : DEFAULT_ENGINE);

// Thrown when the caller aborts a render via options.signal (an AbortSignal).
// Named 'AbortError' so callers can tell a user cancel from a genuine failure.
export function abortError() {
    const e = new Error('Analysis cancelled');
    e.name = 'AbortError';
    return e;
}

// The three 32-byte PSID/RSID header strings: name, author, released. They sit
// at a fixed offset in every version of the format and cannot change a single
// sample of the audio.
const HEADER_TEXT_FROM = 0x16;
const HEADER_TEXT_TO = 0x76;   // exclusive

// Cheap FNV-1a content hash so a fresh Uint8Array of the same tune still hits.
// The title/author/release strings are skipped: the bytes come from
// createModifiedSID(), so hashing them meant typing in the title threw away a
// finished render and started the whole thing again. Everything else in the
// header - load/init/play addresses, song count, speed flags, the v2 chip
// fields - does change the audio, so it stays in.
export function tuneKey(bytes, subtune, sampleRate, maxSeconds, minLoopSeconds, engine) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        if (i >= HEADER_TEXT_FROM && i < HEADER_TEXT_TO) continue;
        h ^= bytes[i]; h = Math.imul(h, 0x01000193);
    }
    // minLoopSeconds (x10 -> integer) is part of the key: it changes the render's
    // loop early-exit point, so a different threshold must re-render, not reuse.
    // The engine is in the key because the two SID cores render different audio.
    for (const e of [subtune, sampleRate, maxSeconds, bytes.length, Math.round((minLoopSeconds || 2) * 10)]) {
        h ^= (e | 0); h = Math.imul(h, 0x01000193);
    }
    for (let i = 0; i < engine.length; i++) { h ^= engine.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
}

// When a proposed loop may be believed, in seconds of audio rendered. A candidate
// is never taken the moment it appears: detectLoop needs only TWO passes of a
// period to propose it, and two passes is a repeat, not a loop. An A-A-B tune
// (plays a phrase twice, then develops) looks exactly like a loop until B arrives,
// and stopping the render on first sight freezes that mistake, because the detector
// never gets to see the audio that would refute it - Blending_Mode.sid proposes a
// 7.2 s loop at the 15 s poll and correctly reports "no loop" at every poll from
// 20 s on.
//
// Two requirements, whichever lands later:
//
//   CYCLES passes of the period plus detectLoop's own ~4 s tail window, so the
//   stream holds more of the loop than the detector needed to propose it. Bounded
//   by CAP_SECONDS: a tune that repeats a multi-minute phrase is taken near enough
//   on sight rather than rendering three more passes of it.
//
//   The candidate has to OUTLIVE the audio it took to appear - half as much again,
//   between PERSIST_MIN and PERSIST_MAX. The cycles rule alone is satisfied on
//   first sight for any short period, so nothing actually held a short candidate
//   up to a later poll: Masoka_Tango (Merman) proposed a 7.7 s loop at its 45 s
//   poll, was believed on the spot, and a 177 s tune was measured as 7.7 s long.
//   A riff that only surfaces deep into a tune is exactly the one that needs more
//   music before it can be trusted, so the wait scales with when it turned up.
export function loopConfirmSeconds(loopStartSeconds, period, firstSeen) {
    const CYCLES = 3;
    const TAIL = 4;                 // seconds; matches detectLoop's confirm window
    const CAP_SECONDS = 60;         // most extra audio the cycles rule may ask for
    const PERSIST_MIN = 15, PERSIST_MAX = 90;
    const cycles = Math.min(loopStartSeconds + CYCLES * period + TAIL, firstSeen + CAP_SECONDS);
    const persist = firstSeen + Math.min(PERSIST_MAX, Math.max(PERSIST_MIN, firstSeen * 0.5));
    return Math.max(cycles, persist);
}

// Shortest render we'll accept before calling an engine's attempt at a tune a
// failure. The silence stop needs 10 s of quiet on top of whatever played, so a
// render that ends this early made essentially no music at all.
const DEAD_RENDER_SECONDS = 15;

// Render the tune through the chosen SID engine (far faster than realtime), feeding
// each chunk into an incremental FFT/bake session. Polls for a confident loop and
// STOPS the render the moment one is found - so a tune that loops early costs a
// fraction of the full analysis window. Returns the session's row store + timing
// (never the whole PCM: only the per-frame rows are kept).
async function renderAndAnalyze(sidBytes, loadEngine, options = {}) {
    const { sampleRate, maxSeconds, subtune, numBars, maxHeight, minLoopSeconds, engine, onProgress,
        signal, stopSignal } = options;
    if (signal && signal.aborted) throw abortError();

    const module = await loadEngine(engine);
    const cwrap = module.cwrap;
    const api = {
        init:        cwrap('audio_init', null, ['number']),
        load:        cwrap('audio_load_sid', 'number', ['number', 'number']),
        setSubtune:  cwrap('audio_set_subtune', null, ['number']),
        setSampling: cwrap('audio_set_sampling_method', null, ['number']),
        generate:    cwrap('audio_generate', 'number', ['number', 'number']),
        isNtsc:      cwrap('audio_get_is_ntsc', 'number', []),
        cleanup:     cwrap('audio_cleanup', null, []),
    };

    api.init(sampleRate);
    // Fast sampling (method 0): the bake only reads a 40-bar spectrum up to ~5.5 kHz,
    // so audio fidelity is irrelevant here. (No-op on an engine that ignores it.)
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
    // Loop poll interval. A poll costs O(frames analysed so far), so a fixed 15 s
    // grid makes the total polling cost quadratic in the scan length: on a 20-minute
    // scan the last polls each cost more than the 15 s of audio they follow. Letting
    // the interval grow with the stream (1/8 of what's been rendered, capped) keeps
    // polling a roughly constant fraction of the render instead. Short tunes - where
    // almost every early exit happens - are unaffected, because they exit while the
    // interval is still at its 15 s floor.
    const CHECK_MIN = Math.floor(sampleRate * 15);
    const CHECK_MAX = Math.floor(sampleRate * 60);
    const checkInterval = (renderedSamples) =>
        Math.min(CHECK_MAX, Math.max(CHECK_MIN, Math.floor(renderedSamples / 8)));
    let pending = null;                 // { period, firstSeen } of the standing candidate
    // A tune that runs into ~10 s of unbroken digital silence has ended - stop the
    // render there (the fade-off path then trims the dead tail and wraps the timer
    // at the last musical frame, so the on-screen clock sticks instead of ticking
    // on into nothing). We only start counting once real audio has been heard, so a
    // few silent seconds of intro can never trip it.
    const SILENCE_LEVEL = 0.004;                // |sample| under this ~= silence (~-48 dB)
    const SILENCE_STOP = Math.floor(sampleRate * 10);
    // A tune that has not made a sound YET is a different case from one that has
    // stopped, and it used to be handled by not handling it: the stop below was
    // gated on sawSignal, so a render that was silent from the first sample never
    // ended early, never qualified as a dead render, and never triggered the
    // libsidplayfp rescue. It burned the whole scan budget and then reported a
    // length of zero. Give it its own, more patient threshold - a tune really can
    // open with a long quiet passage, and if we cut one short the rescue re-scans
    // it on the accurate engine anyway.
    const NEVER_SOUNDED_STOP = SILENCE_STOP * 2;
    let rendered = 0, sinceYield = 0, sinceCheck = 0, foundLoop = false;
    let silentRun = 0, sawSignal = false, stoppedOnSilence = false;
    // "Stop searching" - distinct from Cancel. Cancel throws the render away;
    // this keeps what has been rendered and analyses that, which is what someone
    // watching a long tune's scan actually wants.
    let stoppedEarly = false;
    // The Int16 view onto the engine's output buffer is re-derived only when the WASM
    // heap actually moves (a grow detaches the old ArrayBuffer), not once per chunk.
    let view = null, viewBuffer = null;
    // Free the WASM buffer and release the audio engine even if we bail early (a
    // user cancel throws mid-render), so the next analysis starts from a clean slate.
    try {
        while (rendered < total) {
            const want = Math.min(CHUNK, total - rendered);
            const got = api.generate(bufPtr, want);
            if (got <= 0) break;
            if (viewBuffer !== module.HEAPU8.buffer) {
                viewBuffer = module.HEAPU8.buffer;
                view = new Int16Array(viewBuffer, bufPtr, CHUNK);
            }
            let peak = 0;
            for (let i = 0; i < got; i++) {
                const s = view[i] / 32768;
                chunk[i] = s;
                const a = s < 0 ? -s : s;
                if (a > peak) peak = a;
            }
            session.feed(chunk.subarray(0, got));
            rendered += got;
            // extra.news marks a progress event that says what the scan FOUND
            // rather than where it has got to: 'maybe' for a candidate loop still
            // being checked, 'found' for something settled. The UI keeps those on
            // their own line instead of letting them flash through the counter.
            // Long-silence early exit (only after the tune has actually made sound).
            if (peak >= SILENCE_LEVEL) { sawSignal = true; silentRun = 0; }
            else if ((silentRun += got) >= (sawSignal ? SILENCE_STOP : NEVER_SOUNDED_STOP)) {
                stoppedOnSilence = true;
                onProgress(sawSignal ? 'Silence detected — the tune has ended'
                                     : 'No audio from this engine — rescanning', 1,
                    { seconds: rendered / sampleRate, totalSeconds: maxSeconds,
                      loopFound: sawSignal, news: 'found' });
                break;
            }
            if ((sinceCheck += got) >= checkInterval(rendered)) {
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
                    const confirmedAt = loopConfirmSeconds(loop.loopStart / frameHz, period, pending.firstSeen);
                    if (secs >= confirmedAt) {
                        foundLoop = true;
                        // Explain the early exit: we found the tune's repeat point, so there's
                        // no need to render the rest - one loop is all the visualization needs.
                        // loopFound lets the UI hold this message on screen for a beat.
                        onProgress('Loop found — no need to scan any further', 1,
                            { seconds: secs, totalSeconds: maxSeconds, loopFound: true, news: 'found' });
                        break;
                    }
                    onProgress('Possible loop found — checking it holds', rendered / total,
                        { seconds: secs, totalSeconds: maxSeconds, news: 'maybe' });
                }
            }
            if ((sinceYield += got) >= sampleRate * 4) {
                sinceYield = 0;
                onProgress('Analysing SID music', rendered / total,
                    { seconds: rendered / sampleRate, totalSeconds: maxSeconds });
                // In the Worker this only exists so an abort message can be delivered
                // between chunks; on the fallback (main-thread) path it is also what
                // keeps the page responsive. See yieldToEventLoop in spectrometer-bake.js.
                await bake.yieldToEventLoop();
                // The user pressed Cancel while we were yielded: stop now (finally
                // cleans up) and let the caller decide what a cancel means.
                if (signal && signal.aborted) throw abortError();
                if (stopSignal && stopSignal.aborted) {
                    stoppedEarly = true;
                    onProgress('Stopped — using what has been scanned so far', 1,
                        { seconds: rendered / sampleRate, totalSeconds: maxSeconds,
                          loopFound: true, news: 'found' });
                    break;
                }
            }
        }
    } finally {
        if (module._free) module._free(bufPtr);
        try { api.cleanup(); } catch (e) { /* best-effort */ }
    }

    return {
        numBars, frameHz, isNtsc, engine,
        rows: session.rows(),
        renderedSeconds: session.fedSeconds(),
        hitCap: !foundLoop && !stoppedEarly && rendered >= total,
        // The user stopped the scan and asked for what was found so far, so
        // nothing downstream should treat this as "we searched everything".
        stoppedEarly,
        // Nothing usable came out of this engine - see renderWithFallback. Either
        // the tune never made a sound at all, or it went quiet almost immediately.
        deadRender: !sawSignal || (stoppedOnSilence && (rendered / sampleRate) < DEAD_RENDER_SECONDS),
    };
}

// Render on the requested engine, but fall back to libsidplayfp if the tune comes
// out silent.
//
// The lightweight reSID core has no C64 environment behind it - no KERNAL, no
// accurate CIA timing - so a tune whose player leans on any of that produces
// nothing at all through it, and the bake would silently ship a PRG with dead bars.
// libsidplayfp runs a real C64, so it is the safety net. This costs a wasted ~1.5 s
// render on the tunes where it triggers and nothing at all everywhere else.
async function renderWithFallback(sidBytes, loadEngine, options) {
    const first = await renderAndAnalyze(sidBytes, loadEngine, options);
    if (!first.deadRender || options.engine === 'fp') return first;
    options.onProgress('Tune needs the accurate engine — rescanning', 0,
        { seconds: 0, totalSeconds: options.maxSeconds });
    const second = await renderAndAnalyze(sidBytes, loadEngine, { ...options, engine: 'fp' });
    // If libsidplayfp finds nothing either, the tune really is silent; keep its
    // result so what the UI reports comes from the engine we trust.
    second.engineFallback = 'fp';
    return second;
}

// One bake core = one render cache. The worker owns a single instance, so the
// analyse pass (#2, pricing the fps options) and the later export bake share one
// render of the tune.
export function createBakeCore(loadEngine) {
    // cache.rows : { key, numBars, engine, rows, frameHz, isNtsc, renderedSeconds, hitCap }
    // cache.bakes: Map geometryKey -> bake result, for the rows currently loaded
    //
    // `slots` is a small LRU of finished renders, keyed by tune+geometry. A
    // single slot meant A -> B -> A re-rendered A from scratch, which is the
    // most common thing anyone does while comparing two tunes. Rows are the
    // expensive part (~90% of a bake), so a handful of them is worth the memory:
    // a 12-minute tune at 50 Hz over 40 bars is about 1.4 MB.
    const MAX_SLOTS = 4;
    const cache = { rows: null, bakes: new Map() };
    const slots = new Map();   // slotKey -> { rows, bakes }

    function remember(slotKey) {
        slots.delete(slotKey);
        slots.set(slotKey, { rows: cache.rows, bakes: cache.bakes });
        while (slots.size > MAX_SLOTS) slots.delete(slots.keys().next().value);
    }

    // Render this tune to FFT rows once (incrementally, stopping as soon as a loop is
    // confirmed) and cache them. Re-render only for a new tune, a different bar count,
    // or a different SID engine. Both the full bake and the loop-only analysis share
    // this - the render is ~90% of the cost, so pricing the fps options and then
    // exporting reuse one render.
    async function ensureRows(sidBytes, options = {}) {
        // A job cancelled before it started must not come back with an answer,
        // and a cache hit would otherwise sail straight past the render's own
        // abort checks and report success.
        if (options.signal && options.signal.aborted) throw abortError();
        const sampleRate = options.sampleRate || 44100;
        const maxSeconds = options.maxSeconds || 720;
        const numBars = options.numBars || 40;
        const maxHeight = options.maxHeight || 111;
        const subtune = options.subtune || 0;
        const minLoopSeconds = options.minLoopSeconds || 2;
        const engine = normalizeEngine(options.engine);
        const onProgress = options.onProgress || (() => {});
        const key = tuneKey(sidBytes, subtune, sampleRate, maxSeconds, minLoopSeconds, engine);
        const slotKey = `${key}|${numBars}`;
        if (!cache.rows || cache.rows.key !== key || cache.rows.numBars !== numBars) {
            const held = slots.get(slotKey);
            if (held) {
                cache.rows = held.rows;
                cache.bakes = held.bakes;
            } else {
                cache.rows = await renderWithFallback(sidBytes, loadEngine, {
                    sampleRate, maxSeconds, subtune, numBars, maxHeight, minLoopSeconds, engine,
                    onProgress, signal: options.signal,
                });
                cache.rows.key = key;
                cache.bakes = new Map();
            }
        }
        remember(slotKey);
        return { numBars, maxHeight };
    }

    return {
        // Analysis-only entry point (#2/#3): render + loop detection ONLY - no vector
        // quantization - and return just the timing summary the UI needs (length, loop
        // point, keyframe count) to price the fps options before any PRG is generated.
        // `storedSeconds` is the fps-independent stored duration - pass it to
        // estimateBakeBytes() to price each fps option (#4).
        async analyze(sidBytes, options = {}) {
            await ensureRows(sidBytes, options);
            const r = bake.analyzeRows(cache.rows.rows, {
                numBars: options.numBars, maxHeight: options.maxHeight,
                frameHz: cache.rows.frameHz, framesPerKeyframe: options.framesPerKeyframe,
                minLoopSeconds: options.minLoopSeconds,
                outputMaxSeconds: options.outputMaxSeconds,
                // Measuring the tune rather than pricing a stream to store: see
                // resolveKeyframes. Callers pricing a bake leave this off.
                measureOnly: options.measureOnly,
                analyzedSeconds: cache.rows.renderedSeconds, hitCap: cache.rows.hitCap,
            });
            return {
                looped: r.looped,
                fadedOut: r.fadedOut,
                // The music was still going where the analysis had to stop, so
                // nothing was resolved - neither a loop nor an ending.
                truncated: r.truncated,
                loopStart: r.loopStart,               // keyframes
                numKeyframes: r.numKeyframes,
                keyframeHz: r.keyframeHz,
                frameHz: cache.rows.frameHz,
                isNtsc: cache.rows.isNtsc || 0,
                engine: cache.rows.engine,
                storedSeconds: r.storedSeconds,                        // intro+loop, or fade-capped
                loopStartSeconds: r.loopStart / r.keyframeHz,          // where the repeat begins
                loopSeconds: (r.numKeyframes - r.loopStart) / r.keyframeHz,
                analyzedSeconds: r.analyzedSeconds,
                cappedAtMaxSeconds: r.cappedAtMaxSeconds,
                // The user pressed "use what it has found" rather than the scan
                // running out of window, which is a different thing to say.
                stoppedEarly: !!cache.rows.stoppedEarly,
                // Frame-exact loop / length, for the song-length tool.
                frameHzExact: cache.rows.frameHz,
                loopStartFrames: r.loopStartFrames,
                loopEndFrames: r.loopEndFrames,
                loopFrames: r.loopFrames,
                lengthFrames: r.lengthFrames,
                lengthSeconds: r.lengthSeconds,
                // Set when the requested engine rendered silence and we re-scanned.
                engineFallback: cache.rows.engineFallback || null,
            };
        },

        async renderAndBake(sidBytes, options = {}) {
            const onProgress = options.onProgress || (() => {});
            const { numBars, maxHeight } = await ensureRows(sidBytes, options);

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
            if (cache.bakes.has(geomKey)) return cache.bakes.get(geomKey);

            const result = await bake.bakeRows(cache.rows.rows, {
                numBars, maxHeight, frameHz: cache.rows.frameHz, framesPerKeyframe,
                outputMaxSeconds: options.outputMaxSeconds,
                minLoopSeconds: options.minLoopSeconds,
                forceLoop: !!options.forceLoop,
                analyzedSeconds: cache.rows.renderedSeconds,
                hitCap: cache.rows.hitCap,
                onProgress,
            });
            result.engine = cache.rows.engine;
            cache.bakes.set(geomKey, result);
            return result;
        },
    };
}
