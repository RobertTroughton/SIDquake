// loop-prepass.js - find where a tune's PLAYER repeats, from its SID register
// writes, before any audio is rendered.
//
// A SID player is a deterministic program stepped once per frame (or N times per
// frame on a CIA timer). Once its state comes round, every write it makes comes
// round with it, so the sequence of per-frame write fingerprints is exactly
// periodic from that point on. The 6510 analyser in sidquake.wasm runs a play
// call in microseconds, so twenty minutes of tune cost about a second here,
// where rendering the same twenty minutes of audio costs minutes.
//
// What comes out is the STATE loop: the frame the player's state first repeats
// from, and the period it repeats with, both exact. That is not the same thing
// as the loop a listener hears, and it is not what the exporter stores:
//
//   - the state period can be a MULTIPLE of the audible one, when something the
//     ear does not follow alternates between passes (a pulse width, a filter
//     value on a silent voice);
//   - the state intro can be LONGER than the audible one, when the first pass
//     starts from init values and later passes carry state over from the loop's
//     end - Axel F (6R6) spends its first 18 s with voice 2's pulse width on a
//     different phase and nothing else, and sounds identical throughout.
//
// So the audio pass still decides. What this buys it is the answer's SHAPE in
// advance: the audible period divides the state period, and the audible intro
// ends no later than the state one, so the render needs intro + one period + a
// confirm window rather than three passes of the loop, and detectLoop tests a
// handful of divisors at one known lag rather than every lag against the tail
// (spectrometer-bake.js, detectLoop's `hint`). A tune whose audio does not
// repeat where its state does - a player reading a timer the analyser does not
// model, say - fails that check and gets the full audio search as before.
//
// Nothing here is trusted on its own: a state loop that the audio does not
// confirm is discarded, and a tune this cannot drive (an init that never
// returns, a BASIC tune, a play routine that runs past the cycle cap) simply
// reports null and costs the audio pass nothing.

const PAL_CYCLES_PER_FRAME = 19656;    // 312 lines * 63 cycles
const NTSC_CYCLES_PER_FRAME = 17095;   // 263 lines * 65 cycles
const INIT_CYCLE_CAP = 20000000;       // ~20 s of C64 time, matches sid_analyze's per-song ceiling
const PLAY_CYCLE_CAP = 20000;          // one raster frame, matches sid_analyze
const MAX_CALLS_PER_FRAME = 16;

const be16 = (b, o) => (b[o] << 8) | b[o + 1];

// The header fields the pre-pass drives the tune from. Mirrors sid_processor.cpp.
export function parseSidHeader(bytes) {
    if (!bytes || bytes.length < 0x76) return null;
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'PSID' && magic !== 'RSID') return null;
    const version = be16(bytes, 4);
    const dataOffset = be16(bytes, 6);
    if (dataOffset + 2 > bytes.length) return null;
    const hdrLoad = be16(bytes, 8);
    const musicStart = hdrLoad === 0 ? dataOffset + 2 : dataOffset;
    const loadAddress = hdrLoad === 0 ? (bytes[dataOffset] | (bytes[dataOffset + 1] << 8)) : hdrLoad;
    const initAddress = be16(bytes, 10) || loadAddress;
    const flags = version >= 2 ? be16(bytes, 0x76) : 0;
    return {
        magic, version, loadAddress, musicStart,
        initAddress,
        playAddress: be16(bytes, 12),
        songs: be16(bytes, 0x0e),
        startSong: be16(bytes, 0x10),
        speed: ((bytes[0x12] << 24) | (bytes[0x13] << 16) | (bytes[0x14] << 8) | bytes[0x15]) >>> 0,
        // RSID flag bit 1: the tune is a BASIC program, nothing here can drive it.
        isBasic: magic === 'RSID' && (flags & 2) !== 0,
        isNtsc: (flags & 0x0c) === 0x08,
    };
}

