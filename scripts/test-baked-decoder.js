#!/usr/bin/env node
// test-baked-decoder.js - run the C64 baked-spectrometer decoder in the 6510
// emulator and check it decodes the exporter's data layout correctly and
// interpolates between keyframes the way the baker models it.
//
// The decoder (DecodeBakedFrame / TickBakedFrame in SIDPlayers/INC/spectrometer.asm)
// is the one place where the player and the exporter have to agree byte-for-byte
// on a data layout, and it does it with self-modifying code. A layout change is
// easy to get subtly wrong and impossible to eyeball, so this drives the real
// assembled routine over synthetic data, one raster frame at a time, and diffs
// every column it shows against the layout the baker writes
// (public/spectrometer-bake.js, bakeFromStore):
//
//   codebook  bar-major: bar b's value for entry e is at codebookBase + b*256 + e
//   indices   PLANAR: segment s's index for keyframe k is at indexBase + s*nk + k
//
// and, between keyframes, against tweenColumn() - the bit-exact model of the
// player's 8.8 fixed-point walk from one keyframe to the next. It also checks the
// end-of-stream wrap back to loopStart, including the bakedJustLooped flag the
// player uses to re-sync its timer (it must fire on the frame the LAST keyframe
// shows, even though the decoder runs a keyframe ahead).
//
// Usage: node scripts/test-baked-decoder.js
// Requires java (KickAss) and public/sidquake.wasm. Exits non-zero on failure.

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const NUM_BARS = 40;
const CODEBOOK_BASE = 0x2000;          // page aligned, 40 pages -> $2000..$49FF
const INDEX_BASE = 0x5000;
const ENTRIES = 256;

function assemble() {
    const out = path.join(os.tmpdir(), 'baked-decoder-test.bin');
    execFileSync('java', ['-jar', path.join(ROOT, 'KickAss.jar'),
        path.join(ROOT, 'SIDPlayers/tests/BakedDecoderTest.asm'),
        '-define', 'SPECTROMETER_BAKED', '-binfile', '-o', out], { cwd: ROOT, stdio: 'pipe' });
    return fs.readFileSync(out);
}

async function loadCpu() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    return factory({ wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
                     print: () => {}, printErr: () => {} });
}

// Deterministic pseudo-random bytes so a failure is reproducible.
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (Math.imul(a ^ (a >>> 15), 1 | a) + 0x6D2B79F5) >>> 0; return (a >>> 8) & 0xFF; };
}

function buildCase({ segments, nk, loopStart, seed }) {
    const segW = NUM_BARS / segments;
    const r = rng(seed);
    const codebook = new Uint8Array(NUM_BARS * ENTRIES);      // bar-major pages
    for (let i = 0; i < codebook.length; i++) codebook[i] = r() % 112;   // 0..maxHeight
    const indices = new Uint8Array(segments * nk);            // planar
    for (let i = 0; i < indices.length; i++) indices[i] = r();
    // Expected column for keyframe k, straight from the layout above.
    const expect = (k) => {
        const col = new Uint8Array(NUM_BARS);
        for (let s = 0; s < segments; s++) {
            const idx = indices[s * nk + k];
            for (let lb = 0; lb < segW; lb++) {
                const b = s * segW + lb;
                col[b] = codebook[b * ENTRIES + idx];
            }
        }
        return col;
    };
    return { segments, segW, nk, loopStart, codebook, indices, expect };
}

function writeMem(m, addr, bytes) {
    const p = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, p);
    m._cpu_load_memory(addr, p, bytes.length);
    m._free(p);
}

function readMem(m, addr, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = m._cpu_read_memory(addr + i);
    return out;
}

const word = v => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]);

