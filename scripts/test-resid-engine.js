#!/usr/bin/env node
/**
 * test-resid-engine.js - the reSID engine in sidquake.wasm (wasm/sid_audio.cpp),
 * which renders the song-length scan when its fast option is picked.
 *
 * Tunes are built here from a few bytes of 6502, one rule each:
 *
 *   - pitch does not depend on how many SID writes a frame makes (each write
 *     used to clock the chip one extra cycle, so busy tunes ran sharp);
 *   - the play clock counts C64 time, not C64 time plus CPU time;
 *   - a play routine that overruns its frame leaves the stack where it was, so
 *     later calls still return where they should;
 *   - play address 0 enters the installed handler as an interrupt: one call per
 *     frame, whether it ends in RTI or JMP $EA31, and per subtune;
 *   - selecting a subtune reloads the tune and resets the frame rate, so a
 *     CIA-timed subtune's rate does not stick to the next;
 *   - every tune starts on a SID in its power-on state. A reset leaves reSID's
 *     envelope counters where the last tune left them, and a gate opened on a
 *     counter at $FF freezes it at zero, so every second tune loaded into one
 *     engine played silent.
 *
 * Needs public/sidquake.wasm; no browser. Run with `node scripts/test-resid-engine.js`.
 */

const fs = require('fs');
const path = require('path');
const { psid, asm } = require('./lib/psid-asm.js');

const ROOT = path.join(__dirname, '..');
const RATE = 44100;

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

