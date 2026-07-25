@echo off
setlocal enabledelayedexpansion

echo ========================================
echo SIDquake Build Script
echo ========================================
echo.

REM --- Step 1: Generate Frequency Table ---
echo [1/3] Generating Frequency Table...
python.exe FreqTableGen.py || goto :error
echo.

REM --- Step 2: Build SID Players for Web ---
REM Players with a CODE_ONLY reloc blob ship no bank .bin at all: runtime code
REM comes from the *-code.bin blobs generated in the relocation step below, and
REM the VIC assets come from public\prg\*.gfx.json manifests distilled from a
REM temp GFX_DONOR build by gen-gfx-manifest.js (also below). Only the
REM fixed-bank players still build committed bank binaries here.
echo [2/3] Building SID Players for Web...
echo.


java -jar .\KickAss.jar :loadAddress=16384 :sysAddress=20736 :dataAddress=20480 .\SIDPlayers\SimpleBitmapWithScroller\SimpleBitmapWithScroller.asm -showmem -binfile -o public\prg\SimpleBitmapWithScroller-4000.bin || goto :error
java -jar .\KickAss.jar :loadAddress=16384 :sysAddress=16640 :dataAddress=16384 .\SIDPlayers\SimpleRaster\SimpleRaster.asm -showmem -binfile -o public\prg\SimpleRaster-4000.bin || goto :error
java -jar .\KickAss.jar :loadAddress=16384 :sysAddress=16640 :dataAddress=16384 .\SIDPlayers\ScrapColumns\ScrapColumns.asm -showmem -binfile -o public\prg\ScrapColumns-4000.bin || goto :error

java -jar .\KickAss.jar :loadAddress=32768 :sysAddress=37120 :dataAddress=36864 .\SIDPlayers\SimpleBitmapWithScroller\SimpleBitmapWithScroller.asm -showmem -binfile -o public\prg\SimpleBitmapWithScroller-8000.bin || goto :error
java -jar .\KickAss.jar :loadAddress=32768 :sysAddress=33024 :dataAddress=32768 .\SIDPlayers\SimpleRaster\SimpleRaster.asm -showmem -binfile -o public\prg\SimpleRaster-8000.bin || goto :error
java -jar .\KickAss.jar :loadAddress=32768 :sysAddress=33024 :dataAddress=32768 .\SIDPlayers\ScrapColumns\ScrapColumns.asm -showmem -binfile -o public\prg\ScrapColumns-8000.bin || goto :error

java -jar .\KickAss.jar :loadAddress=49152 :sysAddress=49408 :dataAddress=49152 .\SIDPlayers\SimpleRaster\SimpleRaster.asm -showmem -binfile -o public\prg\SimpleRaster-C000.bin || goto :error

