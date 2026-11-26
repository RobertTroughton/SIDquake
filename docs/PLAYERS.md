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

## Piano

`SIDPlayers/Piano/Piano.asm`: the RaistlinBarsWithLogo logo split (10 art rows
and a clear row, sprite curtain), the song name and under it the clock
(`INC/timer.asm`, centred, with "/MM:SS" when the length is known) in the 1x2
font, and a 40-white-key keyboard six rows tall with black keys the top four
(68 keys from a C to the G five octaves and a fifth above). The exporter picks
that C per tune (`public/piano-range.js`, via `processPianoRange` in
`prg-builder.js`): it steps the tune on the analyser, counts the strikes the
player would show and takes the start (C1, C2, C0 or C3, in that order of
preference on a tie) that leaves the most of them unfolded. It writes the
note + 1 to data block `$74`; 0 means C1. It reads the SID through the same register mirror as the bar players,
so it ships two builds: realtime (second play call under save/restore) and
`SPECTROMETER_SHADOW`. No baked variant: an FFT cannot tell which key a voice
is on.

- Per voice, `AnalyzeSIDRegisters` turns the frequency into a note by binary
  search of a PAL semitone-boundary table and folds it by octaves onto the
  keyboard. Noise-only voices (drums), the test bit and an empty waveform read
  as silent.
- Per key, `UpdatePiano` keeps a level: a gate rising, or a voice landing on a
  different key than last frame (or sounding again after a silent frame),
  strikes it. The second rule is for multispeed tunes whose gate opens and
  closes between two of the player's once-a-frame samples (Moonlight Sonata by
  Thanos B. gates for one of its two calls a frame): the new note, or the hard
  restart before it, is all the analysis sees. Then sustain sets a floor while the gate is held, and the
  decay or release nibble sets how fast it falls (held to 4..40 frames). The
  level picks one of four shades from the voice's colour family.
- White keys are lit in colour RAM. The black keys are cut-outs in the white-key
  characters, so a lit black key is a 6px Y-expanded sprite (up to eight at
  once); the split IRQ turns the curtain sprites into these once the curtain
  has passed, and `MusicFrameHandler` turns them back in the bottom border.

`scripts/test-piano.js` (in `npm test`) runs these routines in the 6510
emulator.

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
