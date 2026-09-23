---
paths:
  - "public/prg-builder.js"
  - "public/compressor-*.js"
  - "public/tscrunch-load.js"
  - "public/lib/**"
  - "public/png-converter.js"
  - "public/image-preview-manager.js"
  - "public/logo-fit*.js"
  - "public/charsetlab-core.js"
  - "public/petscii-*.js"
  - "public/zip-writer.js"
  - "wasm/png_converter.cpp"
  - "wasm/exomizer_wrap.c"
---

# PRG export

Read `docs/EXPORT.md` first; the C64 side is `docs/PLAYERS.md`.

- `generateDataBlock()` in `prg-builder.js` and `SIDPlayers/INC/common.asm` are
  one contract: change one, change both.
- Whatever the image picker chooses must reach the hidden `<input type="file">`;
  that input is what the exporter reads (`scripts/logo-drop-check.js`).
- Player code is relocated at export time from `*-code.bin` + `*.codereloc.json`.
  Never patch either by hand; both come from one build.
- Crunching runs in `compressor-worker.js` with an in-page fallback; the two must
  produce the same bytes (`scripts/compression-check.js`).
- Tests: `scripts/test-logo-fit.js`, `test-c64-render.js`,
  `test-image-memory.js`, `test-zip-writer.js` (all in `npm test`).
