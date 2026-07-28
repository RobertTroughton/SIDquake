// Differential fuzzer for SIDquake's two 6510 cores.
//
//   A = wasm/cpu6510_wasm.cpp  - analysis core (drives sid_analyze)
//   B = wasm/sid_audio.cpp     - audio playback core (drives reSID)
//   R = optional third-party reference core, compiled in with -DWITH_REFERENCE
//
// Each iteration puts every core in an identical randomised machine state,
// executes one instruction, and reports divergence in PC, registers, flags,
// cycle count or memory. A-vs-B covers all 256 opcodes; R is compared only on
// the opcodes it implements (see refOpcodes).
//
// See README.md for how to build and run this.

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cstdlib>

#include "cpu6510_wasm.cpp"

extern "C" {
    // Audio core, via shim_audio.cpp.
    void aud_set_state(const uint8_t* image, uint16_t pc, uint8_t a, uint8_t x,
                       uint8_t y, uint8_t sp, uint8_t st);
    int aud_step();
    uint16_t aud_pc(); uint8_t aud_a(); uint8_t aud_x(); uint8_t aud_y();
    uint8_t aud_sp(); uint8_t aud_st(); uint8_t* aud_mem();

#ifdef WITH_REFERENCE
    // Interface of the siddump-family cpu.c: flat globals plus runcpu().
    extern unsigned short pc;
    extern unsigned char a, x, y, flags, sp;
    extern unsigned char mem[0x10000];
    extern unsigned int cpucycles;
    void initcpu(unsigned short newpc, unsigned char newa, unsigned char newx, unsigned char newy);
    int runcpu(void);
#endif
}

static uint64_t rngState;
static inline uint32_t rnd() {
    rngState ^= rngState << 13;
    rngState ^= rngState >> 7;
    rngState ^= rngState << 17;
    return (uint32_t)(rngState >> 16);
}

#ifdef WITH_REFERENCE
// Opcodes the siddump-family cpu.c implements. It calls exit(1) on anything
// else, so feeding it the full 256 would abort the run. Adjust to match the
// reference core in use.
static const uint8_t refOpcodes[] = {
    0xa7,0xb7,0xaf,0xa3,0xb3,
    0x1a,0x3a,0x5a,0x7a,0xda,0xfa,
    0x80,0x82,0x89,0xc2,0xe2,0x04,0x44,0x64,0x14,0x34,0x54,0x74,0xd4,0xf4,
    0x0c,0x1c,0x3c,0x5c,0x7c,0xdc,0xfc,
    0x69,0x65,0x75,0x6d,0x7d,0x79,0x61,0x71,
    0x29,0x25,0x35,0x2d,0x3d,0x39,0x21,0x31,
    0x0b,0x2b,
    0x0a,0x06,0x16,0x0e,0x1e,
    0x90,0xb0,0xf0,0x24,0x2c,0x30,0xd0,0x10,0x50,0x70,
    0x18,0xd8,0x58,0xb8,
    0xc9,0xc5,0xd5,0xcd,0xdd,0xd9,0xc1,0xd1,
    0xe0,0xe4,0xec,0xc0,0xc4,0xcc,
    0xc6,0xd6,0xce,0xde,0xca,0x88,
    0x49,0x45,0x55,0x4d,0x5d,0x59,0x41,0x51,
    0xe6,0xf6,0xee,0xfe,0xe8,0xc8,
    0x20,0x4c,0x6c,
    0xa9,0xa5,0xb5,0xad,0xbd,0xb9,0xa1,0xb1,
    0xa2,0xa6,0xb6,0xae,0xbe,
    0xa0,0xa4,0xb4,0xac,0xbc,
    0x4a,0x46,0x56,0x4e,0x5e,
    0xea,
    0x09,0x05,0x15,0x0d,0x1d,0x19,0x01,0x11,
    0x48,0x08,0x68,0x28,
    0x2a,0x26,0x36,0x2e,0x3e,
    0x6a,0x66,0x76,0x6e,0x7e,
    0x40,0x60,
    0xe9,0xeb,0xe5,0xf5,0xed,0xfd,0xf9,0xe1,0xf1,
    0x38,0xf8,0x78,
    0x85,0x95,0x8d,0x9d,0x99,0x81,0x91,
    0x86,0x96,0x8e,
    0x84,0x94,0x8c,
    0xaa,0xba,0x8a,0x9a,0x98,0xa8
};
static bool inRefSet[256];
#endif

