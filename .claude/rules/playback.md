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

- Both engines export the same `audio_*` API; `sid-playback.js` treats them as
  interchangeable. A change to one engine's exports needs the same change in the
  other.
- `sidplayfp` is the default; `sid_audio.cpp` (reSID) is the `?engine=resid`
  fallback and has no real C64 environment (no RSID, digi or raster tunes).
- `wasm/libsidplayfp/` and `wasm/resid/` are vendored; local patches are
  minimal and recorded in `wasm/libsidplayfp/README.SIDquake.md`.
- Chip model `auto` means each tune's header decides, per chip for 2SID/3SID.
- Nothing automated covers playback; `public/tests/engine-test.html` is the
  manual comparison page.
