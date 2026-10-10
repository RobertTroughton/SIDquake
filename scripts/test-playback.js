#!/usr/bin/env node
/**
 * test-playback.js - the page's playback wrapper (public/sid-playback.js), run
 * in Node against stubs of the Web Audio objects and the engine.
 *
 *   - Pause, stop, a subtune change and a reload ramp the output to silence
 *     before the worklet's queue is cut or the graph disconnected, so the
 *     waveform does not stop mid-cycle.
 *   - The clock counts audio still queued at the fast-forward speed it was
 *     rendered at, so it does not jump when the speed changes.
 *
 * Run with `node scripts/test-playback.js`.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A SIDPlayback with a loaded tune, wired to stubs that log, in order, what
// reaches the worklet, the gain automation and the graph.
function makePlayback({ sampleRate = 44100 } = {}) {
    const ctx = vm.createContext({ window: {}, localStorage: { getItem: () => null, setItem() {} },
        console, setTimeout, clearTimeout });
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sid-playback.js'), 'utf8');
    vm.runInContext(src + '\nthis.SIDPlayback = SIDPlayback;', ctx);

    const log = [];
    const audioCtx = { state: 'running', sampleRate, destination: { name: 'destination' },
        get currentTime() { return performance.now() / 1000; } };
    const gain = {
        value: 1,
        cancelScheduledValues: () => log.push({ gain: 'cancel' }),
        setValueAtTime: (v) => log.push({ gain: 'set', v }),
        linearRampToValueAtTime: (v, t) => log.push({ gain: 'ramp', v, over: t - audioCtx.currentTime }),
    };
    const pb = new ctx.SIDPlayback(4096);
    pb.audioCtx = audioCtx;
    pb.gainNode = { gain };
    pb.analyser = {
        connect: () => log.push({ graph: 'connect' }),
        disconnect: () => log.push({ graph: 'disconnect' }),
    };
    pb.workletNode = { port: { postMessage: (m) => log.push({ worklet: m.type }) } };
    pb.module = { HEAPU8: new Uint8Array(4096 * 2) };
    pb.wasmBufferPtr = 0;
    pb.api = {
        audio_generate: () => 0,
        audio_set_subtune: () => log.push({ engine: 'subtune' }),
        audio_get_play_time: () => 0,
    };
    pb.loaded = true;
    return { pb, log };
}

// Index of the first entry matching `pred`, or -1.
const at = (log, pred) => log.findIndex(pred);
const isCut = (e) => e.worklet === 'stop' || e.worklet === 'pause' || e.graph === 'disconnect';
const isRampDown = (e) => e.gain === 'ramp' && e.v === 0;

(async () => {
    for (const [name, act] of [
        ['pause', (pb) => pb.pause(true)],
        ['stop', (pb) => pb.stop()],
    ]) {
        console.log(`${name} fades out before it cuts`);
        const { pb, log } = makePlayback();
        pb.play();
        await wait(30);
        log.length = 0;
        act(pb);
        check(at(log, isCut) === -1, 'nothing is cut at once', JSON.stringify(log));
        const ramp = log.find(isRampDown);
        check(!!ramp && ramp.over > 0.005 && ramp.over < 0.05, 'gain ramps to 0 over a few ms',
            ramp ? `${(ramp.over * 1000).toFixed(1)} ms` : 'no ramp');
        await wait(60);
        check(at(log, isRampDown) !== -1 && at(log, isCut) > at(log, isRampDown), 'the cut follows the ramp',
            JSON.stringify(log));
    }

    console.log('a subtune change fades out the old tune before flushing it');
    {
        const { pb, log } = makePlayback();
        pb.play();
        await wait(30);
        log.length = 0;
        // What sid-player.js does on a subtune change.
        pb.pause();
        pb.setSubtune(3);
        pb.play();
        check(pb.isAudible(), 'playback reads as started straight away');
        check(at(log, (e) => e.worklet === 'stop') === -1, 'the old queue is not flushed at once',
            JSON.stringify(log));
        await wait(60);
        const down = at(log, isRampDown);
        const flush = at(log, (e) => e.worklet === 'stop');
        const start = at(log, (e) => e.worklet === 'start');
        const up = log.findIndex((e, i) => i > flush && e.gain === 'ramp' && e.v > 0);
        check(down !== -1 && flush > down, 'flush follows the fade-out', JSON.stringify(log));
        check(start > flush && up > flush, 'then it starts again and fades in', JSON.stringify(log));
        check(at(log, (e) => e.graph === 'disconnect') === -1, 'the output stays connected');
    }

    console.log('a reload fades out before the queue is flushed');
    {
        const { pb, log } = makePlayback();
        pb.play();
        await wait(30);
        log.length = 0;
        pb.init = async () => {};
        pb.api.audio_cleanup = () => {};
        pb.api.audio_load_sid = () => -1;
        pb.module._malloc = () => 0;
        pb.module._free = () => {};
        await pb._applyLoad(new Uint8Array(0x7c).buffer).catch(() => {});
        check(at(log, isRampDown) !== -1 && (at(log, isCut) === -1 || at(log, isCut) > at(log, isRampDown)),
            'no cut before the fade-out', JSON.stringify(log));
    }

    console.log('a speed change does not rescale audio already queued');
    {
        // One chunk is one second at this rate.
        const { pb } = makePlayback({ sampleRate: 4096 });
        let rendered = 0;
        pb.api.audio_generate = () => { rendered += pb.speed; return 4096; };
        pb.api.audio_get_play_time = () => rendered;
        for (let i = 0; i < 6; i++) pb._generateAndPost();
        pb.setSpeed(4);
        for (let i = 0; i < 2; i++) pb._generateAndPost();
        // The worklet has played 5 of the 1x chunks: 1 + 2 chunks still queued.
        pb._queuedSamples = 3 * 4096;
        check(pb.getAudibleTime() === 5, 'clock shows the 5 s heard', `got ${pb.getAudibleTime()}`);
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
