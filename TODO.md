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
- **The memory-bank override is dead code.** `createLayoutSelectorHTML`
  (`ui.js:1623-1692`) builds a complete layout radio group with per-bank ranges
  and overlap reasons. Nothing calls it; `selectedLayoutKey` is hardcoded `null`
  (`ui.js:3044`). Automatic placement is the right default and the scoring behind
  it is good (`prg-builder.js:2026`) — but the override is written and
  unreachable.

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

- **Still open: the worker does not serialise jobs.** `self.onmessage` is `async`
  and starts each `run` immediately (`spectrometer-bake-worker.js:71`), while
  `createBakeCore` holds a single engine and a single `cache.rows` slot. `ui.js`
  now keeps one in-flight analysis per page (`_ensureAnalysis`), so nothing
  overlaps today, but the worker would still happily run two if asked. Queue them
  worker-side rather than relying on the caller.
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

- Make `cache.rows` a 3-5 entry LRU.
- Persist the *summary* (`looped`, `fadedOut`, `loopStart`, `frameHz`,
  `lengthFrames`, `storedSeconds` — a couple of hundred bytes) to IndexedDB keyed
  by `tuneKey`. For every non-spectrometer export that summary is the entire
  payload, so the second time a tune is ever touched the answer is already there.
- Exclude the header bytes from the key, or key on the music payload only.
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

**Neither — needs a second path.** The beginner does not want a smaller expert
UI, they want a different one. Add a **Quick export** route from the landing
card: pick a look from a handful of big animated previews, press one button, get
a file. Everything else stays exactly where it is behind "Customise".

**Structural fixes that serve both populations:**

- **Persist the session's visualiser and option memory across a reload.** The
  choice now survives loading another tune (`_lastVisualizerId`,
  `_lastDataSource`, `_optionMemory`), but not a refresh or a new tab. Consider
  putting it in localStorage next to `sidquakeAdvanced` — and note that the same
  state is most of a recipe file, so the two should be designed together.
- **Collapse eight tabs to six** — fold Method inline under the visualiser card
  that owns it, and merge Bar Style + Colour Effect + palette + colours into one
  "Look" tab. Eight tabs for what is one aesthetic decision reads as eight
  required steps.
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

- **Still open: the rail and nav are rebuilt wholesale on every refresh.** Focus
  is now carried across the rebuild (`_preservingFocus`) and the rail only
  scrolls when the tab actually changed, so the keyboard cost is gone — but
  `queueRefresh` still throws away and recreates every button on each keystroke.
  Diff the tab list and update in place.
- **Replace the hardcoded modal-precedence list with a real stack.**
  `studio-modal.js:53` now names every overlay including `logoFitModal`, so the
  keyboard trap is gone, but the next overlay added will reintroduce it. Push/pop
  an id on open/close and have each handler act only when it is on top. The logo
  tool also still needs its own Tab trap and focus restore (copy `ui.js:274-296`),
  and its document-level arrow handler swallows the Size slider's arrow keys —
  scope it to the canvas.
- **Still open: the file load has no Cancel.** `processFile`'s overlay passes no
  `onCancel`, so the 30,000-frame analysis can't be stopped. Random SID is
  cancellable now, and the overlay itself is a labelled dialog that announces on
  a throttle, focuses Cancel and makes the page behind `inert`.
- **Still open: the HVSC listing is not virtualised.** It is a proper listbox
  now — roving tabindex, arrows, Home/End, PageUp/Down, type-ahead, announced
  counts — but a search still renders up to 500 rows with `innerHTML=''` plus a
  per-row `appendChild` on every keystroke.

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

**Motion.** The global `prefers-reduced-motion` block and the floating-notes
guard are in. Still wanted: a persisted user toggle for the drifting notes, since
"I find this distracting" is not the same preference as the OS setting, and a
static substitute for `.busy-spinner` when a scan runs for minutes.

**Structure.** Done: the Tool tab is a `<main>` with a heading and a skip link,
the Studio's heading order runs h2 → h3, and the rail is a real `tablist` whose
tabs carry `aria-selected` / `aria-controls`, answer to the arrow keys and cost
one tab stop. Still open: two `<h1>`s in the document at once (the wide and tall
logos are both in the DOM, hidden by media queries rather than `<picture>`).

**Zoom.** Done: the footer wraps rather than crushing the status text out of
sight, drops the summary below 900px, and carries the current tab's status where
the rail is hidden — which on a 1440px monitor is exactly 200% zoom. Still open:
`.studio-manifest` has no `overflow-x` wrapper, so a long value plus its edit
button can push the table wider than the panel at 320px; and 49 `font-size: *px`
declarations (down to 9px) ignore a raised browser default font, though zoom
scales them.

