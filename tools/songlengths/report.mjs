#!/usr/bin/env node
/*
 * Turns the scan journal into the three deliverables:
 *
 *   Songlengths.ours.md5    HVSC's file byte-for-byte, except the times we
 *                           disagree with, which carry our value instead. Every
 *                           comment, ordering and line ending is preserved, so a
 *                           diff against the original shows exactly what changed
 *                           and nothing else.
 *   Songlengths.frames.txt  our measurements with raster-frame counts as well as
 *                           times: loop start, loop period and total length, all
 *                           frame-exact, plus PAL/NTSC.
 *   songlengths-report.html a sortable, filterable table of every subtune with
 *                           HVSC's value, ours, the difference and a class.
 *
 * Usage:
 *   node tools\songlengths\report.mjs
 *   node tools\songlengths\report.mjs --out <dir> --md5 <file> --threshold 1.0
 *
 *   --threshold <s>   how far apart the two values must be before we rewrite
 *                     HVSC's entry (default 1.0 s). Entries we couldn't measure
 *                     - capped, errored, no loop found - are NEVER rewritten.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSonglengths, formatTimeMs, rewriteEntryLine } from './parse-md5.mjs';
import { classify, CLASSES } from './classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const flags = parseArgs(process.argv.slice(2));
const OUT = path.resolve(flags.out || path.join(HERE, 'out'));
const THRESHOLD_MS = (Number(flags.threshold) || 1.0) * 1000;

const meta = readJsonIfPresent(path.join(OUT, 'run-meta.json')) || {};
const MD5 = path.resolve(flags.md5 || meta.md5 ||
    path.join(REPO, 'public', 'HVSC', 'C64Music', 'DOCUMENTS', 'Songlengths.md5'));

if (!fs.existsSync(MD5)) {
    console.error(`\nCan't find Songlengths.md5: ${MD5}\nPass --md5 <file>.\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the journal

const results = new Map();   // "md5:subtune" -> result
let lines = 0;
for (const f of fs.readdirSync(OUT).filter(f => /^results-\d+\.jsonl$/.test(f))) {
    const text = fs.readFileSync(path.join(OUT, f), 'utf8');
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            // A re-run can legitimately measure the same subtune twice (e.g. after
            // --redo on a subset); last write wins.
            results.set(`${r.md5}:${r.subtune}`, r);
            lines++;
        } catch (e) { /* torn final line - see scan.mjs */ }
    }
}
if (!results.size) {
    console.error(`\nNo results in ${OUT}. Run scan.mjs first.\n`);
    process.exit(1);
}
console.log(`Loaded ${results.size.toLocaleString()} measurements (${lines.toLocaleString()} journal lines)`);

// Journal entries written before the format was recorded fall back to the header
// facts scan.mjs cached; if neither is available the column shows a dash rather
// than guessing.
let kindByPath = {};
try {
    const c = JSON.parse(fs.readFileSync(path.join(OUT, 'sid-kinds.json'), 'utf8'));
    if (c && c.kinds) kindByPath = c.kinds;
} catch (e) { /* optional */ }
const { lines: srcLines, entries } = parseSonglengths(fs.readFileSync(MD5, 'utf8'));
console.log(`HVSC file: ${entries.length.toLocaleString()} entries`);

// ---------------------------------------------------------------------------
// 1) Songlengths.ours.md5

const outLines = srcLines.slice();
let rewritten = 0, rewrittenSubtunes = 0;
for (const e of entries) {
    let changed = false;
    const texts = e.times.map((t, s) => {
        const r = results.get(`${e.md5}:${s}`);
        // Only override where we actually measured something we believe.
        if (!r || r.error || r.capped || (!r.looped && !r.fadedOut)) return t.text;
        if (t.ms != null && Math.abs(r.ms - t.ms) < THRESHOLD_MS) return t.text;
        changed = true; rewrittenSubtunes++;
        return formatTimeMs(r.ms);
    });
    if (changed) {
        outLines[e.lineIndex] = rewriteEntryLine(srcLines[e.lineIndex], e.md5, texts);
        rewritten++;
    }
}
const oursPath = path.join(OUT, 'Songlengths.ours.md5');
fs.writeFileSync(oursPath, outLines.join(''));
console.log(`\n1) ${path.basename(oursPath)}  - ${rewritten.toLocaleString()} entries / ` +
    `${rewrittenSubtunes.toLocaleString()} subtunes rewritten (threshold ${THRESHOLD_MS / 1000}s)`);