// The flag bits every core models: N V D I Z C. Bits 4 and 5 have no shared
// meaning across implementations.
static const uint8_t FLAGMASK = 0xCF;

struct Divergence {
    uint32_t count;
    uint16_t pc;
    uint8_t a, x, y, sp, flags, o1, o2;
    char what[192];
};
static Divergence divAud[256];
#ifdef WITH_REFERENCE
static Divergence divRef[256];
#endif

static void note(Divergence& d, const char* what, uint16_t p, uint8_t ra, uint8_t rx,
                 uint8_t ry, uint8_t rsp, uint8_t rf, uint8_t o1, uint8_t o2) {
    if (d.count == 0) {
        d.pc = p; d.a = ra; d.x = rx; d.y = ry; d.sp = rsp; d.flags = rf;
        d.o1 = o1; d.o2 = o2;
        snprintf(d.what, sizeof(d.what), "%s", what);
    }
    d.count++;
}

static void report(const char* title, const Divergence* d, uint32_t iterations, int& n) {
    printf("=== %s ===\n", title);
    for (int op = 0; op < 256; op++) {
        if (!d[op].count) continue;
        n++;
        printf("  $%02X %-4s %6u/%u | PC=$%04X ops $%02X $%02X A=$%02X X=$%02X Y=$%02X "
               "SP=$%02X P=$%02X -> %s\n",
               op, opcodeTable[op].mnemonic, d[op].count, iterations,
               d[op].pc, d[op].o1, d[op].o2, d[op].a, d[op].x, d[op].y,
               d[op].sp, d[op].flags, d[op].what);
    }
    if (!n) printf("  (none)\n");
}

static uint8_t base[0x10000];

// Cross-check the analysis core's hand-written cycle counts and operand sizes
// against opcodes.h, which the disassembler and the unimplemented-opcode
// fallback both trust. Run with X=Y=0 and untaken branches so no opcode is
// owed a page-crossing or branch-taken penalty, leaving the table's base
// figures as the expected answer.
static int table_check() {
    int bad = 0;
    for (int op = 0; op < 256; op++) {
        if (op == 0x00 || (op & 0x0F) == 0x02) continue;  // terminal opcodes

        memset(cpu.memory, 0, 0x10000);
        const uint16_t startPC = 0x1000;
        cpu.memory[startPC] = (uint8_t)op;
        cpu.memory[startPC + 1] = 0x34;
        cpu.memory[startPC + 2] = 0x12;
        cpu.pc = startPC;
        cpu.a = 0; cpu.x = 0; cpu.y = 0; cpu.sp = 0xFD;
        cpu.status = FLAG_UNUSED | FLAG_INTERRUPT;
        // With N, V, Z and C all clear these four branches are taken, which
        // costs the base cycle plus one. A zero displacement keeps the target
        // in the same page, so no page-crossing penalty is owed on top.
        bool branchTaken = (op == 0x10 || op == 0x50 || op == 0x90 || op == 0xD0);
        if (opcodeTable[op].mode == MODE_RELATIVE) cpu.memory[startPC + 1] = 0x00;
        cpu.cycles = 0; cpu.halted = false;
        cpu_step();

        const OpcodeInfo& info = opcodeTable[op];
        uint32_t expected = info.cycles + (branchTaken ? 1 : 0);
        if ((uint32_t)cpu.cycles != expected) {
            printf("  $%02X %-4s cycles: core=%u expected=%u\n",
                   op, info.mnemonic, (uint32_t)cpu.cycles, expected);
            bad++;
            continue;
        }
        // PC only tells us the operand size for opcodes that fall through to
        // the next instruction.
        bool controlFlow = info.mode == MODE_RELATIVE || op == 0x4C || op == 0x6C ||
                           op == 0x20 || op == 0x40 || op == 0x60;
        if (!controlFlow && cpu.pc != (uint16_t)(startPC + info.size)) {
            printf("  $%02X %-4s size: core=%d table=%u\n",
                   op, info.mnemonic, (int)(cpu.pc - startPC), info.size);
            bad++;
        }
    }
    return bad;
}

