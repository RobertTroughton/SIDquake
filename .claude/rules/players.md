---
paths:
  - "SIDPlayers/**"
  - "public/prg/**"
  - "scripts/build-players.sh"
  - "scripts/gen-*.js"
  - "scripts/verify-reloc.js"
  - "scripts/seam-*.js"
  - "scripts/lib/seam-lib.js"
  - "scripts/make-test-logo.js"
---

# C64 players

Read `docs/PLAYERS.md`, then `SIDPlayers/CODE_ONLY_GUIDE.md` for player
structure and `SIDPlayers/BAR_HEIGHT_METHODS.md` for bar data.

- `public/prg/` is generated. Rebuild with `scripts/build-players.sh` (needs
  `java`), which emits each blob together with its reloc table.
- After touching `SIDPlayers/`: `scripts/build-players.sh --check` to see which
  shipped binaries moved. Shared `INC/` code can move up to three per bar player.
- `INC/common.asm` data-block layout is a contract with `prg-builder.js`
  `generateDataBlock()`.
- After touching a logo player's raster split: `scripts/seam-check.js` and
  `scripts/seam-latency.js` in VICE, with a logo from `scripts/make-test-logo.js`
  (see `docs/TESTING.md`).
- PAL only; `SetupStableRaster` writes the PAL `$DC06` latch unconditionally.
