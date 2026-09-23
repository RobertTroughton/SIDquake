---
paths:
  - "wasm/sid_processor.cpp"
  - "public/sidquake-core.js"
  - "public/analysis-store.js"
  - "public/loop-prepass.js"
  - "public/spectrometer-*.js"
  - "SIDPlayers/INC/spectrometer*.asm"
  - "scripts/test-loop-*.js"
  - "scripts/test-song-end.js"
  - "scripts/test-range-fit.js"
  - "scripts/test-bake-cache.js"
  - "scripts/test-baked-decoder.js"
  - "scripts/test-shadow-replay.js"
  - "scripts/test-vu-visibility.js"
  - "tools/songlengths/**"
---

# Sound analysis and bar data

Read `docs/ANALYSIS.md` (analyser run, song length, loop pre-pass) and
`SIDPlayers/BAR_HEIGHT_METHODS.md` (the three bar-data methods) first.

- The baked FFT stream and the shadow-register replay order are byte-level
  contracts between the JS encoder and the 6502 decoder. `npm test` runs the
  real assembled decoder against the encoder; keep it green and extend it when
  the format changes.
- The analyser counts a SID "chip" per touched `$20` slot in `$D400-$D7FF`, so a
  tune sweeping the mirror range reports up to 8 chips.
- Timing is PAL-only.
- Song length and loop decisions describe one tune: in a multi-song export they
  stay off unless the export is locked to one subtune (`exportSubtuneIndex()`).
- A loop hint the audio does not confirm is dropped, never trusted. A tune still
  playing when the scan stops is unresolved, not a fade-out.
