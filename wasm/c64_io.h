// c64_io.h - the parts of the C64's I/O area both 6510 bus adapters model
// without emulating the chips behind it: whether the processor port maps I/O
// in, and the registers a play routine is known to poll.
//
// The analyser (cpu6510_wasm.cpp) and the reSID engine (sid_audio.cpp) keep
// their own RAM and cycle counts; both pass them in here, so the two machines
// agree on what these reads return and these writes do.

#pragma once

#include <cstdint>

namespace c64io {

constexpr uint32_t PAL_CYCLES_PER_LINE = 63;
constexpr uint32_t PAL_LINES = 312;

// ---- The I/O map ---------------------------------------------------------

// The 6510's processor port ($01) and the bits that decide what $D000-$DFFF is.
constexpr uint16_t CPU_PORT    = 0x01;
constexpr uint8_t  PORT_LORAM  = 0x01;
constexpr uint8_t  PORT_HIRAM  = 0x02;
constexpr uint8_t  PORT_CHAREN = 0x04;
constexpr uint8_t  PORT_DEFAULT = 0x37;   // BASIC, KERNAL and I/O in, as the KERNAL leaves it

// VIC-II: $D000-$D3FF, its registers repeating every $40 bytes.
constexpr uint16_t VIC_BASE          = 0xD000;
constexpr uint16_t VIC_LAST          = 0xD3FF;
constexpr uint8_t  VIC_REGISTER_MASK = 0x3F;
constexpr uint8_t  VIC_CONTROL1      = 0x11;   // bit 7 is bit 8 of the raster line
constexpr uint8_t  VIC_RASTER        = 0x12;   // bits 0-7 of the raster line

// SID: one chip's $20-byte register window. The first chip at $D400 repeats
// through $D7FF; further chips sit in that range or in I/O 1-2 ($DE00-$DFFF).
constexpr uint16_t SID_BASE          = 0xD400;
constexpr uint16_t SID_MIRROR_LAST   = 0xD7FF;
constexpr uint16_t SID_REGISTERS     = 0x20;
constexpr uint8_t  SID_REGISTER_MASK = 0x1F;
constexpr uint16_t IO_EXPANSION_BASE = 0xDE00;
constexpr uint16_t IO_LAST           = 0xDFFF;

// CIA 1: $DC00-$DCFF, its registers repeating every 16 bytes.
constexpr uint16_t CIA1_BASE         = 0xDC00;
constexpr uint16_t CIA1_LAST         = 0xDCFF;
constexpr uint8_t  CIA_REGISTER_MASK = 0x0F;
constexpr uint8_t  CIA_TIMER_A_LO    = 0x04;
constexpr uint8_t  CIA_TIMER_A_HI    = 0x05;
constexpr uint8_t  CIA_ICR           = 0x0D;   // interrupt control: flags on read
constexpr uint8_t  CIA_ICR_TIMER_A_FIRED = 0x81;   // IRQ (bit 7) from timer A (bit 0)

// ---- Reads and writes ----------------------------------------------------

// Whether processor port value `port` ($01) maps the I/O area in: CHAREN set,
// and LORAM or HIRAM set. Otherwise $D000-$DFFF is RAM or character ROM.
inline bool io_visible(uint8_t port) {
    return (port & (PORT_LORAM | PORT_HIRAM)) && (port & PORT_CHAREN);
}

// A read of one of the modelled registers: sets `value` and returns true, or
// returns false for the caller to read its RAM. `mem` is the caller's RAM ($01
// and what was last written to $D011 are read from it) and `cycles` its C64
// time, which gives the raster position.
//
//   $D012, $D011 bit 7   the raster line, free-running at PAL timing, so a
//                        routine that waits for a line gets there
//   $DC0D                CIA 1's interrupt flags read as "timer A fired", so a
//                        routine that waits for the timer goes on
inline bool read(uint16_t addr, const uint8_t* mem, uint64_t cycles, uint8_t& value) {
    if (addr < VIC_BASE || addr > CIA1_LAST || !io_visible(mem[CPU_PORT])) return false;
    if (addr <= VIC_LAST) {
        const uint32_t line = (uint32_t)((cycles / PAL_CYCLES_PER_LINE) % PAL_LINES);
        switch (addr & VIC_REGISTER_MASK) {
            case VIC_RASTER: value = (uint8_t)line; return true;
            case VIC_CONTROL1:
                value = (uint8_t)((mem[VIC_BASE + VIC_CONTROL1] & 0x7F) | (line & 0x100 ? 0x80 : 0));
                return true;
        }
        return false;
    }
    if (addr >= CIA1_BASE && (addr & CIA_REGISTER_MASK) == CIA_ICR) {
        value = CIA_ICR_TIMER_A_FIRED;
        return true;
    }
    return false;
}

// The side effects of a write the caller has already stored in `mem`: CIA 1
// repeats every 16 bytes across $DC00-$DCFF, so a register written through a
// mirror ($DC14) is also the one read back at $DC04.
inline void write(uint8_t* mem, uint16_t addr, uint8_t value) {
    if ((addr & 0xFF00) == CIA1_BASE && io_visible(mem[CPU_PORT]))
        mem[CIA1_BASE | (addr & CIA_REGISTER_MASK)] = value;
}

} // namespace c64io
