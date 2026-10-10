---
paths:
  - "wasm/sid_processor.cpp"
  - "public/sidquake-core.js"
  - "public/analysis-store.js"
  - "public/loop-prepass.js"
  - "public/analyser-session.js"
  - "public/psid.js"
  - "public/spectrometer-*.js"
  - "public/bake-dsp.js"
  - "public/loop-detect.js"
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
- The analyser counts a SID "chip" per `$20` slot a play routine writes to
  (`$D400-$D7FF`, `$DE00-$DFFF`), plus `$D400` and any header-declared address;
  init writes don't count.
- Timing is PAL-only.
- Song length and loop decisions describe one tune: in a multi-song export they
  stay off unless the export is locked to one subtune (`exportSubtuneIndex()`).
- A loop hint the audio does not confirm is dropped, never trusted. A tune still
  playing when the scan stops is unresolved, not a fade-out.
