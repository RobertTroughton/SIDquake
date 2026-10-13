// sid_processor.cpp - WASM module for SID file analysis.
// Works with cpu6510_wasm.cpp to load, parse, and emulate PSID files.

#include <emscripten/emscripten.h>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>
#include <set>
#include <string>
#include "opcodes.h"
#include "c64_io.h"
#include "c64_env.h"
#include "cpu6510_api.h"

// cpu_get_memory_access bits (MemoryAccessFlag in cpu6510_wasm.cpp).
static constexpr uint8_t ACCESS_EXECUTE = 0x01;
static constexpr uint8_t ACCESS_WRITE   = 0x04;

// The $20-byte SID slots cpu_get_sid_chip_used counts: 32 across $D400-$D7FF,
// then 16 across $DE00-$DFFF.
static constexpr int SID_SLOTS_D400 = 32;
static constexpr int SID_SLOT_COUNT = 48;
static constexpr int SID_SLOT_SHIFT = 5;   // 32 registers per slot

// PSID v2+ flags: bits 2-3 are the video standard, bits 4-5 the SID model.
static constexpr uint16_t PSID_CLOCK_MASK = 0x0C;
static constexpr uint16_t PSID_CLOCK_PAL  = 0x04;
static constexpr uint16_t PSID_CLOCK_NTSC = 0x08;
static constexpr uint16_t PSID_CLOCK_BOTH = 0x0C;
static constexpr uint16_t PSID_MODEL_MASK = 0x30;
static constexpr uint16_t PSID_MODEL_6581 = 0x10;
static constexpr uint16_t PSID_MODEL_8580 = 0x20;
static constexpr uint16_t PSID_MODEL_BOTH = 0x30;

static constexpr size_t   PSID_STRING_LENGTH = 32;   // name, author, copyright
static constexpr uint16_t PSID_MAX_SONGS = 256;

static constexpr uint32_t PAL_CYCLES_PER_FRAME  = 312 * 63;   // lines x cycles per line
static constexpr uint32_t NTSC_CYCLES_PER_FRAME = 263 * 65;

// A play call's budget: a little over one PAL frame.
static constexpr uint32_t PLAY_CYCLES_MAX = 20000;

// Strip non-printable bytes and trailing spaces from a fixed-length SID header
// field. SID header strings are Latin-1 (ISO 8859-1), so keep the printable
// high range (0xA0-0xFF: umlauts, ø, é, ...) alongside printable ASCII, so a
// name like "Søren" is not mangled to "Sren".
static std::string cleanSIDString(const char* str, size_t maxLen) {
    std::string result;
    result.reserve(maxLen);

    for (size_t i = 0; i < maxLen; i++) {
        if (str[i] == '\0') {
            break;
        }
        const unsigned char c = (unsigned char)str[i];
        if ((c >= 32 && c <= 126) || c >= 160) {
            result.push_back((char)c);
        }
    }

    while (!result.empty() && result.back() == ' ') {
        result.pop_back();
    }

    return result;
}

