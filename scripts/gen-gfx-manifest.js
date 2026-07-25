#!/usr/bin/env node
// gen-gfx-manifest.js - graphics manifests for the code-only reloc players.
//
// The code-only players (Default, the bar family, MusicalBlobs) ship their
// runtime code as the relocatable *-code.bin blob; the exporter only needs the
// VIC assets (fonts, sprites, colour tables, screen prefills) plus the extent
// of the zero-filled reservations. Committing a full 16 KB GFX_DONOR bank
// image per variant just to donate those few KB is wasteful, so instead this
// tool assembles each donor image to a TEMP location (the ASM stays the single
// source of truth - KickAss keeps computing the ADSR tables, screen fills,
// curtain patterns; nothing is hand-authored or re-derived here) and distils
// it into a small public/prg/<player>.gfx.json manifest:
//
//   {
//     "player": "RaistlinBars.asm",
//     "variants": ["RaistlinBars", "RaistlinBarsFFT", ...],
//     "base": "0x4000",              // bank base of the donor build
//     "size": "0x4000",              // full image extent (bank viability needs it)
//     "segments": [
//       { "name": "Screen RAM", "addr": "0x6000", "size": "0x0400" },
//       { "name": "Charset",    "addr": "0x6800", "size": "0x0800", "data": "<base64>" }
//     ]
//   }
//
// Segments follow the KickAss -showmem block list (so they keep their names),
// splitting a block further only to elide zero runs >= 256 bytes: zero runs
// become bare reservations (compose-time zeros), real bytes carry base64.
// prg-builder.js composes the manifest back into a bank image and feeds it to
// planRelocationCodeOnly exactly where the donor .bin used to go.
//
// The donor's "Main Code" block is EXCLUDED: GFX_DONOR compiles the code out,
// but data parked in the code block to soak up alignment padding (e.g. the
// WithLogo players' spriteSineTable) still assembles there. The exporter never
// reads it - the graphics blob starts at graphicsBase/colour table, and the
// code-only build carries its own copy - so the manifest drops it and every
// comparison treats the block as don't-care.
//
// Self-checks (all hard failures):
//   * every byte outside the parsed blocks must be zero (nothing lost)
//   * recomposing the manifest must reproduce the donor image byte-for-byte
//     over every non-"Main Code" block
//   * if public/prg/<Variant>-4000.bin still exists (transition), the donor
//     build must match it byte-for-byte (same bar as the donor switch)
//   * a config that names a gfxManifest must name the one computed here, so
//     variants silently diverging from a shared manifest break the build
//     loudly instead of exporting stale graphics
//
// Variants whose donor images are byte-identical (FFT/Shadow vs the live
// build) collapse into the base variant's manifest; the "variants" field
// records everyone sharing it.
//
// Usage: node scripts/gen-gfx-manifest.js   (run from the repo root)

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const BASE = 0x4000;            // donor bank base (matches the old -4000 bins)
const ZERO_RUN = 0x100;         // elide zero runs >= this many bytes

// One entry per exported player variant (mirrors the reloc list in 0-build.bat).
// Order matters for collapsing: the base (live) variant precedes its FFT/Shadow
// siblings so identical images collapse onto the base variant's manifest name.
const VARIANTS = [
    { name: 'Default', asm: 'SIDPlayers/Default/Default.asm', defines: [] },
    { name: 'DefaultWithLogo', asm: 'SIDPlayers/DefaultWithLogo/DefaultWithLogo.asm', defines: [] },
    { name: 'MusicalBlobs', asm: 'SIDPlayers/MusicalBlobs/MusicalBlobs.asm', defines: [] },
    { name: 'RaistlinBars', asm: 'SIDPlayers/RaistlinBars/RaistlinBars.asm', defines: [] },
    { name: 'RaistlinBarsFFT', asm: 'SIDPlayers/RaistlinBars/RaistlinBars.asm', defines: ['SPECTROMETER_BAKED'] },
    { name: 'RaistlinBarsShadow', asm: 'SIDPlayers/RaistlinBars/RaistlinBars.asm', defines: ['SPECTROMETER_SHADOW'] },
    { name: 'RaistlinBarsWithLogo', asm: 'SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm', defines: [] },
    { name: 'RaistlinBarsFFTWithLogo', asm: 'SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm', defines: ['SPECTROMETER_BAKED'] },
    { name: 'RaistlinBarsWithLogoShadow', asm: 'SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm', defines: ['SPECTROMETER_SHADOW'] },
    { name: 'RaistlinMirrorBars', asm: 'SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm', defines: [] },
    { name: 'RaistlinMirrorBarsFFT', asm: 'SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm', defines: ['SPECTROMETER_BAKED'] },
    { name: 'RaistlinMirrorBarsShadow', asm: 'SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm', defines: ['SPECTROMETER_SHADOW'] },
    { name: 'RaistlinMirrorBarsWithLogo', asm: 'SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm', defines: [] },
    { name: 'RaistlinMirrorBarsFFTWithLogo', asm: 'SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm', defines: ['SPECTROMETER_BAKED'] },
    { name: 'RaistlinMirrorBarsWithLogoShadow', asm: 'SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm', defines: ['SPECTROMETER_SHADOW'] },
];

