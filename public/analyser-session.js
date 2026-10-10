// analyser-session.js - drive a tune on the 6510 analyser in sidquake.wasm from
// JS: load it, run init for a subtune, and hand back a play caller with the
// subtune's play rate. Shared by the register pre-pass (loop-prepass.js) and the
// shadow and VU scans (spectrometer-shadow-detect.js).
//
// The analyser CPU is one per module and separate from that module's audio
// engine; each startTune() reinitialises it.

const PAL_CYCLES_PER_FRAME = 19656;    // 312 lines * 63 cycles
const NTSC_CYCLES_PER_FRAME = 17095;   // 263 lines * 65 cycles
const MAX_CALLS_PER_FRAME = 16;
// Init's cycle budget: sid_analyze's per-song ceiling, ~20 s of C64 time.
// Julian_Jaymz/Slanted's init alone takes 2,040,135 cycles.
export const INIT_CYCLE_CAP = 20000000;
export const PLAY_CYCLE_CAP = 20000;   // one raster frame, matches sid_analyze

export function makeAnalyserApi(module) {
    const cw = (n, r, a) => module.cwrap(n, r, a);
    return {
        cpuInit: cw('cpu_init', null, []),
        reset:   cw('cpu_reset_state_only', null, []),
        track:   cw('cpu_set_tracking', null, ['number']),
        wr:      cw('cpu_write_memory', null, ['number', 'number']),
        rd:      cw('cpu_read_memory', 'number', ['number']),
        access:  cw('cpu_get_memory_access', 'number', ['number']),
        setA:    cw('cpu_set_accumulator', null, ['number']),
        setX:    cw('cpu_set_xreg', null, ['number']),
        setY:    cw('cpu_set_yreg', null, ['number']),
        exec:    cw('cpu_execute_function', 'number', ['number', 'number']),
        execIrq: cw('cpu_execute_interrupt', 'number', ['number', 'number', 'number']),
        irqHandler: cw('cpu_get_irq_handler', 'number', []),
        env:     cw('cpu_setup_c64_env', null, []),
        record:  cw('cpu_set_record_writes', null, ['number']),
        seqLen:  cw('cpu_get_write_sequence_length', 'number', []),
        seqItem: cw('cpu_get_write_sequence_item', 'number', ['number']),
        sidWrites: cw('cpu_get_sid_writes', 'number', ['number']),
        ciaLo:   cw('cpu_get_cia_timer_lo', 'number', []),
        ciaHi:   cw('cpu_get_cia_timer_hi', 'number', []),
        ciaWritten: cw('cpu_get_cia_timer_written', 'number', []),
    };
}

// Copy the music into the analyser's RAM in one call. Bytes that would land
// past $FFFF are dropped: sid_analyze refuses such a tune outright, and wrapping
// them round would overwrite zero page.
export function loadMusic(module, sidBytes, musicStart, loadAddress) {
    const music = sidBytes.subarray(musicStart, musicStart + 0x10000 - loadAddress);
    if (!music.length) return;
    const ptr = module._malloc(music.length);
    module.HEAPU8.set(music, ptr);
    module.cwrap('cpu_load_memory', null, ['number', 'number', 'number'])(loadAddress, ptr, music.length);
    module._free(ptr);
}

// Returns a function that runs one play call within a cycle cap and answers
// whether it returned, or null when there is nothing to call. A play address
// of 0 means init hung the play routine on an interrupt: take the handler it
// installed and enter it as one, so the RTI or JMP $EA31 that ends it counts
// as the return (cpu_get_irq_handler / cpu_execute_interrupt).
export function playCaller(api, playAddress) {
    if (playAddress) return (cap) => api.exec(playAddress, cap);
    const handler = api.irqHandler();
    const addr = handler & 0xffff, viaKernal = handler > 0xffff ? 1 : 0;
    if (!addr) return null;
    return (cap) => api.execIrq(addr, cap, viaKernal);
}

// How often a subtune's play routine runs, read once its init has run.
// Multispeed: this subtune's PSID speed bit says the play routine runs off
// the CIA timer, and init programmed one. Subtunes past 32 share bit 31.
// A CIA timer counts its latch down to zero and reloads, so it fires every
// latch + 1 cycles: Blending_Mode programs 6551 and runs exactly three
// calls a frame (6552 * 3 = 19656), and the audio repeats on that grid.
export function playTiming({ speed, subtune, isNtsc = false, ciaWritten, latch }) {
    const cyclesPerFrame = isNtsc ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;
    let callsPerFrame = 1, framesPerCall = 1;
    const speedBit = subtune < 31 ? subtune : 31;
    if (((speed >>> speedBit) & 1) && ciaWritten && latch > 0) {
        const cyclesPerCall = latch + 1;
        callsPerFrame = Math.min(MAX_CALLS_PER_FRAME, Math.max(1, Math.round(cyclesPerFrame / cyclesPerCall)));
        framesPerCall = cyclesPerCall / cyclesPerFrame;
    }
    return { callsPerFrame, framesPerCall };
}

// Reset the analyser CPU and its C64 environment, load the music `tune`
// describes ({ musicStart, loadAddress, initAddress, playAddress, speed }, as
// parseSidHeader in psid.js returns it), poke `patches` ([address, value] pairs)
// over it, and run init for `subtune` with write tracking on. Returns
// { play, callsPerFrame, framesPerCall }: `play` is the playCaller, or null when
// init did not return or left nothing to call; the timing is read either way.
export function startTune(module, api, sidBytes, tune, { subtune = 0, isNtsc = false, patches = null } = {}) {
    api.cpuInit();
    api.env();
    loadMusic(module, sidBytes, tune.musicStart, tune.loadAddress);
    if (patches) for (const [addr, val] of patches) api.wr(addr & 0xffff, val & 0xff);
    api.reset();
    api.track(1);
    api.setA(subtune); api.setX(subtune); api.setY(subtune);
    const inited = api.exec(tune.initAddress, INIT_CYCLE_CAP);
    const play = inited ? playCaller(api, tune.playAddress) : null;
    const timing = playTiming({
        speed: tune.speed, subtune, isNtsc,
        ciaWritten: api.ciaWritten(), latch: api.ciaLo() | (api.ciaHi() << 8),
    });
    return { play, ...timing };
}
