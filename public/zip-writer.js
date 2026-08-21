// zip-writer.js - build a .zip in memory, no dependency, no compression.
//
// For exporting a whole set at once. Chrome can write straight into a folder the
// user picks (showDirectoryPicker), but nothing else can, so the fallback has to
// be a single file - and a directory of PRGs is what a music disk wants.
//
// Everything is stored, not deflated: an exomizer-crunched PRG is already
// compressed, and deflate would add a compressor here to save nothing. Files
// stay under 4 GB, so this writes the original 32-bit format rather than ZIP64.
(function () {
    let table = null;
    function crcTable() {
        if (table) return table;
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    }

    function crc32(bytes) {
        const t = crcTable();
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // MS-DOS date/time, which is all the format carries. The caller passes the
    // moment; nothing here reads the clock, so a build stays reproducible.
    function dosStamp(date) {
        const d = date || new Date(1980, 0, 1);
        const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5)
            | ((Math.floor(d.getSeconds() / 2)) & 31);
        const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5)
            | (d.getDate() & 31);
        return { time, day };
    }

    /**
     * @param {Array<{name: string, bytes: Uint8Array}>} files
     * @param {Date} [date] - timestamp written into every entry
     * @returns {Uint8Array} the complete archive
     */
    function makeZip(files, date) {
        const enc = new TextEncoder();
        const { time, day } = dosStamp(date);
        const entries = files.map((f) => ({
            nameBytes: enc.encode(f.name),
            bytes: f.bytes,
            crc: crc32(f.bytes),
        }));

        let size = 0;
        for (const e of entries) size += 30 + e.nameBytes.length + e.bytes.length;   // local
        for (const e of entries) size += 46 + e.nameBytes.length;                    // central
        size += 22;                                                                  // end record

        const out = new Uint8Array(size);
        const view = new DataView(out.buffer);
        let at = 0;
        const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
        const u32 = (v) => { view.setUint32(at, v >>> 0, true); at += 4; };
        const raw = (b) => { out.set(b, at); at += b.length; };

        for (const e of entries) {
            e.offset = at;
            u32(0x04034b50);
            u16(20);            // version needed
            u16(0x0800);        // UTF-8 names
            u16(0);             // stored
            u16(time); u16(day);
            u32(e.crc);
            u32(e.bytes.length);
            u32(e.bytes.length);
            u16(e.nameBytes.length);
            u16(0);             // no extra field
            raw(e.nameBytes);
            raw(e.bytes);
        }

        const centralAt = at;
        for (const e of entries) {
            u32(0x02014b50);
            u16(20); u16(20);
            u16(0x0800);
            u16(0);
            u16(time); u16(day);
            u32(e.crc);
            u32(e.bytes.length);
            u32(e.bytes.length);
            u16(e.nameBytes.length);
            u16(0); u16(0);     // extra, comment
            u16(0);             // disk number
            u16(0);             // internal attrs
            u32(0);             // external attrs
            u32(e.offset);
            raw(e.nameBytes);
        }

        // Take the size before writing the end record - the writers below move
        // `at` as they go.
        const centralSize = at - centralAt;
        u32(0x06054b50);
        u16(0); u16(0);
        u16(entries.length); u16(entries.length);
        u32(centralSize);
        u32(centralAt);
        u16(0);                 // no comment

        return out;
    }

    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    g.makeZip = makeZip;
    g.zipCrc32 = crc32;
})();
