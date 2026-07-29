// sid_audio.cpp - reSID-based audio playback engine for SIDquake
// Provides cycle-accurate SID emulation via reSID library
// with a lightweight 6510 CPU for running SID play routines.
//
// Compile together with reSID sources via Emscripten.

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstring>
#include <cmath>
#include "resid/sid.h"
#include "cpu6510_core.h"

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
    uint16_t playAddress;
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
    uint64_t totalCycles;      // total cycles since play started
    int      chipModel;        // 6581 or 8580
} S;

// ---- Memory access with SID register interception ----

static inline uint8_t mem_read(uint16_t addr) {
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

    // Primary SID at $D400
    if (addr >= 0xD400 && addr <= 0xD41F) {
        S.sid[0].write(addr & 0x1F, val);
        // Flush MOS8580 write pipeline: with SAMPLE_FAST + MOS8580, reSID
        // defers writes to a single-slot pipeline (only the LAST write is
        // stored). Clock 1 cycle to apply each write immediately.
        S.sid[0].clock();
        return;
    }
    // Multi-SID chips
    for (int i = 1; i < S.sidCount; i++) {
        if (addr >= S.sidAddress[i] && addr < S.sidAddress[i] + 0x20) {
            S.sid[i].write(addr & 0x1F, val);
            S.sid[i].clock();
            return;
        }
    }
    // SID mirror range ($D420-$D7FF) - mirror to chip 0 if no multi-SID mapped
    if (addr >= 0xD420 && addr < 0xD800) {
        S.memory[0xD400 | (addr & 0x1F)] = val;
        S.sid[0].write(addr & 0x1F, val);
    }
}

// ---- Stack helper (used by cpu_jsr to plant a sentinel return address) ----
static inline void push8(uint8_t val) {
    S.memory[0x100 + S.sp] = val;
    S.sp--;
}
static inline void push16(uint16_t val) {
    push8((val >> 8) & 0xFF);
    push8(val & 0xFF);
}

// ---- Bus adapter ----
// Binds the shared decoder in cpu6510_core.h to this engine's memory. Reads and
// writes go through the SID interception; instruction fetches are always plain
// RAM, as on the real machine where the CPU never executes from $D400.
static bool cpuJammed;

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
    void jumpTarget(uint16_t) {}
    void jam() { cpuJammed = true; }
};

// ---- 6510 CPU step: execute one instruction, return cycle count ----
static int cpu_step() {
    AudioBus bus{ S.pc, S.sp, S.a, S.x, S.y, S.st };
    return cpu6510::step(bus);
}

// ---- CPU init ----
static void cpu_init(uint16_t pc) {
    S.pc = pc;
    S.sp = 0xFF;
    S.a = S.x = S.y = 0;
    S.st = cpu6510::FLAG_U | cpu6510::FLAG_I;
}

// Run a subroutine to completion or until maxCycles is exceeded.
// A sentinel return address is pushed so the matching RTS lands on a known PC
// and an SP-comparison can detect it without scanning the call graph.
static void cpu_jsr(uint16_t addr, uint32_t maxCycles) {
    push16(0xFFFF);
    S.pc = addr;
    uint32_t cyclesRun = 0;
    uint8_t initialSP = S.sp + 2;  // SP before the sentinel push
    cpuJammed = false;

    while (cyclesRun < maxCycles) {
        int cyc = cpu_step();
        cyclesRun += cyc;
        S.totalCycles += cyc;

        if (cpuJammed) break;  // KIL opcode; the CPU would never come back
        if (S.sp >= initialSP) break;  // matching RTS executed
        if (S.pc == 0 || S.pc == 0xFFFF) break;  // BRK or sentinel landing
    }
}

// ---- SID file header (PSID/RSID v1-v4) ----
#pragma pack(push, 1)
struct SIDFileHeader {
    char     magicID[4];
    uint8_t  versionHi, versionLo;
    uint8_t  dataOffsetHi, dataOffsetLo;
    uint8_t  loadAddrHi, loadAddrLo;
    uint8_t  initAddrHi, initAddrLo;
    uint8_t  playAddrHi, playAddrLo;
    uint8_t  songsHi, songsLo;
    uint8_t  startSongHi, startSongLo;
    uint8_t  speedB3, speedB2, speedB1, speedB0;
    char     name[32];
    char     author[32];
    char     copyright[32];
    // v2+ fields follow at offset 0x76
};
#pragma pack(pop)

static uint16_t be16(uint8_t hi, uint8_t lo) { return (hi << 8) | lo; }

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
    S.chipModel = 6581;
}

