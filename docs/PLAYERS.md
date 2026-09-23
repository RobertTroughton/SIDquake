# C64 players

The visualisers that run on the C64. How to write a relocatable one is in
[`SIDPlayers/CODE_ONLY_GUIDE.md`](../SIDPlayers/CODE_ONLY_GUIDE.md); the three
ways a bar visualiser gets its bar heights are in
[`SIDPlayers/BAR_HEIGHT_METHODS.md`](../SIDPlayers/BAR_HEIGHT_METHODS.md). The
exporter side is in [`EXPORT.md`](EXPORT.md).

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

The 6510 emulator those tests use is described in [`CPU_CORES.md`](CPU_CORES.md).

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

## Rules that bite

- `INC/common.asm` holds the **data-block layout**, a contract with
  `prg-builder.js` `generateDataBlock()`: change one, change both.
- Each bar visualiser is compiled once per bar-data method (`<none>` /
  `SPECTROMETER_SHADOW` / `SPECTROMETER_BAKED`). Touching shared `INC/` code
  changes up to three shipped blobs per player; `scripts/build-players.sh
  --check` says which.
- Exports are relocated, so a player's *code* size is not capped by the bank
  layout; only its VIC graphics must fit a 16 KB bank.
- Timing is PAL-only, and `SetupStableRaster` writes the PAL `$DC06` latch
  unconditionally.

## Raster splits

Nothing in `npm test` sees a VIC-II, so the logo players' raster splits are
covered by two scripts that export a real `.prg` and run it in VICE. See
[`TESTING.md`](TESTING.md#raster-splits-vice).
