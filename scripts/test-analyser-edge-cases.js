#!/usr/bin/env node
/**
 * test-analyser-edge-cases.js - PSID header and play-routine cases the tunes in
 * SID/ never exercise, run through the real analyser in sidquake.wasm.
 *
 * Every tune here is built in this file from a few bytes of 6502, so each case
 * isolates one rule:
 *
 *   - init address 0 means "the load address" (PSID spec);
 *   - play address 0 means init hung the player on an interrupt. The analyser
 *     must find the vector init installed ($0314 behind the KERNAL, or $FFFE with
 *     the ROMs banked out) and enter it the way an interrupt would, so a handler
 *     ending in JMP $EA31 or RTI counts as having returned;
 *   - a rejected load leaves the previously loaded tune in place;
 *   - the SID chip count covers every subtune, not the last one analysed;
 *   - a header claiming 0 songs still analyses the one it has;
 *   - operand bytes count as code, not just opcodes;
 *   - reading memory from the host leaves no access flag behind;
 *   - the CIA 1 timer is seen through its mirrors ($DC14 is $DC04), and fires
 *     every latch + 1 cycles, which decides the rounding of calls per frame;
 *   - a call that does not return reports no execution cycles, rather than the
 *     previous call's.
 *
 * Needs public/sidquake.wasm; no browser. Run with
 * `node scripts/test-analyser-edge-cases.js`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}
const hex = (v) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');

const { psid, asm } = require('./lib/psid-asm.js');

async function main() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    const M = await factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
        print: () => {}, printErr: () => {},
    });
    const cw = (n, r, a) => M.cwrap(n, r, a);
    const sid = {
        init: cw('sid_init', null, []),
        load: cw('sid_load', 'number', ['number', 'number']),
        analyze: cw('sid_analyze', 'number', ['number', 'number']),
        header: cw('sid_get_header_value', 'number', ['number']),
        modCount: cw('sid_get_modified_count', 'number', []),
        modAddr: cw('sid_get_modified_address', 'number', ['number']),
        chips: cw('sid_get_sid_chip_count', 'number', []),
        maxCycles: cw('sid_get_max_cycles', 'number', []),
        timeouts: cw('sid_get_init_timeouts', 'number', []),
        codeBytes: cw('sid_get_code_bytes', 'number', []),
        callsPerFrame: cw('sid_get_num_calls_per_frame', 'number', []),
    };
    const cpu = {
        init: cw('cpu_init', null, []),
        track: cw('cpu_set_tracking', null, ['number']),
        wr: cw('cpu_write_memory', null, ['number', 'number']),
        rd: cw('cpu_read_memory', 'number', ['number']),
        access: cw('cpu_get_memory_access', 'number', ['number']),
        exec: cw('cpu_execute_function', 'number', ['number', 'number']),
        lastCycles: cw('cpu_get_last_execution_cycles', 'number', []),
    };
    const hasPlayResolved = typeof M._sid_get_resolved_play_address === 'function';
    const resolvedPlay = hasPlayResolved ? cw('sid_get_resolved_play_address', 'number', []) : () => -1;

    function load(bytes) {
        const p = M._malloc(bytes.length);
        M.HEAPU8.set(bytes, p);
        const r = sid.load(p, bytes.length);
        M._free(p);
        return r;
    }
    function analyze(frames = 50) {
        const r = sid.analyze(frames, 0);
        const mod = new Set();
        for (let i = 0; i < sid.modCount(); i++) mod.add(sid.modAddr(i));
        return { r, mod, chips: sid.chips(), maxCycles: sid.maxCycles(), timeouts: sid.timeouts() };
    }

    sid.init();

    console.log('init address 0 is the load address');
    {
        // $1000: INC $1100 / RTS (init); $1004: RTS (play)
        const code = Uint8Array.from([0xee, 0x00, 0x11, 0x60, 0x60]);
        check(load(psid({ init: 0, play: 0x1004, code })) === 0, 'loads');
        check(sid.header(2) === 0x1000, 'header reports init at the load address', hex(sid.header(2)));
        const a = analyze();
        check(a.timeouts === 0, 'init returns', `timeouts ${a.timeouts}`);
        check(a.mod.has(0x1100), 'init\'s store is recorded');
    }

    console.log('play address 0, handler on $0314 ending in JMP $EA31');
    {
        const code = asm(0x1000, [
            // init: point the KERNAL IRQ vector at the handler
            0xa9, '<irq', 0x8d, 0x14, 0x03, 0xa9, '>irq', 0x8d, 0x15, 0x03, 0x60,
            'irq:', 0xee, 0x00, 0x11,           // INC $1100
            0x8d, 0x00, 0xd4,                   // STA $D400
            0x4c, 0x31, 0xea,                   // JMP $EA31
        ]);
        check(load(psid({ play: 0, code })) === 0, 'loads');
        const a = analyze(300);
        check(a.mod.has(0x1100), 'handler\'s RAM store is recorded');
        check(a.mod.has(0xd400), 'handler\'s SID store is recorded');
        check(a.maxCycles > 0, 'play calls return', `maxCycles ${a.maxCycles}`);
        check(a.chips === 1, 'one SID chip', `${a.chips}`);
        check(resolvedPlay() === 0x100b, 'resolved play address is the handler',
            hasPlayResolved ? hex(resolvedPlay()) : 'sid_get_resolved_play_address missing');
    }

    console.log('play address 0, handler on $FFFE ending in RTI, ROMs banked out');
    {
        const code = asm(0x1000, [
            0xa9, 0x35, 0x85, 0x01,             // LDA #$35 / STA $01
            0xa9, '<irq', 0x8d, 0xfe, 0xff, 0xa9, '>irq', 0x8d, 0xff, 0xff, 0x60,
            'irq:', 0x48,                       // PHA
            0xee, 0x01, 0x11,                   // INC $1101
            0x8d, 0x01, 0xd4,                   // STA $D401
            0x68, 0x40,                         // PLA / RTI
        ]);
        check(load(psid({ play: 0, code })) === 0, 'loads');
        const a = analyze(600);
        check(a.mod.has(0x1101), 'handler\'s RAM store is recorded');
        check(a.mod.has(0xd401), 'handler\'s SID store is recorded');
        check(a.maxCycles > 0 && a.maxCycles < 100, 'every play call returns promptly', `maxCycles ${a.maxCycles}`);
    }

    console.log('a rejected load leaves the previous tune in place');
    {
        const good = psid({ songs: 3, code: Uint8Array.from([0x60, 0x00, 0x00, 0x60]) });
        check(load(good) === 0, 'first tune loads');
        const big = psid({ load: 0xf800, init: 0xf800, play: 0xf800, songs: 7, code: new Uint8Array(0x1000).fill(0x60) });
        check(load(big) === -7, 'oversized tune is rejected with -7');
        check(sid.header(4) === 3, 'song count is still the first tune\'s', `${sid.header(4)}`);
        check(sid.header(1) === 0x1000, 'load address is still the first tune\'s', hex(sid.header(1)));
    }

    console.log('the chip count covers every subtune');
    for (const second of [0, 1]) {
        // init stores A; play writes $D400 always, and $D420 when the stored
        // song number equals `second` - so exactly one subtune uses chip 2.
        const code = asm(0x1000, [
            0x8d, 0x00, 0x11, 0x60,             // init: STA $1100 / RTS
            0x8d, 0x00, 0xd4,                   // play: STA $D400
            0xad, 0x00, 0x11, 0xc9, second,     // LDA $1100 / CMP #second
            0xd0, 0x03, 0x8d, 0x20, 0xd4,       // BNE +3 / STA $D420
            0x60,
        ]);
        check(load(psid({ play: 0x1004, songs: 2, code })) === 0, `loads (chip 2 on song ${second + 1})`);
        const a = analyze();
        check(a.chips === 2, `two chips when song ${second + 1} of 2 is the one using the second`, `${a.chips}`);
    }

    console.log('a header claiming 0 songs analyses one');
    {
        const code = Uint8Array.from([0xee, 0x00, 0x11, 0x60, 0x60]);
        check(load(psid({ play: 0x1004, songs: 0, code })) === 0, 'loads');
        const a = analyze();
        check(a.mod.has(0x1100), 'init ran', `${a.mod.size} modified`);
    }

    console.log('operand bytes count as code');
    {
        // init: LDA #$01 / STA $1100 / RTS (6 bytes); play: RTS
        const code = Uint8Array.from([0xa9, 0x01, 0x8d, 0x00, 0x11, 0x60, 0x60]);
        check(load(psid({ play: 0x1006, code })) === 0, 'loads');
        analyze();
        check(sid.codeBytes() === 7, 'all seven bytes are code', `${sid.codeBytes()}`);
    }

    console.log('a host read leaves no access flag');
    {
        cpu.init();
        cpu.track(1);
        cpu.rd(0x5000);
        check(cpu.access(0x5000) === 0, 'nothing is recorded at the address read', `${cpu.access(0x5000)}`);
        cpu.track(0);
    }

    console.log('the CIA 1 timer through a mirror, and its latch + 1 period');
    for (const [base, latch, calls] of [[0xdc14, 9827, 2], [0xdc04, 7862, 2]]) {
        // init programs the timer; the speed bit puts song 1 on it.
        const code = Uint8Array.from([
            0xa9, latch & 0xff, 0x8d, base & 0xff, base >> 8,
            0xa9, latch >> 8, 0x8d, (base + 1) & 0xff, base >> 8,
            0x60, 0x60,
        ]);
        const bytes = psid({ play: 0x100b, code });
        bytes[0x15] = 0x01;
        check(load(bytes) === 0, 'loads');
        analyze();
        check(sid.callsPerFrame() === calls, `latch ${latch} at $${base.toString(16).toUpperCase()} gives ${calls} calls a frame`,
            `${sid.callsPerFrame()}`);
    }

    console.log('a call that does not return reports no cycles');
    {
        cpu.init();
        cpu.wr(0x2000, 0x60);                            // RTS
        cpu.wr(0x2100, 0x4c); cpu.wr(0x2101, 0x00); cpu.wr(0x2102, 0x21);   // JMP $2100
        check(cpu.exec(0x2000, 1000) === 1 && cpu.lastCycles() > 0, 'a returning call reports its cycles',
            `${cpu.lastCycles()}`);
        check(cpu.exec(0x2100, 1000) === 0 && cpu.lastCycles() === 0, 'a timed-out one reports none',
            `${cpu.lastCycles()}`);
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
