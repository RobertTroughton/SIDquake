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

**`cpu6510_wasm.cpp`** - 6510 CPU emulator
- Complete MOS 6510 instruction set (legal + illegal opcodes)
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
- Minimal 6510 CPU that calls init once and JSR-to-play once per frame, driving reSID
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

**`png-converter.js`** (244 lines) - WASM bridge for image conversion
- `PNGConverter` class wrapping PNG converter WASM functions
- Handles RGBA pixel data transfer to/from WASM heap

**`image-preview-manager.js`** (615 lines) - Image selection UI
- `ImageSelectorModal`: Modal dialog for choosing visualizer images
- Supports: drag-drop, file browse, gallery selection
- PETSCII and bitmap mode support
- Gallery loading from visualizer config JSON files

**`charsetlab-core.js`** - CharSet Lab analysis engine (pure JS, no WASM)
- Extracted from `charsetlab/charsetlab.js`; runs in the browser and in Node
- PNG (320x200 / 384x272 VICE grab) → palette match, ±7px alignment search,
  then PETSCII / Hires / Mixed / ECM character-mode analysis
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
- Compiled by `0-build.bat` using KickAss.jar

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
