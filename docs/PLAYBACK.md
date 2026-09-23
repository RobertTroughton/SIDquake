# Playback

One engine, libsidplayfp, fed into one AudioWorklet.

## Engine

**`sidplayfp_audio.cpp`** (compiled into `sidplayfp.wasm`, lazily loaded)
- Exports the `audio_*` API `sid-playback.js` drives
- Full C64 environment from vendored `wasm/libsidplayfp/` (2.16.1): cycle-exact
  6510 + CIA + VIC-II, real KERNAL/BASIC/CHARGEN ROMs (embedded via `wasm/roms_data.h`,
  sources in `roms/`), reSIDfp SID emulation (nonlinear 6581 filter, 2SID/3SID)
- Correctly plays RSID tunes, main-loop/NMI digi players and raster-timed code
- Built by `scripts/build-sidplayfp-wasm.sh` or the second emcc step in `0-build.bat`

libsidplayfp uses its own reSIDfp, not `wasm/resid/`.

**`sid_audio.cpp`** (in `sidquake.wasm`) is a lightweight reSID engine with the
same `audio_*` API. It no longer plays tunes to the listener. It renders audio
for the song-length scan when the Studio's "reSID (about twice as fast)" scan
engine is picked, and for the VU-visibility warning's audio check. It has no
real C64 environment: a playback bus over `cpu6510_core.h`, a minimal KERNAL,
init once and play once per frame (entered as an interrupt for play address 0).
Selecting a subtune reloads the tune and powers the SID chips on afresh, so
nothing carries over from the previous tune; `scripts/test-resid-engine.js`
covers it.

Timing is PAL-only throughout.

## Page side

**`sid-playback.js`** - Playback engine wrapper
- `SIDPlayback`: one shared AudioContext + AudioWorklet for the whole page,
  fed from `sidplayfp.wasm`
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
- Pause keeps the engine's place and the worklet's queue, and Play resumes from
  there; Stop, Restart, a subtune change or a reload start the tune over

**`sid-worklet-processor.js`** - the AudioWorklet. The engine renders on the
main thread; `sid-playback.js` posts Float32 sample blocks over the worklet's
MessagePort and the processor queues them and plays them out in `process()`.
It asks for more below ~0.37 s buffered, and asks again every ~0.2 s while a
request has come back empty.

`public/tests/engine-test.html` is a manual page for comparing the engines.
