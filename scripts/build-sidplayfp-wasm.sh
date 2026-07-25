#!/bin/bash
# Build public/sidplayfp.js + public/sidplayfp.wasm - the libsidplayfp/reSIDfp
# playback engine (separate module from sidquake.wasm; playback only).
#
# Requires emcc on PATH (Emscripten SDK, or `apt install emscripten`).
# Keep the source list and flags in sync with the WASM step in 0-build.bat.
set -e
cd "$(dirname "$0")/.."

LIB=wasm/libsidplayfp/src

python3 scripts/gen-roms-header.py

em++ -O3 -std=c++17 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -Iwasm/libsidplayfp \
  -I$LIB \
  -I$LIB/sidplayfp \
  -I$LIB/builders/residfp-builder \
  -I$LIB/builders/residfp-builder/residfp \
  -I$LIB/utils \
  -DHAVE_CONFIG_H \
  wasm/sidplayfp_audio.cpp \
  $LIB/EventScheduler.cpp \
  $LIB/mixer.cpp \
  $LIB/player.cpp \
  $LIB/psiddrv.cpp \
  $LIB/reloc65.cpp \
  $LIB/sidemu.cpp \
  $LIB/c64/c64.cpp \
  $LIB/c64/mmu.cpp \
  $LIB/c64/CIA/SerialPort.cpp \
  $LIB/c64/CIA/interrupt.cpp \
  $LIB/c64/CIA/mos652x.cpp \
  $LIB/c64/CIA/timer.cpp \
  $LIB/c64/CIA/tod.cpp \
  $LIB/c64/CPU/mos6510.cpp \
  $LIB/c64/VIC_II/mos656x.cpp \
  $LIB/sidplayfp/SidConfig.cpp \
  $LIB/sidplayfp/SidInfo.cpp \
  $LIB/sidplayfp/SidTune.cpp \
  $LIB/sidplayfp/SidTuneInfo.cpp \
  $LIB/sidplayfp/sidbuilder.cpp \
  $LIB/sidplayfp/sidplayfp.cpp \
  $LIB/sidtune/MUS.cpp \
  $LIB/sidtune/PSID.cpp \
  $LIB/sidtune/SidTuneBase.cpp \
  $LIB/sidtune/SidTuneTools.cpp \
  $LIB/sidtune/p00.cpp \
  $LIB/sidtune/prg.cpp \
  $LIB/utils/MD5/MD5.cpp \
  $LIB/utils/md5Factory.cpp \
  $LIB/builders/residfp-builder/residfp-builder.cpp \
  $LIB/builders/residfp-builder/residfp-emu.cpp \
  $LIB/builders/residfp-builder/residfp/Dac.cpp \
  $LIB/builders/residfp-builder/residfp/EnvelopeGenerator.cpp \
  $LIB/builders/residfp-builder/residfp/ExternalFilter.cpp \
  $LIB/builders/residfp-builder/residfp/Filter.cpp \
  $LIB/builders/residfp-builder/residfp/Filter6581.cpp \
  $LIB/builders/residfp-builder/residfp/Filter8580.cpp \
  $LIB/builders/residfp-builder/residfp/FilterModelConfig.cpp \
  $LIB/builders/residfp-builder/residfp/FilterModelConfig6581.cpp \
  $LIB/builders/residfp-builder/residfp/FilterModelConfig8580.cpp \
  $LIB/builders/residfp-builder/residfp/Integrator6581.cpp \
  $LIB/builders/residfp-builder/residfp/Integrator8580.cpp \
  $LIB/builders/residfp-builder/residfp/OpAmp.cpp \
  $LIB/builders/residfp-builder/residfp/SID.cpp \
  $LIB/builders/residfp-builder/residfp/Spline.cpp \
  $LIB/builders/residfp-builder/residfp/WaveformCalculator.cpp \
  $LIB/builders/residfp-builder/residfp/WaveformGenerator.cpp \
  $LIB/builders/residfp-builder/residfp/version.cc \
  $LIB/builders/residfp-builder/residfp/resample/SincResampler.cpp \
  -sWASM=1 \
  -sEXPORTED_FUNCTIONS="['_audio_init','_audio_load_sid','_audio_set_subtune','_audio_generate','_audio_set_model','_audio_set_sampling_method','_audio_set_speed','_audio_get_title','_audio_get_author','_audio_get_copyright','_audio_get_subtune_count','_audio_get_default_subtune','_audio_get_sid_model','_audio_get_sid_count','_audio_get_play_time','_audio_get_is_ntsc','_audio_cleanup','_malloc','_free']" \
  -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAP8','HEAP16','HEAP32','HEAPU8','HEAPU16','HEAPU32','HEAPF32','HEAPF64']" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME="SIDPlayfpModule" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 \
  -sMAXIMUM_MEMORY=134217728 \
  -sNO_EXIT_RUNTIME=1 \
  -sENVIRONMENT="web" \
  -sSINGLE_FILE=0 \
  -o public/sidplayfp.js

ls -la public/sidplayfp.js public/sidplayfp.wasm
echo "sidplayfp WASM build OK"
