# SIDquake Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (public/)                      │
│                                                           │
│  index.html ──► ui.js (orchestrator)                     │
│                  ├── sidquake-core.js ──► sidquake.wasm │
│                  ├── prg-builder.js                       │
│                  │    └── compressor-manager.js            │
│                  │         ├── compressor-worker.js (crunch) │
│                  │         ├── lib/ (TSCrunch, JS)          │
│                  │         └── exomizer.js ──► exomizer.wasm │
│                  ├── png-converter.js ──► sidquake.wasm  │
│                  ├── petscii-converter.js                 │
│                  ├── hvsc-browser.js ──► hvsc-index.json  │
│                  ├── visualizer-registry.js               │
│                  └── image-preview-manager.js             │
│                                                           │
├───────────────────────────────────────────────────────────┤
│  Self-hosted HVSC (public/HVSC/, static files)           │
│  ├── C64Music/... raw .sid files served directly         │
│  └── hvsc-index.json: tree + title/author/STIL for search │
└───────────────────────────────────────────────────────────┘
```

## Core Components

### WASM Layer (`wasm/`)

Two WASM modules are built from this directory: `sidquake.wasm` (analysis,
export, PNG conversion + the lightweight reSID playback engine) and
`sidplayfp.wasm` (the accurate libsidplayfp playback engine).

C++ files compiled together into `sidquake.wasm`:

**`cpu6510_core.h`** - the 6510 instruction set, templated over a memory bus
- Complete MOS 6510 instruction set (legal + illegal opcodes), decoded once
- The bus supplies the registers plus `fetch`/`read`/`write`/`jumpTarget`/`jam`,
  which is what lets the analysis and playback cores differ without duplicating
  the decoder. See `docs/CPU_CORES.md`.

**`cpu6510_wasm.cpp`** - analysis bus over that core
- Memory access tracking (execute/read/write/jump-target flags per address)
- SID register write capture (supports up to 32 SID chips)
- Zero-page write tracking
- CIA timer detection
- Key exports: `cpu_init`, `cpu_step`, `cpu_execute_function`, `cpu_get_*`

**`sid_processor.cpp`** - SID file format handler
- Parses PSID/RSID headers (v1-v4)
- Runs emulation analysis: loads SID, calls init, runs play for N frames
- Extracts: modified addresses, zero-page usage, SID writes, clock type, SID model
- Metadata editing and modified SID export
- Key exports: `sid_init`, `sid_load`, `sid_analyze`, `sid_get_*`, `sid_set_*`

**`png_converter.cpp`** - Image format converter
- Converts 320x200 PNG to C64 multicolor or hires bitmap
- 60+ pre-defined C64 color palettes (VICE, Pepto, Colodore, etc.)
- Color quantization with palette matching
- Outputs: bitmap data, screen RAM, color RAM
- Key exports: `png_converter_init`, `png_converter_convert`, `png_converter_get_*`

**`sid_audio.cpp`** - Legacy lightweight reSID playback engine
- Playback bus over `cpu6510_core.h`, routing reads and writes through the SID
  chips; calls init once and JSR-to-play once per frame, driving reSID
- No real C64 environment (RSID/digi/raster tunes need `sidplayfp.wasm`)
- No longer the default; kept one release as the `?engine=resid` fallback
- Key exports: `audio_init`, `audio_load_sid`, `audio_generate`, `audio_get_*`

**`opcodes.h`** - Shared opcode table (256 entries with mnemonic, addressing mode, size, cycles)

Compiled into `sidplayfp.wasm` (playback only, lazily loaded):

**`sidplayfp_audio.cpp`** - libsidplayfp playback engine (the default)
- Same `audio_*` export API as `sid_audio.cpp`, so `sid-playback.js` treats the two
  engines interchangeably (`?engine=fp|resid` or localStorage `sidquake-engine`;
  default `fp`)
- Full C64 environment from vendored `wasm/libsidplayfp/` (2.16.1): cycle-exact
  6510 + CIA + VIC-II, real KERNAL/BASIC/CHARGEN ROMs (embedded via `wasm/roms_data.h`,
  sources in `roms/`), reSIDfp SID emulation (nonlinear 6581 filter, 2SID/3SID)
- Correctly plays RSID tunes, main-loop/NMI digi players and raster-timed code
- Built by `scripts/build-sidplayfp-wasm.sh` or the second emcc step in `0-build.bat`

### JavaScript Application (`public/`)

**`sidquake-core.js`** (320 lines) - WASM bridge
- `SIDAnalyzer` class wrapping all WASM calls via `cwrap()`
- Manages WASM heap memory allocation for file transfers
- Provides clean JS API: `loadSID()`, `analyze()`, `updateMetadata()`, `createModifiedSID()`

**`ui.js`** - Main application controller
- `UIController` class orchestrating the entire UI
- SID file loading (drag-drop, file picker, HVSC, random)
- Header display and metadata editing
- Visualizer grid with selection; renders option controls into Studio tabs
- Quick path (`renderQuickExport`): a row of looks and one Generate button
  outside the Studio, running the same export. Picking a look built around a
  picture opens the gallery for it, rather than exporting the player's stock
  logo. A bar look lands on the live "VU meter · Clever" bar data (see
  `SIDPlayers/BAR_HEIGHT_METHODS.md`); the spectrometer is a Studio choice.
  A tune the live methods cannot see is warned about here as well as on the
  Method panel (`renderVuNotes`)
- Song length (`runTuneAnalysis` → Song tab): the scan measures the tune itself
  (`measureOnly`), so no length is capped by what the spectrometer can store.
  A scan that resolves neither a loop nor an ending gives the C64 a running
  clock with no total, and offers "Keep looking" — the same search with the
  window doubled for that tune
- The scan itself (`spectrometer-bake-core.js` `renderAndAnalyze`) runs a
  register pre-pass first (`loop-prepass.js`): the tune's player is stepped on
  the 6510 analyser for the whole window, about a second's work, and the frame
  its SID writes start repeating from and the exact period they repeat with
  come out. The audible loop can only be a divisor of that period, starting no
  later than that intro, so the audio render stops after intro + one period +
  a confirm window and `detectLoop` checks that one lag (its `hint`) instead of
  polling every lag for two passes. Silence shorter than the period is part of
  the tune while a hint stands, which is what lets a loop with a long quiet
  tail (Crystalline, JCH) be found rather than reported as an ending. A hint
  the audio does not confirm is dropped and the old search carries on from
  where the render is; a tune the analyser cannot drive gets no hint at all
- Files holding several tunes (`multiSongExport`): everything that can only
  describe one tune — the song length, the forced loop, the baked spectrometer
  — is off while the export still holds all of them, and the scan does not run
  at all. The Song tab's "Export just this tune" locks the export to the tune
  chosen there: the data block reports one song, which takes the C64's tune
  keys out (`INC/keyboard.asm` reads `NumSongs`), and the measurement,
  the bake and the length all describe that tune. `exportSubtuneIndex()` is
  the one place that says which tune that is
- PRG export workflow with progress feedback
- C64 color palette constants

**`studio-modal.js`** (+ `studio-modal.css`) - The Studio workspace
- `StudioModal`: near-fullscreen modal hosting the whole configure→export
  pipeline as tabs
- Tab rail is DERIVED from the selected visualizer's config
  (`deriveGroups()`): image inputs → own tabs, options grouped into
  Text / Style / Scroller; the set changes only on decisions (SID load,
  visualizer pick), never on data entry
- Panels stay mounted when inactive - prg-builder reads option values from
  the DOM by id
- Export tab renders a live include/skip manifest mirroring the builder's
  gates; footer carries a one-line summary + the Generate button
- Under 720px it goes fullscreen and drops the rail entirely: the footer's
  Previous/Next walk the same tab order and carry a step counter. It has to
  sit above the site header, no panel may set a width the viewport can't
  hold, and every panel must be reachable from the first one
  (`scripts/mobile-layout-check.js` guards all three)

**Player binaries** (`public/prg/*.bin`) - two kinds:
- Players with a CODE_ONLY reloc blob (`relocCodeBase`: Default,
  DefaultWithLogo, the four bar players, MusicalBlobs) ship their runtime
  code ONLY as the relocatable `*-code.bin` blob - any size, placed on any
  free page at export time. Their VIC assets come from a **graphics
  manifest** (`public/prg/<player>.gfx.json`, config field `gfxManifest`):
  at build time `scripts/gen-gfx-manifest.js` assembles a graphics-only
  `GFX_DONOR` image to a temp location and distils it into named segments -
  zero runs as bare reservations, real bytes as base64 - which the exporter
  composes back into a bank image (`loadGfxManifest`). No full-bank bins are
  committed for these players; byte-identical variants (FFT/Shadow vs live)
  share one manifest. Code size is therefore never capped by the bank
  layout; only graphics must fit a 16 KB VIC bank.
- ScrapColumns / SimpleRaster (full-binary diff reloc) and
  SimpleBitmapWithScroller keep runnable full-bank builds.

**`prg-builder.js`** - PRG file assembly
- `PRGBuilder`: Low-level binary PRG construction
- `SIDquakePRGExporter`: High-level export combining SID + visualizer
- Memory layout engine: calculates non-overlapping placement of music data, player code, and visualizer assets
- Multi-SID support, save/restore routines
- Compression integration via CompressorManager

**`compressor-manager.js`** - Compression abstraction
- `CompressorManager`: Unified interface for compression options
- Supports: none, TSCrunch, Exomizer (both self-extracting 6502 formats)
- TSCrunch is a JS port loaded from `lib/index.js`
- Exomizer is a WASM module (`exomizer.js` + `exomizer.wasm`) fetched on first
  use; a fresh module instance is created per compression because upstream keeps
  global state it never resets
- The pair is a ratio/speed trade: Exomizer is ~9-16% smaller on a typical
  export, TSCrunch roughly 4x faster to decrunch on the C64 (~33 vs ~129 cycles
  per byte)
- Exomizer is the default; TSCrunch is the pick when depack speed matters
- The crunch itself runs in `compressor-worker.js`, which imports this same file
  (`G` is `window` or `self`; dependencies load through `importScripts` in the
  worker). Either compressor is one synchronous call of ten seconds and more on
  a full-RAM export, which on the page froze the tab mid-build. The in-page path
  remains the fallback when a worker cannot start or a job dies in one.
  `scripts/compression-check.js` holds a heartbeat against the main thread and
  diffs the two paths' output

**`png-converter.js`** (244 lines) - WASM bridge for image conversion
- `PNGConverter` class wrapping PNG converter WASM functions
- Handles RGBA pixel data transfer to/from WASM heap

**`image-preview-manager.js`** - Image selection UI
- `ImageSelectorModal`: Modal dialog for choosing visualizer images
- Supports: drag-drop, file browse, gallery selection
- PETSCII and bitmap mode support
- Gallery loading from visualizer config JSON files
- Whatever the user picks is written back to the hidden `<input type="file">` -
  that input is what `prg-builder.js` reads at export time, so a preview that
  doesn't reach it exports the visualizer's default instead
- Logo inputs run every image through `logo-fit.js` first, and the note strip
  under the preview says what was done to it (or why it can't be converted)

**`logo-fit.js`** - Placing a logo on the C64 screen
- A player only displays the top `charsetRows` character rows, so a logo drawn
  lower down loses most of itself
- `sizeError()` is the gate on what a logo may be: 320x200, 384x272 (a VICE
  grab) or 320 wide by any multiple of 8. Anything else is refused when it's
  picked, with the preview and the input left on the previous choice - there is
  no offset that makes a 360x194 image a C64 screen, and cropping or resampling
  to hide that wrecks the pixel art
- `plan()` finds the surround colour (most common colour around the edges), the
  artwork's bounding box and where that artwork has to sit; an image whose
  artwork is already inside the band is left untouched, and opens in the Adjust
  tool exactly as it is (`place.auto` still carries the automatic placement, for
  the Auto-place button). For a VICE grab all three are measured over the inner
  screen, or the border reads as the background and the whole screen as artwork
- Artwork is centred horizontally but goes to the **top** of the band, not the
  middle: the player fills the screen below the band with bars, so slack above
  the logo makes the whole screen read as sitting low. All of it belongs below
- Offsets are always multiples of 8 so each source character cell still lands in
  one output cell; artwork too big for the band is scaled down (never up)
- `composite()` blends nothing: scaling is nearest-neighbour and a
  semi-transparent pixel keeps its own colour rather than being mixed with the
  background. The converter ignores alpha entirely, so a blended edge would hand
  it in-between shades that fit no C64 mode - a couple of pixels of one is
  enough to fail even multicolour bitmap (whose pixels are 2px wide)
- Pure enough to run in Node - see `scripts/test-logo-fit.js`

**`logo-fit-modal.js`** - The "Adjust logo" crop tool
- Shows the placement on a 320x200 canvas with the rows the visualizer never
  displays dimmed; drag / arrow keys / nudge buttons move by whole character
  cells, plus a size slider and the 16 C64 colours for the surround
- Applying re-renders the logo and pushes it back through the input

**`charsetlab-core.js`** - CharSet Lab analysis engine (pure JS, no WASM)
- Extracted from `charsetlab/charsetlab.js`; runs in the browser and in Node
- PNG (320x200 / 384x272 VICE grab) → palette match, ±7px alignment search,
  then PETSCII / Hires / Mixed / ECM character-mode analysis
- Every mode in the input's list is tried; `failureReason()` explains the last
  (most permissive) one, since quoting the first reads as though hires was the
  only mode considered
- `buildLogoBlob()` packs a fitted result (charset + screen + colour RAM +
  `$d021-$d024` registers) into a fixed-layout blob that visualizer configs
  slice into memory regions (`convertType: "charset"` inputs, e.g. the
  MusicalBlobs logo)

**`petscii-converter.js`** (332 lines) - PETSCII art generator
- `PETSCIIConverter`: Converts PNG images to C64 PETSCII character art
- Loads charset .bin files, matches 8x8 tiles to best PETSCII characters
- Output: 721 bytes (360 screen codes + 360 color bytes + charset flag)

**`petscii-sanitizer.js`** (266 lines) - Unicode to PETSCII text
- `PETSCIISanitizer`: Converts Unicode text (smart quotes, dashes, etc.) to PETSCII-safe ASCII
- Text padding and centering for SID metadata fields

**`visualizer-registry.js`** (68 lines) - Template catalog
- Static list of 9 visualizer types with name, description, preview image path
- Each references a config JSON in `public/prg/<VisualizerName>/`

**`visualizer-configs.js`** (149 lines) - Config loader
- `VisualizerConfig`: Fetches and caches JSON configs per visualizer
- Merges external gallery definitions
- Provides option schemas for the UI

**`sid-playback.js`** - Playback engine wrapper
- `SIDPlayback`: one shared AudioContext + AudioWorklet for the whole page,
  fed from whichever WASM engine `SIDPlayback.engineName()` selects
- Asks iOS for the `playback` audio session type, so the ring/silent switch
  doesn't mute a tune the way it mutes Web Audio by default
- `setModel(6581|8580)` forces a chip; anything else follows the tune's header
  (the fp engine does that per chip, so a 2SID/3SID tune keeps a mixed set).
  `getHeaderModel()` reports what the header asked for, parsed from the file

**`sid-player.js`** - Playback UI
- `SIDPlayer`: the transport pill (play/stop/subtunes/time/quality/chip/speed/
  volume), built into whatever container it is given; several may exist, and
  the one that plays owns the shared `SIDPlayback`
- Sampling quality, volume and chip model are page-wide preferences kept in
  localStorage (`sidquake-sampling`, `sidquake-volume`, `sidquake-sid-model`)
  and mirrored across every pill on the page. Chip model defaults to `auto`,
  i.e. each tune's own header decides; changing quality or chip reloads the
  tune in the engine, so playback restarts

### HVSC Integration (self-hosted)

HVSC is hosted directly by the site. The raw `.sid` files live under
`public/HVSC/C64Music/...` and are served as static assets; the whole
collection tree and per-tune metadata come from a single committed index,
`public/hvsc-index.json`. There is no serverless proxy and no dependency on an
external mirror — so browsing is instant (no per-folder network calls) and the
version is whatever we ship.

**`hvsc-browser.js`** - Collection browser
- `window.hvscBrowser`: Navigate HVSC directory structure
- Builds the directory tree in-memory from `hvsc-index.json`; no network per folder
- Plays/downloads SIDs directly from `/HVSC/<path>`
- Search matches title, author, path AND folded STIL comment text
- A row single-clicks to select and preview; double-click (double-tap) opens a
  folder or takes a tune, the same as the Select button, which stays inert
  until a tune is selected
- Under 720px the modal goes fullscreen, the SID info panel moves below the
  listing and hides until it has details to show

**`hvsc-embed.html` + `hvsc-embed-config.js`** - The same browser as a widget
- One iframe page, configured entirely by its query string; the host gets
  selections over `postMessage`. Every option is documented in
  [`EMBED.md`](EMBED.md) and on the site's Embed HVSC tab
- `hvsc-embed-config.js` runs before `hvsc-browser.js` and splits the options
  three ways: behaviour onto `window.HVSC_EMBED`, chrome into `hvsc-no-*`
  classes on `<html>` that the page's own CSS acts on, and the palette into
  custom properties overriding the `:root` block in `styles.css`
- Colours are validated (hex or a keyword the browser actually knows) before
  they are set, so nothing an embedder passes reaches the page as raw CSS
- `scripts/embed-options-check.js` drives every option in a real browser

**`hvsc-random.js`** - Random SID picker
- `window.hvscRandom`: Picks a random tune from the index
- Optional `hvsc-random.json` (path prefixes) biases the pick to curated areas

**Data & tooling (not served / built ahead of time):**
- `hvsc-data/*.7z` - committed HVSC archive (the raw files aren't committed)
- `scripts/extract-hvsc.js` - extracts the archive into `public/HVSC/`
  (run locally once, and by the Netlify build via `netlify.toml`)
- `tools/build-hvsc-index.js` - reads `public/HVSC/` + `DOCUMENTS/STIL.txt`
  and writes `public/hvsc-index.json` (seconds; run after each HVSC update)
- Returns HTML for directories, base64 for binary SID files
- CORS headers for browser access

### Data Files (`public/`)

**`bar-styles-data.js`** - 8 spectrometer bar character styles (bitmap data)
**`color-palettes-data.js`** - Spectrometer colour tables (luminance-ladder height/row gradients + waveform-family ramps) injected at PRG build time
**`font-data.js`** - PETSCII font bitmaps (uppercase + lowercase, 256 chars x 8 bytes)

### Compression Libraries

**Exomizer** - `wasm/exomizer/` (vendored upstream C, see its README) compiled to
`public/exomizer.wasm` by `scripts/build-exomizer-wasm.sh`. `wasm/exomizer_wrap.c`
drives exomizer's own `main()` over MEMFS, so the crunched image is exactly what
the command line tool emits.

**TSCrunch** - `public/lib/`, a JavaScript port of TSCrunch 1.3.1:
- `index.js` - Main `Cruncher` class
- `tokens.js` - Compression token types (ZERORUN, RLE, LZ, LIT)
- `graph.js` - Dijkstra optimal path for encoding decisions
- `sfx.js` - Self-extracting format with 6502 boot loader

### Pre-built Players (`public/prg/`)

9 visualizer directories, each containing:
- `.bin` files at 3 load addresses ($4000, $8000, $C000)
- `.json` config (options, galleries, font availability)
- `.png` preview image
- Gallery JSON files referencing assets in `public/PNG/`

Built from KickAss assembly in `SIDPlayers/` via `0-build.bat`.

### C64 Assembly Players (`SIDPlayers/`)

KickAss assembly source for each visualizer type:
- Main file (e.g., `RaistlinBars.asm`)
- Shared includes in `INC/` (lowercase filenames): common.asm, multicallirq.asm, spectrometer.asm, musicplayback.asm, keyboard.asm, stablerastersetup.asm, barstyles.asm
- Binary data: FreqTable.bin, SoundbarSine.bin, character sets
- Compiled by `0-build.bat` using KickAss.jar. `scripts/build-players.sh` runs
  the same player builds on Linux/macOS; `--check` builds to a temp directory and
  diffs against the committed artifacts instead of overwriting them.

Two routines are contracts between the C64 side and the exporter, where a layout
change is easy to get wrong and impossible to eyeball. Both are pinned by tests
that run the real assembled code in the 6510 emulator (`npm test`):
`scripts/test-baked-decoder.js` (baked FFT stream) and
`scripts/test-shadow-replay.js` (shadow-register replay order). See
`SIDPlayers/BAR_HEIGHT_METHODS.md`.

The 6510 instruction set lives once, in `wasm/cpu6510_core.h`, as a template
over a memory bus. `cpu6510_wasm.cpp` (offline analysis) and `sid_audio.cpp`
(reSID playback) are bus adapters over it - the first tracks per-address access,
the second routes reads and writes through the SID chips.
`scripts/cpu-crosscheck/run.sh` checks the decoder against `opcodes.h` and
hand-worked vectors, checks the two adapters against each other, and can link in
a third-party `cpu.c` as an outside opinion. It is not part of `npm test` (it
needs a C++ toolchain and takes minutes); run it after touching either.
See `scripts/cpu-crosscheck/README.md` and `docs/CPU_CORES.md`.

All players share the multi-call IRQ scheduler in `INC/multicallirq.asm`:
music call 0 is raster-driven once per frame at the player's
`MUSIC_SYNC_LINE`; calls 1..N-1 (N = NumCallsPerFrame, up to 8) are CIA1
Timer B driven at FRAME_CYCLES/N so multi-speed tunes play evenly spaced
regardless of the display. Display splits (logo/effect boundaries, border
tricks) are short "urgent" raster IRQs that may briefly interrupt a music
call, flip VIC registers and return - so every visualizer, with or without
a logo, supports multi-speed tunes. Each player defines `MusicFrameHandler`
(frame-call raster event), `MusicCall_Frame`/`MusicCall_Other` (play call
hooks) and `FrameCall` (once-per-frame display work), which keeps all
players structurally alike and is the first step toward mix-and-match
visualizer features.

## Data Flow

### Loading a SID file
```
User drops .sid file
  → ui.js reads ArrayBuffer
  → sidquake-core.js allocates WASM heap, copies data
  → sid_load() parses header
  → sid_analyze() runs N frames of 6510 emulation
  → Results returned: addresses, SID writes, memory map
  → ui.js displays header info, opens the Studio modal (studio-modal.js)
```

### Exporting a PRG
```
User selects visualizer + options
  → prg-builder.js calculates memory layout
  → Loads player .bin from public/prg/
  → Patches SID data + metadata into player template
  → Optional: image conversion (PNG → C64 bitmap via WASM)
  → Optional: logo conversion (already placed on the screen by logo-fit.js
    when the image was picked; charsetlab-core turns it into charset/bitmap)
  → Optional: PETSCII conversion for text logos
  → Optional: TSCrunch or Exomizer compression (self-extracting)
  → Downloads .prg file
```

### HVSC browsing
```
User clicks Browse HVSC
  → hvsc-browser.js loads hvsc-index.json once (cached, gzipped)
  → Builds the directory tree in-memory → folder navigation is instant
  → User clicks .sid file → fetched directly from /HVSC/<path> → loaded as SID
  → Search filters the index over title/author/path/STIL client-side
```

## C64 Memory Map Context

```
$0000-$00FF  Zero page (CPU registers, pointers)
$0100-$01FF  Stack
$0400-$07FF  Screen RAM (default)
$0800-$0FFF  BASIC start area
$1000-$3FFF  Common SID music location
$4000-$7FFF  Player load address (default)
$8000-$BFFF  Player load address (alternate)
$C000-$CFFF  Player load address (high)
$D000-$D3FF  VIC-II registers
$D400-$D7FF  SID registers (voice 1-3, filter, volume)
$D800-$DBFF  Color RAM
$DC00-$DCFF  CIA 1
$DD00-$DDFF  CIA 2
```

The PRG builder must place music data and player code in non-overlapping regions, avoiding I/O space ($D000-$DFFF) and other reserved areas.
