# SIDquake — TODO

Outstanding work only. `[WASM]` / `[asm]` items need a rebuild to land.

---

# Part 1 — UX and product

From a six-persona review of the whole app (visualiser-led musician, plain-info
musician, teenage beginner, music-disk wrangler, phone drive-by listener,
screen-reader + keyboard user). Every file:line below was checked against the
source; where a claim still needs a browser to confirm it, it says so.

## Suggested order

Ranked by value against effort, not by section order. Each line names the section
that holds the detail.

1. Ship the preview GIFs and set `animated: true` — one per grid card. *(Preview)*

Bigger pieces worth planning rather than picking up: the live in-browser preview,
recipe files plus the `sidquake-build` CLI, the listener-first entry point, and
the memory work already scoped as V2.01 in Part 2.

## Broken things

Verified defects, not preferences. These come first because each one silently
produces a wrong result or dead UI.

- **Animated visualiser previews are dead code.** `ui.js:963-990` probes for
  `prg/<id>.gif` and swaps on hover, gated on `visualizer.animated`. No registry
  entry sets `animated: true` and there are no `.gif` files in `public/prg/`.
  Users pick a *motion* effect from a frozen still.

## Analysis timing — run it in the background, then ask a better question

**The problem.** Two separate slow passes, both unconditional, neither explained
before it starts.

1. **On every load**, `analyzer.analyze(30000)` (`ui.js:702`) emulates 30,000
   frames — ten minutes of PAL playback — synchronously, so the overlay it sits
   behind cannot even update (see "Synchronous analysis" below). Nobody who only
   wants to *hear* the tune needs this.
2. **At Generate**, `runTuneAnalysis` renders the whole tune to find its loop or
   fade-out (`ui.js:2966` for spectrometer players, `ui.js:3002` for everyone
   else). Minutes on a long tune, behind a full-screen modal overlay, at the last
   click of a multi-tab wizard.

**The design: start it on load, in the background, and never block on it unless
the user reaches Generate first.** The user spends a minute or two picking a
visualiser, a logo and a palette anyway. Spend that time rendering. Show a small
non-blocking status chip in a corner ("Analysing tune… 1:20 scanned · ✕") rather
than a modal, and let the user ignore it, cancel it, or carry on.

That changes what there is to ask about. The question stops being "are you
willing to wait several minutes?" — a cost the user cannot judge and resents
being handed at the last click — and becomes a plain display choice on the Song
tab: **"Show the song length (MM:SS) on screen?"**, already answered by the time
they get there. For spectrometer players the bake is simply ready when they reach
Export, and no prompt is needed at all.

- **Done: the scan runs in the background** from the moment the Studio opens,
  reporting in a corner chip (`#analysisChip`), cancellable from the chip, and
  aborted on a tune change or an engine-setting change. The full-screen overlay
  now appears only when Generate is pressed before the scan has finished, and it
  adopts the running job rather than starting a second render. A user who stops
  the scan is not asked again at Generate.
- **Done: the Song tab is a length panel** — measuring / measured / typed / not
  measured, with Measure, Stop, a manual `m:ss` entry and a "show the song length
  on the C64 screen" toggle. A typed length or an unticked toggle both skip the
  scan entirely at export.
- **Done: skipping is offered back.** Cancelling or skipping always produces a
  file, and the completion panel invites the user to measure it and build again.
- **Move the too-long check before the render.** `resolveAdvancedRate` returning
  null (`ui.js:2988-2995`) tells the user "this tune is too long for the
  spectrometer" *after* minutes of rendering.
- **Defer the 30,000-frame load analysis** until the Studio opens (`ui.js:674`).
  A listener never needs it; it costs 63 KB of WASM and seconds of CPU per load.

**What already works, and what has to be built.** The transport is ready — the
bake runs in a real Web Worker, each job has its own `AbortController` reachable
by an `abort` message (`spectrometer-bake-worker.js:87-89`), progress is posted
back per job id, and the job table is on a global so `ui.js` and `prg-builder.js`
share one worker and one render cache. Backgrounding needs no architectural
change. The gaps:

- **Done: the worker serialises jobs.** Runs go through a promise chain, so the
  worker no longer depends on its caller keeping one analysis in flight. A run's
  AbortController is registered when its message lands rather than when the run
  starts, so aborting a queued job is honoured before it begins — and `ensureRows`
  now refuses an already-aborted signal, which a cache hit used to sail past and
  report success for.
- **Still open: rendering while the tune plays** is two cores' worth of work.
  Check it on a phone before backgrounding there — the Studio does not auto-open
  on phones once that change lands, which already limits the exposure.

