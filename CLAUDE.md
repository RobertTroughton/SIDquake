# CLAUDE.md

Working agreement for agents in this repository. Every rule here is a hard
constraint. When in doubt, ask. State assumptions before acting on them.
Partial compliance is non-compliance.

This file is deliberately project-agnostic — it holds *how to work*, not *what
this project is*. Per-project facts (build commands, layout, gotchas) go in the
"Project facts" section at the bottom, and anything longer than a few lines
belongs in the repo's own docs rather than here. Keep this file terse; don't
grow it with procedure.

**This file must stay self-contained.** Don't add `@`-includes pointing at
gitignored paths (`.claude/`, local config): they resolve on the machine that
wrote them and silently vanish for everyone else.

---

## Communication style

Assume I'm an experienced developer.

- Be concise by default. Short bullets over prose.
- No introductions, conclusions, praise, or filler. Don't restate my request.
- Don't explain obvious implementation details or narrate your progress.
- Report decisions, blockers, risks, assumptions, and completion. If everything
  worked, say so and mention anything I need to know.
- Expand only when I ask. Don't teach concepts I didn't ask about.

## Decision making

- When several reasonable solutions exist, recommend one. Don't list
  alternatives unless I ask.
- Optimise for developer momentum over exhaustive verification.
- Don't investigate hypothetical edge cases without concrete evidence they matter.
- Stop investigating once there's enough evidence for a good solution.

---

## Code changes

- **Surgical changes only.** Every changed line must trace to the request.
  Don't refactor, rename, restructure, reformat, or "tidy up" unasked.
- Don't add features, abstractions, or error handling for impossible cases.
- **Don't remove dead or unreachable code.** Leave it and add a brief comment on
  why it's dead. Removal is only on explicit request.
- Match the surrounding code: its naming, idiom, comment density, and structure.
  A change should be invisible in a diff of style.
- Don't add a dependency without stating the reason. Don't silently swallow errors.
- Never weaken a check to make something pass — not tests, not types, not lint,
  not certificate verification.

### Comments

Default to none. When you do comment, describe **functionality** — what the code
does or a non-obvious *why* — never the change itself.

```
int maxSpeed = 6;   // max speed in MPH        <- yes
int maxSpeed = 6;   // changed from 5          <- no
```

No changelog comments, no "added for X", no commented-out code, no restating
what the line plainly says. Remove such comments if you find them next to code
you're already editing. Keep copyright headers, genuine WHY comments, and
anything under a vendored/third-party directory.

---

## Testing

Default to implementing first, testing second. Unless I explicitly ask for
verification:

- Don't automatically run long test suites or wait on lengthy builds.
- Run the quickest validation that gives reasonable confidence — prefer compile
  over full suite, targeted tests over all tests, lint over integration tests.
- **Tell me which tests you skipped and exactly what I should run afterwards.**
- If a build or test will take more than ~2 minutes, hand back after
  implementation rather than blocking on it.

When I *do* ask for verification, or when the change is a bugfix:

- **Bugfix order is fixed:** identify the bug → write a regression test and
  confirm it fails → fix → tests pass. Don't flip the order, even for a one-liner.
- A behaviour change without a test isn't finished.
- Report results faithfully. If tests fail, say so and show the output. If you
  skipped a step, say that. Don't hedge when something is genuinely verified.

---

## Documentation

Update docs **in the same change** as the code, not as a follow-up step. If a
change affects a subsystem that has a doc, update it. If a task is the first to
touch a subsystem with no doc, writing that doc is part of the task — "the code
is self-explanatory" is not a substitute.

Don't hardcode volatile numbers ("all tests pass", not "95 tests pass").

---

## Writing style (user-facing copy)

For anything a human reads as prose — page text, release notes, PR bodies,
commit messages: no "not X, it's Y" constructions, no em-dash drama, no
marketing adjectives ("powerful", "seamless", "revolutionary"), no generic
openings, no rhetorical questions, no "excited to announce", no emoji unless
asked. State the specific claim plainly, then re-read and cut the slop.

---

## Git

- **Commit as you go.** After each self-contained working change, commit it with
  a clear message. Don't wait to be asked. Don't commit a knowingly broken tree.
- **Push completed work to the current feature branch without being asked.**
  Sessions run in ephemeral containers; unpushed work is lost.
- **Never push to the default branch. Never force-push. Never run destructive
  git commands. Never rewrite pushed history.** Confirm before any of these.
