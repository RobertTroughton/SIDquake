#!/usr/bin/env node
// scan-shadow-suitability.js - report which tunes the shadow-register bar method
// can actually be built for, and why the rest can't.
//
// Runs the same offline analysis the exporter runs (public/spectrometer-shadow-detect.js
// analyzeShadow) over a set of .sid files, outside the browser. Useful for
// checking a change to the detection against a corpus rather than one tune at a
// time, and for seeing at a glance how often each rejection reason fires.
//
// Usage:
//   node scripts/scan-shadow-suitability.js [file-or-directory ...]   (default: SID/)
//   node scripts/scan-shadow-suitability.js --frames 300 SID/
//
// Requires public/sidquake.wasm. Exits non-zero if a file could not be analysed.

const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const be16 = (b, o) => (b[o] << 8) | b[o + 1];

async function loadCpu() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    return factory({ wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
                     print: () => {}, printErr: () => {} });
}

// The addresses analyzeShadow needs, straight out of the PSID/RSID header.
function headerOf(bytes) {
    const dataOffset = be16(bytes, 6);
    let loadAddress = be16(bytes, 8);
    if (loadAddress === 0) loadAddress = bytes[dataOffset] | (bytes[dataOffset + 1] << 8);
    return { loadAddress, initAddress: be16(bytes, 10) || loadAddress, playAddress: be16(bytes, 12) };
}

// Second/third/fourth SID addresses live in the v3+/v4 header as the middle byte
// of $Dxx0 ; 0 means "not present".
function chipAddresses(bytes) {
    const version = be16(bytes, 4);
    const addrs = [0xD400];
    for (const off of [0x7A, 0x7B]) {
        if (version < 3 || bytes.length <= off || !bytes[off]) continue;
        addrs.push(0xD000 | (bytes[off] << 4));
    }
    return addrs;
}

function collect(target) {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return [target];
    return fs.readdirSync(target)
        .filter(f => f.toLowerCase().endsWith('.sid'))
        .sort()
        .map(f => path.join(target, f));
}

async function main() {
    const argv = process.argv.slice(2);
    let frames = 1200;
    const targets = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--frames') frames = parseInt(argv[++i], 10);
        else targets.push(argv[i]);
    }
    const files = (targets.length ? targets : [path.join(ROOT, 'SID')]).flatMap(collect);

    const { analyzeShadow } = await import(
        'file://' + path.join(ROOT, 'public/spectrometer-shadow-detect.js'));
    const m = await loadCpu();

    let ok = 0, errors = 0;
    const reasons = new Map();
    for (const file of files) {
        const bytes = new Uint8Array(fs.readFileSync(file));
        const h = headerOf(bytes);
        const chips = chipAddresses(bytes);
        const name = path.basename(file);
        if (!h.playAddress) { console.log(`  skip ${name}: no play address`); continue; }

        let res;
        try {
            res = analyzeShadow(m, bytes, { ...h, subtune: 0, numChips: chips.length, frames });
        } catch (e) {
            console.log(`  ERR  ${name}: ${e.message}`);
            errors++; continue;
        }

        // Same grid check the exporter applies before it trusts the order.
        const offGrid = chips.some((a, i) => a !== 0xD400 + i * 0x20);
        const why = offGrid ? 'chips off the $D400/$20 grid'
            : res.leakedWrites ? `${res.leakedWrites} un-redirectable SID write(s)`
            : res.overflowWrites ? `${res.overflowWrites} write(s) past the mirror`
            : null;
        if (why) reasons.set(why, (reasons.get(why) || 0) + 1);
        else ok++;

        const chipStr = chips.length > 1 ? ` ${chips.length}SID` : '';
        console.log(why
            ? `  no   ${name}${chipStr}: ${why}`
            : `  yes  ${name}${chipStr}: ${res.order.length} regs, ` +
              `${res.usedFallback ? 'fallback order' : `${(res.consistency * 100).toFixed(0)}% consistent`}, ` +
              `${res.storeSites.length} store sites`);
    }

    console.log(`\n${ok}/${files.length} tunes can use the shadow method.`);
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${why}`);
    process.exit(errors === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
