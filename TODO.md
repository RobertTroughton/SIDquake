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

1. The nine `for=` attributes, `logoFitModal` in the modal-precedence list, the
   `prefers-reduced-motion` guard on floating notes, one global `:focus-visible`
   rule, and the two colour-token fixes. An afternoon; moves the app from
   unusable to usable with a keyboard or a screen reader. *(Accessibility)*
2. Build the curated Random SID pool file. One build script, ~2 MB off the front
   door. *(Mobile and first impression)*
3. Background the loop/length analysis from load with a corner status chip, and
   turn the Song tab's row into "show the song length on screen?" *(Analysis
   timing)*
4. Move Generate PRG onto every tab; collapse Technical Details; move the frame
   rate, stored bars and analysis engine behind an Advanced disclosure; restore
   the scan window, min-loop and bank override into it. *(Progressive disclosure)*
5. Ship the eleven preview GIFs and set `animated: true`. *(Preview)*
6. Don't auto-open the Studio below 720px; un-hide the visualiser on phones;
   autoplay after Random SID. *(Mobile and first impression)*
7. The completion panel that tells a first-timer what a .prg is and how to run
   it. *(Language)*
8. Multi-file drop and a queue. *(Batch)*

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
- **Two Advanced settings are read but unreachable.** `getAdvancedSettings`
  (`ui.js:1402-1403`) reads `scanLenText` (the loop-scan window) and
  `minLoopSeconds` from localStorage; `_wireAdvancedSettings` (`ui.js:1493`)
  wires only `advFps`, `advStoredLen`, `advBakeEngine`. The "Loop detection"
  section below still says the fix for a capped scan is "open Advanced and raise
  the value" — there is no such control. Devtools is the only route.
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

- **Status chip, not an overlay.** Progress already flows back per job
  (`spectrometer-bake-runner.js:100-112`); it just needs somewhere quiet to land.
  Keep the existing full-screen overlay for one case only: Generate pressed while
  the job is still running, where blocking is honest.
- **Cancel on tune change, on dismiss, and on an engine-setting change.** Hold the
  `AbortController` on the controller so `processFile` can abort the previous
  tune's job; changing `bakeEngine` already invalidates the result (`ui.js:1518`)
  and should abort too.
- **Reframe the Song tab.** Replace "Song end not analysed yet…"
  (`index.html:298`) with a live row: `Song length — analysing… 1:20` →
  `Song length — 3:42 · [x] show on screen` → `Song length — not measured ·
  [Measure] [Type it in __:__]`. Merge the Song Looping toggle into it; both are
  the same underlying fact.
- **Let the user type it in.** A composer knows their tune is 3:41. Writing
  `bakedLenMin/Sec/hasLength` directly (`prg-builder.js:2274-2325`) skips the
  render entirely, and settles the case where the scan finds nothing.
- **Never a dead end.** Cancelling or skipping must always still produce a file,
  and the completion panel offers it back: "Add the song length? [Measure and
  rebuild]".
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

- **Nothing serialises jobs.** `self.onmessage` is `async` and starts each `run`
  immediately (`spectrometer-bake-worker.js:71`), while `createBakeCore` holds a
  single engine and a single `cache.rows` slot (`spectrometer-bake-core.js:276`).
  Two overlapping runs would clobber each other's cache. Keep one in-flight
  analysis per page: Generate must `await` the running job, not start a second.
  Today the FFT branch (`ui.js:2966`) calls `runTuneAnalysis` unconditionally.
- **A stale job must not write into the new tune's state.** `runTuneAnalysis`
  assigns `this.tuneAnalysis` directly; a background job that resolves after
  another SID has loaded would poison it. Use a request token, as
  `loadVisualizerOptions` already does with `_optionsRequest` (`ui.js:1150`).
- **A late result has to refresh the UI it feeds** — the Song-tab length row, the
  Song Looping status, and the studio footer/manifest — since nothing is waiting
  on it any more.
- **Don't background on the main-thread fallback path.** When Workers or dynamic
  `import()` inside one are unavailable, `spectrometer-bake-runner.js` runs the
  core on the page; backgrounding there would jank the UI it is meant to keep
  responsive. Fall back to running on demand.
- Rendering while the tune plays is two cores' worth of work; check it on a phone
  before making it the default there.

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

