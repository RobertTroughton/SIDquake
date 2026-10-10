// Instance isolation for the two machines in sidquake.wasm.
//
// Analyser6510 (wasm/cpu6510_wasm.cpp) and ResidEngine (wasm/sid_audio.cpp)
// keep all their state in the instance, so two of them in one process must not
// see each other. Each check runs two different programs on two instances with
// their work interleaved, one of them the default instance behind the exported
// C API, and compares each against the same program run alone on a fresh
// instance.
//
// See README.md for how to build and run this.

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <memory>
#include <vector>

#include "cpu6510_wasm.cpp"
#include "sid_audio.cpp"

static int failures = 0;

static void check(bool ok, const char* what) {
    printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) failures++;
}

// ---- Analyser6510 ----------------------------------------------------------

// Two endless loops that write SID registers, zero page, the CIA 1 timer and
// their own operands, so every kind of tracking has something to record.
static const uint8_t progA[] = {   // at $1000
    0xA2, 0x00,             // LDX #0
    0x8A,                   // loop: TXA
    0x9D, 0x00, 0xD4,       //   STA $D400,X
    0x95, 0x20,             //   STA $20,X
    0x8D, 0x04, 0xDC,       //   STA $DC04
    0xE8,                   //   INX
    0xE0, 0x19,             //   CPX #$19
    0xD0, 0xF3,             //   BNE loop
    0xEE, 0x01, 0x10,       //   INC $1001
    0x4C, 0x00, 0x10,       //   JMP $1000
};
static const uint8_t progB[] = {   // at $2000
    0xA0, 0x10,             // LDY #$10
    0x88,                   // loop: DEY
    0x8C, 0x18, 0xD4,       //   STY $D418
    0x8C, 0x00, 0xD5,       //   STY $D500
    0x84, 0x40,             //   STY $40
    0xAD, 0x12, 0xD0,       //   LDA $D012
    0x99, 0x00, 0x30,       //   STA $3000,Y
    0xD0, 0xF0,             //   BNE loop
    0xE6, 0x41,             //   INC $41
    0x4C, 0x00, 0x20,       //   JMP $2000
};

static void load(Analyser6510& c, uint16_t at, const uint8_t* code, size_t size) {
    c.init();
    memcpy(&c.memory[at], code, size);
    c.pc = at;
    c.trackingEnabled = true;
    c.setRecordWrites(true);
}

static bool same(const Analyser6510& p, const Analyser6510& q) {
    return p.pc == q.pc && p.sp == q.sp && p.a == q.a && p.x == q.x && p.y == q.y
        && p.st == q.st && p.cycles == q.cycles
        && p.ciaTimerLo == q.ciaTimerLo && p.ciaTimerHi == q.ciaTimerHi
        && p.ciaTimerWritten == q.ciaTimerWritten
        && p.totalSidWrites == q.totalSidWrites && p.totalZpWrites == q.totalZpWrites
        && p.lastExecutionCycles == q.lastExecutionCycles
        && !memcmp(p.memory, q.memory, sizeof(p.memory))
        && !memcmp(p.memoryAccess, q.memoryAccess, sizeof(p.memoryAccess))
        && !memcmp(p.sidWrites, q.sidWrites, sizeof(p.sidWrites))
        && !memcmp(p.sidChipsUsed, q.sidChipsUsed, sizeof(p.sidChipsUsed))
        && !memcmp(p.zpWrites, q.zpWrites, sizeof(p.zpWrites))
        && !memcmp(p.lastWritePC, q.lastWritePC, sizeof(p.lastWritePC))
        && p.writeSequence == q.writeSequence;
}

static void analyser_check() {
    const int steps = 20000;
    auto soloA = std::make_unique<Analyser6510>();
    auto soloB = std::make_unique<Analyser6510>();
    load(*soloA, 0x1000, progA, sizeof(progA));
    load(*soloB, 0x2000, progB, sizeof(progB));
    for (int i = 0; i < steps; i++) soloA->step();
    for (int i = 0; i < steps; i++) soloB->step();

    // A on the default instance through the C API, B on a second instance,
    // one instruction each in turn.
    auto b = std::make_unique<Analyser6510>();
    load(cpu, 0x1000, progA, sizeof(progA));
    load(*b, 0x2000, progB, sizeof(progB));
    for (int i = 0; i < steps; i++) { cpu_step(); b->step(); }

    check(soloA->writeSequence.size() > 0 && soloB->writeSequence.size() > 0
          && soloA->ciaTimerWritten && !soloB->ciaTimerWritten,
          "the two programs exercise different tracking");
    check(same(cpu, *soloA), "default analyser stepped alongside another matches it run alone");
    check(same(*b, *soloB), "second analyser stepped alongside the default matches it run alone");

    // The call runner: a subroutine on one instance and a jam on the other.
    load(*soloA, 0x1000, progA, sizeof(progA));
    soloA->memory[0x4000] = 0xE6; soloA->memory[0x4001] = 0x50;   // INC $50
    soloA->memory[0x4002] = 0x60;                                 // RTS
    memcpy(b->memory, soloA->memory, sizeof(b->memory));
    b->memory[0x4002] = 0x02;                                     // JAM
    const int retA = soloA->execute(0x4000, 1000, false, false);
    const int retB = b->execute(0x4000, 1000, false, false);
    const int retA2 = soloA->execute(0x4000, 1000, false, false);
    check(retA == 1 && retA2 == 1 && retB == 0 && soloA->memory[0x50] == 2
          && soloA->lastExecutionCycles > 0 && !soloA->halted && b->halted,
          "a jam on one analyser leaves another's calls returning");
}

