#!/usr/bin/env bash
# build-players.sh - assemble every SID player and regenerate its committed
# artifacts (fixed-bank .bin files, CODE_ONLY blobs, reloc tables, graphics
# manifests). This is the player half of 0-build.bat, runnable on Linux/macOS;
# the WASM and freq-table steps stay in the .bat.
#
# Run from the repository root:
#   scripts/build-players.sh          regenerate the committed artifacts
#   scripts/build-players.sh --check  build to a temp dir and diff instead
#
# --check is the one that answers "did my source change alter any shipped
# binary?" - it leaves the working tree alone and exits non-zero on drift.
set -uo pipefail

cd "$(dirname "$0")/.."

KICKASS=KickAss.jar
OUT=public/prg
CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; OUT=$(mktemp -d); }

fail=0
note() { printf '%-46s %s\n' "$1" "$2"; }

# Assemble one fixed-bank player binary.
# bank <name> <asm> <loadAddress> <sysAddress> <dataAddress>
bank() {
    local name=$1 asm=$2 load=$3 sys=$4 data=$5
    local log; log=$(mktemp)
    if java -jar "$KICKASS" ":loadAddress=$load" ":sysAddress=$sys" ":dataAddress=$data" \
            "$asm" -binfile -o "$OUT/$name.bin" >"$log" 2>&1; then
        note "$name" "ok"
    else
        note "$name" "FAILED"; cat "$log"; fail=1
    fi
    rm -f "$log"
}

# Generate a reloc table (+ its matching blob) with one of the two generators.
# reloc <label> <script> <args...>
reloc() {
    local name=$1; shift
    local log; log=$(mktemp)
    if node "$@" >"$log" 2>&1; then
        note "$name" "ok"
    else
        note "$name" "FAILED"; cat "$log"; fail=1
    fi
    rm -f "$log"
}

echo "Building fixed-bank players..."
bank SimpleBitmapWithScroller-4000 SIDPlayers/SimpleBitmapWithScroller/SimpleBitmapWithScroller.asm 16384 20736 20480
bank SimpleRaster-4000             SIDPlayers/SimpleRaster/SimpleRaster.asm                         16384 16640 16384
bank ScrapColumns-4000             SIDPlayers/ScrapColumns/ScrapColumns.asm                         16384 16640 16384
bank SimpleBitmapWithScroller-8000 SIDPlayers/SimpleBitmapWithScroller/SimpleBitmapWithScroller.asm 32768 37120 36864
bank SimpleRaster-8000             SIDPlayers/SimpleRaster/SimpleRaster.asm                         32768 33024 32768
bank ScrapColumns-8000             SIDPlayers/ScrapColumns/ScrapColumns.asm                         32768 33024 32768
bank SimpleRaster-C000             SIDPlayers/SimpleRaster/SimpleRaster.asm                         49152 49408 49152