- To bring the default branch into a feature branch, **merge** — don't rebase a
  branch that has already been pushed.
- **Never open a pull request unless I explicitly ask.**
- **Check the branch base before your first edit.** A session can start on an
  unrelated branch with unrelated uncommitted changes. Run `git status` /
  `git branch --show-current` first; if the base is wrong, branch from the
  right place before touching anything.
- **Never add AI-attribution trailers** — no `Co-Authored-By: Claude…`, no
  `Claude-Session:`, no "Generated with Claude Code" — in commits, PR bodies,
  code comments, or any other committed artifact. Write as the human author.
- Never commit secrets, credentials, or gitignored config/data files.
- Don't let session scratch (scratch files, logs, notes-to-self) into a commit.

---

## Secrets

Secrets never enter the repo or any file you write — not in code, not in docs,
not in a commit message, not in a test fixture. If I paste a secret into chat,
don't write it to disk, and remind me to rotate it.

---

## Persistence

**Never write project knowledge to off-repo agent memory** (`~/.claude/…` or
similar). Anything worth keeping goes into version control: behavioural rules
and my preferences into this file, subsystem facts into the relevant doc.

## Don't discard reusable tooling

If you write a non-trivial helper or "throwaway" script — especially one
encoding hard-won environment knowledge (a capture, probe, build, or setup
script) — commit it under `scripts/` (or alongside the subsystem) and document
how to run it. Keep genuinely one-off scratch out of the repo, but err toward
keeping anything I'd plausibly re-run.

---

## Scope and delivery

- The requested scope is the deliverable. Don't quietly narrow, widen, or
  transform it.
- Make routine judgement calls yourself. Check in only when different readings
  would lead to materially different work.
- If you hit a real problem with the task as specified, say so in a sentence or
  two, then keep going: deliver the complete work under stated assumptions.
- Finish the whole task. If part of it turns out to be blocked, finish
  everything else and say explicitly what you left out and why — scaling the
  work down is my call, not yours.
- For actions that are hard to reverse or that reach outside the repo, confirm
  first unless I've already authorised that specific kind of action.
- Prefer doing less over doing more. Never fabricate facts — say "not confirmed"
  when unsure. A wrong fact is worse than a gap.

---

## Project facts

> Keep it to things an agent can't work out in thirty seconds; put anything
> longer in the repo's own docs and link to it here.

**What this project is** — SIDquake, a browser tool for Commodore 64 SID music
(live at sidquake.c64demo.com). It plays tunes through libsidplayfp/reSIDfp,
analyses them with a 6510 emulator, links them with a visualiser into a runnable
C64 `.prg`, and browses a self-hosted HVSC. Three code bodies: `public/` is the
app (plain browser JS, **no bundler** — classic scripts loaded by the loader at
the bottom of `index.html`, plus dynamic `import()` for the ES modules);
`wasm/` is the C++ compiled to the committed `.wasm` files; `SIDPlayers/` is the
KickAssembler 6502 source for the visualiser players.

**Build**

- Players: `scripts/build-players.sh` (Linux/macOS) or step 2 of `0-build.bat`.
  `--check` builds to a temp dir and diffs against the committed artifacts
  instead of overwriting them — use it to answer "did my change move any shipped
  binary?". Needs `java` only.
- WASM: `scripts/build-*-wasm.sh`, needs emsdk. `0-build.bat` hardcodes
  `EMSDK_PATH`. The `.wasm` + their emscripten JS glue are committed.
- Icons: `scripts/build-icon-font.py`, needs Python with `fonttools` + `brotli`
  and network access to cdnjs. Run it after adding or removing an `fa-` class;
  `--check` diffs instead of overwriting. Output is committed.
- Site: `npm run build` (HVSC extract + SEO pages + share meta + random pool +
  index/STIL split). Netlify serves
  `public/` as-is; there is no compile step for the app JS.

