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

// FNV-1a 32-bit, low byte selects the shard. Must match tune-og.js.
function shardOf(p) {
    let h = 0x811c9dc5;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return (h & 0xff).toString(16).padStart(2, '0');
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
