# Testing

## `npm test`

Pure Node, no browser. The core of it is harnesses that drive the *real
assembled 6502* in the WASM 6510 emulator, covering the places the C64 side and
the exporter must agree byte-for-byte:

- `scripts/test-baked-decoder.js`: baked FFT stream.
- `scripts/test-shadow-replay.js`: shadow-register replay order.
- `scripts/test-timer-layout.js`: calls each assembled player's timer routines
  and diffs memory to check where the play-time clock lands.

The rest:

- `scripts/test-loop-prepass.js`: steps real tunes from `SID/` on the 6510
  analyser and checks the register pre-pass finds HVSC's loop period to the
  frame.
- `scripts/test-range-fit.js`: feeds the bake synthetic tones and checks the
  per-song frequency span it fits.
- `scripts/test-analyser-edge-cases.js`, `scripts/test-shadow-detect.js`: PSID
  header rules, play-address-0 tunes and the shadow scan, on tunes the tests
  build from a few bytes of 6502 (`scripts/lib/psid-asm.js`).
- `scripts/test-loop-detect.js`, `scripts/test-song-end.js`,
  `scripts/test-bake-cache.js`, `scripts/test-vu-visibility.js`: song length,
  loop and bake decisions (see [`ANALYSIS.md`](ANALYSIS.md)).
- `scripts/test-logo-fit.js`: the logo placement maths.
- `scripts/test-c64-render.js`, `scripts/test-image-memory.js`: the C64 preview
  matches the export, and converted pictures keep their real memory footprint.
- `scripts/test-resid-engine.js`: the reSID engine the fast song-length scan
  renders with: pitch, play clock, stack, play-address-0 and subtune handling.
- `scripts/test-worklet.js`: the AudioWorklet asks again when a request comes
  back empty, keeps its queue across a pause, and hands spent blocks back.
- `scripts/test-sidquake-core.js`: starting the page's analyser leaves the
  `SIDquakeModule` factory callable for the other loaders.
- `scripts/test-zip-writer.js`, `scripts/test-share-shards.js`: the hand-written
  zip layout, and the three copies of the share-meta shard hash agree.

`package.json` holds the authoritative list.

## Browser checks (Playwright, not in `npm test`)

Almost nothing covers the browser UI. The exceptions all need Playwright, which
isn't a dependency (`npm install --no-save playwright`):

| script | covers |
|---|---|
| `scripts/mobile-layout-check.js` | HVSC and Studio modals at phone widths |
| `scripts/logo-drop-check.js` | picking a logo lands in the input the exporter reads |
| `scripts/studio-smoke-check.js` | load a SID -> Studio -> background analysis -> export manifest, and the sticky visualizer choice; an export mid-scan leaves the length and loop out, one after the scan includes them |
| `scripts/device-check.js` | a device matrix from iPhone to 2560px desktop: horizontal scrolling, clipped content, tap target and text sizes, contrast, how many HVSC rows fit |
| `scripts/hvsc-deeplink-check.js` | a `?tune=` link arrives loaded and described, in either index/share-meta order and when the quick play fails; builds its own one-tune mirror |
| `scripts/player-check.js` | a rejected file leaves the previous tune loaded, Load then Play initialises the C64 once, a chip change restarts on that chip, Play after Pause resumes, the clock trails the engine by what is queued, the VU answer stays with its tune, a play-address-0 tune is refused at export |
| `scripts/compression-check.js` | crunching an export keeps the page answering, and gives the same bytes in the worker and on the page |
| `scripts/embed-options-check.js` | every documented embed option reaches the widget: chrome switches, configurable text, palette, root confinement, initial sort and query |

## Raster splits (VICE)

Nothing in `npm test` sees a VIC-II, so the players' raster splits are covered
by two scripts that export a real `.prg` and run it in VICE
(`apt-get install -y vice xvfb`; the C64 ROMs come from `roms/`):

- `scripts/seam-check.js` renders frames and checks the line below the logo's
  sprite curtain holds info text rather than data fetched through the logo's
  pointers.
- `scripts/seam-latency.js` breaks on the split handler's `$d011` write to
  report how many cycles of margin the switch has left (`--watch=curtain` reads
  sprite 0's Y there instead, i.e. whether the curtain that hides the switch was
  up at all).

Both take `--method` (which bar data to export with) and share
`scripts/lib/seam-lib.js`. Run them after touching a logo player's split, with
`scripts/make-test-logo.js`: a shipped gallery logo's artwork stops short of the
band and hides anything that goes wrong at its bottom edge.

## Slow checks to run by hand

- `scripts/build-players.sh --check` after touching `SIDPlayers/`: did any
  shipped binary move?
- `scripts/cpu-crosscheck/run.sh` after touching the 6510 decoder or either bus
  adapter. Needs a C++ toolchain and takes minutes. See
  [`CPU_CORES.md`](CPU_CORES.md).
- `scripts/bench-bake-analysis.mjs [bake-module] [tune.sid]` after an
  optimisation in `spectrometer-bake.js`: times the per-frame analysis and
  hashes its output, so a copy of the old module passed as `bake-module` shows
  whether the output stayed byte-identical.
- `scripts/measure-bass-resolution.mjs [bake-module] [seconds]` after changing
  the bake's bass windows: pitch spread and time smearing of the bottom bars
  over every tune in `SID/`.
