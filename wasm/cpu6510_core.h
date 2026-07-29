// cpu6510_core.h - the 6510 instruction set, once.
//
// Both cores in this repo (cpu6510_wasm.cpp for offline analysis,
// sid_audio.cpp for reSID playback) execute the same 6510; they differ only in
// how memory is reached and what gets recorded on the way. That difference is
// the Bus template parameter, so the decoder itself exists in one place.
//
// A Bus supplies the register file by reference plus five operations:
//
//   uint16_t& pc;  uint8_t& sp, a, x, y, st;   // live registers
//   uint8_t fetch(uint16_t addr)               // instruction stream read
//   uint8_t read(uint16_t addr)                // data read
//   void    write(uint16_t addr, uint8_t val)  // data write
//   void    jumpTarget(uint16_t addr)          // JMP/JSR destination
//   void    jam()                              // a KIL opcode executed
//
// fetch() is kept separate from read() because the analysis core records data
// reads but covers the instruction stream with its execute flags instead, and
// because the audio core routes read()/write() through the SID chips while
// instructions are always plain RAM.
//
// step() runs one instruction and returns its cycle count, page-crossing and
// branch-taken penalties included.

#pragma once

#include <cstdint>
#include <cstdio>
#include <set>
#include "opcodes.h"

namespace cpu6510 {

enum Flag : uint8_t {
    FLAG_C = 0x01, FLAG_Z = 0x02, FLAG_I = 0x04, FLAG_D = 0x08,
    FLAG_B = 0x10, FLAG_U = 0x20, FLAG_V = 0x40, FLAG_N = 0x80
};

template <class Bus>
struct Core {
    Bus& b;
    // Whether the last indexed addressing mode crossed a page, and the address
    // it indexed from. Reads pay a cycle for a crossing, writes and
    // read-modify-writes do not, and the unstable stores need the base.
    bool crossed = false;
    uint16_t indexBase = 0;

    explicit Core(Bus& bus) : b(bus) {}

    // --- operand and address fetch -----------------------------------------
    uint8_t fetch() { return b.fetch(b.pc++); }
    uint16_t fetch16() { uint8_t lo = fetch(); uint8_t hi = fetch(); return uint16_t(lo | (hi << 8)); }

    uint16_t ea_zp() { return fetch(); }
    uint16_t ea_zpx() { return uint8_t(fetch() + b.x); }
    uint16_t ea_zpy() { return uint8_t(fetch() + b.y); }
    uint16_t ea_abs() { return fetch16(); }
    uint16_t ea_indexed(uint16_t base, uint8_t index) {
        indexBase = base;
        uint16_t addr = uint16_t(base + index);
        crossed = ((base ^ addr) & 0xFF00) != 0;
        return addr;
    }
    uint16_t ea_absx() { return ea_indexed(fetch16(), b.x); }
    uint16_t ea_absy() { return ea_indexed(fetch16(), b.y); }
    uint16_t ea_indx() {
        uint8_t z = uint8_t(fetch() + b.x);
        return uint16_t(b.read(z) | (b.read(uint8_t(z + 1)) << 8));
    }
    uint16_t ea_indy() {
        uint8_t z = fetch();
        uint16_t ptr = uint16_t(b.read(z) | (b.read(uint8_t(z + 1)) << 8));
        return ea_indexed(ptr, b.y);
    }

    // --- flags --------------------------------------------------------------
    void setFlag(uint8_t f, bool on) { if (on) b.st |= f; else b.st &= uint8_t(~f); }
    bool testFlag(uint8_t f) const { return (b.st & f) != 0; }
    void setZN(uint8_t v) { setFlag(FLAG_Z, v == 0); setFlag(FLAG_N, (v & 0x80) != 0); }

    // --- stack --------------------------------------------------------------
    void push(uint8_t v) { b.write(uint16_t(0x0100 + b.sp), v); b.sp--; }
    uint8_t pull() { b.sp++; return b.read(uint16_t(0x0100 + b.sp)); }

    // --- arithmetic ---------------------------------------------------------
    void do_cmp(uint8_t reg, uint8_t v) {
        setFlag(FLAG_C, reg >= v);
        setZN(uint8_t(reg - v));
    }

