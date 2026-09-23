#!/usr/bin/env node
// bench-bake-analysis.mjs - time the bake's per-frame FFT analysis and hash what
// it produces (the raw bar rows, the fine grid and its histogram), so a change
// meant to be an optimisation can be shown to leave the output byte-identical.
//
//   node scripts/bench-bake-analysis.mjs [bake-module] [tune.sid]
//
// bake-module defaults to public/spectrometer-bake.js; pass a copy of an older
// version to compare. The tune (from SID/, default JCH-Crystalline.sid) is
// rendered for 60 s on the reSID engine in sidquake.wasm first; only the
// analysis is timed.
import fs from 'fs'; import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const R = new URL('..', import.meta.url).pathname;
const M = await require(R + 'public/sidquake.js')({ wasmBinary: fs.readFileSync(R + 'public/sidquake.wasm'), print() {}, printErr() {} });
const bake = await import(process.argv[2] ? new URL(process.argv[2], 'file://' + process.cwd() + '/').href : R + 'public/spectrometer-bake.js');
const RATE = 44100, SECS = 60;
const bytes = fs.readFileSync(R + 'SID/' + (process.argv[3] || 'JCH-Crystalline.sid'));
const cw = (n, r, a) => M.cwrap(n, r, a);
cw('audio_init', null, ['number'])(RATE);
const p = M._malloc(bytes.length); M.HEAPU8.set(bytes, p); cw('audio_load_sid', 'number', ['number', 'number'])(p, bytes.length);
cw('audio_set_subtune', null, ['number'])(0);
const gen = cw('audio_generate', 'number', ['number', 'number']);
const CH = 8192, buf = M._malloc(CH * 2); const chunks = [];
for (let n = 0; n < RATE * SECS; ) { const g = gen(buf, CH); const v = new Int16Array(M.HEAPU8.buffer, buf, g); const f = new Float32Array(g); for (let i = 0; i < g; i++) f[i] = v[i] / 32768; chunks.push(f); n += g; }
const s = bake.createBakeSession(RATE, { numBars: 40, maxHeight: 111, frameHz: 50.1245 });
const t = performance.now();
for (const c of chunks) s.feed(c);
const ms = performance.now() - t;
const rows = s.rows();
const h = crypto.createHash('sha1');
h.update(Buffer.from(rows.data.buffer, rows.data.byteOffset, rows.count * 40 * rows.data.BYTES_PER_ELEMENT));
h.update(Buffer.from(rows.fine.data.buffer, 0, rows.fine.count * rows.fine.bands.count * 2));
h.update(Buffer.from(rows.fine.hist.buffer));
console.log('frames', rows.count, 'analyse ms', ms.toFixed(0), 'hash', h.digest('hex').slice(0, 16));
