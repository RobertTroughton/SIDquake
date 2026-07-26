/*
 * Classifying a .sid by its header, cheaply - we only ever read the first 124
 * bytes, never the whole file.
 *
 *   RSID   The "real C64" variant, whose init is not required to return (it
 *          typically installs an IRQ and loops). SIDquake's own ANALYSER rejects
 *          RSID, but the playback engines do not: measured against libsidplayfp,
 *          plain RSID tunes render perfectly well. They are kept in the scan by
 *          default and simply reported as RSID, so any pattern in their results
 *          is visible rather than hidden by exclusion.
 *
 *   BASIC  RSID flags bit 1: the tune IS a BASIC program, started by RUN.
 *          Nothing ever drives the SID from our side, so these measure as
 *          nothing and are excluded by default. In HVSC they are the
 *          *_BASIC.sid files - 589 of the 590 so named carry the flag, so the
 *          flag is the reliable test and the filename is not.
 *
 * The MUS flag (bit 0, Compute!'s Sidplayer data) is checked too for
 * completeness; HVSC 85 contains none.
 *
 * One compact shape is used throughout - { rsid, basic, mus } as 0/1 - because
 * these get cached to disk per tune and read back by both scan.mjs (to filter)
 * and report.mjs (for the Format column).
 */

import { open } from 'fs/promises';

const HEADER_BYTES = 0x7c;

// Read just the header and say what we're looking at.
// Returns { magic, version, flags, rsid, basic, mus } or null if
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
            rsid: isRsid ? 1 : 0,
            // Bit 1 means "psidSpecific" on a PSID but "C64 BASIC" on an RSID -
            // only the RSID reading marks a BASIC program.
            basic: (isRsid && (flags & 2)) ? 1 : 0,
            mus: (flags & 1) ? 1 : 0,
        };
    } catch (e) {
        return null;
    } finally {
        if (fh) await fh.close();
    }
}

// Why a tune should be left out of the scan, or null to measure it.
export function skipReason(kind, { includeRsid = true, includeBasic = false } = {}) {
    if (!kind) return 'unreadable';
    if (kind.basic && !includeBasic) return 'basic';
    if (kind.rsid && !includeRsid) return 'rsid';
    if (kind.mus) return 'mus';
    return null;
}