**Test** — `npm test`. Two harnesses drive the *real assembled 6502* in the WASM
6510 emulator, covering the two places the C64 side and the exporter must agree
byte-for-byte: `scripts/test-baked-decoder.js` (baked FFT stream) and
`scripts/test-shadow-replay.js` (shadow-register replay order).
`scripts/test-timer-layout.js` also drives assembled players, calling each one's
timer routines and diffing memory to check where the play-time clock lands;
`scripts/test-logo-fit.js` covers the logo placement maths. Almost nothing
covers the browser UI — the exceptions are `scripts/mobile-layout-check.js`
(HVSC and Studio modals at phone widths) and `scripts/logo-drop-check.js`
(picking a logo lands in the input the exporter reads) and
`scripts/studio-smoke-check.js` (load a SID -> Studio -> background analysis ->
export manifest, and the sticky visualizer choice) and
`scripts/device-check.js` (a device matrix from iPhone to 2560px desktop:
horizontal scrolling, clipped content, tap target and text sizes, contrast, and
how many HVSC rows fit); none are in `npm test`, all
need Playwright, which isn't a dependency (`npm install --no-save playwright`).

Nothing in `npm test` sees a VIC-II, so the players' raster splits are covered
by two scripts that export a real `.prg` and run it in VICE
(`apt-get install -y vice xvfb`; the C64 ROMs come from `roms/`):
`scripts/seam-check.js` renders frames and checks the line below the logo's
sprite curtain holds info text rather than data fetched through the logo's
pointers, and `scripts/seam-latency.js` breaks on the split handler's `$d011`
write to report how many cycles of margin the switch has left. Both share
`scripts/lib/seam-lib.js`. Run them after touching a logo player's split.

Also run `scripts/build-players.sh
--check` after touching `SIDPlayers/`, and `scripts/cpu-crosscheck/run.sh` after
touching the 6510 decoder or either bus adapter (not in `npm test`: needs a C++
toolchain, takes minutes).

**Layout**

- `public/` — the app. `ui.js` (UI + state), `prg-builder.js` (memory layout +
  PRG assembly), `sidquake-core.js` (WASM analysis glue), `spectrometer-*.js`
  (the two offline bar-data methods), `visualizer-registry.js` + `prg/*.json`
  (what the visualiser picker offers).
- `SIDPlayers/` — one directory per visualiser, shared code in `INC/`.
  `INC/common.asm` holds the **data-block layout**, a contract with
  `prg-builder.js` `generateDataBlock()`: change one, change both.
- `scripts/` — build, codegen and test tooling. `tools/` — HVSC index + song
  length scanners.
- Docs: `docs/ARCHITECTURE.md`, `docs/EMBED.md`,
  `docs/CPU_CORES.md` (the shared 6510 decoder and its two bus adapters),
  `docs/RESPONSIVE.md` (which media query answers which question, and why the
  app asks about the pointer and the height as well as the width),
  `SIDPlayers/CODE_ONLY_GUIDE.md` (how a relocatable player is structured),
  `SIDPlayers/BAR_HEIGHT_METHODS.md` (the three bar-data methods). `TODO.md` is
  outstanding work only and is kept current.

**Generated output — never edit by hand** — `public/icons.css` +
`public/fonts/sidquake-icons.woff2`, `public/prg/*-code.bin`,
`*.codereloc.json`, `*.reloc.json`, `*.gfx.json`, the fixed-bank `*.bin`,
`public/*.wasm` and their emscripten JS glue (`sidquake.js`, `sidplayfp.js`,
`exomizer.js`), `public/hvsc-random-pool.json` and `SIDPlayers/INC/FreqTable*.bin`.
Regenerate rather than patch.

**Gotchas**

- A player blob and its reloc table **must be regenerated together**. A stale
  blob against a fresh table is patched at the wrong offsets and silently
  corrupts every export; the table carries an Adler-32 of the blob to catch it.
  `build-players.sh` and `0-build.bat` always emit both from one build.
- Exports are relocated, so a player's *code* size is not capped by the bank
  layout — only its VIC graphics must fit a 16 KB bank. See `CODE_ONLY_GUIDE.md`.
- Each bar visualiser is compiled once per bar-data method (`<none>` /
  `SPECTROMETER_SHADOW` / `SPECTROMETER_BAKED`). Touching shared `INC/` code
  changes up to three shipped blobs per player — check which with
  `build-players.sh --check`.
- Timing is PAL-only throughout, and `SetupStableRaster` writes the PAL `$DC06`
  latch unconditionally.
- The 6510 analyser counts a SID "chip" per touched `$20` slot in `$D400-$D7FF`,
  so a tune that sweeps writes across the mirror range reports up to 8 chips.
- The committed HVSC archive under `hvsc-data/` dominates the repo size; the
  extracted `public/HVSC/` is gitignored and rebuilt by `npm run extract-hvsc`.
