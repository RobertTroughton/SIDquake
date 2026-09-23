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

Three code bodies:

- `public/` - the app: plain browser JS, no bundler. Classic scripts loaded by
  the loader at the bottom of `index.html`, plus dynamic `import()` for the ES
  modules.
- `wasm/` - C++ compiled to the committed `.wasm` files. `sidquake.wasm` holds
  analysis, PNG conversion and the lightweight reSID engine; `sidplayfp.wasm`
  the accurate libsidplayfp playback engine; `exomizer.wasm` the cruncher.
- `SIDPlayers/` - KickAssembler 6502 source for the visualiser players, built
  into `public/prg/`.

## Areas

Each area has its own document. Read the one for the code you are touching.

| area | main code | doc |
|---|---|---|
| 6510 emulation | `wasm/cpu6510_core.h`, `cpu6510_wasm.cpp`, `opcodes.h`, `sid_audio.cpp` (bus) | [`CPU_CORES.md`](CPU_CORES.md) |
| Tune analysis, song length | `wasm/sid_processor.cpp`, `public/sidquake-core.js`, `loop-prepass.js`, `analysis-store.js` | [`ANALYSIS.md`](ANALYSIS.md) |
| Bar data (spectrometer) | `public/spectrometer-*.js`, `SIDPlayers/INC/spectrometer*.asm` | [`../SIDPlayers/BAR_HEIGHT_METHODS.md`](../SIDPlayers/BAR_HEIGHT_METHODS.md) |
| Playback | `wasm/sidplayfp_audio.cpp`, `wasm/sid_audio.cpp`, `public/sid-playback.js`, `sid-player.js`, `sid-worklet-processor.js` | [`PLAYBACK.md`](PLAYBACK.md) |
| PRG export, images, compression | `public/prg-builder.js`, `compressor-*.js`, `png-converter.js`, `logo-fit*.js`, `charsetlab-core.js`, `petscii-*.js` | [`EXPORT.md`](EXPORT.md) |
| C64 players | `SIDPlayers/`, `public/prg/` | [`PLAYERS.md`](PLAYERS.md), [`../SIDPlayers/CODE_ONLY_GUIDE.md`](../SIDPlayers/CODE_ONLY_GUIDE.md) |
| App UI | `public/ui.js`, `studio-modal.js`, `visualizer-*.js`, CSS | [`UI.md`](UI.md), [`RESPONSIVE.md`](RESPONSIVE.md) |
| HVSC hosting, embed | `public/hvsc-*.js`, `netlify/`, `tools/`, `scripts/build-*` | [`HVSC.md`](HVSC.md), [`EMBED.md`](EMBED.md) |
| Build, generated files | `scripts/build-*`, `0-build.bat` | [`BUILD.md`](BUILD.md) |
| Tests | `scripts/test-*.js`, `scripts/*-check.js` | [`TESTING.md`](TESTING.md) |

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

Exporting and HVSC browsing are traced in [`EXPORT.md`](EXPORT.md) and
[`HVSC.md`](HVSC.md).

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
