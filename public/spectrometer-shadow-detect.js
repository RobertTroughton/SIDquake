// spectrometer-shadow-detect.js - analysis for the "shadow-register" bar method.
// See SIDPlayers/BAR_HEIGHT_METHODS.md.
//
// The shadow method avoids the double-play: the C64 redirects the play routine's
// $D4xx writes into a shadow buffer, runs play once, then replays the shadow to
// the real SID in a fixed order and reuses those values for the bars. That needs
// two things this module works out (and verifies) offline, using only existing
// exports in sidquake.wasm (no rebuild):
//   1) the per-frame write ORDER, which is baked as the replay order when it is
//      consistent enough to trust and replaced by a safe fallback when it isn't;
//   2) every SID write comes from a patchable STA $D4xx instruction, so
//      repointing them at the shadow page captures 100% of the writes. This is
//      the only check that can disqualify a tune.

const MEM_EXECUTE = 1 << 0;
const MEM_WRITE = 1 << 2;

function makeApi(module) {
    const cw = (n, r, a) => module.cwrap(n, r, a);
    return {
        cpuInit: cw('cpu_init', null, []),
        reset:   cw('cpu_reset_state_only', null, []),
        track:   cw('cpu_set_tracking', null, ['number']),
        wr:      cw('cpu_write_memory', null, ['number', 'number']),
        rd:      cw('cpu_read_memory', 'number', ['number']),
        access:  cw('cpu_get_memory_access', 'number', ['number']),
        setA:    cw('cpu_set_accumulator', null, ['number']),
        setX:    cw('cpu_set_xreg', null, ['number']),
        setY:    cw('cpu_set_yreg', null, ['number']),
        exec:    cw('cpu_execute_function', 'number', ['number', 'number']),
        record:  cw('cpu_set_record_writes', null, ['number']),
        seqLen:  cw('cpu_get_write_sequence_length', 'number', []),
        seqItem: cw('cpu_get_write_sequence_item', 'number', ['number']),
        sidWrites: cw('cpu_get_sid_writes', 'number', ['number']),
    };
}

// Load the music into CPU RAM (applying byte patches), init the tune, and step
// `frames` play calls with recording on. Returns the per-frame first-write
// orders (arrays of register offsets 0..). Leaves memory-access flags populated.
function loadAndRun(api, sidBytes, opts, patches) {
    const { initAddress, playAddress, loadAddress, subtune = 0, frames = 1500, warmup = 8 } = opts;
    const dataOffset = (sidBytes[6] << 8) | sidBytes[7];
    const hdrLoad = (sidBytes[8] << 8) | sidBytes[9];
    const musicStart = hdrLoad === 0 ? dataOffset + 2 : dataOffset;

    api.cpuInit();
    for (let i = musicStart; i < sidBytes.length; i++) api.wr((loadAddress + (i - musicStart)) & 0xffff, sidBytes[i]);
    if (patches) for (const [addr, val] of patches) api.wr(addr & 0xffff, val & 0xff);
    api.reset();
    api.track(1);

    api.setA(subtune); api.setX(subtune); api.setY(subtune);
    api.exec(initAddress, 2000000);

    const orders = [];
    for (let f = 0; f < frames; f++) {
        api.record(1);
        if (api.exec(playAddress, 100000) === 0) break;
        if (f < warmup) continue;
        const len = api.seqLen();
        const seen = new Set(), order = [];
        for (let i = 0; i < len; i++) {
            const reg = api.seqItem(i) - 0xD400;
            if (reg < 0 || reg > 0x7f) continue;
            if (!seen.has(reg)) { seen.add(reg); order.push(reg); }
        }
        orders.push(order);
    }
    return orders;
}

function dominantOrder(orders) {
    const counts = new Map();
    for (const o of orders) { if (!o.length) continue; const k = o.join(','); counts.set(k, (counts.get(k) || 0) + 1); }
    let bestKey = '', best = 0, total = 0;
    for (const [k, c] of counts) { total += c; if (c > best) { best = c; bestKey = k; } }
    return { order: bestKey ? bestKey.split(',').map(Number) : [], consistency: total ? best / total : 0, variants: counts.size, frames: total };
}

