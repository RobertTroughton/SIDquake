// cpu6510_core.h - the 6510 instruction set, once.
//
// Both cores in this repo (cpu6510_wasm.cpp for offline analysis,
// sid_audio.cpp for reSID playback) execute the same 6510; they differ only in
// how memory is reached and what gets recorded on the way. That difference is
// the Bus template parameter, so the decoder itself exists in one place.
//
// A Bus supplies the register file by reference plus six operations:
//
//   uint16_t& pc;  uint8_t& sp, a, x, y, st;   // live registers
//   uint8_t fetch(uint16_t addr)               // instruction stream read
//   uint8_t read(uint16_t addr)                // data read
//   void    write(uint16_t addr, uint8_t val)  // data write
//   void    dummyWrite(uint16_t addr, uint8_t val)  // RMW write-back, below
//   void    jumpTarget(uint16_t addr)          // JMP/JSR destination
//   void    jam()                              // a KIL opcode executed
//
// fetch() is kept separate from read() because the analysis core records data
// reads but covers the instruction stream with its execute flags instead, and
// because the audio core routes read()/write() through the SID chips while
// instructions are always plain RAM.
//
// Every read-modify-write instruction writes the unmodified value back before
// the modified one, as the NMOS 6502 does; dummyWrite() carries that first
// write, so a bus can pass it to I/O without counting it as a store.
//
// step() runs one instruction and returns its cycle count, page-crossing and
// branch-taken penalties included.

#pragma once