**Caching, which matters as much as the timing.** `createBakeCore` keeps exactly
one render slot (`spectrometer-bake-core.js:276-300`), in memory only. So:
re-exporting the same tune is free, A -> B -> A re-renders A, and a page reload
loses everything. Worse, `tuneKey` (`spectrometer-bake-core.js:52`) hashes the
whole SID *including the header*, and the bytes come from `createModifiedSID()` —
so **editing the title after an analysis invalidates it and forces a full
re-render**.

- **Done: `cache.rows` is a 4-entry LRU.** A -> B -> A no longer re-renders A.
- **Done: the header text is out of the key.** The three 32-byte name/author/
  released fields are skipped; everything else in the header (load/init/play
  addresses, song count, speed flags, the v2 chip fields) does change the audio
  and stays in. `scripts/test-bake-cache.js` drives the core with a stub engine
  and counts renders, so both of these are covered by `npm test`.
- **Done: the summary is persisted to IndexedDB** (`public/analysis-store.js`),
  keyed by the same content hash plus the settings that change what a scan finds.
  A tune measured once is not measured again — across reloads, and across runs of
  the same queue. Everything in there fails quietly: a private window or blocked
  storage is just a cache miss. Old entries are dropped past 500, and a schema
  number retires stored shapes rather than handing back stale fields.
- Make the cache importable, so `tools/songlengths/`'s journal — the same
  measurement, already computed across HVSC — can prime it.
- Check whether `DOCUMENTS/Songlengths.md5` ships inside `hvsc-data/C64Music.7z`;
  if it does, index it into `hvsc-index.json` (which today carries only path,
  title, author, released) and the length for an HVSC tune becomes a lookup
  instead of a render. **Not confirmed** — the archive is an unfetched LFS
  pointer in a fresh clone.

Related and already scoped further down: "Stop searching / use what we have", and
prompting at the cap instead of surrendering silently. Both matter more once the
scan is something the user watches rather than waits on.

## Progressive disclosure — what to show, hide, and restore

The personas split cleanly into two populations, and today the app serves
neither well: the beginner meets up to nine tabs and four unjudgeable dropdowns,
while the power user finds the controls they want deleted or unreachable.

**Default-visible.** Title / Author / Copyright (as real `<input>`s with a
character counter — they end up on the C64 screen, they are not trivia); the new
song-length row; the sub-tune selector; the visualiser grid; the method cards;
logo / bitmap; font; bar style; colour effect and palette; scroller; compression
(as one select line, not three large radio cards); the export manifest; the
post-export timeline and memory map.

**Advanced-hidden.** Done for Technical Details (now collapsed) and for the
Export tab: frame rate, max stored bars, analysis engine and the restored
loop-search window + shortest-loop threshold all sit inside a remembered
`<details>`. Still to fold in: the memory-bank override, once
`createLayoutSelectorHTML` is wired to a real `selectedLayoutKey`.

**Neither — needs a second path. Done.** The landing card offers a quick route:
four looks with previews, one button, a file. It sets the same selection the
Studio does and calls the same export, so nothing is a special case; the Studio
is now "Change everything" rather than the only way through. Still wanted: the
previews here are stills like the grid's, so this is the other place the
animated previews below would pay off.

**Structural fixes that serve both populations:**

- **Done: the visualiser and option memory survive a reload.** The player, data
  source, option values and gallery image picks go into `sidquakeSession` next to
  `sidquakeAdvanced`. Two things are deliberately left out: the fields that
  describe the tune currently open (title, author, copyright, sub-tune, typed-in
  length — the option snapshot is a sweep of the whole panel, so it catches them),
  because carrying those into a new session would stamp one tune's credits onto
  the next; and the advanced settings, which have their own store and would
  otherwise exist in two places that drift apart. An uploaded image is recorded by
  name only in a recipe and not at all here — a name cannot be re-read as a file,
  and storing one would promise something the next page load could not deliver.
  Note that the same
  state is most of a recipe file, so the two should be designed together.
- **Drop the "2 / 8" wizard framing on desktop.** The rail is the navigation; the
  counter implies mandatory steps that are all already correct. Keep it at narrow
  widths where the rail is hidden — that rationale is already in
  `studio-modal.js:177`.
- **Don't stack a success toast over the freshly opened Studio** (`ui.js:748`).

## Language — the beginner's jargon audit

