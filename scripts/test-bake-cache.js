#!/usr/bin/env node
/**
 * test-bake-cache.js - the bake core's render cache.
 *
 * The render is ~90% of the cost of a bake, so which renders are avoided is the
 * whole performance story. Two things it must get right:
 *
 *   - A -> B -> A must not re-render A (the cache is a small LRU, not one slot).
 *   - Editing the SID's title must not invalidate anything. The bytes handed to
 *     the bake come from createModifiedSID(), so a title change rewrites the
 *     header - and hashing that header meant typing in a name threw away a
 *     finished render.
 *
 * createBakeCore takes its engine as an argument, so this drives it with a stub
 * that emulates the Emscripten audio_* surface and counts renders. No WASM, no
 * browser: run with `node scripts/test-bake-cache.js`.
 */

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

// A minimal PSID v2 header followed by `n` bytes of "music". Only the three
// 32-byte text fields at 0x16..0x75 are cosmetic; everything else changes the
// audio and must stay in the cache key.
function makeSid(seed, title = 'a title') {
    const bytes = new Uint8Array(0x7c + 64);
    const put = (off, str) => { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i); };
    put(0, 'PSID');
    bytes[4] = 0; bytes[5] = 2;         // version 2
    bytes[6] = 0; bytes[7] = 0x7c;      // dataOffset
    bytes[0x0e] = 0; bytes[0x0f] = 1;   // songs
    bytes[0x10] = 0; bytes[0x11] = 1;   // startSong
    put(0x16, title);                   // name
    put(0x36, 'an author');             // author
    put(0x56, '2026');                  // released
    for (let i = 0; i < 64; i++) bytes[0x7c + i] = (seed * 31 + i) & 0xff;
    return bytes;
}

// An engine that plays a short repeating phrase, so the loop detector settles
// quickly and a render is cheap. Every call is counted.
function stubEngine(counter) {
    const HEAP_BYTES = 1 << 20;
    const heap = new ArrayBuffer(HEAP_BYTES);
    const HEAPU8 = new Uint8Array(heap);
    let brk = 16;
    let pos = 0;
    const api = {
        audio_init: () => { pos = 0; },
        audio_load_sid: () => { counter.renders++; counter.subtune = null; return 0; },
        audio_set_subtune: (n) => { counter.subtune = n; },
        audio_set_sampling_method: () => {},
        audio_get_is_ntsc: () => 0,
        audio_cleanup: () => {},
        audio_generate: (ptr, n) => {
            const view = new Int16Array(heap, ptr, n);
            // 2 seconds of audio that repeats exactly: an unambiguous loop.
            for (let i = 0; i < n; i++) {
                const t = (pos + i) % (44100 * 2);
                view[i] = Math.round(Math.sin(t * 0.01) * 12000);
            }
            pos += n;
            return n;
        },
    };
    return {
        HEAPU8,
        _malloc: (n) => { const p = brk; brk += (n + 15) & ~15; return p; },
        _free: () => {},
        cwrap: (name) => api[name],
    };
}

(async () => {
    const { createBakeCore } = await import('../public/spectrometer-bake-core.js');
    const counter = { renders: 0 };
    const engine = stubEngine(counter);
    const core = createBakeCore(async () => engine);

    const opts = { maxSeconds: 30, numBars: 40, engine: 'resid' };
    const run = async (sid) => core.analyze(sid, opts);

    const a = makeSid(1);
    const b = makeSid(2);

    await run(a);
    const afterFirst = counter.renders;
    check(afterFirst > 0, 'a tune is rendered the first time it is analysed',
        `${afterFirst} render(s)`);
    // subtune is a 0-based index. Leaving the engine on its own start song for
    // song 1 rendered song 3 of a tune that starts on song 3.
    check(counter.subtune === 0, 'song 1 is selected explicitly, not left to the file\'s start song',
        `set_subtune(${counter.subtune})`);

    await run(a);
    check(counter.renders === afterFirst, 'analysing it again reuses the render',
        `${counter.renders} render(s)`);

    await run(b);
    const afterB = counter.renders;
    check(afterB > afterFirst, 'a different tune is rendered', `${afterB} render(s)`);

    await run(a);
    check(counter.renders === afterB, 'going back to the first tune reuses its render',
        `${counter.renders} render(s)`);

    // The whole point of skipping the header text.
    await run(makeSid(1, 'a completely different title'));
    check(counter.renders === afterB, 'renaming the tune does not throw the render away',
        `${counter.renders} render(s)`);

    // ...but a real change to the music does.
    await run(makeSid(3));
    check(counter.renders > afterB, 'changing the music does', `${counter.renders} render(s)`);

    // The cache is bounded: push past it and the oldest entry is gone.
    const before = counter.renders;
    for (let i = 10; i < 16; i++) await run(makeSid(i));
    const pushed = counter.renders;
    check(pushed === before + 6, 'each new tune costs one render',
        `${pushed - before} render(s) for 6 tunes`);
    await run(a);
    check(counter.renders > pushed, 'and the cache is bounded, not unlimited',
        `${counter.renders - pushed} render(s)`);

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
