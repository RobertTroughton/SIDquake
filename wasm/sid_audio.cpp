// sid_audio.cpp - reSID-based audio playback engine for SIDquake
// Provides cycle-accurate SID emulation via reSID library
// with a lightweight 6510 CPU for running SID play routines.
//
// Compile together with reSID sources via Emscripten.

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <new>
#include "resid/sid.h"
#include "cpu6510_core.h"
#include "c64_io.h"
#include "c64_env.h"

extern "C" {

// ---- Constants ----
static const double PAL_CLOCK  = 985248.0;
static const double NTSC_CLOCK = 1022730.0;
static const int PAL_CYCLES_PER_FRAME  = 19656;
static const int NTSC_CYCLES_PER_FRAME = 17095;
static const int MAX_SID_CHIPS = 3;

// ---- Playback state ----
static struct {
    // 6510 CPU registers
    uint16_t pc;
    uint8_t  sp, a, x, y, st;
    uint8_t  memory[65536];

    // reSID instances
    reSID::SID sid[MAX_SID_CHIPS];
    int        sidCount;
    uint16_t   sidAddress[MAX_SID_CHIPS];

    // SID file metadata
    uint16_t loadAddress;
    uint16_t initAddress;
    uint16_t playAddress;      // header value; 0 = handler installed by init
    uint16_t songs;
    uint16_t startSong;
    uint32_t speed;        // bit per subtune: 0=VBI, 1=CIA
    char     name[33];
    char     author[33];
    char     copyright[33];
    uint16_t flags;        // v2+ flags field
    uint8_t  secondSIDAddr;
    uint8_t  thirdSIDAddr;

    // Playback config
    double   clockFreq;
    double   sampleRate;
    int      cyclesPerFrame;
    int      currentSubtune;
    bool     isNTSC;
    bool     loaded;

    // Frame-level playback
    int      remainingCycles;  // cycles left in current frame
    bool     playRoutineActive;
    uint64_t totalCycles;      // SID cycles rendered since play started
    uint32_t callCycles;       // CPU cycles into the init or play call running
    int      chipModel;        // 6581 or 8580
    reSID::chip_model chipModels[MAX_SID_CHIPS];   // per chip, as last set

    // The play routine audio_set_subtune resolved: the header's address, or
    // with play address 0 the interrupt handler init installed.
    uint16_t playRoutine;
    bool     playIsIrq;
    bool     playViaKernal;

    // reSID with SAMPLE_FAST on an 8580 pipelines a register write until the
    // next cycle; flushed cycles are counted so the frame stays its length.
    int      samplingMethod;
    int      flushedCycles[MAX_SID_CHIPS];

    // Memory as audio_load_sid left it (stubs + tune), restored before each
    // init so a subtune never starts from what the previous one left behind.
    uint8_t  loadedMemory[65536];
} S;

static reSID::sampling_method resid_sampling(int method) {
    switch (method) {
        case 1:  return reSID::SAMPLE_INTERPOLATE;
        case 2:  return reSID::SAMPLE_RESAMPLE;
        default: return reSID::SAMPLE_FAST;
    }
}

// Put chip i in its power-on state: a newly constructed reSID::SID with this
// engine's model and sampling. reset() is not enough. It leaves the envelope
// counters where the last tune left them (as the RES line does on hardware),
// and a gate opened on a counter at $FF freezes it at zero, so a tune that
// followed a sustained note played silent; it also leaves the oscillator
// accumulators, so a tune rendered after another came out different from the
// same tune on a fresh module. The model tables are built once per process,
// so constructing a chip is cheap. The 8580 filter fills its noise table from
// rand() as it is constructed, so the generator is seeded per chip first: a
// chip's noise is then the same whatever was constructed before it.
static void sid_power_on(int i) {
    S.sid[i].~SID();
    srand(1 + i);
    new (&S.sid[i]) reSID::SID();
    S.sid[i].set_chip_model(S.chipModels[i]);
    S.sid[i].set_sampling_parameters(S.clockFreq, resid_sampling(S.samplingMethod), S.sampleRate);
}

// A write is only pipelined (and so needs flushing) with SAMPLE_FAST on an 8580.
static inline bool writesPipelined(int chip) {
    return S.samplingMethod == 0 && S.chipModels[chip] == reSID::MOS8580;
}

// ---- Memory access with SID register interception ----

// The SIDs sit in $D400-$D7FF and $DE00-$DFFF; everything outside that, and
// everything when I/O is banked out, is plain RAM.
static inline bool sid_area(uint16_t addr) {
    return addr >= 0xD400 && addr <= 0xDFFF && c64io::io_visible(S.memory[0x01]);
}

static inline uint8_t mem_read(uint16_t addr) {
    uint8_t io;
    if (c64io::read(addr, S.memory, S.totalCycles + S.callCycles, io)) return io;
    if (!sid_area(addr)) return S.memory[addr];
    // Primary SID reads
    if (addr >= 0xD400 && addr <= 0xD41F) {
        return S.sid[0].read(addr & 0x1F);
    }
    // Multi-SID reads
    for (int i = 1; i < S.sidCount; i++) {
        if (addr >= S.sidAddress[i] && addr < S.sidAddress[i] + 0x20) {
            return S.sid[i].read(addr & 0x1F);
        }
    }
    return S.memory[addr];
}

static inline void mem_write(uint16_t addr, uint8_t val) {
    S.memory[addr] = val;
    // CIA 1 repeats every 16 bytes: a timer latch written through a mirror
    // ($DC14) is the one audio_set_subtune reads at $DC04.
    if ((addr & 0xFF00) == 0xDC00 && c64io::io_visible(S.memory[0x01])) {
        S.memory[0xDC00 | (addr & 0x0F)] = val;
    }
    if (!sid_area(addr)) return;

    // Primary SID at $D400
    if (addr >= 0xD400 && addr <= 0xD41F) {
        S.sid[0].write(addr & 0x1F, val);
        // Flush MOS8580 write pipeline: with SAMPLE_FAST + MOS8580, reSID
        // defers writes to a single-slot pipeline (only the LAST write is
        // stored). Clock 1 cycle to apply each write immediately, and count it
        // against the frame.
        if (writesPipelined(0)) { S.sid[0].clock(); S.flushedCycles[0]++; }
        return;
    }
    // Multi-SID chips
    for (int i = 1; i < S.sidCount; i++) {
        if (addr >= S.sidAddress[i] && addr < S.sidAddress[i] + 0x20) {
            S.sid[i].write(addr & 0x1F, val);
            if (writesPipelined(i)) { S.sid[i].clock(); S.flushedCycles[i]++; }
            return;
        }
    }
    // SID mirror range ($D420-$D7FF) - mirror to chip 0 if no multi-SID mapped
    if (addr >= 0xD420 && addr < 0xD800) {
        S.memory[0xD400 | (addr & 0x1F)] = val;
        S.sid[0].write(addr & 0x1F, val);
        if (writesPipelined(0)) { S.sid[0].clock(); S.flushedCycles[0]++; }
    }
}

// ---- Bus adapter ----
// Binds the shared decoder in cpu6510_core.h to this engine's memory. Reads and
// writes go through the SID interception; instruction fetches are always plain
// RAM, as on the real machine where the CPU never executes from $D400.
static bool cpuJammed;
static int cpu_step();

struct AudioBus {
    uint16_t& pc;
    uint8_t& sp;
    uint8_t& a;
    uint8_t& x;
    uint8_t& y;
    uint8_t& st;

    uint8_t fetch(uint16_t addr) { return S.memory[addr]; }
    uint8_t read(uint16_t addr) { return mem_read(addr); }
    void write(uint16_t addr, uint8_t val) { mem_write(addr, val); }
    void dummyWrite(uint16_t addr, uint8_t val) { mem_write(addr, val); }
    void jumpTarget(uint16_t) {}
    void jam() { cpuJammed = true; }

    // For c64env::call. A call's cycles also drive the raster position the
    // I/O model reads (c64_io.h).
    int step() { int c = cpu_step(); S.callCycles += c; return c; }
    bool jammed() const { return cpuJammed; }
    void clearJam() { cpuJammed = false; }
};

// ---- 6510 CPU step: execute one instruction, return cycle count ----
static int cpu_step() {
    AudioBus bus{ S.pc, S.sp, S.a, S.x, S.y, S.st };
    return cpu6510::step(bus);
}

// ---- CPU init ----
static void cpu_init(uint16_t pc) {
    S.pc = pc;
    S.sp = 0xFD;
    S.a = S.x = S.y = 0;
    S.st = cpu6510::FLAG_U | cpu6510::FLAG_I;
}

// Run init or play to completion, or until maxCycles run out (c64env::call).
static void cpu_call(uint16_t addr, uint32_t maxCycles, bool irq = false, bool viaKernal = false) {
    AudioBus bus{ S.pc, S.sp, S.a, S.x, S.y, S.st };
    S.callCycles = 0;
    c64env::call(bus, addr, maxCycles, irq, viaKernal);
}

// ====================================================================
// WASM-exported functions
// ====================================================================

EMSCRIPTEN_KEEPALIVE
void audio_init(double sampleRate) {
    // Field-by-field reset: must NOT memset over the reSID::SID instances,
    // which are non-POD and own constructed state.
    S.pc = 0; S.sp = 0; S.a = 0; S.x = 0; S.y = 0; S.st = 0;
    memset(S.memory, 0, sizeof(S.memory));
    S.sidCount = 1;
    for (int i = 0; i < MAX_SID_CHIPS; i++) {
        S.sidAddress[i] = 0;
        S.sid[i].reset();
    }
    S.sidAddress[0] = 0xD400;
    S.loadAddress = 0; S.initAddress = 0; S.playAddress = 0;
    S.songs = 0; S.startSong = 0; S.speed = 0;
    S.name[0] = 0; S.author[0] = 0; S.copyright[0] = 0;
    S.flags = 0; S.secondSIDAddr = 0; S.thirdSIDAddr = 0;
    S.clockFreq = PAL_CLOCK;
    S.sampleRate = sampleRate > 0 ? sampleRate : 48000.0;
    S.cyclesPerFrame = PAL_CYCLES_PER_FRAME;
    S.currentSubtune = 0;
    S.isNTSC = false;
    S.loaded = false;
    S.remainingCycles = 0;
    S.playRoutineActive = false;
    S.totalCycles = 0;
    S.callCycles = 0;
    S.chipModel = 6581;
    for (int i = 0; i < MAX_SID_CHIPS; i++) S.chipModels[i] = reSID::MOS6581;
    S.playRoutine = 0;
    S.playIsIrq = S.playViaKernal = false;
    S.samplingMethod = 1;
    for (int i = 0; i < MAX_SID_CHIPS; i++) S.flushedCycles[i] = 0;
}

EMSCRIPTEN_KEEPALIVE
int audio_load_sid(const uint8_t* data, int length) {
    // The analyser's checks and resolved addresses (c64env::parse_psid); RSID
    // is accepted here. Errors as there: -1 too short, -2 not a SID, -4 bad
    // version, -5 bad data offset, -7 does not fit in 64K, -8 MUS data.
    c64env::Psid h;
    const int parsed = c64env::parse_psid(data, length < 0 ? 0 : (uint32_t)length, h);
    if (parsed < 0) return parsed;

    S.loadAddress = h.loadAddress;
    S.initAddress = h.initAddress;
    S.playAddress = h.playAddress;
    S.songs       = h.songs;
    S.startSong   = h.startSong;
    S.speed       = h.speed;
    S.flags       = h.flags;
    S.secondSIDAddr = h.secondSidByte;
    S.thirdSIDAddr  = h.thirdSidByte;
    memcpy(S.name, data + 0x16, 32); S.name[32] = 0;
    memcpy(S.author, data + 0x36, 32); S.author[32] = 0;
    memcpy(S.copyright, data + 0x56, 32); S.copyright[32] = 0;

    S.isNTSC = c64env::is_ntsc(S.flags);
    S.clockFreq = S.isNTSC ? NTSC_CLOCK : PAL_CLOCK;
    S.cyclesPerFrame = S.isNTSC ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;

    S.sidCount = 1;
    S.sidAddress[0] = 0xD400;
    for (uint8_t b : { S.secondSIDAddr, S.thirdSIDAddr }) {
        const uint16_t addr = c64env::sid_address(b);
        if (addr) S.sidAddress[S.sidCount++] = addr;
    }

    // The KERNAL stubs first, then the tune over them, so a tune that occupies
    // any of those addresses keeps its own bytes.
    memset(S.memory, 0, 65536);
    c64env::plant_kernal(S.memory);
    memcpy(&S.memory[S.loadAddress], data + h.musicStart, h.musicSize);
    memcpy(S.loadedMemory, S.memory, sizeof(S.memory));

    // Each chip's model from the header. The sampling method audio_init or
    // audio_set_sampling_method chose is kept: the song-length scan's fast
    // option sets it before loading.
    S.chipModel = c64env::chip_model(S.flags, 0);
    for (int i = 0; i < S.sidCount; i++) {
        S.chipModels[i] = c64env::chip_model(S.flags, i) == 8580 ? reSID::MOS8580 : reSID::MOS6581;
        sid_power_on(i);
    }

    S.loaded = true;
    S.totalCycles = 0;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void audio_set_subtune(int subtune) {
    if (!S.loaded) return;
    S.currentSubtune = subtune;

    for (int i = 0; i < S.sidCount; i++) {
        sid_power_on(i);
        S.flushedCycles[i] = 0;
    }

    memcpy(S.memory, S.loadedMemory, sizeof(S.memory));
    S.memory[0x01] = 0x37;
    S.cyclesPerFrame = S.isNTSC ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;

    // PSID convention: the subtune index (0-based) is passed in A — and also in
    // X and Y. Some tunes read the song number from X or Y (e.g. an init doing
    // "LDA songtable,X") rather than A; passing all three matches how a real
    // driver and SIDquake's own export engine call init, so playback and export
    // stay consistent (fixes multi-song tunes that sounded corrupt on preview).
    cpu_init(S.initAddress);
    S.a = S.x = S.y = subtune;
    S.totalCycles = 0;

    // Init gets a generous cycle budget - ~20 s of C64 time. A typical player's
    // init returns in a few hundred cycles, but a tune that unpacks or builds
    // tables in init needs far more (Julian_Jaymz/Slanted.sid: 2,040,135 cycles),
    // and a truncated init leaves the tune half-built so playback comes out silent
    // or garbled. Emulating 2 M cycles costs ~14 ms, so the budget is only a
    // backstop against a tune that never returns at all.
    cpu_call(S.initAddress, 20000000);
    for (int i = 0; i < S.sidCount; i++) S.flushedCycles[i] = 0;

    // CIA-driven tunes (speed bit set) latch the play period in $DC04/$DC05.
    // Subtunes past 32 share bit 31.
    if (S.speed & (1u << (subtune < 31 ? subtune : 31))) {
        // The timer counts its latch down to 0 and reloads: it fires every
        // latch + 1 cycles.
        uint16_t timerVal = S.memory[0xDC04] | (S.memory[0xDC05] << 8);
        if (timerVal > 0) {
            S.cyclesPerFrame = timerVal + 1;
        }
    }

    // Implicit play address: the handler this subtune's init installed.
    S.playRoutine = S.playAddress;
    S.playIsIrq = S.playViaKernal = false;
    if (S.playAddress == 0) {
        const c64env::IrqHandler handler = c64env::irq_handler(S.memory);
        S.playRoutine = handler.addr;
        S.playIsIrq = true;
        S.playViaKernal = handler.viaKernal;
    }

    S.remainingCycles = 0;
}

EMSCRIPTEN_KEEPALIVE
int audio_generate(int16_t* buffer, int numSamples) {
    if (!S.loaded || numSamples <= 0) return 0;

    int16_t mixBuf[8192];  // scratch buffer for additional SID chips
    int totalGenerated = 0;

    int loopGuard = 0;
    const int maxLoops = numSamples + 256;

    while (totalGenerated < numSamples && loopGuard++ < maxLoops) {
        // Run the play routine once per emulated frame.
        if (S.remainingCycles <= 0) {
            if (S.playRoutine == 0) break;
            cpu_call(S.playRoutine, (uint32_t)S.cyclesPerFrame, S.playIsIrq, S.playViaKernal);
            // Cycles a write flush already clocked chip 0 through are part of
            // this frame, not extra time.
            S.remainingCycles += S.cyclesPerFrame - S.flushedCycles[0];
            S.flushedCycles[0] = 0;
        }

        int remaining = numSamples - totalGenerated;
        // Never generate more per iteration than mixBuf can hold: the
        // multi-SID mix pass writes up to `generated` samples into it, so a
        // larger chunk would overflow the stack buffer. Larger requests are
        // simply produced across multiple loop iterations.
        if (remaining > (int)(sizeof(mixBuf) / sizeof(mixBuf[0]))) {
            remaining = (int)(sizeof(mixBuf) / sizeof(mixBuf[0]));
        }
        reSID::cycle_count delta = S.remainingCycles;
        int generated = S.sid[0].clock(delta, buffer + totalGenerated, remaining);
        int cyclesConsumed = S.remainingCycles - delta;

        // Mix any additional SID chips into the same output buffer, each scaled
        // by 1/sqrt(chips) as libsidplayfp's mono mixer does, with saturation.
        if (S.sidCount > 1) {
            const int32_t scale = S.sidCount == 2 ? 46341 : 37837;   // 65536 / sqrt(2), / sqrt(3)
            for (int s = 0; s < generated; s++) {
                buffer[totalGenerated + s] = (int16_t)((buffer[totalGenerated + s] * scale) >> 16);
            }
            for (int chip = 1; chip < S.sidCount; chip++) {
                int owed = cyclesConsumed - S.flushedCycles[chip];
                S.flushedCycles[chip] = owed < 0 ? -owed : 0;
                reSID::cycle_count delta2 = owed > 0 ? owed : 0;
                int gen2 = S.sid[chip].clock(delta2, mixBuf, generated);
                for (int s = 0; s < gen2; s++) {
                    int mixed = (int)buffer[totalGenerated + s] + ((mixBuf[s] * scale) >> 16);
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;
                    buffer[totalGenerated + s] = (int16_t)mixed;
                }
            }
        }

        S.remainingCycles = delta;  // reSID writes leftover cycles back via delta
        totalGenerated += generated;
        S.totalCycles += cyclesConsumed;

        // Guard against a zero-progress iteration that could spin forever.
        if (generated == 0 && cyclesConsumed == 0) {
            S.remainingCycles = 0;
        }
    }

    return totalGenerated;
}

EMSCRIPTEN_KEEPALIVE
// 6581 or 8580 forces every chip to that model; anything else returns to the
// header's model for each chip, as in sidplayfp_audio.cpp.
void audio_set_model(int model) {
    const bool forced = model == 6581 || model == 8580;
    S.chipModel = forced ? model : c64env::chip_model(S.flags, 0);
    for (int i = 0; i < S.sidCount; i++) {
        const int m = forced ? model : c64env::chip_model(S.flags, i);
        S.chipModels[i] = m == 8580 ? reSID::MOS8580 : reSID::MOS6581;
        S.sid[i].set_chip_model(S.chipModels[i]);
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_set_sampling_method(int method) {
    reSID::sampling_method m = resid_sampling(method);
    S.samplingMethod = method == 1 || method == 2 ? method : 0;
    for (int i = 0; i < S.sidCount; i++) {
        S.sid[i].set_sampling_parameters(S.clockFreq, m, S.sampleRate);
    }
}

// ---- Metadata accessors ----

EMSCRIPTEN_KEEPALIVE
const char* audio_get_title() { return S.name; }

EMSCRIPTEN_KEEPALIVE
const char* audio_get_author() { return S.author; }

EMSCRIPTEN_KEEPALIVE
const char* audio_get_copyright() { return S.copyright; }

EMSCRIPTEN_KEEPALIVE
int audio_get_subtune_count() { return S.songs; }

EMSCRIPTEN_KEEPALIVE
int audio_get_default_subtune() { return S.startSong; }

EMSCRIPTEN_KEEPALIVE
int audio_get_sid_model() { return S.chipModel; }

EMSCRIPTEN_KEEPALIVE
int audio_get_sid_count() { return S.sidCount; }

EMSCRIPTEN_KEEPALIVE
double audio_get_play_time() {
    return (double)S.totalCycles / S.clockFreq;
}

EMSCRIPTEN_KEEPALIVE
int audio_get_is_ntsc() { return S.isNTSC ? 1 : 0; }

// Engine RAM, for scripts/test-resid-engine.js.
EMSCRIPTEN_KEEPALIVE
int audio_peek(uint16_t addr) { return S.memory[addr]; }

EMSCRIPTEN_KEEPALIVE
void audio_cleanup() {
    for (int i = 0; i < MAX_SID_CHIPS; i++) {
        S.sid[i].reset();
    }
    S.loaded = false;
}

} // extern "C"
