# Playback

Two engines behind one API, fed into one AudioWorklet.

## Engines

**`sid_audio.cpp`** - Legacy lightweight reSID playback engine
- Playback bus over `cpu6510_core.h`, routing reads and writes through the SID
  chips; calls init once and JSR-to-play once per frame, driving reSID
- No real C64 environment (RSID/digi/raster tunes need `sidplayfp.wasm`)
- No longer the default; kept one release as the `?engine=resid` fallback
- Key exports: `audio_init`, `audio_load_sid`, `audio_generate`, `audio_get_*`

Compiled into `sidplayfp.wasm` (playback only, lazily loaded):

**`sidplayfp_audio.cpp`** - libsidplayfp playback engine (the default)
- Same `audio_*` export API as `sid_audio.cpp`, so `sid-playback.js` treats the two
  engines interchangeably (`?engine=fp|resid` or localStorage `sidquake-engine`;
  default `fp`)
- Full C64 environment from vendored `wasm/libsidplayfp/` (2.16.1): cycle-exact
  6510 + CIA + VIC-II, real KERNAL/BASIC/CHARGEN ROMs (embedded via `wasm/roms_data.h`,
  sources in `roms/`), reSIDfp SID emulation (nonlinear 6581 filter, 2SID/3SID)
- Correctly plays RSID tunes, main-loop/NMI digi players and raster-timed code
- Built by `scripts/build-sidplayfp-wasm.sh` or the second emcc step in `0-build.bat`

Timing is PAL-only throughout.

## Page side

**`sid-playback.js`** - Playback engine wrapper
- `SIDPlayback`: one shared AudioContext + AudioWorklet for the whole page,
  fed from whichever WASM engine `SIDPlayback.engineName()` selects
- Asks iOS for the `playback` audio session type, so the ring/silent switch
  doesn't mute a tune the way it mutes Web Audio by default
- `setModel(6581|8580)` forces a chip; anything else follows the tune's header
  (the fp engine does that per chip, so a 2SID/3SID tune keeps a mixed set).
  `getHeaderModel()` reports what the header asked for, parsed from the file

**`sid-player.js`** - Playback UI
- `SIDPlayer`: the transport pill (play/stop/subtunes/time/quality/chip/speed/
  volume), built into whatever container it is given; several may exist, and
  the one that plays owns the shared `SIDPlayback`
- Sampling quality, volume and chip model are page-wide preferences kept in
  localStorage (`sidquake-sampling`, `sidquake-volume`, `sidquake-sid-model`)
  and mirrored across every pill on the page. Chip model defaults to `auto`,
  i.e. each tune's own header decides; changing quality or chip reloads the
  tune in the engine, so playback restarts

**`sid-worklet-processor.js`** - the AudioWorklet. The engine renders on the
main thread; `sid-playback.js` posts Float32 sample blocks over the worklet's
MessagePort and the processor queues them and plays them out in `process()`.

`public/tests/engine-test.html` is a manual page for comparing the engines.
