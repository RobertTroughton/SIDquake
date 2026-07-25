# Vendored libsidplayfp (for the SIDquake playback engine)

This directory contains a pruned copy of **libsidplayfp 2.16.1** (which bundles
**reSIDfp**), used to build `public/sidplayfp.wasm` — the accurate in-browser
SID playback engine (full C64 environment: cycle-exact 6510, CIA, VIC-II,
KERNAL/BASIC ROMs, reSIDfp SID emulation).

- Upstream: https://github.com/libsidplayfp/libsidplayfp
- Release tarball: https://sourceforge.net/projects/sidplay-residfp/files/libsidplayfp/2.16/libsidplayfp-2.16.1.tar.gz
- License: **GPL v2 or later** (see `COPYING`). Same obligation as the reSID
  library already shipped in `sidquake.wasm`: corresponding source is public
  in this repository.

## What was pruned

Hardware-SID builders and file-based utilities that make no sense in WASM:

- `src/builders/resid-builder/` (we use reSIDfp, not classic reSID)
- `src/builders/exsid-builder/`, `hardsid-builder/`, `usbsid-builder/`
- `src/utils/STILview/`, `src/utils/SidDatabase.*`, `src/utils/iniParser.*`
- autotools build system (`configure`, `Makefile.am`, ...)

## Local modifications (marked with `__EMSCRIPTEN__` guards)

1. `src/builders/residfp-builder/residfp/FilterModelConfig6581.cpp` and
   `FilterModelConfig8580.cpp`: the filter-table precomputation upstream runs
   on `std::thread`s; Emscripten here is single-threaded (no pthreads, so we
   don't require SharedArrayBuffer/COOP/COEP headers on the site), so the same
   lambdas run sequentially under `#ifdef __EMSCRIPTEN__`.

## Generated headers (hand-maintained, normally produced by autotools)

- `config.h` — hand-written Emscripten config (no HardSID/exSID/USBSID, no
  pthread, no libgcrypt; C++17).
- `src/sidplayfp/sidversion.h` — version constants for 2.16.1.
- `src/builders/residfp-builder/residfp/siddefs-fp.h` — reSIDfp compile config
  (branch hints + inlining on, version string 2.16.1).

When updating to a newer upstream release, re-apply the thread patch and
regenerate/refresh these three headers.
