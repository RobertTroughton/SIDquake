// psid.js - the PSID/RSID file header, as the JS analysis code reads it.
//
// The analyser itself parses the header in C++ (sid_processor.cpp); this is the
// JS side's one copy, used by the register pre-pass and the shadow/VU scans.
// sid-playback.js is a classic script and keeps its own reader.

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

// Header field offsets (big-endian words unless noted).
const OFF_VERSION = 0x04;
const OFF_DATA_OFFSET = 0x06;
const OFF_LOAD = 0x08;
const OFF_INIT = 0x0a;
const OFF_PLAY = 0x0c;
const OFF_SONGS = 0x0e;
const OFF_START_SONG = 0x10;
const OFF_SPEED = 0x12;          // 32 bits, one bit per subtune
const OFF_FLAGS = 0x76;          // v2+
const OFF_SECOND_SID = 0x7a;     // v3+, one byte: $Dxx0 middle nybbles
const OFF_THIRD_SID = 0x7b;      // v4+
const V1_HEADER_SIZE = 0x76;

// v2+ flags word.
const FLAG_BASIC = 0x02;         // RSID: the tune is a BASIC program
const FLAG_CLOCK_MASK = 0x0c;
const FLAG_CLOCK_NTSC = 0x08;
const MODEL_MASK = 3;            // per-chip model field, two bits each
const MODEL_SHIFT_SID1 = 4;
const MODEL_SHIFT_SID2 = 6;
const MODEL_SHIFT_SID3 = 8;

// Fields the analysis code drives a tune from, or null when `bytes` is not a
// PSID/RSID file whose data starts inside it. An init address of 0 is the load
// address, and a load address of 0 means the first two data bytes hold it.
// `flags` is 0 below version 2. `models` are the per-chip model codes from the
// flags (0 unknown, 1 6581, 2 8580, 3 either), and `secondSidAddress` /
// `thirdSidAddress` the decoded $Dxx0 addresses, 0 when the header names none;
// neither is checked against what the spec allows.
export function parseSidHeader(bytes) {
    if (!bytes || bytes.length < V1_HEADER_SIZE) return null;
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'PSID' && magic !== 'RSID') return null;
    const version = be16(bytes, OFF_VERSION);
    const dataOffset = be16(bytes, OFF_DATA_OFFSET);
    if (dataOffset + 2 > bytes.length) return null;
    const hdrLoad = be16(bytes, OFF_LOAD);
    const musicStart = hdrLoad === 0 ? dataOffset + 2 : dataOffset;
    const loadAddress = hdrLoad === 0 ? (bytes[dataOffset] | (bytes[dataOffset + 1] << 8)) : hdrLoad;
    const initAddress = be16(bytes, OFF_INIT) || loadAddress;
    const flags = version >= 2 ? be16(bytes, OFF_FLAGS) : 0;
    const sidAddress = (v, minVersion) => (version >= minVersion && bytes[v] ? 0xD000 | (bytes[v] << 4) : 0);
    return {
        magic, version, dataOffset, loadAddress, musicStart,
        initAddress,
        playAddress: be16(bytes, OFF_PLAY),
        songs: be16(bytes, OFF_SONGS),
        startSong: be16(bytes, OFF_START_SONG),
        speed: be32(bytes, OFF_SPEED),
        flags,
        // Nothing here can drive a BASIC tune.
        isBasic: magic === 'RSID' && (flags & FLAG_BASIC) !== 0,
        isNtsc: (flags & FLAG_CLOCK_MASK) === FLAG_CLOCK_NTSC,
        models: [
            (flags >> MODEL_SHIFT_SID1) & MODEL_MASK,
            version >= 3 ? (flags >> MODEL_SHIFT_SID2) & MODEL_MASK : 0,
            version >= 4 ? (flags >> MODEL_SHIFT_SID3) & MODEL_MASK : 0,
        ],
        secondSidAddress: sidAddress(OFF_SECOND_SID, 3),
        thirdSidAddress: sidAddress(OFF_THIRD_SID, 4),
    };
}
