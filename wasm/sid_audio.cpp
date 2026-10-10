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

// ---- Constants ----
static const double PAL_CLOCK  = 985248.0;
static const double NTSC_CLOCK = 1022730.0;
static const int PAL_CYCLES_PER_FRAME  = 19656;
static const int NTSC_CYCLES_PER_FRAME = 17095;
static const int MAX_SID_CHIPS = 3;

// ---- Playback state ----
// One engine: the 6510, its RAM, the reSID chips and the tune loaded into
// them. The exported audio_* API below drives a single default instance;
// native tests can create as many as they like.
struct ResidEngine {
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

    // Set by KIL/JAM opcodes; ends the call running
    bool     cpuJammed;

    void sidPowerOn(int i);
    bool writesPipelined(int chip) const;
    bool sidArea(uint16_t addr) const;
    uint8_t memRead(uint16_t addr);
    void memWrite(uint16_t addr, uint8_t val);
    int cpuStep();
    void cpuInit(uint16_t pc);
    void cpuCall(uint16_t addr, uint32_t maxCycles, bool irq = false, bool viaKernal = false);

    void init(double sampleRate);
    int loadSid(const uint8_t* data, int length);
    void setSubtune(int subtune);
    int generate(int16_t* buffer, int numSamples);
    void setModel(int model);
    void setSamplingMethod(int method);
};

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
void ResidEngine::sidPowerOn(int i) {
    sid[i].~SID();
    srand(1 + i);
    new (&sid[i]) reSID::SID();
    sid[i].set_chip_model(chipModels[i]);
    sid[i].set_sampling_parameters(clockFreq, resid_sampling(samplingMethod), sampleRate);
}

// A write is only pipelined (and so needs flushing) with SAMPLE_FAST on an 8580.
inline bool ResidEngine::writesPipelined(int chip) const {
    return samplingMethod == 0 && chipModels[chip] == reSID::MOS8580;
}

// ---- Memory access with SID register interception ----

// The SIDs sit in $D400-$D7FF and $DE00-$DFFF; everything outside that, and
// everything when I/O is banked out, is plain RAM.
inline bool ResidEngine::sidArea(uint16_t addr) const {
    return addr >= 0xD400 && addr <= 0xDFFF && c64io::io_visible(memory[0x01]);
}

inline uint8_t ResidEngine::memRead(uint16_t addr) {
    uint8_t io;
    if (c64io::read(addr, memory, totalCycles + callCycles, io)) return io;
    if (!sidArea(addr)) return memory[addr];
    // Primary SID reads
    if (addr >= 0xD400 && addr <= 0xD41F) {
        return sid[0].read(addr & 0x1F);
    }
    // Multi-SID reads
    for (int i = 1; i < sidCount; i++) {
        if (addr >= sidAddress[i] && addr < sidAddress[i] + 0x20) {
            return sid[i].read(addr & 0x1F);
        }
    }
    return memory[addr];
}

inline void ResidEngine::memWrite(uint16_t addr, uint8_t val) {
    memory[addr] = val;
    c64io::write(memory, addr, val);
    if (!sidArea(addr)) return;

    // Primary SID at $D400
    if (addr >= 0xD400 && addr <= 0xD41F) {
        sid[0].write(addr & 0x1F, val);
        // Flush MOS8580 write pipeline: with SAMPLE_FAST + MOS8580, reSID
        // defers writes to a single-slot pipeline (only the LAST write is
        // stored). Clock 1 cycle to apply each write immediately, and count it
        // against the frame.
        if (writesPipelined(0)) { sid[0].clock(); flushedCycles[0]++; }
        return;
    }
    // Multi-SID chips
    for (int i = 1; i < sidCount; i++) {
        if (addr >= sidAddress[i] && addr < sidAddress[i] + 0x20) {
            sid[i].write(addr & 0x1F, val);
            if (writesPipelined(i)) { sid[i].clock(); flushedCycles[i]++; }
            return;
        }
    }
    // SID mirror range ($D420-$D7FF) - mirror to chip 0 if no multi-SID mapped
    if (addr >= 0xD420 && addr < 0xD800) {
        memory[0xD400 | (addr & 0x1F)] = val;
        sid[0].write(addr & 0x1F, val);
        if (writesPipelined(0)) { sid[0].clock(); flushedCycles[0]++; }
    }
}

