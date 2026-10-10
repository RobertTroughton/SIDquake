// cpu6510_api.h - the analysis core's C API (cpu6510_wasm.cpp), exported to JS
// and called by sid_processor.cpp. Declared once here, and included by the file
// that defines it, so a signature that drifts fails to compile instead of
// linking against the wrong one.

#pragma once

#include <cstddef>
#include <cstdint>

extern "C" {

void cpu_init();
void cpu_reset_state_only();
void cpu_set_tracking(bool enabled);
void cpu_setup_c64_env();

void cpu_load_memory(uint16_t address, uint8_t* data, uint16_t size);
uint8_t cpu_read_memory(uint16_t address);
void cpu_write_memory(uint16_t address, uint8_t value);
void cpu_save_memory(uint8_t* buffer);
void cpu_restore_memory(uint8_t* buffer);

void cpu_step();
int cpu_execute_function(uint16_t address, uint32_t maxCycles);
int cpu_execute_interrupt(uint16_t address, uint32_t maxCycles, bool kernalEntry);
uint32_t cpu_get_irq_handler();

uint16_t cpu_get_pc();
void cpu_set_pc(uint16_t pc);
uint8_t cpu_get_sp();
uint8_t cpu_get_a();
uint8_t cpu_get_x();
uint8_t cpu_get_y();
void cpu_set_accumulator(uint8_t value);
void cpu_set_xreg(uint8_t value);
void cpu_set_yreg(uint8_t value);
uint64_t cpu_get_cycles();
uint32_t cpu_get_last_execution_cycles();

uint8_t cpu_get_cia_timer_lo();
uint8_t cpu_get_cia_timer_hi();
bool cpu_get_cia_timer_written();

uint8_t cpu_get_memory_access(uint16_t address);
uint16_t cpu_get_last_write_pc(uint16_t address);
void cpu_analyze_memory(uint16_t startAddr, uint16_t endAddr, uint32_t* codeBytes, uint32_t* dataBytes);
uint32_t cpu_get_sid_writes(uint8_t reg);
uint32_t cpu_get_total_sid_writes();
bool cpu_get_sid_chip_used(uint32_t slot);
void cpu_reset_sid_chip_usage();
uint32_t cpu_get_sid_chip_count();
uint16_t cpu_get_sid_chip_address(uint32_t index);
uint32_t cpu_get_zp_writes(uint8_t addr);
uint32_t cpu_get_total_zp_writes();
void cpu_set_record_writes(bool record);
uint32_t cpu_get_write_sequence_length();
uint16_t cpu_get_write_sequence_item(uint32_t index);

uint8_t* allocate_memory(size_t size);
void free_memory(uint8_t* ptr);

}
