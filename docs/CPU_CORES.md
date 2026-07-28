# The two 6510 cores

SIDquake emulates the 6510 twice, for two different jobs:

| | source | job |
|---|---|---|
| **analysis core** | `wasm/cpu6510_wasm.cpp` | runs init/play offline for `sid_analyze`, the spectrometer bar-data methods and `npm test`. Tracks per-address read/write/execute flags, SID and zero-page write counts, and the per-frame cycle count the exporter budgets against (`sid_get_max_cycles`). |
| **audio core** | `wasm/sid_audio.cpp` | runs init/play in real time to drive reSID. Cycle counts clock the SID chips, so they set when each register write lands within a frame. |

`wasm/sidplayfp_audio.cpp` is a third playback path but uses libsidplayfp's own
CPU, not either of these.

Both decode all 256 opcodes, including the illegals, and agree with each other
on PC, registers, flags, cycles and memory for every non-terminal opcode.

## Keeping them honest

`scripts/cpu-crosscheck/run.sh` runs four checks:

- the analysis core's hand-written cycle counts and operand sizes against
  `opcodes.h`, which the disassembler also trusts;
- the unstable `SHA`/`SHX`/`SHY`/`TAS` stores against hand-worked vectors, since
  "both cores agree" proves nothing where both were written from one reading of
  the hardware;
- both cores against each other, stepped through the same randomised machine
  states, diffing PC, registers, flags, cycles and all 64 KB of memory;
- optionally both against a third-party `cpu.c` linked in as an outside opinion.

Run it after touching either core; see `scripts/cpu-crosscheck/README.md`. It is
not part of `npm test`: it needs a C++ toolchain and takes minutes.

## What is still not modelled

- **The NMOS read-modify-write double write.** Real hardware writes the
  unmodified value back before the modified one, which is visible on I/O
  registers. Adding it would double every `INC`/`DEC`/shift on a tracked
  address in `sidWrites`, `zpWrites` and the shadow-register write sequence, so
  it needs those consumers looked at first.
- **`ARR` (`$6B`) in decimal mode.** Both cores use the binary-mode result and
  flags. The BCD variant needs a separate fixup.
- **`XAA` (`$8B`) and `LAX #imm` (`$AB`) magic constants.** Both cores use the
  common deterministic forms (`A = X & imm` and `A = X = imm`); on real hardware
  the result depends on the analogue state of the internal bus.
- **Bus conflicts and open-bus reads.** There is no I/O or VIC model here at
  all; `$D400-$D7FF` is plain RAM in the analysis core and mapped to reSID in
  the audio core.

The `SHA`/`SHX`/`SHY`/`TAS` behaviour that *is* modelled - value is
`reg & (pre-index high byte + 1)`, and a page-crossing index replaces the
target's high byte with that value - is the standard deterministic model. These
opcodes are genuinely unstable on hardware and the AND can drop out.

## Checked against an outside reference

The analysis core was fuzzed against the `cpu.c` of the `siddump` family of
tools (flat globals plus `initcpu`/`runcpu`), which implements 185 of the 256
opcodes and calls `exit(1)` on the rest. 27 opcodes diverged, in three groups,
and SIDquake is right in all three:

- **Read-modify-write flags, 24 opcodes** (`ASL`/`LSR`/`ROL`/`ROR`/`INC`/`DEC`
  in `zp`, `zp,X`, `abs`, `abs,X`). The reference builds these from macros that
  expand the operand-address expression several times, including once *after*
  the result has been stored. When the instruction modifies its own operand
  bytes - ordinary self-modifying code in a SID player - the recomputed address
  differs and N/Z come from an unrelated byte. SIDquake computes the address
  once and sets the flags from the value actually written.
- **`ANC` (`$0B`, `$2B`)**. The reference takes carry from bit 7 of the
  *immediate operand*; carry comes from bit 7 of the *result*, which is what
  SIDquake does.
- **`NOP abs` (`$0C`)**. The reference groups it with the `abs,X` NOPs and adds
  a page-crossing penalty to an instruction that is not indexed. It is a flat 4
  cycles.

Two structural differences from that reference, both deliberate here: SIDquake
executes `BRK` through the `$FFFE` vector rather than treating it as "stop"
(`cpu_execute_function` bounds runaway execution with its cycle cap and the
`pc < 2` check instead), and the reference reads `mem[0x10000]` when an absolute
operand starts at `$FFFF`, where both SIDquake cores wrap to `$0000`.

The 71 opcodes the reference does not implement - among them `LAX abs,Y`
(`$BF`), all of `SLO`/`RLA`/`SRE`/`RRA`/`DCP`/`ISC`/`SAX`, `ALR`, `ARR`, `AXS`,
`LAS` and the unstable stores - have no third opinion; they are covered by the
core-vs-core diff, the opcode-table check and the store vectors.

## Memory-access tracking

The analysis core records `MEM_READ`, `MEM_WRITE`, `MEM_EXECUTE`,
`MEM_OPCODE` and `MEM_JUMP_TARGET` per address, plus the PC of the last write.
Every read an instruction performs is recorded, including operand reads,
indirect pointer fetches and stack pulls; the only unrecorded fetches are the
instruction stream itself, which is covered by `MEM_EXECUTE`/`MEM_OPCODE`.

Consumers: `sid_processor.cpp` uses `MEM_WRITE` (modified addresses, zero-page
use) and `MEM_EXECUTE` (code/data split); `spectrometer-shadow-detect.js` uses
the whole flag byte to ask whether a page was touched at all before parking the
shadow-register buffer there.
