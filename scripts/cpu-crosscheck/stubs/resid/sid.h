// Stub reSID interface: lets sid_audio.cpp's 6510 core be compiled natively
// without the reSID sources. Registers behave as plain storage so the CPU can
// be exercised; nothing here models SID audio.
#pragma once

#include <cstdint>
#include <cstring>

namespace reSID {

typedef int cycle_count;
enum chip_model { MOS6581, MOS8580 };
enum sampling_method { SAMPLE_FAST, SAMPLE_INTERPOLATE, SAMPLE_RESAMPLE };

class SID {
public:
    uint8_t regs[32];
    SID() { memset(regs, 0, sizeof(regs)); }
    uint8_t read(int reg) { return regs[reg & 0x1F]; }
    void write(int reg, uint8_t val) { regs[reg & 0x1F] = val; }
    void clock() {}
    int clock(cycle_count, short*, int n) { return n; }
    void reset() { memset(regs, 0, sizeof(regs)); }
    bool set_chip_model(chip_model) { return true; }
    bool set_sampling_parameters(double, sampling_method, double) { return true; }
};

}
