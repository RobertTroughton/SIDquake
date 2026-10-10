// cpu6510_wasm.cpp - 6510 emulator core with memory-access tracking.
// Build: emcc cpu6510_wasm.cpp -O3 -s WASM=1 -s EXPORTED_FUNCTIONS='["_malloc","_free"]' -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]' -s MODULARIZE=1 -s EXPORT_NAME='CPU6510Module' -o cpu6510.js

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
#include "cpu6510_core.h"

extern "C" {

    // Memory access tracking flags
    enum MemoryAccessFlag {
        MEM_EXECUTE = 1 << 0,
        MEM_READ = 1 << 1,
        MEM_WRITE = 1 << 2,
        MEM_JUMP_TARGET = 1 << 3,
        MEM_OPCODE = 1 << 4
    };

    // CPU Status flags
    enum StatusFlag {
        FLAG_CARRY = 0x01,
        FLAG_ZERO = 0x02,
        FLAG_INTERRUPT = 0x04,
        FLAG_DECIMAL = 0x08,
        FLAG_BREAK = 0x10,
        FLAG_UNUSED = 0x20,
        FLAG_OVERFLOW = 0x40,
        FLAG_NEGATIVE = 0x80
    };

    // Global CPU state
    struct CPU6510State {
        uint16_t pc;
        uint8_t sp;
        uint8_t a;
        uint8_t x;
        uint8_t y;
        uint8_t status;
        uint64_t cycles;

        uint8_t ciaTimerLo;
        uint8_t ciaTimerHi;
        bool ciaTimerWritten;

        uint8_t memory[65536];
        uint8_t memoryAccess[65536];

        // SID write tracking
        uint32_t sidWrites[32];  // Count writes to each SID register
        uint32_t totalSidWrites;

        // Multi-SID chip tracking: $20-byte slots, 0-31 for $D400-$D7FF and
        // 32-47 for $DE00-$DFFF (the I/O areas a second or third SID sits in)
        bool sidChipsUsed[48];   // Track which SID chips have been written to

        // Zero page write tracking
        uint32_t zpWrites[256];   // Count writes to each zero page location
        uint32_t totalZpWrites;

        // Memory write tracking
        uint16_t lastWritePC[65536];  // Track PC that last wrote to each address

        // For pattern detection
        std::vector<uint16_t> writeSequence;
        bool recordWrites;

        // Flag to enable/disable tracking (so we can load without tracking)
        bool trackingEnabled;

        // Set by KIL/JAM opcodes; cpu_execute_function exits immediately when true
        bool halted;

        // First byte of the instruction currently executing, so a store is
        // attributed to the instruction rather than to the advanced PC.
        uint16_t instructionPC;

        // Track cycles from last function execution
        uint32_t lastExecutionCycles;
    } cpu;

    // Initialize CPU
    EMSCRIPTEN_KEEPALIVE
        void cpu_init() {
        cpu.pc = 0;
        cpu.sp = 0xFD;
        cpu.a = 0;
        cpu.x = 0;
        cpu.y = 0;
        cpu.status = FLAG_INTERRUPT | FLAG_UNUSED;
        cpu.cycles = 0;

        cpu.ciaTimerLo = 0;
        cpu.ciaTimerHi = 0;
        cpu.ciaTimerWritten = false;

        cpu.totalSidWrites = 0;
        cpu.totalZpWrites = 0;
        cpu.recordWrites = false;
        cpu.trackingEnabled = false;
        cpu.halted = false;
        cpu.instructionPC = 0;
        cpu.lastExecutionCycles = 0;

        memset(cpu.memory, 0, sizeof(cpu.memory));
        // The processor port as the KERNAL leaves it: I/O mapped in, so SID
        // and CIA writes are seen as such until the code banks it out.
        cpu.memory[0x00] = 0x2F;
        cpu.memory[0x01] = 0x37;
        memset(cpu.memoryAccess, 0, sizeof(cpu.memoryAccess));
        memset(cpu.sidWrites, 0, sizeof(cpu.sidWrites));
        memset(cpu.sidChipsUsed, 0, sizeof(cpu.sidChipsUsed));
        memset(cpu.zpWrites, 0, sizeof(cpu.zpWrites));
        memset(cpu.lastWritePC, 0, sizeof(cpu.lastWritePC));

        cpu.writeSequence.clear();
    }

    // Enable or disable tracking
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

    // Instruction-driven write: this is the path that records access info.
    void write_memory_internal(uint16_t address, uint8_t value) {
        cpu.memory[address] = value;
        c64io::write(cpu.memory, address, value);

        // Only track if tracking is enabled
        if (cpu.trackingEnabled) {
            cpu.memoryAccess[address] |= MEM_WRITE;
            cpu.lastWritePC[address] = cpu.instructionPC;

            // Track zero page writes
            if (address < 256) {
                cpu.zpWrites[address]++;
                cpu.totalZpWrites++;
            }

            // I/O is only there when the processor port maps it in; otherwise
            // a write here is to RAM.
            if (c64io::io_visible(cpu.memory[0x01])) {
                // Track SID writes (full SID range $D400-$D7FF)
                if (address >= 0xD400 && address <= 0xD7FF) {
                    uint8_t reg = address & 0x1F;
                    cpu.sidWrites[reg]++;
                    cpu.totalSidWrites++;

                    // Track which SID chip is being used (each chip is $20 bytes)
                    uint8_t sidChipIndex = (address - 0xD400) >> 5;  // Divide by 32
                    cpu.sidChipsUsed[sidChipIndex] = true;

                    if (cpu.recordWrites) {
                        cpu.writeSequence.push_back(address);
                    }
                }
                else if (address >= 0xDE00 && address <= 0xDFFF) {
                    cpu.sidChipsUsed[32 + ((address - 0xDE00) >> 5)] = true;
                }

                // Track CIA 1 timer A writes, through the register mirrors too: CIA 1
                // repeats every 16 bytes across $DC00-$DCFF.
                if ((address & 0xFF0F) == 0xDC04) {
                    cpu.ciaTimerLo = value;
                    cpu.ciaTimerWritten = true;
                }
                else if ((address & 0xFF0F) == 0xDC05) {
                    cpu.ciaTimerHi = value;
                    cpu.ciaTimerWritten = true;
                }
            }
        }
    }

    void cpu_step();

    // === Bus adapter ============================================================
    // Binds the shared decoder in cpu6510_core.h to this core's memory and its
    // access tracking. Instruction-stream fetches deliberately bypass tracking:
    // they are covered by MEM_EXECUTE/MEM_OPCODE instead.
    struct AnalysisBus {
        uint16_t& pc;
        uint8_t& sp;
        uint8_t& a;
        uint8_t& x;
        uint8_t& y;
        uint8_t& st;

        uint8_t fetch(uint16_t addr) { return cpu.memory[addr]; }
        uint8_t read(uint16_t addr) {
            if (cpu.trackingEnabled) cpu.memoryAccess[addr] |= MEM_READ;
            uint8_t io;
            if (c64io::read(addr, cpu.memory, cpu.cycles, io)) return io;
            return cpu.memory[addr];
        }
        void write(uint16_t addr, uint8_t value) { write_memory_internal(addr, value); }
        // The analyser models no write-sensitive I/O, and counting the RMW
        // write-back would double every INC/DEC/shift in the write tracking.
        void dummyWrite(uint16_t, uint8_t) {}
        void jumpTarget(uint16_t addr) {
            if (cpu.trackingEnabled) cpu.memoryAccess[addr] |= MEM_JUMP_TARGET;
        }
        void jam() { cpu.halted = true; }

        // For c64env::call.
        int step() {
            const uint64_t before = cpu.cycles;
            cpu_step();
            return (int)(cpu.cycles - before);
        }
        bool jammed() const { return cpu.halted; }
        void clearJam() { cpu.halted = false; }
    };

    // Execute one instruction
    EMSCRIPTEN_KEEPALIVE
        void cpu_step() {
        if (cpu.trackingEnabled) {
            // The whole instruction is code; MEM_OPCODE marks where it starts.
            cpu.memoryAccess[cpu.pc] |= MEM_EXECUTE | MEM_OPCODE;
            for (uint8_t i = 1; i < opcodeTable[cpu.memory[cpu.pc]].size; i++) {
                cpu.memoryAccess[(uint16_t)(cpu.pc + i)] |= MEM_EXECUTE;
            }
        }
        // Writes are attributed to the instruction that made them, not to
        // wherever the PC has reached by the time the store happens.
        cpu.instructionPC = cpu.pc;

        AnalysisBus bus{ cpu.pc, cpu.sp, cpu.a, cpu.x, cpu.y, cpu.status };
        cpu.cycles += cpu6510::step(bus);
    }


    // Run a subroutine until its matching RTS, or maxCycles is exceeded (see
    // c64env::call). Returns 1 if it returned; lastExecutionCycles is then its
    // cycle count, else 0.
    EMSCRIPTEN_KEEPALIVE
        int cpu_execute_function(uint16_t address, uint32_t maxCycles) {
        AnalysisBus bus{ cpu.pc, cpu.sp, cpu.a, cpu.x, cpu.y, cpu.status };
        const c64env::CallResult r = c64env::call(bus, address, maxCycles);
        cpu.lastExecutionCycles = r.returned ? r.cycles : 0;
        return r.returned ? 1 : 0;
    }

    // Run an interrupt handler until the RTI that ends it, or maxCycles is
    // exceeded. kernalEntry: the handler was reached through the KERNAL's $FF48
    // entry, which pushed A, X and Y; a handler leaving through JMP $EA31 /
    // $EA81 pulls them back.
    EMSCRIPTEN_KEEPALIVE
        int cpu_execute_interrupt(uint16_t address, uint32_t maxCycles, bool kernalEntry) {
        AnalysisBus bus{ cpu.pc, cpu.sp, cpu.a, cpu.x, cpu.y, cpu.status };
        const c64env::CallResult r = c64env::call(bus, address, maxCycles, true, kernalEntry);
        cpu.lastExecutionCycles = r.returned ? r.cycles : 0;
        return r.returned ? 1 : 0;
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

    // Get CPU state
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

    // Get memory access info
    EMSCRIPTEN_KEEPALIVE
        uint8_t cpu_get_memory_access(uint16_t address) {
        return cpu.memoryAccess[address];
    }

    // Get SID write statistics
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

    // Get the number of SID chips used (based on which $20-byte groups were written to)
    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_sid_chip_count() {
        uint32_t count = 0;
        for (int i = 0; i < 48; i++) {
            if (cpu.sidChipsUsed[i]) {
                count++;
            }
        }
        return count;
    }

    // Get the base address of the Nth SID chip used (0-indexed)
    // Returns 0 if index is out of range
    EMSCRIPTEN_KEEPALIVE
        uint16_t cpu_get_sid_chip_address(uint32_t index) {
        uint32_t count = 0;
        for (int i = 0; i < 48; i++) {
            if (cpu.sidChipsUsed[i]) {
                if (count == index) {
                    return i < 32 ? 0xD400 + (i * 0x20) : 0xDE00 + ((i - 32) * 0x20);
                }
                count++;
            }
        }
        return 0;
    }

    // Get zero page write statistics
    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_zp_writes(uint8_t addr) {
        return cpu.zpWrites[addr];
    }

    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_total_zp_writes() {
        return cpu.totalZpWrites;
    }

    // Enable/disable write sequence recording
    EMSCRIPTEN_KEEPALIVE
        void cpu_set_record_writes(bool record) {
        cpu.recordWrites = record;
        if (record) {
            cpu.writeSequence.clear();
        }
    }

    // Get write sequence length
    EMSCRIPTEN_KEEPALIVE
        uint32_t cpu_get_write_sequence_length() {
        return cpu.writeSequence.size();
    }

    // Get write sequence item
    EMSCRIPTEN_KEEPALIVE
        uint16_t cpu_get_write_sequence_item(uint32_t index) {
        if (index < cpu.writeSequence.size()) {
            return cpu.writeSequence[index];
        }
        return 0;
    }

    // Analyze memory for code vs data
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

    // Get last PC that wrote to an address
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
        cpu.pc = 0;
        cpu.sp = 0xFD;
        cpu.a = 0;
        cpu.x = 0;
        cpu.y = 0;
        cpu.status = FLAG_INTERRUPT | FLAG_UNUSED;
        cpu.cycles = 0;

        cpu.ciaTimerLo = 0;
        cpu.ciaTimerHi = 0;
        cpu.ciaTimerWritten = false;
        cpu.totalSidWrites = 0;
        cpu.totalZpWrites = 0;
        cpu.recordWrites = false;
        cpu.halted = false;
        cpu.instructionPC = 0;
        cpu.lastExecutionCycles = 0;

        memset(cpu.memoryAccess, 0, sizeof(cpu.memoryAccess));
        memset(cpu.sidWrites, 0, sizeof(cpu.sidWrites));
        memset(cpu.sidChipsUsed, 0, sizeof(cpu.sidChipsUsed));
        memset(cpu.zpWrites, 0, sizeof(cpu.zpWrites));
        memset(cpu.lastWritePC, 0, sizeof(cpu.lastWritePC));
        cpu.writeSequence.clear();
    }

} // extern "C"