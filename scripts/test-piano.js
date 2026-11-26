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
//                        strikes again, and so does a note whose gate opened
//                        and closed between two frames' samples; a voice
//                        moving on lets its old key fade; noise lights the
//                        drum bar instead of a key, a slide shows only its
//                        first note, a chord keeps its keys lit, and the
//                        filter cutoff sets the filter bar's length
//   piano-range.js       the exporter's choice of the keyboard's leftmost C
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
const DRUM_ROW = 17, KEYS_TOP_ROW = 18, KEYS_BOTTOM_ROW = 23, FILTER_ROW = 24;
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
    const quiet = () => { for (let v = 0; v < 6; v++) setVoice(v, {}); for (let i = 0; i < 45; i++) frame(); };
    const hold = (v, regs, n = 1) => { setVoice(v, regs); for (let i = 0; i < n; i++) frame(); };
    const lit = () => { const out = []; for (let k = 0; k < NUM_KEYS; k++) if (level(k)) out.push(k); return out; };
    const drumColour = (col) => rd(0xD800 + DRUM_ROW * 40 + col);
    const drumDark = () => [0, 12, 14, 25, 27, 39].every(c => drumColour(c) === 0);

    // Silence: test bit, noise only, no waveform, zero frequency are no key.
    const E4 = 12 * 4 + 4, A4 = 12 * 4 + 9, Cs3 = 12 * 3 + 1, G2 = 12 * 2 + 7, C4 = 12 * 4;
    for (const [what, regs] of [
        ['test bit', { freq: noteFreq(A4), ctrl: 0x49 }],
        ['noise', { freq: noteFreq(A4), ctrl: 0x81 }],
        ['no waveform', { freq: noteFreq(A4), ctrl: 0x01 }],
        ['zero frequency', { freq: 0, ctrl: 0x41 }]]) {
        hold(0, regs);
        check(rd(L('voiceKey')) === 0xFF, `${name}: ${what} reads as a key`);
    }
    quiet();

    // A note is watched for a frame before its key lights: the first sample
    // can't tell a note from a drum. A gated pulse note on voice 0 then lights
    // its white key with two frames of flash (red), then the steady shade
    // (light red); sustain $8 holds it lit while the gate stays on.
    const kE4 = expectedKey(E4);
    hold(0, { freq: noteFreq(E4), ctrl: 0x41, ad: 0x09, sr: 0x8A });
    check(level(kE4) === 0, `${name}: a note lit on its first sample, before it could be told from a drum`);
    frame();
    check(level(kE4) === 0xFF, `${name}: struck key level ${level(kE4)}, expected 255`);
    check(colourAt(kE4, KEYS_TOP_ROW) === 0x02 && colourAt(kE4, KEYS_BOTTOM_ROW) === 0x02,
        `${name}: struck white key colour $${colourAt(kE4, KEYS_TOP_ROW).toString(16)}, expected $2`);
    frame();
    check(colourAt(kE4, KEYS_TOP_ROW) === 0x02, `${name}: white key flash lasted one frame, expected two`);
    frame();
    check(colourAt(kE4, KEYS_TOP_ROW) === 0x0A && colourAt(kE4, KEYS_BOTTOM_ROW) === 0x0A,
        `${name}: white key after its flash $${colourAt(kE4, KEYS_TOP_ROW).toString(16)}, expected $a (light red)`);
    for (let i = 0; i < 100; i++) frame();
    check(level(kE4) >= 112 + 8 * 9, `${name}: held key fell to ${level(kE4)} below its sustain floor`);

    // Voice 3 is SID 2's first voice: a black key, drawn as sprite 0 at the
    // black key's X, in grey whichever voice plays it: a light grey flash,
    // then mid grey.
    const kCs3 = expectedKey(Cs3);
    hold(3, { freq: noteFreq(Cs3), ctrl: 0x21, ad: 0x00, sr: 0xF0 }, 2);
    check(isBlack(kCs3), `${name}: C#3 is not a black key`);
    check(level(kCs3) === 0xFF, `${name}: SID 2 voice did not strike its key`);
    check(rd(L('keySpriteEnable')) === 0x01, `${name}: sprite enable $${rd(L('keySpriteEnable')).toString(16)}, expected $01`);
    const x = rd(L('keySpriteX')) + ((rd(L('keySpriteMSB')) & 1) << 8);
    check(x === column(kCs3) * 8 + 21, `${name}: black key sprite X ${x}, expected ${column(kCs3) * 8 + 21}`);
    check(rd(L('keySpriteColour')) === 0x0F, `${name}: struck black key colour $${rd(L('keySpriteColour')).toString(16)}, expected $f (light grey flash)`);
    frame(); frame();
    check(rd(L('keySpriteColour')) === 0x0C, `${name}: black key colour after its flash $${rd(L('keySpriteColour')).toString(16)}, expected $c (grey)`);

    // Release: gate off with release $A (1.5 s, held to 40 frames). The key is
    // still lit after a few frames and back to white within 40.
    hold(0, { freq: noteFreq(E4), ctrl: 0x40, ad: 0x09, sr: 0x8A }, 5);
    check(level(kE4) > 0, `${name}: released key went dark after 5 frames`);
    for (let i = 0; i < 40; i++) frame();
    check(level(kE4) === 0 && colourAt(kE4, KEYS_TOP_ROW) === 0x01 && colourAt(kE4, KEYS_BOTTOM_ROW) === 0x01,
        `${name}: released key not back to white after 45 frames (level ${level(kE4)})`);

    // A chord: a jump of three semitones or more under a held gate lights at
    // once, beside the note before it.
    const kG2 = expectedKey(G2), kA4 = expectedKey(A4);
    hold(1, { freq: noteFreq(G2), ctrl: 0x11, ad: 0x00, sr: 0x04 }, 2);
    hold(1, { freq: noteFreq(A4), ctrl: 0x11, ad: 0x00, sr: 0x04 });
    check(level(kA4) === 0xFF, `${name}: arpeggio step did not strike its key`);
    check(level(kG2) > 0, `${name}: previous arpeggio key went dark in one frame`);
    check(colourAt(kA4, KEYS_BOTTOM_ROW) === 0x05, `${name}: voice 1 key colour $${colourAt(kA4, KEYS_BOTTOM_ROW).toString(16)}, expected $5 (green)`);

    // A multispeed tune whose gate is only on for the first of two play calls
    // (Thanos B.'s Moonlight Sonata): the once-a-frame sample sees the hard
    // restart (test bit), then the new note with its gate already off. The key
    // must still be struck, and a different note with the gate off strikes too.
    const kC3 = expectedKey(12 * 3), kE3 = expectedKey(12 * 3 + 4);
    hold(2, { freq: noteFreq(12 * 3), ctrl: 0x09, ad: 0x0F, sr: 0x0F });
    hold(2, { freq: noteFreq(12 * 3), ctrl: 0x40, ad: 0x00, sr: 0xEA }, 2);
    check(level(kC3) === 0xFF, `${name}: note after a hard restart, gate already off: level ${level(kC3)}, expected 255`);
    hold(2, { freq: noteFreq(12 * 3 + 4), ctrl: 0x40, ad: 0x00, sr: 0xEA }, 2);
    check(level(kE3) === 0xFF, `${name}: new note with the gate off: level ${level(kE3)}, expected 255`);
    frame();
    check(level(kE3) < 0xFF, `${name}: a ringing note with the gate off was struck again`);

    // One voice is one finger: moving on lets the key it left fade out over
    // about 10 frames, whatever that note's release, even across the hard
    // restart's silent frame. A key another voice is holding stays down.
    const kD4 = expectedKey(12 * 4 + 2), kF4 = expectedKey(12 * 4 + 5), kG4 = expectedKey(12 * 4 + 7);
    quiet();
    hold(0, { freq: noteFreq(12 * 4 + 2), ctrl: 0x40, sr: 0x0E }, 2);
    hold(0, { freq: noteFreq(12 * 4 + 2), ctrl: 0x09, sr: 0x0E });
    hold(0, { freq: noteFreq(12 * 4 + 5), ctrl: 0x40, sr: 0x0E }, 3);
    check(level(kD4) > 0, `${name}: the key a voice left went dark within 2 frames`);
    for (let i = 0; i < 10; i++) frame();
    check(level(kD4) === 0, `${name}: the key a voice left is still lit after 12 frames (level ${level(kD4)})`);
    check(level(kF4) > 0, `${name}: the key the voice moved to went dark`);
    hold(1, { freq: noteFreq(12 * 4 + 5), ctrl: 0x41, sr: 0x8E }, 2);
    hold(0, { freq: noteFreq(12 * 4 + 7), ctrl: 0x40, sr: 0x0E }, 3);
    check(level(kF4) > 0 && level(kG4) > 0, `${name}: a key held by another voice was lifted`);

    // Drums. Noise held for two samples is a snare or hi-hat (low pitch, so
    // the low third of the drum bar); no key lights, the other zones stay
    // dark, the zone fades, and the next gated note is a note.
    quiet();
    hold(2, { freq: 0x3000, ctrl: 0x81, sr: 0x08 }, 2);
    check(drumColour(0) !== 0 && drumColour(12) === drumColour(0), `${name}: drum hit did not light the low zone (col 0 $${drumColour(0).toString(16)})`);
    check(drumColour(14) === 0 && drumColour(39) === 0, `${name}: a low drum lit another zone`);
    for (const f of [0x1800, 0x1400, 0x1000, 0x0c00]) hold(2, { freq: f, ctrl: 0x41, sr: 0x08 });
    check(lit().length === 0, `${name}: a drum's pitched body lit keys ${lit()}`);
    for (let i = 0; i < 12; i++) frame();
    check(drumColour(0) === 0, `${name}: drum zone still lit 16 frames after the hit`);
    hold(2, { freq: 0x0c00, ctrl: 0x40 });
    hold(2, { freq: noteFreq(A4), ctrl: 0x41, sr: 0x88 }, 2);
    check(level(kA4) === 0xFF, `${name}: a gated note after a drum was not struck`);

    // A noise blip, then silence: a click or hi-hat, here high-pitched.
    hold(2, { freq: 0xFF00, ctrl: 0x81 });
    hold(2, { freq: 0xFF00, ctrl: 0x08 });
    check(drumColour(39) !== 0 && drumColour(27) !== 0 && drumColour(0) === 0, `${name}: a noise blip then silence did not light (only) the high zone`);

    // One frame of noise opening a note that then holds its pitch (Magnar
    // Harestad's Bitgang starts its notes this way, and GP All Stars its lead
    // with an octave drop too) is the note's attack, not a drum.
    quiet();
    hold(2, { freq: 0xFFFF, ctrl: 0x81, sr: 0xCA });
    hold(2, { freq: noteFreq(A4 + 12), ctrl: 0x41, sr: 0xCA });
    hold(2, { freq: noteFreq(A4), ctrl: 0x41, sr: 0xCA }, 2);
    check(level(kA4) === 0xFF && lit().length === 1, `${name}: a note with a noise attack lit ${lit()}, expected only its key`);
    check(drumDark(), `${name}: a note's noise attack lit the drum bar`);

    // A pitch falling two semitones or more a sample, twice, with no noise at
    // all (GP All Stars' kicks): a kick, in the low zone, and no key.
    quiet();
    for (const n of [42, 38, 30, 24, 20]) hold(0, { freq: noteFreq(n), ctrl: 0x41, sr: 0x08 });
    check(lit().length === 0, `${name}: a falling kick lit keys ${lit()}`);
    check(drumColour(0) !== 0 && drumColour(39) === 0, `${name}: a falling kick did not light the low zone`);

    // A slide: one semitone a frame under a held gate shows only the note it
    // started on; where it comes to rest for three frames is a new note.
    quiet();
    hold(0, { freq: noteFreq(C4), ctrl: 0x41, sr: 0xF8 }, 2);
    for (let n = C4 + 1; n <= C4 + 5; n++) hold(0, { freq: noteFreq(n), ctrl: 0x41, sr: 0xF8 });
    check(lit().length === 1 && lit()[0] === expectedKey(C4), `${name}: a slide lit keys ${lit()}, expected only its first note`);
    frame();
    check(level(expectedKey(C4 + 5)) === 0, `${name}: a slide's resting note was struck after two frames`);
    frame();
    check(level(expectedKey(C4 + 5)) === 0xFF, `${name}: a slide's resting note was not struck after three frames`);

    // Vibrato that crosses into the next semitone for a sample at a time
    // (Bitgang's held chords) keeps the note's key lit at its sustain level,
    // and lights nothing else.
    quiet();
    const D2 = 12 * 2 + 2;
    hold(0, { freq: noteFreq(D2), ctrl: 0x51, sr: 0xCA }, 2);
    let lowest = 255, others = 0;
    for (let i = 0; i < 60; i++) {
        hold(0, { freq: noteFreq(D2 + (i % 5 === 3 ? 1 : i % 5 === 0 ? -1 : 0)), ctrl: 0x51, sr: 0xCA });
        lowest = Math.min(lowest, level(expectedKey(D2)));
        others = Math.max(others, lit().length - 1);
    }
    check(lowest >= 112 + 12 * 9, `${name}: vibrato let the held note fall to ${lowest}`);
    check(others === 0, `${name}: vibrato lit other keys`);

    // A chord: an arpeggio cycling A-C#-E under a held gate keeps all three lit,
    // and only flashes a key the first time round.
    quiet();
    const chord = [A4, A4 + 4, A4 + 7];
    for (let round = 0; round < 4; round++) {
        for (const n of chord) hold(1, { freq: noteFreq(n), ctrl: 0x41, sr: 0xA4 });
    }
    check(chord.every(n => level(expectedKey(n)) > 0), `${name}: an arpeggio's chord did not stay lit (${lit()})`);
    check(rd(L('keyFlash') + expectedKey(A4)) === 0 && rd(L('keyFlash') + expectedKey(A4 + 4)) === 0,
        `${name}: a chord note flashed again on its next time round`);

    // Filter bar: voice 1 routed through the filter, cutoff high byte $80, lights
    // 21 columns in voice 1's colour; with nothing routed, none.
    quiet();
    wr(mirror + 0x16, 0x80); wr(mirror + 0x17, 0x01);
    frame();
    const fcol = (c) => rd(0xD800 + FILTER_ROW * 40 + c);
    check(fcol(0) === 0x02 && fcol(20) === 0x02 && fcol(21) === 0,
        `${name}: filter bar cols 0/20/21 $${fcol(0).toString(16)}/$${fcol(20).toString(16)}/$${fcol(21).toString(16)}, expected $2/$2/$0`);
    wr(mirror + 0x17, 0x00);
    frame();
    check(fcol(0) === 0, `${name}: filter bar lit with nothing routed through the filter`);

    // Silence everything: no sprite stays on.
    quiet();
    check(rd(L('keySpriteEnable')) === 0, `${name}: a sprite is still enabled after every voice stopped`);

    if (failures === failsBefore) console.log(`  ok  ${name}: ${notesChecked} frequencies, gate/release/arpeggio/sprites`);
}

