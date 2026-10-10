#!/usr/bin/env bash
# Run the 6510 decoder against Tom Harte's SingleStepTests and Klaus Dormann's
# functional test. See README.md.
#
#   ./singlestep.sh [--sample N]
#
# The test data is downloaded on first use into $SIDQUAKE_CPU_TESTS (default
# ${TMPDIR:-/tmp}/sidquake-cpu-tests) and reused after that. It is never
# committed: Klaus's test is GPL-3, and Harte's suite is about 1.1 GB.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wasm="$here/../../wasm"
cache="${SIDQUAKE_CPU_TESTS:-${TMPDIR:-/tmp}/sidquake-cpu-tests}"
out="${TMPDIR:-/tmp}/sidquake-cpu-singlestep"

harteUrl="https://raw.githubusercontent.com/SingleStepTests/65x02/main/6502/v1"
klausUrl="https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin"

sample=0
while [ $# -gt 0 ]; do
    case "$1" in
        --sample) sample="$2"; shift 2 ;;
        *) echo "usage: $0 [--sample N]" >&2; exit 2 ;;
    esac
done

ops=$(for i in $(seq 0 255); do printf '%02x\n' "$i"; done)
if [ "$sample" -gt 0 ]; then
    ops=$(printf '%s\n' "$ops" | shuf -n "$sample" | sort)
    echo "sampling opcodes: $(echo $ops)"
fi

mkdir -p "$cache/harte"
# A download goes to a temporary name first, so an interrupted run never
# leaves a truncated file that a later run would trust.
fetch() { curl -sSfL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }
export -f fetch
printf '%s\n' "$ops" | while read -r op; do
    [ -s "$cache/harte/$op.json" ] || echo "$op"
done | xargs -r -P 16 -I{} bash -c 'fetch "$0/{}.json" "$1/harte/{}.json"' "$harteUrl" "$cache"
[ -s "$cache/6502_functional_test.bin" ] || fetch "$klausUrl" "$cache/6502_functional_test.bin"

mkdir -p "$out"
g++ -O2 -std=c++17 -I"$wasm" "$here/singlestep.cpp" -o "$out/singlestep"

status=0
"$out/singlestep" --klaus "$cache/6502_functional_test.bin" || status=1
# shellcheck disable=SC2046
"$out/singlestep" --harte "$cache/harte" $(printf '%s.json ' $ops) || status=1
exit $status