// Entries in the replay order are offsets from $D400, so chip N's registers are
// $20*N + $00..$18 - the same offsets the C64 uses to index both the mirror page
// and $D400 (see PlayMusicShadow in INC/musicplayback.asm).
const CHIP_STRIDE = 0x20;
const REGS_PER_CHIP = 25;          // $00-$18
export const MAX_SHADOW_CHIPS = 4; // the mirror page covers $D400-$D478

// Safe fallback replay order: registers descending from $18 down to $00, chips
// ascending. Used verbatim when the tune's per-frame write order isn't consistent
// enough to trust, and to fill in any register the tune never wrote so we always
// replay a full 25 per chip.
function fallbackOrder(numChips) {
    const o = [];
    for (let c = 0; c < numChips; c++) for (let r = 0x18; r >= 0x00; r--) o.push(c * CHIP_STRIDE + r);
    return o;
}
const ORDER_CONSISTENCY_MIN = 0.60;

// How much of the redirected page the player's mirror actually covers: chip 3's
// last register, $60 + $18. Matches SIDMIRROR_SIZE in SIDPlayers/INC/common.asm.
const MIRROR_BYTES = (MAX_SHADOW_CHIPS - 1) * CHIP_STRIDE + REGS_PER_CHIP;

// Two consecutive pages the tune never reads, writes or executes, searched from
// the top of RAM down (below the $D000 I/O block). Returns the first page's high
// byte, or null if the tune leaves no such pair. Reads the access map left by the
// most recent run, so call it after pass 1 and before pass 2 reinitialises it.
function pickShadowPage(api) {
    for (let page = 0xCE; page >= 0x02; page--) {
        let used = false;
        for (let off = 0; off < 0x200 && !used; off++) used = api.access(((page << 8) + off) & 0xffff) !== 0;
        if (!used) return page;
    }
    return null;
}

// Turn an observed (partial) dominant order into a full replay order covering all
// 25 registers of every chip the tune uses. Below the consistency floor we ignore
// the observation entirely and use the fallback; above it we keep the observed
// order for the offsets it covers - which preserves the tune's own cross-chip
// interleaving - and append every remaining register in fallback order. We always
// replay all 25 per chip on the C64 so init-only registers (volume, filter) and
// the odd frame that touches an extra register are never dropped.
// Exported so scripts/test-shadow-replay.js can drive the assembled player with
// the exact tables the exporter bakes.
export function buildFullOrder(observed, consistency, numChips) {
    const valid = new Set(fallbackOrder(numChips));
    const seen = new Set();
    const full = [];
    const push = r => { if (valid.has(r) && !seen.has(r)) { seen.add(r); full.push(r); } };
    if (consistency >= ORDER_CONSISTENCY_MIN) for (const r of observed) push(r);
    for (const r of fallbackOrder(numChips)) push(r);
    return full;   // exactly 25 * numChips entries
}