    void do_adc(uint8_t v) {
        uint16_t carry = testFlag(FLAG_C) ? 1 : 0;
        if (testFlag(FLAG_D)) {
            // NMOS 6502 BCD add. Z comes from the binary result; N and V are
            // taken from the intermediate sum before the high-nibble fixup.
            int al = (b.a & 0x0F) + (v & 0x0F) + carry;
            if (al >= 0x0A) al = ((al + 0x06) & 0x0F) + 0x10;
            int a2 = (b.a & 0xF0) + (v & 0xF0) + al;
            setFlag(FLAG_Z, ((b.a + v + carry) & 0xFF) == 0);
            setFlag(FLAG_N, (a2 & 0x80) != 0);
            setFlag(FLAG_V, (~(b.a ^ v) & (b.a ^ a2) & 0x80) != 0);
            if (a2 >= 0xA0) a2 += 0x60;
            setFlag(FLAG_C, a2 >= 0x100);
            b.a = uint8_t(a2 & 0xFF);
        } else {
            uint16_t r = uint16_t(b.a) + v + carry;
            setFlag(FLAG_C, r > 0xFF);
            setFlag(FLAG_V, ((b.a ^ r) & (v ^ r) & 0x80) != 0);
            b.a = uint8_t(r);
            setZN(b.a);
        }
    }

    void do_sbc(uint8_t v) {
        uint16_t borrow = testFlag(FLAG_C) ? 0 : 1;
        uint16_t bin = uint16_t(uint16_t(b.a) - v - borrow);
        // NMOS 6502: SBC sets N, V, Z and C identically in binary and decimal
        // mode - only the accumulator result differs.
        setFlag(FLAG_C, bin < 0x100);
        setFlag(FLAG_V, ((b.a ^ bin) & (~v ^ bin) & 0x80) != 0);
        if (testFlag(FLAG_D)) {
            int al = (b.a & 0x0F) - (v & 0x0F) - int(borrow);
            if (al < 0) al = ((al - 0x06) & 0x0F) - 0x10;
            int a2 = (b.a & 0xF0) - (v & 0xF0) + al;
            if (a2 < 0) a2 -= 0x60;
            b.a = uint8_t(a2 & 0xFF);
        } else {
            b.a = uint8_t(bin);
        }
        setZN(uint8_t(bin));
    }

    // --- read-modify-write --------------------------------------------------
    uint8_t do_asl(uint8_t v) { setFlag(FLAG_C, (v & 0x80) != 0); v = uint8_t(v << 1); setZN(v); return v; }
    uint8_t do_lsr(uint8_t v) { setFlag(FLAG_C, (v & 0x01) != 0); v = uint8_t(v >> 1); setZN(v); return v; }
    uint8_t do_rol(uint8_t v) {
        bool c = testFlag(FLAG_C);
        setFlag(FLAG_C, (v & 0x80) != 0);
        v = uint8_t((v << 1) | (c ? 1 : 0));
        setZN(v);
        return v;
    }
    uint8_t do_ror(uint8_t v) {
        bool c = testFlag(FLAG_C);
        setFlag(FLAG_C, (v & 0x01) != 0);
        v = uint8_t((v >> 1) | (c ? 0x80 : 0));
        setZN(v);
        return v;
    }
    void rmw_asl(uint16_t a) { b.write(a, do_asl(b.read(a))); }
    void rmw_lsr(uint16_t a) { b.write(a, do_lsr(b.read(a))); }
    void rmw_rol(uint16_t a) { b.write(a, do_rol(b.read(a))); }
    void rmw_ror(uint16_t a) { b.write(a, do_ror(b.read(a))); }

    void do_lax(uint8_t v) { b.a = v; b.x = v; setZN(v); }

    // SHA/SHX/SHY/TAS store reg ANDed with the high byte of the *pre-index*
    // address plus one, and when the index crosses a page the value being
    // stored replaces the target's high byte.
    void do_unstable_store(uint16_t base, uint8_t index, uint8_t reg) {
        uint16_t addr = uint16_t(base + index);
        uint8_t v = reg & uint8_t((base >> 8) + 1);
        if ((base & 0xFF00) != (addr & 0xFF00)) addr = uint16_t((v << 8) | (addr & 0xFF));
        b.write(addr, v);
    }

    // Branch: 2 cycles not taken, 3 taken, 4 if the target is in another page.
    int branch(bool cond) {
        int8_t off = int8_t(fetch());
        if (!cond) return 2;
        uint16_t from = b.pc;
        b.pc = uint16_t(from + off);
        return ((from ^ b.pc) & 0xFF00) ? 4 : 3;
    }

    // Reads through an indexed mode pay a cycle for a page crossing; writes and
    // read-modify-writes always take their fixed count.
    int rd_cycles(int base) const { return base + (crossed ? 1 : 0); }

