#!/usr/bin/env node
/**
 * test-render-determinism.js - a render depends only on the tune, never on what
 * the engine played before it.
 *
 * The bake worker keeps one module per engine for the whole page session, and
 * libsidplayfp's power-on delay is pinned precisely so a bake is reproducible
 * (vector quantisation amplifies small differences). That only holds if loading
 * a tune puts every chip, oscillator and mixer back where a fresh module has
 * them. For each engine this renders tune A on a fresh module, then in one
 * module renders A, B, A, and the selected subtune twice, and in another
 * renders B first, and checks every A matches the fresh render sample for
 * sample.
 *
 * Needs public/sidquake.wasm and public/sidplayfp.wasm; no browser.
 * Run with `node scripts/test-render-determinism.js`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RATE = 44100;
const SECONDS = 3;
// A pair that exposed each source of drift: the reSID noise tables, and
// libsidplayfp handing out its chips in heap-address order.
const TUNE_A = 'SID/drax-twine.sid';
const TUNE_B = 'SID/magnar-withlove.sid';

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

function engine(M) {
    const c = (n, r, a) => M.cwrap(n, r, a || []);
    const init = c('audio_init', null, ['number']);
    const load = c('audio_load_sid', 'number', ['number', 'number']);
    const subtune = c('audio_set_subtune', null, ['number']);
    const generate = c('audio_generate', 'number', ['number', 'number']);
    return {
        load(file) {
            const bytes = fs.readFileSync(path.join(ROOT, file));
            init(RATE);
            const p = M._malloc(bytes.length);
            M.HEAPU8.set(bytes, p);
            const r = load(p, bytes.length);
            M._free(p);
            if (r < 0) throw new Error(`${file}: load failed ${r}`);
            subtune(0);
        },
        subtune,
        render() {
            const total = RATE * SECONDS, CH = 4096, out = new Int16Array(total);
            const buf = M._malloc(CH * 2);
            let n = 0;
            while (n < total) {
                const got = generate(buf, Math.min(CH, total - n));
                if (got <= 0) break;
                out.set(new Int16Array(M.HEAPU8.buffer, buf, got), n);
                n += got;
            }
            M._free(buf);
            return out.subarray(0, n);
        },
    };
}

function compare(a, b) {
    if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
    let first = -1, max = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d && first < 0) first = i;
        if (d > max) max = d;
    }
    return first < 0 ? null : `first difference at sample ${first}, max |diff| ${max}`;
}

async function main() {
    for (const name of ['sidquake', 'sidplayfp']) {
        console.log(`${name}.wasm`);
        const fresh = engine(await instantiate(name));
        fresh.load(TUNE_A);
        const want = fresh.render();

        const e = engine(await instantiate(name));
        e.load(TUNE_A);
        const first = e.render();
        let d = compare(want, first);
        check(!d, 'a first render matches a fresh module', d || '');

        e.load(TUNE_B);
        e.render();
        e.load(TUNE_A);
        d = compare(want, e.render());
        check(!d, 'a tune loaded after another renders the same as on a fresh module', d || '');

        e.load(TUNE_A);
        e.render();
        e.subtune(0);
        d = compare(want, e.render());
        check(!d, 'selecting the subtune again restarts it exactly', d || '');

        const other = engine(await instantiate(name));
        other.load(TUNE_B);
        other.render();
        other.load(TUNE_A);
        d = compare(want, other.render());
        check(!d, 'a module whose first tune was another renders the same', d || '');
    }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
