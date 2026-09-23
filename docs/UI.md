# Application UI

The page-level controllers. Layout rules for small screens and touch are in
[`RESPONSIVE.md`](RESPONSIVE.md).

**`ui.js`** - Main application controller
- `UIController` class orchestrating the entire UI
- SID file loading (drag-drop, file picker, HVSC, random)
- Header display and metadata editing
- Visualizer grid with selection; renders option controls into Studio tabs
- Quick path (`renderQuickExport`): a row of looks and one Generate button
  outside the Studio, running the same export. Picking a look built around a
  picture opens the gallery for it, rather than exporting the player's stock
  logo. A bar look lands on the live "VU meter · Clever" bar data (see
  `SIDPlayers/BAR_HEIGHT_METHODS.md`); the spectrometer is a Studio choice.
  A tune the live methods cannot see is warned about here as well as on the
  Method panel (`renderVuNotes`)
- Song length and multi-song handling: see [`ANALYSIS.md`](ANALYSIS.md)
- PRG export workflow with progress feedback
- C64 color palette constants

**`studio-modal.js`** (+ `studio-modal.css`) - The Studio workspace
- `StudioModal`: near-fullscreen modal hosting the whole configure→export
  pipeline as tabs
- Tab rail is DERIVED from the selected visualizer's config
  (`deriveGroups()`): image inputs → own tabs, options grouped into
  Text / Style / Scroller; the set changes only on decisions (SID load,
  visualizer pick), never on data entry
- Panels stay mounted when inactive - prg-builder reads option values from
  the DOM by id
- Export tab renders a live include/skip manifest mirroring the builder's
  gates; footer carries a one-line summary + the Generate button
- Under 720px it goes fullscreen and drops the rail entirely: the footer's
  Previous/Next walk the same tab order and carry a step counter. It has to
  sit above the site header, no panel may set a width the viewport can't
  hold, and every panel must be reachable from the first one
  (`scripts/mobile-layout-check.js` guards all three)

**`visualizer-registry.js`** - Template catalog
- Static list of 9 visualizer types with name, description, preview image path
- Each references a config JSON in `public/prg/<VisualizerName>/`

**`visualizer-configs.js`** - Config loader
- `VisualizerConfig`: Fetches and caches JSON configs per visualizer
- Merges external gallery definitions
- Provides option schemas for the UI

The page is plain classic scripts loaded by the loader at the bottom of
`index.html`, plus dynamic `import()` for the ES modules. There is no bundler
and no compile step: Netlify serves `public/` as-is.

## Browser checks

Almost nothing covers the UI automatically; see [`TESTING.md`](TESTING.md) for
the Playwright scripts that do.
