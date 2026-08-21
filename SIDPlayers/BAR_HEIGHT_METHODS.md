# Bar-height methods for the spectrum visualizers

The bar visualizers (RaistlinBars family, ScrapColumns) can derive their bar
heights three different ways. A visualizer is compiled once per method it
supports, selected by a build flag, and the web app picks the variant at export
(see the build matrix and registry/UI notes below).

| # | Method | Play calls/frame | Extra RAM | Quality | Status |
|---|--------|------------------|-----------|---------|--------|
| a | Modified-memory | 2 (real + analysis peek, backup/restore) | none | good | **shipped** (normal build) |
| b | Shadow-register | 1 (redirected) | small (order table + mirror) | good, cheaper | **shipped** (`SPECTROMETER_SHADOW`) |
| c | Precomputed FFT | 1 | large (codebook + index, ~10-15 KB) | best | **shipped** (`SPECTROMETER_BAKED`) |

## (a) Modified-memory — current normal build

`AnalyseMusic` (INC/musicplayback.asm) plays the tune, then plays a second
"peek" bracketed by `BackupSIDMemory` / `RestoreSIDMemory` (the save/restore
routines the exporter generates from the analyzer's modified-address list) so
the peek advances nothing. The peeked SID registers are mirrored to
`sidRegisterMirror` and `AnalyzeSIDRegisters` (INC/spectrometer.asm) turns
voice frequency + envelope into bar targets. Correct but costs two play calls
plus the per-frame memory save/restore.

## (c) Precomputed FFT — `SPECTROMETER_BAKED`

The web app renders the tune, FFTs it, and vector-quantizes the 40-bar heights
with **split (product) VQ**: the column is cut into segments (bars/segment) that
are quantized independently, so segments animate on their own instead of the
whole column freezing on one shared codebook shape. It ships a fixed-size
codebook (256 columns × 40 bars, however split) plus one index byte per segment
per 25 Hz keyframe, loop-trimmed. The exporter picks the segment count per tune —
5×8 for best detail whenever the index fits RAM (nearly always, since looped
tunes store one short cycle), dropping to 4/2/1 for long non-looping tunes so
they animate all the way through. The player replays it (`DecodeBakedFrame`,
reading the segment count/width from the data block) and drops the whole
analysis subsystem (freqtable, `AnalyzeSIDRegisters`, ADSR sim, register
mirror, `barVoiceMap`, `voiceRelease`). One play call, no bar maths, but needs
the data in RAM and can fail to find a clean loop on very long tunes.

## (b) Shadow-register — `SPECTROMETER_SHADOW`

Goal: one play call and no per-frame save/restore, while still getting the
per-register values method (a) needs. Instead of playing twice, redirect the
play routine's SID writes into a shadow buffer, then replay them to the real
SID in a fixed order.

### Emulation side (web app, extends the existing analyzer) — BUILT + verified
Implemented in `public/spectrometer-shadow-detect.js` (`detectWriteOrder`). It
drives the 6510 emulator already in `sidquake.wasm` (via existing exports -
`cpu_execute_function`, `cpu_set_record_writes`, `cpu_get_write_sequence_*`,
`cpu_set_tracking`; no rebuild), captures the order each register is first
written **per frame**, and reports the dominant order + its consistency. Steps:
1. Load the music into CPU RAM, init the tune, then step `play` frame by frame
   with write-recording on.
2. Dominant order = most frequent per-frame first-write signature; consistency =
   its share of frames.
3. Consistency **no longer gates the tune** - it only decides which order we
   bake. `analyzeShadow` always returns a full **25-entry** replay order (a
   permutation of `$00-$18`): when consistency >= 60% we keep the detected order
   and append any registers the tune never wrote in fallback order; below 60% we
   use the fallback order outright (`$18,$17,..,$00` - descending). Measured on
   real tunes: JCH-Crystalline
   and stinsen-diagonality are 100% consistent; axelf (30%), Xiny-Laxity (50%),
   knightrider (76%), dane (87%) vary - all now handled, the low ones via the
   fallback order.

For a multi-SID tune the same detection covers every chip: the recorded offsets
are already relative to `$D400`, so chip N's registers appear as `$20*N + $00-$18`
and go into the same order list, preserving the tune's own cross-chip interleaving.
`analyzeShadow` takes a `numChips` option and returns **25 entries per chip**.

`analyzeShadow()` also finds the **store sites** and **verifies the redirect**:
it scans the executed code (init **and** play) for absolute stores to `$D4xx`
(STA/STX/STY - `8D/9D/99/8E/8C`), then re-runs with every site's high byte
repointed at a shadow page and checks that **zero** writes still reach the real
`$D4xx` (redirect complete). It returns `{ suitable, order, usedFallback,
storeSites, redirectComplete }`. `suitable` is now purely `redirectComplete` -
the *only* thing that blocks shadow is a SID write that doesn't come from a
patchable store (an indirect or self-modifying store address), because then we
can't mask the SID. The exporter patches the site offsets to the chosen shadow
page and bakes the 25-entry `order`.

### Why replay all 25 registers every frame
The mirror is seeded by the **init** routine's redirected stores (volume, filter
setup) as well as each frame's play, so it always holds the tune's full intended
SID state. Replaying only the observed subset dropped init-only registers (the
tune would play at the wrong volume, or silent) and any register an occasional
frame wrote but the dominant frame didn't. So the C64 replays **all 25**
registers from the mirror every frame in the baked order; re-writing an unchanged
register with its own mirror value is harmless, and no write is ever missed.

