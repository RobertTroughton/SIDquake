// spectrometer-bake-runner.js - browser entry point for the baked FFT spectrometer.
//
// The actual work (SID render -> FFT rows -> loop detection -> vector quantization)
// lives in spectrometer-bake-core.js. This file only decides WHERE it runs:
//
//   - normally, in a Web Worker (spectrometer-bake-worker.js), so a multi-minute
//     bake never blocks the page;
//   - if Workers, dynamic import() inside one, or importScripts() are unavailable,
//     on the main thread instead, exactly as before.
//
// Both paths return the same shapes, so callers (ui.js, prg-builder.js) don't care
// which one ran.
//
// The render cache lives with whichever core is in use. In the worker that is
// naturally one instance for the whole page. On the fallback path it has to be a
// stable global rather than a module variable: the dev cache-buster appends ?t=<now>
// to every dynamic import, so ui.js (analyse) and prg-builder.js (export bake) load
// DIFFERENT module instances, and a module-level cache would be empty in the second
// one and re-render the tune.

import { createBakeCore, DEFAULT_ENGINE, normalizeEngine, abortError } from './spectrometer-bake-core.js';

export { DEFAULT_ENGINE, normalizeEngine };

// Options are structured-cloned to the worker, so the two function-valued ones have
// to be stripped; they're re-attached on the worker side from the message channel.
function cloneableOptions(options) {
    const { onProgress, signal, ...rest } = options || {};
    return rest;
}

// ---------------------------------------------------------------------------
// Worker transport

// All of this lives on a global, not in module scope, for the same reason the render
// cache does: with the dev cache-buster, ui.js and prg-builder.js hold DIFFERENT
// instances of this module. They share one worker (it is reached through this
// object), so the pending-job table has to be shared too - otherwise only the
// instance that happened to create the worker would ever see a reply, and jobs
// started from the other one would hang forever.
const workerState = (() => {
    const g = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (!g.__spectrometerWorker) {
        g.__spectrometerWorker = { promise: null, worker: null, failed: false, jobs: new Map(), nextId: 1 };
    }
    return g.__spectrometerWorker;
})();

// Resolves to a live worker, or null if this browser can't run one (the caller then
// uses the main-thread core). Only ever probed once per page.
function getWorker() {
    if (workerState.failed) return Promise.resolve(null);
    if (workerState.promise) return workerState.promise;
    workerState.promise = new Promise((resolve) => {
        if (typeof Worker === 'undefined') { workerState.failed = true; resolve(null); return; }
        let worker;
        try {
            worker = new Worker(new URL('./spectrometer-bake-worker.js', import.meta.url));
        } catch (e) {
            workerState.failed = true; resolve(null); return;
        }
        // The worker proves it can dynamic-import the bake module and importScripts
        // the engine glue before we commit to it; anything else means fall back.
        const settle = (ok) => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            if (ok) {
                workerState.worker = worker;
                worker.addEventListener('message', onJobMessage);
                resolve(worker);
            } else {
                workerState.failed = true;
                try { worker.terminate(); } catch (e) { /* already gone */ }
                resolve(null);
            }
        };
        const onMessage = (ev) => {
            if (!ev.data) return;
            if (ev.data.type === 'ready') settle(true);
            else if (ev.data.type === 'unsupported') {
                console.warn('Spectrometer bake worker unavailable, running on the main thread:', ev.data.message);
                settle(false);
            }
        };
        const onError = () => settle(false);
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        // The dev cache-buster is a page-side helper; hand the worker its token so it
        // busts the URLs it loads too.
        const cb = (typeof window !== 'undefined' && window.cacheBust) || null;
        const token = cb ? (cb('x').split('?')[1] || '') : '';
        worker.postMessage({ type: 'init', cacheBust: token });
    });
    return workerState.promise;
}

function onJobMessage(ev) {
    const msg = ev.data || {};
    const job = workerState.jobs.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') {
        try { job.onProgress(msg.label, msg.fraction, msg.extra); } catch (e) { /* UI callback threw; keep baking */ }
    } else if (msg.type === 'done') {
        workerState.jobs.delete(msg.id);
        job.resolve(msg.result);
    } else if (msg.type === 'error') {
        workerState.jobs.delete(msg.id);
        const e = new Error(msg.message);
        e.name = msg.name || 'Error';
        job.reject(e);
    }
}

function runInWorker(worker, op, sidBytes, options) {
    const id = workerState.nextId++;
    const onProgress = options.onProgress || (() => {});
    const signal = options.signal;
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(abortError()); return; }
        workerState.jobs.set(id, { resolve, reject, onProgress });
        if (signal) {
            signal.addEventListener('abort', () => {
                worker.postMessage({ type: 'abort', id });
            }, { once: true });
        }
        // Copy the SID bytes so the caller keeps its own array usable, and transfer
        // the copy rather than structured-cloning it.
        const copy = sidBytes.slice();
        worker.postMessage({ type: 'run', id, op, sidBytes: copy.buffer, options: cloneableOptions(options) },
            [copy.buffer]);
    });
}

