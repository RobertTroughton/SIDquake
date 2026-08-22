#!/usr/bin/env node
/**
 * make-test-logo.js - a plain 320x200 logo PNG with art in the top N char rows.
 *
 * The shipped gallery logos are real artwork: busy, multicolour, and each one a
 * different height. That is the wrong instrument for asking "what does the
 * player do with the LAST row of the logo band?" - a stray line lands on top of
 * artwork and is invisible. This writes a deliberately plain one instead: flat
 * stripes in two colours, a gap down the middle so a row drawn through the wrong
 * pointers can't be mistaken for the art, and black everywhere below the art, so
 * anything the player paints outside the logo shows up against it.
 *
 * The stripes are 4 lines tall, so every cell holds both colours - the image
 * converts as a charset (few unique cells), which is the case the seam differs
 * on. Pass --bitmap for noisy art that has to fall back to bitmap mode.
 *
 *   node scripts/make-test-logo.js out.png            # 11 rows (the bars-with-logo band)
 *   node scripts/make-test-logo.js out.png --rows=3
 *   node scripts/make-test-logo.js out.png --bitmap
 *
 * Feed it to the seam scripts: node scripts/seam-check.js --logo=out.png
 */

const fs = require('fs');
const zlib = require('zlib');

const W = 320, H = 200;
const BLACK = [0, 0, 0];
const LIGHTBLUE = [108, 94, 181];
const WHITE = [255, 255, 255];
// A third colour per cell forces the bitmap fallback.
const RED = [136, 57, 50];

function png(file, rows) {
    const raw = Buffer.concat(rows.map(r => Buffer.concat([Buffer.from([0]), Buffer.from(r.flat())])));
    const chunk = (tag, data) => {
        const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2;            // 8-bit, truecolour
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

// Node's zlib.crc32 landed in 22.2; fall back for older runtimes.
let TABLE = null;
function crc32(buf) {
    if (!TABLE) {
        TABLE = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            TABLE[n] = c;
        }
    }
    let c = 0xffffffff;
    for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--'));
if (!out) {
    console.error('usage: make-test-logo.js <out.png> [--rows=N] [--bitmap]');
    process.exit(2);
}
const rows = Number((args.find(a => a.startsWith('--rows=')) || '=11').split('=')[1]);
const noisy = args.includes('--bitmap');

const pixels = [];
for (let y = 0; y < H; y++) {
    if (y < rows * 8) {
        const row = [];
        for (let x = 0; x < W; x++) {
            if (x >= 150 && x < 170) { row.push(BLACK); continue; }
            if (noisy) {
                // Three colours inside single cells: no charset mode fits, so
                // the converter falls back to a bitmap logo. Pixels are 2px
                // wide, which is what multicolour bitmap can hold - and three
                // rather than four, because the black gap column is a fourth
                // colour in the cells it crosses.
                row.push([LIGHTBLUE, WHITE, RED][((x >> 1) + y) % 3]);
            } else {
                row.push(((y >> 2) & 1) ? WHITE : LIGHTBLUE);
            }
        }
        pixels.push(row);
    } else {
        pixels.push(new Array(W).fill(BLACK));
    }
}
png(out, pixels);
console.log(`${out}: ${rows} char row(s) of art, ${noisy ? 'bitmap-mode' : 'charset-mode'}`);
