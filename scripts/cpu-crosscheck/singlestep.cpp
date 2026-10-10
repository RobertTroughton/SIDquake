// Instruction-level tests for the shared 6510 decoder (wasm/cpu6510_core.h)
// against two outside references:
//
//   - Tom Harte's SingleStepTests 65x02 suite (6502/v1/<op>.json): 10,000
//     cases per opcode, each an initial and final machine state plus the
//     cycle-by-cycle bus activity of a real NMOS 6502.
//   - Klaus Dormann's 6502_functional_test.bin, which traps at $3469 when
//     every test passes and at the failing test otherwise.
//
// Neither is committed (see README.md); singlestep.sh downloads them.
//
//   singlestep --harte <dir> [op.json ...]   run the named files from <dir>
//   singlestep --klaus <file.bin>

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "cpu6510_core.h"

// ---- a flat 64 KB RAM bus that records its writes --------------------------

struct Machine {
    uint16_t pc = 0;
    uint8_t sp = 0, a = 0, x = 0, y = 0, st = 0;
    uint8_t mem[0x10000];
    bool jammed = false;
    std::vector<std::pair<uint16_t, uint8_t>> writes;
};
static Machine m;

struct FlatBus {
    uint16_t& pc;
    uint8_t& sp;
    uint8_t& a;
    uint8_t& x;
    uint8_t& y;
    uint8_t& st;

    uint8_t fetch(uint16_t addr) { return m.mem[addr]; }
    uint8_t read(uint16_t addr) { return m.mem[addr]; }
    void write(uint16_t addr, uint8_t val) { m.mem[addr] = val; m.writes.push_back({addr, val}); }
    void dummyWrite(uint16_t addr, uint8_t val) { write(addr, val); }
    void jumpTarget(uint16_t) {}
    void jam() { m.jammed = true; }
};

static int step() {
    FlatBus bus{ m.pc, m.sp, m.a, m.x, m.y, m.st };
    return cpu6510::step(bus);
}

// ---- exclusions ------------------------------------------------------------
//
// Each entry is behaviour the core does not model. Everything else must match
// Harte's states, cycle counts and bus writes exactly.

static bool skipOpcode(uint8_t op) {
    // JAM/KIL: the CPU halts and hammers the bus forever. The core reports the
    // halt to its bus and stops instead, so there is no final state to compare.
    if ((op & 0x0F) == 0x02 && op != 0x82 && op != 0xA2 && op != 0xC2 && op != 0xE2)
        return true;
    return false;
}

// ---- a minimal reader for the Harte JSON layout ----------------------------

struct Reader {
    const char* p;
    const char* end;
    bool ok = true;

    void ws() { while (p < end && isspace((unsigned char)*p)) p++; }
    bool peek(char c) { ws(); return p < end && *p == c; }
    void expect(char c) { ws(); if (p < end && *p == c) p++; else ok = false; }
    bool accept(char c) { if (peek(c)) { p++; return true; } return false; }
    long number() {
        ws();
        char* e;
        long v = strtol(p, &e, 10);
        if (e == p) ok = false;
        p = e;
        return v;
    }
    std::string str() {
        expect('"');
        const char* s = p;
        while (p < end && *p != '"') p++;
        std::string r(s, p);
        expect('"');
        return r;
    }
};

struct State {
    uint16_t pc;
    uint8_t s, a, x, y, p;
    std::vector<std::pair<uint16_t, uint8_t>> ram;
};

struct Cycle {
    uint16_t addr;
    uint8_t val;
    bool write;
};

struct Case {
    std::string name;
    State initial, final;
    std::vector<Cycle> cycles;
};