// ---------------------------------------------------------------------------
// Main-thread fallback core (also the shape the worker path mirrors)

const fallbackCore = (() => {
    const g = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (!g.__spectrometerFallbackCore) {
        g.__spectrometerFallbackCore = createBakeCore(async (name) => loadEngineOnPage(name));
    }
    return g.__spectrometerFallbackCore;
})();

// Page-side engine loader, used only on the fallback path. Mirrors the worker's
// ENGINE_MODULES table; kept separate because loading a script into the page is
// nothing like importScripts().
const PAGE_ENGINES = {
    resid: { script: 'sidquake.js',  global: 'SIDquakeModule' },
    fp:    { script: 'sidplayfp.js', global: 'SIDPlayfpModule' },
};
const pageEngineInstances = new Map();

async function loadEngineOnPage(name) {
    const spec = PAGE_ENGINES[name] || PAGE_ENGINES.resid;
    if (!pageEngineInstances.has(name)) {
        pageEngineInstances.set(name, (async () => {
            if (typeof self[spec.global] !== 'function') {
                if (typeof window !== 'undefined' && window.loadScript) {
                    await window.loadScript(spec.script);
                } else {
                    // Resolved against THIS module's URL, not the document's: the
                    // engine glue sits next to it, and a page served from another
                    // directory would otherwise miss it.
                    const url = (window.cacheBust || (x => x))(new URL(spec.script, import.meta.url).href);
                    await new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = url;
                        s.onload = resolve;
                        s.onerror = () => reject(new Error(`failed to load ${spec.script}`));
                        document.head.appendChild(s);
                    });
                }
            }
            const factory = self[spec.global];
            if (typeof factory !== 'function') throw new Error(`${spec.script} did not define ${spec.global}`);
            // A dedicated instance for the bake, so it never disturbs the module the
            // page is using for playback / analysis.
            return factory();
        })());
    }
    return pageEngineInstances.get(name);
}

// The worker sends a trimmed, structured-cloneable result; the fallback core returns
// the baker's full object (which also carries a reconstruct() closure and the raw
// keyframe grid). Normalize both to the same shape so callers can't accidentally
// depend on something that only exists on one path.
function pickBakeResult(r) {
    return {
        codebook: r.codebook, indices: r.indices,
        numBars: r.numBars, maxHeight: r.maxHeight, K: r.K,
        segments: r.segments, segmentWidth: r.segmentWidth,
        keyframeHz: r.keyframeHz, numKeyframes: r.numKeyframes,
        loopStart: r.loopStart, framesPerKeyframe: r.framesPerKeyframe,
        looped: r.looped, fadedOut: r.fadedOut, forcedLoop: r.forcedLoop,
        analyzedKeyframes: r.analyzedKeyframes, analyzedSeconds: r.analyzedSeconds,
        cappedAtMaxSeconds: r.cappedAtMaxSeconds, totalBytes: r.totalBytes,
        engine: r.engine,
    };
}

// ---------------------------------------------------------------------------
// Public API (unchanged for callers)

// sidBytes: Uint8Array of a valid .sid file (e.g. analyzer.createModifiedSID()).
// options: { subtune, sampleRate=44100, maxSeconds, outputMaxSeconds, numBars,
//            maxHeight, engine, onProgress(label, fraction, extra) } . extra (render
//            stage only) = { seconds, totalSeconds, loopFound? } - elapsed tune time
//            scanned vs the search cap, so the UI can show time instead of a %
//            (the render stops early on a confirmed loop, making a bare % jumpy).
// Returns the bake result { codebook, indices, K, numBars, ... }.
export async function renderAndBakeSpectrometer(sidBytes, options = {}) {
    const opts = { ...options, engine: normalizeEngine(options.engine) };
    const worker = await getWorker();
    if (worker) return runInWorker(worker, 'bake', sidBytes, opts);
    return pickBakeResult(await fallbackCore.renderAndBake(sidBytes, opts));
}

// Analysis-only entry point (#2/#3): the tune's loop / length summary, with no
// vector quantization. The heavy render is cached, so the later export bake for the
// same tune/bars/engine reuses it.
export async function analyzeSpectrometer(sidBytes, options = {}) {
    const opts = { ...options, engine: normalizeEngine(options.engine) };
    const worker = await getWorker();
    if (worker) return runInWorker(worker, 'analyze', sidBytes, opts);
    return fallbackCore.analyze(sidBytes, opts);
}