REM === Relocatable code blobs + reloc tables ==================================
REM Each gen-reloc-codeonly call emits the reloc table AND, via --codebin, the
REM matching CODE_ONLY blob (relocCodeBase) from the SAME build - so the two can
REM never drift out of sync. A stale blob against a fresh table silently corrupts
REM the relocated code in every export, so ALWAYS regenerate them together here.
REM ScrapColumns and SimpleRaster instead relocate the full binary via a diff
REM table (gen-reloc-table.js); it is diffed from the SAME source these .bin files
REM are built from, so it too MUST be regenerated every build or its stale offsets
REM patch live opcodes and crash the relocated export on load.
REM
REM :reloc (defined at the end of this file) prints one clean line per player. The
REM tools' verbose report is captured to a temp log and only shown if a step fails.
echo Testing relocation tables...
call :reloc "Default"                          scripts\gen-reloc-codeonly.js .\SIDPlayers\Default\Default.asm public\prg\default.codereloc.json --codebin public\prg\Default-code.bin
call :reloc "DefaultWithLogo"                  scripts\gen-reloc-codeonly.js .\SIDPlayers\DefaultWithLogo\DefaultWithLogo.asm public\prg\defaultwithlogo.codereloc.json --codebin public\prg\DefaultWithLogo-code.bin
call :reloc "MusicalBlobs"                     scripts\gen-reloc-codeonly.js .\SIDPlayers\MusicalBlobs\MusicalBlobs.asm public\prg\musicalblobs.codereloc.json --codebin public\prg\MusicalBlobs-code.bin
call :reloc "RaistlinBars"                     scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinBars\RaistlinBars.asm public\prg\raistlinbars.codereloc.json --codebin public\prg\RaistlinBars-code.bin
call :reloc "RaistlinBarsFFT"                  scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinBars\RaistlinBars.asm public\prg\raistlinbarsfft.codereloc.json --codebin public\prg\RaistlinBarsFFT-code.bin -define SPECTROMETER_BAKED
call :reloc "RaistlinBarsShadow"               scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinBars\RaistlinBars.asm public\prg\raistlinbarsshadow.codereloc.json --codebin public\prg\RaistlinBarsShadow-code.bin -define SPECTROMETER_SHADOW
call :reloc "RaistlinBarsWithLogo"             scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinBarsWithLogo\RaistlinBarsWithLogo.asm public\prg\raistlinbarswithlogo.codereloc.json --codebin public\prg\RaistlinBarsWithLogo-code.bin
call :reloc "RaistlinBarsFFTWithLogo"          scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinBarsWithLogo\RaistlinBarsWithLogo.asm public\prg\raistlinbarsfftwithlogo.codereloc.json --codebin public\prg\RaistlinBarsFFTWithLogo-code.bin -define SPECTROMETER_BAKED
call :reloc "RaistlinBarsWithLogoShadow"       scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinBarsWithLogo\RaistlinBarsWithLogo.asm public\prg\raistlinbarswithlogoshadow.codereloc.json --codebin public\prg\RaistlinBarsWithLogoShadow-code.bin -define SPECTROMETER_SHADOW
call :reloc "RaistlinMirrorBars"               scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinMirrorBars\RaistlinMirrorBars.asm public\prg\raistlinmirrorbars.codereloc.json --codebin public\prg\RaistlinMirrorBars-code.bin
call :reloc "RaistlinMirrorBarsFFT"            scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinMirrorBars\RaistlinMirrorBars.asm public\prg\raistlinmirrorbarsfft.codereloc.json --codebin public\prg\RaistlinMirrorBarsFFT-code.bin -define SPECTROMETER_BAKED
call :reloc "RaistlinMirrorBarsShadow"         scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinMirrorBars\RaistlinMirrorBars.asm public\prg\raistlinmirrorbarsshadow.codereloc.json --codebin public\prg\RaistlinMirrorBarsShadow-code.bin -define SPECTROMETER_SHADOW
call :reloc "RaistlinMirrorBarsWithLogo"       scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinMirrorBarsWithLogo\RaistlinMirrorBarsWithLogo.asm public\prg\raistlinmirrorbarswithlogo.codereloc.json --codebin public\prg\RaistlinMirrorBarsWithLogo-code.bin
call :reloc "RaistlinMirrorBarsFFTWithLogo"    scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinMirrorBarsWithLogo\RaistlinMirrorBarsWithLogo.asm public\prg\raistlinmirrorbarsfftwithlogo.codereloc.json --codebin public\prg\RaistlinMirrorBarsFFTWithLogo-code.bin -define SPECTROMETER_BAKED
call :reloc "RaistlinMirrorBarsWithLogoShadow" scripts\gen-reloc-codeonly.js .\SIDPlayers\RaistlinMirrorBarsWithLogo\RaistlinMirrorBarsWithLogo.asm public\prg\raistlinmirrorbarswithlogoshadow.codereloc.json --codebin public\prg\RaistlinMirrorBarsWithLogoShadow-code.bin -define SPECTROMETER_SHADOW
call :reloc "ScrapColumns"                     scripts\gen-reloc-table.js .\SIDPlayers\ScrapColumns\ScrapColumns.asm 4000 public\prg\scrapcolumns.reloc.json
call :reloc "SimpleRaster"                     scripts\gen-reloc-table.js .\SIDPlayers\SimpleRaster\SimpleRaster.asm 4000 public\prg\simpleraster.reloc.json

REM === Graphics manifests =====================================================
REM Assembles each code-only player's GFX_DONOR image to a temp file and distils
REM it into public\prg\*.gfx.json (the exporter composes the graphics blob from
REM these; no bank .bins are committed for the code-only players). Round-trips
REM and cross-checks itself - a failure here means the manifests, configs and
REM ASM have drifted apart.
echo Generating graphics manifests...
node scripts\gen-gfx-manifest.js || goto :error

echo.
echo SID Players built successfully.
echo.

REM --- Step 3: WASM Build ---
echo [3/3] Building WASM modules...
echo.

REM Set up Emscripten environment
REM Adjust this path to where you installed emsdk
set EMSDK_PATH=D:\git\emsdk

if not exist "%EMSDK_PATH%" (
    echo ERROR: EMSDK not found at %EMSDK_PATH%
    echo Please install Emscripten or update EMSDK_PATH in this script.
    echo Skipping WASM build.
    goto :done
)

REM Check output directory
if not exist "public" (
    echo Creating public directory...
    mkdir public
)

REM Activate Emscripten environment
echo Activating Emscripten environment...
call "%EMSDK_PATH%\emsdk_env.bat"

