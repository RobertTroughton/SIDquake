// c64_env.h - the machine a PSID tune expects, shared by the two 6510 bus
// adapters: the analyser (cpu6510_wasm.cpp + sid_processor.cpp) and the reSID
// engine (sid_audio.cpp). One header parser, one set of KERNAL stubs, one way
// to find the play routine init installed and one way to call into the tune,
// so the two machines cannot drift apart.

#pragma once

#include <cstdint>
#include <cstring>
#include <initializer_list>

#include "cpu6510_core.h"

namespace c64env {

// ---- PSID/RSID header ----------------------------------------------------

struct Psid {
    bool     rsid;
    uint16_t version;
    uint16_t loadAddress;      // resolved: never 0
    uint16_t initAddress;      // resolved: 0 in the file means the load address
    uint16_t playAddress;      // 0 = init installs the player on an interrupt
    uint16_t songs;
    uint16_t startSong;
    uint32_t speed;            // bit per subtune: 0 = vsync, 1 = CIA timer
    uint16_t flags;            // v2+, else 0
    uint8_t  secondSidByte;    // v3+, else 0
    uint8_t  thirdSidByte;     // v4+, else 0
    uint32_t musicStart;       // file offset of the first byte loaded
    uint32_t musicSize;        // bytes loaded at loadAddress
};

enum ParseError {
    ERR_TOO_SHORT   = -1,
    ERR_NOT_SID     = -2,
    ERR_VERSION     = -4,
    ERR_DATA_OFFSET = -5,
    ERR_TOO_LONG    = -7,      // does not fit in 64K at its load address
    ERR_MUS         = -8,      // PSID flag bit 0: the data is Sidplayer MUS, not code
};

inline uint16_t be16(const uint8_t* p) { return (uint16_t)((p[0] << 8) | p[1]); }

// Parse and check a PSID/RSID file. Returns 0, or a ParseError.
inline int parse_psid(const uint8_t* data, uint32_t size, Psid& h) {
    if (size < 0x78) return ERR_TOO_SHORT;
    const bool psid = memcmp(data, "PSID", 4) == 0;
    if (!psid && memcmp(data, "RSID", 4) != 0) return ERR_NOT_SID;

    memset(&h, 0, sizeof(h));
    h.rsid = !psid;
    h.version = be16(data + 0x04);
    if (h.version < 1 || h.version > 4) return ERR_VERSION;
    if (h.version >= 2 && size < 0x7C) return ERR_TOO_SHORT;

    const uint16_t dataOffset = be16(data + 0x06);
    if (dataOffset < (h.version == 1 ? 0x76 : 0x7C) || dataOffset >= size) return ERR_DATA_OFFSET;

    h.loadAddress = be16(data + 0x08);
    h.initAddress = be16(data + 0x0A);
    h.playAddress = be16(data + 0x0C);
    h.songs       = be16(data + 0x0E);
    h.startSong   = be16(data + 0x10);
    h.speed = ((uint32_t)data[0x12] << 24) | ((uint32_t)data[0x13] << 16)
            | ((uint32_t)data[0x14] << 8) | data[0x15];
    if (h.version >= 2) h.flags = be16(data + 0x76);
    if (h.version >= 3) h.secondSidByte = data[0x7A];
    if (h.version >= 4) h.thirdSidByte = data[0x7B];
    if (psid && (h.flags & 0x01)) return ERR_MUS;

    // A load address of 0 means the data starts with it, little-endian.
    h.musicStart = dataOffset;
    if (h.loadAddress == 0) {
        if (size < h.musicStart + 2u) return ERR_DATA_OFFSET;
        h.loadAddress = data[h.musicStart] | (data[h.musicStart + 1] << 8);
        h.musicStart += 2;
    }
    if (h.initAddress == 0) h.initAddress = h.loadAddress;
    h.musicSize = size - h.musicStart;
    if ((uint32_t)h.loadAddress + h.musicSize > 0x10000) return ERR_TOO_LONG;
    return 0;
}

inline bool is_ntsc(uint16_t flags) { return (flags & 0x0C) == 0x08; }

// Base address of the SID a v3/v4 header byte names ($Dxx0), or 0 when the
// byte names none: the PSID spec allows even values in $42-$7F and $E0-$FE.
inline uint16_t sid_address(uint8_t b) {
    if ((b & 1) || !((b >= 0x42 && b <= 0x7F) || (b >= 0xE0 && b <= 0xFE))) return 0;
    return (uint16_t)(0xD000 | (b << 4));
}

// 6581 or 8580 for chip 0, 1 or 2, from the model bits of the flags (4-5 for
// the first chip, 6-7 and 8-9 for the others). "Either" (11) and "unknown"
// (00) on the first chip are 6581; on the others, unknown is the first's.
inline int chip_model(uint16_t flags, int chip) {
    auto decode = [](int bits, int fallback) { return bits == 2 ? 8580 : bits == 1 ? 6581 : fallback; };
    const int first = decode((flags >> 4) & 3, 6581);
    if (chip == 0) return first;
    return decode((flags >> (chip == 1 ? 6 : 8)) & 3, first);
}

// ---- The machine -----------------------------------------------------------

constexpr uint16_t NMI_ENTRY = 0xFE43;

// Plant into zeroed RAM what a tune expects of the KERNAL, before the tune is
// loaded over it (a tune that occupies these addresses keeps its own bytes):
//
//   $00/$01         the processor port as the KERNAL leaves it
//   $DC04/$DC05     CIA 1 timer A latch as the PAL KERNAL programs it
//   $EA31 $EA7E $EA81  the IRQ exits: pull Y, X and A, then RTI ($EA7E reads
//                   $DC0D first, acknowledging CIA 1)
//   $FF81-$FFF3     the jump table, each entry an RTS
//   $FF48           the IRQ entry: push A, X and Y, then JMP ($0314), or
//                   ($0316) for a BRK
//   $FE43           the NMI entry: SEI, JMP ($0318)
//   $FFFA/$FFFE     the NMI and IRQ vectors, and $0314/$0318 the RAM vectors
//                   they go through, at the exits above
inline void plant_kernal(uint8_t* m) {
    m[0x00] = 0x2F;
    m[0x01] = 0x37;
    m[0xDC04] = 0x25;
    m[0xDC05] = 0x40;

    using namespace cpu6510;

    static const uint8_t exitTail[] = { PLA, TAY, PLA, TAX, PLA, RTI };
    memcpy(&m[0xEA31], exitTail, sizeof(exitTail));
    m[0xEA7E] = LDA_ABS; m[0xEA7F] = 0x0D; m[0xEA80] = 0xDC;
    memcpy(&m[0xEA81], exitTail, sizeof(exitTail));

    for (int addr = 0xFF81; addr <= 0xFFF3; addr += 3) m[addr] = RTS;

    // The B flag of the P byte the interrupt pushed tells a BRK from an IRQ.
    static const uint8_t irqEntry[] = {
        PHA, TXA, PHA, TYA, PHA,
        TSX, LDA_ABSX, 0x04, 0x01,
        AND_IMM, 0x10,
        BEQ, 0x03,
        JMP_IND, 0x16, 0x03,
        JMP_IND, 0x14, 0x03 };
    memcpy(&m[0xFF48], irqEntry, sizeof(irqEntry));

    static const uint8_t nmiEntry[] = { SEI, JMP_IND, 0x18, 0x03 };
    memcpy(&m[NMI_ENTRY], nmiEntry, sizeof(nmiEntry));

    m[0xFFFA] = NMI_ENTRY & 0xFF; m[0xFFFB] = NMI_ENTRY >> 8;
    m[0xFFFE] = 0x48; m[0xFFFF] = 0xFF;
    m[0x0314] = 0x31; m[0x0315] = 0xEA;
    m[0x0318] = 0x81; m[0x0319] = 0xEA;
}

// The play routine a PSID with play address 0 left behind: init hung it on an
// interrupt. With the KERNAL ROM banked in ($01 & 3 >= 2) the CPU's vector is
// the ROM's, which enters through $0314 (viaKernal); with it banked out, the
// RAM vector at $FFFE is the handler.
struct IrqHandler { uint16_t addr; bool viaKernal; };

inline IrqHandler irq_handler(const uint8_t* m) {
    if ((m[0x01] & 3) < 2) return { (uint16_t)(m[0xFFFE] | (m[0xFFFF] << 8)), false };
    return { (uint16_t)(m[0x0314] | (m[0x0315] << 8)), true };
}

// ---- Calling into the tune -------------------------------------------------

// Cycles the hardware spends before an interrupt handler's first instruction,
// and what the KERNAL's $FF48 entry adds before it jumps through $0314.
constexpr uint32_t IRQ_ENTRY_CYCLES = 7;
constexpr uint32_t KERNAL_IRQ_ENTRY_CYCLES = 29;

struct CallResult {
    bool     returned;
    uint32_t cycles;     // the call's cycles, entry included
};

// Run a subroutine until the RTS that returns from it, or with `irq` an
// interrupt handler until its RTI, or until `maxCycles` run out.
//
// A subroutine call plants a return address of $FFFF; an interrupt is entered
// the way the hardware does it (PC and P pushed, I set), and `viaKernal` adds
// the A/X/Y the KERNAL's $FF48 entry pushes, which the $EA31/$EA81 exits pull
// back. The return is the matching RTS/RTI: SP back at or above where it
// started, compared as a signed distance so a wrap past $FF still counts. A
// call that does not return (cycle cap, JAM, a jump to $0000/$0001 or $FFFF)
// has its stack put back, so the next call does not start lower.
//
// The Bus is the adapter's cpu6510 bus plus: `int step()`, which runs one
// instruction with the adapter's own bookkeeping and returns its cycles;
// `bool jammed()`; and `void clearJam()`.
template <class Bus>
CallResult call(Bus& b, uint16_t addr, uint32_t maxCycles, bool irq = false, bool viaKernal = false) {
    const uint8_t startSP = b.sp;
    auto push = [&](uint8_t v) { b.write(0x0100 + b.sp, v); b.sp--; };
    uint32_t cycles = 0;
    if (irq) {
        push(0x00);
        push(0x00);
        push((b.st & ~cpu6510::FLAG_B) | cpu6510::FLAG_U);
        cycles += IRQ_ENTRY_CYCLES;
        if (viaKernal) {
            push(b.a);
            push(b.x);
            push(b.y);
            cycles += KERNAL_IRQ_ENTRY_CYCLES;
        }
        b.st |= cpu6510::FLAG_I;
    } else {
        push(0xFF);
        push(0xFF);
    }
    b.pc = addr;
    b.clearJam();

    while (cycles < maxCycles) {
        const uint8_t opcode = b.fetch(b.pc);
        cycles += b.step();
        if (b.jammed()) break;
        if (opcode == (irq ? cpu6510::RTI : cpu6510::RTS) && (int8_t)(b.sp - startSP) >= 0) return { true, cycles };
        if (b.pc < 2 || b.pc == 0xFFFF) break;
    }
    b.sp = startSP;
    return { false, cycles };
}

} // namespace c64env