// ---------------------------------------------------------------------------
// 2) Songlengths.frames.txt

const framesOut = [];
framesOut.push('# SIDquake song lengths, frame-exact.');
framesOut.push('#');
framesOut.push('# One line per SID, mirroring Songlengths.md5 ordering. Each subtune is');
framesOut.push('# recorded as a comma-separated group, subtunes separated by spaces:');
framesOut.push('#');
framesOut.push('#   <md5>=<time>,<lengthFrames>,<loopStartFrames>,<loopFrames>,<kind> ...');
framesOut.push('#');
framesOut.push('#   time            M:SS.mmm, derived from lengthFrames at the tune\'s own rate');
framesOut.push('#   lengthFrames    raster frames from tune start to the repeat point');
framesOut.push('#                   (intro + one loop), or to where the music stops');
framesOut.push('#   loopStartFrames raster frames of intro before the repeating section');
framesOut.push('#   loopFrames      length of the repeating section in raster frames');
framesOut.push('#                   (0 when the tune ends rather than loops)');
framesOut.push('#   kind            L = loops, F = fades/ends, C = hit the scan budget,');
framesOut.push('#                   E = failed to render. Lower case = NTSC (59.826 Hz),');
framesOut.push('#                   upper case = PAL (50.1245 Hz).');
framesOut.push('#');
framesOut.push(`# Generated ${new Date().toISOString()} by tools/songlengths/report.mjs`);
framesOut.push(`# Engine: ${meta.engine || 'unknown'}   Source: ${path.basename(MD5)}`);
framesOut.push('');

let measured = 0;
for (const e of entries) {
    const groups = e.times.map((t, s) => {
        const r = results.get(`${e.md5}:${s}`);
        if (!r) return '-';
        if (r.error) return 'E';
        let kind = r.capped ? 'C' : (r.looped ? 'L' : 'F');
        if (r.isNtsc) kind = kind.toLowerCase();
        measured++;
        return `${formatTimeMs(r.ms)},${r.lengthFrames},${r.loopStartFrames},${r.loopFrames},${kind}`;
    });
    if (e.sidPath) framesOut.push(`; /${e.sidPath}`);
    framesOut.push(`${e.md5}=${groups.join(' ')}`);
}
const framesPath = path.join(OUT, 'Songlengths.frames.txt');
fs.writeFileSync(framesPath, framesOut.join('\r\n') + '\r\n');
console.log(`2) ${path.basename(framesPath)}  - ${measured.toLocaleString()} subtunes recorded`);

// ---------------------------------------------------------------------------
// 3) songlengths-report.html
//
// 80k rows will not go into a <table> - the DOM alone would be hundreds of MB and
// the tab would hang. The data is embedded as compact column arrays with a shared
// path table (paths repeat across subtunes), sorted and filtered in memory, and
// only the ~40 visible rows are ever in the DOM.

const fmtOf = (r, p) => {
    if (r.rsid != null) return r.rsid ? 1 : 0;
    const k = kindByPath[p];
    return k && k.rsid != null ? (k.rsid ? 1 : 0) : -1;
};

// How the tune ENDED, as distinct from how well it agrees with HVSC (the class).
//   0 loop  - a repeat was found
//   1 fade  - the music stopped
//   2 never - the scan budget ran out with neither
//  -1 error
const endingOf = (r) => r.error ? -1 : (r.looped ? 0 : (r.capped ? 2 : 1));