### Multi-SID
Only the *high* byte of each `$D4xx` store is repointed, so every chip keeps its
natural offset within the redirected page: SID 1 lands at `mirror + $00`, SID 2 at
`+ $20`, SID 3 at `+ $40`, SID 4 at `+ $60`. Those are the same offsets the replay
uses to index `$D400`, so **one page-aligned mirror covers all four chips** and the
replay loop is unchanged apart from running longer. Cost is 25 more replayed
registers per extra chip (~500 cycles), against a whole extra play call for method
(a). The mirror grows from 100 to 121 bytes in shadow builds
(`SIDMIRROR_CHIP_STRIDE`/`SIDMIRROR_SIZE` in `INC/common.asm`), and the order table
reserves `4*25+1` bytes.

This assumes the chips sit on the `$D400 + $20*N` grid, which is what the C64
players assume everywhere else too (`RestartMusic`, `AnalyseMusic`,
`AnalyzeSIDRegisters`). The exporter checks the analyzer's detected chip addresses
and refuses shadow for anything else. A chip outside the `$D4` page (e.g. `$D500`)
is caught earlier and more cheaply: its stores aren't `$D4xx`, so they never get
redirected and show up as leaked writes.

### PRG baking
- Bake the canonical order table into a small data block the player reads.
- Patch the play routine's SID stores to target the shadow buffer instead of
  $D4xx: rewrite the high byte of every `8D/9D/99 lo D4` operand to the shadow
  page. (Indexed and self-modifying players need care — verify against the
  analyzer's write-site list; if any site can't be safely repointed, fall back
  to (a).)

### C64 side (`SPECTROMETER_SHADOW` build flag) — BUILT
Per frame (`PlayMusicShadow` in `INC/musicplayback.asm`):
1. `jsr SIDPlay` — writes land in `sidRegisterMirror` (the play routine's `$D4xx`
   stores were repointed there by the exporter; init's were too, at startup).
2. Replay **all 25** registers of every chip to the real SID in the baked order:
   `ldy shadowOrder,x / bmi done / lda sidRegisterMirror,y / sta $D400,y`. The
   table holds 25 entries per chip and ends in `$FF`, so the terminator alone
   bounds the loop to the chips the tune actually uses — a single-SID export
   replays exactly the 25 it used to, at exactly the old cost.
3. `jmp AnalyzeSIDRegisters`, which reads the mirror directly for bar targets.
No second play, no backup/restore.

### Risks / open questions
- SID write **order** matters for hard-restart / gate timing; replaying final
  values in the baked order reproduces audio only when each register is written
  at most once per frame. Multi-write registers within a frame lose intermediate
  values — measure how often that actually happens.
- Patching SID stores in an arbitrary (possibly self-modifying or indexed)
  play routine is the fragile part; a store whose address can't be statically
  repointed shows up as a leaked write and disqualifies the tune (falls back to
  (a) in the UI).
- Only validatable on real hardware / VICE — build in stages, testing each.

## Build matrix

Each supporting visualizer compiles up to three code blobs via flags
(`<none>` = a, `SPECTROMETER_SHADOW` = b, `SPECTROMETER_BAKED` = c), e.g.
`RaistlinBars-code.bin`, `RaistlinBarsShadow-code.bin`, `RaistlinBarsFFT-code.bin`.
Each variant's config JSON lists its binary + the data-block addresses it needs;
the registry/UI exposes the choice. All four bar players (RaistlinBars,
RaistlinBarsWithLogo, RaistlinMirrorBars, RaistlinMirrorBarsWithLogo) ship all
three methods. ScrapColumns and the non-bar visualizers still ship (a) only.

`scripts/build-players.sh` rebuilds every variant; `--check` builds to a temp
directory and diffs against the committed artifacts instead of overwriting them.

## Which one the app picks

Selecting a bar card lands on **(a) modified-memory** — "VU meter · Clever" in
the UI (`selectVisualizer` in `public/ui.js`). It works on any tune, needs no
precomputed stream in RAM, keeps every subtune of a multi-song file, and exports
with nothing to render first. Method (c) looks better and is one click away on
the Method panel, but it has to render the whole tune and store it, which caps
how much of a non-repeating tune it can show — not something a first export
should opt into silently. A method the user chooses is remembered for the
session and tried first on the next tune; anything that cannot be built for the
tune in hand (calls/frame, SID count, memory) is skipped in that order.