The teenage-beginner persona could not complete a release, and the cause was
almost entirely vocabulary. A first pass has been through the front door, the
Studio panel copy, the method cards, the compression labels, the multi-song
warning and the greyed-out reasons (which now describe the *look*, not the
tune, and carry the SID's address range for the expert). Still to do:

- **"PRG" still appears** in the About tab, the Releases copy and the memory
  map. The button and the completion panel say what it is now; the rest doesn't.
- **The logo input's description** ("320x200 or 384x272 PNG; only the top 11
  char rows (88px) are shown. Charset-friendly images export as a charset") is
  four unknown words to a beginner and belongs behind the same disclosure the
  Advanced settings use.
- **"Max stored bars — 5 slices (finest)"** is unguessable. Now that it is
  advanced-hidden it matters less, but it still needs a sentence saying what a
  slice is.
- **Move "Embed HVSC" out of the main tab row.** It is a developer page sitting
  next to the one tab a newcomer needs.
- **Done: the completion panel** replaces the self-dismissing "Saved …" toast —
  what the file is, an emulator link and three steps to run it, the SYS address
  explained rather than printed, where releases get shared, and an offer to
  measure the song length and rebuild when it was skipped.

## Accessibility

No `aria-live`, `role="status"` or `role="alert"` exists anywhere in
`public/*.js` or `public/*.html` — confirmed by grep. The modal plumbing (focus
save/restore, Escape, Tab traps in `error-modal.js` and `studio-modal.js`) is
well built; the failures are those good patterns not having been applied to the
other twenty places that needed them.

**Blockers.**

- **The rail is updated in place — done.** Focus is carried across a real
  rebuild (`_preservingFocus`), the rail only scrolls when the tab actually
  changed, and `renderRail` now compares the tab-id signature: when the tab set
  has not changed it updates the existing buttons' active state and status glyph
  instead of recreating them, so typing in a panel leaves the rail's DOM alone.
  `renderNav` still rebuilds its two buttons and position label each refresh —
  three nodes, so it was left as it is.
- **Modal precedence — done.** The two hand-maintained id lists are gone (and the
  one in `ui.js` had already drifted, missing the logo tool). Every overlay
  carries `data-overlay`, and `overlay-stack.js` works out what is above what
  from the z-index and document order actually in force, so a new overlay is
  covered by tagging its markup. A smoke check fails if a fixed element above the
  page is missing the attribute. The logo tool now traps Tab, hands focus back to
  the button that opened it (looked up on close, since the preview is rebuilt
  while the dialog is open) and blurs rather than stranding focus in a hidden
  dialog when that button is gone; its arrow handler is scoped to the canvas, so
  the Size slider keeps its own arrow keys.
- **The file load still has no Cancel, and can't have one in JS.** `sid_analyze`
  is a single synchronous WASM call — measured at ~470 ms for a one-song tune on
  a fast desktop, and it runs the whole loop again per subtune — so the main
  thread is held for its entire run and a Cancel button would be unclickable.
  What was fixable is fixed: the overlay used to tick a fake `setInterval`
  percentage the browser could not deliver until after the call had finished, so
  it sat at 0% and jumped to 100%. It now says what is happening and that the
  page will pause, and yields a frame so that message is on screen before the
  freeze. A real Cancel needs `[WASM]`: chunk `sid_analyze` into resumable
  batches with an entry point the JS side can drive frame by frame. Random SID
  is cancellable, and the overlay is a labelled dialog that announces on a
  throttle, focuses Cancel and makes the page behind `inert`.
- **HVSC results now paint in chunks.** It is a proper listbox — roving
  tabindex, arrows, Home/End, PageUp/Down, type-ahead, announced counts — and a
  search paints 60 rows at a time across frames, abandoning the tail when the
  next keystroke arrives, so typing costs one chunk rather than 500 rows. Still
  not windowed: once typing stops, all 500 rows end up in the DOM. That only
  matters if the cap is raised.

**Contrast** (computed from the tokens in `styles.css:7-68`; AA needs 4.5:1):

**Done since:** transient toasts are polite status regions rather than dialogs
that steal focus and hand it back two seconds later; the icon-only modal close
buttons, the transport and the sampling-quality select have accessible names;
Play/Pause renames itself with its glyph; the speed buttons carry `aria-pressed`
inside a labelled group; and the 22px transport / search-clear targets meet the
24px minimum.

**Contrast — done.** `--text-muted` and the white-on-amber buttons cleared AA
earlier; this pass added `--border-control` (#6e6e85, 3.17:1 against the tightest
surface) for every text field's boundary, lifted `--error` to #e07070 (4.84:1 on
its own tinted background), gave `.btn` primary text, and raised the disabled
Generate button to 3.1:1 — technically exempt, but it is disabled for most of a
session, so "unreadable most of the time" was the wrong outcome. The C64 swatch
strip keeps its colours and gains a light divider, since nine of the fifteen
neighbouring pairs are under 3:1 against each other.

- Leave the C64 palette swatches alone — reproducing the machine's colours is the
  point, and 1.4.11 exempts them. Give the chips a visible boundary and put a
  lighter divider between `.color-slider-track` segments instead.

