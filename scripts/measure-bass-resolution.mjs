#!/usr/bin/env node
// measure-bass-resolution.mjs - how sharply the bake's bottom bars resolve a
// note, in pitch and in time, for comparing changes to the bass windows in
// spectrometer-bake.js (analysisSources / resolvesFrom).
//
//   node scripts/measure-bass-resolution.mjs [bake-module] [seconds]
//
// Each tune in SID/ is rendered on the reSID engine in sidquake.wasm, analysed
// with `bake-module` (default public/spectrometer-bake.js), and turned into the
// 40 fitted bars the exporter would store. Over the bottom twelve bars it
// reports, averaged over frames with something playing:
//   spread - bars within 85% of the frame's peak among those twelve (lower is
//            a sharper pitch; one note lighting several bars reads high);
//   motion - mean frame-to-frame change of those bars on the 0..1 scale
//            (lower means the long windows are smearing notes out in time).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const R = new URL('..', import.meta.url).pathname;
const mod = process.argv[2] ? new URL(process.argv[2], 'file://' + process.cwd() + '/').href : R + 'public/spectrometer-bake.js';
const SECS = +(process.argv[3] || 45);
const RATE = 44100, BOTTOM = 12;
const bake = await import(mod);
const { fitRange, deriveBars } = bake._internals;
const M = await require(R + 'public/sidquake.js')({ wasmBinary: fs.readFileSync(R + 'public/sidquake.wasm'), print() {}, printErr() {} });
const cw = (n, r, a) => M.cwrap(n, r, a);
const A = {
    init: cw('audio_init', null, ['number']), load: cw('audio_load_sid', 'number', ['number', 'number']),
    sub: cw('audio_set_subtune', null, ['number']), gen: cw('audio_generate', 'number', ['number', 'number']),
};
const tunes = fs.readdirSync(R + 'SID').filter((f) => /\.sid$/i.test(f)).sort();
let tS = 0, tM = 0, n = 0;
for (const f of tunes) {
    const bytes = fs.readFileSync(path.join(R, 'SID', f));
    if (bytes.toString('latin1', 0, 4) !== 'PSID') continue;
    A.init(RATE);
    const p = M._malloc(bytes.length); M.HEAPU8.set(bytes, p);
    const ok = A.load(p, bytes.length); M._free(p);
    if (ok < 0) continue;
    A.sub(Math.max(0, ((bytes[0x10] << 8) | bytes[0x11]) - 1));
    const s = bake.createBakeSession(RATE, { numBars: 40, maxHeight: 111, frameHz: 50.1245 });
    const CH = 8192, buf = M._malloc(CH * 2);
    for (let done = 0; done < RATE * SECS;) {
        const g = A.gen(buf, CH); if (g <= 0) break;
        const v = new Int16Array(M.HEAPU8.buffer, buf, g), c = new Float32Array(g);
        for (let i = 0; i < g; i++) c[i] = v[i] / 32768;
        s.feed(c); done += g;
    }
    M._free(buf);
    const fine = s.rows().fine;
    const r = fitRange(fine);
    const bars = deriveBars(fine, 40, r.fMin, r.fMax);
    let spread = 0, motion = 0, frames = 0;
    for (let k = 1; k < bars.count; k++) {
        const row = bars.data.subarray(k * 40, k * 40 + BOTTOM), prev = bars.data.subarray((k - 1) * 40, (k - 1) * 40 + BOTTOM);
        let peak = 0; for (const x of row) if (x > peak) peak = x;
        if (peak < 0.1) continue;
        let near = 0, d = 0;
        for (let b = 0; b < BOTTOM; b++) { if (row[b] >= 0.85 * peak) near++; d += Math.abs(row[b] - prev[b]); }
        spread += near; motion += d / BOTTOM; frames++;
    }
    if (!frames) continue;
    console.log(`${f.padEnd(40)} spread ${(spread / frames).toFixed(2)}  motion ${(motion / frames).toFixed(4)}`);
    tS += spread / frames; tM += motion / frames; n++;
}
console.log(`${'mean over ' + n + ' tunes'.padEnd(40)} spread ${(tS / n).toFixed(2)}  motion ${(tM / n).toFixed(4)}`);
