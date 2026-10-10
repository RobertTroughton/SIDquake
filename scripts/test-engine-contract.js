#!/usr/bin/env node
/**
 * test-engine-contract.js - the two audio engines keep one audio_* contract.
 *
 * sidplayfp.wasm (sidplayfp_audio.cpp) plays; sidquake.wasm's reSID engine
 * (sid_audio.cpp) renders for the song-length scan's fast option and the VU
 * warning. JS drives both through the same audio_* calls, so for every tune in
 * a small set they must agree on what the header says: subtune count and start
 * song, chip count, PAL/NTSC, the chip model the header asks for and the model
 * reported after a forced choice and after going back to the header's (0).
 * Both must also render the requested number of samples.
 *
 * Needs public/sidquake.wasm and public/sidplayfp.wasm; no browser.
 * Run with `node scripts/test-engine-contract.js`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RATE = 44100;
const TUNES = [
    'Flex-Lundia', 'JCH-Crystalline', 'Phat_Frog_2SID', 'MCH-MontyOnTheRunDnBEdit-2SID',
    'shogoon-cheezzytop-3SID', 'martingalway-parallax-multisong', 'Steel-92littleshortyrockers',
    'robhubbard-thingonaspring',
];

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

async function instantiate(name) {
    const factory = require(path.join(ROOT, `public/${name}.js`));
    return factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, `public/${name}.wasm`)),
        print: () => {}, printErr: () => {},
    });
}

function describe(M, bytes) {
    const c = (n, r, a) => M.cwrap(n, r, a || []);
    c('audio_init', null, ['number'])(RATE);
    const p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    const loaded = c('audio_load_sid', 'number', ['number', 'number'])(p, bytes.length);
    M._free(p);
    c('audio_set_subtune', null, ['number'])(0);
    const setModel = c('audio_set_model', null, ['number']);
    const model = c('audio_get_sid_model', 'number');
    const out = {
        loaded,
        songs: c('audio_get_subtune_count', 'number')(),
        startSong: c('audio_get_default_subtune', 'number')(),
        chips: c('audio_get_sid_count', 'number')(),
        ntsc: c('audio_get_is_ntsc', 'number')(),
        model: model(),
    };
    setModel(8580);
    out.forced = model();
    setModel(0);
    out.header = model();
    const buf = M._malloc(4096 * 2);
    out.rendered = c('audio_generate', 'number', ['number', 'number'])(buf, 4096);
    M._free(buf);
    return out;
}

async function main() {
    const resid = await instantiate('sidquake');
    const fp = await instantiate('sidplayfp');
    for (const name of TUNES) {
        const bytes = fs.readFileSync(path.join(ROOT, 'SID', `${name}.sid`));
        const a = describe(resid, bytes), b = describe(fp, bytes);
        const same = JSON.stringify(a) === JSON.stringify(b);
        check(same && a.loaded === 0 && a.forced === 8580 && a.rendered === 4096, name,
            same ? JSON.stringify(a) : `reSID ${JSON.stringify(a)}\n         sidplayfp ${JSON.stringify(b)}`);
    }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