**Motion — done.** The global `prefers-reduced-motion` block, the floating-notes
guard, a persisted footer toggle for the drifting notes (since "I find this
distracting" is not the same preference as the OS setting), and stilled spinners
under reduced motion, which matters because a scan can run for minutes.

**Structure.** Done: the Tool tab is a `<main>` with a heading and a skip link,
the Studio's heading order runs h2 → h3, the rail is a real `tablist` whose
tabs carry `aria-selected` / `aria-controls`, answer to the arrow keys and cost
one tab stop, and the document has a single `<h1>` (the Releases heading was a
second one).

**Zoom.** Done: the footer wraps rather than crushing the status text out of
sight, drops the summary below 900px, and carries the current tab's status where
the rail is hidden — which on a 1440px monitor is exactly 200% zoom. The export
manifest's fixed 110px label and 150px status columns left the value 36px of a
320px screen; below 480px the three cells stack down the page instead (234px for
the value), and the table scrolls inside its own box above that. Still open: 49
`font-size: *px` declarations (down to 9px) ignore a raised browser default font,
though zoom scales them.

## Mobile and first impression

The site is engineered carefully — 25 KB of render-blocking CSS, deferred
stylesheets, pre-hidden modal DOM, all three `.wasm` modules lazily loaded, a
`dvh`/safe-area-aware modal layout, and a Playwright geometry harness. The
problem is aim: every optimisation assumes a visitor who already wants to export
a PRG.

- **Deep links play from their share-meta shard now**, so nobody waits on the
  index to hear anything, and the shards are even. The lopsidedness turned out to
  be a bug rather than a tuning problem: `h * 0x01000193` passes 2^53 and loses
  exactly the low bits the shard was taken from, which left 212 of 256 shards in
  use with the largest holding 966 tunes against a median of 33. With `Math.imul`
  and 12 bits it is 4,096 shards, median 15 tunes and largest 30 — about 1.5 KB
  raw whichever tune a link points at, against a 31 KB worst case.
  `scripts/test-share-shards.js` lifts the function out of all three files that
  carry a copy (Node build script, Deno edge function, browser) and checks they
  agree over every path in the index, since nothing can import across those
  boundaries. The *listing* behind the player still waits for the full index —
  a per-directory shard would fix that properly — but it no longer waits behind
  a bare spinner: it says "Loading the collection", and counts the megabytes as
  the body streams, announced politely so a screen reader is not read every
  chunk.
- **Done: STIL is split out of the index** — 4.0 MB of 12.5 MB serialised, on
  29,509 of 61,157 entries. The browser fetches `hvsc-index-lite.json` (1,121 KB
  gzipped, against 2,042 KB) and pulls `hvsc-stil.json` only when something needs
  it. It is part of the search haystack, so a search kicks the fetch off and
  re-runs once it lands: first results are immediate, commentary matches fold in
  a moment later.
- **Done: an early tap on the upload buttons is held, not dropped.** They ship in
  static HTML while their handlers attach in `ui.js`, fourth in a deliberately
  yielded load chain, so for the first second or two they looked live and did
  nothing. A small inline script holds the tap, marks the button as waking, and
  replays it the moment the controller exists. Upload SID needs nothing from
  `ui.js` at all, so it opens the file picker immediately; a file chosen that
  early is still on the input, and the change event is re-fired once `ui.js` is
  listening.
- **`public/songlengths-report.html` is 1.4 MB** of internal QA output, deployed
  and publicly reachable. It is disallowed in `robots.txt` now, but it is still
  8% of `public/` for a dev artifact — it belongs outside the deployed directory,
  which is the owner's call since it is deliberately committed.
- **Done: the icon font is self-hosted and subset.** The whole solid set — ~150 KB
  of webfont plus ~100 KB of stylesheet, from a third-party origin on the
  critical path — is replaced by the 59 glyphs the site uses: 5.6 KB of woff2 and
  3.4 KB of CSS, served from our own origin, with the cdnjs preconnect gone.
  `scripts/build-icon-font.py` regenerates both (Python + fonttools; `--check`
  diffs rather than overwrites), and reads Font Awesome's own alias selectors so
  the FA5 names still in the markup (`fa-cogs`, `fa-times`) resolve. A browser
  check fails if anything is fetched from cdnjs again.

## The listener product

A self-hosted 61,157-tune mirror, full-collection search, a real
libsidplayfp player with sub-tunes, STIL commentary, a spectrum visualiser,
per-tune share URLs, edge-rendered Open Graph unfurls
(`netlify/edge-functions/tune-og.js`) and crawlable per-composer pages
(`scripts/build-seo-pages.js`) all already exist. They are filed under an
acronym, inside a modal, behind a button, on a page whose headline addresses
composers. The only landing-page link to `/music/` is fifteen words at the end of
a credits paragraph (`index.html:502`), and the "Releases" tab — the one that
sounds like music — is 48 screenshots linking off-site to CSDb, with nothing
playable, despite every one of those tunes existing in the mirror.

- Give the Tool tab a playable hero: a tune already loaded, big play button,
  spectrum running (the visualiser's idle demo wave was built for this), a
  "Shuffle" that resolves in under a second, and the search box promoted out of
  the modal.
- Rewrite the subtitle so it doesn't tell 95% of arrivals they're in the wrong
  place. Keep both audiences in one sentence.
- **Done:** the browser is titled "61,000 C64 tunes" with HVSC as a subtitle,
  its buttons say "Use this tune" / "Close" rather than "Select" / "Cancel", and
  the landing page links `/music/` for people who only came to listen.
- **The Releases tab still isn't playable, and probably can't be as it stands:**
  the cards are CSDb releases, and SIDquake does not hold those tunes — HVSC
  lags new releases by months. Playing them would mean hosting the .sid
  alongside each entry, which is a decision about what the site distributes.
- Add a seek bar and a total duration to the player (`sid-player.js:334` shows
  elapsed only) — `tools/songlengths/` already produces exactly this data.
- Auto-advance within a folder, and `localStorage` favourites.
- The conversion moment writes itself: under the player, "Want this running on a
  real C64? Make a demo →". A listener funnel is where the next C64 musician
  comes from; the creator funnel is a few hundred people worldwide who will find
  the Studio through one extra tap.

## Batch, recipes and automation

The exporter assumes one tune, one sitting, one human, and forgets most state
between tunes. A 14-tune music disk is ~15 interactions each, ~300 in total, with
a human required between every blocking wait.

- **Done: multi-file drop and a queue.** Several SIDs load the first and list
  the rest; "Export all with these settings" walks the queue, reporting per-tune
  state and noting any tune that had to fall back to a different player. The
  fade-out prompt is suppressed during a run so a batch cannot stall on a modal.
- **Done: choose where a set goes.** Downloads folder (as before), one zip, or a
  folder picked with `showDirectoryPicker()` — that last option only appears where
  the browser has it. The choice is remembered. A file that cannot be written into
  the chosen folder falls back to a download rather than being lost after the user
  has already waited for it. The zip is written by `public/zip-writer.js`: stored
  entries, no dependency (an exomizer-crunched PRG is already compressed, so
  deflate would buy nothing), covered by `scripts/test-zip-writer.js`. Recipes
  written by the "with every PRG" switch go into the same place.
- **The queue no longer re-measures a tune it has already measured.** Each export
  still blocks on the first scan of a tune it has never seen, but the persisted
  analysis cache (above) means a second run of the same set — or the same set
  after a reload — skips straight past.
- **Recipes exist** (`.sqrecipe.json`, saved and loaded from the Export tab):
  player + data source, every option value, gallery image picks, sub-tune,
  forced-loop answer, song-length choices, compression and the analysis
  settings. Done since:
  - **A `built` block** — filename, load address, SYS address, span, file size,
    block count, compression, loop frames and an FNV-1a of the PRG bytes,
    recorded after an export so two builds can be diffed. The pipeline is
    deterministic (no timestamp reaches the PRG), so same inputs give same
    bytes. It is dropped again the moment the settings stop matching the ones
    that produced it, so a recipe never claims a build it would not reproduce.
  - **One alongside every PRG**, behind a switch on the Export tab (off by
    default — a second download per export is not something to start doing
    unasked). The choice is remembered.
  - **Drop a recipe onto the page** to apply it. It carries no tune, so the
    loaded one is left alone.

  - **Applied across a whole queue.** A settings file dropped with (or before) a
    set is held for the run and re-applied to every tune, minus its song block —
    sub-tune, forced loop and a typed-in length describe the tune the recipe was
    made from, not the next one. The queue says when that is what it is building
    from.

  Still open:
  - **Custom uploaded images can only be named, not carried.** A recipe records
    the slot and the filename and asks for the image again; a gallery pick
    restores in full.
- **A `sidquake-build` CLI.** The option-provider refactor is done —
  `prg-builder.js` reads option values through `optionValue(id)` and has one DOM
  read left, for the `File` in a file input. What remains is a headless logo
  path (`convertLogoPNG` uses `new Image()` and a canvas), `fetch` shimmed to
  `fs`, and the wrapper itself. The precedent is already in the repo:
  `tools/songlengths/scan-worker.mjs:37` loads `public/sidquake.js` /
  `public/sidplayfp.js` in Node by passing `wasmBinary` directly and imports
  `spectrometer-bake-core.js` unmodified, with a resumable JSONL journal and
  `--jobs`. The DOM coupling in `prg-builder.js` is six call sites (`:849`,
  `:872`, `:945`, `:1129`, `:1174`, `:1557`) — replace them with an injected
  option provider (which is the snapshot above) and the module is DOM-free.
  `fetch` shims to `fs`; the only genuine browser dependency left is
  `convertLogoPNG`'s `new Image()` + canvas (`:1060`).
- **Done: filename templates** — `{name}`, `{title}`, `{author}`, `{song}`,
  `{index}`, carried in a recipe so a set names its files consistently. The
  fallback is real now: a title with nothing a C64 directory can hold used to
  produce a file called `.prg`, because the `'output'` fallback only fired when
  there was no filename at all, not when sanitising emptied it.
- **Preferred VIC bank is in** (Advanced settings), soft, falling back to
  automatic with a warning when the tune leaves no room for it. **Reserved
  ranges are in too**, next to it: `$C000-$CFFF, $0900` style, a bare address
  meaning its page, with anything unparseable named rather than silently
  dropped. Unlike the bank they are hard — the code page search, the VIC bank
  choice and the free-block scoring all avoid them, and an export that cannot
  place the player around them fails with a message that says so instead of
  using the memory anyway. The placement plan on the Export tab re-runs as they
  change, so the effect is visible before building. Still open: a *preferred*
  code region, as opposed to ranges to avoid.
- **`createLayoutSelectorHTML` (`ui.js`) is still unreachable dead code.** It
  offers the *fixed-bank* layouts, which only the three non-relocatable players
  use; everything else places through `planRelocationCodeOnly`, which the bank
  preference now drives. Either wire it up for those three, or drop it together
  with the fixed-bank path when V2.01 retires them.
- **Done: blocks, span and wasted space** are reported on the completion panel —
  disk blocks because that is the unit a release is budgeted in, where the
  program runs, and a warning when an uncompressed file is mostly the empty
  space between its parts. The memory map still draws those holes as "unused",
  which reads as free RAM rather than bytes paid for.
- **Done: the layout is shown before the export.** Picking a player runs the same
  placement the export would (`previewPlacement`, on a scratch builder so the real
  one and `lastSysAddress` are untouched) and reports the SYS address, where the
  music sits, the code page, the graphics address and VIC bank, and the span so
  far. It says plainly that it is a plan: the song data, the player stub and any
  bitmaps are placed later, so that span is a floor. The memory map still waits
  for a real export, because that one is the finished image. Still open: an
  estimated compressed size, which needs a run through exomizer to be worth
  printing.

## Preview — the missing feedback loop

There is no preview of the visualiser at any fidelity, anywhere: not a canvas
mock, not a GIF, not an emulator. Every aesthetic decision — bar style, colour
effect, palette, font, logo, background — is made blind, exported, and checked by
alt-tabbing to VICE. That round trip is minutes long and it is the top-ranked
wish of both experienced musicians and the beginner alike.

- **Ship the eleven GIFs** the hover path at `ui.js:963-990` already expects, and
  set `animated: true`. Cheapest possible win.
- **A live in-browser mock** of the selected player driven off the `AnalyserNode`
  — `hvsc-visualizer.js` already proves the approach — updating as options change.
- **Show the converted logo**, C64-quantised with cell colour clash visible, next
  to the source. Today the preview is the *input* PNG
  (`image-preview-manager.js:1077`); the classifier already computes the real
  result to badge it.
- **Live palette preview for custom fades**, not just the five presets — the
  presets already render through the real `getHeightColorTable` (`ui.js:1999`).
- **A text-layout preview** of the three 32-column rows with real centring, font
  case and PETSCII substitution applied.

## Creative control gaps

- **Still open: the logo's own background** is fixed by the PNG converter with
  no override (`$d021`-`$d024`). Border and screen are separate controls now.
- **No scroller on the bars-with-logo players.** Bars + logo + greetings is the
  standard release layout and it is not buildable; `scrollText` exists only in
  `scrapcolumns.json` and `simplebitmapwithscroller.json`.
- **No Group field.** Scene releases are handle / group, and the Default player
  already has three 32-byte text slots.
- **The Default player prints the full hardware block** (`Default.asm:104-141`)
  with no option to suppress it, so the only minimal player is a *technical*
  screen rather than a tasteful one.
- **No song length for multi-song SIDs** (`prg-builder.js:2267`, `ui.js:3002`),
  no analysis run, forced looping disabled — and the forfeit is spelled out only
  inside the Spectrometer warning, which never appears for the players a
  multi-song release would use.
- Text is always centred (`prg-builder.js:555`); bar count, bar width and the
  ADSR feel are not exposed.

---

# Part 2 — Engineering

## Playback / engine
- **Remove the legacy reSID fallback** — libsidplayfp is the default engine; remove `sid_audio.cpp` and the `?engine=resid` path a release after the switch, and update `public/tests/engine-test.html`.
- **SID register mirror writes** (`sid_audio.cpp` `$D420-$D7FF`) can be lost under MOS8580 + SAMPLE_FAST. Legacy reSID engine only — low priority given the removal above.
- **`playAddress == 0` tunes** analyse as almost-nothing but `sid_analyze` still returns success. [WASM]
- **`png_converter` output accessors** trust caller buffer sizes (no length params) — an under-allocated JS buffer is a WASM heap overflow. [WASM]

## Performance
- **`png_converter` conversion cost** — `getPixelColor` scans ~119 palettes × 16 per pixel and re-runs full-image passes up to ~65× on VICE screenshots. Cache a `colorIndex[320*200]` in `setImageData`. [WASM]
- **Synchronous analysis** — `sid_analyze` runs 30,000 frames in one call, so the busy overlay can't update. Chunk it or move it to a Web Worker.
- **Main-thread index cost — mostly closed.** The STIL commentary is a separate
  file now, fetched only when something reads it, which takes the index from
  11.9 MB to 7.7 MB. The tree build over 61,157 entries went from ~190 ms to
  ~25 ms by walking each path prefix once and remembering the last folder
  (they arrive clustered, ~31 files to a folder), so the remaining main-thread
  block is the ~50 ms `JSON.parse`. A Worker would not help that: parsing there
  and posting 61k objects back costs the main thread a structured-clone
  deserialise of the same order. Worth revisiting only with a packed binary
  index that transfers as an ArrayBuffer. PETSCII matching and image conversion
  still run on the main thread and are the better Worker candidates.

## Assembly / players
- **`SetupStableRaster` is PAL-only** (`SIDPlayers/INC/stablerastersetup.asm`) — writes the PAL `$DC06` latch unconditionally; NTSC exports jitter. Gate the latch on the clock-type byte. [asm — rebuild + NTSC test]
- **`WithLogo` players are near-clone forks** of their base players — fold behind a `HAS_LOGO` define.

## Memory / relocation — V2.01: full memory configurability
Goal: every visualizer uses the code-only model, and the exporter can place each
VIC asset at any *valid slot within a bank* — not just shift whole banks in
`$4000` steps — so memory packs as tightly as possible around the SID.

- **Retire the `CODE_ONLY` / `GFX_DONOR` two-build split** — today a player is
  compiled *twice*: once with `-define CODE_ONLY` (emits the code + CPU tables,
  graphics behind `#if !CODE_ONLY`) and once with `-define GFX_DONOR` (emits the
  VIC graphics, which live in those same `#if !CODE_ONLY` blocks, for
  `gen-gfx-manifest.js`). The two builds are *complementary halves*, so the
  `#if !CODE_ONLY` guards can't just be deleted — the graphics blob is generated
  from them. Redesign the source so code and graphics live in cleanly separate
  segments emitted from a single build, then drop the paired defines.
- **Convert the last 3 classic players to code-only** — `SimpleRaster`,
  `ScrapColumns`, `SimpleBitmapWithScroller`. Then retire the full-binary reloc
  path (`gen-reloc-table.js` + `*.reloc.json`) and the fixed-bank `.bin`s, leaving
  **one** placement system.
- **Relocate VIC assets independently *inside* a bank** (today they keep their
  authored intra-bank offset and only the bank moves). Move bitmap / screen /
  charset separately, updating `$d018` (screen+charset) and `$dd00` (bank):
  - **Bitmap** — 2 slots per bank (`bank+$0000` / `bank+$2000`). Valid absolute
    bases: `$2000, $4000, $6000, $A000, $C000, $E000`. **Not** `$8000` (VIC
    char-ROM shadow at `$9000-$9FFF` corrupts the top half) and **not** `$0000`
    (ZP/stack + char-ROM shadow at `$1000-$1FFF`).
  - **Screen** (video matrix) — any `$0400` slot in the bank (16/bank), avoiding
    the char-ROM shadow slots in banks 0 and 2.
  - **Charset** — any `$0800` slot in the bank (8/bank), same char-ROM caveat.
- **Removes the fixed-address limits** — e.g. `SimpleBitmapWithScroller` could
  then load at `$C000` (bitmap at `$C000`/`$E000`, RAM under I/O + KERNAL via
  `$01` banking), not just `$4000`/`$8000`.

## Refactor / cleanup
- **Media-converter consolidation** — reassess whether `png_converter` is still needed or whether CharSetLab (or its functions) can replace it; unify the font/PETSCII/image conversion paths on a faster shared core.
- **Export option snapshot — done.** `createPRG` takes an `optionValues`
  snapshot and reads it through `optionValue(id)`, falling back to the document
  for anything absent. Only one DOM read is left in `prg-builder.js`, and it
  cannot be a snapshot: it wants the `File` from a file input.

## Loop detection — give the user control of the scan
The analysis cap (`maxLoopSeconds`, default 600 s → a 1200 s render cap) is now
settable under Advanced settings on the Export tab, and changing it rescans. But
hitting the cap is still silent: the tune is stored as a fade-out with nothing
said, so the user has to know to go and raise it. Most tunes loop or fade inside
~6 min, so the cap should be lower *and* the rare long tune handled in the
moment.

- **Done: "use what it has found"** sits in the corner chip next to Cancel, and
  appears once 45 seconds have been scanned — below that the answer would be a
  fade-out at a few seconds, which is worse than none. It is a second, softer
  signal all the way down (`stopSignal`, distinct from the abort that throws the
  render away): the render breaks out, the rows so far are analysed, and the job
  resolves with a measurement.
- **Done: hitting the cap is no longer silent.** The status now distinguishes
  three endings — the scan ran out of window ("as far as the scan looks", naming
  the setting that raises it), the user stopped it, or nothing genuinely
  repeated. Still open: a prompt *in the moment* offering [Keep searching], which
  wants the render to extend from where it stopped rather than restart.
- **Drop the default cap 10 min → 6 min** once keep-searching exists, so the
  common case gets faster and the edge case stays reachable.
- Edge cases worth covering: a tune that never loops (long ambient), one whose loop
  is longer than the cap, a user who wants to stop early on purpose, and a
  background tab (the scan must not stall or silently abandon).
- Related: the render already stops early on a confirmed loop and on ~10 s of
  silence, so these prompts should only ever appear on genuinely long tunes.

## Bar methods — warn when a tune is invisible to the VU meter
The VU-meter methods claim a bar only for a voice with GATE=1, TEST=0 and a
waveform selected (`INC/spectrometer.asm` `AnalyseSingleVoice`). Some tunes drive
the SID audibly without ever meeting that test, so the bars sit empty while the
music plays — and nothing tells the user why.

Open case: `MUSICIANS/M/Mr_Mouse/Downhill_Rocks_Roll_the_Best.sid` runs its first
~13.6 s (frames 8-679) with voices 1/2 all zeros and voice 3 at `ctrl=$10`
(triangle, gate off), yet audibly plays music — rendered rms ~0.03 with a rhythmic
accent every ~4 s, stepping to ~0.07 at 13.5 s.

**The mechanism producing that audio is not yet understood, so the fix isn't settled.**
What is established:
- Our 6510 core is almost certainly right: the rendered level step at 13.5 s matches
  the first gated voice at frame 680 (13.57 s) exactly, and VICE shows the same
  register values.
- Ruled out: CIA/multispeed (no CIA writes, header 50 Hz), an init-installed IRQ,
  unmodelled SID/ROM readback (the tune reads **no** I/O and no ROM), truncated init
  (completes at every cycle budget), unimplemented opcodes, `$D418` digi (one
  constant write/frame), filter self-oscillation (res 0, no routing, cutoff 0).

Next measurement that would settle it: read **`$D41C` (ENV3)** in VICE during the
intro. Non-zero ⇒ voice 3 really is sounding with the gate closed, so the gate-driven
model is simply the wrong model and bars could be driven from the envelope instead.
Zero ⇒ the sound comes from somewhere else entirely and the search reopens.

Whatever the cause, the user-visible outcome (music playing, bars empty) is wrong.
Until a real fix is known, at least make the failure legible:
- During analysis, count frames with no audibly-active voice (the emulator glue in
  `spectrometer-shadow-detect.js` already does load/init/step).
- If a long leading stretch — or a large fraction — of the tune has none, flag it on
  the VU-meter cards in the method picker: "the bars will be empty for the first
  N seconds of this tune; Spectrometer reads the audio directly."
- Spectrometer is unaffected (it FFTs rendered audio), so it stays the recommendation.

## Search / product
- **Search relevance ranking** — results follow the Name/Year column sort. Add a "Relevance" sort mode (title/author-prefix weighting) so ranking doesn't fight the column sort. (Diacritic folding + true total count are done.)

## Build / infra
- **Release WASM flags** — consider `-flto`, `-sASSERTIONS=0`, `--closure 1`.
- **Artifact CI covers the players only** — `.github/workflows/ci.yml` rebuilds the
  players and diffs them against what is committed (`scripts/build-players.sh --check`).
  The `.wasm` files and the freq tables are still unverified; both need emsdk/python
  in the job.
- **Windows-only build** — `0-build.bat` has a hardcoded `EMSDK_PATH`; the sidplayfp WASM build is duplicated between it and `scripts/build-sidplayfp-wasm.sh`. The player half now also runs from `scripts/build-players.sh`, so the two will drift unless they are folded together.
- **Repo size** — the committed HVSC `.7z` (~88 MB) dominates the repository; consider Git LFS or a build-time fetch.
- **`.gitignore` residue** — still carries CMake / native-desktop-app entries from before the project became a web tool.
- **HVSC token hardening** — the token is a deliberate speed-bump, not access control; a Netlify rate-limit on `/hvsc-token` + `/HVSC/*` would raise the bar.
