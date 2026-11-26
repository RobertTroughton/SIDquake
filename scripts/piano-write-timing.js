#!/usr/bin/env node
/**
 * piano-write-timing.js - where on the screen the Piano player writes its
 * keyboard, measured in VICE.
 *
 * The keyboard is redrawn by writing colour RAM (keys, drum bar, filter bar
 * colour) and screen RAM (the filter bar's characters). A write the VIC
 * catches mid-draw tears the keyboard: part of a key in the old colour, part
 * in the new. This boots a Piano .prg in VICE, puts a watchpoint on every
 * write to the keyboard rows (drum bar row 17 to filter bar row 24: colour RAM
 * and screen RAM), and records the raster line each lands on - the monitor's
 * stop line carries the beam position. Writes on lines 187-250 (the drum bar's
 * first line to the filter bar's last) were made while that part of the screen
 * was being drawn.
 *
 * Needs VICE (`apt-get install -y vice xvfb`; ROMs from roms/), and a .prg
 * exported with the Piano visualiser (any tune; the default VIC bank layout,
 * screen at $7000, is assumed - pass --screen=XXXX if the export used another).
 *
 *   node scripts/piano-write-timing.js export.prg [--writes=400] [--screen=7000]
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { romDir } = require('./lib/seam-lib.js');

const DRUM_ROW = 17, FILTER_ROW = 24;
const FIRST_LINE = 51 + DRUM_ROW * 8, LAST_LINE = 51 + FILTER_ROW * 8 + 7;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A line-oriented client for VICE's remote (text) monitor (as seam-latency.js). */
class Monitor {
    constructor(sock) {
        this.sock = sock;
        this.buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (d) => { this.buf += d; });
    }
    static async connect(port, tries = 60) {
        for (let i = 0; i < tries; i++) {
            try {
                const sock = await new Promise((res, rej) => {
                    const s = net.connect(port, '127.0.0.1');
                    s.once('connect', () => res(s));
                    s.once('error', rej);
                });
                return new Monitor(sock);
            } catch (e) { await sleep(500); }
        }
        throw new Error('the remote monitor never came up on port ' + port);
    }
    async cmd(line, timeoutMs = 5000) {
        this.buf = '';
        this.sock.write(line + '\n');
        const end = Date.now() + timeoutMs;
        for (;;) {
            if (/\(C:\$[0-9a-f]{4}\)/i.test(this.buf)) return this.buf;
            if (Date.now() > end) return this.buf;
            await sleep(5);
        }
    }
    close() { this.sock.destroy(); }
}

(async () => {
    const args = process.argv.slice(2);
    const arg = (n, d) => (args.find(a => a.startsWith('--' + n + '=')) || '=' + d).split('=')[1];
    const prg = args.find(a => !a.startsWith('--'));
    if (!prg) { console.error('usage: piano-write-timing.js export.prg [--writes=400] [--screen=7000]'); process.exit(1); }
    const writes = Number(arg('writes', '400'));
    const screen = parseInt(arg('screen', '7000'), 16);
    const port = 6510 + Math.floor(Math.random() * 200);

    const dir = romDir(path.dirname(path.resolve(prg)));
    const viceArgs = ['-default', '-directory', dir + ':/usr/share/vice',
        '-warp', '-autostart-warp', '-sounddev', 'dummy', '-autostartprgmode', '1',
        '-remotemonitor', '-remotemonitoraddress', 'ip4://127.0.0.1:' + port, '-autostart', path.resolve(prg)];
    const headless = !process.env.DISPLAY;
    const vice = spawn(headless ? 'xvfb-run' : 'x64sc', headless ? ['-a', 'x64sc', ...viceArgs] : viceArgs,
        { stdio: 'ignore', detached: true });
    let mon;
    try {
        // Let it autostart, decompress and play a while before freezing it.
        await sleep(25000);
        mon = await Monitor.connect(port);
        await mon.cmd('', 4000);
        const hex = (n) => n.toString(16).padStart(4, '0');
        await mon.cmd(`watch store ${hex(0xD800 + DRUM_ROW * 40)} ${hex(0xD800 + FILTER_ROW * 40 + 39)}`);
        await mon.cmd(`watch store ${hex(screen + DRUM_ROW * 40)} ${hex(screen + FILTER_ROW * 40 + 39)}`);
        const lines = [];
        for (let i = 0; i < writes; i++) {
            const out = await mon.cmd('x', 15000);
            const m = /\)\s+(\d+)\/\$[0-9a-f]+,\s+(\d+)\//i.exec(out);
            if (!m) break;
            lines.push(Number(m[1]));
        }
        if (!lines.length) throw new Error('no write to the keyboard rows was seen');
        const open = lines.filter(l => l >= FIRST_LINE && l <= LAST_LINE);
        const lo = Math.min(...lines), hi = Math.max(...lines);
        console.log(`${lines.length} keyboard writes, raster lines ${lo}-${hi}`);
        console.log(`${open.length} landed on lines ${FIRST_LINE}-${LAST_LINE}, while the keyboard was being drawn`
            + (open.length ? ` (${[...new Set(open)].slice(0, 12).join(', ')}${open.length > 12 ? ', ...' : ''})` : ''));
        process.exitCode = open.length ? 1 : 0;
    } finally {
        if (mon) { try { await mon.cmd('quit', 2000); } catch (e) { /* gone */ } mon.close(); }
        try { process.kill(-vice.pid); } catch (e) { /* gone */ }
    }
})().catch(e => { console.error(e); process.exit(1); });