#include <cstdint>
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
    void rmw_store(uint16_t a, uint8_t old, uint8_t v) { b.dummyWrite(a, old); b.write(a, v); }

    // The undocumented read-modify-write groups (SLO, RLA, SRE, RRA, DCP, ISC)
    // share one set of addressing modes, picked by the opcode's low five bits.
    // SLO's opcodes have the top three bits clear, so they spell those
    // patterns. Sets the effective address and returns the cycle count.
    int ea_illegal_rmw(uint8_t op, uint16_t& a) {
        switch (op & 0x1F) {
        case SLO_ZP:   a = ea_zp();   return 5;
        case SLO_ZPX:  a = ea_zpx();  return 6;
        case SLO_ABS:  a = ea_abs();  return 6;
        case SLO_ABSX: a = ea_absx(); return 7;
        case SLO_ABSY: a = ea_absy(); return 7;
        case SLO_INDX: a = ea_indx(); return 8;
        default:       a = ea_indy(); return 8;
        }
    }
    void rmw_asl(uint16_t a) { uint8_t o = b.read(a); rmw_store(a, o, do_asl(o)); }
    void rmw_lsr(uint16_t a) { uint8_t o = b.read(a); rmw_store(a, o, do_lsr(o)); }
    void rmw_rol(uint16_t a) { uint8_t o = b.read(a); rmw_store(a, o, do_rol(o)); }
    void rmw_ror(uint16_t a) { uint8_t o = b.read(a); rmw_store(a, o, do_ror(o)); }

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
    case LDA_IMM:  b.a = fetch();               setZN(b.a); return 2;
    case LDA_ZP:   b.a = b.read(ea_zp());       setZN(b.a); return 3;
    case LDA_ZPX:  b.a = b.read(ea_zpx());      setZN(b.a); return 4;
    case LDA_ABS:  b.a = b.read(ea_abs());      setZN(b.a); return 4;
    case LDA_ABSX: b.a = b.read(ea_absx());     setZN(b.a); return rd_cycles(4);
    case LDA_ABSY: b.a = b.read(ea_absy());     setZN(b.a); return rd_cycles(4);
    case LDA_INDX: b.a = b.read(ea_indx());     setZN(b.a); return 6;
    case LDA_INDY: b.a = b.read(ea_indy());     setZN(b.a); return rd_cycles(5);

    // ---- LDX ----
    case LDX_IMM:  b.x = fetch();               setZN(b.x); return 2;
    case LDX_ZP:   b.x = b.read(ea_zp());       setZN(b.x); return 3;
    case LDX_ZPY:  b.x = b.read(ea_zpy());      setZN(b.x); return 4;
    case LDX_ABS:  b.x = b.read(ea_abs());      setZN(b.x); return 4;
    case LDX_ABSY: b.x = b.read(ea_absy());     setZN(b.x); return rd_cycles(4);

    // ---- LDY ----
    case LDY_IMM:  b.y = fetch();               setZN(b.y); return 2;
    case LDY_ZP:   b.y = b.read(ea_zp());       setZN(b.y); return 3;
    case LDY_ZPX:  b.y = b.read(ea_zpx());      setZN(b.y); return 4;
    case LDY_ABS:  b.y = b.read(ea_abs());      setZN(b.y); return 4;
    case LDY_ABSX: b.y = b.read(ea_absx());     setZN(b.y); return rd_cycles(4);

    // ---- STA / STX / STY ----
    case STA_ZP:   b.write(ea_zp(),   b.a); return 3;
    case STA_ZPX:  b.write(ea_zpx(),  b.a); return 4;
    case STA_ABS:  b.write(ea_abs(),  b.a); return 4;
    case STA_ABSX: b.write(ea_absx(), b.a); return 5;
    case STA_ABSY: b.write(ea_absy(), b.a); return 5;
    case STA_INDX: b.write(ea_indx(), b.a); return 6;
    case STA_INDY: b.write(ea_indy(), b.a); return 6;
    case STX_ZP:   b.write(ea_zp(),   b.x); return 3;
    case STX_ZPY:  b.write(ea_zpy(),  b.x); return 4;
    case STX_ABS:  b.write(ea_abs(),  b.x); return 4;
    case STY_ZP:   b.write(ea_zp(),   b.y); return 3;
    case STY_ZPX:  b.write(ea_zpx(),  b.y); return 4;
    case STY_ABS:  b.write(ea_abs(),  b.y); return 4;

    // ---- transfers ----
    case TAX: b.x = b.a;  setZN(b.x); return 2;
    case TAY: b.y = b.a;  setZN(b.y); return 2;
    case TXA: b.a = b.x;  setZN(b.a); return 2;
    case TYA: b.a = b.y;  setZN(b.a); return 2;
    case TSX: b.x = b.sp; setZN(b.x); return 2;
    case TXS: b.sp = b.x;             return 2;

    // ---- AND / ORA / EOR ----
    case AND_IMM:  b.a &= fetch();           setZN(b.a); return 2;
    case AND_ZP:   b.a &= b.read(ea_zp());   setZN(b.a); return 3;
    case AND_ZPX:  b.a &= b.read(ea_zpx());  setZN(b.a); return 4;
    case AND_ABS:  b.a &= b.read(ea_abs());  setZN(b.a); return 4;
    case AND_ABSX: b.a &= b.read(ea_absx()); setZN(b.a); return rd_cycles(4);
    case AND_ABSY: b.a &= b.read(ea_absy()); setZN(b.a); return rd_cycles(4);
    case AND_INDX: b.a &= b.read(ea_indx()); setZN(b.a); return 6;
    case AND_INDY: b.a &= b.read(ea_indy()); setZN(b.a); return rd_cycles(5);

    case ORA_IMM:  b.a |= fetch();           setZN(b.a); return 2;
    case ORA_ZP:   b.a |= b.read(ea_zp());   setZN(b.a); return 3;
    case ORA_ZPX:  b.a |= b.read(ea_zpx());  setZN(b.a); return 4;
    case ORA_ABS:  b.a |= b.read(ea_abs());  setZN(b.a); return 4;
    case ORA_ABSX: b.a |= b.read(ea_absx()); setZN(b.a); return rd_cycles(4);
    case ORA_ABSY: b.a |= b.read(ea_absy()); setZN(b.a); return rd_cycles(4);
    case ORA_INDX: b.a |= b.read(ea_indx()); setZN(b.a); return 6;
    case ORA_INDY: b.a |= b.read(ea_indy()); setZN(b.a); return rd_cycles(5);

    case EOR_IMM:  b.a ^= fetch();           setZN(b.a); return 2;
    case EOR_ZP:   b.a ^= b.read(ea_zp());   setZN(b.a); return 3;
    case EOR_ZPX:  b.a ^= b.read(ea_zpx());  setZN(b.a); return 4;
    case EOR_ABS:  b.a ^= b.read(ea_abs());  setZN(b.a); return 4;
    case EOR_ABSX: b.a ^= b.read(ea_absx()); setZN(b.a); return rd_cycles(4);
    case EOR_ABSY: b.a ^= b.read(ea_absy()); setZN(b.a); return rd_cycles(4);
    case EOR_INDX: b.a ^= b.read(ea_indx()); setZN(b.a); return 6;
    case EOR_INDY: b.a ^= b.read(ea_indy()); setZN(b.a); return rd_cycles(5);

    // ---- ADC / SBC ----
    case ADC_IMM:  do_adc(fetch());           return 2;
    case ADC_ZP:   do_adc(b.read(ea_zp()));   return 3;
    case ADC_ZPX:  do_adc(b.read(ea_zpx()));  return 4;
    case ADC_ABS:  do_adc(b.read(ea_abs()));  return 4;
    case ADC_ABSX: do_adc(b.read(ea_absx())); return rd_cycles(4);
    case ADC_ABSY: do_adc(b.read(ea_absy())); return rd_cycles(4);
    case ADC_INDX: do_adc(b.read(ea_indx())); return 6;
    case ADC_INDY: do_adc(b.read(ea_indy())); return rd_cycles(5);

    case SBC_IMM:
    case SBC_IMM_EB: do_sbc(fetch());           return 2;
    case SBC_ZP:     do_sbc(b.read(ea_zp()));   return 3;
    case SBC_ZPX:    do_sbc(b.read(ea_zpx()));  return 4;
    case SBC_ABS:    do_sbc(b.read(ea_abs()));  return 4;
    case SBC_ABSX:   do_sbc(b.read(ea_absx())); return rd_cycles(4);
    case SBC_ABSY:   do_sbc(b.read(ea_absy())); return rd_cycles(4);
    case SBC_INDX:   do_sbc(b.read(ea_indx())); return 6;
    case SBC_INDY:   do_sbc(b.read(ea_indy())); return rd_cycles(5);

    // ---- CMP / CPX / CPY ----
    case CMP_IMM:  do_cmp(b.a, fetch());           return 2;
    case CMP_ZP:   do_cmp(b.a, b.read(ea_zp()));   return 3;
    case CMP_ZPX:  do_cmp(b.a, b.read(ea_zpx()));  return 4;
    case CMP_ABS:  do_cmp(b.a, b.read(ea_abs()));  return 4;
    case CMP_ABSX: do_cmp(b.a, b.read(ea_absx())); return rd_cycles(4);
    case CMP_ABSY: do_cmp(b.a, b.read(ea_absy())); return rd_cycles(4);
    case CMP_INDX: do_cmp(b.a, b.read(ea_indx())); return 6;
    case CMP_INDY: do_cmp(b.a, b.read(ea_indy())); return rd_cycles(5);
    case CPX_IMM:  do_cmp(b.x, fetch());           return 2;
    case CPX_ZP:   do_cmp(b.x, b.read(ea_zp()));   return 3;
    case CPX_ABS:  do_cmp(b.x, b.read(ea_abs()));  return 4;
    case CPY_IMM:  do_cmp(b.y, fetch());           return 2;
    case CPY_ZP:   do_cmp(b.y, b.read(ea_zp()));   return 3;
    case CPY_ABS:  do_cmp(b.y, b.read(ea_abs()));  return 4;

    // ---- BIT ----
    case BIT_ZP:
    case BIT_ABS: {
        uint8_t v = b.read(op == BIT_ZP ? ea_zp() : ea_abs());
        setFlag(FLAG_Z, (b.a & v) == 0);
        setFlag(FLAG_N, (v & 0x80) != 0);
        setFlag(FLAG_V, (v & 0x40) != 0);
        return op == BIT_ZP ? 3 : 4;
    }

    // ---- INC / DEC memory ----
    case INC_ZP:   { uint16_t a = ea_zp();   uint8_t o = b.read(a); uint8_t v = uint8_t(o + 1); rmw_store(a, o, v); setZN(v); return 5; }
    case INC_ZPX:  { uint16_t a = ea_zpx();  uint8_t o = b.read(a); uint8_t v = uint8_t(o + 1); rmw_store(a, o, v); setZN(v); return 6; }
    case INC_ABS:  { uint16_t a = ea_abs();  uint8_t o = b.read(a); uint8_t v = uint8_t(o + 1); rmw_store(a, o, v); setZN(v); return 6; }
    case INC_ABSX: { uint16_t a = ea_absx(); uint8_t o = b.read(a); uint8_t v = uint8_t(o + 1); rmw_store(a, o, v); setZN(v); return 7; }
    case DEC_ZP:   { uint16_t a = ea_zp();   uint8_t o = b.read(a); uint8_t v = uint8_t(o - 1); rmw_store(a, o, v); setZN(v); return 5; }
    case DEC_ZPX:  { uint16_t a = ea_zpx();  uint8_t o = b.read(a); uint8_t v = uint8_t(o - 1); rmw_store(a, o, v); setZN(v); return 6; }
    case DEC_ABS:  { uint16_t a = ea_abs();  uint8_t o = b.read(a); uint8_t v = uint8_t(o - 1); rmw_store(a, o, v); setZN(v); return 6; }
    case DEC_ABSX: { uint16_t a = ea_absx(); uint8_t o = b.read(a); uint8_t v = uint8_t(o - 1); rmw_store(a, o, v); setZN(v); return 7; }

    // ---- INX / INY / DEX / DEY ----
    case INX: b.x++; setZN(b.x); return 2;
    case INY: b.y++; setZN(b.y); return 2;
    case DEX: b.x--; setZN(b.x); return 2;
    case DEY: b.y--; setZN(b.y); return 2;

    // ---- shifts and rotates ----
    case ASL_ACC:  b.a = do_asl(b.a); return 2;
    case ASL_ZP:   rmw_asl(ea_zp());   return 5;
    case ASL_ZPX:  rmw_asl(ea_zpx());  return 6;
    case ASL_ABS:  rmw_asl(ea_abs());  return 6;
    case ASL_ABSX: rmw_asl(ea_absx()); return 7;
    case LSR_ACC:  b.a = do_lsr(b.a); return 2;
    case LSR_ZP:   rmw_lsr(ea_zp());   return 5;
    case LSR_ZPX:  rmw_lsr(ea_zpx());  return 6;
    case LSR_ABS:  rmw_lsr(ea_abs());  return 6;
    case LSR_ABSX: rmw_lsr(ea_absx()); return 7;
    case ROL_ACC:  b.a = do_rol(b.a); return 2;
    case ROL_ZP:   rmw_rol(ea_zp());   return 5;
    case ROL_ZPX:  rmw_rol(ea_zpx());  return 6;
    case ROL_ABS:  rmw_rol(ea_abs());  return 6;
    case ROL_ABSX: rmw_rol(ea_absx()); return 7;
    case ROR_ACC:  b.a = do_ror(b.a); return 2;
    case ROR_ZP:   rmw_ror(ea_zp());   return 5;
    case ROR_ZPX:  rmw_ror(ea_zpx());  return 6;
    case ROR_ABS:  rmw_ror(ea_abs());  return 6;
    case ROR_ABSX: rmw_ror(ea_absx()); return 7;

    // ---- branches ----
    case BPL: return branch(!testFlag(FLAG_N));
    case BMI: return branch(testFlag(FLAG_N));
    case BVC: return branch(!testFlag(FLAG_V));
    case BVS: return branch(testFlag(FLAG_V));
    case BCC: return branch(!testFlag(FLAG_C));
    case BCS: return branch(testFlag(FLAG_C));
    case BNE: return branch(!testFlag(FLAG_Z));
    case BEQ: return branch(testFlag(FLAG_Z));

    // ---- jumps and returns ----
    case JMP_ABS: { uint16_t a = ea_abs(); b.pc = a; b.jumpTarget(a); return 3; }
    case JMP_IND: {
        uint16_t ptr = ea_abs();
        // 6502 JMP indirect bug: when the low byte is $FF the high byte is
        // fetched from the same page ($xx00) instead of crossing into the next.
        uint16_t hiAddr = (ptr & 0xFF) == 0xFF ? uint16_t(ptr & 0xFF00) : uint16_t(ptr + 1);
        uint16_t a = uint16_t(b.read(ptr) | (b.read(hiAddr) << 8));
        b.pc = a;
        b.jumpTarget(a);
        return 5;
    }
    case JSR_ABS: {
        // The high operand byte is fetched after the return address is pushed,
        // so a JSR in the stack page can overwrite its own operand.
        uint8_t lo = fetch();
        push(uint8_t(b.pc >> 8));
        push(uint8_t(b.pc & 0xFF));
        uint16_t a = uint16_t(lo | (fetch() << 8));
        b.pc = a;
        b.jumpTarget(a);
        return 6;
    }
    case RTS: { uint8_t lo = pull(); uint8_t hi = pull(); b.pc = uint16_t((lo | (hi << 8)) + 1); return 6; }
    case RTI: {
        b.st = uint8_t(pull() | FLAG_U);
        uint8_t lo = pull();
        uint8_t hi = pull();
        b.pc = uint16_t(lo | (hi << 8));
        return 6;
    }

    // ---- stack ----
    case PHA: push(b.a); return 3;
    case PHP: push(uint8_t(b.st | FLAG_B | FLAG_U)); return 3;
    case PLA: b.a = pull(); setZN(b.a); return 4;
    case PLP: b.st = uint8_t(pull() | FLAG_U); return 4;

    // ---- flags ----
    case CLC: setFlag(FLAG_C, false); return 2;
    case SEC: setFlag(FLAG_C, true);  return 2;
    case CLI: setFlag(FLAG_I, false); return 2;
    case SEI: setFlag(FLAG_I, true);  return 2;
    case CLD: setFlag(FLAG_D, false); return 2;
    case SED: setFlag(FLAG_D, true);  return 2;
    case CLV: setFlag(FLAG_V, false); return 2;

    case NOP: return 2;

    case BRK: {
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
    case LAX_ZP:   do_lax(b.read(ea_zp()));   return 3;
    case LAX_ZPY:  do_lax(b.read(ea_zpy()));  return 4;
    case LAX_ABS:  do_lax(b.read(ea_abs()));  return 4;
    case LAX_ABSY: do_lax(b.read(ea_absy())); return rd_cycles(4);
    case LAX_INDX: do_lax(b.read(ea_indx())); return 6;
    case LAX_INDY: do_lax(b.read(ea_indy())); return rd_cycles(5);

    // SAX - store A & X
    case SAX_ZP:   b.write(ea_zp(),   uint8_t(b.a & b.x)); return 3;
    case SAX_ZPY:  b.write(ea_zpy(),  uint8_t(b.a & b.x)); return 4;
    case SAX_ABS:  b.write(ea_abs(),  uint8_t(b.a & b.x)); return 4;
    case SAX_INDX: b.write(ea_indx(), uint8_t(b.a & b.x)); return 6;

    // DCP - DEC + CMP
    case DCP_ZP: case DCP_ZPX: case DCP_ABS: case DCP_ABSX: case DCP_ABSY: case DCP_INDX: case DCP_INDY: {
        uint16_t a;
        const int cyc = ea_illegal_rmw(op, a);
        uint8_t o = b.read(a);
        uint8_t v = uint8_t(o - 1);
        rmw_store(a, o, v);
        do_cmp(b.a, v);
        return cyc;
    }

    // ISC (ISB) - INC + SBC
    case ISC_ZP: case ISC_ZPX: case ISC_ABS: case ISC_ABSX: case ISC_ABSY: case ISC_INDX: case ISC_INDY: {
        uint16_t a;
        const int cyc = ea_illegal_rmw(op, a);
        uint8_t o = b.read(a);
        uint8_t v = uint8_t(o + 1);
        rmw_store(a, o, v);
        do_sbc(v);
        return cyc;
    }

    // SLO - ASL + ORA
    case SLO_ZP: case SLO_ZPX: case SLO_ABS: case SLO_ABSX: case SLO_ABSY: case SLO_INDX: case SLO_INDY: {
        uint16_t a;
        const int cyc = ea_illegal_rmw(op, a);
        uint8_t o = b.read(a);
        setFlag(FLAG_C, (o & 0x80) != 0);
        uint8_t v = uint8_t(o << 1);
        rmw_store(a, o, v);
        b.a |= v;
        setZN(b.a);
        return cyc;
    }

    // RLA - ROL + AND
    case RLA_ZP: case RLA_ZPX: case RLA_ABS: case RLA_ABSX: case RLA_ABSY: case RLA_INDX: case RLA_INDY: {
        uint16_t a;
        const int cyc = ea_illegal_rmw(op, a);
        uint8_t o = b.read(a);
        bool c = testFlag(FLAG_C);
        setFlag(FLAG_C, (o & 0x80) != 0);
        uint8_t v = uint8_t((o << 1) | (c ? 1 : 0));
        rmw_store(a, o, v);
        b.a &= v;
        setZN(b.a);
        return cyc;
    }

    // SRE - LSR + EOR
    case SRE_ZP: case SRE_ZPX: case SRE_ABS: case SRE_ABSX: case SRE_ABSY: case SRE_INDX: case SRE_INDY: {
        uint16_t a;
        const int cyc = ea_illegal_rmw(op, a);
        uint8_t o = b.read(a);
        setFlag(FLAG_C, (o & 1) != 0);
        uint8_t v = uint8_t(o >> 1);
        rmw_store(a, o, v);
        b.a ^= v;
        setZN(b.a);
        return cyc;
    }

    // RRA - ROR + ADC
    case RRA_ZP: case RRA_ZPX: case RRA_ABS: case RRA_ABSX: case RRA_ABSY: case RRA_INDX: case RRA_INDY: {
        uint16_t a;
        const int cyc = ea_illegal_rmw(op, a);
        uint8_t o = b.read(a);
        bool c = testFlag(FLAG_C);
        setFlag(FLAG_C, (o & 1) != 0);
        uint8_t v = uint8_t((o >> 1) | (c ? 0x80 : 0));
        rmw_store(a, o, v);
        do_adc(v);
        return cyc;
    }

    // ANC - AND #imm, then carry from bit 7 of the result
    case ANC_IMM_0B: case ANC_IMM_2B:
        b.a &= fetch();
        setZN(b.a);
        setFlag(FLAG_C, (b.a & 0x80) != 0);
        return 2;

    // ALR - AND #imm then LSR A
    case ALR_IMM:
        b.a &= fetch();
        setFlag(FLAG_C, (b.a & 1) != 0);
        b.a = uint8_t(b.a >> 1);
        setZN(b.a);
        return 2;

    // ARR - AND #imm then ROR A; C is bit 6 of the result, V bit 6 ^ bit 5.
    // In decimal mode N, Z and V come from the rotated value and each nibble
    // of the AND result gets an ADC-style BCD fixup, which also sets C.
    case ARR_IMM: {
        uint8_t t = uint8_t(b.a & fetch());
        bool c = testFlag(FLAG_C);
        b.a = uint8_t((t >> 1) | (c ? 0x80 : 0));
        if (testFlag(FLAG_D)) {
            setZN(b.a);
            setFlag(FLAG_V, ((t ^ b.a) & 0x40) != 0);
            if ((t & 0x0F) + (t & 0x01) > 5) b.a = uint8_t((b.a & 0xF0) | ((b.a + 6) & 0x0F));
            bool hc = (t & 0xF0) + (t & 0x10) > 0x50;
            setFlag(FLAG_C, hc);
            if (hc) b.a = uint8_t(b.a + 0x60);
            return 2;
        }
        setZN(b.a);
        setFlag(FLAG_C, (b.a & 0x40) != 0);
        setFlag(FLAG_V, ((b.a ^ (b.a << 1)) & 0x40) != 0);
        return 2;
    }

    // AXS/SBX - X = (A & X) - imm
    case AXS_IMM: {
        uint8_t i = fetch();
        uint16_t r = uint16_t(uint16_t(b.a & b.x) - i);
        setFlag(FLAG_C, r < 0x100);
        b.x = uint8_t(r);
        setZN(b.x);
        return 2;
    }

    // LAX #imm (LXA/ATX): A = X = (A | magic) & imm. Unstable on hardware: the
    // magic constant varies between chips. $EE is the common value, and the
    // one Tom Harte's tests use.
    case LAX_IMM: { uint8_t v = uint8_t((b.a | 0xEE) & fetch()); b.a = v; b.x = v; setZN(v); return 2; }

    // XAA #imm (ANE): A = (A | magic) & X & imm, with the same $EE as LXA.
    // VICE and libsidplayfp use $EF for ANE, which VICE's notes say Spectipede
    // and Turrican 3 need.
    case XAA_IMM: b.a = uint8_t((b.a | 0xEE) & b.x & fetch()); setZN(b.a); return 2;

    // SHA/SHX/SHY/TAS - see do_unstable_store.
    case SHA_ABSY: { uint16_t base = fetch16(); do_unstable_store(base, b.y, uint8_t(b.a & b.x)); return 5; }
    case SHA_INDY: {
        uint8_t z = fetch();
        uint16_t ptr = uint16_t(b.read(z) | (b.read(uint8_t(z + 1)) << 8));
        do_unstable_store(ptr, b.y, uint8_t(b.a & b.x));
        return 6;
    }
    case SHX_ABSY: { uint16_t base = fetch16(); do_unstable_store(base, b.y, b.x); return 5; }
    case SHY_ABSX: { uint16_t base = fetch16(); do_unstable_store(base, b.x, b.y); return 5; }
    case TAS_ABSY: {
        uint16_t base = fetch16();
        b.sp = uint8_t(b.a & b.x);
        do_unstable_store(base, b.y, uint8_t(b.a & b.x));
        return 5;
    }

    // LAS/LAR - A = X = SP = mem & SP
    case LAS_ABSY: {
        uint8_t v = uint8_t(b.read(ea_absy()) & b.sp);
        b.a = v; b.x = v; b.sp = v;
        setZN(v);
        return rd_cycles(4);
    }

    // KIL/JAM - the CPU stops. Back the PC up onto the opcode so a caller that
    // reports where it stopped points at the offending byte.
    case JAM_02: case JAM_12: case JAM_22: case JAM_32: case JAM_42: case JAM_52:
    case JAM_62: case JAM_72: case JAM_92: case JAM_B2: case JAM_D2: case JAM_F2:
        b.pc--;
        b.jam();
        return 2;

    // Illegal NOPs come in four forms with different sizes, cycle counts and
    // memory access; each is decoded separately so timing and read tracking
    // stay accurate.
    case NOP_1A: case NOP_3A: case NOP_5A: case NOP_7A: case NOP_DA: case NOP_FA:
        return 2;
    case NOP_IMM_80: case NOP_IMM_82: case NOP_IMM_89: case NOP_IMM_C2: case NOP_IMM_E2:
        fetch(); return 2;
    case NOP_ZP_04: case NOP_ZP_44: case NOP_ZP_64:
        b.read(ea_zp()); return 3;
    case NOP_ZPX_14: case NOP_ZPX_34: case NOP_ZPX_54: case NOP_ZPX_74: case NOP_ZPX_D4: case NOP_ZPX_F4:
        b.read(ea_zpx()); return 4;
    case NOP_ABS:
        b.read(ea_abs()); return 4;
    case NOP_ABSX_1C: case NOP_ABSX_3C: case NOP_ABSX_5C: case NOP_ABSX_7C: case NOP_ABSX_DC: case NOP_ABSX_FC:
        b.read(ea_absx()); return rd_cycles(4);

    default: {
        // Unreachable: all 256 opcodes are handled above (the cross-check
        // confirms it). Kept as a defensive fallback that skips past the
        // opcode using the size table.
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