// Folder and filename are interned separately: folders repeat across every tune by
// the same composer, so two tables are SMALLER than one of full paths as well as
// being what the two columns need.
const folderIds = new Map(), folders = [];
const nameIds = new Map(), names = [];
const intern = (map, arr, v) => {
    let id = map.get(v);
    if (id == null) { id = arr.length; map.set(v, id); arr.push(v); }
    return id;
};

const rows = [];
const counts = Object.fromEntries(CLASSES.map(c => [c, 0]));
for (const e of entries) {
    for (let s = 0; s < e.times.length; s++) {
        const r = results.get(`${e.md5}:${s}`);
        if (!r) continue;
        const p = e.sidPath || '';
        const cut = p.lastIndexOf('/');
        const fid = intern(folderIds, folders, cut < 0 ? '' : p.slice(0, cut));
        const nid = intern(nameIds, names, cut < 0 ? p : p.slice(cut + 1));
        const cls = classify(r);
        counts[cls]++;
        rows.push([
            fid,                                  // 0 folder id
            s,                                    // 1 subtune
            e.times[s].ms == null ? -1 : e.times[s].ms,  // 2 HVSC ms
            r.error ? -1 : r.ms,                  // 3 our ms
            r.error ? 0 : r.lengthFrames,         // 4 length frames
            r.error ? 0 : r.loopStartFrames,      // 5 intro frames
            r.error ? 0 : r.loopFrames,           // 6 loop frames
            CLASSES.indexOf(cls),                 // 7 class
            r.isNtsc ? 1 : 0,                     // 8 ntsc
            r.error ? 0 : Math.round(r.scannedSeconds || 0), // 9 seconds scanned
            r.fellBack ? 1 : 0,                   // 10 needed the libsidplayfp rescue
            fmtOf(r, p),                          // 11 0 = PSID, 1 = RSID, -1 = unknown
            nid,                                  // 12 filename id
            endingOf(r),                          // 13 how the tune ended
        ]);
    }
}
const summary = CLASSES.map(c => `${c} ${counts[c]}`).join('  ');
console.log(`3) songlengths-report.html   - ${rows.length.toLocaleString()} rows`);
console.log(`   ${summary}`);

// Relative path from the report to the HVSC tree, so the folder/file links work
// when the page is opened straight off disk. Computed rather than hard-coded
// because --out and --hvsc both move.
const HVSC_DIR = meta.hvsc || path.join(REPO, 'public', 'HVSC', 'C64Music');
const hvscHref = path.relative(OUT, HVSC_DIR).split(path.sep).join('/');

const html = buildHtml({
    folders, names, rows, counts, hvscHref,
    meta: { ...meta, source: path.basename(MD5), generated: new Date().toISOString(), threshold: THRESHOLD_MS / 1000 },
});
const htmlPath = path.join(OUT, 'songlengths-report.html');
fs.writeFileSync(htmlPath, html);
console.log(`\nWritten to ${OUT}`);
console.log(`Open ${path.basename(htmlPath)} in a browser (${(html.length / 1048576).toFixed(1)} MB)\n`);

// ---------------------------------------------------------------------------