async function run() {
    const bin = assemble();
    const m = await loadCpu();
    const { tweenColumn } = await import('../public/spectrometer-bake.js');

    let failures = 0, checked = 0;

    const cases = [
        { segments: 5, nk: 24, loopStart: 7, seed: 0x1234, divisor: 2 },
        { segments: 4, nk: 19, loopStart: 0, seed: 0x2345, divisor: 3 },
        { segments: 2, nk: 40, loopStart: 33, seed: 0x3456, divisor: 1 },
        { segments: 1, nk: 300, loopStart: 128, seed: 0x4567, divisor: 2 },   // > 256 keyframes: high byte of the counter
        { segments: 5, nk: 3, loopStart: 2, seed: 0x5678, divisor: 3 },       // wraps almost immediately
        { segments: 5, nk: 12, loopStart: 4, seed: 0x6789, divisor: 3 },
    ];

    for (const spec of cases) {
        const c = buildCase(spec);
        const d = spec.divisor;
        m._cpu_init();
        writeMem(m, 0x0800, bin);
        writeMem(m, CODEBOOK_BASE, c.codebook);
        writeMem(m, INDEX_BASE, c.indices);
        writeMem(m, 0x080A, word(CODEBOOK_BASE));
        writeMem(m, 0x080C, word(INDEX_BASE));
        writeMem(m, 0x080E, word(c.nk));
        writeMem(m, 0x0810, word(c.loopStart));
        writeMem(m, 0x0812, new Uint8Array([c.segments, c.segW, d]));

        const initAddr = m._cpu_read_memory(0x0801) | (m._cpu_read_memory(0x0802) << 8);
        const tickAddr = m._cpu_read_memory(0x0804) | (m._cpu_read_memory(0x0805) << 8);
        const targets = m._cpu_read_memory(0x0806) | (m._cpu_read_memory(0x0807) << 8);
        const justLooped = m._cpu_read_memory(0x0808) | (m._cpu_read_memory(0x0809) << 8);

        if (!m._cpu_execute_function(initAddr, 200000)) {
            console.error(`  FAIL seg=${c.segments}: InitBaked did not return`);
            failures++; continue;
        }

        // Play past the end of the stream so the wrap is exercised at least twice.
        const keyframes = c.nk + (c.nk - c.loopStart) * 2 + 3;
        const frames = keyframes * d;
        let k = 0, bad = 0;
        const label = `seg=${c.segments} div=${d}`;
        for (let f = 0; f < frames; f++) {
            m._cpu_write_memory(justLooped, 0);
            if (!m._cpu_execute_function(tickAddr, 200000)) {
                console.error(`  FAIL ${label}: TickBakedFrame did not return at frame ${f}`);
                failures++; bad = -1; break;
            }
            const got = readMem(m, targets, NUM_BARS);
            const sub = f % d;
            const next = (k + 1) >= c.nk ? c.loopStart : k + 1;
            const want = sub === 0 ? c.expect(k) : tweenColumn(c.expect(k), c.expect(next), d, sub);
            checked++;
            for (let b = 0; b < NUM_BARS; b++) {
                if (got[b] !== want[b]) {
                    if (bad < 3) {
                        console.error(`  FAIL ${label} frame ${f} (keyframe ${k}${sub ? ` +${sub}/${d}` : ''}) bar ${b}: ` +
                                      `got ${got[b]}, want ${want[b]}`);
                    }
                    bad++; failures++;
                    break;
                }
            }
            // The wrap flag fires on the keyframe frame that shows the LAST keyframe.
            const flag = m._cpu_read_memory(justLooped);
            const wantFlag = (sub === 0 && k === c.nk - 1) ? 1 : 0;
            if (flag !== wantFlag) {
                console.error(`  FAIL ${label}: bakedJustLooped=${flag} at frame ${f} (keyframe ${k}), want ${wantFlag}`);
                failures++;
            }
            if (sub === d - 1) k = next;
            if (bad < 0) break;
        }
        if (bad === 0) console.log(`  ok  segments=${c.segments} width=${c.segW} keyframes=${c.nk} loopStart=${c.loopStart} divisor=${d} (${frames} frames)`);
    }

    console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: ${checked} shown columns checked, ${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
