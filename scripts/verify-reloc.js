#!/usr/bin/env node
// verify-reloc.js - prove the relocation table + relocator reproduce a direct
// KickAss build at arbitrary $xx00 pages, byte-for-byte.
//
// Usage: node scripts/verify-reloc.js <player.asm> <baseHex> <table.json> [targets...]
//   e.g. node scripts/verify-reloc.js SIDPlayers/SimpleRaster/SimpleRaster.asm 4000 \
//            public/prg/simpleraster.reloc.json 8000 2000 5500 a300 c000
//
// For a graphics-free player (gfxFree) the relocated image must equal the direct
// build exactly. For a player with gfx refs, code and gfx move together here (a
// whole-bank delta), so this still checks the code-ref set is complete; true
// independent code/gfx relocation is validated on the C64 after the split.

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

let DEFINES = [];
function build(asm, addr) {
    const out = path.join(os.tmpdir(), `vr-${addr.toString(16)}-${DEFINES.join('-')}-${path.basename(asm)}.bin`);
    const args = ['-jar', 'KickAss.jar',
        `:loadAddress=${addr}`, `:sysAddress=${addr + 0x100}`, `:dataAddress=${addr}`];
    for (const d of DEFINES) args.push('-define', d);
    args.push(asm, '-binfile', '-o', out);
    execFileSync('java', args, { stdio: 'pipe' });
    return fs.readFileSync(out);
}

function relocate(image, table, delta) {
    const out = Buffer.from(image);
    for (const off of [...(table.codeRefs || []), ...(table.gfxRefs || [])]) {
        out[off] = (out[off] + delta) & 0xff;
    }
    // Anomalies (VIC-bank config) are position-dependent non-pointers a loader
    // sets from the target bank; exclude them from the comparison.
    return out;
}

function main() {
    const rawArgv = process.argv.slice(2);
    const argv = [];
    for (let i = 0; i < rawArgv.length; i++) {
        if (rawArgv[i] === '-define' || rawArgv[i] === '--define') DEFINES.push(rawArgv[++i]);
        else argv.push(rawArgv[i]);
    }
    const [asm, baseHex, tableFile, ...targetHexes] = argv;
    if (!asm || !baseHex || !tableFile) {
        console.error('usage: node scripts/verify-reloc.js <player.asm> <baseHex> <table.json> [targets...]');
        process.exit(1);
    }
    const base = parseInt(baseHex, 16);
    const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
    const targets = (targetHexes.length ? targetHexes : ['8000', '2000', '5500', 'a300', 'c000'])
        .map(h => parseInt(h, 16));
    // anomalies are {off, base, perBank} (VIC-bank config); compare-exclude by offset.
    const anomalySet = new Set((table.anomalies || []).map(a => (typeof a === 'number' ? a : a.off)));

    const baseImg = build(asm, base);
    console.log(`base $${base.toString(16)}: ${baseImg.length} bytes, ` +
        `${(table.codeRefs || []).length} code + ${(table.gfxRefs || []).length} gfx refs, ` +
        `gfxFree=${!!table.gfxFree}`);

    let allOk = true;
    for (const target of targets) {
        const direct = build(asm, target);
        const delta = ((target >> 8) - (base >> 8)) & 0xff;
        const reloc = relocate(baseImg, table, delta);
        let diffs = 0;
        for (let i = 0; i < direct.length; i++) {
            if (reloc[i] !== direct[i] && !anomalySet.has(i)) diffs++;
        }
        const ok = diffs === 0;
        allOk = allOk && ok;
        console.log(`  -> $${target.toString(16).padStart(4, '0')} (+$${delta.toString(16)}): ` +
            `${ok ? 'IDENTICAL' : `MISMATCH (${diffs} bytes)`}`);
    }
    console.log(allOk ? 'PASS: relocation reproduces direct builds' : 'FAIL');
    process.exit(allOk ? 0 : 1);
}

main();
