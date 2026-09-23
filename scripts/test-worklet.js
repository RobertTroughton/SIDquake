#!/usr/bin/env node
/**
 * test-worklet.js - the AudioWorklet that plays what the engine renders
 * (public/sid-worklet-processor.js), run in Node against a stub of the worklet
 * globals.
 *
 *   - A request for samples that comes back empty (the engine rendered nothing
 *     that once, e.g. libsidplayfp re-initialising after a JAM) must not leave
 *     the worklet waiting forever: it asks again while it is starved.
 *   - Pausing keeps the queued audio, so resuming carries on from where the
 *     listener was rather than skipping what was buffered.
 *
 * Run with `node scripts/test-worklet.js`.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

function makeProcessor() {
    let Klass = null;
    const sent = [];
    class AudioWorkletProcessor {
        constructor() { this.port = { postMessage: (m) => sent.push(m), onmessage: null }; }
    }
    const ctx = vm.createContext({
        AudioWorkletProcessor,
        registerProcessor: (name, k) => { Klass = k; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sid-worklet-processor.js'), 'utf8'), ctx);
    const p = new Klass();
    const send = (data) => p.port.onmessage({ data });
    const quantum = () => { const out = new Float32Array(128); p.process([], [[out]]); return out; };
    return { p, sent, send, quantum };
}

console.log('an empty answer to a request is not the last request');
{
    const w = makeProcessor();
    w.send({ type: 'start' });
    for (let i = 0; i < 400; i++) w.quantum();          // ~1.2 s with nothing arriving
    const asks = w.sent.filter((m) => m.type === 'need-samples').length;
    check(asks > 1, 'a starved worklet asks again', `${asks} request(s)`);
}

console.log('pausing keeps what is queued');
{
    const w = makeProcessor();
    w.send({ type: 'start' });
    const block = new Float32Array(1024).map((_, i) => i + 1);
    w.send({ type: 'samples', samples: block });
    const first = w.quantum();
    w.send({ type: 'pause' });
    const paused = w.quantum();
    w.send({ type: 'start' });
    const resumed = w.quantum();
    check(first[0] === 1 && paused.every((v) => v === 0), 'nothing plays while paused');
    check(resumed[0] === 129, 'resuming plays on from the next queued sample', `first sample ${resumed[0]}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
