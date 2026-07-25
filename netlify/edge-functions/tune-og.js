// Per-tune link previews: when the main page is requested with ?tune=..., the
// static Open Graph / Twitter meta tags are rewritten with the tune's title,
// artist and release year, so links shared to Facebook/Discord/X/etc unfurl
// as the song rather than the generic site card. Social crawlers don't run
// JavaScript, so this has to happen at the edge.
//
// Metadata comes from public/share-meta/<shard>.json, generated at build time
// by scripts/build-share-meta.js (256 small shards of hvsc-index.json, so a
// lookup fetches a few KB, cached per isolate). Unknown tunes and requests
// without ?tune= pass through untouched.

const shardCache = new Map();

// FNV-1a 32-bit, low byte selects the shard. Must match build-share-meta.js.
function shardOf(p) {
    let h = 0x811c9dc5;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return (h & 0xff).toString(16).padStart(2, '0');
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rewrite the page's title/description/OG/Twitter tags for one tune. */
export function injectTuneTags(html, tune, shareUrl) {
    const title = tune.t || tune.path.split('/').pop().replace(/\.sid$/i, '');
    const author = tune.a || '';
    const yearTok = (tune.r || '').trim().split(/\s+/)[0] || '';
    const year = /\d/.test(yearTok) ? ` (${yearTok})` : '';

    const ogTitle = escapeHtml(author ? `${title} — ${author}` : title);
    const desc = escapeHtml(
        `Listen to "${title}"${author ? ' by ' + author : ''}${year} — `
        + 'C64 SID music from the High Voltage SID Collection, playing right in your browser on SIDquake.');
    const url = escapeHtml(shareUrl);

    // Use replacer functions, not replacement strings: in a replacement string
    // `$&`, `` $` ``, `$1`... are special, so a tune title containing `$`
    // sequences would corrupt (or dump chunks of the page into) the meta tags.
    return html
        .replace(/<title>[^<]*<\/title>/, () => `<title>${ogTitle} - SIDquake</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, (_, p1, p2) => p1 + desc + p2)
        .replace(/(<meta property="og:title" content=")[^"]*(")/, (_, p1, p2) => p1 + ogTitle + p2)
        .replace(/(<meta property="og:description" content=")[^"]*(")/, (_, p1, p2) => p1 + desc + p2)
        .replace(/(<meta property="og:url" content=")[^"]*(")/, (_, p1, p2) => p1 + url + p2)
        .replace(/(<meta name="twitter:title" content=")[^"]*(")/, (_, p1, p2) => p1 + ogTitle + p2)
        .replace(/(<meta name="twitter:description" content=")[^"]*(")/, (_, p1, p2) => p1 + desc + p2);
}

export default async (request, context) => {
    const url = new URL(request.url);
    const rawTune = url.searchParams.get('tune');
    if (!rawTune) return context.next();

    // Normalise to the index form: path within the collection, no C64Music/.
    const p = rawTune.replace(/^\/+/, '').replace(/^HVSC\//, '').replace(/^C64Music\//, '');
    if (!/\.sid$/i.test(p) || p.includes('..')) return context.next();

    let tune = null;
    try {
        const shard = shardOf(p);
        let table = shardCache.get(shard);
        if (!table) {
            const res = await fetch(new URL(`/share-meta/${shard}.json`, request.url));
            if (res.ok) {
                table = await res.json();
                shardCache.set(shard, table);
            }
        }
        const row = table && table[p];
        if (row) tune = { t: row[0], a: row[1], r: row[2], path: p };
    } catch (_) {
        // metadata unavailable: serve the page untouched
    }
    if (!tune) return context.next();

    const page = await context.next();
    const html = await page.text();
    const shareUrl = `${url.origin}/?tune=${p.split('/').map(encodeURIComponent).join('/')}`;
    const headers = new Headers(page.headers);
    headers.delete('content-length');
    return new Response(injectTuneTags(html, tune, shareUrl), { status: page.status, headers });
};

export const config = { path: '/' };
