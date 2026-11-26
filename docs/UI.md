# Application UI

The page-level controllers. Layout rules for small screens and touch are in
[`RESPONSIVE.md`](RESPONSIVE.md).

**`ui.js`** - Main application controller
- `UIController` class orchestrating the entire UI
- SID file loading (drag-drop, file picker, HVSC)
  (`processFile`): the file is parsed first, and only an accepted one switches
  the page, player and scan over to it; a rejected file leaves the previous
  tune loaded
- Header display and metadata editing
- Visualizer grid with selection; renders option controls into Studio tabs
- The landing card's only route to an export is "Open the Studio"; a tune the
  live bar methods cannot see is warned about on the Method panel
  (`renderVuNotes`)
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
  gates; footer carries a one-line summary + the Generate button. Generate is
  never disabled by the background scan. While it runs, a popup floating
  just above Generate shows it (`studioLength`, out of the footer's flow so it
  shifts nothing: busy, with "Wait to include the song length." under it,
  then a pulse and "Song length calculated: M:SS", held
  2.5 s and faded out), because the page's corner chip sits under the Studio;
  the manifest says a
  live-method export leaves the song length and forced loop out (and that the
  Spectrometer waits); see [`ANALYSIS.md`](ANALYSIS.md)
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