// Full shadow analysis. Returns:
//   { suitable, consistency, order, storeSites:[offsets in the music image],
//     redirectComplete, leakedWrites } .
export function analyzeShadow(module, sidBytes, opts) {
    const api = makeApi(module);
    const { loadAddress } = opts;
    const numChips = Math.min(Math.max(opts.numChips || 1, 1), MAX_SHADOW_CHIPS);
    const musicLen = ((sidBytes[8] << 8) | sidBytes[9]) === 0
        ? sidBytes.length - (((sidBytes[6] << 8) | sidBytes[7]) + 2)
        : sidBytes.length - ((sidBytes[6] << 8) | sidBytes[7]);

    // Pass 1: unpatched run -> write-order consistency + execute flags.
    const ord = dominantOrder(loadAndRun(api, sidBytes, opts));
    // We always produce a full 25-register replay order: the tune's detected
    // order when it's consistent enough, otherwise the safe fallback. Low
    // consistency doesn't disqualify the tune - only an un-redirectable write does (below).
    const usedFallback = !(ord.consistency >= ORDER_CONSISTENCY_MIN && ord.order.length > 0);
    const fullOrder = buildFullOrder(ord.order, ord.consistency, numChips);

    // Find STA $D4xx store sites among EXECUTED opcodes (8D abs / 9D abs,X /
    // 99 abs,Y with high byte $D4). Executed-only avoids matching data.
    const storeSites = [];   // offset within the music image of the operand high byte
    // Absolute stores whose high operand byte can be repointed at the shadow:
    // STA abs $8D, STA abs,X $9D, STA abs,Y $99, STX abs $8E, STY abs $8C.
    const STORE_OPS = new Set([0x8D, 0x9D, 0x99, 0x8E, 0x8C]);
    for (let a = loadAddress; a < loadAddress + musicLen - 2; a++) {
        if (!(api.access(a) & MEM_EXECUTE)) continue;
        if (!STORE_OPS.has(api.rd(a))) continue;
        if (api.rd(a + 2) === 0xD4) storeSites.push((a + 2 - loadAddress));
    }

    // Simulation shadow page (the exporter picks the real one). It has to be two
    // pages the tune never touches: then every access inside them during pass 2
    // came from the redirect and nothing else, which is what makes the overflow
    // check below trustworthy - and it stops the redirect corrupting the tune's
    // own data, which would make the leak check meaningless.
    const shadowHi = pickShadowPage(api) ?? 0xCE;

    // Pass 2: patch every site's high byte to the shadow page and re-run; if the
    // redirect is complete, ZERO writes should reach the real $D4xx registers.
    const patches = storeSites.map(off => [loadAddress + off, shadowHi]);
    loadAndRun(api, sidBytes, opts, patches);
    // Write counts are kept per register ($00-$1F), pooled across every chip in
    // $D400-$D7FF - so any chip's leaked write shows up here whatever its address.
    let leaked = 0;
    for (let reg = 0; reg < 0x20; reg++) leaked += api.sidWrites(reg);

    // Indexed stores (STA $D4xx,X/Y) can reach past the last register the player's
    // mirror covers - a redirected write beyond MIRROR_BYTES lands on whatever the
    // player put after the mirror (the replay-order table, for a start). Nothing in
    // the leak count catches that, since such a write never touches $D400-$D7FF.
    let overflowWrites = 0;
    for (let off = MIRROR_BYTES; off < 0x200; off++) {
        if (api.access(((shadowHi << 8) + off) & 0xffff) & MEM_WRITE) overflowWrites++;
    }
    const redirectComplete = leaked === 0 && overflowWrites === 0;

    return {
        // Shadow is usable as long as every SID write can be redirected, and lands
        // inside the mirror when it is. The per-frame order only decides whether we
        // bake the detected order or the fallback - it never blocks the tune.
        suitable: redirectComplete,
        consistency: ord.consistency,
        variants: ord.variants,
        order: fullOrder,       // 25 entries per chip, each an offset from $D400
        numChips,
        usedFallback,
        storeSites,
        redirectComplete,
        leakedWrites: leaked,
        overflowWrites,
    };
}

/**
 * How much of a tune the VU-meter bar methods can actually see.
 *
 * Both live methods claim a bar only for a voice with GATE=1, TEST=0 and a
 * waveform selected - the same test `INC/spectrometer.asm`'s AnalyseSingleVoice
 * applies. Some tunes drive the SID audibly without ever meeting it, so the
 * bars sit empty while the music plays and nothing says why. (The open case is
 * MUSICIANS/M/Mr_Mouse/Downhill_Rocks_Roll_the_Best.sid, whose first ~13.6 s
 * runs with every voice's gate closed.)
 *
 * This is a warning, not a fix: the mechanism producing that audio is not
 * understood yet (see TODO.md). Counting the frames no voice qualifies in at
 * least makes the failure legible before the user exports.
 *
 * A frame with every gate closed is completely ordinary - gates close between
 * notes - so the count alone means nothing: across the tunes in SID/ it runs
 * from 26% to 95% on tunes whose bars are perfectly fine. What matters is a long
 * *leading* stretch, and only when the tune is audible through it. So the lead-in
 * is measured against the rendered audio: a tune that genuinely opens with
 * silence is not a problem, and is not reported as one.
 *
 * @returns {{frames:number, quietFrames:number, leadingQuietFrames:number,
 *            leadingSeconds:number, leadingAudible:boolean, quietFraction:number}}
 */
