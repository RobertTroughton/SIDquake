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

// Whether processor port value `port` ($01) maps the I/O area in: CHAREN set,
// and LORAM or HIRAM set. Otherwise $D000-$DFFF is RAM or character ROM.
inline bool io_visible(uint8_t port) {
    return (port & 0x03) && (port & 0x04);
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
    if (addr < 0xD000 || addr > 0xDCFF || !io_visible(mem[0x01])) return false;
    if (addr <= 0xD3FF) {
        const uint32_t line = (uint32_t)((cycles / PAL_CYCLES_PER_LINE) % PAL_LINES);
        switch (addr & 0x3F) {       // the VIC-II repeats every $40 bytes
            case 0x12: value = (uint8_t)line; return true;
            case 0x11: value = (uint8_t)((mem[0xD011] & 0x7F) | (line & 0x100 ? 0x80 : 0)); return true;
        }
        return false;
    }
    if (addr >= 0xDC00 && (addr & 0x0F) == 0x0D) {   // CIA 1 repeats every 16 bytes
        value = 0x81;
        return true;
    }
    return false;
}

// The side effects of a write the caller has already stored in `mem`: CIA 1
// repeats every 16 bytes across $DC00-$DCFF, so a register written through a
// mirror ($DC14) is also the one read back at $DC04.
inline void write(uint8_t* mem, uint16_t addr, uint8_t value) {
    if ((addr & 0xFF00) == 0xDC00 && io_visible(mem[0x01])) mem[0xDC00 | (addr & 0x0F)] = value;
}

} // namespace c64io