const hex = (n, w = 4) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');

// GFX_DONOR build at $4000 (temp output, never committed). Returns the raw
// image plus the -showmem block list parsed from KickAss's stdout.
function buildDonor(v) {
    const out = path.join(os.tmpdir(), `gfx-${v.name}.bin`);
    const args = ['-jar', 'KickAss.jar',
        `:loadAddress=${BASE}`, `:sysAddress=${BASE + 0x100}`, `:dataAddress=${BASE}`,
        '-define', 'GFX_DONOR'];
    for (const d of v.defines) args.push('-define', d);
    args.push(v.asm, '-showmem', '-binfile', '-o', out);
    const stdout = execFileSync('java', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { image: fs.readFileSync(out), blocks: parseShowMem(stdout) };
}

// Parse the "Memory Map" section: lines like "  $6000-$63ff Screen RAM".
// End addresses are inclusive; an end below the start is an empty block
// (KickAss prints "$4100-$40ff Main Code" for a zero-length block).
function parseShowMem(stdout) {
    const blocks = [];
    let inMap = false;
    for (const line of stdout.split('\n')) {
        if (/^Memory Map/.test(line)) { inMap = true; continue; }
        if (!inMap) continue;
        const m = line.match(/^\s+\$([0-9a-f]+)-\$([0-9a-f]+)\s+(.+?)\s*$/i);
        if (!m) continue;
        const start = parseInt(m[1], 16), end = parseInt(m[2], 16);
        blocks.push({ name: m[3], start, len: end < start ? 0 : end - start + 1 });
    }
    if (!blocks.length) throw new Error('no -showmem memory map found in KickAss output');
    return blocks;
}

// Split one block into manifest segments: zero runs >= ZERO_RUN become bare
// reservations, everything between them is a base64 payload (short zero runs
// ride along inside the payload). A block with no data at all stays a single
// named reservation whatever its size.
function splitBlock(image, name, start, len) {
    const off = start - BASE;
    const seg = (addr, size, data) => {
        const s = { name, addr: hex(addr), size: hex(size) };
        if (data) s.data = data.toString('base64');
        return s;
    };
    // Maximal non-zero runs, then merge across zero gaps < ZERO_RUN.
    const runs = [];
    for (let i = 0; i < len;) {
        while (i < len && image[off + i] === 0) i++;
        if (i >= len) break;
        let j = i; while (j < len && image[off + j] !== 0) j++;
        const last = runs[runs.length - 1];
        if (last && i - last.end < ZERO_RUN) last.end = j; else runs.push({ start: i, end: j });
        i = j;
    }
    if (!runs.length) return [seg(start, len)];
    const segs = [];
    let cur = 0;
    for (const r of runs) {
        if (r.start - cur >= ZERO_RUN) {
            segs.push(seg(start + cur, r.start - cur));
        } else {
            r.start = cur;      // short leading gap rides inside the payload
        }
        segs.push(seg(start + r.start, r.end - r.start,
            Buffer.from(image.subarray(off + r.start, off + r.end))));
        cur = r.end;
    }
    if (len - cur >= ZERO_RUN) segs.push(seg(start + cur, len - cur));
    else if (len > cur) {       // short trailing gap joins the last payload
        const last = segs[segs.length - 1];
        const a = parseInt(last.addr), s = parseInt(last.size) + (len - cur);
        segs[segs.length - 1] = seg(a, s, Buffer.from(image.subarray(a - BASE, a - BASE + s)));
    }
    return segs;
}

function makeManifest(v, image, blocks) {
    // 0 = uncovered (must be zero), 1 = manifested, 2 = don't-care (Main Code)
    const covered = new Uint8Array(image.length);
    const segments = [];
    for (const b of blocks) {
        if (b.len === 0) continue;
        if (b.start < BASE || b.start + b.len > BASE + image.length) {
            throw new Error(`${v.name}: block "${b.name}" ${hex(b.start)}+${hex(b.len)} outside the image`);
        }
        const mainCode = /^Main Code$/i.test(b.name);
        covered.fill(mainCode ? 2 : 1, b.start - BASE, b.start - BASE + b.len);
        if (!mainCode) segments.push(...splitBlock(image, b.name, b.start, b.len));
    }
    // Nothing real may live outside the named blocks - a stray byte there would
    // silently vanish from the composed image.
    for (let i = 0; i < image.length; i++) {
        if (covered[i] === 0 && image[i] !== 0) {
            throw new Error(`${v.name}: non-zero byte ${hex(image[i], 2)} at ${hex(BASE + i)} outside every -showmem block`);
        }
    }
    segments.sort((a, b) => parseInt(a.addr) - parseInt(b.addr));
    const manifest = {
        player: path.basename(v.asm),
        variants: [v.name],             // extended when identical variants collapse
        base: hex(BASE),
        size: hex(image.length),
        segments,
    };
    return { manifest, dontCare: covered };
}

// Recompose a manifest into a bank image - the same logic prg-builder.js runs
// in the browser (kept trivially simple so the two can't disagree).
function compose(manifest) {
    const base = parseInt(manifest.base);
    const img = Buffer.alloc(parseInt(manifest.size));
    for (const s of manifest.segments) {
        if (!s.data) continue;
        const bytes = Buffer.from(s.data, 'base64');
        if (bytes.length !== parseInt(s.size)) throw new Error(`segment ${s.addr}: data/size mismatch`);
        bytes.copy(img, parseInt(s.addr) - base);
    }
    return img;
}

function main() {
    let failed = false;
    const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };

    // Build every variant, manifest it, and self-check the round trip over
    // every non-"Main Code" byte (the block itself is don't-care - see header).
    const results = [];
    for (const v of VARIANTS) {
        const { image, blocks } = buildDonor(v);
        const { manifest, dontCare } = makeManifest(v, image, blocks);
        const recomposed = compose(manifest);
        let diffs = 0;
        for (let i = 0; i < image.length; i++) {
            if (dontCare[i] !== 2 && recomposed[i] !== image[i]) diffs++;
        }
        if (recomposed.length !== image.length || diffs) {
            fail(`${v.name}: recomposed manifest doesn't reproduce the donor image (${diffs} byte diffs)`);
            continue;
        }
        // Transition check: while the committed donor bin still exists it must
        // match this build exactly (stale bin or drifted ASM otherwise).
        const donorBin = path.join('public', 'prg', `${v.name}-4000.bin`);
        if (fs.existsSync(donorBin)) {
            if (!fs.readFileSync(donorBin).equals(image)) fail(`${v.name}: donor build differs from committed ${donorBin}`);
        }
        results.push({ v, manifest });
    }
    if (failed) process.exit(2);

    // Collapse variants with identical manifests (FFT/Shadow vs live) onto the
    // first (base) variant's file. Keyed on manifest content, not the raw
    // image, so don't-care Main Code residue can never block a collapse.
    const groups = new Map();
    for (const r of results) {
        const { variants, ...rest } = r.manifest;
        const key = JSON.stringify(rest);
        if (!groups.has(key)) groups.set(key, r);
        else groups.get(key).manifest.variants.push(r.v.name);
    }

    // Write the unique manifests; remember each variant's canonical file so the
    // configs can be cross-checked.
    const canonical = new Map();    // variant name -> "prg/<file>"
    for (const g of groups.values()) {
        const file = `${g.v.name.toLowerCase()}.gfx.json`;
        const payload = g.manifest.segments.filter(s => s.data)
            .reduce((n, s) => n + parseInt(s.size), 0);
        fs.writeFileSync(path.join('public', 'prg', file), JSON.stringify(g.manifest, null, 2) + '\n');
        for (const name of g.manifest.variants) canonical.set(name, `prg/${file}`);
        console.log(`${file}: ${g.manifest.segments.length} segments, ${payload}B payload` +
            (g.manifest.variants.length > 1 ? ` (shared by ${g.manifest.variants.join(', ')})` : ''));
    }

    // Stale manifests (e.g. after a collapse changes shape) must not linger.
    const expected = new Set([...groups.values()].map(g => `${g.v.name.toLowerCase()}.gfx.json`));
    for (const f of fs.readdirSync(path.join('public', 'prg')).filter(f => f.endsWith('.gfx.json'))) {
        if (!expected.has(f)) fail(`stale manifest public/prg/${f} - delete it (no variant produces it any more)`);
    }

    // Config cross-check: a config naming a gfxManifest must name OUR file for
    // that variant. Catches variants diverging away from a shared manifest.
    for (const r of results) {
        const cfgPath = path.join('public', 'prg', `${r.v.name.toLowerCase()}.json`);
        if (!fs.existsSync(cfgPath)) { fail(`${r.v.name}: missing config ${cfgPath}`); continue; }
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const want = canonical.get(r.v.name);
        if (cfg.gfxManifest == null) {
            console.warn(`note: ${cfgPath} has no gfxManifest yet (expected "${want}")`);
        } else if (cfg.gfxManifest !== want) {
            fail(`${cfgPath}: gfxManifest is "${cfg.gfxManifest}" but this build produces "${want}" - variants diverged?`);
        }
    }

    process.exit(failed ? 2 : 0);
}

main();
