// cpu6510_wasm.cpp - the analysis machine: the shared 6510 core on a bus that
// records memory access. Built into sidquake.wasm by
// scripts/build-sidquake-wasm.sh.

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include <algorithm>
#include <set>
#include "opcodes.h"
#include "c64_io.h"
#include "c64_env.h"
#include "cpu6510_api.h"
#include "cpu6510_core.h"

enum MemoryAccessFlag {
    MEM_EXECUTE = 1 << 0,
    MEM_READ = 1 << 1,
    MEM_WRITE = 1 << 2,
    MEM_JUMP_TARGET = 1 << 3,
    MEM_OPCODE = 1 << 4
};

// One analysis machine: registers, RAM and what the code did to it. The
// exported C API below drives a single default instance; native tests can
// create as many as they like.
//
// It is also the bus the shared decoder in cpu6510_core.h runs on, so the
// decoder reaches registers and RAM through one reference. Instruction-stream
// fetches deliberately bypass tracking: they are covered by
// MEM_EXECUTE/MEM_OPCODE instead.
struct Analyser6510 {
    uint16_t pc;
    uint8_t sp;
    uint8_t a;
    uint8_t x;
    uint8_t y;
    uint8_t st;
    uint64_t cycles;

    uint8_t ciaTimerLo;
    uint8_t ciaTimerHi;
    bool ciaTimerWritten;

    uint8_t memory[65536];
    uint8_t memoryAccess[65536];

    uint32_t sidWrites[32];  // per SID register, all chips folded together
    uint32_t totalSidWrites;

    // Multi-SID chip tracking: $20-byte slots, 0-31 for $D400-$D7FF and
    // 32-47 for $DE00-$DFFF (the I/O areas a second or third SID sits in)
    bool sidChipsUsed[48];

    uint32_t zpWrites[256];
    uint32_t totalZpWrites;

    uint16_t lastWritePC[65536];

    // For pattern detection
    std::vector<uint16_t> writeSequence;
    bool recordWrites;

    // Flag to enable/disable tracking (so we can load without tracking)
    bool trackingEnabled;

    // Set by KIL/JAM opcodes; execute() exits immediately when true
    bool halted;

    // First byte of the instruction currently executing, so a store is
    // attributed to the instruction rather than to the advanced PC.
    uint16_t instructionPC;

    // Cycles of the last execute() call, or 0 if it did not return.
    uint32_t lastExecutionCycles;

    void init();
    void resetStateOnly();
    void writeTracked(uint16_t address, uint8_t value);
    int step();
    int execute(uint16_t address, uint32_t maxCycles, bool irq, bool kernalEntry);
    uint32_t sidChipCount() const;
    uint16_t sidChipAddress(uint32_t index) const;
    void setRecordWrites(bool record);

    // === Bus ================================================================
    uint8_t fetch(uint16_t addr) { return memory[addr]; }
    uint8_t read(uint16_t addr) {
        if (trackingEnabled) memoryAccess[addr] |= MEM_READ;
        uint8_t io;
        if (c64io::read(addr, memory, cycles, io)) return io;
        return memory[addr];
    }
    void write(uint16_t addr, uint8_t value) { writeTracked(addr, value); }
    // The analyser models no write-sensitive I/O, and counting the RMW
    // write-back would double every INC/DEC/shift in the write tracking.
    void dummyWrite(uint16_t, uint8_t) {}
    void jumpTarget(uint16_t addr) {
        if (trackingEnabled) memoryAccess[addr] |= MEM_JUMP_TARGET;
    }
    void jam() { halted = true; }

    // For c64env::call, with step() above.
    bool jammed() const { return halted; }
    void clearJam() { halted = false; }
};

