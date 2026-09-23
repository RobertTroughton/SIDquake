// psid-asm.js - build tiny PSID files in a test, from a few bytes of 6502.
// Used by scripts/test-analyser-edge-cases.js, test-shadow-detect.js and
// test-loop-prepass.js.

// A PSID v2 file: 0x7C-byte header, then the code at `load`.
function psid({ load = 0x1000, init = 0x1000, play = 0x1003, songs = 1, startSong = 1, code }) {
    const h = new Uint8Array(0x7c);
    h.set([0x50, 0x53, 0x49, 0x44], 0);          // "PSID"
    const w16 = (o, v) => { h[o] = (v >> 8) & 0xff; h[o + 1] = v & 0xff; };
    w16(4, 2); w16(6, 0x7c); w16(8, load); w16(10, init); w16(12, play);
    w16(14, songs); w16(16, startSong);
    const out = new Uint8Array(h.length + code.length);
    out.set(h); out.set(code, h.length);
    return out;
}

// Assemble a flat byte list; strings of the form '<label' / '>label' are the
// low / high byte of a label resolved against `org`.
function asm(org, parts) {
    const labels = {}, bytes = [];
    for (const p of parts) {
        if (typeof p === 'string' && p.endsWith(':')) labels[p.slice(0, -1)] = org + bytes.length;
        else bytes.push(p);
    }
    return Uint8Array.from(bytes.map((b) => {
        if (typeof b !== 'string') return b;
        const v = labels[b.slice(1)];
        if (v === undefined) throw new Error('unknown label ' + b);
        return b[0] === '<' ? v & 0xff : (v >> 8) & 0xff;
    }));
}

module.exports = { psid, asm };