// ---- Bus adapter ----
// Binds the shared decoder in cpu6510_core.h to one engine's memory. Reads and
// writes go through the SID interception; instruction fetches are always plain
// RAM, as on the real machine where the CPU never executes from $D400.
struct AudioBus {
    ResidEngine& e;
    uint16_t& pc;
    uint8_t& sp;
    uint8_t& a;
    uint8_t& x;
    uint8_t& y;
    uint8_t& st;

    uint8_t fetch(uint16_t addr) { return e.memory[addr]; }
    uint8_t read(uint16_t addr) { return e.memRead(addr); }
    void write(uint16_t addr, uint8_t val) { e.memWrite(addr, val); }
    void dummyWrite(uint16_t addr, uint8_t val) { e.memWrite(addr, val); }
    void jumpTarget(uint16_t) {}
    void jam() { e.cpuJammed = true; }

    // For c64env::call. A call's cycles also drive the raster position the
    // I/O model reads (c64_io.h).
    int step() { int c = e.cpuStep(); e.callCycles += c; return c; }
    bool jammed() const { return e.cpuJammed; }
    void clearJam() { e.cpuJammed = false; }
};

// ---- 6510 CPU step: execute one instruction, return cycle count ----
int ResidEngine::cpuStep() {
    AudioBus bus{ *this, pc, sp, a, x, y, st };
    return cpu6510::step(bus);
}

// ---- CPU init ----
void ResidEngine::cpuInit(uint16_t start) {
    pc = start;
    sp = 0xFD;
    a = x = y = 0;
    st = cpu6510::FLAG_U | cpu6510::FLAG_I;
}

// Run init or play to completion, or until maxCycles run out (c64env::call).
void ResidEngine::cpuCall(uint16_t addr, uint32_t maxCycles, bool irq, bool viaKernal) {
    AudioBus bus{ *this, pc, sp, a, x, y, st };
    callCycles = 0;
    c64env::call(bus, addr, maxCycles, irq, viaKernal);
}

void ResidEngine::init(double rate) {
    // Field-by-field reset: must NOT memset over the reSID::SID instances,
    // which are non-POD and own constructed state.
    pc = 0; sp = 0; a = 0; x = 0; y = 0; st = 0;
    memset(memory, 0, sizeof(memory));
    sidCount = 1;
    for (int i = 0; i < MAX_SID_CHIPS; i++) {
        sidAddress[i] = 0;
        sid[i].reset();
    }
    sidAddress[0] = 0xD400;
    loadAddress = 0; initAddress = 0; playAddress = 0;
    songs = 0; startSong = 0; speed = 0;
    name[0] = 0; author[0] = 0; copyright[0] = 0;
    flags = 0; secondSIDAddr = 0; thirdSIDAddr = 0;
    clockFreq = PAL_CLOCK;
    sampleRate = rate > 0 ? rate : 48000.0;
    cyclesPerFrame = PAL_CYCLES_PER_FRAME;
    currentSubtune = 0;
    isNTSC = false;
    loaded = false;
    remainingCycles = 0;
    playRoutineActive = false;
    totalCycles = 0;
    callCycles = 0;
    chipModel = 6581;
    for (int i = 0; i < MAX_SID_CHIPS; i++) chipModels[i] = reSID::MOS6581;
    playRoutine = 0;
    playIsIrq = playViaKernal = false;
    samplingMethod = 1;
    for (int i = 0; i < MAX_SID_CHIPS; i++) flushedCycles[i] = 0;
}

