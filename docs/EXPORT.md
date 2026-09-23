# PRG export

Everything between "Generate" and the downloaded `.prg`: memory layout, player
relocation, image and logo conversion, compression. The C64 side of the
contract is in [`PLAYERS.md`](PLAYERS.md).

## Flow

```
User selects visualizer + options
  → prg-builder.js calculates memory layout
  → Loads the player (relocatable code blob + graphics manifest, or a fixed-bank .bin)
  → Patches SID data + metadata into player template
  → Optional: image conversion (PNG → C64 bitmap via WASM)
  → Optional: logo conversion (already placed on the screen by logo-fit.js
    when the image was picked; charsetlab-core turns it into charset/bitmap)
  → Optional: PETSCII conversion for text logos
  → Optional: TSCrunch or Exomizer compression (self-extracting)
  → Downloads .prg file
```

## Layout and players

**`prg-builder.js`** - PRG file assembly
- `PRGBuilder`: Low-level binary PRG construction
- `SIDquakePRGExporter`: High-level export combining SID + visualizer
- Memory layout engine: calculates non-overlapping placement of music data, player code, and visualizer assets
- Multi-SID support, save/restore routines
- Compression integration via CompressorManager

The data block the exporter writes (`generateDataBlock()`) is a contract with
`SIDPlayers/INC/common.asm`: change one, change both.

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

A player blob and its reloc table **must be regenerated together**. A stale
blob against a fresh table is patched at the wrong offsets and silently
corrupts every export; the table carries an Adler-32 of the blob to catch it.

## Compression

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

**Exomizer** - `wasm/exomizer/` (vendored upstream C, see its README) compiled to
`public/exomizer.wasm` by `scripts/build-exomizer-wasm.sh`. `wasm/exomizer_wrap.c`
drives exomizer's own `main()` over MEMFS, so the crunched image is exactly what
the command line tool emits.

**TSCrunch** - `public/lib/`, a JavaScript port of TSCrunch 1.3.1:
- `index.js` - Main `Cruncher` class
- `tokens.js` - Compression token types (ZERORUN, RLE, LZ, LIT)
- `graph.js` - Dijkstra optimal path for encoding decisions
- `sfx.js` - Self-extracting format with 6502 boot loader

## Images and logos

**`png_converter.cpp`** - Image format converter
- Converts 320x200 PNG to C64 multicolor or hires bitmap
- 60+ pre-defined C64 color palettes (VICE, Pepto, Colodore, etc.)
- Color quantization with palette matching
- Outputs: bitmap data, screen RAM, color RAM
- Key exports: `png_converter_init`, `png_converter_convert`, `png_converter_get_*`

**`png-converter.js`** - WASM bridge for image conversion
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

**`petscii-converter.js`** - PETSCII art generator
- `PETSCIIConverter`: Converts PNG images to C64 PETSCII character art
- Loads charset .bin files, matches 8x8 tiles to best PETSCII characters
- Output: 721 bytes (360 screen codes + 360 color bytes + charset flag)

**`petscii-sanitizer.js`** - Unicode to PETSCII text
- `PETSCIISanitizer`: Converts Unicode text (smart quotes, dashes, etc.) to PETSCII-safe ASCII
- Text padding and centering for SID metadata fields

## Data files (`public/`)

**`bar-styles-data.js`** - 8 spectrometer bar character styles (bitmap data)
**`color-palettes-data.js`** - Spectrometer colour tables (luminance-ladder height/row gradients + waveform-family ramps) injected at PRG build time
**`font-data.js`** - PETSCII font bitmaps (uppercase + lowercase, 256 chars x 8 bytes)
