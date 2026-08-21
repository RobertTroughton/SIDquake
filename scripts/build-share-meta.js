#!/usr/bin/env node
// Shards HVSC tune metadata (title/author/released) into small JSON files so
// the tune-og edge function can look up a single tune without loading the
// ~12MB hvsc-index.json. Output: public/share-meta/00.json .. ff.json,
// each mapping "MUSICIANS/D/DRAX/ECM_Refresh.sid" -> [title, author, released].
//
// Runs during the Netlify build (npm run build); output is not committed.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'public', 'hvsc-index.json');
const OUT_DIR = path.join(ROOT, 'public', 'share-meta');

// FNV-1a 32-bit, low 12 bits select the shard. Must match tune-og.js and
// hvsc-browser.js - scripts/test-share-shards.js checks that all three agree.
//
// Math.imul, NOT `(h * 0x01000193) >>> 0`: h reaches ~4.3e9 and the prime is
// ~1.7e7, so the plain multiply exceeds 2^53 and silently loses the low bits
// the shard is taken from. That is not a hash - it left 212 of 256 shards in
// use, the largest holding 966 tunes against a median of 33.
//
// 12 bits, not 8: at 8 the shards are even but big (about 240 tunes each), and
// a deep link fetches one to play one tune. At 12 the median is 15 tunes and
// the largest 29, so a shared link downloads about 1.5 KB whichever tune it is.
function shardOf(p) {
    let h = 0x811c9dc5;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) & 0xfff).toString(16).padStart(3, '0');
}

function main() {
    const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    const shards = {};
    let count = 0;
    for (const e of index.entries || []) {
        // Keys use the ?tune= form: path within the collection, no C64Music/.
        const p = e.p.replace(/^C64Music\//, '');
        const shard = shardOf(p);
        (shards[shard] = shards[shard] || {})[p] = [e.t || '', e.a || '', e.r || ''];
        count++;
    }
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [shard, table] of Object.entries(shards)) {
        fs.writeFileSync(path.join(OUT_DIR, `${shard}.json`), JSON.stringify(table));
    }
    console.log(`share-meta: ${count} tunes across ${Object.keys(shards).length} shards -> public/share-meta/`);
}

main();
