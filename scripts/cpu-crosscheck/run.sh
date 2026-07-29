#!/usr/bin/env bash
# Build and run the 6510 cross-check. See README.md.
#
#   ./run.sh [iterations] [--reference /path/to/cpu.c]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wasm="$here/../../wasm"
out="${TMPDIR:-/tmp}/sidquake-cpu-crosscheck"

iterations=20000
reference=""
while [ $# -gt 0 ]; do
    case "$1" in
        --reference) reference="$2"; shift 2 ;;
        *) iterations="$1"; shift ;;
    esac
done

# The WASM sources use quoted includes ("resid/sid.h", "opcodes.h"), which
# resolve against the including file's own directory before any -I path. Build
# from a staging dir holding the sources next to the stub headers so the stubs
# win instead of the real reSID tree.
rm -rf "$out"
mkdir -p "$out"
cp -r "$here/stubs/." "$out/"
cp "$wasm/sid_audio.cpp" "$wasm/cpu6510_wasm.cpp" "$wasm/cpu6510_core.h" "$wasm/opcodes.h" "$out/"
cp "$here/shim_audio.cpp" "$here/crosscheck.cpp" "$out/"

cxxflags=(-O2 -w -I"$out")
objs=()

if [ -n "$reference" ]; then
    [ -f "$reference" ] || { echo "reference core not found: $reference" >&2; exit 2; }
    gcc -O2 -w -c "$reference" -o "$out/reference.o"
    objs+=("$out/reference.o")
    cxxflags+=(-DWITH_REFERENCE)
fi

g++ "${cxxflags[@]}" -c "$out/shim_audio.cpp" -o "$out/shim_audio.o"
objs+=("$out/shim_audio.o")
g++ "${cxxflags[@]}" -c "$out/crosscheck.cpp" -o "$out/crosscheck.o"
g++ "$out/crosscheck.o" "${objs[@]}" -o "$out/crosscheck"

exec "$out/crosscheck" "$iterations"
