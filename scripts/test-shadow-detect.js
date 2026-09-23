#!/usr/bin/env node
/**
 * test-shadow-detect.js - the offline checks behind the shadow-register bar
 * method and the VU-visibility warning (public/spectrometer-shadow-detect.js),
 * on tunes built here from a few bytes of 6502.
 *
 *   - Store sites are collected from the code the tune runs, so the scan has to
 *     run long enough to reach every one: a site first reached after the scan
 *     stops is left unpatched in the export, and its writes are replaced by
 *     stale mirror values every frame.
 *   - An init that takes more than 2 M cycles (Slanted's does) has to finish
 *     before play is driven, or the scan sees a half-built tune.
 *   - A play address of 0 is the interrupt handler init installed.
 *   - The audio check behind the warning runs init for subtune 0 too.
 *   - Only executed opcodes are store sites: operand bytes that happen to read
 *     8D xx D4 are not.
 *
 * Needs public/sidquake.wasm; no browser. Run with
 * `node scripts/test-shadow-detect.js`.
 */

const fs = require('fs');
const path = require('path');
const { psid, asm } = require('./lib/psid-asm.js');

const ROOT = path.join(__dirname, '..');

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
    const { analyzeShadow, soundsDuring } = await import('../public/spectrometer-shadow-detect.js');

    console.log('a store site first reached 36 s in');
    {
        const code = Uint8Array.from([
            0xa9, 0x00, 0x8d, 0x00, 0x11, 0x8d, 0x01, 0x11, 0x60,   // init: clear the frame counter
            0xee, 0x00, 0x11, 0xd0, 0x03, 0xee, 0x01, 0x11,         // play: INC counter (16-bit)
            0xad, 0x01, 0x11, 0xc9, 0x07, 0xb0, 0x04,               // counter >= $700 (1792 frames)?
            0x8d, 0x00, 0xd4, 0x60,                                 // no: STA $D400
            0x8d, 0x01, 0xd4, 0x60,                                 // yes: STA $D401
        ]);
        const bytes = psid({ play: 0x1009, code });
        const r = analyzeShadow(M, bytes, { initAddress: 0x1000, playAddress: 0x1009, loadAddress: 0x1000, subtune: 0, numChips: 1 });
        check(r.storeSites.length === 2, 'both store sites are found', `${r.storeSites.length}`);
        check(r.suitable && r.leakedWrites === 0, 'and the redirect is complete', `leaked ${r.leakedWrites}`);
    }

    console.log('an init that runs for about 4 M cycles');
    {
        const code = Uint8Array.from([
            0xa9, 0x0c, 0x85, 0xfb,                     // 12 outer passes
            0xa2, 0x00, 0xa0, 0x00,                     // outer: X = Y = 0
            0xca, 0xd0, 0xfd, 0x88, 0xd0, 0xfa,         // inner: 65536 x DEX/BNE
            0xc6, 0xfb, 0xd0, 0xf2,                     // DEC $FB / BNE outer
            0xa9, 0x01, 0x8d, 0x00, 0x11, 0x60,         // init done: flag = 1
            0xad, 0x00, 0x11, 0xf0, 0x03,               // play: only once init finished
            0x8d, 0x00, 0xd4, 0x60,                     //   STA $D400
        ]);
        const bytes = psid({ play: 0x1018, code });
        const r = analyzeShadow(M, bytes, { initAddress: 0x1000, playAddress: 0x1018, loadAddress: 0x1000, subtune: 0, numChips: 1, frames: 100 });
        check(r.storeSites.length === 1, 'play runs against the finished init', `${r.storeSites.length} site(s)`);
    }

    console.log('play address 0, handler on $0314');
    {
        const code = asm(0x1000, [
            0xa9, '<irq', 0x8d, 0x14, 0x03, 0xa9, '>irq', 0x8d, 0x15, 0x03, 0x60,
            'irq:', 0x8d, 0x00, 0xd4,           // STA $D400
            0x4c, 0x31, 0xea,                   // JMP $EA31
        ]);
        const bytes = psid({ play: 0, code });
        const r = analyzeShadow(M, bytes, { initAddress: 0x1000, playAddress: 0, loadAddress: 0x1000, subtune: 0, numChips: 1, frames: 100 });
        check(r.storeSites.length === 1 && r.storeSites[0] === 0x0d, 'the handler\'s store is found',
            JSON.stringify(r.storeSites));
    }

    console.log('operand bytes that look like a store');
    {
        // play: LDX #$8D / LDY #$D4 / STA $D400 / RTS - the first two operands
        // read 8D A0 D4, the shape of STA $D4A0.
        const code = Uint8Array.from([0x60, 0xa2, 0x8d, 0xa0, 0xd4, 0x8d, 0x00, 0xd4, 0x60]);
        const bytes = psid({ play: 0x1001, code });
        const r = analyzeShadow(M, bytes, { initAddress: 0x1000, playAddress: 0x1001, loadAddress: 0x1000, subtune: 0, numChips: 1, frames: 50 });
        check(r.storeSites.length === 1 && r.storeSites[0] === 7, 'only the real store is a site', JSON.stringify(r.storeSites));
    }

    console.log('the audio check runs init for subtune 0');
    {
        // init starts a sawtooth at full volume; play does nothing.
        const code = Uint8Array.from([
            0xa9, 0x0f, 0x8d, 0x18, 0xd4,               // volume 15
            0xa9, 0x10, 0x8d, 0x01, 0xd4,               // frequency hi
            0xa9, 0x00, 0x8d, 0x05, 0xd4,               // attack/decay 0
            0xa9, 0xf0, 0x8d, 0x06, 0xd4,               // sustain 15
            0xa9, 0x21, 0x8d, 0x04, 0xd4,               // sawtooth + gate
            0x60,
            0x60,                                       // play: RTS
        ]);
        const bytes = psid({ play: 0x101a, code });
        check(soundsDuring(M, bytes, 0, 1) === true, 'the tune is heard');
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
