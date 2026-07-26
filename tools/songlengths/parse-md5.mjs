/*
 * Parser / serializer for HVSC's DOCUMENTS/Songlengths.md5.
 *
 * The file looks like this (CRLF line endings, and the path comment above each
 * entry is what actually locates the .sid on disk - we never recompute HVSC's
 * MD5, we just carry it through as an opaque key):
 *
 *   [Database]
 *   ;
 *   ; /DEMOS/0-9/1_45_Tune.sid
 *   9dc4cbf3a5b58a0d5d2f42a0f4ad9d5f=1:45
 *   ;
 *   ; /MUSICIANS/H/Hubbard_Rob/Commando.sid
 *   4c8d1e...=3:22.500 2:15 1:05.250
 *
 * One time per subtune. Times are M:SS or M:SS.mmm (HVSC #68+ has millisecond
 * precision); a few very long tunes use MM:SS. Trailing markers HVSC sometimes
 * appends to a time - "(F)" faded, "(S)" seek etc. - are preserved verbatim on
 * any entry we don't rewrite, and dropped from ones we do (they describe how
 * HVSC arrived at ITS value, not ours).
 *
 * parseSonglengths() keeps every physical line so the file can be written back
 * byte-for-byte with only the values we disagree with changed - requirement (1)
 * of the tool. Do not "tidy" anything here.
 */

// One entry per md5 line, in file order.
//   lineIndex : index into `lines`, so a rewrite can target the exact line
//   md5       : the 32-hex key, verbatim
//   sidPath   : HVSC-relative path from the preceding "; /..." comment
//               (leading slash stripped), or null if there wasn't one
//   times     : [{ ms, text }] - parsed milliseconds plus the original text
export function parseSonglengths(text) {
    // Split but KEEP the terminator so we can rebuild the file exactly, CRLF or LF.
    const lines = text.split(/(?<=\n)/);
    const entries = [];
    let pendingPath = null;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.replace(/\r?\n$/, '');
        if (!line.length) continue;

        if (line[0] === ';') {
            // "; /MUSICIANS/..." - the path for the entry that follows.
            const m = /^;\s*(\/.+?)\s*$/.exec(line);
            if (m) pendingPath = m[1].replace(/^\/+/, '');
            continue;
        }
        if (line[0] === '[') continue;            // [Database]

        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const md5 = line.slice(0, eq).trim();
        if (!/^[0-9a-fA-F]{32}$/.test(md5)) continue;

        const times = line.slice(eq + 1).trim().split(/\s+/).filter(Boolean)
            .map((text) => ({ text, ms: parseTimeMs(text) }));
        if (!times.length) continue;

        entries.push({ lineIndex: i, md5, sidPath: pendingPath, times });
        pendingPath = null;
    }
    return { lines, entries };
}

// "3:22.500" / "3:22" / "12:05.25" -> milliseconds. Any trailing marker such as
// "(F)" is ignored for the numeric value. Returns null if it doesn't parse.
export function parseTimeMs(text) {
    const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?/.exec(text);
    if (!m) return null;
    const frac = m[3] ? m[3].padEnd(3, '0') : '000';
    return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + parseInt(frac, 10);
}

// Milliseconds -> "M:SS.mmm", HVSC's own formatting. HVSC truncates rather than
// rounds when it writes these, so we do too.
export function formatTimeMs(ms, withMillis = true) {
    const total = Math.max(0, Math.floor(ms));
    const mins = Math.floor(total / 60000);
    const secs = Math.floor((total % 60000) / 1000);
    const rem = total % 1000;
    const base = `${mins}:${String(secs).padStart(2, '0')}`;
    return withMillis ? `${base}.${String(rem).padStart(3, '0')}` : base;
}

// Rebuild one md5 line with new time texts, preserving the original md5 and the
// line's own terminator.
export function rewriteEntryLine(originalLine, md5, timeTexts) {
    const term = /\r\n$/.test(originalLine) ? '\r\n' : (/\n$/.test(originalLine) ? '\n' : '');
    return `${md5}=${timeTexts.join(' ')}${term}`;
}