## Mobile and first impression

The site is engineered carefully — 25 KB of render-blocking CSS, deferred
stylesheets, pre-hidden modal DOM, all three `.wasm` modules lazily loaded, a
`dvh`/safe-area-aware modal layout, and a Playwright geometry harness. The
problem is aim: every optimisation assumes a visitor who already wants to export
a PRG.

- **Deep links play from their share-meta shard now** (median 1.5 KB gzipped,
  against 2,041 KB for the index), so nobody waits on the index to hear
  anything. Still open: the *listing* behind the player waits for the full
  index, and the shard distribution is lopsided — a low byte of FNV-1a gives 219
  shards for 61,157 tunes, so the median is 1.5 KB but the worst is 31 KB.
  Twelve bits would even that out, but `build-share-meta.js` and
  `netlify/edge-functions/tune-og.js` have to agree, so it is a paired change.
- **Done: STIL is split out of the index** — 4.0 MB of 12.5 MB serialised, on
  29,509 of 61,157 entries. The browser fetches `hvsc-index-lite.json` (1,121 KB
  gzipped, against 2,042 KB) and pulls `hvsc-stil.json` only when something needs
  it. It is part of the search haystack, so a search kicks the fetch off and
  re-runs once it lands: first results are immediate, commentary matches fold in
  a moment later.
- **The upload buttons are live-looking but dead for the first second or two** —
  they ship in static HTML (`index.html:146-158`) and handlers attach in `ui.js`,
  fourth in a deliberately yielded load chain (`index.html:1133-1150`). A first
  tap that does nothing is a bounce.
- **`public/songlengths-report.html` is 1.4 MB** of internal QA output, deployed
  and publicly reachable. It is disallowed in `robots.txt` now, but it is still
  8% of `public/` for a dev artifact — it belongs outside the deployed directory,
  which is the owner's call since it is deliberately committed.
- **Still open: self-host a subset of the solid icon font.** The brands file is
  no longer requested (the two marks that used it are inline SVG), but the solid
  set is still ~157 KB from cdnjs for 58 glyphs, and cdnjs is a third-party
  origin on the critical path.

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
- **Still open: choose an output directory.** Every file lands in the browser's
  downloads folder. `showDirectoryPicker()` would fix it where supported, but it
  is Chromium-only, so it needs a fallback (a zip) rather than a hard dependency.
- **Still open: the queue re-measures every tune.** Each export blocks on that
  tune's own scan. The persisted analysis cache below is what makes a re-run of
  the same set fast.
- **Recipes exist** (`.sqrecipe.json`, saved and loaded from the Export tab):
  player + data source, every option value, gallery image picks, sub-tune,
  forced-loop answer, song-length choices, compression and the analysis
  settings. Still open:
  - **A `built` block** — load address, uncompressed span, file size, block
    count, loop frames, PRG hash — written back after an export so two builds
    can be diffed. The pipeline is already deterministic (no timestamp reaches
    the PRG), so same inputs give same bytes.
  - **Write one alongside every PRG**, rather than only on request.
  - **Drop a recipe onto the page** to apply it, and apply one across a whole
    queue rather than per tune.
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
- **Layout hints** — preferred VIC bank, preferred code region, reserved ranges —
  soft, falling back to automatic with a visible note. A disk with a shared
  loader wants every PRG in the same bank.
- **Done: blocks, span and wasted space** are reported on the completion panel —
  disk blocks because that is the unit a release is budgeted in, where the
  program runs, and a warning when an uncompressed file is mostly the empty
  space between its parts. The memory map still draws those holes as "unused",
  which reads as free RAM rather than bytes paid for.
- **Show the layout before the export, not after.** `renderMemoryMap` is only
  called on success (`ui.js:3193`) and `clearMemoryMap` wipes it on any
  visualiser change (`ui.js:1093`). `selectValidLayouts` already runs on every
  card render, and `placeRelocatedVisualizer` needs only the SID bytes and the
  config — so bank, code page, PRG load address, span and an estimated compressed
  size can all be shown live.

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
- **Main-thread index cost** — the 11.9 MB index parse + 61k-tree build (and PETSCII matching, image conversion) run on the main thread; move to a Worker / lazy STIL shard.

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

- **"Stop searching" button** during the scan — take what's been rendered so far and
  bake it (currently only a full Cancel exists, which throws the analysis away).
- **Prompt at the cap** instead of silently giving up: "No loop found in 6:00 —
  [Keep searching] [Use what we have]". Keep-searching should extend from where it
  is, not restart the render.
- **Drop the default cap 10 min → 6 min** once the above exists, so the common case
  gets faster and the edge case stays reachable.
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
