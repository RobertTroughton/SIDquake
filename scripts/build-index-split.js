#!/usr/bin/env node
/**
 * build-index-split.js - lift the STIL commentary out of the HVSC index.
 *
 * STIL is about a third of public/hvsc-index.json (4.0 MB of 12.5 MB serialised,
 * on 29,509 of 61,157 entries), and it is read one entry at a time - for the
 * tune currently selected. Everyone who opens the browser pays for all of it.
 *
 * This writes two derived files from the committed index:
 *   public/hvsc-index-lite.json - the same index without the `s` field
 *   public/hvsc-stil.json       - { path: text }, fetched only when needed
 *
 * hvsc-browser.js prefers the lite index and falls back to the full one, so a
 * deploy that skips this step behaves exactly as before. It folds the STIL file
 * in lazily - on the first search, and when an info panel needs it - so
 * commentary stays searchable.
 *
 * Usage: node scripts/build-index-split.js
 * Output is generated - do not edit by hand.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const INDEX = path.join(PUBLIC, 'hvsc-index.json');
const LITE = path.join(PUBLIC, 'hvsc-index-lite.json');
const STIL = path.join(PUBLIC, 'hvsc-stil.json');

function main() {
    if (!fs.existsSync(INDEX)) {
        console.error(`Missing ${INDEX} - run npm run build-hvsc-index first.`);
        process.exit(1);
    }

    const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    const entries = index.entries || [];
    const stil = {};
    let withStil = 0;

    const lite = entries.map((e) => {
        if (e.s) {
            stil[e.p] = e.s;
            withStil++;
            const { s, ...rest } = e;
            return rest;
        }
        return e;
    });

    fs.writeFileSync(LITE, JSON.stringify({ ...index, entries: lite, stilSplit: true }));
    fs.writeFileSync(STIL, JSON.stringify(stil));

    const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0);
    console.error(`index split: ${entries.length} tunes, ${withStil} with commentary. `
        + `${kb(INDEX)} KB -> ${kb(LITE)} KB index + ${kb(STIL)} KB commentary.`);
}

main();
