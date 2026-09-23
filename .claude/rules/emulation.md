---
paths:
  - "wasm/cpu6510_core.h"
  - "wasm/cpu6510_wasm.cpp"
  - "wasm/opcodes.h"
  - "wasm/sid_audio.cpp"
  - "scripts/cpu-crosscheck/**"
---

# 6510 emulation

Read `docs/CPU_CORES.md` before changing anything here.

- The instruction set lives once, in `cpu6510_core.h`, templated over a bus.
  `cpu6510_wasm.cpp` (analysis) and `sid_audio.cpp` (reSID playback) are bus
  adapters. Put instruction semantics in the core, never in an adapter.
- Instruction fetch is not a data read: the analysis bus flags it
  `MEM_EXECUTE`/`MEM_OPCODE`, and the audio bus must not let it reach reSID.
- Cycle counts are load-bearing: the analysis bus reports the per-frame cycle
  budget the exporter plans against, and the audio bus clocks the SID with them.
  Keep them in step with `opcodes.h`.
- `wasm/libsidplayfp/`, `wasm/resid/` and `wasm/exomizer/` are vendored; any
  local patch is minimal and recorded in that directory's README.
- After a change: `scripts/cpu-crosscheck/run.sh` (C++ toolchain, minutes) and
  `npm test` (the harnesses run assembled players on this core). Rebuilding
  `sidquake.wasm` needs emsdk (`scripts/build-sidquake-wasm.sh`); the `.wasm`
  and its JS glue are committed together.
