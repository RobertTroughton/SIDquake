#!/usr/bin/env node
// test-shadow-replay.js - run the C64 shadow-register replay loop in the 6510
// emulator and check it pushes the register mirror out to the real SID exactly
// as the exporter expects.
//
// PlayMusicShadow (SIDPlayers/INC/musicplayback.asm) and the exporter
// (public/prg-builder.js processSpectrometerShadow) have to agree on the
// replay-order table byte-for-byte:
//
//   entry     an offset from $D400, so chip N's register r is $20*N + r
//   length    25 entries per SID chip the tune uses
//   end       one $FF terminator - the only thing bounding the replay
//
// Get any of that wrong and the export is silently mistuned, silent, or (with a
// multi-SID order replayed on a single-SID layout) writes junk into SID 1 through
// the $D420 mirror. So this drives the real assembled routine over the real
// tables buildFullOrder() produces and diffs every write it makes.
//
// Usage: node scripts/test-shadow-replay.js
// Requires java (KickAss) and public/sidquake.wasm. Exits non-zero on failure.

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const LOAD = 0x0700;               // lowest address in the harness image
const ENTRY = 0x0800;              // jmp PlayMusicShadow
const REGS_PER_CHIP = 25;

function assemble() {
    const out = path.join(os.tmpdir(), 'shadow-replay-test.bin');
    execFileSync('java', ['-jar', path.join(ROOT, 'KickAss.jar'),
        path.join(ROOT, 'SIDPlayers/tests/ShadowReplayTest.asm'),
        '-define', 'SPECTROMETER_SHADOW', '-binfile', '-o', out], { cwd: ROOT, stdio: 'pipe' });
    return fs.readFileSync(out);
}

async function loadCpu() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    return factory({ wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
                     print: () => {}, printErr: () => {} });
}

function writeMem(m, addr, bytes) {
    const p = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, p);
    m._cpu_load_memory(addr, p, bytes.length);
    m._free(p);
}

// Deterministic mirror contents so a failure is reproducible. Never 0 and never
// $FF, so "the player wrote nothing" and "the player replayed the terminator"
// both show up as a mismatch rather than a coincidence.
const mirrorValue = off => ((off * 7 + 0x31) & 0x7F) | 0x01;

async function main() {
    const bin = assemble();
    const m = await loadCpu();

    m._cpu_init();
    writeMem(m, LOAD, bin);
    const word = a => m._cpu_read_memory(a) | (m._cpu_read_memory(a + 1) << 8);
    const mirrorAddr = word(ENTRY + 3);
    const orderAddr = word(ENTRY + 5);

    const { buildFullOrder } = await import(
        'file://' + path.join(ROOT, 'public/spectrometer-shadow-detect.js'));

    // One case per supported chip count, each with a plausible detected order and
    // its low-consistency fallback twin (which is what most tunes actually ship).
    const cases = [];
    for (let chips = 1; chips <= 4; chips++) {
        // A typical per-frame order: each chip's voices written low-to-high, filter
        // and volume last - interleaved across chips the way a real player does.
        const observed = [];
        for (let r = 0; r <= 0x18; r++) for (let c = 0; c < chips; c++) observed.push(c * 0x20 + r);
        cases.push({ chips, label: 'detected', order: buildFullOrder(observed, 1.0, chips) });
        cases.push({ chips, label: 'fallback', order: buildFullOrder([], 0.0, chips) });
    }

    let failures = 0, checked = 0;
    for (const c of cases) {
        const expected = c.order;
        if (expected.length !== REGS_PER_CHIP * c.chips) {
            console.log(`  FAIL ${c.chips} chip(s) ${c.label}: order has ${expected.length} entries, ` +
                        `expected ${REGS_PER_CHIP * c.chips}`);
            failures++; continue;
        }

        m._cpu_reset_state_only();
        writeMem(m, LOAD, bin);

        // Seed the mirror the way a redirected play routine would: chip N's
        // registers at mirror + $20*N. Stop short of the order table, which shares
        // the page ($79 in - see the harness's SHADOW_LABELS output).
        const mirrorLen = orderAddr - mirrorAddr;
        writeMem(m, mirrorAddr, Uint8Array.from({ length: mirrorLen }, (_, i) => mirrorValue(i)));
        // Bake the table exactly as prg-builder does: the entries, then $FF.
        writeMem(m, orderAddr, Uint8Array.from([...expected, 0xFF]));
        // Clear the whole SID address range so any stray write shows up.
        writeMem(m, 0xD400, new Uint8Array(0x400));

        m._cpu_set_tracking(1);
        m._cpu_set_record_writes(1);
        if (m._cpu_execute_function(ENTRY, 1000000) === 0) {
            console.log(`  FAIL ${c.chips} chip(s) ${c.label}: replay did not complete`);
            failures++; continue;
        }
        m._cpu_set_record_writes(0);

        // Every SID write, in order. Exactly the baked order, nothing more:
        // an extra write means the terminator was missed, a missing one means the
        // loop stopped early.
        const seq = [];
        for (let i = 0, n = m._cpu_get_write_sequence_length(); i < n; i++) {
            seq.push(m._cpu_get_write_sequence_item(i));
        }
        let bad = 0;
        if (seq.length !== expected.length) {
            console.log(`  FAIL ${c.chips} chip(s) ${c.label}: ${seq.length} SID writes, ` +
                        `expected ${expected.length}`);
            bad++;
        }
        for (let i = 0; i < Math.min(seq.length, expected.length); i++) {
            const want = 0xD400 + expected[i];
            if (seq[i] !== want) {
                if (bad < 5) console.log(`  FAIL ${c.chips} chip(s) ${c.label}: write ${i} went to ` +
                    `$${seq[i].toString(16)}, expected $${want.toString(16)}`);
                bad++;
            }
        }
        // ...and each register ended up holding its own mirror byte.
        for (const off of expected) {
            checked++;
            const got = m._cpu_read_memory(0xD400 + off);
            if (got !== mirrorValue(off)) {
                if (bad < 5) console.log(`  FAIL ${c.chips} chip(s) ${c.label}: $${(0xD400 + off).toString(16)} ` +
                    `= $${got.toString(16)}, expected $${mirrorValue(off).toString(16)}`);
                bad++;
            }
        }
        if (bad === 0) console.log(`  ok  ${c.chips} chip(s), ${c.label} order: ${expected.length} registers replayed`);
        failures += bad;
    }

    console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: ${checked} replayed registers checked, ${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