echo.
echo Compiling WASM module (cpu6510 + SID processor + PNG converter + reSID audio)...
echo.

pushd wasm
call emcc cpu6510_wasm.cpp sid_processor.cpp png_converter.cpp sid_audio.cpp ^
    resid\sid.cc resid\voice.cc resid\wave.cc resid\envelope.cc ^
    resid\filter8580new.cc resid\extfilt.cc ^
    resid\pot.cc resid\dac.cc resid\version.cc ^
    -I. ^
    -O3 ^
    -s WASM=1 ^
    -s EXPORTED_FUNCTIONS="['_cpu_init','_cpu_load_memory','_cpu_read_memory','_cpu_write_memory','_cpu_step','_cpu_execute_function','_cpu_get_pc','_cpu_set_pc','_cpu_get_sp','_cpu_get_a','_cpu_get_x','_cpu_get_y','_cpu_get_cycles','_cpu_get_memory_access','_cpu_get_sid_writes','_cpu_get_total_sid_writes','_cpu_get_sid_chip_count','_cpu_get_sid_chip_address','_cpu_get_zp_writes','_cpu_get_total_zp_writes','_cpu_set_record_writes','_cpu_set_tracking','_cpu_get_write_sequence_length','_cpu_get_write_sequence_item','_cpu_analyze_memory','_cpu_get_last_write_pc','_sid_init','_sid_load','_sid_analyze','_sid_get_header_string','_sid_get_header_value','_sid_set_header_string','_sid_create_modified','_sid_get_modified_count','_sid_get_modified_address','_sid_get_zp_count','_sid_get_zp_address','_sid_get_code_bytes','_sid_get_data_bytes','_sid_get_sid_writes','_sid_get_sid_chip_count','_sid_get_sid_chip_address','_sid_get_clock_type','_sid_get_sid_model','_sid_cleanup','_png_converter_init','_png_converter_set_image','_png_converter_convert','_png_converter_create_c64_bitmap','_png_converter_get_background_color','_png_converter_get_bitmap_mode','_png_converter_get_color_stats','_png_converter_get_map_data','_png_converter_get_scr_data','_png_converter_get_col_data','_png_converter_set_palette','_png_converter_get_palette_count','_png_converter_get_palette_name','_png_converter_get_current_palette','_png_converter_get_palette_color','_png_converter_cleanup','_audio_init','_audio_load_sid','_audio_set_subtune','_audio_generate','_audio_set_model','_audio_set_sampling_method','_audio_get_title','_audio_get_author','_audio_get_copyright','_audio_get_subtune_count','_audio_get_default_subtune','_audio_get_sid_model','_audio_get_sid_count','_audio_get_play_time','_audio_get_is_ntsc','_audio_cleanup','_allocate_memory','_free_memory','_malloc','_free']" ^
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAP8','HEAP16','HEAP32','HEAPU8','HEAPU16','HEAPU32','HEAPF32','HEAPF64']" ^
    -s MODULARIZE=1 ^
    -s EXPORT_NAME="SIDquakeModule" ^
    -s ALLOW_MEMORY_GROWTH=1 ^
    -s INITIAL_MEMORY=33554432 ^
    -s MAXIMUM_MEMORY=67108864 ^
    -s NO_EXIT_RUNTIME=1 ^
    -s ENVIRONMENT="web" ^
    -s SINGLE_FILE=0 ^
    -o "..\public\sidquake.js"
popd

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo WASM build FAILED! See errors above.
    goto :error
)

echo.
echo Compiling sidplayfp WASM module (libsidplayfp + reSIDfp playback engine)...
echo.

