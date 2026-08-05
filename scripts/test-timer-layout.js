#!/usr/bin/env node
// test-timer-layout.js - where each player puts the play-time clock, run in the
// 6510 emulator against the real assembled players.
//
// The clock is drawn either as "MM:SS/MM:SS" (elapsed + song length) or, when
// the analysis found no length, as "MM:SS" on its own. The alone case is easy
// to get wrong: leave the elapsed time in the column it uses when a length
// follows it and it strands blank columns against the screen edge, which is
// exactly what MusicalBlobs did. Every player must instead either move the
// clock flush-right or centre it on the span the full string covered.
//
// Rather than hard-code screen addresses, this assembles each player, calls its
// timer routines in the emulator, and diffs memory to see which cells were
// written - so the check is about the shape of the layout, not about constants
// that are free to move.
//
// It also checks, in the sources, that every player with a clock advances it
// inside its fast-forward loop. Holding SPACE plays several music frames per
// real frame, and a clock that keeps ticking at 50Hz through that drifts behind
// the audio - MusicalBlobs did. That one is a source check rather than an
// emulator run: the loop lives in the middle of a main loop or a raster IRQ,
// neither of which can be called on its own.
//
// Not covered: that a player wires bakedHasLength through to its timer at boot
// (that happens in the middle of the boot sequence, which needs a VIC).
//
// Usage: node scripts/test-timer-layout.js
// Requires java (KickAss) and public/sidquake.wasm. Exits non-zero on failure.

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 0x1000;                   // the CODE_ONLY base gen-reloc-codeonly.js uses
const DATA = BASE;
const HAS_LENGTH = DATA + 0x5F;        // data-block offsets shared by every player
const LEN_MIN = DATA + 0x5D, LEN_SEC = DATA + 0x5E;

// Each player, and how to make its timer paint. `alone` runs the no-length
// case, `withLength` the "MM:SS/MM:SS" one; both name routines to call and
// bytes to poke first.
const PLAYERS = [
    {
        name: 'MusicalBlobs',
        asm: 'SIDPlayers/MusicalBlobs/MusicalBlobs.asm',
        // Reads bakedHasLength itself and draws the length on the way out.
        withLength: { poke: [[HAS_LENGTH, 1]], call: ['InitSongTimer'] },
        alone: { poke: [[HAS_LENGTH, 0]], call: ['InitSongTimer'] }
    },
    {
        name: 'RaistlinBars',
        asm: 'SIDPlayers/RaistlinBars/RaistlinBars.asm',
        // INC/timer.asm picks its column from timerAlone; the player sets that
        // from bakedHasLength at boot, and DrawSongLength paints the length.
        withLength: { poke: [[HAS_LENGTH, 1], ['timerAlone', 0]], call: ['InitTimer', 'DrawSongLength'] },
        alone: { poke: [[HAS_LENGTH, 0], ['timerAlone', 1]], call: ['InitTimer'] }
    },
    {
        name: 'RaistlinBarsWithLogo',
        asm: 'SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm',
        withLength: { poke: [[HAS_LENGTH, 1], ['timerAlone', 0]], call: ['InitTimer', 'DrawSongLength'] },
        alone: { poke: [[HAS_LENGTH, 0], ['timerAlone', 1]], call: ['InitTimer'] }
    },
    {
        name: 'RaistlinMirrorBars',
        asm: 'SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm',
        withLength: { poke: [[HAS_LENGTH, 1], ['timerAlone', 0]], call: ['InitTimer', 'DrawSongLength'] },
        alone: { poke: [[HAS_LENGTH, 0], ['timerAlone', 1]], call: ['InitTimer'] }
    },
    {
        name: 'RaistlinMirrorBarsWithLogo',
        asm: 'SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm',
        withLength: { poke: [[HAS_LENGTH, 1], ['timerAlone', 0]], call: ['InitTimer', 'DrawSongLength'] },
        alone: { poke: [[HAS_LENGTH, 0], ['timerAlone', 1]], call: ['InitTimer'] }
    }
];

// Every player that shows a clock, and the routine that advances it one music
// frame. ScrapColumns, SimpleRaster and SimpleBitmapWithScroller fast-forward
// too but have no clock, so there's nothing to keep in step.
const FAST_FORWARD = [
    { name: 'MusicalBlobs', asm: 'SIDPlayers/MusicalBlobs/MusicalBlobs.asm', tick: 'UpdateSongTimer' },
    { name: 'Default', asm: 'SIDPlayers/Default/Default.asm', tick: 'UpdateTimer' },
    { name: 'DefaultWithLogo', asm: 'SIDPlayers/DefaultWithLogo/DefaultWithLogo.asm', tick: 'UpdateTimer' },
    { name: 'RaistlinBars', asm: 'SIDPlayers/RaistlinBars/RaistlinBars.asm', tick: 'UpdateTimer' },
    { name: 'RaistlinBarsWithLogo', asm: 'SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm', tick: 'UpdateTimer' },
    { name: 'RaistlinMirrorBars', asm: 'SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm', tick: 'UpdateTimer' },
    { name: 'RaistlinMirrorBarsWithLogo', asm: 'SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm', tick: 'UpdateTimer' }
];

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