static void readState(Reader& r, State& s) {
    r.expect('{');
    do {
        std::string k = r.str();
        r.expect(':');
        if (k == "ram") {
            s.ram.clear();
            r.expect('[');
            if (!r.accept(']')) {
                do {
                    r.expect('[');
                    uint16_t addr = (uint16_t)r.number();
                    r.expect(',');
                    uint8_t val = (uint8_t)r.number();
                    r.expect(']');
                    s.ram.push_back({addr, val});
                } while (r.accept(','));
                r.expect(']');
            }
        } else {
            long v = r.number();
            if (k == "pc") s.pc = (uint16_t)v;
            else if (k == "s") s.s = (uint8_t)v;
            else if (k == "a") s.a = (uint8_t)v;
            else if (k == "x") s.x = (uint8_t)v;
            else if (k == "y") s.y = (uint8_t)v;
            else if (k == "p") s.p = (uint8_t)v;
        }
    } while (r.accept(','));
    r.expect('}');
}

static bool readCase(Reader& r, Case& c) {
    r.expect('{');
    do {
        std::string k = r.str();
        r.expect(':');
        if (k == "name") c.name = r.str();
        else if (k == "initial") readState(r, c.initial);
        else if (k == "final") readState(r, c.final);
        else if (k == "cycles") {
            c.cycles.clear();
            r.expect('[');
            if (!r.accept(']')) {
                do {
                    Cycle cy;
                    r.expect('[');
                    cy.addr = (uint16_t)r.number();
                    r.expect(',');
                    cy.val = (uint8_t)r.number();
                    r.expect(',');
                    cy.write = r.str() == "write";
                    r.expect(']');
                    c.cycles.push_back(cy);
                } while (r.accept(','));
                r.expect(']');
            }
        } else {
            r.ok = false;
        }
    } while (r.ok && r.accept(','));
    r.expect('}');
    return r.ok;
}

// ---- Harte -----------------------------------------------------------------

// Runs one case; returns an empty string on a match, else what differed.
static std::string runCase(const Case& c) {
    for (auto& e : c.initial.ram) m.mem[e.first] = e.second;
    m.pc = c.initial.pc; m.sp = c.initial.s; m.a = c.initial.a;
    m.x = c.initial.x; m.y = c.initial.y; m.st = c.initial.p;
    m.jammed = false;
    m.writes.clear();

    int cycles = step();

    char buf[160];
    std::string err;
    auto reg = [&](const char* n, unsigned got, unsigned want) {
        if (got != want && err.empty()) {
            snprintf(buf, sizeof(buf), "%s: got $%02X want $%02X", n, got, want);
            err = buf;
        }
    };
    reg("PC", m.pc, c.final.pc);
    reg("A", m.a, c.final.a);
    reg("X", m.x, c.final.x);
    reg("Y", m.y, c.final.y);
    reg("SP", m.sp, c.final.s);
    // P bit 4 is not a register bit: B exists only in the copy BRK/PHP push.
    // Harte reads it as 0; the core keeps what PLP/RTI loaded, which nothing
    // observes because every push of P sets or clears it explicitly.
    reg("P", m.st & 0xEF, c.final.p & 0xEF);
    if (err.empty() && cycles != (int)c.cycles.size()) {
        snprintf(buf, sizeof(buf), "cycles: got %d want %zu", cycles, c.cycles.size());
        err = buf;
    }
    for (auto& e : c.final.ram) {
        if (err.empty() && m.mem[e.first] != e.second) {
            snprintf(buf, sizeof(buf), "mem[$%04X]: got $%02X want $%02X",
                     e.first, m.mem[e.first], e.second);
            err = buf;
        }
    }
    if (err.empty()) {
        // The bus writes, in order. Reads are not compared: the core does not
        // make the 6502's dummy reads, which only matter to read-sensitive I/O.
        std::vector<std::pair<uint16_t, uint8_t>> want;
        for (auto& cy : c.cycles) if (cy.write) want.push_back({cy.addr, cy.val});
        if (want != m.writes) {
            std::string g, w;
            for (auto& e : m.writes) { snprintf(buf, sizeof(buf), " $%04X=$%02X", e.first, e.second); g += buf; }
            for (auto& e : want) { snprintf(buf, sizeof(buf), " $%04X=$%02X", e.first, e.second); w += buf; }
            err = "writes: got" + g + " want" + w;
        }
    }

    // Leave memory zeroed for the next case.
    for (auto& e : c.initial.ram) m.mem[e.first] = 0;
    for (auto& e : m.writes) m.mem[e.first] = 0;
    return err;
}

