#!/usr/bin/env node
/**
 * test-share-shards.js - the three copies of the share-meta shard hash agree.
 *
 * A shared link is served by a Netlify edge function (Deno), the shards are
 * written by a Node build script, and the browser reads one directly to start
 * playing before the collection index arrives. Three runtimes, so three copies
 * of the same function - and if any one drifts, a deep link 404s its metadata
 * and silently loses the preview and the fast start.
 *
 * Nothing imports across those boundaries, so this lifts each function out of
 * its file by text and runs all three over the real paths.
 *
 * Run with `node scripts/test-share-shards.js`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

/** Pull a named function's source out of a file and make it callable. */
function lift(file, name) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const at = text.indexOf(`function ${name}(p) {`);
    if (at === -1) throw new Error(`${file}: no function ${name}`);
    // Balance braces from the opening one so the whole body comes with it.
    const open = text.indexOf('{', at);
    let depth = 0, end = -1;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end === -1) throw new Error(`${file}: ${name} is not balanced`);
    // eslint-disable-next-line no-new-func
    return new Function(`${text.slice(at, end)}; return ${name};`)();
}

const impls = [
    ['scripts/build-share-meta.js', 'shardOf'],
    ['netlify/edge-functions/tune-og.js', 'shardOf'],
    ['public/hvsc-browser.js', 'shareShardOf'],
].map(([file, name]) => ({ file, fn: lift(file, name) }));

check(impls.length === 3, 'all three copies were found');

// The real paths, when the index is there; a representative sample otherwise,
// since the index is gitignored and rebuilt.
const INDEX = ['public/hvsc-index-lite.json', 'public/hvsc-index.json']
    .map(f => path.join(ROOT, f)).find(fs.existsSync);
let paths;
if (INDEX) {
    // The shards are keyed on the ?tune= form - the path inside the collection,
    // with no C64Music/ prefix - so hash what is actually hashed.
    paths = JSON.parse(fs.readFileSync(INDEX, 'utf8')).entries
        .map(e => e.p.replace(/^C64Music\//, ''));
} else {
    console.log('  note: no local HVSC index - checking a fixed sample instead');
    paths = [
        'MUSICIANS/H/Hubbard_Rob/Commando.sid',
        'DEMOS/0-9/1_45_Tune.sid',
        'MUSICIANS/G/Gray_Matt/Last_Ninja.sid',
        'GAMES/A-F/Delta.sid',
        'MUSICIANS/Ö/Öbb/ünïcode.sid',
    ];
}

let disagree = null;
for (const p of paths) {
    const first = impls[0].fn(p);
    for (const impl of impls.slice(1)) {
        if (impl.fn(p) !== first) {
            disagree = `${p}: ${impls[0].file} says ${first}, ${impl.file} says ${impl.fn(p)}`;
            break;
        }
    }
    if (disagree) break;
}
check(!disagree, `all three agree over ${paths.length} paths`, disagree || '');

// The shard name is what becomes a filename and a URL.
const shard = impls[0].fn(paths[0]);
check(/^[0-9a-f]{3}$/.test(shard), 'a shard name is three lowercase hex digits', shard);

// The multiply must not overflow into the bits the shard is taken from. A
// plain `h * 0x01000193` passes 2^53 and loses them, which left 212 of 256
// shards in use with the largest holding 966 tunes.
if (paths.length > 1000) {
    const counts = new Map();
    for (const p of paths) counts.set(impls[0].fn(p), (counts.get(impls[0].fn(p)) || 0) + 1);
    const sizes = [...counts.values()].sort((a, b) => a - b);
    const median = sizes[sizes.length >> 1];
    const max = sizes[sizes.length - 1];
    check(max <= median * 4, 'and the tunes are spread evenly across them',
        `${counts.size} shards, median ${median}, largest ${max}`);
} else {
    console.log('  note: too few paths to judge the spread');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
