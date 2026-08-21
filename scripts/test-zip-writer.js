#!/usr/bin/env node
/**
 * test-zip-writer.js - the archive a whole-set export hands the user.
 *
 * public/zip-writer.js writes the archive by hand (no dependency, stored
 * entries), so the byte layout is ours to get right. This builds one, unpacks it
 * with Node's own zlib-free reading of the format, and checks every file comes
 * back byte for byte with the CRC the archive claims.
 *
 * Run with `node scripts/test-zip-writer.js`.
 */

const path = require('path');
const zlib = require('zlib');

require(path.join(__dirname, '..', 'public', 'zip-writer.js'));

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

/** Read a stored-entry zip back out, straight from the central directory. */
function unzip(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    // Find the end-of-central-directory record (no comment, so it is the last 22).
    let end = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('no end-of-central-directory record');
    const count = buf.readUInt16LE(end + 10);
    const cdSize = buf.readUInt32LE(end + 12);
    const cdAt = buf.readUInt32LE(end + 16);
    if (cdAt + cdSize !== end) {
        throw new Error(`central directory runs to ${cdAt + cdSize}, end record is at ${end}`);
    }

    const out = [];
    let at = cdAt;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
        const method = buf.readUInt16LE(at + 10);
        const crc = buf.readUInt32LE(at + 16);
        const size = buf.readUInt32LE(at + 24);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const commentLen = buf.readUInt16LE(at + 32);
        const local = buf.readUInt32LE(at + 42);
        const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
        at += 46 + nameLen + extraLen + commentLen;

        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
        const lNameLen = buf.readUInt16LE(local + 26);
        const lExtraLen = buf.readUInt16LE(local + 28);
        const dataAt = local + 30 + lNameLen + lExtraLen;
        out.push({ name, method, crc, bytes: buf.slice(dataAt, dataAt + size) });
    }
    return out;
}

const files = [
    { name: 'first.prg', bytes: new Uint8Array([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00]) },
    { name: 'a longer name with spaces.prg',
      bytes: new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff)) },
    { name: 'ünïcode-näme.sqrecipe.json', bytes: Buffer.from('{"sidquake":{"recipe":1}}') },
    { name: 'empty.prg', bytes: new Uint8Array(0) },
];

const archive = makeZip(files, new Date(2026, 0, 2, 3, 4, 6));
let read;
try {
    read = unzip(archive);
} catch (e) {
    check(false, 'the archive is readable', e.message);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}

check(read.length === files.length, 'every file is in the archive',
    `${read.length} of ${files.length}`);

let allMatch = true, allStored = true, allCrc = true;
for (const want of files) {
    const got = read.find(f => f.name === want.name);
    if (!got) { allMatch = false; continue; }
    const wantBuf = Buffer.from(want.bytes);
    if (!got.bytes.equals(wantBuf)) allMatch = false;
    if (got.method !== 0) allStored = false;
    if (got.crc !== zipCrc32(want.bytes)) allCrc = false;
}
check(allMatch, 'each one comes back byte for byte');
check(allStored, 'nothing is deflated - a crunched PRG is already compressed');
check(allCrc, 'and the CRC in the archive is the CRC of the bytes');

// CRC-32 against a known value, so a wrong table cannot pass by agreeing with
// itself: the standard check vector for "123456789".
check(zipCrc32(Buffer.from('123456789')) === 0xCBF43926, 'the CRC is a real CRC-32',
    '0x' + zipCrc32(Buffer.from('123456789')).toString(16));
// zlib computes the same one, over the real payload this time.
const big = files[1].bytes;
check(zipCrc32(big) === zlib.crc32(Buffer.from(big)), 'and agrees with zlib over 5 KB');

check(makeZip([], new Date(2026, 0, 1)).length === 22, 'an empty archive is just the end record');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
