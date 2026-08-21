#!/usr/bin/env node
/**
 * seam-check.js - render a real export in VICE and look at the raster splits.
 *
 * The logo players hand the VIC a different display mode above and below a
 * raster split, and the switch has to land in the two lines the sprite curtain
 * hides. If it lands late the first line of the info text is drawn with the
 * logo's charset pointer - one row of arbitrary bitmap bytes smeared across the
 * song title. That is invisible to every other test here: the 6510 emulator in
 * the WASM core has no VIC, and the converter tests never run the player.
 *
 * So this drives the real page to export a .prg, runs it in VICE with warp and
 * a screenshot at a known frame, and reports the colour of each line around
 * every split - so a seam that has moved shows up as a changed line index.
 *
 * Needs Playwright and VICE (neither is a dependency):
 *   npm install --no-save playwright
 *   apt-get install -y vice          # x64sc
 *
 *   node scripts/seam-check.js                       # default tune + logo
 *   node scripts/seam-check.js --keep=/tmp/seam      # keep .prg and PNGs
 *   node scripts/seam-check.js --visualizer=raistlinbarswithlogo
 *
 * The C64 ROMs VICE needs are the ones committed under roms/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { exportPRG, renderInVice, lineProfile } = require('./lib/seam-lib.js');

let failures = 0;
function check(ok, what, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

/**
 * The seam itself. Below the logo the screen goes: logo artwork, the flat pair
 * of lines the sprite curtain paints, then info text. A split that lands on the
 * wrong line leaves one line between the curtain and the text that was fetched
 * through the logo's pointers - the logo's video matrix read as character
 * codes, or its bitmap read as glyphs.
 *
 * Counting ink doesn't find it: the stray bytes are sparse, and 32 lit pixels
 * is well inside the range a row of text occupies. What separates them is
 * COLOUR. A line of info text carries the background plus the one or two
 * colours that row's text is in; a line fetched through the logo carries the
 * logo's palette, because the colours still come from the logo's colour RAM.
 * So the test is: the first line after the curtain must be as plain as the text
 * below it.
 */
function seamReport(prof, label) {
    const rows = prof.rows;
    // The logo is the first unbroken run of lines with something on them: it
    // starts at the top of the display window and ends where the curtain paints
    // its flat pair. (A logo with a two-line empty band across its full width
    // would fool this; none of the shipped ones has one.)
    const first = rows.findIndex(r => r.ink > 0);
    let logoEnd = first;
    while (logoEnd + 1 < rows.length && rows[logoEnd + 1].ink > 0) logoEnd++;

    // The curtain: the flat lines immediately below the logo.
    let curtainEnd = logoEnd;
    while (curtainEnd + 1 < rows.length && rows[curtainEnd + 1].ink === 0) curtainEnd++;

    // What a settled info line looks like, taken from the rows further down.
    const text = rows.slice(curtainEnd + 2, curtainEnd + 18).filter(r => r.ink > 0);
    const textColours = text.length
        ? Math.max(...text.map(r => r.colours)) : 2;

    const firstInfo = rows[curtainEnd + 1];
    console.log('  logo ends at y=' + logoEnd + ', curtain y=' + (logoEnd + 1) + '-' + curtainEnd +
        ', text tops out at ' + textColours + ' colours a line');

    check(!!firstInfo && firstInfo.colours <= textColours,
        label + ': the first line below the curtain is info text, not logo data',
        firstInfo ? 'y=' + firstInfo.y + ' has ' + firstInfo.colours + ' colours and ' +
            firstInfo.ink + ' lit pixels' : 'no line below the curtain');
    check(curtainEnd > logoEnd,
        label + ': the curtain covers the switch', 'y=' + (logoEnd + 1) + '-' + curtainEnd);
    return { logoEnd, curtainEnd, textColours, firstInfo };
}

(async () => {
    const args = process.argv.slice(2);
    const arg = (n, d) => (args.find(a => a.startsWith('--' + n + '=')) || '=' + d).split('=')[1];
    const opts = {
        sid: arg('sid', 'psych858o-xtrovert.sid'),
        visualizer: arg('visualizer', 'DefaultWithLogo'),
        logo: arg('logo', path.join(ROOT, 'public', 'PNG', 'Logos', 'facet-psychoandstinsen.png')),
        frames: Number(arg('frames', '12'))
    };
    if (args.includes('--no-logo')) opts.logo = null;
    const keep = arg('keep', '');
    const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'seam-'));
    fs.mkdirSync(dir, { recursive: true });

    console.log('exporting ' + opts.visualizer + ' with ' + path.basename(opts.sid) +
        (opts.logo ? ' + ' + path.basename(opts.logo) : ' (no logo)'));
    const prg = await exportPRG(opts);
    const prgPath = path.join(dir, 'seam.prg');
    fs.writeFileSync(prgPath, prg);
    console.log('  ' + prg.length + ' bytes -> ' + prgPath);

    // The switch is only late when the IRQ was delayed, and what delays it (a
    // music call, the dispatcher prologue) lands differently every frame - so
    // one frame proves nothing. Sample a spread of them.
    const base = Number(arg("start", "600"));
    for (let i = 0; i < opts.frames; i++) {
        const frame = base + i * 7;
        const pngPath = path.join(dir, 'frame-' + frame + '.png');
        renderInVice(prgPath, pngPath, frame);
        console.log('frame ' + frame + ' -> ' + path.basename(pngPath));
        seamReport(lineProfile(pngPath), 'frame ' + frame);
    }

    console.log(failures ? '\n' + failures + ' frame(s) show a glitched seam'
        : '\nevery sampled frame has a clean seam');
    console.log('(PNGs in ' + dir + ')');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