void Analyser6510::init() {
    pc = 0;
    sp = 0xFD;
    a = 0;
    x = 0;
    y = 0;
    st = cpu6510::FLAG_I | cpu6510::FLAG_U;
    cycles = 0;

    ciaTimerLo = 0;
    ciaTimerHi = 0;
    ciaTimerWritten = false;

    totalSidWrites = 0;
    totalZpWrites = 0;
    recordWrites = false;
    trackingEnabled = false;
    halted = false;
    instructionPC = 0;
    lastExecutionCycles = 0;

    memset(memory, 0, sizeof(memory));
    // The processor port as the KERNAL leaves it: I/O mapped in, so SID
    // and CIA writes are seen as such until the code banks it out.
    memory[0x00] = 0x2F;
    memory[0x01] = 0x37;
    memset(memoryAccess, 0, sizeof(memoryAccess));
    memset(sidWrites, 0, sizeof(sidWrites));
    memset(sidChipsUsed, 0, sizeof(sidChipsUsed));
    memset(zpWrites, 0, sizeof(zpWrites));
    memset(lastWritePC, 0, sizeof(lastWritePC));

    writeSequence.clear();
}

// Reset CPU registers and tracking state, leaving memory contents intact.
void Analyser6510::resetStateOnly() {
    pc = 0;
    sp = 0xFD;
    a = 0;
    x = 0;
    y = 0;
    st = cpu6510::FLAG_I | cpu6510::FLAG_U;
    cycles = 0;

    ciaTimerLo = 0;
    ciaTimerHi = 0;
    ciaTimerWritten = false;
    totalSidWrites = 0;
    totalZpWrites = 0;
    recordWrites = false;
    halted = false;
    instructionPC = 0;
    lastExecutionCycles = 0;

    memset(memoryAccess, 0, sizeof(memoryAccess));
    memset(sidWrites, 0, sizeof(sidWrites));
    memset(sidChipsUsed, 0, sizeof(sidChipsUsed));
    memset(zpWrites, 0, sizeof(zpWrites));
    memset(lastWritePC, 0, sizeof(lastWritePC));
    writeSequence.clear();
}

// Instruction-driven write: this is the path that records access info.
void Analyser6510::writeTracked(uint16_t address, uint8_t value) {
    memory[address] = value;
    c64io::write(memory, address, value);

    if (trackingEnabled) {
        memoryAccess[address] |= MEM_WRITE;
        lastWritePC[address] = instructionPC;

        if (address < 256) {
            zpWrites[address]++;
            totalZpWrites++;
        }

        // I/O is only there when the processor port maps it in; otherwise
        // a write here is to RAM.
        if (c64io::io_visible(memory[0x01])) {
            // Track SID writes (full SID range $D400-$D7FF)
            if (address >= 0xD400 && address <= 0xD7FF) {
                uint8_t reg = address & 0x1F;
                sidWrites[reg]++;
                totalSidWrites++;

                uint8_t sidChipIndex = (address - 0xD400) >> 5;
                sidChipsUsed[sidChipIndex] = true;

                if (recordWrites) {
                    writeSequence.push_back(address);
                }
            }
            else if (address >= 0xDE00 && address <= 0xDFFF) {
                sidChipsUsed[32 + ((address - 0xDE00) >> 5)] = true;
            }

            // Track CIA 1 timer A writes, through the register mirrors too: CIA 1
            // repeats every 16 bytes across $DC00-$DCFF.
            if ((address & 0xFF0F) == 0xDC04) {
                ciaTimerLo = value;
                ciaTimerWritten = true;
            }
            else if ((address & 0xFF0F) == 0xDC05) {
                ciaTimerHi = value;
                ciaTimerWritten = true;
            }
        }
    }
}

// Execute one instruction; returns its cycles, which are also added to cycles.
int Analyser6510::step() {
    if (trackingEnabled) {
        // The whole instruction is code; MEM_OPCODE marks where it starts.
        memoryAccess[pc] |= MEM_EXECUTE | MEM_OPCODE;
        for (uint8_t i = 1; i < opcodeTable[memory[pc]].size; i++) {
            memoryAccess[(uint16_t)(pc + i)] |= MEM_EXECUTE;
        }
    }
    // Writes are attributed to the instruction that made them, not to
    // wherever the PC has reached by the time the store happens.
    instructionPC = pc;

    const int c = cpu6510::step(*this);
    cycles += c;
    return c;
}

// Run a subroutine, or with `irq` an interrupt handler, until it returns or
// maxCycles is exceeded (see c64env::call). Returns 1 if it returned;
// lastExecutionCycles is then its cycle count, else 0.
int Analyser6510::execute(uint16_t address, uint32_t maxCycles, bool irq, bool kernalEntry) {
    const c64env::CallResult r = c64env::call(*this, address, maxCycles, irq, kernalEntry);
    lastExecutionCycles = r.returned ? r.cycles : 0;
    return r.returned ? 1 : 0;
}

