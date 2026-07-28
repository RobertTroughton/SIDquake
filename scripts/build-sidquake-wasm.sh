#!/bin/bash
# Build public/sidquake.js + public/sidquake.wasm - the SID analysis/export
# module (cpu6510 + SID processor + PNG converter + legacy reSID audio).
#
# Requires emcc on PATH (Emscripten SDK, or `apt install emscripten`).
# Keep the source list and flags in sync with the WASM step in 0-build.bat.
# Built with emscripten 5.0.7. From 6.0 the generated glue drops the
# Module.wasmBinary path in getBinarySync(), which is how the `npm test`
# harnesses load the module under node - they abort with "both async and sync
# fetching of the wasm failed". Check `npm test` after changing toolchain.
set -e
cd "$(dirname "$0")/.."

emcc -O3 \
  -Iwasm \
  wasm/cpu6510_wasm.cpp \
  wasm/sid_processor.cpp \
  wasm/png_converter.cpp \
  wasm/sid_audio.cpp \
  wasm/resid/sid.cc \
  wasm/resid/voice.cc \
  wasm/resid/wave.cc \
  wasm/resid/envelope.cc \
  wasm/resid/filter8580new.cc \
  wasm/resid/extfilt.cc \
  wasm/resid/pot.cc \
  wasm/resid/dac.cc \
  wasm/resid/version.cc \
  -sWASM=1 \
  -sEXPORTED_FUNCTIONS="['_cpu_init','_cpu_load_memory','_cpu_read_memory','_cpu_write_memory','_cpu_step','_cpu_execute_function','_cpu_get_pc','_cpu_set_pc','_cpu_get_sp','_cpu_get_a','_cpu_get_x','_cpu_get_y','_cpu_get_cycles','_cpu_get_memory_access','_cpu_get_sid_writes','_cpu_get_total_sid_writes','_cpu_get_sid_chip_count','_cpu_get_sid_chip_address','_cpu_get_zp_writes','_cpu_get_total_zp_writes','_cpu_set_record_writes','_cpu_set_tracking','_cpu_get_write_sequence_length','_cpu_get_write_sequence_item','_cpu_analyze_memory','_cpu_get_last_write_pc','_sid_init','_sid_load','_sid_analyze','_sid_get_header_string','_sid_get_header_value','_sid_set_header_string','_sid_create_modified','_sid_get_modified_count','_sid_get_modified_address','_sid_get_zp_count','_sid_get_zp_address','_sid_get_code_bytes','_sid_get_data_bytes','_sid_get_sid_writes','_sid_get_sid_chip_count','_sid_get_sid_chip_address','_sid_get_clock_type','_sid_get_sid_model','_sid_cleanup','_png_converter_init','_png_converter_set_image','_png_converter_convert','_png_converter_create_c64_bitmap','_png_converter_get_background_color','_png_converter_get_bitmap_mode','_png_converter_get_color_stats','_png_converter_get_map_data','_png_converter_get_scr_data','_png_converter_get_col_data','_png_converter_set_palette','_png_converter_get_palette_count','_png_converter_get_palette_name','_png_converter_get_current_palette','_png_converter_get_palette_color','_png_converter_cleanup','_audio_init','_audio_load_sid','_audio_set_subtune','_audio_generate','_audio_set_model','_audio_set_sampling_method','_audio_get_title','_audio_get_author','_audio_get_copyright','_audio_get_subtune_count','_audio_get_default_subtune','_audio_get_sid_model','_audio_get_sid_count','_audio_get_play_time','_audio_get_is_ntsc','_audio_cleanup','_allocate_memory','_free_memory','_malloc','_free']" \
  -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAP8','HEAP16','HEAP32','HEAPU8','HEAPU16','HEAPU32','HEAPF32','HEAPF64']" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME="SIDquakeModule" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 \
  -sMAXIMUM_MEMORY=67108864 \
  -sNO_EXIT_RUNTIME=1 \
  -sENVIRONMENT="web" \
  -sSINGLE_FILE=0 \
  -o public/sidquake.js

ls -la public/sidquake.js public/sidquake.wasm
echo "sidquake WASM build OK"
