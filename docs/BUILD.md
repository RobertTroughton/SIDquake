# Building

The app JS has no compile step: Netlify serves `public/` as-is. What does get
built is committed, except the HVSC-derived site output.

| what | how | needs |
|---|---|---|
| C64 players | `scripts/build-players.sh` (Linux/macOS) or step 2 of `0-build.bat` | `java` |
| WASM | `scripts/build-sidquake-wasm.sh`, `build-sidplayfp-wasm.sh`, `build-exomizer-wasm.sh` | emsdk (`0-build.bat` hardcodes `EMSDK_PATH`) |
| Icon font | `scripts/build-icon-font.py`, after adding or removing an `fa-` class | Python with `fonttools` + `brotli`, network access to cdnjs |
| Site | `npm run build`: HVSC extract, SEO pages, share meta, random pool, index/STIL split | Node |
| HVSC index | `npm run build-hvsc-index` after an HVSC update | Node, extracted `public/HVSC/` |

`build-players.sh --check` and `build-icon-font.py --check` build to a temp
location and diff against the committed output instead of overwriting it. Use
them to answer "did my change move anything shipped?".

## Generated output (never edit by hand)

`public/icons.css` + `public/fonts/sidquake-icons.woff2`,
`public/prg/*-code.bin`, `*.codereloc.json`, `*.reloc.json`, `*.gfx.json`, the
fixed-bank `*.bin`, `public/*.wasm` and their emscripten JS glue
(`sidquake.js`, `sidplayfp.js`, `exomizer.js`), `public/hvsc-random-pool.json`
and `SIDPlayers/INC/FreqTable*.bin`. Regenerate rather than patch.

A player blob and its reloc table must come from the same build.
`build-players.sh` and `0-build.bat` always emit both; see
[`EXPORT.md`](EXPORT.md).

## Repo size

The committed HVSC archive under `hvsc-data/` dominates the repo; the extracted
`public/HVSC/` is gitignored and rebuilt by `npm run extract-hvsc`.
