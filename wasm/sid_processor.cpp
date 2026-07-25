// sid_processor.cpp - WASM module for SID file analysis.
// Works with cpu6510_wasm.cpp to load, parse, and emulate PSID files.

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>
#include <set>
#include <string>
#include "opcodes.h"

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
        char name[32];                            // Offset 0x16
        char author[32];                          // Offset 0x36
        char copyright[32];                       // Offset 0x56
        uint16_t flags;            // v2+         // Offset 0x76
        uint8_t startPage;         // v2+         // Offset 0x78
        uint8_t pageLength;        // v2+         // Offset 0x79
        uint8_t secondSIDAddress;  // v3+         // Offset 0x7A
        uint8_t thirdSIDAddress;   // v4+         // Offset 0x7B
    };
#pragma pack(pop)

    struct AnalysisResults {
        std::set<uint16_t> modifiedAddresses;
        std::set<uint8_t> zeroPageUsed;
        // Sorted snapshot of modifiedAddresses, rebuilt after each analysis so
        // sid_get_modified_address(index) is O(1) instead of O(n) per call
        // (JS enumerates every address, which made the old std::advance
        // approach O(n^2) overall).
        std::vector<uint16_t> modifiedList;

        uint32_t sidRegisterWrites[32];

        uint32_t codeBytes;
        uint32_t dataBytes;

        bool hasPattern;
        uint32_t patternPeriod;
        uint32_t initFrames;

        uint8_t numCallsPerFrame;
        uint16_t ciaTimerValue;
        bool ciaTimerDetected;
        uint32_t maxCycles;
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

    // CPU functions imported from cpu6510_wasm.cpp.
    extern void cpu_init();
    extern void cpu_set_tracking(bool enabled);
    extern void cpu_write_memory(uint16_t address, uint8_t value);
    extern int cpu_execute_function(uint16_t address, uint32_t maxCycles);
    extern uint8_t cpu_get_memory_access(uint16_t address);
    extern uint32_t cpu_get_sid_writes(uint8_t reg);
    extern uint32_t cpu_get_sid_chip_count();
    extern uint16_t cpu_get_sid_chip_address(uint32_t index);
    extern uint32_t cpu_get_zp_writes(uint8_t addr);
    extern void cpu_set_record_writes(bool record);
    extern void cpu_save_memory(uint8_t* buffer);
    extern void cpu_restore_memory(uint8_t* buffer);
    extern void cpu_reset_state_only();
    extern uint32_t cpu_get_last_execution_cycles();

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
        sidState.analysis.codeBytes = 0;
        sidState.analysis.dataBytes = 0;
        sidState.analysis.hasPattern = false;
        sidState.analysis.patternPeriod = 0;
        sidState.analysis.initFrames = 0;
        sidState.analysis.maxCycles = 0;

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
        if (size < 120) {
            return -1;
        }

        // Only copy what the file actually contains: a 120-byte v1 file is
        // smaller than the packed struct (124 bytes with the v2+/v3/v4 tail),
        // and copying sizeof(SIDHeader) unconditionally over-reads the input
        // buffer. The v2+ fields are zeroed for v1 files instead.
        SIDHeader header;
        memset(&header, 0, sizeof(SIDHeader));
        memcpy(&header, data, size < sizeof(SIDHeader) ? size : sizeof(SIDHeader));

        // magicID has no null terminator in the file format.
        std::string magicID(header.magicID, 4);

        if (magicID != "PSID" && magicID != "RSID") {
            return -2;
        }

        if (magicID == "RSID") {
            return -3;
        }

        header.version = swap16(header.version);
        header.dataOffset = swap16(header.dataOffset);
        header.loadAddress = swap16(header.loadAddress);
        header.initAddress = swap16(header.initAddress);
        header.playAddress = swap16(header.playAddress);
        header.songs = swap16(header.songs);
        header.startSong = swap16(header.startSong);
        header.speed = swap32(header.speed);

        if (header.version >= 2) {
            header.flags = swap16(header.flags);
        }

        if (header.version < 1 || header.version > 4) {
            return -4;
        }

        if (header.version >= 2 && size < 0x7C) {
            return -1;
        }

        // dataOffset comes straight from the file: reject values that point
        // before the end of the header or past the end of the file. Without
        // this, `size - dataStart` underflows to ~4 billion and the load loop
        // reads far out of bounds (a crafted/corrupt .sid would hang the tab).
        const uint32_t minDataOffset = (header.version == 1) ? 0x76 : 0x7C;
        if (header.dataOffset < minDataOffset || header.dataOffset >= size) {
            return -5;
        }

        // If loadAddress is 0, the actual load address is encoded as the first
        // two bytes of the data section (little-endian, like a PRG file).
        uint32_t dataStart = header.dataOffset;
        if (header.loadAddress == 0) {
            if (size < dataStart + 2) {
                return -5;
            }
            uint8_t lo = data[dataStart];
            uint8_t hi = data[dataStart + 1];
            header.loadAddress = lo | (hi << 8);
            dataStart += 2;
        }

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
        sidState.cleanName = cleanSIDString(header.name, 32);
        sidState.cleanAuthor = cleanSIDString(header.author, 32);
        sidState.cleanCopyright = cleanSIDString(header.copyright, 32);

        uint32_t musicSize = size - dataStart;
        uint8_t* musicData = data + dataStart;

        // The tune must fit in the 64K address space at its load address.
        // cpu_write_memory takes a uint16_t address, so an oversized tune would
        // silently wrap and corrupt zero page / the CPU vectors rather than
        // failing. Reject it up front.
        if ((uint32_t)header.loadAddress + musicSize > 0x10000) {
            return -7;
        }

        cpu_init();
        cpu_set_tracking(false);

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
        sidState.analysis.codeBytes = 0;
        sidState.analysis.dataBytes = 0;
        sidState.analysis.hasPattern = false;
        sidState.analysis.patternPeriod = 0;
        sidState.analysis.initFrames = 0;
        sidState.analysis.numCallsPerFrame = 1;
        sidState.analysis.ciaTimerValue = 0;
        sidState.analysis.ciaTimerDetected = false;
        sidState.analysis.maxCycles = 0;

        // Snapshot memory after initial load so each song can start from
        // an identical baseline.
        uint8_t* cleanMemorySnapshot = (uint8_t*)malloc(65536);
        if (!cleanMemorySnapshot) {
            return -2;
        }

        // A byte is code if any subtune executed it; collected across songs so
        // the code/data split is counted once, not once per subtune (which
        // inflated codeBytes+dataBytes to musicSize * numSongs).
        std::vector<uint8_t> executedAnywhere(65536, 0);

        cpu_init();
        cpu_set_tracking(false);

        uint32_t musicSize = sidState.fileSize - sidState.dataStart;
        uint8_t* musicData = sidState.fileBuffer + sidState.dataStart;
        for (uint32_t i = 0; i < musicSize; i++) {
            cpu_write_memory(sidState.header.loadAddress + i, musicData[i]);
        }

        cpu_save_memory(cleanMemorySnapshot);

        // PSID allows at most 256 songs; clamp so a corrupt header can't make
        // us emulate 65,535 subtunes (hours of blocking work).
        uint16_t songsToAnalyze = sidState.header.songs;
        if (songsToAnalyze > 256) {
            songsToAnalyze = 256;
        }

        // The exporter bakes ONE subtune (default = the SID's start song), and
        // multispeed timing is per-subtune in PSID, so key the calls-per-frame
        // detection to that subtune's speed bit (below). 1-based; clamp a corrupt
        // startSong into range.
        uint16_t defaultSong = sidState.header.startSong;
        if (defaultSong < 1 || defaultSong > songsToAnalyze) {
            defaultSong = 1;
        }

        for (uint16_t songNum = 1; songNum <= songsToAnalyze; songNum++) {
            cpu_restore_memory(cleanMemorySnapshot);
            cpu_reset_state_only();

            // PSID convention: subtune index (0-based) is passed in A, X and Y.
            extern void cpu_set_accumulator(uint8_t value);
            extern void cpu_set_xreg(uint8_t value);
            extern void cpu_set_yreg(uint8_t value);
            cpu_set_accumulator(songNum - 1);
            cpu_set_xreg(songNum - 1);
            cpu_set_yreg(songNum - 1);

            cpu_set_tracking(true);

            if (!cpu_execute_function(sidState.header.initAddress, 100000)) {
                continue;
            }

            // A play address of 0 means init installed the play routine behind an
            // IRQ; without deriving it the loop below would "call" $0000 (BRK) and
            // abort on frame 0, so the analysis would cover init only (maxCycles 0,
            // an incomplete modified-address set). Read the vector init set up,
            // mirroring the audio engine (sid_audio.cpp): the hardware IRQ vector
            // at $FFFE when RAM is banked in there, else the KERNAL vector at $0314.
            uint16_t playAddr = sidState.header.playAddress;
            if (playAddr == 0) {
                extern uint8_t cpu_read_memory(uint16_t);
                if ((cpu_read_memory(0x01) & 3) < 2) {
                    playAddr = cpu_read_memory(0xFFFE) | (cpu_read_memory(0xFFFF) << 8);
                } else {
                    playAddr = cpu_read_memory(0x0314) | (cpu_read_memory(0x0315) << 8);
                }
            }

            cpu_set_record_writes(true);

            for (uint32_t frame = 0; frame < frameCount; frame++) {
                if (!cpu_execute_function(playAddr, 20000)) {
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

                if (access & 0x04) { // MEM_WRITE
                    sidState.analysis.modifiedAddresses.insert(addr);

                    if (addr < 256) {
                        sidState.analysis.zeroPageUsed.insert(addr);
                    }
                }

                if (access & 0x01) { // MEM_EXECUTE
                    executedAnywhere[addr] = 1;
                }
            }

            for (int reg = 0; reg < 32; reg++) {
                sidState.analysis.sidRegisterWrites[reg] += cpu_get_sid_writes(reg);
            }

            // Multispeed (calls-per-frame) detection, keyed to the subtune the
            // exporter actually bakes (the default/start song). PSID encodes
            // timing per subtune in the 32-bit speed field: bit set => the play
            // routine runs at the CIA-timer rate, bit clear => vsync, i.e. single
            // speed. A $DC04/05 write is only a multispeed signal when this
            // subtune's bit says CIA - trusting it unconditionally exported plain
            // vsync tunes (that poke the timer for unrelated reasons) at up to N x
            // tempo. Subtunes past 32 share bit 31, per the PSID spec.
            //
            // Only the default subtune's rate is derived; the exporter can still
            // bake a user-picked non-default subtune, which then inherits the
            // default's rate. A fully per-subtune rate would need the export
            // selection at analysis time - deferred; single-subtune tunes and the
            // default export (the common cases) are exact.
            if (songNum == defaultSong && !sidState.analysis.ciaTimerDetected) {
                extern uint8_t cpu_get_cia_timer_lo();
                extern uint8_t cpu_get_cia_timer_hi();
                extern bool cpu_get_cia_timer_written();

                uint8_t speedBit = (defaultSong - 1) < 31 ? (uint8_t)(defaultSong - 1) : 31;
                bool ciaSpeed = (sidState.header.speed >> speedBit) & 1u;

                if (ciaSpeed && cpu_get_cia_timer_written()) {
                    uint8_t ciaTimerLo = cpu_get_cia_timer_lo();
                    uint8_t ciaTimerHi = cpu_get_cia_timer_hi();

                    if (ciaTimerLo != 0 || ciaTimerHi != 0) {
                        uint16_t timerValue = ciaTimerLo | (ciaTimerHi << 8);
                        // PAL: 312 lines * 63 cycles = 19656 cycles/frame.
                        // NTSC: 263 lines * 65 cycles = 17095 cycles/frame.
                        double cyclesPerFrame = 19656.0;

                        if (sidState.header.version >= 2) {
                            uint16_t flags = sidState.header.flags;
                            if ((flags & 0x0C) == 0x08) { // NTSC
                                cyclesPerFrame = 17095.0;
                            }
                        }

                        double freq = cyclesPerFrame / timerValue;
                        sidState.analysis.numCallsPerFrame = (uint8_t)std::min(16, std::max(1, (int)(freq + 0.5)));
                        sidState.analysis.ciaTimerValue = timerValue;
                        sidState.analysis.ciaTimerDetected = true;
                    }
                }
            }
        }

        free(cleanMemorySnapshot);

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
        uint16_t sid_get_header_value(int field) {
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
            memset(target, 0, 32);
            // Leave room for the trailing null even though the on-disk field
            // is fixed-width and not null-terminated by the spec.
            strncpy(target, value, 31);
            *cleanTarget = cleanSIDString(target, 32);
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
        uint16_t originalLoadAddress = swap16(*(uint16_t*)&sidState.fileBuffer[0x08]);

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

        memcpy(newBuffer, &tempHeader, sizeof(SIDHeader));

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
        if (reg < 32) {
            return sidState.analysis.sidRegisterWrites[reg];
        }
        return 0;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t sid_get_sid_chip_count() {
        return cpu_get_sid_chip_count();
    }

    // Base address of the Nth SID chip detected during analysis (0-indexed).
    EMSCRIPTEN_KEEPALIVE
        uint16_t sid_get_sid_chip_address(uint32_t index) {
        return cpu_get_sid_chip_address(index);
    }

    // PSID v2+ flags bits 2-3 encode video standard.
    EMSCRIPTEN_KEEPALIVE
        const char* sid_get_clock_type() {
        if (!sidState.isLoaded || sidState.header.version < 2) {
            return "PAL";
        }

        uint16_t flags = sidState.header.flags;
        if ((flags & 0x0C) == 0x04) return "PAL";
        if ((flags & 0x0C) == 0x08) return "NTSC";
        if ((flags & 0x0C) == 0x0C) return "PAL/NTSC";
        return "Unknown";
    }

    // PSID v2+ flags bits 4-5 encode SID chip model.
    EMSCRIPTEN_KEEPALIVE
        const char* sid_get_sid_model() {
        if (!sidState.isLoaded || sidState.header.version < 2) {
            return "6581";
        }

        uint16_t flags = sidState.header.flags;
        if ((flags & 0x30) == 0x10) return "6581";
        if ((flags & 0x30) == 0x20) return "8580";
        if ((flags & 0x30) == 0x30) return "6581/8580";
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