async function main() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    const M = await factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
        print: () => {}, printErr: () => {},
    });
    const cw = (n, r, a) => M.cwrap(n, r, a);
    const A = {
        init: cw('audio_init', null, ['number']),
        load: cw('audio_load_sid', 'number', ['number', 'number']),
        subtune: cw('audio_set_subtune', null, ['number']),
        generate: cw('audio_generate', 'number', ['number', 'number']),
        time: cw('audio_get_play_time', 'number', []),
    };
    const peek = typeof M._audio_peek === 'function' ? cw('audio_peek', 'number', ['number']) : () => NaN;

    function start(bytes, subtune = 0) {
        A.init(RATE);
        const p = M._malloc(bytes.length);
        M.HEAPU8.set(bytes, p);
        const r = A.load(p, bytes.length);
        M._free(p);
        if (r < 0) throw new Error('load failed ' + r);
        A.subtune(subtune);
    }
    function render(seconds) {
        const total = Math.round(seconds * RATE), out = new Float32Array(total);
        const CH = 4096, buf = M._malloc(CH * 2);
        let n = 0;
        while (n < total) {
            const got = A.generate(buf, Math.min(CH, total - n));
            if (got <= 0) break;
            const v = new Int16Array(M.HEAPU8.buffer, buf, got);
            for (let i = 0; i < got; i++) out[n + i] = v[i] / 32768;
            n += got;
        }
        M._free(buf);
        return out.subarray(0, n);
    }
    // Frequency from rising mean-crossings, interpolated between samples.
    function pitch(x) {
        const skip = RATE >> 2;
        let mean = 0;
        for (let i = skip; i < x.length; i++) mean += x[i];
        mean /= x.length - skip;
        let first = -1, last = -1, count = 0;
        for (let i = skip + 1; i < x.length; i++) {
            const a = x[i - 1] - mean, b = x[i] - mean;
            if (a < 0 && b >= 0) {
                const t = i - 1 + a / (a - b);
                if (first < 0) first = t; else count++;
                last = t;
            }
        }
        return count * RATE / (last - first);
    }

    // init: triangle at freq $1CD6 (433.5 Hz), full volume, gate on.
    // play: rewrite the frequency low byte `writes` times.
    const tone = (writes) => {
        const play = [];
        for (let i = 0; i < writes; i++) play.push(0x8d, 0x00, 0xd4);   // STA $D400 (A = $D6)
        play.push(0x60);
        const init = [
            0xa9, 0x0f, 0x8d, 0x18, 0xd4, 0xa9, 0x1c, 0x8d, 0x01, 0xd4,
            0xa9, 0x00, 0x8d, 0x05, 0xd4, 0xa9, 0xf0, 0x8d, 0x06, 0xd4,
            0xa9, 0x11, 0x8d, 0x04, 0xd4, 0xa9, 0xd6, 0x8d, 0x00, 0xd4, 0x60,
        ];
        const code = Uint8Array.from([...init, 0xa9, 0xd6, ...play]);
        return psid({ play: 0x1000 + init.length, code });
    };

    console.log('pitch does not depend on the number of SID writes per frame');
    {
        start(tone(0));
        const quiet = pitch(render(10));
        start(tone(100));
        const busy = pitch(render(10));
        const cents = 1200 * Math.log2(busy / quiet);
        check(Math.abs(cents) < 0.5, '100 writes a frame play at the same pitch as none',
            `${quiet.toFixed(2)} Hz vs ${busy.toFixed(2)} Hz (${cents.toFixed(2)} cents)`);
    }

    console.log('each tune loaded into the engine is heard');
    {
        const rms = (x) => { let t = 0; for (const v of x) t += v * v; return Math.sqrt(t / x.length); };
        const levels = [];
        for (let k = 0; k < 3; k++) { start(tone(0)); levels.push(rms(render(0.5))); }
        check(levels.every((l) => Math.abs(l - levels[0]) < 0.002), 'three loads play at the same level',
            levels.map((l) => l.toFixed(4)).join(' '));
    }

    console.log('the play clock counts C64 time');
    {
        // play burns about 2,600 cycles.
        const code = Uint8Array.from([0x60, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x60]);
        start(psid({ play: 0x1001, code }));
        render(6);
        const t = A.time();
        check(Math.abs(t - 6) < 0.02, '6 s of audio reads as 6 s', `${t.toFixed(3)} s`);
    }

    console.log('an overrunning play call leaves the stack where it was');
    {
        // Odd calls spin past the frame; even calls JSR a subroutine that
        // increments $1100. 200 frames: 100 increments if every good call returns.
        const code = asm(0x1000, [
            0x60,                                   // init: RTS
            'play:', 0xee, 0x01, 0x11,              // INC $1101 (call count)
            0xad, 0x01, 0x11, 0x29, 0x01,           // LDA $1101 / AND #1
            0xf0, 0x03, 0x4c, '<spin', '>spin',     // BEQ good / JMP spin
            'good:', 0x20, '<sub', '>sub', 0x60,    // JSR sub / RTS
            'sub:', 0xee, 0x00, 0x11, 0x60,         // INC $1100 / RTS
            'spin:', 0x4c, '<spin', '>spin',        // JMP spin
        ]);
        start(psid({ play: 0x1001, code }));
        render(200 / 50.1245);
        const calls = peek(0x1101), good = peek(0x1100);
        check(good === (calls >> 1), 'every returning call counts', `${good} of ${calls >> 1} (${calls} calls)`);
    }

    for (const exit of ['RTI', 'JMP $EA31']) {
        console.log(`play address 0, handler ending in ${exit}`);
        const viaKernal = exit !== 'RTI';
        const code = asm(0x1000, viaKernal ? [
            0xa9, '<irq', 0x8d, 0x14, 0x03, 0xa9, '>irq', 0x8d, 0x15, 0x03, 0x60,
            'irq:', 0xee, 0x00, 0x11, 0x4c, 0x31, 0xea,
        ] : [
            0xa9, 0x35, 0x85, 0x01,
            0xa9, '<irq', 0x8d, 0xfe, 0xff, 0xa9, '>irq', 0x8d, 0xff, 0xff, 0x60,
            'irq:', 0x48, 0xee, 0x00, 0x11, 0x68, 0x40,
        ]);
        start(psid({ play: 0, code }));
        render(2);
        const calls = peek(0x1100);
        check(Math.abs(calls - 100) <= 2, 'one call per frame', `${calls} calls in 2 s`);
    }

    console.log('selecting a subtune reloads the tune and its play routine');
    {
        // init counts its runs in $1102 and hangs handler 1 or 2 on $0314 by song.
        const code = asm(0x1000, [
            0xee, 0x02, 0x11,                       // INC $1102
            0xc9, 0x00, 0xd0, 0x0b,                 // CMP #0 / BNE song2
            0xa9, '<h1', 0x8d, 0x14, 0x03, 0xa9, '>h1', 0x8d, 0x15, 0x03, 0x60,
            'song2:', 0xa9, '<h2', 0x8d, 0x14, 0x03, 0xa9, '>h2', 0x8d, 0x15, 0x03, 0x60,
            'h1:', 0xee, 0x00, 0x11, 0x4c, 0x31, 0xea,
            'h2:', 0xee, 0x01, 0x11, 0x4c, 0x31, 0xea,
        ]);
        start(psid({ play: 0, songs: 2, code }), 0);
        render(0.5);
        A.subtune(1);
        render(1);
        check(peek(0x1102) === 1, 'init runs on a fresh copy of the tune', `init count ${peek(0x1102)}`);
        check(peek(0x1100) === 0 && peek(0x1101) > 40, 'song 2 plays its own handler',
            `h1 ${peek(0x1100)}, h2 ${peek(0x1101)}`);
    }

    console.log('a CIA-timed subtune does not set the rate of the next');
    {
        // Song 1 is CIA-timed at twice the frame rate; song 2 is vsync. Play
        // counts calls in $1100.
        const code = Uint8Array.from([
            0xc9, 0x00, 0xd0, 0x0a,                 // init: song 2 skips the timer
            0xa9, 0x67, 0x8d, 0x04, 0xdc, 0xa9, 0x26, 0x8d, 0x05, 0xdc,   // $2667 = 9831
            0x60,
            0xee, 0x00, 0x11, 0x60,                 // play: INC $1100
        ]);
        const bytes = psid({ play: 0x100f, songs: 2, code });
        bytes[0x15] = 0x01;                          // speed: song 1 on the CIA timer
        start(bytes, 0);
        render(1);
        A.subtune(1);
        render(2);
        const calls = peek(0x1100);
        check(Math.abs(calls - 100) <= 2, 'song 2 plays at the frame rate', `${calls} calls in 2 s`);
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