// The exporter's range pick (public/piano-range.js): the strike rule matches
// the player's, the window with the most unfolded strikes wins, and a real tune
// scans to an answer.
async function checkRange(m) {
    const failsBefore = failures;
    const { countStrikes, bestLowNote, freqToNote, analyzePianoRange, drumSplit, PIANO_LOW_NOTES } =
        await import('file://' + path.join(ROOT, 'public/piano-range.js'));
    const silent = { freq: 0, ctrl: 0 };

    for (let n = 0; n < 95; n++) check(freqToNote(noteFreq(n)) === n, `range: freqToNote(note ${n})`);

    // Gate pulse (struck once its pitch holds), hard restart, the same note
    // again for one sample only (replaced before it could hold: not shown, not
    // counted), a new note with the gate off, that note ringing, then noise:
    // two strikes, the same the player shows.
    const C3 = noteFreq(36), E3 = noteFreq(40);
    const hits = countStrikes([
        [{ freq: C3, ctrl: 0x41 }], [{ freq: C3, ctrl: 0x40 }], [{ freq: C3, ctrl: 0x09 }],
        [{ freq: C3, ctrl: 0x40 }], [{ freq: E3, ctrl: 0x40 }], [{ freq: E3, ctrl: 0x40 }],
        [{ freq: E3, ctrl: 0x81 }], [silent]], 1);
    check(hits[36] === 1 && hits[40] === 1 && hits.reduce((a, b) => a + b) === 2,
        `range: strikes counted ${JSON.stringify(hits.map((h, i) => h ? i + ':' + h : '').filter(Boolean))}`);

    const high = new Array(96).fill(0);
    high[30] = 5; high[80] = 10; high[90] = 10;      // F#2, G#6, F#7
    check(bestLowNote(high).lowNote === 24, `range: a high tune starts at C2 (got ${bestLowNote(high).lowNote})`);
    const low = new Array(96).fill(0);
    low[5] = 10; low[40] = 10;                       // F0, E3
    check(bestLowNote(low).lowNote === 0, `range: a deep bass starts at C0 (got ${bestLowNote(low).lowNote})`);
    check(bestLowNote(new Array(96).fill(0)).lowNote === 12, 'range: no notes keeps C1');

    // Drum split: three pitches land one per third; two, the outer thirds;
    // more, split at the widest gaps; none, the player's defaults.
    const zone = (hi, [t1, t2]) => (hi >= t1) + (hi >= t2);
    const split = (pitches) => drumSplit(new Map(pitches.map(p => [p, 1])));
    const three = split([0xC4, 0xDD, 0xFF]);
    check([0xC4, 0xDD, 0xFF].map(p => zone(p, three)).join() === '0,1,2', `range: three drum pitches split ${three}`);
    const two = split([0x31, 0x57]);
    check(zone(0x31, two) === 0 && zone(0x57, two) === 2, `range: two drum pitches split ${two}`);
    const many = split([0x05, 0x06, 0x07, 0x1D, 0x1F, 0x9C]);
    check([0x05, 0x07, 0x1D, 0x1F, 0x9C].map(p => zone(p, many)).join() === '0,0,1,1,2', `range: six drum pitches split ${many}`);
    check(split([]).join() === '0,0', 'range: no drums leaves the defaults');
    const drumSamples = [[{ freq: 0x3000, ctrl: 0x81 }], [{ freq: 0x1000, ctrl: 0x41 }], [{ freq: 0x0800, ctrl: 0x41 }]];
    check(countStrikes(drumSamples, 1).every(h => h === 0), 'range: a drum\'s pitched body counted as notes');

    const sidBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'SID/6r6-axelf.sid')));
    const h = Buffer.from(sidBytes), dataOffset = h.readUInt16BE(6);
    const res = analyzePianoRange(m, sidBytes, {
        initAddress: h.readUInt16BE(10), playAddress: h.readUInt16BE(12),
        loadAddress: h.readUInt16BE(8) || h.readUInt16LE(dataOffset) });
    check(PIANO_LOW_NOTES.includes(res.lowNote) && res.strikes > 100 && res.onKeyboard > res.strikes * 0.9,
        `range: Axel F scans to a keyboard (${JSON.stringify(res)})`);

    if (failures === failsBefore) console.log(`  ok  range pick: Axel F starts on note ${res.lowNote}, ${res.onKeyboard}/${res.strikes} strikes on their own keys`);
}

async function main() {
    const m = await loadCpu();
    await runVariant(m, 'realtime', [], 25);
    await runVariant(m, 'shadow', ['SPECTROMETER_SHADOW'], 0x20);
    await checkRange(m);
    console.log(failures === 0 ? 'PASS' : `FAIL: ${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