// Number of $20-byte SID slots written to.
uint32_t Analyser6510::sidChipCount() const {
    uint32_t count = 0;
    for (int i = 0; i < 48; i++) {
        if (sidChipsUsed[i]) {
            count++;
        }
    }
    return count;
}

// Base address of the Nth SID slot written to (0-indexed), or 0 if index is
// out of range.
uint16_t Analyser6510::sidChipAddress(uint32_t index) const {
    uint32_t count = 0;
    for (int i = 0; i < 48; i++) {
        if (sidChipsUsed[i]) {
            if (count == index) {
                return i < 32 ? 0xD400 + (i * 0x20) : 0xDE00 + ((i - 32) * 0x20);
            }
            count++;
        }
    }
    return 0;
}

void Analyser6510::setRecordWrites(bool record) {
    recordWrites = record;
    if (record) {
        writeSequence.clear();
    }
}

// The instance the exported C API drives.
static Analyser6510 cpu;

extern "C" {

    EMSCRIPTEN_KEEPALIVE
        void cpu_init() {
        cpu.init();
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_set_tracking(bool enabled) {
        cpu.trackingEnabled = enabled;
    }

    // Load data into memory without recording it as a tracked write.
    EMSCRIPTEN_KEEPALIVE
        void cpu_load_memory(uint16_t address, uint8_t* data, uint16_t size) {
        if (address + size <= 65536) {
            memcpy(&cpu.memory[address], data, size);
        }
    }

    // Host-side read (JS inspecting RAM or a SID register). Leaves no access
    // flag: MEM_READ records what the tune's own instructions read, and a host
    // look would otherwise make an untouched page look used.
    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_read_memory(uint16_t address) {
        return cpu.memory[address];
    }

    // External-write entry point: bypasses tracking (used for initial setup only).
    EMSCRIPTEN_KEEPALIVE
        void cpu_write_memory(uint16_t address, uint8_t value) {
        cpu.memory[address] = value;
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_step() {
        cpu.step();
    }


    // Run a subroutine until its matching RTS, or maxCycles is exceeded (see
    // c64env::call). Returns 1 if it returned; lastExecutionCycles is then its
    // cycle count, else 0.
    EMSCRIPTEN_KEEPALIVE
        int cpu_execute_function(uint16_t address, uint32_t maxCycles) {
        return cpu.execute(address, maxCycles, false, false);
    }

    // Run an interrupt handler until the RTI that ends it, or maxCycles is
    // exceeded. kernalEntry: the handler was reached through the KERNAL's $FF48
    // entry, which pushed A, X and Y; a handler leaving through JMP $EA31 /
    // $EA81 pulls them back.
    EMSCRIPTEN_KEEPALIVE
        int cpu_execute_interrupt(uint16_t address, uint32_t maxCycles, bool kernalEntry) {
        return cpu.execute(address, maxCycles, true, kernalEntry);
    }

    // The play routine a PSID with play address 0 left behind (see
    // c64env::irq_handler). Bit 16 of the result is set when the handler expects
    // cpu_execute_interrupt's kernalEntry.
    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_irq_handler() {
        const c64env::IrqHandler h = c64env::irq_handler(cpu.memory);
        return (h.viaKernal ? 0x10000u : 0u) | h.addr;
    }

    // The machine a PSID expects of the KERNAL (see c64env::plant_kernal).
    // Call before loading the tune, which then overwrites any stub it overlaps.
    EMSCRIPTEN_KEEPALIVE
        void cpu_setup_c64_env() {
        c64env::plant_kernal(cpu.memory);
    }

    EMSCRIPTEN_KEEPALIVE
        uint16_t cpu_get_pc() { return cpu.pc; }

    EMSCRIPTEN_KEEPALIVE
        void cpu_set_pc(uint16_t pc) { cpu.pc = pc; }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_sp() { return cpu.sp; }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_a() { return cpu.a; }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_x() { return cpu.x; }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_y() { return cpu.y; }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_cia_timer_lo() {
        return cpu.ciaTimerLo;
    }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_cia_timer_hi() {
        return cpu.ciaTimerHi;
    }

    EMSCRIPTEN_KEEPALIVE
        bool cpu_get_cia_timer_written() {
        return cpu.ciaTimerWritten;
    }

    EMSCRIPTEN_KEEPALIVE
        uint64_t cpu_get_cycles() { return cpu.cycles; }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_last_execution_cycles() { return cpu.lastExecutionCycles; }

    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_memory_access(uint16_t address) {
        return cpu.memoryAccess[address];
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_sid_writes(uint8_t reg) {
        if (reg < 32) {
            return cpu.sidWrites[reg];
        }
        return 0;
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_total_sid_writes() {
        return cpu.totalSidWrites;
    }

    // Whether $20-byte SID slot `slot` was written to: $D400 + slot * $20 for
    // slots 0-31, $DE00 + (slot - 32) * $20 for 32-47.
    EMSCRIPTEN_KEEPALIVE
        bool cpu_get_sid_chip_used(uint32_t slot) {
        return slot < 48 && cpu.sidChipsUsed[slot];
    }

    // Forget which SID slots have been written to, so a caller can count
    // only the writes that follow (sid_analyze: play, not init).
    EMSCRIPTEN_KEEPALIVE
        void cpu_reset_sid_chip_usage() {
        memset(cpu.sidChipsUsed, 0, sizeof(cpu.sidChipsUsed));
    }

    // The number of $20-byte SID slots written to.
    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_sid_chip_count() {
        return cpu.sidChipCount();
    }

    // Base address of the Nth SID slot written to (0-indexed), or 0 if index
    // is out of range.
    EMSCRIPTEN_KEEPALIVE
        uint16_t cpu_get_sid_chip_address(uint32_t index) {
        return cpu.sidChipAddress(index);
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_zp_writes(uint8_t addr) {
        return cpu.zpWrites[addr];
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_total_zp_writes() {
        return cpu.totalZpWrites;
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_set_record_writes(bool record) {
        cpu.setRecordWrites(record);
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_write_sequence_length() {
        return cpu.writeSequence.size();
    }

    EMSCRIPTEN_KEEPALIVE
        uint16_t cpu_get_write_sequence_item(uint32_t index) {
        if (index < cpu.writeSequence.size()) {
            return cpu.writeSequence[index];
        }
        return 0;
    }

    // Bytes in [startAddr, endAddr] that were executed, and the rest.
    EMSCRIPTEN_KEEPALIVE
        void cpu_analyze_memory(uint16_t startAddr, uint16_t endAddr, uint32_t* codeBytes, uint32_t* dataBytes) {
        *codeBytes = 0;
        *dataBytes = 0;

        for (uint32_t addr = startAddr; addr <= endAddr && addr < 65536; addr++) {
            if (cpu.memoryAccess[addr] & MEM_EXECUTE) {
                (*codeBytes)++;
            }
            else {
                (*dataBytes)++;
            }
        }
    }

    EMSCRIPTEN_KEEPALIVE
        uint16_t cpu_get_last_write_pc(uint16_t address) {
        return cpu.lastWritePC[address];
    }

    // Memory allocation helpers for JavaScript
    EMSCRIPTEN_KEEPALIVE
        uint8_t* allocate_memory(size_t size) {
        return (uint8_t*)malloc(size);
    }

    EMSCRIPTEN_KEEPALIVE
        void free_memory(uint8_t* ptr) {
        free(ptr);
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_set_accumulator(uint8_t value) {
        cpu.a = value;
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_set_xreg(uint8_t value) {
        cpu.x = value;
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_set_yreg(uint8_t value) {
        cpu.y = value;
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_save_memory(uint8_t* buffer) {
        memcpy(buffer, cpu.memory, 65536);
    }

    EMSCRIPTEN_KEEPALIVE
        void cpu_restore_memory(uint8_t* buffer) {
        memcpy(cpu.memory, buffer, 65536);
    }

    // Reset CPU registers and tracking state, leaving memory contents intact.
    EMSCRIPTEN_KEEPALIVE
        void cpu_reset_state_only() {
        cpu.resetStateOnly();
    }

} // extern "C"