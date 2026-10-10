# 6510 cross-check

Correctness checks for the 6510 emulation. The decoder itself lives once, in
`wasm/cpu6510_core.h`; the two cores are bus adapters over it:

| | source | used by |
|---|---|---|
| A | `wasm/cpu6510_wasm.cpp` | offline analysis (`sid_analyze`, shadow/baked spectrometer, `npm test`) |
| B | `wasm/sid_audio.cpp` | reSID playback engine |

Everything is compiled natively against stubbed `emscripten.h` / `resid/sid.h`
headers. Four checks run:

1. **Cycle counts and operand sizes vs `opcodes.h`**, the table the disassembler
   trusts, with no page crossing or branch penalty owed.
2. **The unstable `SHA`/`SHX`/`SHY`/`TAS` stores vs hand-worked vectors**, so
   those do not rest on the implementation agreeing with itself.
3. **A against B**, stepped through identical randomised machine states and
   compared on PC, A, X, Y, SP, flags (N V D I Z C), cycle count and all 64 KB
   of memory. Since both now share a decoder this no longer proves the
   instruction set is right - it proves the two *bus adapters* agree wherever
   they should, which catches a mis-bound register or a tracking hook with a
   side effect.
4. **A against an optional third-party `cpu.c`**, which is the only check that
   is genuinely independent of this repo's reading of the hardware.

Every opcode is fuzzed with a fresh random memory image and random registers; a
quarter of the cases deliberately aim the operand at the instruction's own bytes
so read-modify-write self-modification is covered, and one case in eight runs
the instruction from zero page so zero-page addressing can alias it.

## Running

```sh
scripts/cpu-crosscheck/run.sh                # 20000 cases per opcode
scripts/cpu-crosscheck/run.sh 2000           # quicker
```

Exit status is non-zero if anything diverges. Needs only `gcc`/`g++`; it does
not touch emsdk or any committed `.wasm`.

## Instruction-level tests (Harte, Klaus Dormann)

`singlestep.sh` checks the decoder alone, on a flat 64 KB RAM bus, against two
outside references:

- **Tom Harte's [SingleStepTests 65x02](https://github.com/SingleStepTests/65x02)**
  `6502/v1`: 10,000 cases per opcode, each an initial and final machine state
  plus every bus cycle of a real NMOS 6502. Each case is checked on PC, A, X,
  Y, SP, P, the RAM it lists, the cycle count, and the sequence of bus writes
  (address and value, in order). Bus reads are not compared, since the core
  does not make the 6502's dummy reads.
- **Klaus Dormann's [`6502_functional_test.bin`](https://github.com/Klaus2m5/6502_65C02_functional_tests)**,
  run from `$0400` until it traps; `$3469` is success.

```sh
scripts/cpu-crosscheck/singlestep.sh             # all 256 opcode files
scripts/cpu-crosscheck/singlestep.sh --sample 20 # 20 random opcode files
```

The test data is downloaded on first use into `$SIDQUAKE_CPU_TESTS` (default
`${TMPDIR:-/tmp}/sidquake-cpu-tests`) and reused after that. It is never
committed: Klaus's test is GPL-3, and Harte's suite is about 1.1 GB. A full
download takes seconds on a fast link and the run itself under ten. Needs
`curl` and `g++`. CI runs it in full.

Exclusions live in `singlestep.cpp` (`skipOpcode`), each with the reason, and
are limited to behaviour the core does not model. P bit 4 is masked: it is not
a register bit, only the copy `BRK`/`PHP` push, and every push in the repo sets
or clears it explicitly.

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
