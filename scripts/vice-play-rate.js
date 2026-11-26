#!/usr/bin/env node
/**
 * vice-play-rate.js - is an exported player calling the tune's play routine
 * every frame? Measured in VICE.
 *
 * The music frame call is raster-driven, and INC/multicallirq.asm drops it
 * when the previous frame's work is still running (its overload guard). A
 * dropped frame call plays the music slower. This boots an exported .prg in
 * VICE, breaks on the tune's play address, lets `--skip` calls go by (to get
 * to the part of the tune in question), then records the emulator's cycle
 * count at each of the next `--calls` calls and reports how many raster
 * frames they span: calls / frames should be the calls a frame the player
 * makes (2 for a realtime-analysis visualiser on a single-speed tune: the
 * play and the analysis peek; 1 for shadow or plain players; times the
 * tune's speed for a multispeed tune). Fewer means frames were dropped.
 *
 * Needs VICE (`apt-get install -y vice xvfb`; ROMs from roms/).
 *
 *   node scripts/vice-play-rate.js export.prg --play=1503 --skip=9600 --calls=500
 *
 * --play is the tune's play address in hex (the SID header's, or the
 * analysed one for a play-address-0 tune). --skip=9600 with two calls a frame
 * is about 96 s in.
 */

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { romDir } = require('./lib/seam-lib.js');

const FRAME_CYCLES = 312 * 63;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A line-oriented client for VICE's remote (text) monitor (as seam-latency.js). */
class Monitor {
    constructor(sock) { this.sock = sock; this.buf = ''; sock.setEncoding('utf8'); sock.on('data', d => { this.buf += d; }); }
    static async connect(port) {
        for (let i = 0; i < 60; i++) {
            try {
                const s = await new Promise((res, rej) => {
                    const c = net.connect(port, '127.0.0.1');
                    c.once('connect', () => res(c));
                    c.once('error', rej);
                });
                return new Monitor(s);
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
}

(async () => {
    const args = process.argv.slice(2);
    const arg = (n, d) => (args.find(a => a.startsWith('--' + n + '=')) || '=' + d).split('=')[1];
    const prg = args.find(a => !a.startsWith('--'));
    const play = arg('play', '');
    if (!prg || !play) {
        console.error('usage: vice-play-rate.js export.prg --play=XXXX [--skip=0] [--calls=500]');
        process.exit(1);
    }
    const skip = Number(arg('skip', '0')), calls = Number(arg('calls', '500'));
    const port = 6600 + Math.floor(Math.random() * 300);
    const dir = romDir(path.dirname(path.resolve(prg)));
    const viceArgs = ['-default', '-directory', dir + ':/usr/share/vice', '-warp', '-autostart-warp',
        '-sounddev', 'dummy', '-autostartprgmode', '1',
        '-remotemonitor', '-remotemonitoraddress', 'ip4://127.0.0.1:' + port, '-autostart', path.resolve(prg)];
    const headless = !process.env.DISPLAY;
    const vice = spawn(headless ? 'xvfb-run' : 'x64sc', headless ? ['-a', 'x64sc', ...viceArgs] : viceArgs,
        { stdio: 'ignore', detached: true });
    try {
        await sleep(8000);
        const mon = await Monitor.connect(port);
        await mon.cmd('', 3000);
        const b = await mon.cmd('break ' + play);
        const num = (/BREAK:\s*(\d+)/i.exec(b) || [0, 1])[1];
        if (skip) {
            await mon.cmd(`ignore ${num} ${skip}`);
            await mon.cmd('x', 900000);
        }
        const cycles = [];
        for (let i = 0; i < calls; i++) {
            const sw = await mon.cmd('sw');
            const c = /(\d{5,})/.exec(sw.replace(/\(C:\$[0-9a-f]{4}\)/gi, ''));
            if (c) cycles.push(Number(c[1]));
            const out = await mon.cmd('x', 20000);
            if (!/\)\s+\d+\/\$[0-9a-f]+,/i.test(out)) break;
        }
        if (cycles.length < 2) throw new Error('the play routine was not reached at $' + play);
        const frames = (cycles[cycles.length - 1] - cycles[0]) / FRAME_CYCLES;
        console.log(`${cycles.length} play calls over ${frames.toFixed(1)} raster frames: `
            + `${((cycles.length - 1) / frames).toFixed(3)} calls a frame`);
        await mon.cmd('quit', 2000);
    } finally {
        try { process.kill(-vice.pid); } catch (e) { /* gone */ }
    }
})().catch(e => { console.error(e); process.exit(1); });
