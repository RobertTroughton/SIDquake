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
    // A fixed 20 cycles a sample, each sample registers 0 and 1, so a caller's
    // frame pacing and register writes both reach its output.
    int clock(cycle_count& delta, short* buf, int n) {
        int s = delta / 20;
        if (s > n) s = n;
        delta -= s * 20;
        for (int i = 0; i < s; i++) buf[i] = (short)(regs[0] | (regs[1] << 8));
        return s;
    }
    void reset() { memset(regs, 0, sizeof(regs)); }
    bool set_chip_model(chip_model) { return true; }
    bool set_sampling_parameters(double, sampling_method, double) { return true; }
    struct State { uint8_t envelope_counter[3]; };
    State read_state() { return State{}; }
    void write_state(const State&) {}
};

}