// Assemble a player's CODE_ONLY build and read back its label addresses.
// KickAss drops the .sym next to the source, so it's removed again after.
function assemble(asmRel) {
    const asm = path.join(ROOT, asmRel);
    const out = path.join(os.tmpdir(), path.basename(asmRel) + '-timer.bin');
    execFileSync('java', ['-jar', path.join(ROOT, 'KickAss.jar'),
        `:loadAddress=${BASE}`, `:sysAddress=${BASE + 0x100}`, `:dataAddress=${DATA}`,
        ':gfxBank=1', '-define', 'CODE_ONLY',
        asm, '-binfile', '-o', out, '-symbolfile'], { cwd: ROOT, stdio: 'pipe' });

    const sym = asm.replace(/\.asm$/, '.sym');
    const labels = {};
    for (const line of fs.readFileSync(sym, 'utf8').split('\n')) {
        const m = /^\.label\s+(\w+)=\$([0-9a-fA-F]+)/.exec(line.trim());
        if (m) labels[m[1]] = parseInt(m[2], 16);
    }
    fs.unlinkSync(sym);
    return { bin: fs.readFileSync(out), labels };
}

async function loadCpu() {
    const factory = require(path.join(ROOT, 'public/sidquake.js'));
    return factory({
        wasmBinary: fs.readFileSync(path.join(ROOT, 'public/sidquake.wasm')),
        print: () => {}, printErr: () => {}
    });
}

function writeMem(m, addr, bytes) {
    const p = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, p);
    m._cpu_load_memory(addr, p, bytes.length);
    m._free(p);
}

// Run one case and return the screen cells it wrote, as a sorted address list.
// Screen RAM is found by diffing: everything the routines touched outside the
// player's own binary and colour RAM is a character cell.
function drawnCells(m, player, bin, labels, spec) {
    m._cpu_init();
    writeMem(m, BASE, bin);
    writeMem(m, LEN_MIN, new Uint8Array([3]));
    writeMem(m, LEN_SEC, new Uint8Array([30]));            // a 03:30 song length
    for (const [where, value] of spec.poke) {
        const addr = typeof where === 'string' ? labels[where] : where;
        if (addr == null) throw new Error(`${player.name}: no label ${where}`);
        writeMem(m, addr, new Uint8Array([value]));
    }

    const before = new Uint8Array(0x10000);
    for (let a = 0; a < 0x10000; a++) before[a] = m._cpu_read_memory(a);

    for (const routine of spec.call) {
        const addr = labels[routine];
        if (addr == null) throw new Error(`${player.name}: no routine ${routine}`);
        if (!m._cpu_execute_function(addr, 200000)) {
            throw new Error(`${player.name}: ${routine} did not return`);
        }
    }

    const cells = [];
    for (let a = 0; a < 0x10000; a++) {
        if (m._cpu_read_memory(a) === before[a]) continue;
        if (a >= 0xd800 && a < 0xdc00) continue;           // colour RAM
        if (a >= BASE && a < BASE + bin.length) continue;  // the player's own variables
        cells.push(a);
    }
    return cells;
}

function contiguous(cells) {
    for (let i = 1; i < cells.length; i++) if (cells[i] !== cells[i - 1] + 1) return false;
    return true;
}

// The body of a player's fast-forward loop: one pass plays a whole music
// frame's worth of calls, so whatever is in here runs once per music frame.
function fastForwardBody(src) {
    const start = src.indexOf('!ffFrameLoop:');
    if (start < 0) return null;
    const end = src.indexOf('bne !ffFrameLoop-', start);
    return end < 0 ? null : src.slice(start, end);
}

function checkFastForward() {
    for (const player of FAST_FORWARD) {
        const src = fs.readFileSync(path.join(ROOT, player.asm), 'utf8');
        const body = fastForwardBody(src);
        check(body !== null, `${player.name}: has a fast-forward loop`);
        if (!body) continue;
        check(body.includes(`jsr ${player.tick}`),
            `${player.name}: fast-forward advances the clock with the music`,
            body.includes(`jsr ${player.tick}`) ? '' : `no "jsr ${player.tick}" in the loop`);
    }
}

async function run() {
    const m = await loadCpu();

    for (const player of PLAYERS) {
        const { bin, labels } = assemble(player.asm);

        // Every screen cell the "MM:SS/MM:SS" layout occupies. Double-buffered
        // players write two screens, so take the run containing the last cell.
        const full = drawnCells(m, player, bin, labels, player.withLength);
        const alone = drawnCells(m, player, bin, labels, player.alone);
        const lastRun = (cells) => {
            const out = [cells[cells.length - 1]];
            for (let i = cells.length - 2; i >= 0 && cells[i] === out[0] - 1; i--) out.unshift(cells[i]);
            return out;
        };
        const fullRun = lastRun(full), aloneRun = lastRun(alone);

        check(fullRun.length === 11, `${player.name}: "MM:SS/MM:SS" covers 11 columns`,
            fullRun.length + ' cells');
        check(aloneRun.length === 5, `${player.name}: the clock alone covers 5 columns`,
            aloneRun.length + ' cells');
        check(contiguous(fullRun) && contiguous(aloneRun), `${player.name}: both runs are contiguous`);

        // Columns relative to the left of the full layout, so no screen address
        // has to be known.
        const left = aloneRun[0] - fullRun[0];
        const right = fullRun[fullRun.length - 1] - aloneRun[aloneRun.length - 1];
        const centred = Math.abs(left - right) <= 1;
        const flushRight = right === 0;
        check(centred || flushRight,
            `${player.name}: the clock alone is centred or flush-right, never left with a gap`,
            `${left} column(s) to its left, ${right} to its right`
            + (flushRight ? ' - flush-right' : centred ? ' - centred' : ''));
    }

    checkFastForward();

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
