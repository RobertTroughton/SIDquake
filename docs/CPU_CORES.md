# The two 6510 cores

SIDquake emulates the 6510 twice, for two different jobs:

| | source | job |
|---|---|---|
| **analysis core** | `wasm/cpu6510_wasm.cpp` | runs init/play offline for `sid_analyze`, the spectrometer bar-data methods and `npm test`. Tracks per-address read/write/execute flags, SID and zero-page write counts, and the per-frame cycle count the exporter budgets against (`sid_get_max_cycles`). |
| **audio core** | `wasm/sid_audio.cpp` | runs init/play in real time to drive reSID. Cycle counts clock the SID chips, so they set when each register write lands within a frame. |

`wasm/sidplayfp_audio.cpp` is a third playback path but uses libsidplayfp's own
CPU, not either of these.

Both cores decode all 256 opcodes, including the illegals. Neither models the
NMOS read-modify-write double write (real hardware writes the unmodified value
back before the modified one), the unstable high-byte corruption that
`SHA`/`SHX`/`SHY`/`TAS` show when the index crosses a page, or bus conflicts.

## Keeping them honest

`scripts/cpu-crosscheck/run.sh` steps both cores through the same randomised
machine states and diffs PC, registers, flags, cycles and all 64 KB of memory
after every instruction. It can also link in a third-party `cpu.c` as an outside
opinion. Run it after touching either core; see
`scripts/cpu-crosscheck/README.md`.

## Known divergence: page-crossing penalties

The audio core charges a flat cycle count where the analysis core adds the
6502's +1 penalty. It affects 40 opcodes:

- indexed reads that cross a page - `abs,X` (14 opcodes), `abs,Y` (10),
  `(ind),Y` (8)
- taken branches whose target is in a different page than the instruction
  after the branch (8)

The analysis core is right; the audio core undercounts. The effect is that play
routines appear slightly shorter than they are, so reSID is clocked a little
early on the affected instructions. Nothing corrects for it downstream.

Everything else matches: across 20000 randomised cases per opcode the two cores
agree on PC, registers, flags and memory for all 254 non-terminal opcodes.
(`BRK` and the `KIL` opcodes are excluded - they are terminal by design in at
least one core, so single-stepping them proves nothing.)

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
`LAS` and the unstable stores - have only been cross-checked between SIDquake's
own two cores, which agree.

## Read tracking is incomplete

`MEM_READ` in the analysis core is set by the shared `rd()` helper, but several
opcodes still read `cpu.memory[]` directly and so record nothing: `AND`/`ORA`/
`EOR`/`BIT` and the `CMP`/`CPX`/`CPY` comparisons in `zp` and `abs`, the
zero-page `ASL`/`LSR`/`ROL`/`ROR` reads, the pointer fetches of `STA (ind,X)` /
`STA (ind),Y` / `JMP (ind)`, and stack pulls. `MEM_WRITE` and `MEM_EXECUTE`,
which is what `sid_processor.cpp` consumes, are complete.

The only consumer of `MEM_READ` is the free-page scan in
`spectrometer-shadow-detect.js`, which asks whether a page was touched at all,
so a page reached exclusively through one of those opcodes could be judged free.
Any single tracked access anywhere in the 512-byte window saves it, which is why
this has not bitten in practice.