// The unstable stores are the one place where "both cores agree" proves
// nothing, since both were written from the same reading of the hardware.
// These vectors are worked out by hand from the NMOS model: the value stored
// is reg & (high byte of the pre-index address + 1), and a page-crossing index
// replaces the target's high byte with that value.
struct StoreVector {
    const char* name;
    uint8_t opcode, o1, o2;     // opcode and its two operand bytes
    uint8_t a, x, y;
    uint16_t expectAddr;
    uint8_t expectValue;
};
static const StoreVector storeVectors[] = {
    // SHY $1080,X with X=$01: $1081, no crossing, stores Y & ($10+1).
    {"SHY no cross",   0x9C, 0x80, 0x10, 0x00, 0x01, 0xFF, 0x1081, 0x11},
    // SHY $10FF,X with X=$02: crosses into $1101, Y=$0F narrows the value to
    // $01, which then becomes the target's high byte.
    {"SHY cross",      0x9C, 0xFF, 0x10, 0x00, 0x02, 0x0F, 0x0101, 0x01},
    {"SHX no cross",   0x9E, 0x80, 0x10, 0x00, 0xFF, 0x01, 0x1081, 0x11},
    {"SHX cross",      0x9E, 0xFF, 0x10, 0x00, 0x0F, 0x02, 0x0101, 0x01},
    {"SHA no cross",   0x9F, 0x80, 0x10, 0xFF, 0xFF, 0x01, 0x1081, 0x11},
    {"SHA cross",      0x9F, 0xFF, 0x10, 0xFF, 0x0F, 0x02, 0x0101, 0x01},
    {"TAS cross",      0x9B, 0xFF, 0x10, 0xFF, 0x0F, 0x02, 0x0101, 0x01},
};

static int vector_check() {
    int bad = 0;
    for (const StoreVector& v : storeVectors) {
        memset(cpu.memory, 0, 0x10000);
        const uint16_t startPC = 0x2000;
        cpu.memory[startPC] = v.opcode;
        cpu.memory[startPC + 1] = v.o1;
        cpu.memory[startPC + 2] = v.o2;
        cpu.pc = startPC; cpu.a = v.a; cpu.x = v.x; cpu.y = v.y;
        cpu.sp = 0xFD; cpu.status = FLAG_UNUSED | FLAG_INTERRUPT;
        cpu.cycles = 0; cpu.halted = false;
        cpu_step();

        if (cpu.memory[v.expectAddr] != v.expectValue) {
            printf("  %-14s expected mem[$%04X]=$%02X, got $%02X\n",
                   v.name, v.expectAddr, v.expectValue, cpu.memory[v.expectAddr]);
            bad++;
        }

        aud_set_state(cpu.memory, startPC, v.a, v.x, v.y, 0xFD,
                      FLAG_UNUSED | FLAG_INTERRUPT);
        // aud_set_state copied the post-store image, so undo the store first.
        aud_mem()[v.expectAddr] = 0;
        aud_step();
        if (aud_mem()[v.expectAddr] != v.expectValue) {
            printf("  %-14s audio core: expected mem[$%04X]=$%02X, got $%02X\n",
                   v.name, v.expectAddr, v.expectValue, aud_mem()[v.expectAddr]);
            bad++;
        }
    }
    return bad;
}

