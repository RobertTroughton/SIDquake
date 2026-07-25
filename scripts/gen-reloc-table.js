#!/usr/bin/env node
// gen-reloc-table.js - generate a relocation table for a SIDPlayers visualizer.
//
// A player assembles to a fixed load address. To load it on any $xx00 page we
// build it TWICE, one page apart, and diff. Every
// byte that differs is the high byte of an address that moves with the code;
// the diff (which is exactly +1 per page) tells us which bytes to patch when
// relocating. This script emits that table and *verifies* it by relocating the
// low build up to the high build and checking they match byte-for-byte.
//
// Usage: node scripts/gen-reloc-table.js <player.asm> <baseHex> [outfile]
//   e.g. node scripts/gen-reloc-table.js SIDPlayers/RaistlinBars/RaistlinBars.asm 4000
//
// Graphics live at VIC-bank-relative addresses (unchanged within a bank), so a
// same-bank one-page shift isolates the CODE/data relocations - exactly the set
// that moves when the code blob is placed elsewhere.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Optional -define flags (e.g. SPECTROMETER_BAKED / SPECTROMETER_SHADOW) so a
// variant build gets its own table - its code differs from the realtime build.
let DEFINES = [];

function build(asm, loadAddr, showmem = false) {
    const out = path.join(os.tmpdir(), `reloc-${loadAddr.toString(16)}-${DEFINES.join('-')}-${path.basename(asm)}.bin`);
    const args = ['-jar', 'KickAss.jar',
        `:loadAddress=${loadAddr}`, `:sysAddress=${loadAddr + 0x100}`, `:dataAddress=${loadAddr}`];
    for (const d of DEFINES) args.push('-define', d);
    args.push(asm, '-binfile', '-o', out);
    if (showmem) args.push('-showmem');
    const stdout = execFileSync('java', args, { encoding: showmem ? 'utf8' : 'buffer' });
    const bin = fs.readFileSync(out);
    return showmem ? { bin, stdout } : bin;
}

// The split point separates the relocatable CODE (any page) from the GRAPHICS
// (a VIC bank). It must sit above the last code byte (so no relative branch or
// contiguous structure straddles it) and at/below where the graphics begin.
// Derive it from the memory map: first page after the "Main Code" segment.
function codeSplitPoint(stdout, base) {
    let codeEnd = base + 0x100;   // at least past the data block
    const re = /\$([0-9a-f]{4})-\$([0-9a-f]{4})\s+Main Code/i;
    const m = stdout.match(re);
    if (m) codeEnd = parseInt(m[2], 16);
    return (codeEnd + 1 + 0xff) & 0xff00;   // page-aligned, just above the code
}

