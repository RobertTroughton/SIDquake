/*
 * Classifying a .sid by its header, cheaply - we only ever read the first 124
 * bytes, never the whole file.
 *
 * Two kinds are worth excluding from a length scan:
 *
 *   RSID   The "real C64" variant. Its init routine is not required to return
 *          (it typically installs an IRQ and loops forever), so the tune only
 *          plays under a full C64 environment. SIDquake's own analyser rejects
 *          RSID outright, and where our engines do render one the result is not
 *          comparable with what HVSC timed.
 *
 *   BASIC  RSID flags bit 1: the tune IS a BASIC program, started by RUN. In
 *          HVSC these are the *_BASIC.sid files - 589 of the 590 so named carry
 *          the flag, so the flag is the reliable test and the filename is not.
 *          They measure as 0 s because nothing ever drives the SID.
 *
 * The MUS flag (bit 0, Compute!'s Sidplayer data) is checked too for
 * completeness; HVSC 85 contains none.
 */

import { open } from 'fs/promises';

const HEADER_BYTES = 0x7c;

// Read just the header and say what we're looking at.
// Returns { magic, version, flags, isRsid, isBasic, isMus, playable } or null if
// the file is too short / not a SID at all.
export async function readSidKind(file) {
    let fh;
    try {
        fh = await open(file, 'r');
        const buf = Buffer.alloc(HEADER_BYTES);
        const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
        if (bytesRead < 0x76) return null;
        const magic = buf.toString('ascii', 0, 4);
        if (magic !== 'PSID' && magic !== 'RSID') return null;
        const version = buf.readUInt16BE(4);
        const flags = (version >= 2 && bytesRead >= 0x78) ? buf.readUInt16BE(0x76) : 0;
        const isRsid = magic === 'RSID';
        return {
            magic, version, flags,
            isRsid,
            // Bit 1 means "psidSpecific" on a PSID but "C64 BASIC" on an RSID -
            // only the RSID reading marks a BASIC program.
            isBasic: isRsid && !!(flags & 2),
            isMus: !!(flags & 1),
        };
    } catch (e) {
        return null;
    } finally {
        if (fh) await fh.close();
    }
}

// Why a tune should be left out of the scan, or null to measure it.
export function skipReason(kind, { includeRsid = false, includeBasic = false } = {}) {
    if (!kind) return 'unreadable';
    if (kind.isBasic && !includeBasic) return 'basic';
    if (kind.isRsid && !includeRsid) return 'rsid';
    if (kind.isMus) return 'mus';
    return null;
}