// ---- ResidEngine -----------------------------------------------------------

// A PSID v2 whose init stores the subtune plus `seed` and whose play routine
// counts frames into $D400/$D401, so an engine's SID registers say which tune
// and how far it got.
static std::vector<uint8_t> psid(uint8_t seed) {
    std::vector<uint8_t> f(0x7C, 0);
    memcpy(&f[0], "PSID", 4);
    f[0x05] = 2;            // version
    f[0x07] = 0x7C;         // data offset
    f[0x08] = 0x10;         // load $1000
    f[0x0A] = 0x10;         // init $1000
    f[0x0C] = 0x10; f[0x0D] = 0x03;   // play $1003
    f[0x0F] = 2;            // songs
    f[0x11] = 1;            // start song
    const uint8_t code[] = {
        0x4C, 0x06, 0x10,       // JMP init
        0x4C, 0x0C, 0x10,       // JMP play
        0x18,                   // init: CLC
        0x69, seed,             //   ADC #seed
        0x85, 0xFB,             //   STA $FB
        0x60,                   //   RTS
        0xE6, 0xFC,             // play: INC $FC
        0xA5, 0xFC,             //   LDA $FC
        0x8D, 0x00, 0xD4,       //   STA $D400
        0x45, 0xFB,             //   EOR $FB
        0x8D, 0x01, 0xD4,       //   STA $D401
        0x60,                   //   RTS
    };
    f.insert(f.end(), code, code + sizeof(code));
    return f;
}

static bool same(ResidEngine& p, ResidEngine& q) {
    return p.pc == q.pc && p.sp == q.sp && p.a == q.a && p.x == q.x && p.y == q.y
        && p.st == q.st && p.totalCycles == q.totalCycles
        && p.remainingCycles == q.remainingCycles && p.currentSubtune == q.currentSubtune
        && !memcmp(p.memory, q.memory, sizeof(p.memory))
        && !memcmp(p.sid[0].regs, q.sid[0].regs, sizeof(p.sid[0].regs));
}

static void engine_check() {
    const std::vector<uint8_t> tuneA = psid(0x11), tuneB = psid(0x5A);
    const int chunks = 40, samples = 2000;
    int16_t buf[samples];
    // Every sample an engine produced, folded into one number.
    auto hash = [&](uint32_t& h) {
        for (int i = 0; i < samples; i++) h = h * 31 + (uint16_t)buf[i];
    };
    uint32_t hSoloA = 0, hSoloB = 0, hA = 0, hB = 0;

    auto start = [&](ResidEngine& e, const std::vector<uint8_t>& t, int subtune) {
        e.init(48000);
        e.loadSid(t.data(), (int)t.size());
        e.setSubtune(subtune);
    };

    auto soloA = std::make_unique<ResidEngine>();
    auto soloB = std::make_unique<ResidEngine>();
    start(*soloA, tuneA, 0);
    start(*soloB, tuneB, 1);
    for (int i = 0; i < chunks; i++) { soloA->generate(buf, samples); hash(hSoloA); }
    for (int i = 0; i < chunks; i++) { soloB->generate(buf, samples); hash(hSoloB); }

    // A on the default instance through the C API, B on a second instance,
    // one chunk each in turn.
    auto b = std::make_unique<ResidEngine>();
    audio_init(48000);
    audio_load_sid(tuneA.data(), (int)tuneA.size());
    audio_set_subtune(0);
    start(*b, tuneB, 1);
    for (int i = 0; i < chunks; i++) {
        audio_generate(buf, samples); hash(hA);
        b->generate(buf, samples); hash(hB);
    }

    check(soloA->memory[0xFC] > 1 && soloA->sid[0].regs[1] != soloB->sid[0].regs[1],
          "the two tunes play several frames and leave different registers");
    check(same(S, *soloA) && hA == hSoloA, "default engine run alongside another matches it run alone");
    check(same(*b, *soloB) && hB == hSoloB, "second engine run alongside the default matches it run alone");
}

int main() {
    printf("=== Analyser6510 instances ===\n");
    analyser_check();
    printf("\n=== ResidEngine instances ===\n");
    engine_check();
    printf("\n%d instance-isolation failures\n", failures);
    return failures ? 1 : 0;
}
