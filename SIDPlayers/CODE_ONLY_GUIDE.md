# Writing a relocatable visualizer (the CODE_ONLY model)

This guide explains how a SIDquake visualizer is structured so the exporter can
place its **code** on any free CPU page and its **graphics** in any free VIC bank,
independently. It's what lets a player pack tightly around an arbitrary SID + the
baked-FFT data, and it's what freed RaistlinBarsWithLogo's code from the bitmap
ceiling so it could finally carry a timer.

## The core idea

A player is built as two independent pieces:

- **Code blob** — the 6502 code plus every table the *CPU* reads (bar-height maps,
  sine tables, colour lookups, ADSR rates, …). Relocatable to **any `$xx00` page**.
- **Graphics blob** — only what the *VIC* fetches: bitmap, screen matrix, charset,
  sprites. Locked to a **16 KB VIC bank**.

The two are assembled together for the classic build, but a `CODE_ONLY` build emits
just the code blob (the graphics are `#if !CODE_ONLY`-guarded away). The exporter
takes the CODE_ONLY blob for code and a normal build's VIC region for graphics,
and places them separately.

**The one rule that matters:** only things the VIC reads belong in the bank.
Everything the CPU reads should live in the code blob. A table in the bank "because
there was spare room there" is legacy, not necessity.

## Anatomy of a player `.asm`

### 1. Decouple the graphics bank from the load address

```asm
#if CODE_ONLY
.var GFX_BANK = cmdLineVars.containsKey("gfxBank") ? cmdLineVars.get("gfxBank").asNumber() : 1
#else
.var GFX_BANK = floor(LOAD_ADDRESS / $4000)
#endif
.var VIC_BANK         = GFX_BANK
.var VIC_BANK_ADDRESS = VIC_BANK * $4000
```

The classic build derives the bank from the load address (output unchanged). A
CODE_ONLY build pins it explicitly and accepts a `:gfxBank=` override so the reloc
tooling can shift the graphics bank independently of the code page.

### 2. Guard the VIC assets behind `#if !CODE_ONLY`

```asm
#if !CODE_ONLY
* = CHARSET_ADDRESS "Font"
    .fill min($700, file_charsetData.getSize()), file_charsetData.get(i)
* = SCREEN0_ADDRESS "Screen 0"
    .fill $400, $00
* = BITMAP_ADDRESS "Bitmap"
    .fill LOGO_HEIGHT * 40 * 8, $00
#endif // !CODE_ONLY
```

Everything the VIC fetches — charset, bar chars, screens, sprites, bitmap — goes
here. The exporter synthesises/places these from the PNGs, palettes and static
maps, so the CODE_ONLY blob doesn't need them.

### 3. Give the code labels for anything it references in the guarded block

If the code reads a table that lives in the graphics region, keep
its **address** available even when its bytes aren't emitted:

```asm
.label heightToColor  = COLOR_TABLE_ADDRESS       // CPU-read lookup, injected palette
.label attackRateLo   = COLOR_TABLE_ADDRESS + COLOR_TABLE_SIZE
```

These become **gfx-refs** — patched to wherever the exporter parks the bank. (A
`.const` address like `LOGO_COLOR_STAGING` already works as-is; you only need
`.label` for things that were defined *inside* a now-guarded segment.)

> **Ideal:** these CPU-read tables belong in the code blob, not the bank — then
> they're code-refs and free that bank space entirely. The Raistlin players keep a
> couple (`heightColorTable`, ADSR rates) in the bank as a documented simplification;
> new players should prefer putting CPU tables in the main code region.

## Building + the relocation table

```
# code blob (any base; the exporter relocates it)
KickAss :loadAddress=4096 :sysAddress=4352 :dataAddress=4096 :gfxBank=1 \
        -define CODE_ONLY  Player.asm -binfile -o Player-code.bin

# two-diff relocation table (self-verifies byte-for-byte)
node scripts/gen-reloc-codeonly.js Player.asm public/prg/player.codereloc.json
```

`gen-reloc-codeonly.js` builds the CODE_ONLY blob three times and diffs:

- **code-page shift** (`$1000` vs `$1100`) → `codeRefs` (high byte +1)
- **graphics-bank shift** (`gfxBank 1` vs `2`) → `gfxRefs` (high byte +$40)

with VIC-bank config bytes (`$DD00`, the bank number) falling out as anomalies.
Because code and graphics are separated, each pointer set is **exact** — no
bank-half heuristic. It then relocates the blob to arbitrary `(page, bank)` targets
and checks it reproduces a direct KickAss build byte-for-byte. If it prints
`RELOCATABLE (verified byte-for-byte)`, the table is complete.

## Config (`public/prg/<player>.json`)

```jsonc
"relocatable":    true,
"gfxManifest":    "prg/player.gfx.json",        // graphics source (gen-gfx-manifest.js)
"relocCodeBase":  "prg/Player-code.bin",        // the CODE_ONLY blob
"relocCodeTable": "prg/player.codereloc.json",  // the two-diff table
"relocBaseLayout":"bank4000"
```

Two markers in the `bank4000` layout let the exporter split correctly:

- **`graphicsBase`** — address of the lowest VIC asset (where the graphics blob
  begins). Defaults to `colorTableAddress` for players that keep the colour table
  as their lowest asset.
- **`relocSplit`** — the code/graphics boundary for the address transform. For a
  logo player whose **bitmap sits below the colour table**, set this to the bitmap
  address (e.g. `0x6000`) so the bitmap + logo inputs classify as graphics, not
  code. Defaults to `graphicsBase`.

Presence of `relocCodeBase` is what switches the exporter onto the code-only path
(`planRelocationCodeOnly`); without it, it uses the classic full-`.bin` split.
Untouched players are byte-for-byte unaffected.

## Gotchas

- **Keep the classic build valid + byte-identical** while converting: the normal
  build is the graphics source, so it must still assemble and its VIC region must
  match what's committed. (A player whose code has grown past the bitmap — e.g. a
  timer added under `#if CODE_ONLY` — is the exception: its graphics come from a
  build where that code is guarded out.)
- **No baked address pointers in the graphics blob.** The bar family's VIC assets
  are raw data (sprite pointers/screen matrix are written at runtime), so the
  graphics blob needs no patching. If a player bakes absolute pointers into its
  graphics, they'd need their own gfx-ref handling.
- **`relocSplit` vs `graphicsBase`** differ only when something graphics-y (a
  bitmap, injected logo screen/colour) sits *below* the graphics blob's start.

## Not every player fits

- **SimpleRaster** is graphics-free (all code) — it relocates to any page as-is.
- **ScrapColumns** bakes address-dependent column/sprite data — not cleanly
  relocatable without source changes.
- The plain **Default/Bitmap** players are intentionally fixed-bank.
