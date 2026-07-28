# SIDquake — TODO

Outstanding work only. `[WASM]` / `[asm]` items need a rebuild to land.

## Playback / engine
- **Remove the legacy reSID fallback** — libsidplayfp is the default engine; remove `sid_audio.cpp` and the `?engine=resid` path a release after the switch, and update `public/tests/engine-test.html`.
- **SID register mirror writes** (`sid_audio.cpp` `$D420-$D7FF`) can be lost under MOS8580 + SAMPLE_FAST. Legacy reSID engine only — low priority given the removal above.
- **`playAddress == 0` tunes** analyse as almost-nothing but `sid_analyze` still returns success. [WASM]
- **`png_converter` output accessors** trust caller buffer sizes (no length params) — an under-allocated JS buffer is a WASM heap overflow. [WASM]

## Performance
- **`png_converter` conversion cost** — `getPixelColor` scans ~119 palettes × 16 per pixel and re-runs full-image passes up to ~65× on VICE screenshots. Cache a `colorIndex[320*200]` in `setImageData`. [WASM]
- **Synchronous analysis** — `sid_analyze` runs 30,000 frames in one call, so the busy overlay can't update. Chunk it or move it to a Web Worker.
- **Main-thread index cost** — the 11.9 MB index parse + 61k-tree build (and PETSCII matching, image conversion) run on the main thread; move to a Worker / lazy STIL shard.

## Assembly / players
- **`SetupStableRaster` is PAL-only** (`SIDPlayers/INC/stablerastersetup.asm`) — writes the PAL `$DC06` latch unconditionally; NTSC exports jitter. Gate the latch on the clock-type byte. [asm — rebuild + NTSC test]
- **`WithLogo` players are near-clone forks** of their base players — fold behind a `HAS_LOGO` define.

## Memory / relocation — V2.01: full memory configurability
Goal: every visualizer uses the code-only model, and the exporter can place each
VIC asset at any *valid slot within a bank* — not just shift whole banks in
`$4000` steps — so memory packs as tightly as possible around the SID.

- **Retire the `CODE_ONLY` / `GFX_DONOR` two-build split** — today a player is
  compiled *twice*: once with `-define CODE_ONLY` (emits the code + CPU tables,
  graphics behind `#if !CODE_ONLY`) and once with `-define GFX_DONOR` (emits the
  VIC graphics, which live in those same `#if !CODE_ONLY` blocks, for
  `gen-gfx-manifest.js`). The two builds are *complementary halves*, so the
  `#if !CODE_ONLY` guards can't just be deleted — the graphics blob is generated
  from them. Redesign the source so code and graphics live in cleanly separate
  segments emitted from a single build, then drop the paired defines.
- **Convert the last 3 classic players to code-only** — `SimpleRaster`,
  `ScrapColumns`, `SimpleBitmapWithScroller`. Then retire the full-binary reloc
  path (`gen-reloc-table.js` + `*.reloc.json`) and the fixed-bank `.bin`s, leaving
  **one** placement system.
- **Relocate VIC assets independently *inside* a bank** (today they keep their
  authored intra-bank offset and only the bank moves). Move bitmap / screen /
  charset separately, updating `$d018` (screen+charset) and `$dd00` (bank):
  - **Bitmap** — 2 slots per bank (`bank+$0000` / `bank+$2000`). Valid absolute
    bases: `$2000, $4000, $6000, $A000, $C000, $E000`. **Not** `$8000` (VIC
    char-ROM shadow at `$9000-$9FFF` corrupts the top half) and **not** `$0000`
    (ZP/stack + char-ROM shadow at `$1000-$1FFF`).
  - **Screen** (video matrix) — any `$0400` slot in the bank (16/bank), avoiding
    the char-ROM shadow slots in banks 0 and 2.
  - **Charset** — any `$0800` slot in the bank (8/bank), same char-ROM caveat.
- **Removes the fixed-address limits** — e.g. `SimpleBitmapWithScroller` could
  then load at `$C000` (bitmap at `$C000`/`$E000`, RAM under I/O + KERNAL via
  `$01` banking), not just `$4000`/`$8000`.