export function analyzeVuVisibility(module, sidBytes, opts) {
    const api = makeApi(module);
    const numChips = Math.min(Math.max(opts.numChips || 1, 1), MAX_SHADOW_CHIPS);
    const frameHz = opts.frameHz || 50.1245;
    const { initAddress, playAddress, loadAddress, subtune = 0, frames = 1500 } = opts;

    const dataOffset = (sidBytes[6] << 8) | sidBytes[7];
    const hdrLoad = (sidBytes[8] << 8) | sidBytes[9];
    const musicStart = hdrLoad === 0 ? dataOffset + 2 : dataOffset;

    api.cpuInit();
    for (let i = musicStart; i < sidBytes.length; i++) {
        api.wr((loadAddress + (i - musicStart)) & 0xffff, sidBytes[i]);
    }
    api.reset();
    api.track(1);
    api.setA(subtune); api.setX(subtune); api.setY(subtune);
    api.exec(initAddress, 2000000);

    // Control register per voice, per chip. Chips are $20 apart in $D400-$D7FF.
    const controls = [];
    for (let chip = 0; chip < numChips; chip++) {
        const base = 0xD400 + chip * 0x20;
        controls.push(base + 0x04, base + 0x0B, base + 0x12);
    }

    let ran = 0, quiet = 0, leading = 0, stillLeading = true;
    for (let f = 0; f < frames; f++) {
        if (api.exec(playAddress, 100000) === 0) break;
        ran++;
        let audible = false;
        for (const addr of controls) {
            const ctrl = api.rd(addr);
            // bit 0 GATE, bit 3 TEST, bits 4-7 the waveform select.
            if ((ctrl & 0x01) && !(ctrl & 0x08) && (ctrl & 0xF0)) { audible = true; break; }
        }
        if (audible) { stillLeading = false; continue; }
        quiet++;
        if (stillLeading) leading++;
    }

    const leadingSeconds = leading / frameHz;
    return {
        frames: ran,
        quietFrames: quiet,
        leadingQuietFrames: leading,
        leadingSeconds,
        // Only a lead-in the listener can actually hear is a defect. Rendering
        // it costs a second or two of audio at most, and only when there is a
        // lead-in worth asking about.
        leadingAudible: leadingSeconds >= 1 && soundsDuring(module, sidBytes, subtune, leadingSeconds),
        quietFraction: ran ? quiet / ran : 0,
    };
}

/** Does the tune make a sound in its first `seconds`? */
function soundsDuring(module, sidBytes, subtune, seconds) {
    const SAMPLE_RATE = 22050;          // plenty to tell sound from silence
    const SILENCE = 0.004;              // ~-48 dB, the same floor the bake uses
    const cw = (n, r, a) => module.cwrap(n, r, a);
    const api = {
        init: cw('audio_init', null, ['number']),
        load: cw('audio_load_sid', 'number', ['number', 'number']),
        setSubtune: cw('audio_set_subtune', null, ['number']),
        generate: cw('audio_generate', 'number', ['number', 'number']),
        cleanup: cw('audio_cleanup', null, []),
    };
    let sidPtr = 0, bufPtr = 0;
    try {
        api.init(SAMPLE_RATE);
        sidPtr = module._malloc(sidBytes.length);
        module.HEAPU8.set(sidBytes, sidPtr);
        if (api.load(sidPtr, sidBytes.length) < 0) return true;   // cannot tell: do not warn
        if (subtune) api.setSubtune(subtune);
        const CHUNK = 4096;
        bufPtr = module._malloc(CHUNK * 2);
        let left = Math.floor(seconds * SAMPLE_RATE);
        while (left > 0) {
            const want = Math.min(CHUNK, left);
            const got = api.generate(bufPtr, want);
            if (got <= 0) break;
            const view = new Int16Array(module.HEAPU8.buffer, bufPtr, got);
            for (let i = 0; i < got; i++) {
                if (Math.abs(view[i] / 32768) >= SILENCE) return true;
            }
            left -= got;
        }
        return false;
    } catch (e) {
        return true;   // no measurement is not evidence of silence
    } finally {
        if (module._free) { if (bufPtr) module._free(bufPtr); if (sidPtr) module._free(sidPtr); }
        try { api.cleanup(); } catch (e) { /* best-effort */ }
    }
}

// Back-compat: just the order-consistency check.
export function detectWriteOrder(module, sidBytes, opts) {
    const api = makeApi(module);
    const ord = dominantOrder(loadAndRun(api, sidBytes, opts));
    return { ...ord, suitable: ord.consistency >= 0.90 && ord.order.length > 0 };
}