**Advanced-hidden.** Technical Details — currently `<details open>`
(`index.html:243`), so eleven rows of load/init/play addresses and zero-page
usage are the first thing on the first tab. Spectrometer frame rate ("Best (fits
memory)" is right nearly always, and an export silently drops to what fits
anyway). Max stored bars. Analysis SID engine plus its ninety-word note
(`ui.js:1462-1481`) — it is rendered unconditionally for every player today
(`ui.js:1194`), and it is a bug-hunting knob. Plus the two settings restored from
the dead-code list, and the bank override.

**Neither — needs a second path.** The beginner does not want a smaller expert
UI, they want a different one. Add a **Quick export** route from the landing
card: pick a look from a handful of big animated previews, press one button, get
a file. Everything else stays exactly where it is behind "Customise".

**Structural fixes that serve both populations:**

- **Put Generate PRG on every tab**, not only Export (`studio-modal.js:198-199`).
  Nothing forces a walk through the wizard once the settings are right.
- **Persist the session's visualiser and option memory across a reload.** The
  choice now survives loading another tune (`_lastVisualizerId`,
  `_lastDataSource`, `_optionMemory`), but not a refresh or a new tab. Consider
  putting it in localStorage next to `sidquakeAdvanced` — and note that the same
  state is most of a recipe file, so the two should be designed together.
- **Move the sub-tune selector to the Song tab.** It is injected above the
  visualiser grid (`ui.js:786`), while the manifest's "Music → edit ›" row points
  at the Song tab (`studio-modal.js:437`) where it isn't.
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
almost entirely vocabulary. Highest-value replacements, all in visible UI text:

- "Linker" (`index.html:7`), "Bundle & Ship" (`index.html:113`) — say what it
  does: turn a tune into a program people can run.
- "PRG" — never explained anywhere a first-timer will see it, yet it is the
  button label (`index.html:375`). One clause on first use.
- "HVSC" — a four-letter button on the landing page (`index.html:152`), defined
  only in About section 04. "Browse 61,000 classic C64 tunes".
- The method cards (`ui.js:1582-1601`): "frequency spectrum", "baked", "ADSR
  approximation", "restore modified memory trick", "save/restore code",
  "shadow-register method", "multispeed", "runtime CPU". One card also warns
  "Sound quality may be affected" with no sense of scale, which frightens a
  beginner into freezing.
- Export-tab dropdowns: "depack", "5 slices (finest)", "SID core", "no C64
  environment".
- **Greyed-out reasons blame the user's tune.** "Needs a slower tune (max 1
  call/frame)" (`ui.js:943`) and "No room in C64 memory alongside this tune"
  (`ui.js:941`) read as "your tune is broken". Rephrase around the *look*: "This
  look doesn't fit alongside your tune — here's what does", with the working
  alternatives right there. Also make them specific for the expert: "SID at
  $1000-$27FF blocks VIC bank 0".
- **Nothing tells anyone what to do with the downloaded file.** The success
  message is "Saved mytune.prg (12.40KB)" (`ui.js:3183`), and on a compression
  fallback it becomes "run it with SYS 16640" (`ui.js:3185`) — the most cryptic
  line in the app arriving at the moment of least confidence. Replace the toast
  with a completion panel: what the file is, how to run it (emulator link, three
  steps), how to run it on real hardware (collapsed), and where people share
  these (CSDb, the Releases tab).
- **Surface PETSCII substitution in the UI.** `prg-builder.js:1516` passes
  `reportUnknown: false` for metadata, so accented characters in a title or group
  name are silently replaced with spaces and discovered in VICE. Metadata is also
  truncated at 31 chars with no counter (`ui.js:604`).

## Accessibility

No `aria-live`, `role="status"` or `role="alert"` exists anywhere in
`public/*.js` or `public/*.html` — confirmed by grep. The modal plumbing (focus
save/restore, Escape, Tab traps in `error-modal.js` and `studio-modal.js`) is
well built; the failures are those good patterns not having been applied to the
other twenty places that needed them.

**Blockers.**

- **Every dynamically built Studio control is unlabelled.** The `<label
  class="option-label">` at `ui.js:1703, 1713, 1749, 1766, 1792, 1805, 1813,
  1899, 2031` is a sibling of the control with no `for=` and no wrapping. Only
  the three Advanced labels (`ui.js:1437, 1447, 1467`) got it right. A screen
  reader reads the whole configuration as "edit blank, combo box, slider 7".
  Adding `for="${config.id}"` to nine templates is the highest value-per-keystroke
  fix in this file.