## Refactor / cleanup
- **Media-converter consolidation** — reassess whether `png_converter` is still needed or whether CharSetLab (or its functions) can replace it; unify the font/PETSCII/image conversion paths on a faster shared core.
- **Palette drift** — the C64 RGB values differ between `ui.js` and `petscii-converter.js`; consolidate to one shared palette.
- **Export option snapshot** — the exporter reads option state from the live DOM rather than a captured snapshot (`_captureOptionValues` exists but isn't used for export). No observed desync today (the modal is static during export).

## Loop detection — give the user control of the scan
The analysis cap is currently an Advanced-settings number (`maxLoopSeconds`, default
600 s → a 1200 s render cap). Hitting it is silent and unrecoverable in-flow: the
tune gets stored as a fade-out and the only way to search further is to open
Advanced, raise the value, and re-run the whole analysis. Most tunes loop or fade
inside ~6 min, so the cap should be lower *and* the rare long tune should be
handled in the moment, without an Advanced round-trip.

- **"Stop searching" button** during the scan — take what's been rendered so far and
  bake it (currently only a full Cancel exists, which throws the analysis away).
- **Prompt at the cap** instead of silently giving up: "No loop found in 6:00 —
  [Keep searching] [Use what we have]". Keep-searching should extend from where it
  is, not restart the render.
- **Drop the default cap 10 min → 6 min** once the above exists, so the common case
  gets faster and the edge case stays reachable.
- Edge cases worth covering: a tune that never loops (long ambient), one whose loop
  is longer than the cap, a user who wants to stop early on purpose, and a
  background tab (the scan must not stall or silently abandon).
- Related: the render already stops early on a confirmed loop and on ~10 s of
  silence, so these prompts should only ever appear on genuinely long tunes.

## Bar methods — warn when a tune is invisible to the VU meter
The VU-meter methods claim a bar only for a voice with GATE=1, TEST=0 and a
waveform selected (`INC/spectrometer.asm` `AnalyseSingleVoice`). Some tunes drive
the SID audibly without ever meeting that test, so the bars sit empty while the
music plays — and nothing tells the user why.

Open case: `MUSICIANS/M/Mr_Mouse/Downhill_Rocks_Roll_the_Best.sid` runs its first
~13.6 s (frames 8-679) with voices 1/2 all zeros and voice 3 at `ctrl=$10`
(triangle, gate off), yet audibly plays music — rendered rms ~0.03 with a rhythmic
accent every ~4 s, stepping to ~0.07 at 13.5 s.

**The mechanism producing that audio is not yet understood, so the fix isn't settled.**
What is established:
- Our 6510 core is almost certainly right: the rendered level step at 13.5 s matches
  the first gated voice at frame 680 (13.57 s) exactly, and VICE shows the same
  register values.
- Ruled out: CIA/multispeed (no CIA writes, header 50 Hz), an init-installed IRQ,
  unmodelled SID/ROM readback (the tune reads **no** I/O and no ROM), truncated init
  (completes at every cycle budget), unimplemented opcodes, `$D418` digi (one
  constant write/frame), filter self-oscillation (res 0, no routing, cutoff 0).

Next measurement that would settle it: read **`$D41C` (ENV3)** in VICE during the
intro. Non-zero ⇒ voice 3 really is sounding with the gate closed, so the gate-driven
model is simply the wrong model and bars could be driven from the envelope instead.
Zero ⇒ the sound comes from somewhere else entirely and the search reopens.

Whatever the cause, the user-visible outcome (music playing, bars empty) is wrong.
Until a real fix is known, at least make the failure legible:
- During analysis, count frames with no audibly-active voice (the emulator glue in
  `spectrometer-shadow-detect.js` already does load/init/step).
- If a long leading stretch — or a large fraction — of the tune has none, flag it on
  the VU-meter cards in the method picker: "the bars will be empty for the first
  N seconds of this tune; Spectrometer reads the audio directly."
- Spectrometer is unaffected (it FFTs rendered audio), so it stays the recommendation.

## Search / product
- **Search relevance ranking** — results follow the Name/Year column sort. Add a "Relevance" sort mode (title/author-prefix weighting) so ranking doesn't fight the column sort. (Diacritic folding + true total count are done.)

## Build / infra
- **Release WASM flags** — consider `-flto`, `-sASSERTIONS=0`, `--closure 1`.
- **Artifact CI covers the players only** — `.github/workflows/ci.yml` rebuilds the
  players and diffs them against what is committed (`scripts/build-players.sh --check`).
  The `.wasm` files and the freq tables are still unverified; both need emsdk/python
  in the job.
- **Windows-only build** — `0-build.bat` has a hardcoded `EMSDK_PATH`; the sidplayfp WASM build is duplicated between it and `scripts/build-sidplayfp-wasm.sh`. The player half now also runs from `scripts/build-players.sh`, so the two will drift unless they are folded together.
- **Repo size** — the committed HVSC `.7z` (~88 MB) dominates the repository; consider Git LFS or a build-time fetch.
- **`.gitignore` residue** — still carries CMake / native-desktop-app entries from before the project became a web tool.
- **HVSC token hardening** — the token is a deliberate speed-bump, not access control; a Netlify rate-limit on `/hvsc-token` + `/HVSC/*` would raise the bar.
