#!/bin/bash
# run.sh - build the WASM engines natively with g++ and run them under a checker.
#
#   scripts/native-check/run.sh [--asan | --valgrind] [resid | sidplayfp] [A.sid B.sid ...]
#
# --asan (default) builds with AddressSanitizer + UBSan; --valgrind builds -O1 -g
# and runs memcheck with --track-origins. `resid` links sidquake.wasm's sources
# (analyser + reSID engine), `sidplayfp` the libsidplayfp engine; the tunes
# default to two from SID/. See README.md.
set -e
cd "$(dirname "$0")/../.."
mode=asan
engine=resid
tunes=()
for a in "$@"; do
    case "$a" in
        --asan) mode=asan ;;
        --valgrind) mode=valgrind ;;
        resid|sidplayfp) engine=$a ;;
        *) tunes+=("$a") ;;
    esac
done
[ ${#tunes[@]} -gt 0 ] || tunes=(SID/drax-twine.sid SID/magnar-withlove.sid)

out="${TMPDIR:-/tmp}/sidquake-native-check"
mkdir -p "$out/stub/emscripten"
echo '#define EMSCRIPTEN_KEEPALIVE' > "$out/stub/emscripten/emscripten.h"

if [ "$mode" = asan ]; then flags=(-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer); else flags=(-O1 -g); fi

if [ "$engine" = resid ]; then
    srcs=(wasm/cpu6510_wasm.cpp wasm/sid_processor.cpp wasm/sid_audio.cpp)
    for f in sid voice wave envelope filter8580new extfilt pot dac version; do srcs+=("wasm/resid/$f.cc"); done
    defs=(-DWITH_ANALYSER)
    incs=(-Iwasm)
else
    # The source list is the WASM build script's; native g++ also needs the
    # mixer the WASM link drops as unused. -D__EMSCRIPTEN__ turns on the local
    # patches (wasm/libsidplayfp/README.SIDquake.md) as the WASM build has them.
    LIB=wasm/libsidplayfp/src
    mapfile -t srcs < <(sed -n '/em++/,/-o public/p' scripts/build-sidplayfp-wasm.sh \
        | grep -o '\$LIB/[^ ]*\.cc\?p\?p\?\|wasm/[^ ]*\.cpp' | sed "s|\\\$LIB|$LIB|")
    srcs+=("$LIB/simpleMixer.cpp")
    defs=(-D__EMSCRIPTEN__ -DHAVE_CONFIG_H)
    incs=(-Iwasm -Iwasm/libsidplayfp -I$LIB -I$LIB/sidplayfp -I$LIB/builders/residfp-builder
          -I$LIB/builders/residfp-builder/residfp -I$LIB/utils)
    python3 scripts/gen-roms-header.py >/dev/null
fi

g++ -std=c++17 -w "${flags[@]}" -I"$out/stub" "${incs[@]}" "${defs[@]}" \
    "${srcs[@]}" scripts/native-check/driver.cpp -o "$out/$engine" -pthread

if [ "$mode" = valgrind ]; then
    valgrind --track-origins=yes --error-exitcode=3 "$out/$engine" "${tunes[@]}"
else
    "$out/$engine" "${tunes[@]}"
fi
