# 6510 cross-check

Differential fuzzer for the two 6510 cores in this repo:

| | source | used by |
|---|---|---|
| A | `wasm/cpu6510_wasm.cpp` | offline analysis (`sid_analyze`, shadow/baked spectrometer, `npm test`) |
| B | `wasm/sid_audio.cpp` | reSID playback engine |

Both are compiled natively against stubbed `emscripten.h` / `resid/sid.h`
headers, put into an identical randomised machine state, stepped one
instruction, then compared on PC, A, X, Y, SP, flags (N V D I Z C), cycle count
and all 64 KB of memory. Every opcode is fuzzed with a fresh random memory image
and random registers; a quarter of the cases deliberately aim the operand at the
instruction's own bytes so read-modify-write self-modification is covered, and
one case in eight runs the instruction from zero page so zero-page addressing
can alias it.

## Running

```sh
scripts/cpu-crosscheck/run.sh                # 20000 cases per opcode
scripts/cpu-crosscheck/run.sh 2000           # quicker
```

Exit status is non-zero if anything diverges. Needs only `gcc`/`g++`; it does
not touch emsdk or any committed `.wasm`.

## Comparing against a third-party core

A third core can be linked in as an outside opinion:

```sh
scripts/cpu-crosscheck/run.sh 20000 --reference /path/to/cpu.c
```

The expected interface is the one used by the `siddump` family of tools: flat
globals `pc`, `a`, `x`, `y`, `flags`, `sp`, `mem[65536]`, `cpucycles`, plus
`initcpu(pc,a,x,y)` and `runcpu()`. Such cores typically call `exit(1)` on an
opcode they do not implement, so `crosscheck.cpp` holds a `refOpcodes` list of
the ones to feed it — adjust it to match the core in use.

No third-party core is committed here.

## Known exclusions

- `BRK` (`$00`) and the `KIL` opcodes (`$x2`) are skipped: they are terminal by
  design in at least one core, so a single-step comparison says nothing useful.
- `$D400-$D7FF` is excluded from the A-vs-B memory compare. The audio core maps
  that range onto the SID chips (including the `$D420-$D7FF` mirror write-back)
  rather than treating it as RAM.
- Flag bits 4 and 5 are masked out; they have no shared meaning across
  implementations.
