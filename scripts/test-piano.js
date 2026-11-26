#!/usr/bin/env node
// test-piano.js - run the Piano player's note analysis and key drawing in the
// 6510 emulator and check what it lights.
//
// The player turns each voice's SID registers (from the register mirror the
// realtime and shadow builds both fill) into a key on a 68-key keyboard, then
// lights white keys in colour RAM and black keys with sprites. None of that is
// visible to the exporter, so this assembles the real player and drives its
// routines directly:
//
//   FreqToKey            every note C0..A#7, in tune and 40 cents off, lands on
//                        the right key, folded by octaves into the keyboard
//   AnalyzeSIDRegisters  gate, test bit, noise and silence; voices on SID 2
//   UpdatePiano          a gated note lights its key in its voice's colour, a
//                        black key gets a sprite at the right X, a released
//                        note fades back to unlit, a new note on a held gate
//                        strikes again
//
// Both register-mirror layouts are covered: 25 bytes per chip (realtime build)
// and $20 per chip (SPECTROMETER_SHADOW).
//
// Usage: node scripts/test-piano.js
// Requires java (KickAss) and public/sidquake.wasm. Exits non-zero on failure.

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 0x1000;                // data block; code at BASE + $100
const NUM_KEYS = 68;
const KEYS_TOP_ROW = 19, KEYS_BOTTOM_ROW = 24;
const PAL_CLOCK = 985248;

function assemble(defines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-test-'));
    const out = path.join(dir, 'piano.bin');
    const args = ['-jar', path.join(ROOT, 'KickAss.jar'),
        `:loadAddress=${BASE}`, `:sysAddress=${BASE + 0x100}`, `:dataAddress=${BASE}`, ':gfxBank=1',
        '-define', 'CODE_ONLY'];
    for (const d of defines) args.push('-define', d);
    args.push(path.join(ROOT, 'SIDPlayers/Piano/Piano.asm'), '-vicesymbols', '-binfile', '-o', out);
    execFileSync('java', args, { cwd: dir, stdio: 'pipe' });
    const labels = {};
    for (const line of fs.readFileSync(path.join(dir, 'Piano.vs'), 'utf8').split('\n')) {
        const m = /^al C:([0-9a-f]+) \.(\w+)/i.exec(line);
        if (m) labels[m[2]] = parseInt(m[1], 16);
    }
    const bin = fs.readFileSync(out);
    fs.rmSync(dir, { recursive: true, force: true });
    return { bin, labels };
}

async function loadCpu() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    return factory({ wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
                     print: () => {}, printErr: () => {} });
}

// The SID register value the player's threshold table is built around.
const noteFreq = (n, cents = 0) =>
    Math.round(16.3516 * Math.pow(2, (n + cents / 100) / 12) * 16777216 / PAL_CLOCK);

// Where the keyboard puts note n (C0 = 0) with C1 as its lowest key.
function expectedKey(n, low = 12) {
    let k = n - low;
    while (k < 0) k += 12;
    while (k >= NUM_KEYS) k -= 12;
    return k;
}
const isBlack = k => [1, 3, 6, 8, 10].includes(k % 12);
const column = k => Math.floor(k / 12) * 7 + [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6][k % 12];

let failures = 0;
function check(ok, what) {
    if (!ok) { console.log('  FAIL ' + what); failures++; }
    return ok;
}

