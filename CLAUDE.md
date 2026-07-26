# CLAUDE.md - SIDquake Project Guide

## What is SIDquake?

A web-based C64 SID music tool. Users load SID files, analyze them, browse HVSC, and export executable C64 PRG files with visualizer effects. Built with vanilla JS + WASM (Emscripten-compiled C++).

## Project Structure

```
public/           Web frontend (vanilla JS, no framework)
wasm/             C++ sources compiled to WASM via Emscripten
SIDPlayers/       C64 assembly (KickAss) player/visualizer routines
netlify/          Serverless function for HVSC proxy
```

See docs/ARCHITECTURE.md for detailed component documentation.

## Build

Run `0-build.bat` (Windows). It does three things:
1. Generates frequency lookup table (FreqTableGen.py)
2. Builds SID player .bin files from KickAss assembly
3. Rebuilds WASM modules via Emscripten

### Prerequisites
- Java (for KickAss.jar assembler)
- Python 3 (for FreqTableGen.py)
- Emscripten SDK (only if rebuilding WASM - set EMSDK_PATH in 0-build.bat)
- Node.js (for dev dependencies only)

### Local dev server
```
1-runserver.bat          # or: python -m http.server 8000 -d public
npx serve public         # alternative
```

## Key Technical Concepts

### WASM Modules
Two compiled WASM modules in `public/`:
- **sidquake.wasm** - SID file processing + PNG converter + lightweight reSID playback (from `wasm/sid_processor.cpp` + `wasm/png_converter.cpp` + `wasm/cpu6510_wasm.cpp` + `wasm/sid_audio.cpp`). The 6510 CPU core (`cpu6510_wasm.cpp`) is compiled into this module, not shipped separately.
- **sidplayfp.wasm** - The default playback engine: libsidplayfp + reSIDfp with a real C64 environment and embedded KERNAL/BASIC/CHARGEN ROMs (from `wasm/sidplayfp_audio.cpp` + vendored `wasm/libsidplayfp/`). Lazily loaded by `sid-playback.js`; exposes the same `audio_*` API as the legacy reSID engine (still inside sidquake.wasm, reachable via `?engine=resid` for one release before removal). Rebuild with `scripts/build-sidplayfp-wasm.sh` (Linux/CI) or the second emcc step in `0-build.bat` (Windows).

- **exomizer.wasm** - Exomizer 3, the default PRG compression option ("smaller file") (from `wasm/exomizer_wrap.c` + vendored `wasm/exomizer/`). Lazily loaded by `compressor-manager.js`, which creates a fresh module instance per compression because upstream keeps global state it never resets. Rebuild with `scripts/build-exomizer-wasm.sh` (Linux/CI) or the third emcc step in `0-build.bat` (Windows).

JS talks to WASM via `cwrap()` bindings in `sidquake-core.js`.

### PRG Export Pipeline
SID file → WASM analysis → memory layout planning → player .bin overlay → optional compression (TSCrunch or Exomizer) → downloadable .prg

TSCrunch and Exomizer are a deliberate ratio/speed pair: Exomizer packs a typical export ~9-16% smaller, TSCrunch decrunches roughly 4x faster on the C64 (~33 vs ~129 cycles/byte). Exomizer is the default; TSCrunch is there for when depack speed matters.

### SIDPlayers Assembly
KickAss assembly files in `SIDPlayers/`. Pre-compiled to `.bin` at three load addresses ($4000, $8000, $C000) and stored in `public/prg/`. Each player has a JSON config defining its options, galleries, and capabilities.

### HVSC Integration (self-hosted)
HVSC is hosted by the site itself, not proxied from an external mirror. Raw `.sid` files are served statically from `public/HVSC/C64Music/...`, and `public/hvsc-index.json` holds the full tree + per-tune metadata (title/author/released + folded STIL comment text for search). `hvsc-browser.js` builds the directory tree in-memory from that index (instant browsing, no per-folder network calls) and loads SIDs directly from `/HVSC/<path>`.

The raw files are **not** committed. A committed archive at `hvsc-data/*.7z` is extracted into `public/HVSC/` by `scripts/extract-hvsc.js` — run locally once (`npm run extract-hvsc`) and by the Netlify build (see `netlify.toml`). `public/HVSC/` is gitignored. After an HVSC update: drop in the new archive, `npm run extract-hvsc -- --force`, then `npm run build-hvsc-index`, and commit the archive + `hvsc-index.json`.

The archive is stored in **Git LFS** (it exceeds GitHub's 100 MB per-file push limit otherwise). Clone with git-lfs installed, and keep `GIT_LFS_ENABLED=true` / `GIT_LFS_FETCH_INCLUDE=*.7z` set in Netlify's environment variables — see `hvsc-data/README.md`.

## Code Conventions

- Vanilla JavaScript with ES6 classes (no build step, no bundler, no framework)
- WASM C++ uses `extern "C"` with `EMSCRIPTEN_KEEPALIVE` exports
- C64 addresses written as hex with $ prefix in comments/docs (e.g., $D400)
- File naming: kebab-case for JS files, PascalCase for SIDPlayers directories

## Common Tasks

### Adding a new visualizer
1. Create assembly in `SIDPlayers/NewName/`
2. Add KickAss build lines to `0-build.bat` for each load address
3. Add entry to `public/visualizer-registry.js`
4. Create config JSON + preview PNG in `public/prg/NewName/`

### Modifying WASM emulation
1. Edit C++ in `wasm/` (cpu6510_wasm.cpp, sid_processor.cpp, or png_converter.cpp)
2. Run `0-build.bat` and answer Y to WASM rebuild
3. New .wasm + .js files land in `public/`

### Modifying the web UI
Edit files directly in `public/`. No build step needed - just refresh the browser.

## Testing
- `public/tests/` contains test files
- No automated test runner currently; testing is manual via browser

## Deployment
Deployed via Netlify. The `public/` directory is the publish directory. Netlify functions are in `netlify/functions/`.
