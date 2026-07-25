# Exomizer (vendored)

Upstream Exomizer 3 by Magnus Lind, used by the PRG exporter as the
"smaller file" compression option alongside TSCrunch.

| | |
|---|---|
| Source | https://bitbucket.org/magli143/exomizer |
| Version | 3.1.3b0 |
| Commit | `ba91318e02bc0f69e437379a84348d416c4a19aa` |
| Licence | zlib (see the header of any source file) |

The licence permits redistribution and alteration, provided the origin is not
misrepresented, altered sources are plainly marked, and the notice is left in
each file. This directory complies with all three.

## What is here

`src/` is upstream's `src/` directory, minus the build system (kept for
reference as `src/Makefile.upstream`), plus one generated file:

- **`src/sfxdecr.c`** is *generated* upstream by crunching `src/sfxdecr.s` with
  a freshly built native `exoraw`. It is committed here so the WebAssembly build
  is a single `emcc` invocation and needs no native bootstrap pass. Regenerate it
  by running `make` in a checkout of the upstream tree and copying the result.
- `src/asm.tab.c` and `src/lex.yy.c` are bison/flex output that upstream commits,
  so no parser generator is needed to build.

`../exomizer_wrap.c` (outside this directory, since it is *ours*, not upstream's)
is the WebAssembly entry point. It drives exomizer's unmodified `main()` over
MEMFS rather than forking the tool.

## Local modifications

**`src/optimal.c` is altered** and says so in a comment at the top of the file.
The optimal parser's statistics tables were declared as a hard-coded 1,000,000
entries - 68 MB of static data, which a WebAssembly module must reserve up front
on every instantiation. The bound is now the macro `EXO_OPTIMAL_STATS_SIZE`,
**defaulting to the upstream 1,000,000**, and three sites that referenced the
size numerically (two bounds checks in `optimize1()` and the suffix-sum loop in
`optimal_optimize()`) now use the macro.

`scripts/build-exomizer-wasm.sh` overrides it to 65536, which is safe because the
tables are indexed by match offset and match length, both capped at 65535 by
exomizer's own `-m` / `-M` defaults (which the wrapper never overrides).

Everything else is byte-for-byte upstream.

## Verifying a build

Two checks, both of which were run when this was added:

1. Building these sources natively with the macro at its default produces
   output byte-identical to unmodified upstream exomizer.
2. The WebAssembly module built with `EXO_OPTIMAL_STATS_SIZE=65536` produces
   output byte-identical to native exomizer, and the result decrunches back to
   the original image under `exomizer desfx`.

## Building

```
./scripts/build-exomizer-wasm.sh      # needs emcc on PATH
```

Emits `public/exomizer.js` + `public/exomizer.wasm`, loaded on demand by
`public/compressor-manager.js`.
