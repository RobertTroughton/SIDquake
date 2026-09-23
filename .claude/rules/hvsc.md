---
paths:
  - "public/hvsc-*"
  - "netlify/**"
  - "tools/**"
  - "scripts/extract-hvsc.js"
  - "scripts/build-seo-pages.js"
  - "scripts/build-share-meta.js"
  - "scripts/build-random-pool.js"
  - "scripts/build-index-split.js"
---

# HVSC hosting and embed

Read `docs/HVSC.md`, and `docs/EMBED.md` for the widget's options.

- The share-meta shard hash exists in three runtimes (edge function, build
  script, browser); `scripts/test-share-shards.js` checks they agree. Change all
  three together.
- Every embed option must be documented in `docs/EMBED.md` and reach the widget
  (`scripts/embed-options-check.js`).
- `public/HVSC/`, `public/music/`, `public/share-meta/`, the sitemap and the
  lite index/STIL split are derived and gitignored; don't commit them.