async function runVariant(m, name, defines, stride) {
    const { bin, labels } = assemble(defines);
    const L = (n) => { if (labels[n] === undefined) throw new Error('no label ' + n); return labels[n]; };
    const rd = (a) => m._cpu_read_memory(a);
    const wr = (a, v) => m._cpu_write_memory(a, v);
    const call = (label) => {
        if (m._cpu_execute_function(L(label), 2000000) === 0) throw new Error(label + ' did not return');
    };

    m._cpu_init();
    const p = m._malloc(bin.length);
    m.HEAPU8.set(bin, p);
    m._cpu_load_memory(BASE, p, bin.length);
    m._free(p);
    wr(BASE + 0xCD, 2);                // NumSIDChips: two, so voice 3 is on SID 2
    call('InitPiano');

    const failsBefore = failures;

    // FreqToKey: every note the 16-bit register reaches, in tune and 40 cents
    // either side.
    let notesChecked = 0;
    for (let n = 0; n < 96; n++) {
        for (const cents of [0, -40, 40]) {
            const f = noteFreq(n, cents);
            if (f < 1 || f > 0xFFFF) continue;
            wr(L('freqLo'), f & 0xFF);
            wr(L('freqHi'), f >> 8);
            call('FreqToKey');
            const got = m._cpu_get_a();
            notesChecked++;
            check(got === expectedKey(n), `${name}: note ${n} ${cents}c (freq $${f.toString(16)}) -> key ${got}, expected ${expectedKey(n)}`);
        }
    }

    const mirror = L('sidRegisterMirror');
    const setVoice = (v, { freq = 0, ctrl = 0, ad = 0, sr = 0 }) => {
        const o = mirror + Math.floor(v / 3) * stride + (v % 3) * 7;
        wr(o + 0, freq & 0xFF); wr(o + 1, freq >> 8);
        wr(o + 4, ctrl); wr(o + 5, ad); wr(o + 6, sr);
    };
    const frame = () => { call('AnalyzeSIDRegisters'); call('UpdatePiano'); };
    const level = (k) => rd(L('keyLevel') + k);
    const colourAt = (k, row) => rd(0xD800 + row * 40 + column(k));
    for (let v = 0; v < 6; v++) setVoice(v, {});

    // Silence: test bit, noise only, no waveform, zero frequency.
    const E4 = 12 * 4 + 4, A4 = 12 * 4 + 9, Cs3 = 12 * 3 + 1, G2 = 12 * 2 + 7;
    for (const [what, regs] of [
        ['test bit', { freq: noteFreq(A4), ctrl: 0x49 }],
        ['noise', { freq: noteFreq(A4), ctrl: 0x81 }],
        ['no waveform', { freq: noteFreq(A4), ctrl: 0x01 }],
        ['zero frequency', { freq: 0, ctrl: 0x41 }]]) {
        setVoice(0, regs);
        frame();
        check(rd(L('voiceKey')) === 0xFF, `${name}: ${what} reads as a key`);
    }

    // A gated pulse note on voice 0 lights its white key in the red family;
    // sustain $8 holds it lit while the gate stays on.
    const kE4 = expectedKey(E4);
    setVoice(0, { freq: noteFreq(E4), ctrl: 0x41, ad: 0x09, sr: 0x8A });
    frame();
    check(level(kE4) === 0xFF, `${name}: struck key level ${level(kE4)}, expected 255`);
    check(colourAt(kE4, KEYS_TOP_ROW) === 0x02 && colourAt(kE4, KEYS_BOTTOM_ROW) === 0x02,
        `${name}: struck white key colour $${colourAt(kE4, KEYS_TOP_ROW).toString(16)}, expected $2`);
    for (let i = 0; i < 100; i++) frame();
    check(level(kE4) >= 112 + 8 * 9, `${name}: held key fell to ${level(kE4)} below its sustain floor`);

    // Voice 3 is SID 2's first voice: a black key, drawn as sprite 0 in the
    // orange family at the black key's X.
    const kCs3 = expectedKey(Cs3);
    setVoice(3, { freq: noteFreq(Cs3), ctrl: 0x21, ad: 0x00, sr: 0xF0 });
    frame();
    check(level(kCs3) === 0xFF, `${name}: SID 2 voice did not strike its key`);
    check(rd(L('keySpriteEnable')) === 0x01, `${name}: sprite enable $${rd(L('keySpriteEnable')).toString(16)}, expected $01`);
    const x = rd(L('keySpriteX')) + ((rd(L('keySpriteMSB')) & 1) << 8);
    check(x === column(kCs3) * 8 + 21, `${name}: black key sprite X ${x}, expected ${column(kCs3) * 8 + 21}`);
    check(rd(L('keySpriteColour')) === 0x07, `${name}: black key colour $${rd(L('keySpriteColour')).toString(16)}, expected $7`);
    check(isBlack(kCs3), `${name}: C#3 is not a black key`);

    // Release: gate off with release $A (1.5 s, held to 40 frames). The key is
    // still lit after a few frames and back to white within 40.
    setVoice(0, { freq: noteFreq(E4), ctrl: 0x40, ad: 0x09, sr: 0x8A });
    for (let i = 0; i < 5; i++) frame();
    check(level(kE4) > 0, `${name}: released key went dark after 5 frames`);
    for (let i = 0; i < 40; i++) frame();
    check(level(kE4) === 0 && colourAt(kE4, KEYS_TOP_ROW) === 0x01 && colourAt(kE4, KEYS_BOTTOM_ROW) === 0x01,
        `${name}: released key not back to white after 45 frames (level ${level(kE4)})`);

    // A new note on a gate that stays on strikes again: an arpeggio lights
    // each of its keys.
    const kG2 = expectedKey(G2), kA4 = expectedKey(A4);
    setVoice(1, { freq: noteFreq(G2), ctrl: 0x11, ad: 0x00, sr: 0x04 });
    frame();
    setVoice(1, { freq: noteFreq(A4), ctrl: 0x11, ad: 0x00, sr: 0x04 });
    frame();
    check(level(kA4) === 0xFF, `${name}: arpeggio step did not strike its key`);
    check(level(kG2) > 0, `${name}: previous arpeggio key went dark in one frame`);
    check(colourAt(kA4, KEYS_BOTTOM_ROW) === 0x05, `${name}: voice 1 key colour $${colourAt(kA4, KEYS_BOTTOM_ROW).toString(16)}, expected $5 (green)`);

    // Silence everything: no sprite stays on.
    for (let v = 0; v < 6; v++) setVoice(v, {});
    for (let i = 0; i < 45; i++) frame();
    check(rd(L('keySpriteEnable')) === 0, `${name}: a sprite is still enabled after every voice stopped`);

    if (failures === failsBefore) console.log(`  ok  ${name}: ${notesChecked} frequencies, gate/release/arpeggio/sprites`);
}

async function main() {
    const m = await loadCpu();
    await runVariant(m, 'realtime', [], 25);
    await runVariant(m, 'shadow', ['SPECTROMETER_SHADOW'], 0x20);
    console.log(failures === 0 ? 'PASS' : `FAIL: ${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