- **Activating a Studio tab destroys the button that was pressed.** `activate()`
  calls `renderRail()`/`renderNav()`, both of which do `innerHTML = ''`
  (`studio-modal.js:315`, `:193`), so focus falls to `<body>` and the next Tab is
  slammed to `#studioClose` by `_trapTab` (`studio-modal.js:118`). Every step of
  the wizard costs a full re-tab. Worse, `queueRefresh` fires on any
  `input`/`change`/`click` in the panels (`studio-modal.js:64`), so typing one
  character into the scroller rebuilds the whole rail and calls `scrollIntoView`.
  Diff the tab list instead of rebuilding, and restore focus across any rebuild.
- **`logoFitModal` is missing from the modal-precedence list** at
  `studio-modal.js:53`. So while the logo crop tool is open, Escape closes the
  Studio underneath it, and every Tab is yanked to `#studioClose` behind the
  dialog — a real keyboard trap, with Cancel and Use-this unreachable. Adding one
  string fixes it; a proper modal stack fixes the class.
- **Nothing is announced, including the multi-minute wait.** `showBusy`
  (`ui.js:3757`) sets `textContent` and adds a class; it does not move focus, and
  `studio-modal.js:54` deliberately stops trapping Tab while the overlay is up,
  so focus roams the page behind an opaque blur. The two longest operations —
  Random SID (`ui.js:300`) and file load (`ui.js:668`) — pass no `onCancel`, so
  the Cancel button is hidden entirely. `showExportStatus` writes into a div and
  auto-clears after 5 s (`ui.js:3711`), so errors appear and vanish silently.
- **Galleries are mouse-only.** `gallery-item-card` (`image-preview-manager.js:284`,
  `:794`), the font grid (`ui.js:2098`) and the bar-style grid (`ui.js:2196`) are
  `<div>`s with click handlers, no `tabIndex`, no `role`, no key handler, and the
  value lives in a hidden input. The visualiser cards at `ui.js:963-973` already
  show the correct pattern. Better still: `role="radiogroup"` with roving
  tabindex, so a 30-font grid is one tab stop rather than thirty.
- **The HVSC list puts every row in the tab order** (`hvsc-browser.js:743`) with
  no arrow keys and no virtualisation, and `#itemCount` changes silently. Make it
  a `role="listbox"` with roving tabindex and type-ahead.

**Contrast** (computed from the tokens in `styles.css:7-68`; AA needs 4.5:1):

- `--text-muted` `#7b7d85` is **4.21:1** on `--bg-surface` and **3.84:1** on
  `--bg-elevated`. It is the colour of every hint and explanation in the app —
  `.export-hint`, `.option-hint`, `.flow-note`, `.busy-submessage`, `.busy-hint`,
  `.status-bar` — i.e. the sentences that tell you what a control does. Lift to
  `#95979f` (5.40:1 on `--bg-elevated`) or just use `--text-secondary` `#8e909a`
  (4.96:1), which already passes everywhere.
- `.file-button { color: white }` on `--accent` is **2.31:1**
  (`styles-deferred.css:203`) — that is Browse Files, Adjust logo, the nudge
  arrows, Cancel, Use this, and Load/Save text. `.export-button` uses
  `var(--bg-primary)` on the same amber for **8.44:1**. One-word fix, same for
  `.visualizer-selected-badge` and `.gallery-item-selected-badge`.
- `--border` `#252530` is 1.22:1 against `--bg-secondary` and is the only visible
  boundary of every text field. `--accent-dim` used as a focus ring composites to
  ~1.23:1 — not an indicator.
- `outline: none` with no `:focus-visible` replacement on `.color-slider`
  (`styles-deferred.css:846`), `.sid-player-speed-btn` (`:2838`),
  `.sid-player-quality-select` (`:2804`), `.search-bar` (`:1470`). One global
  `:focus-visible` rule with a 3px `--accent-light` outline replaces all of them.
- Leave the C64 palette swatches alone — reproducing the machine's colours is the
  point, and 1.4.11 exempts them. Give the chips a visible boundary and put a
  lighter divider between `.color-slider-track` segments instead.

**Motion.** `floating-notes.js:95` adds a 6rem rotating glyph every 167 ms
indefinitely, ~42 live at once, with no `prefers-reduced-motion` guard and no off
switch — `studio-modal.css` is the only file in `public/` that mentions the media
query. Add the guard, skip the interval entirely under reduced motion, and put
`aria-hidden="true"` on the container. The scanline overlays are static
gradients at 1.5% alpha and are fine as they are.

