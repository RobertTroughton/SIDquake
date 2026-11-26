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
and a clear row, sprite curtain), then in the 1x2 font the song name and under
it the clock (`INC/timer.asm`, centred, with "/MM:SS" when the length is
known), then a drum bar, a 40-white-key keyboard six rows tall with black keys
the top four (68 keys from a C to the G five octaves and a fifth above), and a
filter bar. It reads the SID through the same register mirror as the bar
players, so it ships two builds: realtime (second play call under
save/restore) and `SPECTROMETER_SHADOW`. No baked variant: an FFT cannot tell
which key a voice is on.

The exporter fits two things per tune (`public/piano-range.js`, via
`processPianoRange` in `prg-builder.js`). It steps the tune on the analyser
and counts what the player would show. The keyboard starts on the C (C1, C2,
C0 or C3, in that order of preference on a tie) that leaves the most strikes
unfolded; it writes the note + 1 to data block `$74`, 0 meaning C1. The drum
bar's low/mid/high split is two noise-frequency high bytes (`$75`/`$76`, 0
meaning `$40`/`$A0`), cut at the two widest gaps between the tune's drum
pitches: tunes pitch their noise anywhere from `$05` to `$FF`.

- Per voice, `AnalyzeSIDRegisters` turns the frequency into a note by binary
  search of a PAL semitone-boundary table and folds it by octaves onto the
  keyboard. Noise is a drum, with a zone from its frequency; the test bit, an
  empty waveform and a zero frequency are silent. It also reads SID 1's filter:
  the cutoff high byte sets the filter bar's length when a voice is routed
  through the filter, coloured by the lowest such voice.
- `UpdatePiano` decides what is a key press. Each voice is idle, watching the
  start of a note, playing a note, or playing a drum.
  - A start: a gate rising, sounding again after a silent sample (a hard
    restart), noise starting, or during a note a different pitch with the gate
    off. The last is for multispeed tunes whose gate opens and closes between
    two of the player's once-a-frame samples (Moonlight Sonata by Thanos B.
    gates for one of its two calls a frame).
  - The start is watched before anything lights, because a note's first
    samples are often not its note: Bitgang (Magnar Harestad) opens every note
    with a frame of noise, GP All Stars' lead with noise and an octave drop,
    and GP All Stars' kicks are a pitch falling fast with no noise at all.
    Noise for a second sample, or noise then silence, is a snare or hi-hat;
    a pitch falling two semitones or more twice running is a kick or tom.
    Either lights the drum bar (its zone from the noise pitch, a kick in the
    low zone), and the pitch after it is ignored until the next start. A pitch
    that holds for a sample is a note, and so is anything still undecided
    after three samples with no noise. A plain note lights one frame after it
    starts, which in the realtime build (its analysis runs a play call ahead
    of the sound) lands it in step. A new note's voice lets go of its other
    keys, fading over 10 frames: one voice is one finger.
  - During a note, a jump of three semitones or more under a held gate is a
    chord tone (an arpeggio). It lights beside the others, which stay lit
    while the gate is held; a revisited key is refreshed without flashing
    again. Smaller steps are a slide or vibrato: not shown, the key stays on
    the note being shown (and keeps its sustain), unless the pitch then rests
    on one note for three samples, a legato note.
- Per key there is a level: a strike sets it full; while the gate is held,
  sustain sets a floor and the decay nibble the fall, after it the release
  nibble (both held to 8..40 frames). On a white key the level picks one of
  four shades from the voice's colour family, after two frames of the
  family's strong colour as a strike flash. Black keys are lit in grey
  whichever voice plays them: a light grey flash, then mid grey, dark grey as
  they fade. The drum and filter bars use the voice's colours.
- White keys are lit in colour RAM. The black keys are cut-outs in the white-key
  characters, so a lit black key is a 6px Y-expanded sprite (up to eight at
  once); the split IRQ turns the curtain sprites into these once the curtain
  has passed, and `MusicFrameHandler` turns them back in the bottom border.
  The two bars are characters whose colour RAM is the background when unlit.

`scripts/test-piano.js` (in `npm test`) runs these routines in the 6510
emulator; `scripts/piano-lit-count.js` reports how many keys a tune keeps lit.

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