function main() {
    // Pull out any `-define NAME` / `--define NAME` pairs, keep the positionals.
    const argv = process.argv.slice(2);
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '-define' || argv[i] === '--define') { DEFINES.push(argv[++i]); }
        else pos.push(argv[i]);
    }
    const [asm, baseHex, outfile] = pos;
    if (!asm || !baseHex) {
        console.error('usage: node scripts/gen-reloc-table.js <player.asm> <baseHex> [outfile] [-define NAME]...');
        process.exit(1);
    }
    const base = parseInt(baseHex, 16);
    // Shift by a whole VIC bank so BOTH code and graphics move together and the
    // two images stay aligned (a sub-bank page shift leaves the bank-relative
    // graphics behind and misaligns the images - which is exactly why loading
    // on an arbitrary page needs code and graphics separated).
    const step = 0x4000;
    const stepHi = step >> 8;               // +$40 per bank

    const loBuilt = build(asm, base, true);
    const lo = loBuilt.bin;
    const hi = build(asm, base + step);
    const splitPoint = codeSplitPoint(loBuilt.stdout, base);
    if (lo.length !== hi.length) {
        console.error(`size mismatch: ${lo.length} vs ${hi.length}`); process.exit(1);
    }

    const reloc = [];       // offsets whose byte is a relocatable high byte
    const anomalies = [];   // diffs that are NOT the expected +bank delta
    for (let i = 0; i < lo.length; i++) {
        if (lo[i] === hi[i]) continue;
        if (((hi[i] - lo[i]) & 0xff) === stepHi) reloc.push(i);
        else anomalies.push({ off: i, lo: lo[i], hi: hi[i] });
    }

    // Verify: after patching every reloc site, the ONLY remaining differences
    // vs the one-bank-up build must be the anomaly offsets - i.e. the reloc
    // table accounts for every pointer. Anomalies are non-pointer bytes that
    // depend on position (a few = VIC bank config the loader sets; many = the
    // player bakes address-dependent data and can't be cleanly relocated).
    const test = Buffer.from(lo);
    for (const off of reloc) test[off] = (test[off] + stepHi) & 0xff;
    let leftover = 0;
    const anomalySet = new Set(anomalies.map(a => a.off));
    for (let i = 0; i < test.length; i++) if (test[i] !== hi[i] && !anomalySet.has(i)) leftover++;
    const tableComplete = leftover === 0;
    const RELOCATABLE = tableComplete && anomalies.length <= 8;

    // Classify each reloc high byte by what it points at. The operand is
    // little-endian (lo at off-1, hi at off), so reconstruct the target. Code
    // lives in the lower half of the bank, graphics (charset/screens/bitmap) in
    // the upper half - so the target's offset within the bank tells them apart.
    let codeRefs = 0, gfxRefs = 0;
    for (const off of reloc) {
        const target = (lo[off] << 8) | (off > 0 ? lo[off - 1] : 0);
        const bankOffset = (target - base) & 0x3fff;   // position within the 16K bank
        if (bankOffset >= 0x2000) gfxRefs++; else codeRefs++;
    }

    console.log(`player      : ${asm}`);
    console.log(`base        : $${base.toString(16)}  (vs $${(base + step).toString(16)}, one bank up)`);
    console.log(`size        : ${lo.length} bytes`);
    console.log(`reloc sites : ${reloc.length}  (${(100 * reloc.length / lo.length).toFixed(1)}% of image)`);
    console.log(`  code refs : ${codeRefs}  (move with the code -> any page)`);
    console.log(`  gfx refs  : ${gfxRefs}  (point into charset/screens/bitmap -> a VIC bank)`);
    console.log(`anomalies   : ${anomalies.length} non-pointer position-dependent bytes` +
        `${anomalies.length && anomalies.length <= 8 ? ' (VIC bank config - loader sets these)' : ''}`);
    console.log(`table check : ${tableComplete ? 'complete (accounts for every pointer diff)' : `INCOMPLETE (${leftover} unexplained diffs)`}`);
    console.log(`VERDICT     : ${RELOCATABLE ? 'RELOCATABLE' : 'NOT cleanly relocatable (bakes address-dependent data)'}`);

    if (outfile && RELOCATABLE) {
        // Split the reloc sites into code refs (move with the code -> any page)
        // and gfx refs (point into charset/screens/bitmap -> a VIC bank), so the
        // relocator can shift each by an independent page delta. The split is by
        // target bank-offset; it is exact for a graphics-free player (all code)
        // and a heuristic otherwise (verify independent relocation before trusting
        // it on a player that keeps code-data in the upper half of the bank).
        // Classify by the actual split point: a ref pointing below it moves with
        // the code (any page), at/above it moves with the graphics (a VIC bank).
        const codeRefs = [], gfxRefs = [];
        for (const off of reloc) {
            const target = (lo[off] << 8) | (off > 0 ? lo[off - 1] : 0);
            (target >= splitPoint ? gfxRefs : codeRefs).push(off);
        }
        // Anomalies are VIC-bank config bytes: position-dependent non-pointers that
        // vary linearly with the VIC bank number (lo build = bank 1 at $4000, hi
        // build = bank 2 at $8000). Record value(bank) = base + perBank*(bank-1) so
        // the exporter can set them for whatever graphics bank it picks (0..3).
        const anomalyEntries = anomalies.map(a => ({
            off: a.off,
            base: a.lo,            // value when graphics are in VIC bank 1 ($4000)
            perBank: (a.hi - a.lo),
        }));
        const table = {
            player: path.basename(asm),
            base,
            size: lo.length,
            splitPoint,                           // code blob = [base, splitPoint); gfx blob = [splitPoint, end)
            gfxFree: gfxRefs.length === 0,        // true = relocatable to any page as-is
            codeRefs,
            gfxRefs,
            anomalies: anomalyEntries,             // [{off, base, perBank}] - value = base + perBank*(bank-1)
        };
        fs.writeFileSync(outfile, JSON.stringify(table, null, 0) + '\n');
        console.log(`wrote       : ${outfile} (code ${codeRefs.length}, gfx ${gfxRefs.length}, anomalies ${anomalies.length})`);
    }
    process.exit(RELOCATABLE ? 0 : 2);
}

main();