int main(int argc, char** argv) {
    const uint32_t iterations = (argc > 1) ? (uint32_t)strtoul(argv[1], nullptr, 0) : 20000;

#ifdef WITH_REFERENCE
    for (uint8_t op : refOpcodes) inRefSet[op] = true;
#endif

    cpu_init();
    cpu_set_tracking(false);

    printf("=== analysis core vs opcodes.h ===\n");
    int nTable = table_check();
    if (!nTable) printf("  (none)\n");

    printf("\n=== unstable stores vs hand-worked vectors ===\n");
    int nVec = vector_check();
    if (!nVec) printf("  (none)\n");
    printf("\n");

    for (int op = 0; op < 256; op++) {
        // BRK and the KIL opcodes are terminal by design in at least one core,
        // so a single-step comparison says nothing useful about them.
        if (op == 0x00 || (op & 0x0F) == 0x02) continue;

        rngState = 0x9E3779B97F4A7C15ull ^ (uint64_t)op * 0x100000001B3ull;
        for (int i = 0; i < 0x10000; i += 4) {
            uint32_t r = rnd();
            base[i] = (uint8_t)r; base[i+1] = (uint8_t)(r >> 8);
            base[i+2] = (uint8_t)(r >> 16); base[i+3] = (uint8_t)(r >> 24);
        }
        // The audio core maps $D400-$D7FF onto the SID chips instead of RAM.
        // Zeroing the range keeps reads comparable; writes there are excluded
        // from the memory compare below.
        memset(base + 0xD400, 0, 0x400);

        for (uint32_t it = 0; it < iterations; it++) {
            // Mostly run from normal RAM, but sometimes from zero page so
            // zero-page addressing can alias the instruction's own bytes.
            uint16_t startPC = ((it & 7) == 4) ? (uint16_t)(0x0010 + (rnd() % 0xE0))
                                               : (uint16_t)(0x0200 + (rnd() % 0xC000));
            uint8_t ra = (uint8_t)rnd(), rx = (uint8_t)rnd(), ry = (uint8_t)rnd();
            uint8_t rsp = (uint8_t)rnd();
            uint8_t rf = (uint8_t)(rnd() & FLAGMASK);
            uint8_t o1 = (uint8_t)rnd(), o2 = (uint8_t)rnd();

            // Point the operand at the instruction's own bytes now and then, so
            // read-modify-write self-modification is exercised on purpose.
            if ((it & 3) == 0) {
                o1 = (uint8_t)(startPC + 1);
                o2 = (uint8_t)((startPC + 1) >> 8);
            }

            // The siddump-family reference bails out of RTS/RTI on an empty stack.
            if ((op == 0x40 || op == 0x60) && rsp == 0xFF) rsp = 0xFE;

            base[startPC] = (uint8_t)op;
            base[(uint16_t)(startPC + 1)] = o1;
            base[(uint16_t)(startPC + 2)] = o2;

            memcpy(cpu.memory, base, 0x10000);
            cpu.pc = startPC; cpu.a = ra; cpu.x = rx; cpu.y = ry;
            cpu.sp = rsp; cpu.status = rf; cpu.cycles = 0; cpu.halted = false;
            cpu_step();

            aud_set_state(base, startPC, ra, rx, ry, rsp, rf);
            uint32_t audCycles = (uint32_t)aud_step();

            char buf[192];

#ifdef WITH_REFERENCE
            if (inRefSet[op]) {
                memcpy(mem, base, 0x10000);
                initcpu(startPC, ra, rx, ry);
                sp = rsp; flags = rf; cpucycles = 0;
                runcpu();

                if (cpu.pc != pc)
                    snprintf(buf, sizeof(buf), "PC: A=$%04X R=$%04X", cpu.pc, pc);
                else if (cpu.a != a)
                    snprintf(buf, sizeof(buf), "A reg: A=$%02X R=$%02X", cpu.a, a);
                else if (cpu.x != x)
                    snprintf(buf, sizeof(buf), "X: A=$%02X R=$%02X", cpu.x, x);
                else if (cpu.y != y)
                    snprintf(buf, sizeof(buf), "Y: A=$%02X R=$%02X", cpu.y, y);
                else if (cpu.sp != sp)
                    snprintf(buf, sizeof(buf), "SP: A=$%02X R=$%02X", cpu.sp, sp);
                else if ((cpu.status & FLAGMASK) != (flags & FLAGMASK))
                    snprintf(buf, sizeof(buf), "P: A=$%02X R=$%02X (diff $%02X)",
                             cpu.status & FLAGMASK, flags & FLAGMASK,
                             (cpu.status ^ flags) & FLAGMASK);
                else if ((uint32_t)cpu.cycles != cpucycles)
                    snprintf(buf, sizeof(buf), "cycles: A=%u R=%u",
                             (uint32_t)cpu.cycles, cpucycles);
                else if (memcmp(cpu.memory, mem, 0x10000) != 0) {
                    int at = 0; while (cpu.memory[at] == mem[at]) at++;
                    snprintf(buf, sizeof(buf), "mem[$%04X]: A=$%02X R=$%02X",
                             at, cpu.memory[at], mem[at]);
                } else buf[0] = 0;

                if (buf[0]) note(divRef[op], buf, startPC, ra, rx, ry, rsp, rf, o1, o2);
            }
#endif

            const uint8_t* am = aud_mem();
            if (cpu.pc != aud_pc())
                snprintf(buf, sizeof(buf), "PC: A=$%04X B=$%04X", cpu.pc, aud_pc());
            else if (cpu.a != aud_a())
                snprintf(buf, sizeof(buf), "A reg: A=$%02X B=$%02X", cpu.a, aud_a());
            else if (cpu.x != aud_x())
                snprintf(buf, sizeof(buf), "X: A=$%02X B=$%02X", cpu.x, aud_x());
            else if (cpu.y != aud_y())
                snprintf(buf, sizeof(buf), "Y: A=$%02X B=$%02X", cpu.y, aud_y());
            else if (cpu.sp != aud_sp())
                snprintf(buf, sizeof(buf), "SP: A=$%02X B=$%02X", cpu.sp, aud_sp());
            else if ((cpu.status & FLAGMASK) != (aud_st() & FLAGMASK))
                snprintf(buf, sizeof(buf), "P: A=$%02X B=$%02X (diff $%02X)",
                         cpu.status & FLAGMASK, aud_st() & FLAGMASK,
                         (cpu.status ^ aud_st()) & FLAGMASK);
            else if ((uint32_t)cpu.cycles != audCycles)
                snprintf(buf, sizeof(buf), "cycles: A=%u B=%u",
                         (uint32_t)cpu.cycles, audCycles);
            else {
                buf[0] = 0;
                int at = -1;
                if (memcmp(cpu.memory, am, 0xD400) != 0) {
                    at = 0; while (cpu.memory[at] == am[at]) at++;
                } else if (memcmp(cpu.memory + 0xD800, am + 0xD800, 0x2800) != 0) {
                    at = 0xD800; while (cpu.memory[at] == am[at]) at++;
                }
                if (at >= 0)
                    snprintf(buf, sizeof(buf), "mem[$%04X]: A=$%02X B=$%02X",
                             at, cpu.memory[at], am[at]);
            }
            if (buf[0]) note(divAud[op], buf, startPC, ra, rx, ry, rsp, rf, o1, o2);
        }
    }

    int nRef = 0, nAud = 0;
#ifdef WITH_REFERENCE
    report("analysis core (cpu6510_wasm.cpp) vs reference core", divRef, iterations, nRef);
    printf("\n");
#endif
    report("analysis core (cpu6510_wasm.cpp) vs audio core (sid_audio.cpp)",
           divAud, iterations, nAud);

    printf("\n%d opcode-table mismatches, %d store-vector failures, "
           "%d opcodes diverge vs audio core", nTable, nVec, nAud);
#ifdef WITH_REFERENCE
    printf(", %d vs reference core", nRef);
#endif
    printf(" (%u cases each)\n", iterations);
    return (nRef || nAud || nTable || nVec) ? 1 : 0;
}
