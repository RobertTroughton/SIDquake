#!/usr/bin/env node
/**
 * test-goldens.js - whole-tune regression over the SID/ corpus.
 *
 * For each tune, and each of its first few subtunes, this pins what the
 * emulation produces today so a change to the 6510 core, either SID engine or
 * the analyser shows up as a named difference rather than a vague "sounds
 * different":
 *
 *   analysis   every sid_analyze result the exporter reads (memory map, zero
 *              page, SID register write counts, chips, calls per frame, cycle
 *              figures), over ANALYSIS_FRAMES play calls per subtune;
 *   trace      every SID register write the analyser CPU makes, address and
 *              value in order, hashed per block of TRACE_BLOCK play calls, so a
 *              failure names the first block that moved;
 *   resid      a hash of the reSID engine's output (sidquake.wasm);
 *   sidplayfp  a hash of the libsidplayfp engine's output (sidplayfp.wasm).
 *
 * Every audio render starts from a freshly instantiated module: renders are
 * only reproducible that way (see TODO.md, "Renders are reproducible only on a
 * fresh module").
 *
 * Fixtures live in scripts/goldens/<tune>.json. A deliberate change to what the
 * emulation produces is recorded with --update, and the commit that moves a
 * golden says why. CI never passes --update.
 *
 * Usage:
 *   node scripts/test-goldens.js            fast tier (FAST below)
 *   node scripts/test-goldens.js --full     every tune in SID/
 *   node scripts/test-goldens.js --only=Flex-Lundia,drax-twine
 *   node scripts/test-goldens.js --update   rewrite the fixtures for the tunes run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SID_DIR = path.join(ROOT, 'SID');
const GOLDEN_DIR = path.join(__dirname, 'goldens');

const MAX_SUBTUNES = 4;
const ANALYSIS_FRAMES = 1500;
const TRACE_CALLS = 3000;
const TRACE_BLOCK = 500;
const INIT_CYCLE_CAP = 20000000;
const PLAY_CYCLE_CAP = 20000;
const RATE = 44100;
const AUDIO_SECONDS = 4;
const SAMPLING_INTERPOLATE = 1;

// One of each kind the corpus has: 1SID, 2SID, 3SID, multi-song, CIA
// multispeed, digi, play address 0, long init.
const FAST = [
    'Flex-Lundia', 'JCH-Crystalline', 'Blending_Mode', 'Phat_Frog_2SID',
    'shogoon-cheezzytop-3SID', 'martingalway-parallax-multisong', 'drax-twine',
    'robhubbard-thingonaspring', 'mrmouse-downhill', 'toggle-fireflies',
    'steel-DespaSIDo', 'magnar-airwolf',
];

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const FULL = args.includes('--full');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').filter(Boolean) : null;

const hash = (data) => crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);

async function instantiate(name) {
    const factory = require(path.join(ROOT, `public/${name}.js`));
    return factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, `public/${name}.wasm`)),
        print: () => {}, printErr: () => {},
    });
}

function withBytes(M, bytes, fn) {
    const p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    try { return fn(p); } finally { M._free(p); }
}

const be16 = (b, o) => (b[o] << 8) | b[o + 1];

function header(bytes) {
    const dataOffset = be16(bytes, 6);
    const hdrLoad = be16(bytes, 8);
    const loadAddress = hdrLoad === 0 ? (bytes[dataOffset] | (bytes[dataOffset + 1] << 8)) : hdrLoad;
    return {
        loadAddress,
        musicStart: hdrLoad === 0 ? dataOffset + 2 : dataOffset,
        initAddress: be16(bytes, 10) || loadAddress,
        playAddress: be16(bytes, 12),
        songs: Math.max(1, be16(bytes, 14)),
    };
}

async function analysisGolden(M, bytes) {
    const c = (n, r, a) => M.cwrap(n, r, a || []);
    if (withBytes(M, bytes, (p) => c('sid_load', 'number', ['number', 'number'])(p, bytes.length)) < 0) {
        return { loadError: true };
    }
    const rc = c('sid_analyze', 'number', ['number', 'number'])(ANALYSIS_FRAMES, 0);
    if (rc < 0) return { analyzeError: rc };
    const list = (countFn, itemFn) => {
        const n = c(countFn, 'number')(), item = c(itemFn, 'number', ['number']), out = [];
        for (let i = 0; i < n; i++) out.push(item(i));
        return out;
    };
    const modified = list('sid_get_modified_count', 'sid_get_modified_address');
    const regWrites = [];
    for (let r = 0; r < 32; r++) regWrites.push(c('sid_get_sid_writes', 'number', ['number'])(r));
    return {
        modifiedCount: modified.length,
        modifiedHash: hash(Uint32Array.from(modified)),
        zeroPage: list('sid_get_zp_count', 'sid_get_zp_address'),
        codeBytes: c('sid_get_code_bytes', 'number')(),
        dataBytes: c('sid_get_data_bytes', 'number')(),
        sidRegisterWrites: regWrites,
        chips: list('sid_get_sid_chip_count', 'sid_get_sid_chip_address'),
        resolvedPlayAddress: c('sid_get_resolved_play_address', 'number')(),
        callsPerFrame: c('sid_get_num_calls_per_frame', 'number')(),
        ciaTimerValue: c('sid_get_cia_timer_value', 'number')(),
        maxCycles: c('sid_get_max_cycles', 'number')(),
        initTimeouts: c('sid_get_init_timeouts', 'number')(),
        longestInitCycles: c('sid_get_longest_init_cycles', 'number')(),
    };
}

// Drive the analyser CPU directly: init, then play calls, recording every SID
// write (address and the value it left) in order.
async function traceGolden(M, bytes, subtune) {
    const c = (n, r, a) => M.cwrap(n, r, a || []);
    const h = header(bytes);
    c('cpu_init', null)();
    c('cpu_setup_c64_env', null)();
    const music = bytes.subarray(h.musicStart, Math.min(bytes.length, h.musicStart + 0x10000 - h.loadAddress));
    withBytes(M, music, (p) => c('cpu_load_memory', null, ['number', 'number', 'number'])(h.loadAddress, p, music.length));
    c('cpu_reset_state_only', null)();
    c('cpu_set_tracking', null, ['number'])(1);
    for (const r of ['cpu_set_accumulator', 'cpu_set_xreg', 'cpu_set_yreg']) c(r, null, ['number'])(subtune);
    const exec = c('cpu_execute_function', 'number', ['number', 'number']);
    if (!exec(h.initAddress, INIT_CYCLE_CAP)) return { initReturned: false };

    let play;
    if (h.playAddress) play = () => exec(h.playAddress, PLAY_CYCLE_CAP);
    else {
        const handler = c('cpu_get_irq_handler', 'number')();
        const irq = c('cpu_execute_interrupt', 'number', ['number', 'number', 'number']);
        play = () => irq(handler & 0xffff, PLAY_CYCLE_CAP, handler > 0xffff ? 1 : 0);
    }
    const record = c('cpu_set_record_writes', null, ['number']);
    const seqLen = c('cpu_get_write_sequence_length', 'number');
    const seqItem = c('cpu_get_write_sequence_item', 'number', ['number']);
    const rd = c('cpu_read_memory', 'number', ['number']);

    const blocks = [];
    let calls = 0, writes = 0, block = [];
    for (; calls < TRACE_CALLS; calls++) {
        record(1);
        if (!play()) break;
        const n = seqLen();
        for (let i = 0; i < n; i++) {
            const a = seqItem(i);
            block.push(a & 0xff, a >> 8, rd(a));
        }
        writes += n;
        record(0);
        if ((calls + 1) % TRACE_BLOCK === 0) { blocks.push(hash(Uint8Array.from(block))); block = []; }
    }
    if (block.length) blocks.push(hash(Uint8Array.from(block)));
    return { calls, writes, blocks };
}

async function audioGolden(engine, bytes, subtune) {
    const M = await instantiate(engine);
    const c = (n, r, a) => M.cwrap(n, r, a || []);
    c('audio_init', null, ['number'])(RATE);
    if (withBytes(M, bytes, (p) => c('audio_load_sid', 'number', ['number', 'number'])(p, bytes.length)) < 0) {
        return 'load-error';
    }
    c('audio_set_subtune', null, ['number'])(subtune);
    c('audio_set_sampling_method', null, ['number'])(SAMPLING_INTERPOLATE);
    const total = RATE * AUDIO_SECONDS, CH = 4096;
    const buf = M._malloc(CH * 2), out = new Int16Array(total);
    let n = 0;
    while (n < total) {
        const got = c('audio_generate', 'number', ['number', 'number'])(buf, Math.min(CH, total - n));
        if (got <= 0) break;
        out.set(new Int16Array(M.HEAPU8.buffer, buf, got), n);
        n += got;
    }
    M._free(buf);
    return `${n}:${hash(new Uint8Array(out.buffer, 0, n * 2))}`;
}

async function goldenFor(file) {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const subtunes = Math.min(MAX_SUBTUNES, header(bytes).songs);
    // The analyser starts from cpu_init / sid_load every time, so one module
    // serves every analysis and trace of a tune. (Instantiating sidquake.wasm
    // costs ~0.6 s, so the audio renders are the only ones that pay it.)
    const analyser = await instantiate('sidquake');
    const out = { analysis: await analysisGolden(analyser, bytes), subtunes: [] };
    for (let s = 0; s < subtunes; s++) {
        out.subtunes.push({
            trace: await traceGolden(analyser, bytes, s),
            resid: await audioGolden('sidquake', bytes, s),
            sidplayfp: await audioGolden('sidplayfp', bytes, s),
        });
    }
    return out;
}

// Paths where the two goldens differ, e.g. "subtunes[0].trace.blocks[3]".
function diff(want, got, at = '') {
    if (typeof want !== 'object' || want === null || typeof got !== 'object' || got === null) {
        return want === got ? [] : [`${at || '(root)'}: ${JSON.stringify(want)} -> ${JSON.stringify(got)}`];
    }
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    const out = [];
    for (const k of keys) {
        const p = Array.isArray(want) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
        out.push(...diff(want[k], got[k], p));
    }
    return out;
}

async function main() {
    const all = fs.readdirSync(SID_DIR).filter((f) => f.endsWith('.sid')).map((f) => f.slice(0, -4)).sort();
    const names = ONLY || (FULL ? all : FAST);
    if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR);

    let failures = 0;
    const t0 = Date.now();
    for (const name of names) {
        const file = path.join(SID_DIR, `${name}.sid`);
        if (!fs.existsSync(file)) { console.log(`  FAIL ${name}: no such tune in SID/`); failures++; continue; }
        const got = await goldenFor(file);
        const gfile = path.join(GOLDEN_DIR, `${name}.json`);
        if (UPDATE) {
            fs.writeFileSync(gfile, JSON.stringify(got, null, 1) + '\n');
            console.log(`  wrote ${name}`);
            continue;
        }
        if (!fs.existsSync(gfile)) { console.log(`  FAIL ${name}: no golden (run with --update)`); failures++; continue; }
        const d = diff(JSON.parse(fs.readFileSync(gfile, 'utf8')), JSON.parse(JSON.stringify(got)));
        if (d.length) {
            failures++;
            console.log(`  FAIL ${name}`);
            for (const line of d.slice(0, 8)) console.log(`         ${line}`);
            if (d.length > 8) console.log(`         ... ${d.length - 8} more`);
        } else {
            console.log(`  ok   ${name}`);
        }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (UPDATE) { console.log(`updated ${names.length} golden(s) in ${secs}s`); return; }
    console.log(failures ? `\n${failures} tune(s) differ from their goldens (${secs}s)` : `\nall goldens match (${secs}s)`);
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