function makeApi(module) {
    const cw = (n, r, a) => module.cwrap(n, r, a);
    return {
        cpuInit: cw('cpu_init', null, []),
        reset:   cw('cpu_reset_state_only', null, []),
        track:   cw('cpu_set_tracking', null, ['number']),
        wr:      cw('cpu_write_memory', null, ['number', 'number']),
        rd:      cw('cpu_read_memory', 'number', ['number']),
        setA:    cw('cpu_set_accumulator', null, ['number']),
        setX:    cw('cpu_set_xreg', null, ['number']),
        setY:    cw('cpu_set_yreg', null, ['number']),
        exec:    cw('cpu_execute_function', 'number', ['number', 'number']),
        record:  cw('cpu_set_record_writes', null, ['number']),
        seqLen:  cw('cpu_get_write_sequence_length', 'number', []),
        seqItem: cw('cpu_get_write_sequence_item', 'number', ['number']),
        ciaLo:   cw('cpu_get_cia_timer_lo', 'number', []),
        ciaHi:   cw('cpu_get_cia_timer_hi', 'number', []),
        ciaWritten: cw('cpu_get_cia_timer_written', 'number', []),
    };
}

// Load the tune into the analyser's RAM, run init for `subtune`, and fingerprint
// `maxFrames` worth of play calls: one FNV-1a hash per call over the addresses
// written, in order, and the value each one holds when the call returns.
// Registers a call does not touch are carried by the calls before it, so a
// sequence of these hashes repeats exactly when the player's output repeats.
//
// Returns { hashes, calls, callsPerFrame, framesPerCall } or null when the tune
// cannot be driven this way. framesPerCall is exact for a vsync tune (1) and for
// a CIA-timed one is the timer's share of a frame, so a period in calls converts
// to raster frames without assuming the timer divides the frame evenly.
export function fingerprintTune(module, sidBytes, { subtune = 0, maxFrames, isNtsc = false } = {}) {
    const h = parseSidHeader(sidBytes);
    if (!h || h.isBasic) return null;
    const api = makeApi(module);

    api.cpuInit();
    for (let i = h.musicStart; i < sidBytes.length; i++) {
        api.wr((h.loadAddress + (i - h.musicStart)) & 0xffff, sidBytes[i]);
    }
    api.reset();
    api.track(1);
    api.setA(subtune); api.setX(subtune); api.setY(subtune);
    if (!api.exec(h.initAddress, INIT_CYCLE_CAP)) return null;

    // A play address of 0 means init hung the play routine on an interrupt; read
    // the vector it installed, the way sid_analyze and the audio engine do.
    let play = h.playAddress;
    if (!play) {
        play = (api.rd(0x01) & 3) < 2
            ? (api.rd(0xfffe) | (api.rd(0xffff) << 8))
            : (api.rd(0x0314) | (api.rd(0x0315) << 8));
    }
    if (!play) return null;

    // Multispeed: this subtune's PSID speed bit says the play routine runs off
    // the CIA timer, and init programmed one. Subtunes past 32 share bit 31.
    // A CIA timer counts its latch down to zero and reloads, so it fires every
    // latch + 1 cycles: Blending_Mode programs 6551 and runs exactly three
    // calls a frame (6552 * 3 = 19656), and the audio repeats on that grid.
    const cyclesPerFrame = isNtsc ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;
    let callsPerFrame = 1, framesPerCall = 1;
    const speedBit = subtune < 31 ? subtune : 31;
    if (((h.speed >>> speedBit) & 1) && api.ciaWritten()) {
        const latch = api.ciaLo() | (api.ciaHi() << 8);
        if (latch > 0) {
            const cyclesPerCall = latch + 1;
            callsPerFrame = Math.min(MAX_CALLS_PER_FRAME, Math.max(1, Math.round(cyclesPerFrame / cyclesPerCall)));
            framesPerCall = cyclesPerCall / cyclesPerFrame;
        }
    }

    const maxCalls = Math.max(1, Math.floor(maxFrames / framesPerCall));
    const hashes = new Uint32Array(maxCalls);
    let calls = 0;
    for (; calls < maxCalls; calls++) {
        api.record(1);
        if (!api.exec(play, PLAY_CYCLE_CAP)) return null;
        let x = 0x811c9dc5;
        const len = api.seqLen();
        for (let i = 0; i < len; i++) {
            const addr = api.seqItem(i);
            x ^= addr; x = Math.imul(x, 0x01000193);
            x ^= api.rd(addr); x = Math.imul(x, 0x01000193);
        }
        hashes[calls] = x >>> 0;
    }
    return { hashes, calls, callsPerFrame, framesPerCall };
}

