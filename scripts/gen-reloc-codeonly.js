#!/usr/bin/env node
// gen-reloc-codeonly.js - relocation table for a CODE_ONLY visualizer build.
//
// A CODE_ONLY build emits just the code + CPU-read tables; the graphics (VIC
// assets) are a separate blob the exporter places in a bank. Because code and
// graphics are separated, two cheap diffs isolate the two pointer sets exactly -
// no bank-half heuristic, no split-point guess:
//
//   * code-page shift  (base vs base+$100, same gfxBank)  -> CODE refs
//       every internal pointer's high byte moves +1; nothing else changes.
//   * graphics-bank shift (gfxBank N vs N+1, same base)   -> GFX refs
//       every pointer into the graphics bank moves +$40; code stays put.
//
// A byte that changes in the bank shift but not by a clean +$40 is an ANOMALY
// (VIC-bank config the loader sets, e.g. $DD00 = 63-bank). The result verifies
// itself: it relocates the base build to arbitrary (page, bank) targets and
// checks each reproduces a direct KickAss build byte-for-byte.
//
// Usage: node scripts/gen-reloc-codeonly.js <player.asm> [outfile] [-define NAME]...

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

let DEFINES = [];
// CODE_ONLY build at a given code base + graphics bank. Returns { bin, stdout }
// so the caller can read compile-time .print output (e.g. the shadow labels).
function build(asm, base, gfxBank) {
    const out = path.join(os.tmpdir(),
        `co-${base.toString(16)}-g${gfxBank}-${DEFINES.join('-')}-${path.basename(asm)}.bin`);
    const args = ['-jar', 'KickAss.jar',
        `:loadAddress=${base}`, `:sysAddress=${base + 0x100}`, `:dataAddress=${base}`,
        `:gfxBank=${gfxBank}`, '-define', 'CODE_ONLY'];
    for (const d of DEFINES) args.push('-define', d);
    args.push(asm, '-binfile', '-o', out);
    const stdout = execFileSync('java', args, { stdio: 'pipe' }).toString();
    return { bin: fs.readFileSync(out), stdout };
}

// Parse the shadow player's ".print SHADOW_LABELS mirror=.. order=.." line.
function parseShadowLabels(stdout) {
    const m = /SHADOW_LABELS mirror=([0-9a-fA-F]+) order=([0-9a-fA-F]+)/.exec(stdout);
    return m ? { mirror: parseInt(m[1], 16), order: parseInt(m[2], 16) } : null;
}

