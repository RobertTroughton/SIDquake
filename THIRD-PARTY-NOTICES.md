# Third-party notices

SIDquake incorporates the third-party components listed below. Two of them —
**libsidplayfp** and **reSID/reSIDfp** — are licensed under the GNU General
Public License v2 (or later) and are compiled into WebAssembly binaries that are
served to every visitor. Distributing those binaries is distribution under the
GPL, so:

- The SIDquake WebAssembly audio engine and the C++ sources under `wasm/` that
  are linked into it are licensed **GPL v2-or-later** (see [`LICENSE`](LICENSE)).
- The corresponding source for the GPL components is published in this
  repository (`wasm/libsidplayfp/`, `wasm/resid/`) together with the exact build
  recipes (`0-build.bat`, `scripts/build-sidplayfp-wasm.sh`,
  `scripts/build-sidquake-wasm.sh`).
- The surrounding vanilla-JavaScript UI (`public/*.js`, HTML, CSS) communicates
  with the WASM modules across a runtime `cwrap`/`ccall` boundary (aggregation),
  and is © Robert Troughton.

## Components shipped to the browser

| Component | Version | License | Copyright | Source |
|-----------|---------|---------|-----------|--------|
| libsidplayfp | 2.16.1 | GPL v2-or-later | Simon White, Antti Lankila, Leandro Nini and contributors | https://github.com/libsidplayfp/libsidplayfp |
| reSIDfp (bundled in libsidplayfp) | — | GPL v2-or-later | Dag Lem; reSIDfp fork by Antti Lankila, ported by Leandro Nini | https://github.com/libsidplayfp/libsidplayfp |
| reSID (classic; legacy `?engine=resid` path) | 0.16 | GPL v2-or-later | Dag Lem | https://github.com/daglem/reSID |
| TSCrunch (JavaScript port) | — | Apache-2.0 (upstream); port credits Antonio Savona | Original algorithm © Antonio Savona | https://github.com/tonysavon/TSCrunch |
| Exomizer | 3.1.3b0 (hg/git ba91318) | zlib | Magnus Lind | https://bitbucket.org/magli143/exomizer |
| C64 KERNAL / BASIC / CHARGEN ROMs | VICE 3.10 | Proprietary (Commodore; rights held by Cloanto) — **not** covered by SIDquake's licence | Commodore International / Cloanto | see `roms/README.md` |
| High Voltage SID Collection (SID tunes) | HVSC #85 | Free redistribution under the HVSC terms; individual tunes © their composers | HVSC Crew and composers | https://hvsc.c64.org/ (bundled `DOCUMENTS/HVSC.txt`) |

## Build-time only (not shipped to the browser)

| Component | License | Notes |
|-----------|---------|-------|
| KickAssembler (`KickAss.jar`) | Proprietary freeware © Mads Nielsen | Assembles the C64 player `.bin` files; the jar is not served to users. |
| Emscripten | MIT / University of Illinois NCSA | Compiles the C++ sources to WebAssembly. |
| pngjs | MIT | Dev dependency (asset tooling). |
| 7zip-bin | MIT (wraps 7-Zip binaries) | Extracts the HVSC archive at build time. |

## Notes

- **C64 ROMs.** `roms/basic.bin`, `roms/kernal.bin` and `roms/chargen.bin`
  (embedded via `wasm/roms_data.h` into `sidplayfp.wasm`) are proprietary
  Commodore ROMs whose rights are held by Cloanto. They are redistributed here
  without a licence covering them; see `roms/README.md` for the provenance and
  the open-source MEGA65 ROM alternative.
- **TSCrunch.** The upstream TSCrunch by Antonio Savona is Apache-2.0. The
  JavaScript port shipped in `public/lib/` credits the original author; retain
  that attribution.

- **Exomizer.** The C sources under `wasm/exomizer/` are upstream Exomizer 3,
  vendored verbatim except for `src/optimal.c`, which is marked as altered in
  its own header (a hard-coded table size was made a compile-time macro so the
  WebAssembly build does not have to reserve 68 MB of static data; the default
  is the upstream value). The zlib licence requires that the origin is not
  misrepresented, that altered sources are plainly marked, and that the notices
  in each file are left intact - see `wasm/exomizer/README.md`.