EMSCRIPTEN_KEEPALIVE
int audio_load_sid(const uint8_t* data, int length) {
    if (length < 0x7C) return -1;

    const SIDFileHeader* hdr = (const SIDFileHeader*)data;

    if (memcmp(hdr->magicID, "PSID", 4) != 0 &&
        memcmp(hdr->magicID, "RSID", 4) != 0) {
        return -2;
    }

    uint16_t version    = be16(hdr->versionHi, hdr->versionLo);
    uint16_t dataOffset = be16(hdr->dataOffsetHi, hdr->dataOffsetLo);
    S.loadAddress  = be16(hdr->loadAddrHi, hdr->loadAddrLo);
    S.initAddress  = be16(hdr->initAddrHi, hdr->initAddrLo);
    S.playAddress  = be16(hdr->playAddrHi, hdr->playAddrLo);
    S.songs        = be16(hdr->songsHi, hdr->songsLo);
    S.startSong    = be16(hdr->startSongHi, hdr->startSongLo);
    S.speed        = ((uint32_t)hdr->speedB3 << 24) | ((uint32_t)hdr->speedB2 << 16) |
                     ((uint32_t)hdr->speedB1 << 8)  | hdr->speedB0;

    memcpy(S.name, hdr->name, 32); S.name[32] = 0;
    memcpy(S.author, hdr->author, 32); S.author[32] = 0;
    memcpy(S.copyright, hdr->copyright, 32); S.copyright[32] = 0;

    // PSID convention: loadAddress=0 means the first two data bytes hold the
    // actual load address (little-endian) and are stripped off the payload.
    const uint8_t* musicData = data + dataOffset;
    int musicLen = length - dataOffset;
    if (S.loadAddress == 0 && musicLen >= 2) {
        S.loadAddress = musicData[0] | (musicData[1] << 8);
        musicData += 2;
        musicLen -= 2;
    }
    if (S.initAddress == 0) S.initAddress = S.loadAddress;

    // v2+ adds the flags word and (v3/v4) the second/third SID address bytes.
    S.flags = 0;
    S.secondSIDAddr = 0;
    S.thirdSIDAddr = 0;
    if (version >= 2 && length >= 0x7C) {
        S.flags = (data[0x76] << 8) | data[0x77];
        if (version >= 3 && length > 0x7A) S.secondSIDAddr = data[0x7A];
        if (version >= 4 && length > 0x7B) S.thirdSIDAddr  = data[0x7B];
    }

    // PSID flags: bits 2-3 = video (00/01/11=PAL, 10=NTSC), bits 4-5 = SID model.
    S.isNTSC = (S.flags & 0x0C) == 0x08;
    S.clockFreq = S.isNTSC ? NTSC_CLOCK : PAL_CLOCK;
    S.cyclesPerFrame = S.isNTSC ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;

    uint8_t sidModelBits = (S.flags >> 4) & 0x03;
    S.chipModel = (sidModelBits >= 2) ? 8580 : 6581;

    // Second/third SID base = $D000 + addrByte*16; valid range per PSID spec is
    // $42..$7E or $E0..$FE on even high-nibbles (skipping I/O collision range).
    S.sidCount = 1;
    S.sidAddress[0] = 0xD400;
    if (S.secondSIDAddr >= 0x42 && (S.secondSIDAddr < 0x80 || S.secondSIDAddr >= 0xE0)) {
        S.sidAddress[S.sidCount++] = 0xD000 + S.secondSIDAddr * 16;
    }
    if (S.thirdSIDAddr >= 0x42 && (S.thirdSIDAddr < 0x80 || S.thirdSIDAddr >= 0xE0)) {
        S.sidAddress[S.sidCount++] = 0xD000 + S.thirdSIDAddr * 16;
    }

    memset(S.memory, 0, 65536);
    S.memory[0x01] = 0x37;  // processor port: default RAM/ROM banking

    S.memory[0xDC04] = 0x24;  // CIA1 Timer A latch defaults to ~PAL frame rate
    S.memory[0xDC05] = 0x40;

    // ---- Minimal C64 Kernal environment for SID compatibility ----
    // Many SID tunes JSR to Kernal ROM routines or JMP to IRQ exit points.
    // Without stubs, those addresses contain 0x00 (BRK) which causes infinite
    // BRK loops that eat all CPU cycles and prevent init/play from completing.
    //
    // These stubs are written into empty RAM FIRST; the tune's own data is
    // loaded on top afterwards (see below), so a tune that occupies these
    // addresses — e.g. one loaded over the $E000-$FFFF Kernal region — always
    // wins and is never corrupted by a stub. Writing stubs after the tune with
    // an "== 0" guard would clobber legitimate zero bytes inside such tunes.

    // Kernal IRQ exit at $EA31: PLA / TAY / PLA / TAX / PLA / RTI.
    if (S.memory[0xEA31] == 0) {
        static const uint8_t ea31[] = {0x68,0xA8,0x68,0xAA,0x68,0x40};
        memcpy(&S.memory[0xEA31], ea31, sizeof(ea31));
    }

    // $EA81: alternate Kernal IRQ exit (bare RTI).
    if (S.memory[0xEA81] == 0) {
        S.memory[0xEA81] = 0x40;
    }

    // Stub the Kernal jump table ($FF81-$FFF3, every 3 bytes) with RTS so any
    // SCINIT/IOINIT/etc. calls return cleanly instead of running garbage.
    for (int addr = 0xFF81; addr <= 0xFFF3; addr += 3) {
        if (S.memory[addr] == 0) {
            S.memory[addr] = 0x60;
        }
    }

    if (S.memory[0xFF48] == 0) {
        S.memory[0xFF48] = 0x40;  // RTI at standard Kernal IRQ entry
    }

    // Hardware IRQ vector -> $FF48 (RTI)
    if (S.memory[0xFFFE] == 0 && S.memory[0xFFFF] == 0) {
        S.memory[0xFFFE] = 0x48;
        S.memory[0xFFFF] = 0xFF;
    }

    // Hardware NMI vector -> $FF48 (RTI)
    if (S.memory[0xFFFA] == 0 && S.memory[0xFFFB] == 0) {
        S.memory[0xFFFA] = 0x48;
        S.memory[0xFFFB] = 0xFF;
    }

    // Software IRQ vector ($0314/$0315) -> $EA31
    if (S.memory[0x0314] == 0 && S.memory[0x0315] == 0) {
        S.memory[0x0314] = 0x31;
        S.memory[0x0315] = 0xEA;
    }

    // Software NMI vector ($0318/$0319) -> $EA81
    if (S.memory[0x0318] == 0 && S.memory[0x0319] == 0) {
        S.memory[0x0318] = 0x81;
        S.memory[0x0319] = 0xEA;
    }

    // Load the tune's data LAST, so it overrides any overlapping stub/vector
    // bytes above (a tune loaded over the Kernal region keeps its own data).
    if (musicLen > 0 && S.loadAddress + musicLen <= 65536) {
        memcpy(&S.memory[S.loadAddress], musicData, musicLen);
    }

    reSID::chip_model model = (S.chipModel == 8580) ? reSID::MOS8580 : reSID::MOS6581;
    for (int i = 0; i < S.sidCount; i++) {
        S.sid[i].reset();
        S.sid[i].set_chip_model(model);
        S.sid[i].set_sampling_parameters(S.clockFreq, reSID::SAMPLE_INTERPOLATE, S.sampleRate);
    }

    // PSID v2+ flag bits 6-7 select the second chip's model independently.
    if (version >= 2) {
        uint8_t model2bits = (S.flags >> 6) & 0x03;
        if (S.sidCount > 1 && model2bits >= 2) {
            S.sid[1].set_chip_model(reSID::MOS8580);
            S.sid[1].set_sampling_parameters(S.clockFreq, reSID::SAMPLE_FAST, S.sampleRate);
        }
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
        S.sid[i].reset();
    }

    S.memory[0x01] = 0x37;

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
    cpu_jsr(S.initAddress, 20000000);

    // CIA-driven tunes (speed bit set) latch the play period in $DC04/$DC05.
    if (S.speed & (1 << (subtune & 31))) {
        uint16_t timerVal = S.memory[0xDC04] | (S.memory[0xDC05] << 8);
        if (timerVal > 0) {
            S.cyclesPerFrame = timerVal;
        }
    }

    // Implicit play address: derive from the IRQ vectors the init routine set.
    if (S.playAddress == 0) {
        if ((S.memory[0x01] & 3) < 2) {
            S.playAddress = S.memory[0xFFFE] | (S.memory[0xFFFF] << 8);
        } else {
            S.playAddress = S.memory[0x0314] | (S.memory[0x0315] << 8);
        }
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
            if (S.playAddress == 0) break;
            cpu_jsr(S.playAddress, (uint32_t)S.cyclesPerFrame);
            S.remainingCycles += S.cyclesPerFrame;
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

        // Mix any additional SID chips into the same output buffer with saturation.
        for (int chip = 1; chip < S.sidCount; chip++) {
            reSID::cycle_count delta2 = cyclesConsumed;
            int gen2 = S.sid[chip].clock(delta2, mixBuf, generated);
            for (int s = 0; s < gen2; s++) {
                int mixed = (int)buffer[totalGenerated + s] + mixBuf[s];
                if (mixed > 32767) mixed = 32767;
                if (mixed < -32768) mixed = -32768;
                buffer[totalGenerated + s] = (int16_t)mixed;
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
void audio_set_model(int model) {
    S.chipModel = model;
    reSID::chip_model m = (model == 8580) ? reSID::MOS8580 : reSID::MOS6581;
    for (int i = 0; i < S.sidCount; i++) {
        S.sid[i].set_chip_model(m);
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_set_sampling_method(int method) {
    reSID::sampling_method m;
    switch (method) {
        case 1:  m = reSID::SAMPLE_INTERPOLATE; break;
        case 2:  m = reSID::SAMPLE_RESAMPLE; break;
        default: m = reSID::SAMPLE_FAST; break;
    }
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

EMSCRIPTEN_KEEPALIVE
void audio_cleanup() {
    for (int i = 0; i < MAX_SID_CHIPS; i++) {
        S.sid[i].reset();
    }
    S.loaded = false;
}

} // extern "C"