**Structure.** No `<main>` landmark, no skip link, and zero headings on the Tool
tab between the `<h1>` logo and the footer. Inside the Studio the order runs
backwards: `<h3 class="studio-panel-title">` at `index.html:200` followed by
`<h2>` at `:206`, `:244`, `:296`.

**Zoom.** The Studio rail is `display: none` below 720px
(`studio-modal.css:404`), which on a 1440px monitor fires at exactly 200% browser
zoom — so the per-tab status ticks, the only progress overview in the app,
disappear with nothing substituting. `.studio-foot` is a no-wrap flex row
(`studio-modal.css:344`) holding a growing summary, the status text, Prev/Next
and Generate.

## Mobile and first impression

The site is engineered carefully — 25 KB of render-blocking CSS, deferred
stylesheets, pre-hidden modal DOM, all three `.wasm` modules lazily loaded, a
`dvh`/safe-area-aware modal layout, and a Playwright geometry harness. The
problem is aim: every optimisation assumes a visitor who already wants to export
a PRG.

- **Random SID downloads 2 MB to pick one of 6,775 strings.** `hvsc-random.js:68`
  fetches the whole `hvsc-index.json` (11.98 MB raw, ~2.04 MB gzipped, 61,157
  entries) and then filters it through the 30 curated prefixes in
  `hvsc-random.json`. Pre-build that filtered path list — roughly 300 KB raw,
  ~51 KB gzipped — and the front door gets ~40× cheaper. Biggest single win on
  the site, and it is a build-script addition.
- **`?tune=` deep links prefetch the same 2 MB** (`index.html:1102`) and
  `hvsc-browser.js` awaits the full index before touching the tune. The edge
  function `netlify/edge-functions/tune-og.js` already resolves a tune from a
  `share-meta/<shard>.json` of ~1.5 KB gzipped. Shared links are how this
  audience arrives.
- **Split STIL out of the index.** It is ~34% of the 11.98 MB and is read one
  entry at a time for the selected tune (`hvsc-browser.js:627`). Shard it the way
  `build-share-meta.js` already shards.
- **The Studio auto-opens on every load** (`studio-modal.js:134`), and on a phone
  `.studio-player-mount` is `display: none` (`studio-modal.css:440`) — so the
  modal that opens uninvited is the one with no play button, over a page with no
  Android Back handling (no `popstate` anywhere; `Escape` is the only close key).
  Don't auto-open below 720px; the "Open Studio" button already exists.
- **The visualiser is hidden on phones** (`styles-deferred.css:2962`).
  `hvsc-visualizer.js` is 64 log-spaced bars with peak caps, a bass flash and an
  idle demo wave — the most listener-friendly thing in the repo, switched off on
  the one device with nothing else to look at.
- **Nothing plays without work.** Random SID ends in two stacked modals with the
  player below the fold; three taps and a scroll to hear anything. Autoplay once
  a tune is chosen.
- **The upload buttons are live-looking but dead for the first second or two** —
  they ship in static HTML (`index.html:146-158`) and handlers attach in `ui.js`,
  fourth in a deliberately yielded load chain (`index.html:1133-1150`). A first
  tap that does nothing is a bounce.
- **The page-tab row may clip at 390px.** `.page-tab` is `flex: 1` with 48px
  padding and uppercase Space Mono (`styles.css:946`), inside a container with
  `overflow: hidden` (`styles.css:128`), and there is no `.page-tab` rule in
  either mobile breakpoint. **Confirm in a browser**, then add a landing-page
  overflow assertion to `scripts/mobile-layout-check.js` — the harness is good and
  only ever looks at `#hvscModal` and `.studio-modal-content`.
- **`public/songlengths-report.html` is 1.4 MB** of internal QA output, deployed,
  publicly reachable and not disallowed in `robots.txt`.
- **Font Awesome brands costs ~117 KB for two icons** (`fa-github`, `fa-youtube`).
  Self-host a subset of the solid set and drop the brands file and one
  third-party origin from the critical path.

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
- Rename the verbs: "Select" / "Cancel" are file-picker words in what is
  functionally a music player.
- Make the Releases tab playable and link `/music/` from the header.
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

