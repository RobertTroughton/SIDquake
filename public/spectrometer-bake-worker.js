// spectrometer-bake-worker.js - runs the whole spectrometer bake (SID render, FFT,
// loop detection, vector quantization) off the main thread.
//
// The bake is minutes of solid CPU on a long tune. On the main thread that competes
// with rendering the page, so the work has to hand control back constantly just to
// keep the UI alive - which is what yieldToEventLoop() in spectrometer-bake.js is
// for, along with its MessageChannel-instead-of-setTimeout workaround for background
// tab throttling. In here none of that is load-bearing any more: the worker owns its
// thread, so the page stays responsive no matter how long the bake runs, and a
// backgrounded tab cannot throttle it.
//
// This is deliberately a CLASSIC worker, not a module worker: the Emscripten engine
// glue (sidquake.js / sidplayfp.js) is a plain script that assigns a global, which is
// exactly what importScripts() is for. The bake code itself is an ES module, loaded
// with dynamic import(). If either is unsupported the worker reports 'unsupported'
// at startup and spectrometer-bake-runner.js quietly falls back to running the same
// core on the main thread.
//
// The worker holds the render cache, so the analyse pass and the later export bake
// for the same tune share one render - the same arrangement the page used to get
// from a global.

/* eslint-env worker */

// Dev cache-buster token, supplied by the page (see window.cacheBust). Applied to
// every URL the worker loads so a local dev server can't serve stale bake code.
let CB = '';
const bust = (url) => (CB ? url + (url.includes('?') ? '&' : '?') + CB : url);

// name -> { script, global, wasm }. Both engines expose the same audio_* API.
const ENGINE_MODULES = {
    resid: { script: 'sidquake.js',   global: 'SIDquakeModule',   wasm: 'sidquake.wasm' },
    fp:    { script: 'sidplayfp.js',  global: 'SIDPlayfpModule',  wasm: 'sidplayfp.wasm' },
};

const engineInstances = new Map();   // name -> Promise<Module>

// Load and initialise one engine. The glue is built with -sENVIRONMENT="web", so it
// resolves its .wasm relative to an empty script directory; we pass locateFile
// explicitly to pin it to the worker's own directory rather than relying on that.
function loadEngine(name) {
    const spec = ENGINE_MODULES[name] || ENGINE_MODULES.resid;
    if (!engineInstances.has(name)) {
        engineInstances.set(name, (async () => {
            if (typeof self[spec.global] !== 'function') importScripts(bust(spec.script));
            const factory = self[spec.global];
            if (typeof factory !== 'function') throw new Error(`engine glue ${spec.script} did not define ${spec.global}`);
            return factory({
                locateFile: (path) => (path === spec.wasm ? bust(new URL(spec.wasm, self.location.href).href) : path),
            });
        })());
    }
    return engineInstances.get(name);
}

let corePromise = null;
async function getCore() {
    if (!corePromise) {
        corePromise = (async () => {
            const mod = await import(bust('./spectrometer-bake-core.js'));
            return mod.createBakeCore(loadEngine);
        })();
    }
    return corePromise;
}

// Jobs in flight, so an 'abort' message can cancel the matching run. The core takes
// an AbortSignal, and the render checks it at each yield point.
const running = new Map();   // id -> AbortController

// Runs are serialised: the core holds one engine and one live rows slot, so two
// renders at once would fight over both. The page happens to keep one analysis
// in flight today, but the worker must not depend on its caller behaving.
// Aborting a queued run is honoured before it ever starts.
let chain = Promise.resolve();
function enqueue(fn) {
    const next = chain.then(fn, fn);
    // Keep the chain alive: a run that throws must not stop the ones behind it.
    chain = next.catch(() => {});
    return next;
}

self.onmessage = (ev) => {
    const msg = ev.data || {};

    if (msg.type === 'init') {
        CB = typeof msg.cacheBust === 'string' ? msg.cacheBust : '';
        // Prove the two dynamic loading mechanisms actually work in this browser
        // before the page commits to the worker path.
        getCore().then(
            () => self.postMessage({ type: 'ready' }),
            (e) => self.postMessage({ type: 'unsupported', message: String(e && e.message || e) }));
        return;
    }

    if (msg.type === 'abort') {
        const ctl = running.get(msg.id);
        if (ctl) ctl.abort();
        return;
    }

    if (msg.type !== 'run') return;

    const { id, op, sidBytes, options } = msg;
    const ctl = new AbortController();
    // Registered now, not when the run starts, so an abort that arrives while
    // this is still queued is not lost.
    running.set(id, ctl);
    enqueue(async () => {
        try {
            const core = await getCore();
            const opts = {
                ...options,
                signal: ctl.signal,
                onProgress: (label, fraction, extra) =>
                    self.postMessage({ type: 'progress', id, label, fraction, extra }),
            };
            const bytes = new Uint8Array(sidBytes);
            if (op === 'analyze') {
                self.postMessage({ type: 'done', id, result: await core.analyze(bytes, opts) });
            } else {
                const r = await core.renderAndBake(bytes, opts);
                // The bake result carries a reconstruct() closure (and a large raw
                // keyframe grid) that structured clone can't take and nothing outside
                // the baker uses. Ship the packed bytes plus the geometry/timing the
                // exporter reads, and transfer the two big arrays instead of copying.
                //
                // Copy the two arrays before transferring: the render cache still owns
                // the originals, and a second export at the same geometry re-serves them
                // from that cache - transferring the originals would detach them.
                const result = {
                    codebook: r.codebook.slice(), indices: r.indices.slice(),
                    numBars: r.numBars, maxHeight: r.maxHeight, K: r.K,
                    segments: r.segments, segmentWidth: r.segmentWidth,
                    keyframeHz: r.keyframeHz, numKeyframes: r.numKeyframes,
                    loopStart: r.loopStart, framesPerKeyframe: r.framesPerKeyframe,
                    looped: r.looped, fadedOut: r.fadedOut, forcedLoop: r.forcedLoop,
                    analyzedKeyframes: r.analyzedKeyframes, analyzedSeconds: r.analyzedSeconds,
                    cappedAtMaxSeconds: r.cappedAtMaxSeconds, totalBytes: r.totalBytes,
                    engine: r.engine,
                };
                self.postMessage({ type: 'done', id, result },
                    [result.codebook.buffer, result.indices.buffer]);
            }
        } catch (e) {
            self.postMessage({
                type: 'error', id,
                name: (e && e.name) || 'Error',
                message: String((e && e.message) || e),
            });
        } finally {
            running.delete(id);
        }
    });
};