static int runHarte(const char* dir, int nFiles, char** files) {
    long total = 0, failed = 0;
    int badOps = 0, skipped = 0;
    memset(m.mem, 0, sizeof(m.mem));
    for (int i = 0; i < nFiles; i++) {
        std::string path = std::string(dir) + "/" + files[i];
        uint8_t op = (uint8_t)strtoul(files[i], nullptr, 16);
        if (skipOpcode(op)) { skipped++; continue; }

        FILE* f = fopen(path.c_str(), "rb");
        if (!f) { printf("  %s: cannot open\n", path.c_str()); badOps++; continue; }
        std::string text;
        char chunk[1 << 16];
        size_t n;
        while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) text.append(chunk, n);
        fclose(f);

        Reader r{ text.data(), text.data() + text.size() };
        r.expect('[');
        long cases = 0, bad = 0;
        std::string firstName, firstErr;
        Case c;
        while (r.ok && !r.peek(']')) {
            if (!readCase(r, c)) break;
            cases++;
            std::string err = runCase(c);
            if (!err.empty()) {
                if (!bad) { firstName = c.name; firstErr = err; }
                bad++;
            }
            r.accept(',');
        }
        if (!r.ok) { printf("  $%02X %-4s: malformed JSON in %s\n", op, opcodeTable[op].mnemonic, path.c_str()); badOps++; continue; }
        total += cases;
        failed += bad;
        if (bad) {
            badOps++;
            printf("  $%02X %-4s %5ld/%ld fail, first \"%s\": %s\n", op,
                   opcodeTable[op].mnemonic, bad, cases, firstName.c_str(), firstErr.c_str());
        }
    }
    printf("Harte: %ld/%ld cases pass, %d opcodes with failures, %d opcodes excluded\n",
           total - failed, total, badOps, skipped);
    return badOps ? 1 : 0;
}

// ---- Klaus Dormann ---------------------------------------------------------

static int runKlaus(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) { printf("Klaus: cannot open %s\n", path); return 1; }
    size_t n = fread(m.mem, 1, sizeof(m.mem), f);
    fclose(f);
    if (n != sizeof(m.mem)) { printf("Klaus: %s is not a 64 KB image\n", path); return 1; }

    // The test reports by trapping in a branch or jump to itself; $3469 is the
    // success trap of the published binary.
    const uint16_t success = 0x3469;
    m.pc = 0x0400; m.sp = 0xFF; m.a = m.x = m.y = 0; m.st = 0x24;
    uint64_t cycles = 0;
    for (;;) {
        uint16_t before = m.pc;
        m.writes.clear();
        cycles += step();
        if (m.jammed) { printf("Klaus: JAM at $%04X\n", m.pc); return 1; }
        if (m.pc == before) break;
        if (cycles > 200000000ull) { printf("Klaus: no trap after %llu cycles\n", (unsigned long long)cycles); return 1; }
    }
    if (m.pc != success) {
        printf("Klaus: trapped at $%04X (success is $%04X)\n", m.pc, success);
        return 1;
    }
    printf("Klaus: pass, success trap $%04X after %llu cycles\n", m.pc, (unsigned long long)cycles);
    return 0;
}

int main(int argc, char** argv) {
    if (argc >= 3 && !strcmp(argv[1], "--klaus")) return runKlaus(argv[2]);
    if (argc >= 3 && !strcmp(argv[1], "--harte")) return runHarte(argv[2], argc - 3, argv + 3);
    fprintf(stderr, "usage: %s --harte <dir> <op.json>... | --klaus <file.bin>\n", argv[0]);
    return 2;
}
