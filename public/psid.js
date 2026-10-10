// psid.js - the PSID/RSID file header, as the JS analysis code reads it.
//
// The analyser itself parses the header in C++ (sid_processor.cpp); this is the
// JS side's one copy, used by the register pre-pass and the shadow/VU scans.
// sid-playback.js is a classic script and keeps its own reader.

const be16 = (b, o) => (b[o] << 8) | b[o + 1];

// Fields the analysis code drives a tune from, or null when `bytes` is not a
// PSID/RSID file whose data starts inside it. An init address of 0 is the load
// address, and a load address of 0 means the first two data bytes hold it.
// `flags` is 0 below version 2. `models` are the per-chip model codes from the
// flags (0 unknown, 1 6581, 2 8580, 3 either), and `secondSidAddress` /
// `thirdSidAddress` the decoded $Dxx0 addresses, 0 when the header names none;
// neither is checked against what the spec allows.
export function parseSidHeader(bytes) {
    if (!bytes || bytes.length < 0x76) return null;
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'PSID' && magic !== 'RSID') return null;
    const version = be16(bytes, 4);
    const dataOffset = be16(bytes, 6);
    if (dataOffset + 2 > bytes.length) return null;
    const hdrLoad = be16(bytes, 8);
    const musicStart = hdrLoad === 0 ? dataOffset + 2 : dataOffset;
    const loadAddress = hdrLoad === 0 ? (bytes[dataOffset] | (bytes[dataOffset + 1] << 8)) : hdrLoad;
    const initAddress = be16(bytes, 10) || loadAddress;
    const flags = version >= 2 ? be16(bytes, 0x76) : 0;
    const sidAddress = (v, minVersion) => (version >= minVersion && bytes[v] ? 0xD000 | (bytes[v] << 4) : 0);
    return {
        magic, version, dataOffset, loadAddress, musicStart,
        initAddress,
        playAddress: be16(bytes, 12),
        songs: be16(bytes, 0x0e),
        startSong: be16(bytes, 0x10),
        speed: ((bytes[0x12] << 24) | (bytes[0x13] << 16) | (bytes[0x14] << 8) | bytes[0x15]) >>> 0,
        flags,
        // RSID flag bit 1: the tune is a BASIC program, nothing here can drive it.
        isBasic: magic === 'RSID' && (flags & 2) !== 0,
        isNtsc: (flags & 0x0c) === 0x08,
        models: [(flags >> 4) & 3, version >= 3 ? (flags >> 6) & 3 : 0, version >= 4 ? (flags >> 8) & 3 : 0],
        secondSidAddress: sidAddress(0x7a, 3),
        thirdSidAddress: sidAddress(0x7b, 4),
    };
}