function main() {
    const argv = [];
    let codeBinOut = null;
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === '-define' || process.argv[i] === '--define') DEFINES.push(process.argv[++i]);
        // The CODE_ONLY blob the exporter actually relocates (relocCodeBase) is the
        // SAME base-$1000 build this tool already makes internally. Emit it here too so
        // the blob and its reloc table are produced from one build and can never drift
        // out of sync (a stale blob + fresh table silently corrupts every export).
        else if (process.argv[i] === '--codebin') codeBinOut = process.argv[++i];
        else argv.push(process.argv[i]);
    }
    const [asm, outfile] = argv;
    if (!asm) { console.error('usage: gen-reloc-codeonly.js <player.asm> [outfile] [--codebin <code.bin>] [-define NAME]...'); process.exit(1); }

    const BASE = 0x1000, GBANK = 1, CFG_BASE = 0x4000;
    const lo   = build(asm, BASE, GBANK);              // reference (also the relocCodeBase blob)
    const loPg = build(asm, BASE + 0x100, GBANK);      // +1 code page
    const loGb = build(asm, BASE, GBANK + 1);          // +1 graphics bank
    if (lo.bin.length !== loPg.bin.length || lo.bin.length !== loGb.bin.length) {
        console.error('size mismatch across builds'); process.exit(1);
    }

    // Shadow players: derive the SID-mirror page + replay-order addresses from the
    // live labels (they drift as the code changes). Classify each by whether it
    // moved with the code page (code-relative) or stayed put (external/gfx), then
    // express it in the config's $4000 space so the exporter's reloc transform
    // relocates it just like every other layout address.
    let shadowLabels = null;
    const slLo = parseShadowLabels(lo.stdout), slPg = parseShadowLabels(loPg.stdout);
    if (slLo && slPg) {
        const toCfg = (v, vPg) => (((vPg - v) & 0xffff) === 0x100 ? v + (CFG_BASE - BASE) : v) & 0xffff;
        const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
        shadowLabels = {
            shadowMirror: hex(toCfg(slLo.mirror, slPg.mirror)),
            shadowOrder:  hex(toCfg(slLo.order, slPg.order)),
        };
    }

    const codeRefs = [], gfxRefs = [], anomalies = [];
    for (let i = 0; i < lo.bin.length; i++) {
        if (loPg.bin[i] !== lo.bin[i]) {
            if (((loPg.bin[i] - lo.bin[i]) & 0xff) === 0x01) codeRefs.push(i);
            else anomalies.push({ off: i, kind: 'code', lo: lo.bin[i], hi: loPg.bin[i] });
        }
        if (loGb.bin[i] !== lo.bin[i]) {
            if (((loGb.bin[i] - lo.bin[i]) & 0xff) === 0x40) gfxRefs.push(i);
            else anomalies.push({ off: i, base: lo.bin[i], perBank: (loGb.bin[i] - lo.bin[i]) & 0xff }); // VIC-bank config
        }
    }
    // A site can't be both; code refs point below the graphics, gfx refs into it.
    const codeSet = new Set(codeRefs);
    const overlap = gfxRefs.filter(o => codeSet.has(o));

    // Self-verify: relocate `lo` to arbitrary (page, bank) targets and compare to
    // a direct build there.
    const anomOffs = new Set(anomalies.map(a => a.off).filter(x => x != null));
    const targets = [
        { base: 0x5500, gfx: 2 }, { base: 0xA300, gfx: 3 }, { base: 0x2000, gfx: 2 },
    ];
    let allOk = true;
    for (const t of targets) {
        const pageDelta = ((t.base - BASE) >> 8) & 0xff;
        const bankDelta = ((t.gfx - GBANK) * 0x40) & 0xff;
        const test = Buffer.from(lo.bin);
        for (const o of codeRefs) test[o] = (test[o] + pageDelta) & 0xff;
        for (const o of gfxRefs)  test[o] = (test[o] + bankDelta) & 0xff;
        const direct = build(asm, t.base, t.gfx).bin;
        let diffs = 0;
        for (let i = 0; i < test.length; i++) if (test[i] !== direct[i] && !anomOffs.has(i)) diffs++;
        if (diffs !== 0) {
            console.error(`${asm}: NOT RELOCATABLE - base $${t.base.toString(16)} gfxBank ${t.gfx}: ${diffs} diffs`);
            allOk = false;
        }
    }

    if (overlap.length) console.error(`${asm}: ${overlap.length} sites classified as both code and gfx`);

    if (outfile && allOk && !overlap.length) {
        // Adler-32 of the code blob: the exporter refuses to relocate when the
        // blob it fetched doesn't match the table (a stale cached file would
        // otherwise be patched at the wrong offsets and silently corrupted).
        let a = 1, b = 0;
        for (let i = 0; i < lo.bin.length; i++) { a = (a + lo.bin[i]) % 65521; b = (b + a) % 65521; }
        const table = {
            player: path.basename(asm),
            codeOnly: true,
            base: BASE,
            size: lo.bin.length,
            adler32: ((b << 16) | a) >>> 0,
            codeRefs,
            gfxRefs,
            // VIC-bank config bytes: value(bank) = base + perBank*(bank-1)
            anomalies: anomalies.filter(a => a.perBank != null).map(a => ({ off: a.off, base: a.base, perBank: a.perBank })),
            // Shadow players only: live SID-mirror + replay-order addresses.
            ...(shadowLabels || {}),
        };
        fs.writeFileSync(outfile, JSON.stringify(table, null, 0) + '\n');
    }
    // Emit the matching code blob from the SAME build as the table (kept in lockstep).
    if (codeBinOut && allOk && !overlap.length) {
        fs.writeFileSync(codeBinOut, lo.bin);
    }
    process.exit(allOk && !overlap.length ? 0 : 2);
}

main();
