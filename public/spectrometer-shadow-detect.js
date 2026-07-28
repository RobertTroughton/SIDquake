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
    const shadowHi = 0xCE;   // simulation shadow page ($CE00..); the exporter picks the real one
    // Absolute stores whose high operand byte can be repointed at the shadow:
    // STA abs $8D, STA abs,X $9D, STA abs,Y $99, STX abs $8E, STY abs $8C.
    const STORE_OPS = new Set([0x8D, 0x9D, 0x99, 0x8E, 0x8C]);
    for (let a = loadAddress; a < loadAddress + musicLen - 2; a++) {
        if (!(api.access(a) & MEM_EXECUTE)) continue;
        if (!STORE_OPS.has(api.rd(a))) continue;
        if (api.rd(a + 2) === 0xD4) storeSites.push((a + 2 - loadAddress));
    }

    // Pass 2: patch every site's high byte to the shadow page and re-run; if the
    // redirect is complete, ZERO writes should reach the real $D4xx registers.
    const patches = storeSites.map(off => [loadAddress + off, shadowHi]);
    loadAndRun(api, sidBytes, opts, patches);
    // Write counts are kept per register ($00-$1F), pooled across every chip in
    // $D400-$D7FF - so any chip's leaked write shows up here whatever its address.
    let leaked = 0;
    for (let reg = 0; reg < 0x20; reg++) leaked += api.sidWrites(reg);
    const redirectComplete = leaked === 0;

    return {
        // Shadow is usable as long as every SID write can be redirected. The
        // per-frame order only decides whether we bake the detected order or the
        // fallback - it never blocks the tune.
        suitable: redirectComplete,
        consistency: ord.consistency,
        variants: ord.variants,
        order: fullOrder,       // 25 entries per chip, each an offset from $D400
        numChips,
        usedFallback,
        storeSites,
        redirectComplete,
        leakedWrites: leaked,
    };
}

// Back-compat: just the order-consistency check.
export function detectWriteOrder(module, sidBytes, opts) {
    const api = makeApi(module);
    const ord = dominantOrder(loadAndRun(api, sidBytes, opts));
    return { ...ord, suitable: ord.consistency >= 0.90 && ord.order.length > 0 };
}