    int step();
};

template <class Bus>
int Core<Bus>::step() {
    const uint8_t op = fetch();

    switch (op) {
    // ---- LDA ----
    case 0xA9: b.a = fetch();               setZN(b.a); return 2;
    case 0xA5: b.a = b.read(ea_zp());       setZN(b.a); return 3;
    case 0xB5: b.a = b.read(ea_zpx());      setZN(b.a); return 4;
    case 0xAD: b.a = b.read(ea_abs());      setZN(b.a); return 4;
    case 0xBD: b.a = b.read(ea_absx());     setZN(b.a); return rd_cycles(4);
    case 0xB9: b.a = b.read(ea_absy());     setZN(b.a); return rd_cycles(4);
    case 0xA1: b.a = b.read(ea_indx());     setZN(b.a); return 6;
    case 0xB1: b.a = b.read(ea_indy());     setZN(b.a); return rd_cycles(5);

    // ---- LDX ----
    case 0xA2: b.x = fetch();               setZN(b.x); return 2;
    case 0xA6: b.x = b.read(ea_zp());       setZN(b.x); return 3;
    case 0xB6: b.x = b.read(ea_zpy());      setZN(b.x); return 4;
    case 0xAE: b.x = b.read(ea_abs());      setZN(b.x); return 4;
    case 0xBE: b.x = b.read(ea_absy());     setZN(b.x); return rd_cycles(4);

    // ---- LDY ----
    case 0xA0: b.y = fetch();               setZN(b.y); return 2;
    case 0xA4: b.y = b.read(ea_zp());       setZN(b.y); return 3;
    case 0xB4: b.y = b.read(ea_zpx());      setZN(b.y); return 4;
    case 0xAC: b.y = b.read(ea_abs());      setZN(b.y); return 4;
    case 0xBC: b.y = b.read(ea_absx());     setZN(b.y); return rd_cycles(4);

    // ---- STA / STX / STY ----
    case 0x85: b.write(ea_zp(),   b.a); return 3;
    case 0x95: b.write(ea_zpx(),  b.a); return 4;
    case 0x8D: b.write(ea_abs(),  b.a); return 4;
    case 0x9D: b.write(ea_absx(), b.a); return 5;
    case 0x99: b.write(ea_absy(), b.a); return 5;
    case 0x81: b.write(ea_indx(), b.a); return 6;
    case 0x91: b.write(ea_indy(), b.a); return 6;
    case 0x86: b.write(ea_zp(),   b.x); return 3;
    case 0x96: b.write(ea_zpy(),  b.x); return 4;
    case 0x8E: b.write(ea_abs(),  b.x); return 4;
    case 0x84: b.write(ea_zp(),   b.y); return 3;
    case 0x94: b.write(ea_zpx(),  b.y); return 4;
    case 0x8C: b.write(ea_abs(),  b.y); return 4;

    // ---- transfers ----
    case 0xAA: b.x = b.a;  setZN(b.x); return 2;  // TAX
    case 0xA8: b.y = b.a;  setZN(b.y); return 2;  // TAY
    case 0x8A: b.a = b.x;  setZN(b.a); return 2;  // TXA
    case 0x98: b.a = b.y;  setZN(b.a); return 2;  // TYA
    case 0xBA: b.x = b.sp; setZN(b.x); return 2;  // TSX
    case 0x9A: b.sp = b.x;             return 2;  // TXS

    // ---- AND / ORA / EOR ----
    case 0x29: b.a &= fetch();           setZN(b.a); return 2;
    case 0x25: b.a &= b.read(ea_zp());   setZN(b.a); return 3;
    case 0x35: b.a &= b.read(ea_zpx());  setZN(b.a); return 4;
    case 0x2D: b.a &= b.read(ea_abs());  setZN(b.a); return 4;
    case 0x3D: b.a &= b.read(ea_absx()); setZN(b.a); return rd_cycles(4);
    case 0x39: b.a &= b.read(ea_absy()); setZN(b.a); return rd_cycles(4);
    case 0x21: b.a &= b.read(ea_indx()); setZN(b.a); return 6;
    case 0x31: b.a &= b.read(ea_indy()); setZN(b.a); return rd_cycles(5);

    case 0x09: b.a |= fetch();           setZN(b.a); return 2;
    case 0x05: b.a |= b.read(ea_zp());   setZN(b.a); return 3;
    case 0x15: b.a |= b.read(ea_zpx());  setZN(b.a); return 4;
    case 0x0D: b.a |= b.read(ea_abs());  setZN(b.a); return 4;
    case 0x1D: b.a |= b.read(ea_absx()); setZN(b.a); return rd_cycles(4);
    case 0x19: b.a |= b.read(ea_absy()); setZN(b.a); return rd_cycles(4);
    case 0x01: b.a |= b.read(ea_indx()); setZN(b.a); return 6;
    case 0x11: b.a |= b.read(ea_indy()); setZN(b.a); return rd_cycles(5);

    case 0x49: b.a ^= fetch();           setZN(b.a); return 2;
    case 0x45: b.a ^= b.read(ea_zp());   setZN(b.a); return 3;
    case 0x55: b.a ^= b.read(ea_zpx());  setZN(b.a); return 4;
    case 0x4D: b.a ^= b.read(ea_abs());  setZN(b.a); return 4;
    case 0x5D: b.a ^= b.read(ea_absx()); setZN(b.a); return rd_cycles(4);
    case 0x59: b.a ^= b.read(ea_absy()); setZN(b.a); return rd_cycles(4);
    case 0x41: b.a ^= b.read(ea_indx()); setZN(b.a); return 6;
    case 0x51: b.a ^= b.read(ea_indy()); setZN(b.a); return rd_cycles(5);

    // ---- ADC / SBC ----
    case 0x69: do_adc(fetch());           return 2;
    case 0x65: do_adc(b.read(ea_zp()));   return 3;
    case 0x75: do_adc(b.read(ea_zpx()));  return 4;
    case 0x6D: do_adc(b.read(ea_abs()));  return 4;
    case 0x7D: do_adc(b.read(ea_absx())); return rd_cycles(4);
    case 0x79: do_adc(b.read(ea_absy())); return rd_cycles(4);
    case 0x61: do_adc(b.read(ea_indx())); return 6;
    case 0x71: do_adc(b.read(ea_indy())); return rd_cycles(5);

    case 0xE9:
    case 0xEB: do_sbc(fetch());           return 2;  // $EB is the illegal alias
    case 0xE5: do_sbc(b.read(ea_zp()));   return 3;
    case 0xF5: do_sbc(b.read(ea_zpx()));  return 4;
    case 0xED: do_sbc(b.read(ea_abs()));  return 4;
    case 0xFD: do_sbc(b.read(ea_absx())); return rd_cycles(4);
    case 0xF9: do_sbc(b.read(ea_absy())); return rd_cycles(4);
    case 0xE1: do_sbc(b.read(ea_indx())); return 6;
    case 0xF1: do_sbc(b.read(ea_indy())); return rd_cycles(5);

    // ---- CMP / CPX / CPY ----
    case 0xC9: do_cmp(b.a, fetch());           return 2;
    case 0xC5: do_cmp(b.a, b.read(ea_zp()));   return 3;
    case 0xD5: do_cmp(b.a, b.read(ea_zpx()));  return 4;
    case 0xCD: do_cmp(b.a, b.read(ea_abs()));  return 4;
    case 0xDD: do_cmp(b.a, b.read(ea_absx())); return rd_cycles(4);
    case 0xD9: do_cmp(b.a, b.read(ea_absy())); return rd_cycles(4);
    case 0xC1: do_cmp(b.a, b.read(ea_indx())); return 6;
    case 0xD1: do_cmp(b.a, b.read(ea_indy())); return rd_cycles(5);
    case 0xE0: do_cmp(b.x, fetch());           return 2;
    case 0xE4: do_cmp(b.x, b.read(ea_zp()));   return 3;
    case 0xEC: do_cmp(b.x, b.read(ea_abs()));  return 4;
    case 0xC0: do_cmp(b.y, fetch());           return 2;
    case 0xC4: do_cmp(b.y, b.read(ea_zp()));   return 3;
    case 0xCC: do_cmp(b.y, b.read(ea_abs()));  return 4;

    // ---- BIT ----
    case 0x24:
    case 0x2C: {
        uint8_t v = b.read(op == 0x24 ? ea_zp() : ea_abs());
        setFlag(FLAG_Z, (b.a & v) == 0);
        setFlag(FLAG_N, (v & 0x80) != 0);
        setFlag(FLAG_V, (v & 0x40) != 0);
        return op == 0x24 ? 3 : 4;
    }

    // ---- INC / DEC memory ----
    case 0xE6: { uint16_t a = ea_zp();   uint8_t v = uint8_t(b.read(a) + 1); b.write(a, v); setZN(v); return 5; }
    case 0xF6: { uint16_t a = ea_zpx();  uint8_t v = uint8_t(b.read(a) + 1); b.write(a, v); setZN(v); return 6; }
    case 0xEE: { uint16_t a = ea_abs();  uint8_t v = uint8_t(b.read(a) + 1); b.write(a, v); setZN(v); return 6; }
    case 0xFE: { uint16_t a = ea_absx(); uint8_t v = uint8_t(b.read(a) + 1); b.write(a, v); setZN(v); return 7; }
    case 0xC6: { uint16_t a = ea_zp();   uint8_t v = uint8_t(b.read(a) - 1); b.write(a, v); setZN(v); return 5; }
    case 0xD6: { uint16_t a = ea_zpx();  uint8_t v = uint8_t(b.read(a) - 1); b.write(a, v); setZN(v); return 6; }
    case 0xCE: { uint16_t a = ea_abs();  uint8_t v = uint8_t(b.read(a) - 1); b.write(a, v); setZN(v); return 6; }
    case 0xDE: { uint16_t a = ea_absx(); uint8_t v = uint8_t(b.read(a) - 1); b.write(a, v); setZN(v); return 7; }

    // ---- INX / INY / DEX / DEY ----
    case 0xE8: b.x++; setZN(b.x); return 2;
    case 0xC8: b.y++; setZN(b.y); return 2;
    case 0xCA: b.x--; setZN(b.x); return 2;
    case 0x88: b.y--; setZN(b.y); return 2;

    // ---- shifts and rotates ----
    case 0x0A: b.a = do_asl(b.a); return 2;
    case 0x06: rmw_asl(ea_zp());   return 5;
    case 0x16: rmw_asl(ea_zpx());  return 6;
    case 0x0E: rmw_asl(ea_abs());  return 6;
    case 0x1E: rmw_asl(ea_absx()); return 7;
    case 0x4A: b.a = do_lsr(b.a); return 2;
    case 0x46: rmw_lsr(ea_zp());   return 5;
    case 0x56: rmw_lsr(ea_zpx());  return 6;
    case 0x4E: rmw_lsr(ea_abs());  return 6;
    case 0x5E: rmw_lsr(ea_absx()); return 7;
    case 0x2A: b.a = do_rol(b.a); return 2;
    case 0x26: rmw_rol(ea_zp());   return 5;
    case 0x36: rmw_rol(ea_zpx());  return 6;
    case 0x2E: rmw_rol(ea_abs());  return 6;
    case 0x3E: rmw_rol(ea_absx()); return 7;
    case 0x6A: b.a = do_ror(b.a); return 2;
    case 0x66: rmw_ror(ea_zp());   return 5;
    case 0x76: rmw_ror(ea_zpx());  return 6;
    case 0x6E: rmw_ror(ea_abs());  return 6;
    case 0x7E: rmw_ror(ea_absx()); return 7;

    // ---- branches ----
    case 0x10: return branch(!testFlag(FLAG_N));  // BPL
    case 0x30: return branch(testFlag(FLAG_N));   // BMI
    case 0x50: return branch(!testFlag(FLAG_V));  // BVC
    case 0x70: return branch(testFlag(FLAG_V));   // BVS
    case 0x90: return branch(!testFlag(FLAG_C));  // BCC
    case 0xB0: return branch(testFlag(FLAG_C));   // BCS
    case 0xD0: return branch(!testFlag(FLAG_Z));  // BNE
    case 0xF0: return branch(testFlag(FLAG_Z));   // BEQ

    // ---- jumps and returns ----
    case 0x4C: { uint16_t a = ea_abs(); b.pc = a; b.jumpTarget(a); return 3; }
    case 0x6C: {
        uint16_t ptr = ea_abs();
        // 6502 JMP indirect bug: when the low byte is $FF the high byte is
        // fetched from the same page ($xx00) instead of crossing into the next.
        uint16_t hiAddr = (ptr & 0xFF) == 0xFF ? uint16_t(ptr & 0xFF00) : uint16_t(ptr + 1);
        uint16_t a = uint16_t(b.read(ptr) | (b.read(hiAddr) << 8));
        b.pc = a;
        b.jumpTarget(a);
        return 5;
    }
    case 0x20: {
        uint16_t a = ea_abs();
        uint16_t ret = uint16_t(b.pc - 1);
        push(uint8_t(ret >> 8));
        push(uint8_t(ret & 0xFF));
        b.pc = a;
        b.jumpTarget(a);
        return 6;
    }
    case 0x60: { uint8_t lo = pull(); uint8_t hi = pull(); b.pc = uint16_t((lo | (hi << 8)) + 1); return 6; }
    case 0x40: {
        b.st = uint8_t(pull() | FLAG_U);
        uint8_t lo = pull();
        uint8_t hi = pull();
        b.pc = uint16_t(lo | (hi << 8));
        return 6;
    }

    // ---- stack ----
    case 0x48: push(b.a); return 3;                              // PHA
    case 0x08: push(uint8_t(b.st | FLAG_B | FLAG_U)); return 3;  // PHP
    case 0x68: b.a = pull(); setZN(b.a); return 4;               // PLA
    case 0x28: b.st = uint8_t(pull() | FLAG_U); return 4;        // PLP

    // ---- flags ----
    case 0x18: setFlag(FLAG_C, false); return 2;
    case 0x38: setFlag(FLAG_C, true);  return 2;
    case 0x58: setFlag(FLAG_I, false); return 2;
    case 0x78: setFlag(FLAG_I, true);  return 2;
    case 0xD8: setFlag(FLAG_D, false); return 2;
    case 0xF8: setFlag(FLAG_D, true);  return 2;
    case 0xB8: setFlag(FLAG_V, false); return 2;

    case 0xEA: return 2;  // NOP

    case 0x00: {  // BRK
        b.pc++;
        push(uint8_t(b.pc >> 8));
        push(uint8_t(b.pc & 0xFF));
        push(uint8_t(b.st | FLAG_B | FLAG_U));
        setFlag(FLAG_I, true);
        b.pc = uint16_t(b.read(0xFFFE) | (b.read(0xFFFF) << 8));
        return 7;
    }

    // ==== illegal opcodes ===================================================

    // LAX - LDA + LDX
    case 0xA7: do_lax(b.read(ea_zp()));   return 3;
    case 0xB7: do_lax(b.read(ea_zpy()));  return 4;
    case 0xAF: do_lax(b.read(ea_abs()));  return 4;
    case 0xBF: do_lax(b.read(ea_absy())); return rd_cycles(4);
    case 0xA3: do_lax(b.read(ea_indx())); return 6;
    case 0xB3: do_lax(b.read(ea_indy())); return rd_cycles(5);

    // SAX - store A & X
    case 0x87: b.write(ea_zp(),   uint8_t(b.a & b.x)); return 3;
    case 0x97: b.write(ea_zpy(),  uint8_t(b.a & b.x)); return 4;
    case 0x8F: b.write(ea_abs(),  uint8_t(b.a & b.x)); return 4;
    case 0x83: b.write(ea_indx(), uint8_t(b.a & b.x)); return 6;

    // DCP - DEC + CMP
    case 0xC7: case 0xD7: case 0xCF: case 0xDF: case 0xDB: case 0xC3: case 0xD3: {
        uint16_t a; int cyc;
        switch (op) {
        case 0xC7: a = ea_zp();   cyc = 5; break;
        case 0xD7: a = ea_zpx();  cyc = 6; break;
        case 0xCF: a = ea_abs();  cyc = 6; break;
        case 0xDF: a = ea_absx(); cyc = 7; break;
        case 0xDB: a = ea_absy(); cyc = 7; break;
        case 0xC3: a = ea_indx(); cyc = 8; break;
        default:   a = ea_indy(); cyc = 8; break;
        }
        uint8_t v = uint8_t(b.read(a) - 1);
        b.write(a, v);
        do_cmp(b.a, v);
        return cyc;
    }

    // ISC (ISB) - INC + SBC
    case 0xE7: case 0xF7: case 0xEF: case 0xFF: case 0xFB: case 0xE3: case 0xF3: {
        uint16_t a; int cyc;
        switch (op) {
        case 0xE7: a = ea_zp();   cyc = 5; break;
        case 0xF7: a = ea_zpx();  cyc = 6; break;
        case 0xEF: a = ea_abs();  cyc = 6; break;
        case 0xFF: a = ea_absx(); cyc = 7; break;
        case 0xFB: a = ea_absy(); cyc = 7; break;
        case 0xE3: a = ea_indx(); cyc = 8; break;
        default:   a = ea_indy(); cyc = 8; break;
        }
        uint8_t v = uint8_t(b.read(a) + 1);
        b.write(a, v);
        do_sbc(v);
        return cyc;
    }

    // SLO - ASL + ORA
    case 0x07: case 0x17: case 0x0F: case 0x1F: case 0x1B: case 0x03: case 0x13: {
        uint16_t a; int cyc;
        switch (op) {
        case 0x07: a = ea_zp();   cyc = 5; break;
        case 0x17: a = ea_zpx();  cyc = 6; break;
        case 0x0F: a = ea_abs();  cyc = 6; break;
        case 0x1F: a = ea_absx(); cyc = 7; break;
        case 0x1B: a = ea_absy(); cyc = 7; break;
        case 0x03: a = ea_indx(); cyc = 8; break;
        default:   a = ea_indy(); cyc = 8; break;
        }
        uint8_t v = b.read(a);
        setFlag(FLAG_C, (v & 0x80) != 0);
        v = uint8_t(v << 1);
        b.write(a, v);
        b.a |= v;
        setZN(b.a);
        return cyc;
    }

    // RLA - ROL + AND
    case 0x27: case 0x37: case 0x2F: case 0x3F: case 0x3B: case 0x23: case 0x33: {
        uint16_t a; int cyc;
        switch (op) {
        case 0x27: a = ea_zp();   cyc = 5; break;
        case 0x37: a = ea_zpx();  cyc = 6; break;
        case 0x2F: a = ea_abs();  cyc = 6; break;
        case 0x3F: a = ea_absx(); cyc = 7; break;
        case 0x3B: a = ea_absy(); cyc = 7; break;
        case 0x23: a = ea_indx(); cyc = 8; break;
        default:   a = ea_indy(); cyc = 8; break;
        }
        uint8_t v = b.read(a);
        bool c = testFlag(FLAG_C);
        setFlag(FLAG_C, (v & 0x80) != 0);
        v = uint8_t((v << 1) | (c ? 1 : 0));
        b.write(a, v);
        b.a &= v;
        setZN(b.a);
        return cyc;
    }

    // SRE - LSR + EOR
    case 0x47: case 0x57: case 0x4F: case 0x5F: case 0x5B: case 0x43: case 0x53: {
        uint16_t a; int cyc;
        switch (op) {
        case 0x47: a = ea_zp();   cyc = 5; break;
        case 0x57: a = ea_zpx();  cyc = 6; break;
        case 0x4F: a = ea_abs();  cyc = 6; break;
        case 0x5F: a = ea_absx(); cyc = 7; break;
        case 0x5B: a = ea_absy(); cyc = 7; break;
        case 0x43: a = ea_indx(); cyc = 8; break;
        default:   a = ea_indy(); cyc = 8; break;
        }
        uint8_t v = b.read(a);
        setFlag(FLAG_C, (v & 1) != 0);
        v = uint8_t(v >> 1);
        b.write(a, v);
        b.a ^= v;
        setZN(b.a);
        return cyc;
    }

    // RRA - ROR + ADC
    case 0x67: case 0x77: case 0x6F: case 0x7F: case 0x7B: case 0x63: case 0x73: {
        uint16_t a; int cyc;
        switch (op) {
        case 0x67: a = ea_zp();   cyc = 5; break;
        case 0x77: a = ea_zpx();  cyc = 6; break;
        case 0x6F: a = ea_abs();  cyc = 6; break;
        case 0x7F: a = ea_absx(); cyc = 7; break;
        case 0x7B: a = ea_absy(); cyc = 7; break;
        case 0x63: a = ea_indx(); cyc = 8; break;
        default:   a = ea_indy(); cyc = 8; break;
        }
        uint8_t v = b.read(a);
        bool c = testFlag(FLAG_C);
        setFlag(FLAG_C, (v & 1) != 0);
        v = uint8_t((v >> 1) | (c ? 0x80 : 0));
        b.write(a, v);
        do_adc(v);
        return cyc;
    }

    // ANC - AND #imm, then carry from bit 7 of the result
    case 0x0B: case 0x2B:
        b.a &= fetch();
        setZN(b.a);
        setFlag(FLAG_C, (b.a & 0x80) != 0);
        return 2;

    // ALR - AND #imm then LSR A
    case 0x4B:
        b.a &= fetch();
        setFlag(FLAG_C, (b.a & 1) != 0);
        b.a = uint8_t(b.a >> 1);
        setZN(b.a);
        return 2;

    // ARR - AND #imm then ROR A; C is bit 6 of the result, V bit 6 ^ bit 5.
    // Decimal mode is not modelled - see docs/CPU_CORES.md.
    case 0x6B: {
        uint8_t t = uint8_t(b.a & fetch());
        bool c = testFlag(FLAG_C);
        b.a = uint8_t((t >> 1) | (c ? 0x80 : 0));
        setZN(b.a);
        setFlag(FLAG_C, (b.a & 0x40) != 0);
        setFlag(FLAG_V, ((b.a ^ (b.a << 1)) & 0x40) != 0);
        return 2;
    }

    // AXS/SBX - X = (A & X) - imm
    case 0xCB: {
        uint8_t i = fetch();
        uint16_t r = uint16_t(uint16_t(b.a & b.x) - i);
        setFlag(FLAG_C, r < 0x100);
        b.x = uint8_t(r);
        setZN(b.x);
        return 2;
    }

    // LAX #imm (LXA/ATX): A = X = imm. Unstable on hardware; the common
    // emulated form just loads the immediate into both registers.
    case 0xAB: { uint8_t v = fetch(); b.a = v; b.x = v; setZN(v); return 2; }

    // XAA #imm (ANE): A = X & imm. Highly unstable on hardware.
    case 0x8B: b.a = uint8_t(b.x & fetch()); setZN(b.a); return 2;

    // SHA/SHX/SHY/TAS - see do_unstable_store.
    case 0x9F: { uint16_t base = fetch16(); do_unstable_store(base, b.y, uint8_t(b.a & b.x)); return 5; }
    case 0x93: {
        uint8_t z = fetch();
        uint16_t ptr = uint16_t(b.read(z) | (b.read(uint8_t(z + 1)) << 8));
        do_unstable_store(ptr, b.y, uint8_t(b.a & b.x));
        return 6;
    }
    case 0x9E: { uint16_t base = fetch16(); do_unstable_store(base, b.y, b.x); return 5; }
    case 0x9C: { uint16_t base = fetch16(); do_unstable_store(base, b.x, b.y); return 5; }
    case 0x9B: {
        uint16_t base = fetch16();
        b.sp = uint8_t(b.a & b.x);
        do_unstable_store(base, b.y, uint8_t(b.a & b.x));
        return 5;
    }

    // LAS/LAR - A = X = SP = mem & SP
    case 0xBB: {
        uint8_t v = uint8_t(b.read(ea_absy()) & b.sp);
        b.a = v; b.x = v; b.sp = v;
        setZN(v);
        return rd_cycles(4);
    }

    // KIL/JAM - the CPU stops. Back the PC up onto the opcode so a caller that
    // reports where it stopped points at the offending byte.
    case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
    case 0x62: case 0x72: case 0x92: case 0xB2: case 0xD2: case 0xF2:
        b.pc--;
        b.jam();
        return 2;

    // Illegal NOPs come in four forms with different sizes, cycle counts and
    // memory access; each is decoded separately so timing and read tracking
    // stay accurate.
    case 0x1A: case 0x3A: case 0x5A: case 0x7A: case 0xDA: case 0xFA:
        return 2;                                                    // implied
    case 0x80: case 0x82: case 0x89: case 0xC2: case 0xE2:
        fetch(); return 2;                                           // #imm
    case 0x04: case 0x44: case 0x64:
        b.read(ea_zp()); return 3;                                   // zp
    case 0x14: case 0x34: case 0x54: case 0x74: case 0xD4: case 0xF4:
        b.read(ea_zpx()); return 4;                                  // zp,X
    case 0x0C:
        b.read(ea_abs()); return 4;                                  // abs
    case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC:
        b.read(ea_absx()); return rd_cycles(4);                      // abs,X

    default: {
        // All 256 opcodes are handled above, so this is unreachable in
        // practice. Kept as a defensive fallback: log each opcode at most once
        // (never per-execution, which would cripple the analysis loop) and skip
        // past it using the opcode-size table.
        static std::set<uint8_t> unimplementedOpcodes;
        if (unimplementedOpcodes.find(op) == unimplementedOpcodes.end()) {
            unimplementedOpcodes.insert(op);
            printf("ERROR: Unimplemented opcode $%02X at PC=$%04X\n", op, b.pc - 1);
        }
        if (opcodeTable[op].size > 0) {
            b.pc = uint16_t(b.pc + opcodeTable[op].size - 1);
            return opcodeTable[op].cycles;
        }
        return 2;
    }
    }
}

// Run one instruction on `bus` and return its cycle count.
template <class Bus>
inline int step(Bus& bus) { return Core<Bus>(bus).step(); }

}  // namespace cpu6510