REM Regenerate the embedded C64 ROMs header from roms/*.bin
python scripts\gen-roms-header.py
if %ERRORLEVEL% NEQ 0 (
    echo ROM header generation FAILED!
    goto :error
)

REM Keep sources and flags in sync with scripts/build-sidplayfp-wasm.sh
set LIBFP=wasm\libsidplayfp\src
call em++ -O3 -std=c++17 ^
    -sDISABLE_EXCEPTION_CATCHING=0 ^
    -Iwasm\libsidplayfp ^
    -I%LIBFP% ^
    -I%LIBFP%\sidplayfp ^
    -I%LIBFP%\builders\residfp-builder ^
    -I%LIBFP%\builders\residfp-builder\residfp ^
    -I%LIBFP%\utils ^
    -DHAVE_CONFIG_H ^
    wasm\sidplayfp_audio.cpp ^
    %LIBFP%\EventScheduler.cpp ^
    %LIBFP%\mixer.cpp ^
    %LIBFP%\player.cpp ^
    %LIBFP%\psiddrv.cpp ^
    %LIBFP%\reloc65.cpp ^
    %LIBFP%\sidemu.cpp ^
    %LIBFP%\c64\c64.cpp ^
    %LIBFP%\c64\mmu.cpp ^
    %LIBFP%\c64\CIA\SerialPort.cpp ^
    %LIBFP%\c64\CIA\interrupt.cpp ^
    %LIBFP%\c64\CIA\mos652x.cpp ^
    %LIBFP%\c64\CIA\timer.cpp ^
    %LIBFP%\c64\CIA\tod.cpp ^
    %LIBFP%\c64\CPU\mos6510.cpp ^
    %LIBFP%\c64\VIC_II\mos656x.cpp ^
    %LIBFP%\sidplayfp\SidConfig.cpp ^
    %LIBFP%\sidplayfp\SidInfo.cpp ^
    %LIBFP%\sidplayfp\SidTune.cpp ^
    %LIBFP%\sidplayfp\SidTuneInfo.cpp ^
    %LIBFP%\sidplayfp\sidbuilder.cpp ^
    %LIBFP%\sidplayfp\sidplayfp.cpp ^
    %LIBFP%\sidtune\MUS.cpp ^
    %LIBFP%\sidtune\PSID.cpp ^
    %LIBFP%\sidtune\SidTuneBase.cpp ^
    %LIBFP%\sidtune\SidTuneTools.cpp ^
    %LIBFP%\sidtune\p00.cpp ^
    %LIBFP%\sidtune\prg.cpp ^
    %LIBFP%\utils\MD5\MD5.cpp ^
    %LIBFP%\utils\md5Factory.cpp ^
    %LIBFP%\builders\residfp-builder\residfp-builder.cpp ^
    %LIBFP%\builders\residfp-builder\residfp-emu.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Dac.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\EnvelopeGenerator.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\ExternalFilter.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Filter.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Filter6581.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Filter8580.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\FilterModelConfig.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\FilterModelConfig6581.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\FilterModelConfig8580.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Integrator6581.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Integrator8580.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\OpAmp.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\SID.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\Spline.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\WaveformCalculator.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\WaveformGenerator.cpp ^
    %LIBFP%\builders\residfp-builder\residfp\version.cc ^
    %LIBFP%\builders\residfp-builder\residfp\resample\SincResampler.cpp ^
    -s WASM=1 ^
    -s EXPORTED_FUNCTIONS="['_audio_init','_audio_load_sid','_audio_set_subtune','_audio_generate','_audio_set_model','_audio_set_sampling_method','_audio_set_speed','_audio_get_title','_audio_get_author','_audio_get_copyright','_audio_get_subtune_count','_audio_get_default_subtune','_audio_get_sid_model','_audio_get_sid_count','_audio_get_play_time','_audio_get_is_ntsc','_audio_cleanup','_malloc','_free']" ^
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAP8','HEAP16','HEAP32','HEAPU8','HEAPU16','HEAPU32','HEAPF32','HEAPF64']" ^
    -s MODULARIZE=1 ^
    -s EXPORT_NAME="SIDPlayfpModule" ^
    -s ALLOW_MEMORY_GROWTH=1 ^
    -s INITIAL_MEMORY=33554432 ^
    -s MAXIMUM_MEMORY=134217728 ^
    -s NO_EXIT_RUNTIME=1 ^
    -s ENVIRONMENT="web" ^
    -s SINGLE_FILE=0 ^
    -o "public\sidplayfp.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo sidplayfp WASM build FAILED! See errors above.
    goto :error
)

echo.
echo WASM modules built successfully:
echo   - public\sidquake.js
echo   - public\sidquake.wasm
echo   - public\sidplayfp.js
echo   - public\sidplayfp.wasm
echo.

:done
echo.
echo ========================================
echo Build complete!
echo ========================================
echo.
pause
exit /b 0

:error
echo.
echo ========================================
echo Build FAILED! See errors above.
echo ========================================
echo.
pause
exit /b 1

REM --- :reloc <display-name> <node-script> <args...> --------------------------
REM Prints "  Relocation testing <name>... DONE" on one line. The relocation
REM tool's verbose report (and the KickAss it spawns) is redirected to a temp log
REM so the build stays quiet; on failure the line ends in FAILED and the log is
REM dumped before aborting. Handles up to 7 args after the name (enough for the
REM code-only calls with -define, and the whole-binary table calls).
:reloc
<nul set /p "=  Relocation testing %~1... "
node %2 %3 %4 %5 %6 %7 %8 %9 >"%TEMP%\sidquake-reloc.log" 2>&1
if errorlevel 1 (
    echo FAILED
    type "%TEMP%\sidquake-reloc.log"
    goto :error
)
echo DONE
goto :eof
