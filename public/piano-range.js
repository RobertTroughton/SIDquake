// piano-range.js - pick the Piano player's keyboard range for a tune.
//
// The keyboard shows 68 keys, C to G across five octaves and a fifth; a note
// outside them is folded by octaves onto the nearest end. Which C the keyboard
// starts on is chosen per tune: step the tune on the analyser, count the key
// strikes the player would show (SIDPlayers/Piano/Piano.asm UpdatePiano: a gate
// rising, or a voice landing on a new note), and take the start that puts the
// most of them on their own key rather than a folded one.

import { PAL_FRAME_HZ, PLAY_CYCLE_CAP, makeAnalyserApi, startTune } from './analyser-session.js';
import { parseSidHeader } from './psid.js';

export const PIANO_KEYS = 68;
// Leftmost C, as a note number (C0 = 0). Listed in preference order: on a tie
// the earlier wins, so a tune that fits either way keeps the usual C1 start.
export const PIANO_LOW_NOTES = [12, 24, 0, 36];
const SCAN_SECONDS = 300;

const PAL_CLOCK = 985248;
const C0_HZ = 16.3516;
const CTRL_GATE = 0x01, CTRL_TEST = 0x08, CTRL_WAVEFORMS = 0xF0, CTRL_NOISE = 0x80;

// The player's note for a frequency register value: the nearest semitone, as
// its PAL threshold table rounds it, clamped to C0..B7.
export function freqToNote(freq) {
    const hz = freq * PAL_CLOCK / 16777216;
    const n = Math.round(12 * Math.log2(hz / C0_HZ));
    return Math.max(0, Math.min(95, n));
}

// Strike counts per note (0..95) from a sequence of per-sample voice states,
// each { freq, ctrl } or null when nothing is known. The same rule as the
// player: noise-only, test-bit, no-waveform and zero-frequency voices are
// silent; a strike is a gate rising or a note other than the last one heard.
export function countStrikes(samples, voices) {
    const hits = new Array(96).fill(0);
    const prev = Array.from({ length: voices }, () => ({ note: -1, gate: 0 }));
    for (const sample of samples) {
        for (let v = 0; v < voices; v++) {
            const { freq, ctrl } = sample[v];
            const wave = ctrl & CTRL_WAVEFORMS;
            if ((ctrl & CTRL_TEST) || !wave || wave === CTRL_NOISE || !freq) {
                prev[v].note = -1; prev[v].gate = 0;
                continue;
            }
            const note = freqToNote(freq), gate = ctrl & CTRL_GATE;
            if (note !== prev[v].note || (gate && !prev[v].gate)) hits[note]++;
            prev[v].note = note; prev[v].gate = gate;
        }
    }
    return hits;
}

// The start (from PIANO_LOW_NOTES) that leaves the most strikes unfolded.
export function bestLowNote(hits) {
    let best = PIANO_LOW_NOTES[0], bestScore = -1;
    for (const low of PIANO_LOW_NOTES) {
        let score = 0;
        for (let n = low; n < low + PIANO_KEYS && n < hits.length; n++) score += hits[n];
        if (score > bestScore) { best = low; bestScore = score; }
    }
    const total = hits.reduce((a, b) => a + b, 0);
    return { lowNote: best, onKeyboard: bestScore, strikes: total };
}

// Step the tune for up to SCAN_SECONDS, sampling every voice once per play
// call, and pick its keyboard start. `chipAddresses` lists the SID chips the
// analysis found (default: one at $D400).
export function analyzePianoRange(module, sidBytes, opts) {
    const api = makeAnalyserApi(module);
    const { subtune = 0, chipAddresses = [0xD400] } = opts;
    const h = parseSidHeader(sidBytes);
    const tune = { musicStart: h.musicStart, speed: h.speed,
        initAddress: opts.initAddress, playAddress: opts.playAddress, loadAddress: opts.loadAddress };
    const { play, framesPerCall } = startTune(module, api, sidBytes, tune, { subtune });
    const voices = chipAddresses.length * 3;
    const samples = [];
    const calls = Math.floor(SCAN_SECONDS * PAL_FRAME_HZ / framesPerCall);
    for (let c = 0; play && c < calls; c++) {
        if (play(PLAY_CYCLE_CAP) === 0) break;
        const sample = [];
        for (const base of chipAddresses) {
            for (let v = 0; v < 3; v++) {
                const r = base + v * 7;
                sample.push({ freq: api.rd(r) | (api.rd(r + 1) << 8), ctrl: api.rd(r + 4) });
            }
        }
        samples.push(sample);
    }
    return bestLowNote(countStrikes(samples, voices));
}