function buildHtml({ folders, names, rows, counts, hvscHref, meta }) {
    const data = JSON.stringify({ folders, names, rows, counts, hvscHref, meta, classes: CLASSES });
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIDquake vs HVSC song lengths</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --mut:#666; --line:#d8d8d8; --head:#f2f2f2;
          --zebra:#00000008; --hover:#3b7ddd24; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8e8ea; --mut:#9aa0a8; --line:#2c3038; --head:#1c1f25;
            --zebra:#ffffff0a; --hover:#3b7ddd38; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 18px 10px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:3; }
  h1 { margin:0 0 3px; font-size:16px; font-weight:650; }
  .sub { color:var(--mut); font-size:12px; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
  .chip { border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:99px;
          padding:3px 11px; font-size:12px; cursor:pointer; font-family:inherit; }
  .chip[aria-pressed="true"] { background:var(--fg); color:var(--bg); border-color:var(--fg); }
  .chip .n { opacity:.6; margin-left:5px; font-variant-numeric:tabular-nums; }
  .tools { display:flex; gap:10px; align-items:center; margin-top:9px; flex-wrap:wrap; }
  input[type=search] { flex:1; min-width:190px; padding:5px 9px; border:1px solid var(--line);
                       border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
  .count { color:var(--mut); font-variant-numeric:tabular-nums; font-size:12px; }
  #headclip { overflow:hidden; border-bottom:1px solid var(--line); background:var(--head); }
  #head { display:grid; background:var(--head);
          position:sticky; top:0; z-index:2; font-weight:600; will-change:transform; }
  #head div { padding:7px 9px; cursor:pointer; user-select:none; white-space:nowrap;
              overflow:hidden; text-overflow:ellipsis; }
  #head div:hover { color:#3b7ddd; }
  #scroll { overflow:auto; height:calc(100vh - 168px); position:relative; }
  #spacer { position:relative; }
  #rows { position:absolute; left:0; right:0; top:0; }
  .r { display:grid; border-bottom:1px solid var(--line); }
  /* Zebra striping keyed to the ABSOLUTE row index, not DOM position. The body is
     virtualised, so plain nth-child would restripe on every scroll step and the
     bands would visibly crawl. Flipping one class on the container inverts the
     parity instead, which costs nothing per row - important at 80k rows. */
  #rows      .r:nth-child(even) { background:var(--zebra); }
  #rows.odd  .r:nth-child(even) { background:transparent; }
  #rows.odd  .r:nth-child(odd)  { background:var(--zebra); }
  /* Listed after the stripes so it wins on equal specificity. */
  #rows .r:hover, #rows.odd .r:hover { background:var(--hover); }
  .r > div { padding:5px 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .pth { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .pth a { color:inherit; text-decoration:none; }
  .pth a:hover { color:#3b7ddd; text-decoration:underline; }
  .e-loop{background:#1f9d5522;color:#1f9d55}.e-fade{background:#fb8c0022;color:#fb8c00}
  .e-never{background:#e5393522;color:#ef5350}.e-err{background:#75757522;color:#9e9e9e}
  .tag { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; font-weight:600; }
  .t-match{background:#1f9d5522;color:#1f9d55}.t-close{background:#8bc34a22;color:#7cb342}
  .t-half,.t-double{background:#9c27b022;color:#ab47bc}.t-off{background:#fb8c0022;color:#fb8c00}
  .t-wild{background:#e5393522;color:#ef5350}.t-noloop{background:#78909c22;color:#90a4ae}
  .t-capped{background:#00acc122;color:#26c6da}.t-nohvsc,.t-error{background:#75757522;color:#9e9e9e}
  .empty { padding:36px; text-align:center; color:var(--mut); }
</style></head><body>
<header>
  <h1>SIDquake vs HVSC song lengths</h1>
  <div class="sub" id="meta"></div>
  <div class="chips" id="chips"></div>
  <div class="tools">
    <input type="search" id="q" placeholder="Filter by path…" autocomplete="off">
    <span class="count" id="count"></span>
  </div>
</header>
<div id="headclip"><div id="head"></div></div>
<div id="scroll"><div id="spacer"><div id="rows"></div></div></div>
<div class="empty" id="empty" hidden>Nothing matches those filters.</div>
<script id="d" type="application/json">${data.replace(/</g, '\\u003c')}</script>
<script>
const D = JSON.parse(document.getElementById('d').textContent);
const { folders, names, rows, counts, hvscHref, meta, classes } = D;
// hvscHref points at the HVSC root from wherever this file was written, so the
// links resolve when the page is opened straight off disk.
const href = (p) => hvscHref + '/' + p.split('/').map(encodeURIComponent).join('/');
const link = (target, text, title) =>
  '<a href="' + esc(href(target)) + '" title="' + esc(title) + '">' + esc(text) + '</a>';
const ENDINGS = ['loop', 'fade', 'never', 'err'];

const COLS = [
  { k:'Folder',    w:'minmax(150px,2fr)', cls:'pth', raw:1,
    get:r=>link(folders[r[0]], folders[r[0]], folders[r[0]]),
    cmp:(a,b)=>folders[a[0]]<folders[b[0]]?-1:folders[a[0]]>folders[b[0]]?1:a[12]-b[12] },
  { k:'File',      w:'minmax(140px,2fr)', cls:'pth', raw:1,
    get:r=>link(folders[r[0]] + '/' + names[r[12]], names[r[12]], folders[r[0]] + '/' + names[r[12]]),
    cmp:(a,b)=>names[a[12]]<names[b[12]]?-1:names[a[12]]>names[b[12]]?1:a[1]-b[1] },
  { k:'#',         w:'46px',  get:r=>r[1],                          cls:'num', cmp:(a,b)=>a[1]-b[1] },
  { k:'HVSC',      w:'92px',  get:r=>r[2]<0?'—':ms(r[2]),           cls:'num', cmp:(a,b)=>a[2]-b[2] },
  // A capped row never resolved a loop or an ending - its "length" is just where
  // the scan budget ran out, so show it as the lower bound it actually is.
  { k:'SIDquake',  w:'92px',  get:r=>r[3]<0?'—':(classes[r[7]]==='capped'?'≥':'')+ms(r[3]), cls:'num', cmp:(a,b)=>a[3]-b[3] },
  { k:'Diff',      w:'86px',  get:r=>(r[2]<0||r[3]<0)?'—':sd(r[3]-r[2]), cls:'num', cmp:(a,b)=>d(a)-d(b) },
  { k:'Class',     w:'92px',  get:r=>'<span class="tag t-'+classes[r[7]]+'">'+classes[r[7]]+'</span>', raw:1, cmp:(a,b)=>a[7]-b[7] },
  { k:'Ending',    w:'82px',  raw:1, cmp:(a,b)=>a[13]-b[13],
    get:r=>r[13]<0?'<span class="tag e-err">—</span>'
      :'<span class="tag e-'+ENDINGS[r[13]]+'">'+['loops','fades','never'][r[13]]+'</span>' },
  { k:'Format',    w:'76px',  get:r=>r[11]===1?'RSID':r[11]===0?'PSID':'—',  cmp:(a,b)=>a[11]-b[11] },
  { k:'Length fr', w:'92px',  get:r=>r[4]||'—',                     cls:'num', cmp:(a,b)=>a[4]-b[4] },
  { k:'Intro fr',  w:'88px',  get:r=>r[5]||'—',                     cls:'num', cmp:(a,b)=>a[5]-b[5] },
  { k:'Loop fr',   w:'88px',  get:r=>r[6]||'—',                     cls:'num', cmp:(a,b)=>a[6]-b[6] },
  { k:'Video',     w:'70px',  get:r=>r[8]?'NTSC':'PAL',             cmp:(a,b)=>a[8]-b[8] },
  { k:'Scanned',   w:'84px',  get:r=>r[9]?r[9]+'s':'—',             cls:'num', cmp:(a,b)=>a[9]-b[9] },
];
const GRID = COLS.map(c=>c.w).join(' ');
// Sum of each column's MINIMUM so the header and the rows share one width and stay
// aligned once the table is wide enough to scroll sideways.
// No regex here on purpose: this whole script is emitted through a template
// literal, so a backslash would be eaten as an escape before it ever reached the
// page. parseInt stops at the first non-digit, so slicing past "minmax(" is enough.
const MINW = COLS.reduce((n,c)=>n + parseInt(c.w.startsWith('minmax(') ? c.w.slice(7) : c.w, 10), 0);
const d = r => (r[2]<0||r[3]<0) ? Infinity : Math.abs(r[3]-r[2]);
function ms(v){ const t=Math.max(0,v|0), m=Math.floor(t/60000), s=Math.floor(t%60000/1000);
  return m+':'+String(s).padStart(2,'0')+'.'+String(t%1000).padStart(3,'0'); }
function sd(v){ const s=v<0?'-':'+'; const a=Math.abs(v); return s+(a/1000).toFixed(2)+'s'; }

document.getElementById('meta').textContent =
  rows.length.toLocaleString()+' subtunes · engine '+(meta.engine||'?')+
  ' · source '+(meta.source||'?')+' · rewrite threshold '+meta.threshold+'s · generated '+(meta.generated||'').slice(0,19).replace('T',' ');

// --- filters
const active = new Set();
const chips = document.getElementById('chips');
for (const c of classes) {
  if (!counts[c]) continue;
  const b = document.createElement('button');
  b.className='chip'; b.setAttribute('aria-pressed','false');
  b.innerHTML = c+'<span class="n">'+counts[c].toLocaleString()+'</span>';
  b.onclick = () => { active.has(c)?active.delete(c):active.add(c);
    b.setAttribute('aria-pressed', active.has(c)?'true':'false'); apply(); };
  chips.appendChild(b);
}

// --- header / sorting
let sortCol = 5, sortDir = -1;   // Diff: biggest disagreement first, the interesting end
const head = document.getElementById('head');
head.style.gridTemplateColumns = GRID;
head.style.minWidth = MINW + 'px';
document.getElementById('spacer').style.minWidth = MINW + 'px';
COLS.forEach((c,i) => {
  const el = document.createElement('div');
  el.onclick = () => { if (sortCol===i) sortDir=-sortDir; else { sortCol=i; sortDir=1; } apply(); };
  head.appendChild(el);
});
function paintHead(){ [...head.children].forEach((el,i)=>{
  el.textContent = COLS[i].k + (sortCol===i ? (sortDir>0?'  ▲':'  ▼') : ''); }); }

// --- virtual scroll: only the visible slice is ever in the DOM
const ROW_H = 27, PAD = 8;
const scroll = document.getElementById('scroll');
const spacer = document.getElementById('spacer');
const body = document.getElementById('rows');
let view = rows;

function apply(){
  const q = document.getElementById('q').value.trim().toLowerCase();
  view = rows;
  if (active.size) view = view.filter(r => active.has(classes[r[7]]));
  if (q) view = view.filter(r => (folders[r[0]] + '/' + names[r[12]]).toLowerCase().includes(q));
  const cmp = COLS[sortCol].cmp;
  view = view.slice().sort((a,b)=>{ const v = cmp(a,b); return (v===0? a[0]-b[0] : v) * sortDir; });
  document.getElementById('count').textContent = view.length.toLocaleString()+' of '+rows.length.toLocaleString()+' shown';
  document.getElementById('empty').hidden = view.length > 0;
  spacer.style.height = (view.length*ROW_H)+'px';
  paintHead(); scroll.scrollTop = 0; render();
}
function render(){
  const first = Math.max(0, Math.floor(scroll.scrollTop/ROW_H) - PAD);
  const n = Math.ceil(scroll.clientHeight/ROW_H) + PAD*2;
  const slice = view.slice(first, first+n);
  body.style.transform = 'translateY('+(first*ROW_H)+'px)';
  body.className = (first & 1) ? 'odd' : '';   // keep the stripes on absolute row parity
  let h = '';
  for (const r of slice) {
    h += '<div class="r" style="grid-template-columns:'+GRID+'">';
    for (const c of COLS) {
      const v = c.get(r);
      h += '<div class="'+(c.cls||'')+'">'+(c.raw ? v : esc(String(v)))+'</div>';
    }
    h += '</div>';
  }
  body.innerHTML = h;
}
function esc(s){ return s.replace(/[&<>]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
const headEl = document.getElementById('head');
scroll.addEventListener('scroll', () => {
  headEl.style.transform = 'translateX(' + (-scroll.scrollLeft) + 'px)';
  render();
}, { passive:true });
addEventListener('resize', render);
let t; document.getElementById('q').addEventListener('input', ()=>{ clearTimeout(t); t=setTimeout(apply,140); });
apply();
</script></body></html>`;
}

function readJsonIfPresent(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('--')) { out[key] = nextArg; i++; }
        else out[key] = true;
    }
    return out;
}