// The earliest point from which a sequence repeats, and the period it repeats
// with: the smallest I such that h[i] === h[i + P] for every i in [I, n - P), for
// some P >= minPeriod, where the repeat is seen over at least two full periods
// plus `confirm` more entries. Among periods that repeat from the same I the
// smallest wins, which is the fundamental: any other period of the same suffix
// is a multiple of it.
//
// Picking the earliest repeat rather than the shortest period is what keeps a
// phrase played three or four times in a row at the END of the scanned span
// from being reported as the loop - the true period explains the stream from
// the intro on, and a riff only explains its last few passes.
//
// Done in one pass with the prefix function of the reversed stream: the
// longest border of the suffix h[n-L..n) gives that suffix's smallest period
// directly, and every other period it has over that length is a multiple of
// it (Fine and Wilf), so each candidate intro costs O(1) after the O(n) table.
// Testing every lag against the tail instead is quadratic where it matters
// most - a player that has stopped and idles on identical frames matches at
// every lag - and a multispeed tune has up to 16 entries per frame.
export function findStatePeriod(hashes, n, minPeriod, confirm) {
    const minP = Math.max(1, minPeriod);
    if (n < 2 * minP + confirm) return null;
    // pi[j]: longest proper border of R[0..j], R being the stream reversed, i.e.
    // of the suffix h[n-1-j..n). Its smallest period is (j + 1) - pi[j].
    const pi = new Int32Array(n);
    for (let j = 1, k = 0; j < n; j++) {
        const c = hashes[n - 1 - j];
        while (k > 0 && c !== hashes[n - 1 - k]) k = pi[k - 1];
        if (c === hashes[n - 1 - k]) k++;
        pi[j] = k;
    }
    for (let L = n; L >= 2 * minP + confirm; L--) {
        const p = L - pi[L - 1];
        const P = p * Math.ceil(minP / p);
        if (2 * P + confirm <= L) return { period: P, intro: n - L };
    }
    return null;
}

// Run the pre-pass for one tune. Returns { introFrames, periodFrames, callsPerFrame,
// scannedFrames } - the state loop in raster frames - or null when no state loop
// is seen inside `maxFrames` (two passes plus `confirmFrames` have to fit) or the
// tune cannot be driven. `module` is an initialised sidquake.wasm instance; the
// analyser CPU it uses is separate from that module's audio engine.
export function findStateLoop(module, sidBytes, {
    subtune = 0, maxFrames, isNtsc = false, minLoopFrames = 100, confirmFrames = 200,
} = {}) {
    const fp = fingerprintTune(module, sidBytes, { subtune, maxFrames, isNtsc });
    if (!fp) return null;
    const toCalls = (frames) => Math.max(1, Math.round(frames / fp.framesPerCall));
    const found = findStatePeriod(fp.hashes, fp.calls, toCalls(minLoopFrames), toCalls(confirmFrames));
    if (!found) return null;
    return {
        introFrames: Math.round(found.intro * fp.framesPerCall),
        periodFrames: Math.max(1, Math.round(found.period * fp.framesPerCall)),
        callsPerFrame: fp.callsPerFrame,
        scannedFrames: Math.round(fp.calls * fp.framesPerCall),
    };
}
