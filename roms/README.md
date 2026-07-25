# C64 system ROMs (for the sidplayfp playback engine)

These are the original Commodore 64 system ROMs, required by libsidplayfp's
real-C64 environment (`public/sidplayfp.wasm`). They are embedded into the
WASM binary at build time via `wasm/roms_data.h` (regenerate with
`python scripts/gen-roms-header.py`).

| File | Contents | MD5 |
|------|----------|-----|
| `kernal.bin` | KERNAL rev. 3 (901227-03), 8 KB | `39065497630802346bce17963f13c092` |
| `basic.bin` | BASIC V2 (901226-01), 8 KB | `57af4ae21d4b705c2991d98ed5c1f7b8` |
| `chargen.bin` | Character generator (901225-01), 4 KB | `12a4202f5331d45af846af6c58fba946` |

The MD5s match libsidplayfp's own `romCheck.h` reference table ("C64 KERNAL
third revision", "C64 BASIC V2", "C64 character generator").

**Origin / licensing:** extracted from the VICE 3.10 source distribution
(`data/C64/kernal-901227-03.bin` etc., https://vice-emu.sourceforge.io/).
These ROMs are Commodore copyright (rights currently held by Cloanto) and are
**not** covered by SIDquake's own license. They are redistributed here the
same way every major C64 emulator distribution has shipped them for decades.
An alternative with cleaner licensing is the MEGA65 open-source ROM
replacements, at the cost of compatibility with a few ROM-dependent tunes.

6581 vs 8580 is the SID *chip*, selected per-tune from the PSID header — it
does not affect which system ROMs are used; this single ROM set serves all
tunes.
