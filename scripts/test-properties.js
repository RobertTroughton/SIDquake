#!/usr/bin/env node
/**
 * test-properties.js - seeded properties over generated input.
 *
 * The PSID header is read in three places: the analyser (sid_processor.cpp)
 * and the reSID engine (sid_audio.cpp) share c64env::parse_psid, and the JS
 * analysis code has public/psid.js. Starting from real tunes in SID/, this
 * corrupts header fields and lengths at random and checks, for every file:
 *
 *   - nothing throws or aborts the module;
 *   - the analyser and the reSID engine accept and reject the same files with
 *     the same code (except RSID, which the analyser alone refuses, -3);
 *   - a file the analyser accepts is one psid.js reads, with the same load,
 *     init and play addresses, song count and start song;
 *   - sid_analyze gives the same answer twice in a row on the same file.
 *
 * Needs public/sidquake.wasm; no browser. `--cases=N` (default 1500) and
 * `--seed=S` change the run. Run with `node scripts/test-properties.js`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (name, dflt) => {
    const a = process.argv.find((x) => x.startsWith(`--${name}=`));
    return a ? Number(a.split('=')[1]) : dflt;
};
const CASES = arg('cases', 1500);
const SEED = arg('seed', 0x51D);

let failures = 0;
function fail(what, detail) {
    if (failures < 10) console.log(`  FAIL ${what}  ${detail}`);
    failures++;
}

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (Math.imul(a ^ (a >>> 15), 1 | a) + 0x6D2B79F5) >>> 0; return a / 0x100000000; };
}

async function main() {
    const { parseSidHeader } = await import('../public/psid.js');
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    let M = null;
    const fresh = async () => {
        M = await factory({ wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')), print() {}, printErr() {} });
    };
    await fresh();
    const call = (name, bytes) => {
        const p = M._malloc(bytes.length);
        M.HEAPU8.set(bytes, p);
        try { return M[`_${name}`](p, bytes.length); } finally { M._free(p); }
    };

    const seeds = fs.readdirSync(path.join(ROOT, 'SID')).filter((f) => f.endsWith('.sid'))
        .map((f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'SID', f))));
    const r = rng(SEED);
    const pick = (n) => Math.floor(r() * n);
    // Header offsets worth corrupting: magic, version, data offset, load/init/
    // play, songs, start song, speed, flags, second/third SID address.
    const FIELDS = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 0x12, 0x15, 0x76, 0x77, 0x7a, 0x7b];

    let accepted = 0;
    for (let i = 0; i < CASES; i++) {
        const base = seeds[pick(seeds.length)];
        let bytes = base.slice();
        for (let k = 1 + pick(3); k > 0; k--) bytes[FIELDS[pick(FIELDS.length)]] = pick(4) ? pick(256) : [0, 1, 0x7c, 0xff][pick(4)];
        if (pick(5) === 0) bytes = bytes.slice(0, pick(bytes.length + 1));
        const label = `case ${i}`;

        let analyser, resid, js;
        try {
            analyser = call('sid_load', bytes);
            M._audio_init(44100);
            resid = call('audio_load_sid', bytes);
        } catch (e) {
            fail(`${label}: a load threw`, String(e.message || e));
            await fresh();
            continue;
        }
        js = parseSidHeader(bytes);

        const rsid = bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RSID';
        const want = analyser === -3 && rsid ? 0 : analyser;
        if (resid !== want) fail(`${label}: the engines disagree`, `analyser ${analyser}, reSID ${resid}`);

        if (analyser === 0) {
            accepted++;
            const h = (f) => M._sid_get_header_value(f);
            const c = [h(1), h(2), h(3), h(4), h(5)].join();
            const j = js && [js.loadAddress, js.initAddress, js.playAddress, js.songs, js.startSong].join();
            if (c !== j) fail(`${label}: psid.js reads it differently`, `C++ ${c}, JS ${j}`);

            if (i % 25 === 0) {
                const once = () => {
                    M._sid_analyze(50, 0);
                    return [M._sid_get_modified_count(), M._sid_get_zp_count(), M._sid_get_sid_chip_count(),
                        M._sid_get_max_cycles(), M._sid_get_num_calls_per_frame()].join();
                };
                try {
                    const a = once(), b = once();
                    if (a !== b) fail(`${label}: sid_analyze differs on a second run`, `${a} / ${b}`);
                } catch (e) {
                    fail(`${label}: sid_analyze threw`, String(e.message || e));
                    await fresh();
                }
            }
        }
    }
    console.log(`  ${CASES} generated files, ${accepted} accepted by the analyser (seed ${SEED})`);
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
