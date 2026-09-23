---
paths:
  - "public/ui.js"
  - "public/studio-modal.*"
  - "public/index.html"
  - "public/*.css"
  - "public/visualizer-*.js"
  - "public/overlay-stack.js"
  - "public/error-modal.js"
  - "public/text-drop-zone.js"
---

# App UI

Read `docs/UI.md`, and `docs/RESPONSIVE.md` before any layout or media-query
change.

- No bundler: scripts are classic scripts loaded by the loader at the bottom of
  `index.html`, plus dynamic `import()` for ES modules. A new file has to be
  added to that loader.
- Studio panels stay mounted when inactive; `prg-builder.js` reads option values
  from the DOM by id.
- Icons come from a subset font. After adding or removing an `fa-` class, run
  `scripts/build-icon-font.py` (or `--check`).
- Browser checks are Playwright scripts outside `npm test`; see
  `docs/TESTING.md` for which one covers what.
