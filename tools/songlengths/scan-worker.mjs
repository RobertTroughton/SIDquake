/*
 * Worker thread for tools/songlengths/scan.mjs.
 *
 * Owns one SID engine instance and one bake core, and analyses whatever subtune
 * the parent hands it. The parent feeds tasks one at a time (a task is seconds
 * of work, so the message round-trip is free and one-at-a-time gives perfect
 * load balancing across cores).
 *
 * Nothing here writes files: results go back to the parent, which owns the
 * append-only journal. That keeps crash recovery in one place.
 */

import { parentPort, workerData } from 'worker_threads';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

// public/*.js are ES modules living in a folder with no package.json "type", so
// Node re-parses each one and warns about it - three identical paragraphs per
// worker, which drowns the progress line. Drop just that warning; anything else
// still gets through.
process.removeAllListeners('warning');
process.on('warning', (w) => {
    if (w.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
    console.warn(w.stack || String(w));
});

const require = createRequire(import.meta.url);
const { publicDir, engine: defaultEngine, sampleRate, minBudgetSeconds, budgetMultiple,
        maxBudgetSeconds, minLoopSeconds } = workerData;

// The Emscripten glue is built with -sENVIRONMENT="web", so it tries to fetch its
// .wasm over HTTP. Handing it the bytes directly is all it needs to run under Node.
const GLUE = {
    resid: ['sidquake.js', 'sidquake.wasm'],
    fp: ['sidplayfp.js', 'sidplayfp.wasm'],
};
const engines = new Map();
async function loadEngine(name) {
    if (!engines.has(name)) {
        engines.set(name, (async () => {
            const [js, wasm] = GLUE[name] || GLUE.resid;
            const factory = require(path.join(publicDir, js));
            return factory({ wasmBinary: readFileSync(path.join(publicDir, wasm)) });
        })());
    }
    return engines.get(name);
}

// pathToFileURL, not a hand-built file:// string: Windows paths need the drive
// letter and backslashes handled properly.
const { createBakeCore } = await import(
    pathToFileURL(path.join(publicDir, 'spectrometer-bake-core.js')).href);

// One core per worker. Its render cache is keyed by tune+subtune+engine, so
// consecutive subtunes of the SAME sid still re-render (different subtune = a
// different key) - that is correct, they are different music.
const core = createBakeCore(loadEngine);

// How much audio to render looking for the loop. HVSC already tells us roughly
// how long the tune is, and confirming a loop needs a bit over two passes of it,
// so the scan renders a multiple of HVSC's figure rather than a flat cap for
// every tune. It is a hint, not a ceiling - their list is hand-curated and can be
// short - but there is no retry: a scan that hits --max-budget without resolving
// anything is just reported as capped, a lower bound rather than a measurement.
function firstBudget(hvscMs) {
    const hvscSeconds = (hvscMs || 0) / 1000;
    if (!hvscSeconds) return Math.min(maxBudgetSeconds, 300);
    return Math.min(maxBudgetSeconds, Math.max(minBudgetSeconds, hvscSeconds * budgetMultiple + 15));
}

async function runAnalysis(sidBytes, task, maxSeconds) {
    return core.analyze(sidBytes, {
        subtune: task.subtune,
        sampleRate,
        numBars: 40,
        maxHeight: 111,
        maxSeconds,
        minLoopSeconds,
        framesPerKeyframe: 2,
        engine: defaultEngine,
        onProgress: () => {},
    });
}

async function analyzeOne(task) {
    const sidBytes = new Uint8Array(await readFile(path.join(workerData.hvscDir, task.sidPath)));
    // Record PSID vs RSID per result so the journal is self-describing - the report
    // shouldn't have to go back to the files (or to scan.mjs's cache) to show it.
    const isRsid = sidBytes.length >= 4 &&
        sidBytes[0] === 0x52 && sidBytes[1] === 0x53 && sidBytes[2] === 0x49 && sidBytes[3] === 0x44;
    // An explicit budget (a --only recheck pass) overrides the HVSC-derived one.
    const maxSeconds = task.forceBudget || firstBudget(task.hvscMs);
    const r = await runAnalysis(sidBytes, task, maxSeconds);
    const frameHz = r.frameHzExact || r.frameHz;
    return {
        rsid: isRsid ? 1 : 0,
        md5: task.md5,
        sidPath: task.sidPath,
        subtune: task.subtune,
        hvscMs: task.hvscMs,
        // Our figures. lengthFrames is the authoritative one; ms is derived.
        ms: Math.round((r.lengthFrames / frameHz) * 1000),
        lengthFrames: r.lengthFrames,
        loopStartFrames: r.loopStartFrames,
        loopFrames: r.loopFrames,
        frameHz: Number(frameHz.toFixed(4)),
        isNtsc: r.isNtsc ? 1 : 0,
        looped: r.looped ? 1 : 0,
        fadedOut: r.fadedOut ? 1 : 0,
        // We stopped at the scan budget without resolving anything - treat the
        // number as a lower bound, not a measurement.
        capped: r.cappedAtMaxSeconds ? 1 : 0,
        scannedSeconds: Number(r.analyzedSeconds.toFixed(1)),
        budgetSeconds: Math.round(maxSeconds),
        engine: r.engineFallback || r.engine || defaultEngine,
        fellBack: r.engineFallback ? 1 : 0,
    };
}

parentPort.on('message', async (msg) => {
    if (msg.type === 'exit') { process.exit(0); return; }
    if (msg.type !== 'task') return;
    const started = Date.now();
    try {
        const result = await analyzeOne(msg.task);
        result.tookMs = Date.now() - started;
        // A recheck pass re-measures a subtune that is already in the journal, so
        // the reader needs to know which line is the later one.
        result.t = Date.now();
        parentPort.postMessage({ type: 'result', result });
    } catch (e) {
        parentPort.postMessage({
            type: 'result',
            result: {
                md5: msg.task.md5, sidPath: msg.task.sidPath, subtune: msg.task.subtune,
                hvscMs: msg.task.hvscMs, error: String((e && e.message) || e),
                tookMs: Date.now() - started,
            },
        });
    }
});

parentPort.postMessage({ type: 'ready' });
