// piano-range.js - fit the Piano player to a tune: its keyboard range and its
// drum bar's low/mid/high split.
//
// The keyboard shows 68 keys, C to G across five octaves and a fifth; a note
// outside them is folded by octaves onto the nearest end. Which C the keyboard
// starts on is chosen per tune: step the tune on the analyser, count the key
// strikes the player would show (SIDPlayers/Piano/Piano.asm UpdatePiano), and
// take the start that puts the most of them on their own key rather than a
// folded one.
//
// Drums are noise, and the drum bar sorts each hit into a low, mid or high
// third by its noise frequency (the register's high byte). Tunes pitch their
// drums anywhere from $05 to $FF, so the two split points are measured too:
// the hits' distinct pitches, split at the two widest gaps between them.

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

// Strike counts per note (0..95) from a sequence of per-sample voice states
// ({ freq, ctrl } per voice), following the player's rules. Test-bit,
// no-waveform and zero-frequency voices are silent. Noise is a drum: it counts
// a drum hit (by frequency high byte) when it starts or its gate reopens, and
// the pitched body that follows under the same gate is not a note. A tonal
// strike is a gate rising, a note after silence, a new note with the gate off,
// or a jump of three semitones or more under a held gate (a chord tone);
// smaller steps under a held gate are slides and count nothing.
export function countStrikes(samples, voices) {
    return scanVoices(samples, voices).hits;
}

function scanVoices(samples, voices) {
    const hits = new Array(96).fill(0);
    const drumHits = new Map();
    const prev = Array.from({ length: voices }, () => ({ note: -1, gate: 0, noise: false, drum: false }));
    for (const sample of samples) {
        for (let v = 0; v < voices; v++) {
            const { freq, ctrl } = sample[v];
            const p = prev[v];
            const wave = ctrl & CTRL_WAVEFORMS, gate = ctrl & CTRL_GATE;
            if ((ctrl & CTRL_TEST) || !wave) {
                Object.assign(p, { note: -1, gate: 0, noise: false, drum: false });
                continue;
            }
            if (wave & CTRL_NOISE) {
                if (!p.noise || (gate && !p.gate)) drumHits.set(freq >> 8, (drumHits.get(freq >> 8) || 0) + 1);
                Object.assign(p, { note: -1, gate, noise: true, drum: true });
                continue;
            }
            p.noise = false;
            if (!freq) { Object.assign(p, { note: -1, gate: 0, drum: false }); continue; }
            const note = freqToNote(freq);
            const rose = gate && !p.gate;
            if (p.drum && !rose) { p.note = note; p.gate = gate; continue; }
            let strike = rose || p.note < 0 || (!gate && note !== p.note);
            if (!strike && gate && note !== p.note && Math.abs(note - p.note) >= 3) strike = true;
            if (strike) { hits[note]++; p.drum = false; }
            p.note = note; p.gate = gate;
        }
    }
    return { hits, drumHits };
}

// The drum bar's two split points (noise frequency high bytes; a hit at or
// above the first is mid, at or above the second high) from the counted hits,
// keyed by high byte. One pitch lights the middle; two, the outer thirds;
// more, split at the two widest gaps between neighbouring pitches on a log
// scale. [0, 0] (no drums) leaves the player's defaults.
export function drumSplit(drumHits) {
    const pitches = [...drumHits.keys()].sort((a, b) => a - b);
    if (!pitches.length) return [0, 0];
    const mid = (a, b) => Math.max(1, Math.ceil((a + b) / 2));
    if (pitches.length === 1) return [Math.max(1, pitches[0]), Math.min(255, pitches[0] + 1)];
    if (pitches.length === 2) { const t = mid(pitches[0], pitches[1]); return [t, t]; }
    const gaps = [];
    for (let i = 1; i < pitches.length; i++) {
        gaps.push({ at: i, width: Math.log2(pitches[i] + 1) - Math.log2(pitches[i - 1] + 1) });
    }
    const [g1, g2] = gaps.sort((a, b) => b.width - a.width).slice(0, 2).sort((a, b) => a.at - b.at);
    return [mid(pitches[g1.at - 1], pitches[g1.at]), mid(pitches[g2.at - 1], pitches[g2.at])];
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
// call, and pick its keyboard start and drum split. `chipAddresses` lists the
// SID chips the analysis found (default: one at $D400).
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
    const { hits, drumHits } = scanVoices(samples, voices);
    return { ...bestLowNote(hits), drumSplit: drumSplit(drumHits) };
}
