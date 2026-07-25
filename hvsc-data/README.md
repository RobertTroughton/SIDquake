# HVSC archive

Drop the High Voltage SID Collection archive here as a single `.7z` (or `.zip`)
whose top-level folder is `C64Music/`. This archive **is** committed (the raw
~61k `.sid` files are not); the build extracts it into `public/HVSC/`.

A version-suffixed name like `C64Music-85.7z` keeps it obvious which update is
shipped, but the filename is not load-bearing: `scripts/extract-hvsc.js` picks
up any `.7z`/`.zip` here, and the authoritative version number lives in
`public/hvsc-index.json` (`--version` at index-build time), which drives the
"HVSC #NN" badge in the browser.

## Workflow after an HVSC update

```
# 1. Replace the archive in this folder with the new one.
# 2. Unpack it locally:
npm run extract-hvsc -- --force        # -> public/HVSC/C64Music/... (gitignored)
# 3. Rebuild the search index (reads public/HVSC + DOCUMENTS/STIL.txt):
npm run build-hvsc-index -- --version 85   # -> public/hvsc-index.json
# 4. Commit the new archive + public/hvsc-index.json.
```

The `--version` number is recorded in the index and shown as an "HVSC #NN"
badge in the browser (so both you and visitors can see the mirror is current).
If you omit `--version`, the builder tries to read it from
`DOCUMENTS/HVSC.txt`, but passing it explicitly is the reliable option.

On Netlify, `scripts/extract-hvsc.js` runs during the build (see `netlify.toml`)
to unpack this archive into the publish directory, so the raw SIDs are served
from `/HVSC/...`.
