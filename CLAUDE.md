@.claude/general.md

# CLAUDE.md — C64GFX

## Agent Contract

Every rule here is a hard constraint. When in doubt, ask. State assumptions before acting on them. Partial compliance is non-compliance. This file holds rules and policy; subsystem detail lives in the repo docs it points to — keep it terse, don't grow it with procedure.

## What this project is

C64GFX (c64gfx.com) catalogs and showcases Commodore 64 pixel art. A Windows C++ tool (`CPPTool/`) scrapes CSDb, processes images, and generates a static site; Netlify functions (`netlify/functions/`) add auth/likes/voting/comments; shared C++ lives in `Common/` and `ThirdParty/`.

Pipeline (all in CPPTool): CSDb scrape → image processing → HTML generation → S3 sync → Netlify deploy. Netlify hosts the generated output plus the serverless backend. **A git push does NOT deploy** — auto-CD-on-push is off. Deploy runs `syncAndDeploy()` (`AWSSync.cpp` → S3, then `NetlifyDeploy.cpp` → `npm run deploy`, atomic) two ways: at the end of a Windows CPPTool run, or via the **manual** `Deploy live site` GitHub Actions workflow (`.github/workflows/deploy.yml`, `workflow_dispatch`, Linux runner; `confirm_production=false` default is a dry run). See `docs/deep-dive/ci-deploy.md`. **A human reviewer's bug report describes the last *deployed* live site, not your branch** — verify the symptom against the current branch before re-diagnosing; a fix you already committed is invisible to them until a deploy runs. **When told a committed fix "isn't live", verify a deploy actually *published* before re-diagnosing the code:** confirm the fix is on the ref that was built (a Windows build uses that machine's local checkout — a push/merge to `main` does not update it; a GitHub deploy builds the dispatched ref), that a deploy ran and published (Actions run for `deploy.yml`; Netlify dashboard — a queued/stuck/dry-run deploy publishes nothing), and read the live HTML with `curl` + a cache-buster (not WebFetch's 15-min cache). The homepage footer build marker (`build <UTC> (<commit>)`) names the live commit. See `docs/deep-dive/ci-deploy.md` "Stuck / queued deploys".

Key folders:
- `CPPTool/merge/HTML/` — **source of truth** for static assets (CSS/JS/images/fonts). Edit here.
- `CPPTool/html/` — generated output. Gitignored, periodically deleted. **Never edit.**
- `CPPTool/content/pages/` — static `.txt` page templates with co-located CSS/JS.
- `netlify/functions/` — Node serverless backend (+ `__tests__/` Jest suite).
- `Common/`, `ThirdParty/` — shared C++ libraries.

## Tech stack

- **CPPTool** — C++ site generator. CMake + vcpkg (deps: mongo-cxx-driver, aws-sdk-cpp[s3], openssl, libpng, libxlsxwriter, curl). Builds on Windows (VS 2022) and Linux/macOS (Ninja presets); all OS-specific code is `_WIN32`-guarded. The devcontainer provides the Linux toolchain.
- **Functions** — Node 24 serverless (`@clerk/backend`, `mongodb`, `jsonwebtoken`); tested with Jest.
- **Services** — Netlify (host), AWS S3 + CloudFront (image CDN), MongoDB Atlas (likes/votes/users), Clerk (auth), Algolia (search), Hyvor Talk (comments), Cloudinary (suggestion uploads), CSDb (source data).

## Reading code — docs first

**HARD RULE:** Before reading source for a subsystem, read its doc — for ad-hoc tasks too. The docs are self-sufficient; reading source first wastes context. Don't `find`/`grep` your way into a subsystem before reading its doc.

Top-level entry points at the repo root:
- `ARCHITECTURE.md` — scrape → process → generate → deploy pipeline and data flow.
- `TECH_STACK.md` — every service, env var, cost, and where each is configured.
- `TESTING.md` — index to the feature ↔ test map (split into per-area files under `docs/testing/`).
- `SECURITY_HARDENING.md` — auth, privacy, hardening constraints.

Per-subsystem detail lives in `docs/deep-dive/` (see its `README.md`). Routing map — code path → doc to read first:

| Touching… | Read first |
|---|---|
| `netlify/functions/` | `docs/deep-dive/netlify-functions.md` |
| `CPPTool/merge/HTML/` | `docs/deep-dive/frontend-assets.md` |
| `CPPTool/merge/HTML/charsetlab/` | `docs/deep-dive/charsetlab.md` |
| `CPPTool/merge/HTML/gfxquake/` + `content/pages/gfxquake.txt` (GFXquake — CharSet Lab plus the C64 bitmap modes, at `/gfxquake`) | `docs/deep-dive/gfxquake.md` |
| `scripts/sprite-placer-bench/` (C++/Rust/JS ports of the MONO+SPR sprite search) | `docs/deep-dive/gfxquake.md`, then that directory's `README.md` |
| `CPPTool/content/pages/` | `docs/deep-dive/page-templates.md` |
| `CPPTool/PageTabs.{h,cpp}` + `.page-tabs` in `common.css` + the `{{pagetabs}}` placeholder (shared tab strips: the gallery group, the directory group and the categories/tag group) | `docs/deep-dive/page-tabs.md` |
| `CPPTool/merge/HTML/userprofile.{txt,js,css}` (user profile page) | `docs/deep-dive/userpage.md` |
| `CPPTool/merge/HTML/image-zoom.{js,css}` (image-zoom inspector) | `docs/deep-dive/image-zoom.md`, then `docs/deep-dive/crt-emulation.md` for the CRT shader |
| `CPPTool/merge/HTML/crt-shader.js` (shared `CRT_VERT`/`CRT_FRAG`/`CRT_CONTROLS`/`CRT_FIXED`, `window.C64CRT`) + `crt-sitewide.js` (`window.C64CRTSite`) + the `c64gfx_crt` toggle in `common.js`/`userprofile.{js,css}` (opt-in, default-off site-wide CRT look) | `docs/deep-dive/crt-sitewide.md`, then `docs/deep-dive/crt-emulation.md` for the shader math |
| `CPPTool/merge/HTML/achievements.js` + achievement endpoints | `docs/deep-dive/achievements.md` |
| `CPPTool/HTML_GroupPage.cpp` + `content/pages/groups.js` (scene group pages) | `docs/deep-dive/group-pages.md` |
| `CPPTool/HTML_TaggedPage.cpp` + `Tags.{h,cpp}` + tag badges (`.img-tag` in `HTML_Generator.cpp`/`hot.js`/`featured.js`/`infiniteScroll.js`) (per-tag gallery pages `/tag/<slug>/`) | `docs/deep-dive/tag-pages.md` |
| `CPPTool/HTML_EventPage.cpp` + `HTML-Events.cpp` + `HTML_CompoRulesViewer.h` (compo/event pages `/compo/` + rules/results/qualify/public-votes viewers) | `docs/deep-dive/compo-pages.md` |
| `CPPTool/Keywords.{h,cpp}` + `content/pages/keywords.js` (keyword pages + `/keywords.html` index) | `docs/deep-dive/keywords.md` |
| `CPPTool/HTML_Generator.cpp` (Related Images grid on image pages) + `globalDirectReferencedImagesMap`/`globalRelatedImagesMap` + `CompareByLikesThenDate` (`HTML_Pages.h`) | `docs/deep-dive/related-images.md` |
| `CPPTool/merge/HTML/artist-top10.{js,css}` + `HTML_ArtistPage.cpp` (Artist's Highlights panel) | `docs/deep-dive/artist-highlights.md` |
| Avatars: the profile-header change-avatar control + Artist Page Settings (`userprofile.js`), `merge/HTML/avatar-picker.{js,css}` (shared selector modal), `merge/HTML/artist-avatar.js` + the `update-artist-avatar`/`get-artist-avatar` functions + the artist-page hero portrait (`HTML_ArtistPage.cpp`) | `docs/deep-dive/artist-avatar.md` |
| `HTML_ArtistPage.cpp` (`generateArtistsMenuHTML`) + `content/pages/artists.js` + `.list-*` rules in `common.css` (Artists list page, shared `.list-table`) | `docs/deep-dive/artists-list-page.md` |
| `CPPTool/content/pages/featured.*` + `admin-featured.*` + `HTML_Featured.cpp` + the `get-featured`/`submit-featured-vote`/`featured-schedule` functions (This Week's Feature) | `docs/deep-dive/featured-weekly.md` |
| `CPPTool/` pipeline | `ARCHITECTURE.md`, then `docs/deep-dive/generation-pipeline.md` |
| `CPPTool/C64_Palettes.txt` + `Common/PaletteLoader.*` + `Common/UpdatedPaletteManager.*` (16-colour palette catalogue) | `docs/deep-dive/palettes.md` |
| `Common/IndexedPNG.*` + `_WriteCompressedPNG` (`Common/GPImage.cpp`) + `prepareUploadHashes` (`CPPTool/AWSSync.cpp`) + `CPPTool/ManifestUploadRule.*` + `CPPTool/S3ObjectIndex.*` (how generated PNGs are encoded; changing the bytes re-uploads the corpus; how an upload is decided from the manifest when the tree has no copy) | `docs/deep-dive/image-encoding.md` |
| `CPPTool/scripts/unify_artwork.{py,bat}` (artwork-folder cleanup) | `docs/deep-dive/artwork-unify.md` |
| `CPPTool/HTML_ReleaseReport.cpp` + `merge/HTML/release-report.{js,css}` (Scraping Report; admin link in `layout.html` + `user-settings.js`) | `docs/deep-dive/release-report.md` |
| `CPPTool/CSDbGfxTypeMatch.{h,cpp}` + `CSDbTagReport.{h,cpp}` + `getGfxTypeToTag()` (`CSDbScrape_Parser.cpp`) (CSDb Tag Report: our tags vs CSDb's `GfxType`) | `docs/deep-dive/csdb-tag-report.md` |
| `CPPTool/DetailsSyncCheck.{h,cpp}` (C64GFX-Content auto-sync before build) | `docs/deep-dive/details-sync.md` |
| Schema.org JSON-LD / structured data (`vars.jsonLD`) | `docs/deep-dive/structured-data.md` |
| `CPPTool/ImageCollage.{cpp,h}` + `CollageManifest.*` (social-share collages) | `docs/deep-dive/collages.md` |
| `CPPTool/SuggestionMerge*.{h,cpp}` + `approved` status in suggestion functions (auto-merge of approved submissions) | `docs/deep-dive/suggestion-merge.md` |
| `netlify/functions/tournament-*.js` + `_tournament-*.js` + `content/pages/bestof.*` (Best of [YEAR] daily knockout) | `docs/deep-dive/bestof-tournament.md` |
| `CPPTool/HotFeed.{cpp,h}` + `hotRankedReleases()` (`HTML_Common.cpp`) + the Hot calls in `HTML_SortedPage.cpp` / `HTML_InfiniteScroll.cpp` (`hot-page1.html`, pre-baked ranking of recently-released art) | `docs/deep-dive/hot-feed.md` |
| `Database::getLikesByRecency()` + `recentlyLikedReleases()` (`HTML_Common.cpp`) (`recentlyliked-page1.html`, pre-baked gallery ordered by last-like recency) | `docs/deep-dive/liked-feed.md` |
| `CPPTool/content/pages/feed.{txt,js,css}` + `netlify/functions/get-feed.js` + `_feed-events.js` (`/feed/` community curation activity feed) | `docs/deep-dive/feed.md` |
| `CPPTool/HTML_GreatPage.cpp` (`great-page1.html`, pre-baked quality-gated gallery, shuffled once per build) | `docs/deep-dive/great-page.md` |
| `CPPTool/HTML_IndexPage.cpp` + `HomePageBlock.h` (homepage `/` blocks: Newest / Recently Added / Popular / Loading Screens / Random / Top Keywords, and the no-repeats rule) | `docs/deep-dive/homepage.md` |
| Running the stack locally / `make test` / `netlify dev` | `docs/deep-dive/local-dev.md` |
| CI deploy workflow (`.github/workflows/deploy.yml`) | `docs/deep-dive/ci-deploy.md` |
| Dev server / `CPPTool/EnvProfile.*` / `C64GFX_ENV` build profile / `merge/DevReleaseSubset.txt` | `docs/deep-dive/dev-server.md` |
| CI test workflow (`.github/workflows/tests.yml`) / adding or moving a test input | `docs/deep-dive/ci-tests.md` |
| `scripts/fetch-bug-reports.js` + `.claude/commands/fetch-bug-reports.md` (bug-report fetcher) | `docs/deep-dive/bug-report-fetch.md` |

Some deep-dive docs aren't written yet (`docs/deep-dive/README.md` tracks status). **If a task is the first to touch a subsystem with no deep-dive doc, writing that doc is part of the task.** "The code is self-explanatory" is not a substitute. **Adding a new deep-dive doc means adding a row in *two* places in the same commit: this routing table *and* the subsystem table in `docs/deep-dive/README.md`.** Half-registering it (README only, or here only) is the drift that leaves a subsystem invisible to the docs-first rule.

## Mandatory rules

### Build
Build the C++ tool **in the devcontainer** (CMake + Ninja + vcpkg): `cmake --preset linux-x64-release` then `cmake --build --preset linux-x64-release` (first configure compiles vcpkg deps from source — slow). A first-configure vcpkg "Download failed / proxy" error on a dependency tarball is usually transient — re-run the same configure before diagnosing; vcpkg resumes from its binary cache. A bare agent sandbox without that toolchain can't build C++; there, edit C++ for correctness against existing patterns instead. Keep OS-specific code behind `_WIN32` guards. Node work (functions, tests, scripts) runs anywhere.

### Environment (devcontainer)
In the devcontainer, run build/test commands inside the container, not on the host (see `.devcontainer/README.md`). If a tool, port, or package is missing, fix it in `.devcontainer/*` so the change survives a rebuild — no host-side workarounds. The container has no secrets; functions/runs needing env vars (`MONGODB_URI`, `CLERK_SECRET_KEY`, …) only work when those are supplied.

### Testing
- **`make test` is the definition of "done".** It runs Jest **and** e2e against a locally-served stack (auto-starts/stops `netlify dev`), and must be green before you call work complete. Targets: `make test` (unit + e2e local), `make test-unit` (Jest only), `make test-e2e` (e2e local only), `make test-live` (full e2e vs production, incl. specs that skip on a local target), `make dev`/`make snapshot`. See `docs/deep-dive/local-dev.md`.
- `npm test` (Jest, `netlify/functions/__tests__/`) must pass with zero warnings. E2e is `npm run test:e2e` (Playwright, `tests/e2e/`); point it at the local stack with `E2E_BASE_URL=http://localhost:8888` (what `make test-e2e` does) or at the live site.
- **Always add a test for any new feature or behavior change** — a feature without a test isn't done. Backend/function changes get a Jest regression test; user-facing behavior gets/extends an e2e spec. New e2e specs that can only pass against the live stack must gate on `LOCAL_TARGET` so `make test` stays green locally while `make test-live` covers them.
- Live-target e2e flakes (rate-limit/CDN 403/429, headless-browser crashes) are environmental, not test bugs — harden only *transient* signals (never mask a sustained wrong status) and prefer a local target over more retries. Fix genuine test-logic bugs; don't chase live-target noise.
- **Keep the CI test path-filters in sync.** `.github/workflows/tests.yml` gates each test job (`node-tests`, `charsetlab-visual`, `e2e-tests`, `e2e-preview`, the two C++ jobs) on a `dorny/paths-filter` output in the `changes` job, so a job runs only when the diff touches its code. When you **add or move a test, test input, fixture corpus, harness, or build/config input outside the subtrees an existing filter covers** — or add a new job — update the matching filter in the **same change**, or the job silently skips on exactly the PRs that should run it (a false-negative skip that lets a real break reach `main` looking green). When unsure, over-include. See `docs/deep-dive/ci-tests.md`.
- **Verify CI inputs against committed state, not the working tree.** A working-tree check (`npm ci --dry-run`, reading a file, a local build) passes on gitignored/untracked files a fresh runner checkout won't have. For any file a workflow consumes, confirm `git ls-files --error-unmatch <f>` and `git check-ignore <f>`; to simulate the runner, run the step against `git archive HEAD`. `npm ci` requires a committed lockfile — every `package-lock.json` a workflow `npm ci`s must be tracked. Note `npm ci` here *mutates* `package-lock.json` (its `postinstall` `strip-extraneous.mjs` drops an extraneous entry); that edit is unrelated to your task — `git checkout -- package-lock.json` after installing and never let it ride along in a commit. A real lockfile change must come from an intentional `package.json` edit.
- **Bugfix workflow:** identify the bug → write a regression test and confirm it fails (red) → fix → tests green. Don't flip the order, even for a one-liner.
- **`bug report:` is a non-negotiable entry point.** When the user's message contains `bug report:` (case-insensitive), whether it opens the message or introduces the request mid-sentence (e.g. "address this bug report: …"), the first thing you do is think about how to write a test that exposes the bug. Don't read other docs, propose fixes, or discuss root causes until the shape of a failing test is clear. State the intended test (what it asserts, where it lives — Jest or e2e, what the failure looks like) before any other action, then: write it, confirm it's red, fix, `make test` green.
- **Bug-report fixes always end as a PR, with `/harvest` folded in.** When the fix is green, run `/harvest` so the session's insights land in the repo docs, commit the harvest to the same branch, and open a PR — don't stop at a pushed branch and don't leave the harvest for a later session. The PR is the deliverable of a bug report.

### Code changes
- Edit static assets **only in `CPPTool/merge/HTML/`**, never in `CPPTool/html/`.
- Page CSS/JS placement: `.txt`-template pages → alongside the `.txt` in `content/pages/`, referenced via `extracss:` / `extrajs:`. C++-generated pages → `merge/HTML/`. Shared behavior/styles → `common.js` / `common.css`.
- Surgical changes only — every changed line traces to the request (see `general.md`). Don't refactor, rename, or restructure unasked. Don't add features, abstractions, or error handling for impossible cases.
- Don't remove dead or unreachable code. Leave it and add a brief comment on why it's dead (e.g. an unreachable defensive branch). Removal is only on explicit request.
- Comments: default to none. When you do comment, describe **functionality** — what the code does/represents or a non-obvious why — never the change itself. E.g. `int maxSpeed = 6; // max speed in MPH`, not `// changed from 5`. No changelog / "added for X" / commented-out code / restatement comments — remove such if found nearby. Keep copyright headers, genuine WHY comments, and anything in `ThirdParty/`.
- Don't add a dependency without stating the reason. Don't silently swallow errors.

### Design system
CSS design tokens are defined in `:root` in `merge/HTML/common.css` — use them, don't hardcode values. Icons: **Font Awesome Free 6.5.1** (`fas` solid, `fab` brands), loaded from cdnjs in `layout.html`. Confirm a glyph exists in the **Free** set before using it — a Pro-only class renders as an empty box with no error.

### UI-change PRs — before/after screenshots
When a PR changes a **visible UI element** (layout, toolbar, button, spacing, colour, an interactive widget's on-screen behaviour), include **two screenshots in the PR body: one "before" and one "after"**. Capture against the local stack (`make snapshot` + `netlify dev`, branch assets overlaid). For a *motion/reflow* change (e.g. something shifting on click), make the difference legible in static frames — stack the relevant states and/or add a reference line — don't rely on one ambiguous frame. Pure backend/logic/doc changes don't need screenshots. For a **CRT** before/after, the effect is a WebGL pass that needs `scripts/crt-screenshot.js` run headed under Xvfb — see `docs/deep-dive/local-dev.md`. When the UI is **owner-only / auth-gated** *and* there's no generated `CPPTool/html` to serve (no DB/catalog), the snapshot path can't render it — drive the real `merge/HTML/<page>.{js,css}` in a hermetic Playwright harness over stubbed `fetch`/globals (pattern: `scripts/profile-artists-modal-shots.mjs`) and commit the harness; see `docs/deep-dive/local-dev.md`. **`gh` can't upload images** — `gh pr create`/`edit` take only text, and GitHub embeds images only when dragged into the body via the web UI. So put a placeholder where the frames go, record the harness run command in the body, and hand the PNGs to the user (`SendUserFile`) to drop in; don't claim the body "carries the frames" when it holds only a placeholder.

### Don't discard reusable tooling
When you write a non-trivial helper/throwaway script — especially one encoding hard-won environment knowledge (a capture/probe/setup script) — **commit it as a reusable script** (under `scripts/` or alongside the subsystem) and document how to run it, rather than deleting it. Keep genuinely one-off scratch out of the repo, but err toward keeping anything another agent would plausibly re-run.

### Documentation
Update docs **in the same task** as the code, not as a final step. When a change affects a subsystem, update its deep-dive doc in `docs/deep-dive/` (creating it if this is the first task to touch it) plus the relevant top-level doc: pipeline → `ARCHITECTURE.md`, services/env → `TECH_STACK.md`, features/tests → the matching per-area file under `docs/testing/` (indexed by `TESTING.md`; frontend → `frontend-features.md`, backend → `backend-functions.md`, CI → `continuous-integration.md` — edit the area file, not the index), security → `SECURITY_HARDENING.md`. "When you change X, also touch Y" rules live in `TECH_STACK.md` — follow them (e.g. add/remove a paid service → also the Donate page Running Costs). Don't hardcode volatile counts ("all tests pass", not "95 tests pass"). When you change CharSet Lab (`CPPTool/merge/HTML/charsetlab/` or `content/pages/charsetlab.txt`), keep `docs/deep-dive/charsetlab-features.md` in sync: add/change a feature → add/update its row (status + test) and add a test for anything node-unit-testable before it's done; remove a feature → delete its row **and** its tests; if char counts shift, re-run `npm run test:charsetlab:update` and commit `charsetlab-baseline.json`.

### Writing style
For any user-facing copy (page text, blog, release notes), avoid AI-isms: no "not X, it is Y", no em-dash drama, no marketing adjectives ("powerful", "seamless", "revolutionary"), no generic openings, no rhetorical questions, no "excited to announce", no emoji unless asked. Write the specific claim plainly, then re-read and cut slop.

### Task planning and execution
When the user asks for a **plan** (not implementation) of a non-trivial task, follow `docs/task-planning.md` and write the plan to `docs/tasks/<slug>.md`; don't write code in the same turn. **Always commit the plan** (the task file + its `docs/tasks/status.md` entry) to the branch before handing off — don't wait to be asked; the executor picks it up from the branch. When asked to **execute** a file under `docs/tasks/`, follow `docs/task-execution.md` — that file is the source of truth for scope, steps, and verification. `docs/tasks/status.md` tracks active/complete plans. When you finish a plan, end the turn with the Phase-6 handoff prompt (`Work on docs/tasks/<slug>.md`) on its own line as the clean final deliverable — not buried in a summary or followed by trailing commentary.

### Git
**Worktree isolation:** in a git worktree, every read and write stays inside that worktree — use relative paths (cwd is already the worktree) or paths under `.claude/worktrees/<name>/…`; never write to an absolute path in the primary repo root. **This failure is silent:** Edit/Read accept a main-tree absolute path and apply there, while Bash/tests (relative paths, cwd = worktree) run against the pristine worktree copy — so the worktree `git diff` shows nothing and tests pass *without your changes*, a false green. If a diff you expect is empty, you probably edited the main tree: `git diff` it, `git checkout --` to revert, re-apply inside the worktree. **Sub-agents (Explore/general-purpose) report absolute paths rooted at the *primary* repo (`/…/C64GFX-CPP/<path>`), not the worktree** — translate each to the worktree (`.claude/worktrees/<name>/<path>`) before Write/Edit, or you silently edit the main tree.

**Start fresh, don't pick up an old worktree — unless the prompt names one.** When a task needs a worktree and the prompt **doesn't** name one, create a **new** worktree (fresh branch off `main`) as a *sibling* under the primary repo's `.claude/worktrees/<name>`; don't reuse a pre-existing worktree, and never nest one inside another (a relative `git worktree add` from inside a worktree nests it, breaking `netlify dev`'s `CPPTool/html` resolution — see `docs/deep-dive/local-dev.md`). If the session is already inside a worktree, the EnterWorktree tool refuses to create another (`name` errors with "Already in a worktree session") — create it with `git -C <primary-repo> worktree add <primary-repo>/.claude/worktrees/<name> -b <name> origin/main` (fetch first), then switch via EnterWorktree with `path`. When the prompt **does** name a worktree (the normal handoff `Work on docs/tasks/<slug>.md in the worktree <name>`), `cd` into it and continue; don't start fresh and lose its branch. Either way a worktree with no `node_modules` needs `npm ci` in the root **and** `tests/e2e`, then `npx playwright install chromium`, before `make test`.

**Check the branch base before your first edit.** A session can launch in a pre-existing worktree already on an *unrelated* branch with unrelated uncommitted changes — editing lands your fix on the wrong base. Before touching any file, run `git status`/`git branch --show-current`; if the current branch isn't the right base, `git fetch origin` and `git checkout -b <new-branch> origin/main` first.

Commit as you go: after each self-contained, working change, commit it to the current branch with a clear message — don't wait to be asked. Keep commits scoped; don't commit a knowingly-broken tree. **Push completed work to the current feature/agent branch without being asked** (it's an ephemeral container — unpushed work is lost): `git push -u origin <branch>`. **Never push to `main`, never force-push or run destructive git commands, and never open a PR unless the user explicitly asks.** Never commit secrets or gitignored config/data files. Don't let session scratch leak into a PR: `/pickup-handoff` commits the archive-move of the handoff, so before opening/handing off a feature-branch PR, `git rm` the archived handoff at the tip (an earlier commit added it, so removing it net-cancels — no history rewrite). **Never add AI-attribution trailers to commits or PR bodies** (no `Co-Authored-By: Claude…`, `Claude-Session:`, "Generated with Claude Code") — write as the human author. **To bring `main` into a task branch, `git merge origin/main` — not rebase** (even if a task file says "rebase"); rebasing an already-pushed branch rewrites shared history. Confirm before any history rewrite.

**Integration ("mega-merge") PRs:** always call such a PR a **mega-merge PR** — use that term in its title and body. To fold several open PRs into one PR that auto-closes them all when it lands, merge each branch with a real `git merge --no-ff` (**never** rebase/squash/cherry-pick — only true merge commits keep each PR's tip an ancestor of the result, which GitHub's auto-close keys on). Verify containment for every constituent: `git merge-base --is-ancestor origin/<branch> HEAD`. Merge clean branches first, plan/new-page PRs last. When you add a PR mid-flight, update **both** the PR title and body (they drift apart otherwise). Such PRs (each adds a page/endpoint) collide almost entirely as **"both-added entry" unions** — resolve keep-both, not per-file investigation — in the shared registry files: `netlify.toml` (the status-200 rewrite), `CPPTool/HTML-Templates.cpp` (the `forceAbsolutePaths` filename list), the `TECH_STACK.md` MongoDB-Atlas row, `docs/tasks/status.md`, `docs/testing/frontend-features.md`, `docs/testing/backend-functions.md`, `docs/deep-dive/page-templates.md`, and `.claude/proposed-claude-md-additions.md`.

### Keep the repo self-contained
This is a private repo shared among several people. Never let content from other local projects leak in — no other-project names, host filesystem paths, or other-project details in any committed file, doc, or commit/PR message. When adapting an idea or file from elsewhere, rewrite it in this project's own terms.

### Secrets
Secrets never enter the repo or any file you write. They live in the Netlify dashboard (functions) and the gitignored `CPPTool/config/` files (the C++ tool). If the user pastes a secret in chat, don't write it to disk and remind them to rotate it.

### Persistence
**Never write to off-repo agent memory** (`~/.claude/.../memory/` or similar) — not for project knowledge, not for user preferences. Everything worth keeping goes into the version-controlled md tree: behavioral rules and user preferences into `CLAUDE.md`, subsystem facts into the relevant doc. Mid-task rule ideas go to `.claude/proposed-claude-md-additions.md` (staging — not in force until back-ported). `/harvest`, `/handoff`, and `/claude.md-update` automate this routing.

## Never commit (all gitignored)

`CPPTool/config/secretkeys.txt`, `CPPTool/config/paths.txt`, `CPPTool/config/scrapedate.txt`, `CPPTool/csdbdata/`, `CPPTool/AllReleases.json`, `CPPTool/AWS/`, `CPPTool/html/`.

## Definition of Done

- The change works and is correct against existing patterns.
- **`make test` is green** (Jest + e2e against the local stack). This is the gate — for a Node/function change `npm test` alone isn't enough.
- The new feature or behavior change **has a test** (Jest and/or e2e); live-only e2e specs gate on `LOCAL_TARGET`.
- The relevant repo doc is updated if a subsystem, service, env var, feature, or test changed.
- No secret entered the repo. No edit landed in `CPPTool/html/`.

## Things to never do

- Edit `CPPTool/html/` or any generated output.
- Attempt heavy C++ builds in a bare sandbox without the toolchain — build in the devcontainer.
- Push to `main`, or run destructive git commands, unless explicitly asked.
- Commit secrets or the gitignored config/data files listed above.
- Store project knowledge only in off-repo agent memory.
- Put AI-attribution trailers (`Co-Authored-By: Claude…`, `Claude-Session:`, "Generated with Claude Code") in commits, PR bodies, or any content.
- Trigger a cold/full CSDb scrape — running CPPTool's scrape with an empty/unseeded `csdbdata/` cache (e.g. a CI deploy run before its cache is seeded) downloads the entire CSDb catalog and hammers a courtesy third-party source. Seed the cache first; the `C64GFX_MAX_CSDB_DOWNLOADS` cap is the backstop, not a substitute. See `docs/deep-dive/ci-deploy.md`.

## When in doubt

Ask before proceeding. Never fabricate facts — say "not confirmed" when unsure; a wrong fact is worse than a gap. Prefer doing less over doing more.


## Communication style

Assume I'm an experienced developer.

- Be concise by default.
- Use short bullet points instead of prose.
- No introductions, conclusions, praise, or filler.
- Don't restate my request.
- Don't explain obvious implementation details.
- Don't narrate your reasoning or progress.
- Report only decisions, blockers, risks, assumptions, or task completion.
- If everything succeeds, simply say so and mention anything I need to know.
- Expand only when I ask.
- Don't teach concepts I didn't ask about.

## Decision making

- When several reasonable solutions exist, recommend one.
- Don't list alternatives unless I ask.
- Optimise for developer momentum over exhaustive verification.
- Don't spend time investigating hypothetical edge cases unless there is concrete evidence they matter.

## Testing philosophy

Default to implementing first, testing second.

Unless I explicitly ask for verification:

- Don't automatically run long test suites.
- Don't wait for lengthy builds before replying.
- Run only the quickest validation that provides reasonable confidence.
- Tell me which tests you skipped.
- Tell me exactly what I should run afterwards.

If a build or test is likely to take more than about two minutes, hand the work back after implementation unless full verification was requested.

Prefer:

- compile over full test suite
- targeted tests over all tests
- linting over integration tests
- practical reasoning over waiting

## Token efficiency

Treat tokens as a limited resource.

- Minimise output while preserving correctness.
- Reuse context already gathered where practical.
- Prefer targeted investigation over broad scans.
- Stop investigating once there is sufficient evidence for a good solution.
- Don't generate reports or summaries unless requested.

## Output style

Be terse. Prefer bullets. One short sentence before a tool batch at most. State results and decisions directly.

## Documentation map

- `CLAUDE.md` — rules and guardrails (this file).
- `ARCHITECTURE.md` — scrape → process → generate → deploy pipeline and data flow.
- `TECH_STACK.md` — services, env vars, costs, config locations, "change X also touch Y".
- `TESTING.md` — index to the feature ↔ test map (split into per-area files under `docs/testing/`).
- `SECURITY_HARDENING.md` — auth, privacy, hardening constraints.
- `docs/deep-dive/` — per-subsystem structural references (see its `README.md`).
- `docs/task-planning.md`, `docs/task-execution.md` — planner / executor protocols.
- `docs/tasks/` — active task plans; `status.md` tracks them; `archive/` holds completed ones.
- `.claude/commands/` — `/handoff`, `/pickup-handoff`, `/harvest`, `/claude.md-update`, `/fetch-bug-reports`.
- `.claude/proposed-claude-md-additions.md` — staging for proposed rules (not in force until back-ported).
