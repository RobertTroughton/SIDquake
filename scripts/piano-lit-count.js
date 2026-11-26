#!/usr/bin/env node
// piano-lit-count.js - how busy the Piano keyboard gets on a tune.
//
// Plays the tune on one 6510 emulator and feeds each frame's SID registers to
// the assembled Piano player (SIDPlayers/Piano/Piano.asm) on another, the way
// the realtime build's analysis sees them: once a frame, after the frame's last
// play call. Prints the average number of lit keys, the average number struck
// within the last frame or so (level >= 192), the most lit at once, and how
// many frames had each count. Skips the first 3 seconds (intros).
//
// Usage: node scripts/piano-lit-count.js <tune.sid> [callsPerFrame=1] [frames=3000]
// callsPerFrame is the tune's play rate (2 for a double-speed CIA tune); the
// script does not work it out. Requires java (KickAss) and public/sidquake.wasm.

const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 0x1000;
const SKIP = 150;

async function main() {
    const [sid, callsArg, framesArg] = process.argv.slice(2);
    if (!sid) { console.error('usage: piano-lit-count.js <tune.sid> [callsPerFrame] [frames]'); process.exit(1); }
    const calls = +callsArg || 1, frames = +framesArg || 3000;
    const make = () => require(path.join(ROOT, 'public/sidquake.js'))({
        wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')), print: () => {}, printErr: () => {} });
    const tune = await make(), piano = await make();
    const load = (m, addr, bytes) => {
        const p = m._malloc(bytes.length);
        m.HEAPU8.set(bytes, p);
        m._cpu_load_memory(addr, p, bytes.length);
        m._free(p);
    };

    const d = fs.readFileSync(sid);
    const off = d.readUInt16BE(6), init = d.readUInt16BE(10), play = d.readUInt16BE(12);
    let addr = d.readUInt16BE(8), body = d.subarray(off);
    if (!addr) { addr = body[0] | (body[1] << 8); body = body.subarray(2); }
    tune._cpu_init();
    load(tune, addr, body);
    tune._cpu_set_accumulator(0);
    tune._cpu_execute_function(init, 20000000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-lit-'));
    execFileSync('java', ['-jar', path.join(ROOT, 'KickAss.jar'),
        `:loadAddress=${BASE}`, `:sysAddress=${BASE + 0x100}`, `:dataAddress=${BASE}`, ':gfxBank=1',
        '-define', 'CODE_ONLY', path.join(ROOT, 'SIDPlayers/Piano/Piano.asm'),
        '-vicesymbols', '-binfile', '-o', path.join(dir, 'piano.bin')], { cwd: dir, stdio: 'pipe' });
    const L = {};
    for (const line of fs.readFileSync(path.join(dir, 'Piano.vs'), 'utf8').split('\n')) {
        const m = /^al C:([0-9a-f]+) \.(\w+)/i.exec(line);
        if (m) L[m[2]] = parseInt(m[1], 16);
    }
    piano._cpu_init();
    load(piano, BASE, fs.readFileSync(path.join(dir, 'piano.bin')));
    fs.rmSync(dir, { recursive: true, force: true });
    piano._cpu_write_memory(BASE + 0xCD, 1);
    piano._cpu_execute_function(L.InitPiano, 1000000);

    let lit = 0, struck = 0, most = 0;
    const counts = {};
    for (let f = 0; f < frames; f++) {
        for (let c = 0; c < calls; c++) tune._cpu_execute_function(play, 20000);
        for (let r = 0; r < 25; r++) piano._cpu_write_memory(L.sidRegisterMirror + r, tune._cpu_read_memory(0xD400 + r));
        piano._cpu_execute_function(L.AnalyzeSIDRegisters, 1000000);
        piano._cpu_execute_function(L.UpdatePiano, 1000000);
        if (f < SKIP) continue;
        let n = 0;
        for (let k = 0; k < 68; k++) {
            const level = piano._cpu_read_memory(L.keyLevel + k);
            if (level) n++;
            if (level >= 192) struck++;
        }
        lit += n; most = Math.max(most, n);
        counts[n] = (counts[n] || 0) + 1;
    }
    const n = frames - SKIP;
    console.log(`lit ${(lit / n).toFixed(2)} avg, ${most} max; struck ${(struck / n).toFixed(2)} avg`);
    console.log('frames by lit count: ' + JSON.stringify(counts));
}

main().catch(e => { console.error(e); process.exit(1); });