int ResidEngine::loadSid(const uint8_t* data, int length) {
    // The analyser's checks and resolved addresses (c64env::parse_psid); RSID
    // is accepted here. Errors as there: -1 too short, -2 not a SID, -4 bad
    // version, -5 bad data offset, -7 does not fit in 64K, -8 MUS data.
    c64env::Psid h;
    const int parsed = c64env::parse_psid(data, length < 0 ? 0 : (uint32_t)length, h);
    if (parsed < 0) return parsed;

    loadAddress = h.loadAddress;
    initAddress = h.initAddress;
    playAddress = h.playAddress;
    songs       = h.songs;
    startSong   = h.startSong;
    speed       = h.speed;
    flags       = h.flags;
    secondSIDAddr = h.secondSidByte;
    thirdSIDAddr  = h.thirdSidByte;
    memcpy(name, data + 0x16, 32); name[32] = 0;
    memcpy(author, data + 0x36, 32); author[32] = 0;
    memcpy(copyright, data + 0x56, 32); copyright[32] = 0;

    isNTSC = c64env::is_ntsc(flags);
    clockFreq = isNTSC ? NTSC_CLOCK : PAL_CLOCK;
    cyclesPerFrame = isNTSC ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;

    sidCount = 1;
    sidAddress[0] = 0xD400;
    for (uint8_t b : { secondSIDAddr, thirdSIDAddr }) {
        const uint16_t addr = c64env::sid_address(b);
        if (addr) sidAddress[sidCount++] = addr;
    }

    // The KERNAL stubs first, then the tune over them, so a tune that occupies
    // any of those addresses keeps its own bytes.
    memset(memory, 0, 65536);
    c64env::plant_kernal(memory);
    memcpy(&memory[loadAddress], data + h.musicStart, h.musicSize);
    memcpy(loadedMemory, memory, sizeof(memory));

    // Each chip's model from the header. The sampling method audio_init or
    // audio_set_sampling_method chose is kept: the song-length scan's fast
    // option sets it before loading.
    chipModel = c64env::chip_model(flags, 0);
    for (int i = 0; i < sidCount; i++) {
        chipModels[i] = c64env::chip_model(flags, i) == 8580 ? reSID::MOS8580 : reSID::MOS6581;
        sidPowerOn(i);
    }

    loaded = true;
    totalCycles = 0;
    return 0;
}

void ResidEngine::setSubtune(int subtune) {
    if (!loaded) return;
    currentSubtune = subtune;

    for (int i = 0; i < sidCount; i++) {
        sidPowerOn(i);
        flushedCycles[i] = 0;
    }

    memcpy(memory, loadedMemory, sizeof(memory));
    memory[0x01] = 0x37;
    cyclesPerFrame = isNTSC ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;

    // PSID convention: the subtune index (0-based) is passed in A — and also in
    // X and Y. Some tunes read the song number from X or Y (e.g. an init doing
    // "LDA songtable,X") rather than A; passing all three matches how a real
    // driver and SIDquake's own export engine call init, so playback and export
    // stay consistent (fixes multi-song tunes that sounded corrupt on preview).
    cpuInit(initAddress);
    a = x = y = subtune;
    totalCycles = 0;

    // Init gets a generous cycle budget - ~20 s of C64 time. A typical player's
    // init returns in a few hundred cycles, but a tune that unpacks or builds
    // tables in init needs far more (Julian_Jaymz/Slanted.sid: 2,040,135 cycles),
    // and a truncated init leaves the tune half-built so playback comes out silent
    // or garbled. Emulating 2 M cycles costs ~14 ms, so the budget is only a
    // backstop against a tune that never returns at all.
    cpuCall(initAddress, 20000000);
    for (int i = 0; i < sidCount; i++) flushedCycles[i] = 0;

    // CIA-driven tunes (speed bit set) latch the play period in $DC04/$DC05.
    // Subtunes past 32 share bit 31.
    if (speed & (1u << (subtune < 31 ? subtune : 31))) {
        // The timer counts its latch down to 0 and reloads: it fires every
        // latch + 1 cycles.
        uint16_t timerVal = memory[0xDC04] | (memory[0xDC05] << 8);
        if (timerVal > 0) {
            cyclesPerFrame = timerVal + 1;
        }
    }

    // Implicit play address: the handler this subtune's init installed.
    playRoutine = playAddress;
    playIsIrq = playViaKernal = false;
    if (playAddress == 0) {
        const c64env::IrqHandler handler = c64env::irq_handler(memory);
        playRoutine = handler.addr;
        playIsIrq = true;
        playViaKernal = handler.viaKernal;
    }

    remainingCycles = 0;
}

