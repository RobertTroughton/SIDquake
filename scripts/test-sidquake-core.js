#!/usr/bin/env node
/**
 * test-sidquake-core.js - starting the page's analyser leaves the sidquake.wasm
 * module factory where the other loaders expect it.
 *
 * sidquake.js defines the factory as the global SIDquakeModule. The bake's
 * page-side fallback (spectrometer-bake-runner.js) and the loop pre-pass call
 * that factory for an instance of their own, so SIDAnalyzer must not replace
 * the global with the instance it made: a factory that has become an object
 * makes every one of those loads throw.
 *
 * It also checks that analyze() reports every address the tune writes,
 * including $FFFF and zero-page $FF, each subtune's calls per frame, and the
 * play calls that stopped the analysis.
 *
 * Needs public/sidquake.wasm; no browser. Run with
 * `node scripts/test-sidquake-core.js`.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { psid, asm } = require('./lib/psid-asm.js');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

(async () => {
    const wasmBinary = fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm'));
    const glue = require(path.join(ROOT, 'public/sidquake.js'));
    const factory = (opts = {}) => glue({ wasmBinary, print: () => {}, printErr: () => {}, ...opts });

    const window = { SIDquakeModule: factory };
    const context = vm.createContext({ window, console });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/sidquake-core.js'), 'utf8'), context);

    console.log('SIDAnalyzer start-up');
    const analyzer = new window.SIDAnalyzer();
    check(await analyzer.initPromise === true, 'the analyser starts');
    check(typeof window.SIDquakeModule === 'function', 'window.SIDquakeModule is still the factory',
        typeof window.SIDquakeModule);
    check(window.SIDquakeModuleInstance === analyzer.Module, 'the shared instance is published separately');

    console.log('analyze() reports the top address of each range');
    // init: LDA #1; STA $FFFF; STA $FF; RTS   play: RTS
    const tune = psid({ load: 0x1000, init: 0x1000, play: 0x1008, code: asm(0x1000, [
        0xa9, 0x01, 0x8d, 0xff, 0xff, 0x85, 0xff, 0x60,
        0x60,
    ]) });
    await analyzer.loadSID(tune.buffer);
    const result = await analyzer.analyze(10);
    check(result.modifiedAddresses.includes(0xFFFF), '$FFFF is in modifiedAddresses',
        result.modifiedAddresses.map((a) => a.toString(16)).join(','));
    check(result.zpAddresses.includes(0xFF), 'zero-page $FF is in zpAddresses',
        result.zpAddresses.map((a) => a.toString(16)).join(','));

    console.log('analyze() reports each subtune\'s rate and its play timeouts');
    {
        // init: CMP #1 / BNE done / CIA timer latch 4913 (4 calls a frame) / done: RTS.
        // play: INC $1100 / LDA $1100 / CMP #5 / BEQ hang / RTS / hang: JMP hang
        const code = asm(0x1000, [
            0xc9, 0x01, 0xd0, 0x0a,
            0xa9, 4913 & 0xff, 0x8d, 0x04, 0xdc, 0xa9, 4913 >> 8, 0x8d, 0x05, 0xdc,
            0x60,
            'play:', 0xee, 0x00, 0x11, 0xad, 0x00, 0x11, 0xc9, 5, 0xf0, 0x01, 0x60,
            'hang:', 0x4c, '<hang', '>hang',
        ]);
        const bytes = psid({ play: 0x100f, songs: 2, code });
        bytes[0x15] = 0x02;
        await analyzer.loadSID(bytes.buffer);
        const r = await analyzer.analyze(20);
        check(JSON.stringify(r.callsPerFrameBySong) === '[1,4]', 'callsPerFrameBySong', JSON.stringify(r.callsPerFrameBySong));
        check(r.playTimeouts === 2, 'playTimeouts', `${r.playTimeouts}`);
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