echo
echo "Building relocatable code blobs + reloc tables..."
CO=scripts/gen-reloc-codeonly.js
reloc Default                          $CO SIDPlayers/Default/Default.asm                                     $OUT/default.codereloc.json                          --codebin $OUT/Default-code.bin
reloc DefaultWithLogo                  $CO SIDPlayers/DefaultWithLogo/DefaultWithLogo.asm                     $OUT/defaultwithlogo.codereloc.json                  --codebin $OUT/DefaultWithLogo-code.bin
reloc MusicalBlobs                     $CO SIDPlayers/MusicalBlobs/MusicalBlobs.asm                           $OUT/musicalblobs.codereloc.json                     --codebin $OUT/MusicalBlobs-code.bin
reloc RaistlinBars                     $CO SIDPlayers/RaistlinBars/RaistlinBars.asm                           $OUT/raistlinbars.codereloc.json                     --codebin $OUT/RaistlinBars-code.bin
reloc RaistlinBarsFFT                  $CO SIDPlayers/RaistlinBars/RaistlinBars.asm                           $OUT/raistlinbarsfft.codereloc.json                  --codebin $OUT/RaistlinBarsFFT-code.bin                  -define SPECTROMETER_BAKED
reloc RaistlinBarsShadow               $CO SIDPlayers/RaistlinBars/RaistlinBars.asm                           $OUT/raistlinbarsshadow.codereloc.json               --codebin $OUT/RaistlinBarsShadow-code.bin               -define SPECTROMETER_SHADOW
reloc RaistlinBarsWithLogo             $CO SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm           $OUT/raistlinbarswithlogo.codereloc.json             --codebin $OUT/RaistlinBarsWithLogo-code.bin
reloc RaistlinBarsFFTWithLogo          $CO SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm           $OUT/raistlinbarsfftwithlogo.codereloc.json          --codebin $OUT/RaistlinBarsFFTWithLogo-code.bin          -define SPECTROMETER_BAKED
reloc RaistlinBarsWithLogoShadow       $CO SIDPlayers/RaistlinBarsWithLogo/RaistlinBarsWithLogo.asm           $OUT/raistlinbarswithlogoshadow.codereloc.json       --codebin $OUT/RaistlinBarsWithLogoShadow-code.bin       -define SPECTROMETER_SHADOW
reloc RaistlinMirrorBars               $CO SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm               $OUT/raistlinmirrorbars.codereloc.json               --codebin $OUT/RaistlinMirrorBars-code.bin
reloc RaistlinMirrorBarsFFT            $CO SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm               $OUT/raistlinmirrorbarsfft.codereloc.json            --codebin $OUT/RaistlinMirrorBarsFFT-code.bin            -define SPECTROMETER_BAKED
reloc RaistlinMirrorBarsShadow         $CO SIDPlayers/RaistlinMirrorBars/RaistlinMirrorBars.asm               $OUT/raistlinmirrorbarsshadow.codereloc.json         --codebin $OUT/RaistlinMirrorBarsShadow-code.bin         -define SPECTROMETER_SHADOW
reloc RaistlinMirrorBarsWithLogo       $CO SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm $OUT/raistlinmirrorbarswithlogo.codereloc.json     --codebin $OUT/RaistlinMirrorBarsWithLogo-code.bin
reloc RaistlinMirrorBarsFFTWithLogo    $CO SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm $OUT/raistlinmirrorbarsfftwithlogo.codereloc.json  --codebin $OUT/RaistlinMirrorBarsFFTWithLogo-code.bin    -define SPECTROMETER_BAKED
reloc RaistlinMirrorBarsWithLogoShadow $CO SIDPlayers/RaistlinMirrorBarsWithLogo/RaistlinMirrorBarsWithLogo.asm $OUT/raistlinmirrorbarswithlogoshadow.codereloc.json --codebin $OUT/RaistlinMirrorBarsWithLogoShadow-code.bin -define SPECTROMETER_SHADOW
reloc ScrapColumns                     scripts/gen-reloc-table.js SIDPlayers/ScrapColumns/ScrapColumns.asm 4000 $OUT/scrapcolumns.reloc.json
reloc SimpleRaster                     scripts/gen-reloc-table.js SIDPlayers/SimpleRaster/SimpleRaster.asm  4000 $OUT/simpleraster.reloc.json

# gen-gfx-manifest.js writes straight to public/prg, so it only runs in the
# regenerating mode - --check has nothing to compare it against.
if [ "$CHECK" = 0 ]; then
    echo
    echo "Generating graphics manifests..."
    node scripts/gen-gfx-manifest.js >/dev/null || { echo "gen-gfx-manifest FAILED"; fail=1; }
fi

if [ "$CHECK" = 1 ]; then
    echo
    echo "Comparing against the committed artifacts..."
    for f in "$OUT"/*; do
        b=$(basename "$f")
        if ! cmp -s "$f" "public/prg/$b"; then note "$b" "DIFFERS"; fail=1; fi
    done
    [ "$fail" = 0 ] && echo "All committed player artifacts match the source."
    rm -rf "$OUT"
fi

exit $fail