int ResidEngine::generate(int16_t* buffer, int numSamples) {
    if (!loaded || numSamples <= 0) return 0;

    int16_t mixBuf[8192];  // scratch buffer for additional SID chips
    int totalGenerated = 0;

    int loopGuard = 0;
    const int maxLoops = numSamples + 256;

    while (totalGenerated < numSamples && loopGuard++ < maxLoops) {
        // Run the play routine once per emulated frame.
        if (remainingCycles <= 0) {
            if (playRoutine == 0) break;
            cpuCall(playRoutine, (uint32_t)cyclesPerFrame, playIsIrq, playViaKernal);
            // Cycles a write flush already clocked chip 0 through are part of
            // this frame, not extra time.
            remainingCycles += cyclesPerFrame - flushedCycles[0];
            flushedCycles[0] = 0;
        }

        int remaining = numSamples - totalGenerated;
        // Never generate more per iteration than mixBuf can hold: the
        // multi-SID mix pass writes up to `generated` samples into it, so a
        // larger chunk would overflow the stack buffer. Larger requests are
        // simply produced across multiple loop iterations.
        if (remaining > (int)(sizeof(mixBuf) / sizeof(mixBuf[0]))) {
            remaining = (int)(sizeof(mixBuf) / sizeof(mixBuf[0]));
        }
        reSID::cycle_count delta = remainingCycles;
        int generated = sid[0].clock(delta, buffer + totalGenerated, remaining);
        int cyclesConsumed = remainingCycles - delta;

        // Mix any additional SID chips into the same output buffer, each scaled
        // by 1/sqrt(chips) as libsidplayfp's mono mixer does, with saturation.
        if (sidCount > 1) {
            const int32_t scale = sidCount == 2 ? 46341 : 37837;   // 65536 / sqrt(2), / sqrt(3)
            for (int s = 0; s < generated; s++) {
                buffer[totalGenerated + s] = (int16_t)((buffer[totalGenerated + s] * scale) >> 16);
            }
            for (int chip = 1; chip < sidCount; chip++) {
                int owed = cyclesConsumed - flushedCycles[chip];
                flushedCycles[chip] = owed < 0 ? -owed : 0;
                reSID::cycle_count delta2 = owed > 0 ? owed : 0;
                int gen2 = sid[chip].clock(delta2, mixBuf, generated);
                for (int s = 0; s < gen2; s++) {
                    int mixed = (int)buffer[totalGenerated + s] + ((mixBuf[s] * scale) >> 16);
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;
                    buffer[totalGenerated + s] = (int16_t)mixed;
                }
            }
        }

        remainingCycles = delta;  // reSID writes leftover cycles back via delta
        totalGenerated += generated;
        totalCycles += cyclesConsumed;

        // Guard against a zero-progress iteration that could spin forever.
        if (generated == 0 && cyclesConsumed == 0) {
            remainingCycles = 0;
        }
    }

    return totalGenerated;
}

// 6581 or 8580 forces every chip to that model; anything else returns to the
// header's model for each chip, as in sidplayfp_audio.cpp.
void ResidEngine::setModel(int model) {
    const bool forced = model == 6581 || model == 8580;
    chipModel = forced ? model : c64env::chip_model(flags, 0);
    for (int i = 0; i < sidCount; i++) {
        const int m = forced ? model : c64env::chip_model(flags, i);
        chipModels[i] = m == 8580 ? reSID::MOS8580 : reSID::MOS6581;
        sid[i].set_chip_model(chipModels[i]);
    }
}

void ResidEngine::setSamplingMethod(int method) {
    reSID::sampling_method m = resid_sampling(method);
    samplingMethod = method == 1 || method == 2 ? method : 0;
    for (int i = 0; i < sidCount; i++) {
        sid[i].set_sampling_parameters(clockFreq, m, sampleRate);
    }
}

// The instance the exported API drives.
static ResidEngine S;

// ====================================================================
// WASM-exported functions
// ====================================================================

extern "C" {

EMSCRIPTEN_KEEPALIVE
void audio_init(double sampleRate) { S.init(sampleRate); }

EMSCRIPTEN_KEEPALIVE
int audio_load_sid(const uint8_t* data, int length) { return S.loadSid(data, length); }

EMSCRIPTEN_KEEPALIVE
void audio_set_subtune(int subtune) { S.setSubtune(subtune); }

EMSCRIPTEN_KEEPALIVE
int audio_generate(int16_t* buffer, int numSamples) { return S.generate(buffer, numSamples); }

EMSCRIPTEN_KEEPALIVE
void audio_set_model(int model) { S.setModel(model); }

EMSCRIPTEN_KEEPALIVE
void audio_set_sampling_method(int method) { S.setSamplingMethod(method); }

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
