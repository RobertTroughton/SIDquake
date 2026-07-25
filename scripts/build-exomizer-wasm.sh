#!/bin/bash
# Build public/exomizer.js + public/exomizer.wasm - the Exomizer 3 cruncher,
# used by the PRG exporter as the "best ratio" compression option alongside
# TSCrunch.
#
# The C sources under wasm/exomizer/ are upstream Exomizer, vendored verbatim
# (see wasm/exomizer/README.md). Only wasm/exomizer_wrap.c is ours: it drives
# exomizer's own main() over MEMFS so we never have to fork the tool.
#
# Requires emcc on PATH (Emscripten SDK, or `apt install emscripten`).
# Keep the source list in sync with EXO_OBJS + SHARED_OBJS in
# wasm/exomizer/src/Makefile.upstream.
set -e
cd "$(dirname "$0")/.."

SRC=wasm/exomizer/src

emcc -O3 \
  -D_XOPEN_SOURCE=600 \
  -DEXO_OPTIMAL_STATS_SIZE=65536 \
  -I$SRC \
  wasm/exomizer_wrap.c \
  $SRC/exo_main.c \
  $SRC/exo_helper.c \
  $SRC/exo_util.c \
  $SRC/exodec.c \
  $SRC/match.c \
  $SRC/search.c \
  $SRC/optimal.c \
  $SRC/output.c \
  $SRC/buf.c \
  $SRC/buf_io.c \
  $SRC/chunkpool.c \
  $SRC/radix.c \
  $SRC/progress.c \
  $SRC/getflag.c \
  $SRC/log.c \
  $SRC/vec.c \
  $SRC/map.c \
  $SRC/named_buffer.c \
  $SRC/parse.c \
  $SRC/expr.c \
  $SRC/pc.c \
  $SRC/table.c \
  $SRC/perf.c \
  $SRC/desfx.c \
  $SRC/areatrace.c \
  $SRC/6502emu.c \
  $SRC/asm.tab.c \
  $SRC/lex.yy.c \
  $SRC/sfxdecr.c \
  -o public/exomizer.js \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=ExomizerModule \
  -sINVOKE_RUN=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS="['_exo_compress_sfx','_exo_output_ptr','_exo_output_len','_exo_free','_malloc','_free']" \
  -sEXPORTED_RUNTIME_METHODS="['cwrap','HEAPU8']"

echo "Built public/exomizer.js + public/exomizer.wasm"
ls -l public/exomizer.js public/exomizer.wasm
