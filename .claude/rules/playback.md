---
paths:
  - "wasm/sidplayfp_audio.cpp"
  - "wasm/sid_audio.cpp"
  - "public/sid-playback.js"
  - "public/sid-player.js"
  - "public/sid-worklet-processor.js"
  - "scripts/build-sidplayfp-wasm.sh"
---

# Playback

Read `docs/PLAYBACK.md` first.

- Playback is libsidplayfp only (`sidplayfp.wasm`). `sid_audio.cpp` (reSID, in
  `sidquake.wasm`) keeps the same `audio_*` API but only renders for the song
  length scan's fast option and the VU warning's audio check.
- libsidplayfp uses its own reSIDfp; `wasm/resid/` is only `sid_audio.cpp`'s.
- `wasm/libsidplayfp/` and `wasm/resid/` are vendored; local patches are
  minimal and recorded in `wasm/libsidplayfp/README.SIDquake.md`.
- Chip model `auto` means each tune's header decides, per chip for 2SID/3SID.
- Nothing automated covers playback; `public/tests/engine-test.html` is the
  manual comparison page.
