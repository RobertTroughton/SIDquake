# HVSC hosting and browsing

HVSC is hosted directly by the site. The raw `.sid` files live under
`public/HVSC/C64Music/...` and are served as static assets; the whole
collection tree and per-tune metadata come from a single committed index,
`public/hvsc-index.json`. There is no serverless proxy and no dependency on an
external mirror — so browsing is instant (no per-folder network calls) and the
version is whatever we ship.

**`hvsc-browser.js`** - Collection browser
- `window.hvscBrowser`: Navigate HVSC directory structure
- Builds the directory tree in-memory from `hvsc-index.json`; no network per folder
- Plays/downloads SIDs directly from `/HVSC/<path>`
- Search matches title, author, path AND folded STIL comment text
- A row single-clicks to select and preview; double-click (double-tap) opens a
  folder or takes a tune, the same as the Select button, which stays inert
  until a tune is selected
- Under 720px the modal goes fullscreen, the SID info panel moves below the
  listing and hides until it has details to show

**`hvsc-embed.html` + `hvsc-embed-config.js`** - The same browser as a widget
- One iframe page, configured entirely by its query string; the host gets
  selections over `postMessage`. Every option is documented in
  [`EMBED.md`](EMBED.md) and on the site's Embed HVSC tab
- `hvsc-embed-config.js` runs before `hvsc-browser.js` and splits the options
  three ways: behaviour onto `window.HVSC_EMBED`, chrome into `hvsc-no-*`
  classes on `<html>` that the page's own CSS acts on, and the palette into
  custom properties overriding the `:root` block in `styles.css`
- Colours are validated (hex or a keyword the browser actually knows) before
  they are set, so nothing an embedder passes reaches the page as raw CSS
- `scripts/embed-options-check.js` drives every option in a real browser

**`hvsc-random.js`** - Random SID picker
- `window.hvscRandom`: Picks a random tune from the index
- Optional `hvsc-random.json` (path prefixes) biases the pick to curated areas

**Data & tooling (not served / built ahead of time):**
- `hvsc-data/*.7z` - committed HVSC archive (the raw files aren't committed)
- `scripts/extract-hvsc.js` - extracts the archive into `public/HVSC/`
  (run locally once, and by the Netlify build via `netlify.toml`)
- `tools/build-hvsc-index.js` - reads `public/HVSC/` + `DOCUMENTS/STIL.txt`
  and writes `public/hvsc-index.json` (seconds; run after each HVSC update)

**Edge functions (`netlify/edge-functions/`):**
- `hvsc-token.js` issues a short-lived token that the browser and embed attach
  to every `.sid` fetch; `hvsc-guard.js` rejects `.sid` requests without one and
  blocks known crawler user agents. Token enforcement is off until
  `HVSC_TOKEN_SECRET` is set in the Netlify environment.
- `tune-og.js` serves per-tune share metadata from the `public/share-meta/`
  shards built by `scripts/build-share-meta.js`.

**Site build (`npm run build`):** extract the archive, then generate the
per-composer SEO pages + sitemap, the share-meta shards, the random pool
(`hvsc-random-pool.json`) and the index/STIL split
(`hvsc-index-lite.json`, `hvsc-stil.json`). All of it is derived from the
committed archive and index.

## Flow

```
User clicks Browse HVSC
  → hvsc-browser.js loads hvsc-index.json once (cached, gzipped)
  → Builds the directory tree in-memory → folder navigation is instant
  → User clicks .sid file → fetched directly from /HVSC/<path> → loaded as SID
  → Search filters the index over title/author/path/STIL client-side
```