extern "C" {

    // PSID/RSID file header. Must be packed to match the on-disk file format
    // exactly; note that `speed` is unaligned (offset 0x12).
    // Fields are stored big-endian on disk and byte-swapped after load.
#pragma pack(push, 1)
    struct SIDHeader {
        char magicID[4];     // 'PSID' or 'RSID'    Offset 0x00
        uint16_t version;                         // Offset 0x04
        uint16_t dataOffset;                      // Offset 0x06
        uint16_t loadAddress;                     // Offset 0x08
        uint16_t initAddress;                     // Offset 0x0A
        uint16_t playAddress;                     // Offset 0x0C
        uint16_t songs;                           // Offset 0x0E
        uint16_t startSong;                       // Offset 0x10
        uint32_t speed;                           // Offset 0x12 (unaligned)
        char name[PSID_STRING_LENGTH];            // Offset 0x16
        char author[PSID_STRING_LENGTH];          // Offset 0x36
        char copyright[PSID_STRING_LENGTH];       // Offset 0x56
        uint16_t flags;            // v2+         // Offset 0x76
        uint8_t startPage;         // v2+         // Offset 0x78
        uint8_t pageLength;        // v2+         // Offset 0x79
        uint8_t secondSIDAddress;  // v3+         // Offset 0x7A
        uint8_t thirdSIDAddress;   // v4+         // Offset 0x7B
    };
#pragma pack(pop)

    // A v1 header ends where the v2+ fields begin.
    constexpr size_t PSID_V1_HEADER_SIZE = offsetof(SIDHeader, flags);

    struct AnalysisResults {
        std::set<uint16_t> modifiedAddresses;
        std::set<uint8_t> zeroPageUsed;
        // Sorted snapshot of modifiedAddresses, rebuilt after each analysis so
        // sid_get_modified_address(index) is O(1): JS enumerates every address.
        std::vector<uint16_t> modifiedList;

        uint32_t sidRegisterWrites[c64io::SID_REGISTERS];
        // $20-byte SID slots (see cpu_get_sid_chip_used) a play routine wrote
        // to in any subtune, plus $D400 and the ones the header declares.
        bool sidChipsUsed[SID_SLOT_COUNT];
        uint16_t resolvedPlayAddress;

        uint32_t codeBytes;
        uint32_t dataBytes;

        bool hasPattern;
        uint32_t patternPeriod;
        uint32_t initFrames;

        uint8_t numCallsPerFrame;
        uint16_t ciaTimerValue;
        bool ciaTimerDetected;
        uint32_t maxCycles;

        // Subtunes whose init routine never returned inside its cycle budget.
        // Those songs contribute NOTHING to modifiedAddresses / zeroPageUsed, so
        // a non-zero count means the memory map is incomplete, not that the
        // tune touches nothing (see sid_analyze).
        uint32_t initTimeouts;
        uint32_t longestInitCycles;
        uint32_t playTimeouts;
        uint32_t firstPlayTimeoutFrame;
        // Play calls per raster frame for each subtune analysed (index 0 =
        // song 1); numCallsPerFrame is the start song's.
        std::vector<uint8_t> callsPerFrameBySong;
    };

    struct {
        SIDHeader header;
        uint8_t* fileBuffer;
        uint32_t fileSize;
        uint32_t dataStart;
        AnalysisResults analysis;
        bool isLoaded;

        std::string cleanName;
        std::string cleanAuthor;
        std::string cleanCopyright;
        std::string cleanMagicID;
    } sidState;

    // SID header values are stored big-endian on disk; the WASM host is
    // little-endian, so byte-swap after loading.
    uint16_t swap16(uint16_t value) {
        return ((value & 0xFF) << 8) | ((value >> 8) & 0xFF);
    }

    uint32_t swap32(uint32_t value) {
        return ((value & 0xFF) << 24) |
            ((value & 0xFF00) << 8) |
            ((value & 0xFF0000) >> 8) |
            ((value & 0xFF000000) >> 24);
    }

    EMSCRIPTEN_KEEPALIVE
        void sid_init() {
        memset(&sidState.header, 0, sizeof(sidState.header));

        sidState.fileBuffer = nullptr;
        sidState.fileSize = 0;
        sidState.dataStart = 0;
        sidState.isLoaded = false;

        sidState.cleanName.clear();
        sidState.cleanAuthor.clear();
        sidState.cleanCopyright.clear();
        sidState.cleanMagicID.clear();

        sidState.analysis.modifiedAddresses.clear();
        sidState.analysis.zeroPageUsed.clear();
        sidState.analysis.modifiedList.clear();
        memset(sidState.analysis.sidRegisterWrites, 0, sizeof(sidState.analysis.sidRegisterWrites));
        memset(sidState.analysis.sidChipsUsed, 0, sizeof(sidState.analysis.sidChipsUsed));
        sidState.analysis.resolvedPlayAddress = 0;
        sidState.analysis.codeBytes = 0;
        sidState.analysis.dataBytes = 0;
        sidState.analysis.hasPattern = false;
        sidState.analysis.patternPeriod = 0;
        sidState.analysis.initFrames = 0;
        sidState.analysis.maxCycles = 0;
        sidState.analysis.initTimeouts = 0;
        sidState.analysis.longestInitCycles = 0;
        sidState.analysis.playTimeouts = 0;
        sidState.analysis.firstPlayTimeoutFrame = UINT32_MAX;
        sidState.analysis.callsPerFrameBySong.clear();

        cpu_init();
    }

    // Load and parse a PSID file. v1 header is 120 bytes; v2+ is 124 bytes.
    // Returns 0 on success or a negative error code.
    //
    // Everything is parsed and validated into LOCALS first; sidState is only
    // touched once every check has passed. A failed load is a normal event
    // (e.g. clicking an RSID in the HVSC browser returns -3) and must leave
    // any previously loaded SID fully intact - header, strings, buffer and
    // isLoaded - or sid_get_header_value/sid_create_modified afterwards
    // operate on a half-parsed wreck of the rejected file.
    EMSCRIPTEN_KEEPALIVE
        int sid_load(uint8_t* data, uint32_t size) {
        // The checks and the resolved addresses are the reSID engine's too
        // (c64env::parse_psid); the analyser also refuses RSID (-3), which
        // needs a real C64 environment it does not model.
        c64env::Psid psid;
        const int parsed = c64env::parse_psid(data, size, psid);
        if (parsed < 0) {
            return parsed;
        }
        if (psid.rsid) {
            return -3;
        }

        // Only copy what the file actually contains: a v1 file can be smaller
        // than the packed struct (124 bytes with the v2+/v3/v4 tail). The
        // numeric fields are then replaced with the parsed ones.
        SIDHeader header;
        memset(&header, 0, sizeof(SIDHeader));
        memcpy(&header, data, size < sizeof(SIDHeader) ? size : sizeof(SIDHeader));
        std::string magicID(header.magicID, 4);   // no null terminator in the file
        header.version = psid.version;
        header.dataOffset = c64env::be16(data + offsetof(SIDHeader, dataOffset));
        header.loadAddress = psid.loadAddress;
        header.initAddress = psid.initAddress;
        header.playAddress = psid.playAddress;
        header.songs = psid.songs;
        header.startSong = psid.startSong;
        header.speed = psid.speed;
        header.flags = psid.flags;
        header.secondSIDAddress = psid.secondSidByte;
        header.thirdSIDAddress = psid.thirdSidByte;

        const uint32_t dataStart = psid.musicStart;
        const uint32_t musicSize = psid.musicSize;
        const uint8_t* musicData = data + dataStart;

        // Allocate the new file copy BEFORE freeing the old one, so even an
        // OOM here leaves the previous SID loaded.
        uint8_t* newBuffer = (uint8_t*)malloc(size);
        if (!newBuffer) {
            return -6;
        }
        memcpy(newBuffer, data, size);

        // All checks passed - commit the new file to sidState.
        if (sidState.fileBuffer) {
            free(sidState.fileBuffer);
        }
        sidState.header = header;
        sidState.fileBuffer = newBuffer;
        sidState.fileSize = size;
        sidState.dataStart = dataStart;
        sidState.cleanMagicID = magicID;
        sidState.cleanName = cleanSIDString(header.name, PSID_STRING_LENGTH);
        sidState.cleanAuthor = cleanSIDString(header.author, PSID_STRING_LENGTH);
        sidState.cleanCopyright = cleanSIDString(header.copyright, PSID_STRING_LENGTH);

        cpu_init();
        cpu_set_tracking(false);
        cpu_setup_c64_env();

        for (uint32_t i = 0; i < musicSize; i++) {
            cpu_write_memory(header.loadAddress + i, musicData[i]);
        }

        sidState.isLoaded = true;
        return 0;
    }

    // Emulate init + `frameCount` play calls per song, accumulating memory,
    // SID register, and timing statistics. progressCallback may be null.
    EMSCRIPTEN_KEEPALIVE
        int sid_analyze(uint32_t frameCount, void (*progressCallback)(uint32_t, uint32_t)) {
        if (!sidState.isLoaded) {
            return -1;
        }

        sidState.analysis.modifiedAddresses.clear();
        sidState.analysis.zeroPageUsed.clear();
        sidState.analysis.modifiedList.clear();
        memset(sidState.analysis.sidRegisterWrites, 0, sizeof(sidState.analysis.sidRegisterWrites));
        memset(sidState.analysis.sidChipsUsed, 0, sizeof(sidState.analysis.sidChipsUsed));
        sidState.analysis.resolvedPlayAddress = 0;
        sidState.analysis.codeBytes = 0;
        sidState.analysis.dataBytes = 0;
        sidState.analysis.hasPattern = false;
        sidState.analysis.patternPeriod = 0;
        sidState.analysis.initFrames = 0;
        sidState.analysis.numCallsPerFrame = 1;
        sidState.analysis.ciaTimerValue = 0;
        sidState.analysis.ciaTimerDetected = false;
        sidState.analysis.maxCycles = 0;
        sidState.analysis.initTimeouts = 0;
        sidState.analysis.longestInitCycles = 0;
        sidState.analysis.playTimeouts = 0;
        sidState.analysis.firstPlayTimeoutFrame = UINT32_MAX;
        sidState.analysis.callsPerFrameBySong.clear();

        // Snapshot memory after initial load so each song can start from
        // an identical baseline.
        uint8_t* cleanMemorySnapshot = (uint8_t*)malloc(65536);
        if (!cleanMemorySnapshot) {
            return -2;
        }

        // A byte is code if any subtune executed it; collected across songs so
        // the code/data split is counted once, not once per subtune.
        std::vector<uint8_t> executedAnywhere(65536, 0);

        cpu_init();
        cpu_set_tracking(false);
        cpu_setup_c64_env();

        uint32_t musicSize = sidState.fileSize - sidState.dataStart;
        uint8_t* musicData = sidState.fileBuffer + sidState.dataStart;
        for (uint32_t i = 0; i < musicSize; i++) {
            cpu_write_memory(sidState.header.loadAddress + i, musicData[i]);
        }

        cpu_save_memory(cleanMemorySnapshot);

        // Clamp so a corrupt header can't make us emulate 65,535 subtunes
        // (hours of blocking work).
        uint16_t songsToAnalyze = sidState.header.songs;
        if (songsToAnalyze > PSID_MAX_SONGS) {
            songsToAnalyze = PSID_MAX_SONGS;
        }
        // A file claiming no songs still holds one: analyse it rather than
        // report a tune that touches nothing.
        if (songsToAnalyze == 0) {
            songsToAnalyze = 1;
        }

        // Cycle budget for a subtune's init routine.
        //
        // A typical player's init takes 22-1400 cycles, but a tune that unpacks
        // or builds tables in init needs orders of magnitude more:
        // Julian_Jaymz/Slanted.sid takes 2,040,135. A subtune whose init runs
        // out of budget is skipped wholesale, and with too small a budget the
        // tune reports no modified memory and no zero-page use, so the exporter
        // places player routines straight over memory the tune needs. Emulating
        // 2 M cycles costs ~14 ms.
        //
        // Budget the whole analysis rather than each song, so a 256-subtune file
        // can't multiply a generous per-song cap into a frozen tab. A single-song
        // tune gets the full allowance. The floor never applies: with at most
        // PSID_MAX_SONGS songs the share stays above 234,000 cycles.
        const uint32_t INIT_CYCLE_BUDGET = 60000000;   // ~60 s of C64 time overall
        const uint32_t INIT_CYCLES_MAX   = 20000000;   // ~20 s for any one subtune
        const uint32_t INIT_CYCLES_MIN   = 200000;
        // songsToAnalyze is at least 1 by here; the zero test is a dead guard.
        uint32_t initCycleCap = INIT_CYCLE_BUDGET / (songsToAnalyze ? songsToAnalyze : 1);
        if (initCycleCap > INIT_CYCLES_MAX) initCycleCap = INIT_CYCLES_MAX;
        if (initCycleCap < INIT_CYCLES_MIN) initCycleCap = INIT_CYCLES_MIN;

        // The exporter bakes ONE subtune (default = the SID's start song), and
        // multispeed timing is per-subtune in PSID, so key the calls-per-frame
        // detection to that subtune's speed bit (below). 1-based; clamp a corrupt
        // startSong into range.
        uint16_t defaultSong = sidState.header.startSong;
        if (defaultSong < 1 || defaultSong > songsToAnalyze) {
            defaultSong = 1;
        }
        sidState.analysis.callsPerFrameBySong.assign(songsToAnalyze, 1);

        for (uint16_t songNum = 1; songNum <= songsToAnalyze; songNum++) {
            cpu_restore_memory(cleanMemorySnapshot);
            cpu_reset_state_only();

            // PSID convention: subtune index (0-based) is passed in A, X and Y.
            cpu_set_accumulator(songNum - 1);
            cpu_set_xreg(songNum - 1);
            cpu_set_yreg(songNum - 1);

            cpu_set_tracking(true);

            if (!cpu_execute_function(sidState.header.initAddress, initCycleCap)) {
                // Init never returned. Skipping the song is still the right call -
                // driving play() against a half-initialised tune records garbage -
                // but it must not look like "this song touches no memory", so count
                // it and let the caller decide (sid_get_init_timeouts).
                sidState.analysis.initTimeouts++;
                continue;
            }
            {
                uint32_t initCycles = cpu_get_last_execution_cycles();
                if (initCycles > sidState.analysis.longestInitCycles) {
                    sidState.analysis.longestInitCycles = initCycles;
                }
            }
            // Chips are counted from what play writes: an init that clears the
            // whole $D400-$D7FF mirror range otherwise reads as 32 SIDs.
            cpu_reset_sid_chip_usage();

            // A play address of 0 means init installed the play routine behind an
            // IRQ; without deriving it the loop below would "call" $0000 (BRK) and
            // abort on frame 0, so the analysis would cover init only (maxCycles 0,
            // an incomplete modified-address set). Take the handler init set up
            // and enter it as an interrupt, so the RTI (or JMP $EA31) that ends it
            // counts as the return.
            uint16_t playAddr = sidState.header.playAddress;
            bool playIsIrq = false, playViaKernal = false;
            if (playAddr == 0) {
                uint32_t handler = cpu_get_irq_handler();
                playAddr = (uint16_t)handler;
                playViaKernal = (handler & 0x10000u) != 0;   // cpu_get_irq_handler's "via KERNAL" bit
                playIsIrq = true;
            }
            if (songNum == defaultSong) {
                sidState.analysis.resolvedPlayAddress = playAddr;
            }

            // Nothing here reads the write sequence, and over 30,000 frames a
            // play routine with a few hundred SID writes a call (a $D418 digi)
            // grew it past the heap and aborted the module. The loop pre-pass
            // shares this CPU and may have left recording on.
            cpu_set_record_writes(false);

            for (uint32_t frame = 0; frame < frameCount; frame++) {
                int returned = playIsIrq
                    ? cpu_execute_interrupt(playAddr, PLAY_CYCLES_MAX, playViaKernal)
                    : cpu_execute_function(playAddr, PLAY_CYCLES_MAX);
                if (!returned) {
                    // The CPU is left mid-routine, so the song's analysis stops
                    // here; everything it would have touched later is missing
                    // from the maps, so say so (sid_get_play_timeouts).
                    sidState.analysis.playTimeouts++;
                    if (frame < sidState.analysis.firstPlayTimeoutFrame) {
                        sidState.analysis.firstPlayTimeoutFrame = frame;
                    }
                    break;
                }

                uint32_t cycles = cpu_get_last_execution_cycles();
                if (cycles > sidState.analysis.maxCycles) {
                    sidState.analysis.maxCycles = cycles;
                }

                if (progressCallback && (frame % 100 == 0)) {
                    uint32_t totalProgress = (songNum - 1) * frameCount + frame;
                    uint32_t totalFrames = songsToAnalyze * frameCount;
                    progressCallback(totalProgress, totalFrames);
                }
            }

            // Accumulate per-song results before the next iteration overwrites them.
            for (uint32_t addr = 0; addr < 65536; addr++) {
                uint8_t access = cpu_get_memory_access(addr);

                if (access & ACCESS_WRITE) {
                    sidState.analysis.modifiedAddresses.insert(addr);

                    if (addr < 256) {
                        sidState.analysis.zeroPageUsed.insert(addr);
                    }
                }

                if (access & ACCESS_EXECUTE) {
                    executedAnywhere[addr] = 1;
                }
            }

            for (int reg = 0; reg < c64io::SID_REGISTERS; reg++) {
                sidState.analysis.sidRegisterWrites[reg] += cpu_get_sid_writes(reg);
            }
            for (uint32_t slot = 0; slot < SID_SLOT_COUNT; slot++) {
                if (cpu_get_sid_chip_used(slot)) {
                    sidState.analysis.sidChipsUsed[slot] = true;
                }
            }

            // Multispeed (calls-per-frame) detection, per subtune. PSID encodes
            // timing per subtune in the 32-bit speed field: bit set => the play
            // routine runs at the CIA-timer rate, bit clear => vsync, i.e. single
            // speed. A $DC04/05 write is only a multispeed signal when this
            // subtune's bit says CIA: vsync tunes also poke the timer for
            // unrelated reasons, and would export at up to N x tempo. Subtunes
            // past 32 share bit 31, per the PSID spec. The exporter takes the
            // rate of the subtune it bakes (sid_get_song_calls_per_frame);
            // sid_get_num_calls_per_frame is the start song's.
            {
                uint8_t speedBit = (songNum - 1) < 31 ? (uint8_t)(songNum - 1) : 31;
                bool ciaSpeed = (sidState.header.speed >> speedBit) & 1u;

                if (ciaSpeed && cpu_get_cia_timer_written()) {
                    uint8_t ciaTimerLo = cpu_get_cia_timer_lo();
                    uint8_t ciaTimerHi = cpu_get_cia_timer_hi();

                    if (ciaTimerLo != 0 || ciaTimerHi != 0) {
                        uint16_t timerValue = ciaTimerLo | (ciaTimerHi << 8);
                        double cyclesPerFrame = PAL_CYCLES_PER_FRAME;
                        if (sidState.header.version >= 2 && c64env::is_ntsc(sidState.header.flags)) {
                            cyclesPerFrame = NTSC_CYCLES_PER_FRAME;
                        }

                        // The timer counts its latch down to 0 and reloads, so
                        // it fires every latch + 1 cycles.
                        double freq = cyclesPerFrame / (timerValue + 1.0);
                        uint8_t calls = (uint8_t)std::min(16, std::max(1, (int)(freq + 0.5)));
                        sidState.analysis.callsPerFrameBySong[songNum - 1] = calls;
                        if (songNum == defaultSong) {
                            sidState.analysis.numCallsPerFrame = calls;
                            sidState.analysis.ciaTimerValue = timerValue;
                            sidState.analysis.ciaTimerDetected = true;
                        }
                    }
                }
            }
        }

        free(cleanMemorySnapshot);

        // Every C64 has a SID at $D400, and a v3/v4 header names the address of
        // the second and third ($Dxx0, even xx in $42-$7F or $E0-$FE).
        sidState.analysis.sidChipsUsed[0] = true;
        for (uint8_t b : { sidState.header.secondSIDAddress, sidState.header.thirdSIDAddress }) {
            const uint16_t addr = c64env::sid_address(b);
            if (addr >= c64io::IO_EXPANSION_BASE) {
                sidState.analysis.sidChipsUsed[SID_SLOTS_D400 + ((addr - c64io::IO_EXPANSION_BASE) >> SID_SLOT_SHIFT)] = true;
            }
            else if (addr) {
                sidState.analysis.sidChipsUsed[(addr - c64io::SID_BASE) >> SID_SLOT_SHIFT] = true;
            }
        }

        // Code-vs-data only matters for the SID's own loaded range.
        for (uint32_t addr = sidState.header.loadAddress;
             addr < sidState.header.loadAddress + musicSize && addr < 65536; addr++) {
            if (executedAnywhere[addr]) {
                sidState.analysis.codeBytes++;
            }
            else {
                sidState.analysis.dataBytes++;
            }
        }

        sidState.analysis.modifiedList.assign(sidState.analysis.modifiedAddresses.begin(),
                                              sidState.analysis.modifiedAddresses.end());

        return 0;
    }

    EMSCRIPTEN_KEEPALIVE
        const char* sid_get_header_string(int field) {
        if (!sidState.isLoaded) return "";

        switch (field) {
        case 0: return sidState.cleanName.c_str();
        case 1: return sidState.cleanAuthor.c_str();
        case 2: return sidState.cleanCopyright.c_str();
        case 3: return sidState.cleanMagicID.c_str();
        default: return "";
        }
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_header_value(int field) {
        if (!sidState.isLoaded) return 0;

        switch (field) {
        case 0: return sidState.header.version;
        case 1: return sidState.header.loadAddress;
        case 2: return sidState.header.initAddress;
        case 3: return sidState.header.playAddress;
        case 4: return sidState.header.songs;
        case 5: return sidState.header.startSong;
        case 6: return sidState.header.flags;
        case 7: return sidState.fileSize - sidState.dataStart;
        default: return 0;
        }
    }

    EMSCRIPTEN_KEEPALIVE
        void sid_set_header_string(int field, const char* value) {
        if (!sidState.isLoaded) return;

        char* target = nullptr;
        std::string* cleanTarget = nullptr;

        switch (field) {
        case 0:
            target = sidState.header.name;
            cleanTarget = &sidState.cleanName;
            break;
        case 1:
            target = sidState.header.author;
            cleanTarget = &sidState.cleanAuthor;
            break;
        case 2:
            target = sidState.header.copyright;
            cleanTarget = &sidState.cleanCopyright;
            break;
        default:
            return;
        }

        if (target && cleanTarget) {
            memset(target, 0, PSID_STRING_LENGTH);
            // Leave room for the trailing null even though the on-disk field
            // is fixed-width and not null-terminated by the spec.
            strncpy(target, value, PSID_STRING_LENGTH - 1);
            *cleanTarget = cleanSIDString(target, PSID_STRING_LENGTH);
        }
    }

    // Build a copy of the loaded SID file with current header fields, ready
    // for download. Caller must free() the returned buffer.
    EMSCRIPTEN_KEEPALIVE
        uint8_t* sid_create_modified(uint32_t* outSize) {
        if (!sidState.isLoaded || !sidState.fileBuffer) {
            *outSize = 0;
            return nullptr;
        }

        uint8_t* newBuffer = (uint8_t*)malloc(sidState.fileSize);
        if (!newBuffer) {
            *outSize = 0;
            return nullptr;
        }
        memcpy(newBuffer, sidState.fileBuffer, sidState.fileSize);

        SIDHeader tempHeader = sidState.header;

        // Preserve the "load address embedded in data" form: when the original
        // header had loadAddress=0, keep it 0 so the data-embedded little-endian
        // load address is honoured on reload.
        uint16_t originalLoadAddress = swap16(*(uint16_t*)&sidState.fileBuffer[offsetof(SIDHeader, loadAddress)]);

        tempHeader.version = swap16(tempHeader.version);
        tempHeader.dataOffset = swap16(tempHeader.dataOffset);

        if (originalLoadAddress == 0x0000) {
            tempHeader.loadAddress = 0x0000;
        }
        else {
            tempHeader.loadAddress = swap16(tempHeader.loadAddress);
        }

        tempHeader.initAddress = swap16(tempHeader.initAddress);
        tempHeader.playAddress = swap16(tempHeader.playAddress);
        tempHeader.songs = swap16(tempHeader.songs);
        tempHeader.startSong = swap16(tempHeader.startSong);
        tempHeader.speed = swap32(tempHeader.speed);
        if (sidState.header.version >= 2) {
            tempHeader.flags = swap16(tempHeader.flags);
        }

        // In a v1 file the v2+ tail would land on tune data (and, in a file
        // shorter than the full struct, past the buffer).
        memcpy(newBuffer, &tempHeader, sidState.header.version >= 2 ? sizeof(SIDHeader) : PSID_V1_HEADER_SIZE);

        *outSize = sidState.fileSize;
        return newBuffer;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_modified_count() {
        return sidState.analysis.modifiedAddresses.size();
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_modified_address(uint32_t index) {
        if (index >= sidState.analysis.modifiedList.size()) {
            return 0xFFFF;
        }

        return sidState.analysis.modifiedList[index];
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_zp_count() {
        return sidState.analysis.zeroPageUsed.size();
    }

    EMSCRIPTEN_KEEPALIVE
        uint8_t sid_get_zp_address(uint32_t index) {
        if (index >= sidState.analysis.zeroPageUsed.size()) {
            return 0xFF;
        }

        auto it = sidState.analysis.zeroPageUsed.begin();
        std::advance(it, index);
        return *it;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_code_bytes() {
        return sidState.analysis.codeBytes;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_data_bytes() {
        return sidState.analysis.dataBytes;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_sid_writes(uint8_t reg) {
        if (reg < c64io::SID_REGISTERS) {
            return sidState.analysis.sidRegisterWrites[reg];
        }
        return 0;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_sid_chip_count() {
        uint32_t count = 0;
        for (int i = 0; i < SID_SLOT_COUNT; i++) {
            if (sidState.analysis.sidChipsUsed[i]) count++;
        }
        return count;
    }

    // Base address of the Nth SID chip detected during analysis (0-indexed),
    // counted over every subtune analysed.
    EMSCRIPTEN_KEEPALIVE
        uint16_t sid_get_sid_chip_address(uint32_t index) {
        uint32_t count = 0;
        for (int i = 0; i < SID_SLOT_COUNT; i++) {
            if (sidState.analysis.sidChipsUsed[i]) {
                if (count == index) {
                    return i < SID_SLOTS_D400
                        ? c64io::SID_BASE + i * c64io::SID_REGISTERS
                        : c64io::IO_EXPANSION_BASE + (i - SID_SLOTS_D400) * c64io::SID_REGISTERS;
                }
                count++;
            }
        }
        return 0;
    }

    // The default subtune's play routine: the header's play address, or for
    // play address 0 the interrupt handler its init installed. 0 until
    // sid_analyze has run.
    EMSCRIPTEN_KEEPALIVE
        uint16_t sid_get_resolved_play_address() {
        return sidState.analysis.resolvedPlayAddress;
    }

    // The video standard the PSID v2+ flags declare.
    EMSCRIPTEN_KEEPALIVE
        const char* sid_get_clock_type() {
        if (!sidState.isLoaded || sidState.header.version < 2) {
            return "PAL";
        }

        const uint16_t clock = sidState.header.flags & PSID_CLOCK_MASK;
        if (clock == PSID_CLOCK_PAL) return "PAL";
        if (clock == PSID_CLOCK_NTSC) return "NTSC";
        if (clock == PSID_CLOCK_BOTH) return "PAL/NTSC";
        return "Unknown";
    }

    // The first SID's model the PSID v2+ flags declare.
    EMSCRIPTEN_KEEPALIVE
        const char* sid_get_sid_model() {
        if (!sidState.isLoaded || sidState.header.version < 2) {
            return "6581";
        }

        const uint16_t model = sidState.header.flags & PSID_MODEL_MASK;
        if (model == PSID_MODEL_6581) return "6581";
        if (model == PSID_MODEL_8580) return "8580";
        if (model == PSID_MODEL_BOTH) return "6581/8580";
        return "Unknown";
    }

    EMSCRIPTEN_KEEPALIVE
        uint8_t sid_get_num_calls_per_frame() {
        return sidState.analysis.numCallsPerFrame;
    }

    EMSCRIPTEN_KEEPALIVE
        bool sid_get_cia_timer_detected() {
        return sidState.analysis.ciaTimerDetected;
    }

    EMSCRIPTEN_KEEPALIVE
        uint16_t sid_get_cia_timer_value() {
        return sidState.analysis.ciaTimerValue;
    }

    // Number of subtunes whose init routine hit its cycle budget. Non-zero means
    // the modified-address / zero-page maps are INCOMPLETE: those songs were
    // skipped, so "no memory in use" is an absence of data, not a finding.
    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_init_timeouts() {
        return sidState.analysis.initTimeouts;
    }

    // Play calls per raster frame for subtune `song` (0-based), as its speed
    // bit and the CIA timer its init programmed give it; 1 for a song out of
    // range or one whose init timed out.
    EMSCRIPTEN_KEEPALIVE
        uint8_t sid_get_song_calls_per_frame(uint32_t song) {
        return song < sidState.analysis.callsPerFrameBySong.size()
            ? sidState.analysis.callsPerFrameBySong[song] : 1;
    }

    // Number of subtunes whose analysis stopped at a play call that did not
    // return within its cycle budget. Like an init timeout, non-zero means the
    // memory maps are incomplete: they hold only what came before that call.
    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_play_timeouts() {
        return sidState.analysis.playTimeouts;
    }

    // The earliest play call (0-based, in calls) at which any subtune's
    // analysis stopped, or UINT32_MAX when none did.
    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_first_play_timeout_frame() {
        return sidState.analysis.firstPlayTimeoutFrame;
    }

    // Cycles the slowest init that DID return took - useful for spotting tunes
    // that unpack in init (a normal player needs a few hundred).
    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_longest_init_cycles() {
        return sidState.analysis.longestInitCycles;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_max_cycles() {
        return sidState.analysis.maxCycles;
    }

    EMSCRIPTEN_KEEPALIVE
        void sid_cleanup() {
        if (sidState.fileBuffer) {
            free(sidState.fileBuffer);
            sidState.fileBuffer = nullptr;
        }
        sidState.isLoaded = false;
        sidState.cleanName.clear();
        sidState.cleanAuthor.clear();
        sidState.cleanCopyright.clear();
        sidState.cleanMagicID.clear();
    }

} // extern "C"
