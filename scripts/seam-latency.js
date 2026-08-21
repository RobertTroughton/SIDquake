#!/usr/bin/env node
/**
 * seam-latency.js - measure where the logo/info split actually lands.
 *
 * The logo players hide the mode switch behind two raster lines of sprite
 * curtain: the split IRQ is armed on the first blocked line and has both lines
 * to rewrite $d011/$d018/$d016 before the beam reaches anything the viewer can
 * see. Whether that holds depends on how late the IRQ was entered, and the
 * worst case is not the common one - a music call that happens to be inside the
 * dispatcher's blind spot when the raster IRQ fires delays it by a further
 * ~60 cycles, and only on the frames where the two collide.
 *
 * Screenshotting frames finds that maybe one frame in fifty. This measures it
 * instead: it breaks on the handler's `sta $d011` in the running export, and
 * VICE's break line already carries the beam position, so every frame reports
 * the exact line and cycle the switch landed on. The check is then a margin,
 * not a photograph: how many cycles are left between the write and the first
 * line the curtain does not hide, against the ~60 a blind-spot collision costs.
 *
 * Needs Playwright and VICE (neither is a dependency of this repo):
 *   npm install --no-save playwright
 *   apt-get install -y vice xvfb
 *
 *   node scripts/seam-latency.js
 *   node scripts/seam-latency.js --visualizer=RaistlinBarsWithLogo --frames=3000
 *   node scripts/seam-latency.js --sid=jammer-mm.sid      # multi-speed: more collisions
 *   node scripts/seam-latency.js --method=realtime       # the bar data to export with
 *   node scripts/seam-latency.js --visualizer=RaistlinBarsWithLogo --watch=curtain
 *
 * --watch=curtain measures the other half of the seam: not whether the mode
 * switch is hidden, but whether the curtain that hides it was there at all. It
 * breaks on the same write and reads sprite 0's Y, which says which duty the
 * sprites were on at that instant. Only RaistlinBarsWithLogo re-arms them per
 * frame (they do water duty in between); the other logo players set their
 * curtain up once at init.
 *
 * The C64 ROMs come from the ones committed under roms/.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { exportPRG, romDir } = require('./lib/seam-lib.js');

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A line-oriented client for VICE's remote (text) monitor. */
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

    /** Send a command and collect output until the monitor prompts again. */
    async cmd(line, timeoutMs = 5000) {
        this.buf = '';
        this.sock.write(line + '\n');
        return this.drain(timeoutMs);
    }

    /** Read until the monitor's `(C:$xxxx)` prompt comes back. */
    async drain(timeoutMs = 5000) {
        const end = Date.now() + timeoutMs;
        for (;;) {
            if (/\(C:\$[0-9a-f]{4}\)/i.test(this.buf)) return this.buf;
            if (Date.now() > end) return this.buf;
            await sleep(5);
        }
    }

    close() { this.sock.destroy(); }
}