- **Accept multiple files on drop.** `ui.js:493` takes `files[0]` and silently
  discards the rest; the file input has no `multiple` (`index.html:166`).
- **A queue in the UI**: list the dropped SIDs, configure against the first,
  "apply to all and export", results to a chosen directory. This needs no
  refactor and removes most of the pain.
- **Recipe files** (`.sqrecipe.json`): player + data source, every option value,
  logo reference and its placement, compression, sub-tune, forced-loop answer and
  the analysis settings — plus a `built` block (load address, uncompressed span,
  file size, block count, loop frames, PRG hash) written back for diffing. Import
  by drop, export alongside every PRG. Half of it already exists as
  `_captureOptionValues` (`ui.js:1216`), and "Export option snapshot" below is
  the same change: snapshot once at Generate, build from the snapshot, write the
  snapshot out as the recipe. The pipeline is already deterministic — no
  timestamp reaches the PRG — so same inputs give same bytes.
- **A `sidquake-build` CLI.** The precedent is already in the repo:
  `tools/songlengths/scan-worker.mjs:37` loads `public/sidquake.js` /
  `public/sidplayfp.js` in Node by passing `wasmBinary` directly and imports
  `spectrometer-bake-core.js` unmodified, with a resumable JSONL journal and
  `--jobs`. The DOM coupling in `prg-builder.js` is six call sites (`:849`,
  `:872`, `:945`, `:1129`, `:1174`, `:1557`) — replace them with an injected
  option provider (which is the snapshot above) and the module is DOM-free.
  `fetch` shims to `fs`; the only genuine browser dependency left is
  `convertLogoPNG`'s `new Image()` + canvas (`:1060`).
- **Filename templates**, plus a real fallback: `ui.js:3134` strips everything
  outside `[a-z0-9\-!]` and the `'output'` fallback only fires when
  `currentFileName` is falsy, so a title with no Latin characters yields a file
  named `.prg`.
- **Layout hints** — preferred VIC bank, preferred code region, reserved ranges —
  soft, falling back to automatic with a visible note. A disk with a shared
  loader wants every PRG in the same bank.
- **Report block counts and the uncompressed span.** `build()` allocates
  `highestAddress - lowestAddress + 1` and zero-fills (`prg-builder.js:76`), so a
  SID at `$1000` with graphics at `$C000` is a ~60 KB file that is mostly zeros.
  The memory map draws those holes as "unused", which reads as free RAM rather
  than bytes paid for.
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

- **Border and background are one control.** `bgColor` writes both
  `layout.borderColor` and the spectrometer background (`prg-builder.js:1381`), so
  a black border with a dark-grey screen is impossible on the bars players. The
  logo's own background is fixed by the converter with no override.
- **The UI palette is not the C64 palette.** `C64_COLORS` (`ui.js:4-21`) is a
  muted set; `petscii-converter.js:25-42` has the real VICE PAL values. Users
  choose in one palette and ship in another. (Also listed under "Palette drift"
  below — same root cause, and it matters more than it looks for a tool whose job
  is C64 aesthetics.)
- **No scroller on the bars-with-logo players.** Bars + logo + greetings is the
  standard release layout and it is not buildable; `scrollText` exists only in
  `scrapcolumns.json` and `simplebitmapwithscroller.json`.
- **Wrong-sized logos are rejected instead of fitted.** `logo-fit.js:44` accepts
  only 320×200, 384×272, or 320-wide multiples of 8, and
  `image-preview-manager.js:546` throws before any state is stored — so the
  Adjust tool, which has a Size slider and would solve it in seconds, is
  unreachable for exactly the images that need it.
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
- **Palette drift** — the C64 RGB values differ between `ui.js` and `petscii-converter.js`; consolidate to one shared palette.
- **Export option snapshot** — the exporter reads option state from the live DOM rather than a captured snapshot (`_captureOptionValues` exists but isn't used for export). No observed desync today (the modal is static during export).

## Loop detection — give the user control of the scan
The analysis cap (`maxLoopSeconds`, default 600 s → a 1200 s render cap) has no UI
at all — `getAdvancedSettings` reads `scanLenText` from localStorage and nothing
writes it (see "Two Advanced settings are read but unreachable" above). Hitting
the cap is silent and unrecoverable in-flow: the tune gets stored as a fade-out
and the only way to search further is to edit localStorage by hand. Most tunes
loop or fade inside ~6 min, so the cap should be lower *and* the rare long tune
should be handled in the moment.

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
