# Tune analysis

How SIDquake learns what a tune does before it plays or exports it: the 6510
analyser run (`sid_processor.cpp` over the analysis bus in
`cpu6510_wasm.cpp`), the JS glue that drives it, and the song-length / loop
scan. The spectrometer bar data built from the same machinery is in
[`SIDPlayers/BAR_HEIGHT_METHODS.md`](../SIDPlayers/BAR_HEIGHT_METHODS.md); the
CPU core itself is in [`CPU_CORES.md`](CPU_CORES.md).

## WASM side (`sidquake.wasm`)

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

**`opcodes.h`** - Shared opcode table (256 entries with mnemonic, addressing mode, size, cycles)

The analyser counts a SID "chip" per touched `$20` slot in `$D400-$D7FF`, so a
tune that sweeps writes across the mirror range reports up to 8 chips.

## JS glue

**`sidquake-core.js`** - WASM bridge
- `SIDAnalyzer` class wrapping all WASM calls via `cwrap()`
- Manages WASM heap memory allocation for file transfers
- Provides clean JS API: `loadSID()`, `analyze()`, `updateMetadata()`, `createModifiedSID()`

**`analysis-store.js`**, **`loop-prepass.js`**, **`spectrometer-shadow-detect.js`**
and the `spectrometer-bake*.js` family consume the analyser; the bake is
described in `BAR_HEIGHT_METHODS.md`.

## Song length and loop detection

Driven from `ui.js`; the results land on the Studio's Song tab.

- Song length (`runTuneAnalysis` → Song tab): the scan measures the tune itself
  (`measureOnly`), so no length is capped by what the spectrometer can store.
  A scan that resolves neither a loop nor an ending gives the C64 a running
  clock with no total, and offers "Keep looking" — the same search with the
  window doubled for that tune
- The scan runs in the background once the Studio opens, and there is no way
  to stop it early and keep a partial answer. Instead, an export pressed while
  it is still running goes ahead without it: no length (running clock, no
  total) and no forced loop, exactly as if nothing had been resolved. The scan
  carries on, and an export after it lands includes both; the Song tab, the
  manifest and the export status say so. Two cases still wait for the scan: the
  baked Spectrometer, whose stream is cut from the scan's own render, and a
  queue run, which has nobody to export again. With no background scan running
  (the quick path outside the Studio, or no Worker), the export measures under
  its overlay as before
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

The standalone HVSC song-length scanner that shares this machinery is
documented in [`tools/songlengths/README.md`](../tools/songlengths/README.md).

## Tests

- `scripts/test-loop-prepass.js` steps real tunes from `SID/` on the analyser
  and checks the pre-pass finds HVSC's loop period to the frame.
- `scripts/test-loop-detect.js`, `scripts/test-song-end.js`: which loop period
  `detectLoop` settles on and when `analyzeRows` may call a song ended
  (`spectrometer-bake.js`), over synthetic bar grids.
- `scripts/test-vu-visibility.js`: the "these bars will be empty" warning does
  not fire on ordinary tunes (real 6510 over `SID/`).
- `scripts/test-range-fit.js`, `scripts/test-bake-cache.js`,
  `scripts/test-baked-decoder.js`, `scripts/test-shadow-replay.js`: the bar-data
  methods (see `BAR_HEIGHT_METHODS.md`).