/** Boot the export in VICE with the remote monitor listening. */
function startVice(prgPath, port) {
    const dir = romDir(path.dirname(prgPath));
    const args = [
        '-default',
        '-directory', dir + ':/usr/share/vice',
        '-VICIIfilter', '0', '-VICIIborders', '1',
        '-warp', '-autostart-warp', '-sounddev', 'dummy',
        '-autostartprgmode', '1',
        '-remotemonitor', '-remotemonitoraddress', 'ip4://127.0.0.1:' + port,
        '-autostart', prgPath
    ];
    const headless = !process.env.DISPLAY;
    const proc = spawn(headless ? 'xvfb-run' : 'x64sc',
        headless ? ['-a', 'x64sc', ...args] : args,
        { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    return proc;
}

const PAL_LINE_CYCLES = 63;

/**
 * The split handler's tail, as every logo player assembles it: the three VIC
 * writes that swap the mode, in this order. Distinctive enough to locate the
 * handler in RAM without knowing where the exporter relocated it to.
 */
const SPLIT_WRITES = ['8d', '11', 'd0', '8e', '21', 'd0', '8c', '18', 'd0'];


(async () => {
    const args = process.argv.slice(2);
    const arg = (n, d) => (args.find(a => a.startsWith('--' + n + '=')) || '=' + d).split('=')[1];
    const opts = {
        sid: arg('sid', 'psych858o-xtrovert.sid'),
        visualizer: arg('visualizer', 'DefaultWithLogo'),
        method: arg('method', ''),
        logo: arg('logo', path.join(ROOT, 'public', 'PNG', 'Logos', 'facet-psychoandstinsen.png'))
    };
    const frames = Number(arg('frames', '1500'));
    // How many raster lines the player's sprite curtain hides the switch behind.
    const curtainLines = Number(arg('curtain-lines', '2'));
    // What to measure: 'switch' (the $d011 write - is the mode change hidden?)
    // or 'curtain' (the sprite Y that arms the curtain - is it there to hide it?).
    const watch = arg('watch', 'switch');
    // The curtain's own sprite Y, from the player source (CURTAIN_SPRITE_Y;
    // RaistlinBarsWithLogo's 11-row logo puts the split on 138, so 117).
    const curtainY = Number(arg('curtain-y', '117'));
    const port = Number(arg('port', '6510'));
    const keep = arg('keep', '');
    const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'seam-'));
    fs.mkdirSync(dir, { recursive: true });

    console.log('exporting ' + opts.visualizer + ' with ' + path.basename(opts.sid));
    const prg = await exportPRG(opts);
    const prgPath = path.join(dir, 'seam.prg');
    fs.writeFileSync(prgPath, prg);
    console.log('  ' + prg.length + ' bytes');

    const vice = startVice(prgPath, port);
    let mon;
    try {
        // Connecting halts the machine, so give the export time to autostart
        // and decompress before the monitor freezes it.
        await sleep(25000);
        mon = await Monitor.connect(port);
        await mon.drain(4000);

        const hunt = await mon.cmd('hunt 0400 cfff ' + SPLIT_WRITES.join(' '), 20000);
        // Strip the monitor's own `(C:$xxxx)` prompts first - the PC they carry
        // looks exactly like a hunt result and sorts ahead of the real one.
        const hits = [...hunt.replace(/\(C:\$[0-9a-f]{4}\)/gi, ' ').matchAll(/\b([0-9a-f]{4})\b/gi)]
            .map(m => m[1].toLowerCase())
            .filter(a => a !== '0400' && a !== 'cfff');
        if (!hits.length) throw new Error('could not find the split handler in RAM:\n' + hunt);
        const addr = hits[0];
        console.log('  split handler writes $d011 at $' + addr.toUpperCase());

        await mon.cmd('break $' + addr);

        // Each hit is one frame's split, and the monitor's break line already
        // carries the beam position - "LIN/$hex, CYC/$hex" - so the raster the
        // write landed on needs no further command.
        const seen = [];
        for (let i = 0; i < frames; i++) {
            const out = await mon.cmd('x', 15000);
            const m = /exec [0-9a-f]{4}\)\s+(\d+)\/\$[0-9a-f]+,\s+(\d+)\//i.exec(out);
            if (!m) break;
            const hit = { line: Number(m[1]), cycle: Number(m[2]) };
            if (watch === 'curtain') {
                // Sprite 0's Y, as the VIC holds it at the instant of the switch:
                // the curtain's own Y means the curtain is up, anything else means
                // the sprites are still on water duty and the switch is in the open.
                const mem = await mon.cmd('m d001 d001', 8000);
                const b = /d001\s+([0-9a-f]{2})/i.exec(mem);
                hit.spriteY = b ? parseInt(b[1], 16) : null;
            }
            seen.push(hit);
        }
        if (!seen.length) throw new Error('the breakpoint never reported a beam position');

        const counts = new Map();
        for (const s of seen) counts.set(s.line, (counts.get(s.line) || 0) + 1);
        const lines = [...counts.entries()].sort((a, b) => a[0] - b[0]);
        console.log('\nraster line the mode switch landed on, over ' + seen.length + ' frames:');
        for (const [line, n] of lines) {
            const cyc = seen.filter(s => s.line === line).map(s => s.cycle);
            console.log('  line ' + line + '  x' + String(n).padStart(5) +
                '  (' + (100 * n / seen.length).toFixed(2) + '%)' +
                '  cycles ' + Math.min(...cyc) + '-' + Math.max(...cyc));
        }

        if (watch === 'curtain') {
            // A frame whose sprite Y is not the curtain's had no curtain over the
            // switch. It is not about WHERE the arming ran - an arming any time
            // after the water write serves the next frame - but about whether it
            // ran at all: a frame call dropped by the dispatcher's overload guard
            // takes the arming with it, and that frame's seam is drawn in the open.
            const missed = seen.filter(s => s.spriteY !== curtainY);
            const pct = (100 * missed.length / seen.length).toFixed(2);
            const others = [...new Set(missed.map(s => s.spriteY))];
            console.log('\nsprite Y at the switch, over ' + seen.length + ' frames: ' +
                'curtain (' + curtainY + ') on ' + (seen.length - missed.length) +
                (others.length ? ', otherwise ' + others.join('/') : ''));
            check(missed.length === 0,
                'the curtain is up on every frame the switch happens',
                missed.length + ' of ' + seen.length + ' frames (' + pct + '%) had no curtain');
            if (mon) mon.close();
            try { process.kill(-vice.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
            if (!keep) console.log('(working dir ' + dir + ')');
            process.exit(failures ? 1 : 0);
        }

        // The curtain hides the line the IRQ is armed on and the one after it.
        // The common case shows where that pair is; anything past it is drawn
        // in the open.
        const common = lines.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        const lastHidden = common;
        const late = seen.filter(s => s.line > lastHidden);
        const worst = Math.max(...seen.map(s => s.line));

        // The deadline is the first line the curtain does NOT hide, so the
        // margin runs from the write to the end of the curtained pair - not to
        // the end of the line the write happens to land on.
        const onTime = seen.filter(s => s.line === common);
        const worstCycle = Math.max(...onTime.map(s => s.cycle));
        const margin = (curtainLines - 1) * PAL_LINE_CYCLES + (PAL_LINE_CYCLES - worstCycle);
        console.log('\nswitch lands on line ' + common + ' by cycle ' + worstCycle +
            '; the curtain runs to line ' + (common + curtainLines - 1));
        console.log('margin before the first line the viewer can see: ' + margin + ' cycles');
        console.log('a music call caught in the dispatcher blind spot costs ~60 more');
        check(margin > 60, 'the margin absorbs a worst-case blind-spot delay',
            margin + ' cycles against a ~60 cycle blind spot');

        check(late.length === 0,
            'the mode switch always lands on a curtained line',
            late.length + ' of ' + seen.length + ' frames landed past line ' +
                lastHidden + ' (worst ' + worst + ')');
    } finally {
        if (mon) mon.close();
        // xvfb-run and x64sc are one detached process group, so the negative
        // pid takes the whole thing down. Never pkill by name: this script's
        // own command line contains it.
        try { process.kill(-vice.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }

    if (!keep) console.log('(working dir ' + dir + ')');
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(2);
});
