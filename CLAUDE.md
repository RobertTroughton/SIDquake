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

> Fill this in per repository. Keep it to things an agent can't work out in
> thirty seconds; put anything longer in the repo's own docs and link to it here.

**What this project is** — A Commodore 64 remaster of *Sabre Wulf* (Ultimate
Play the Game, 1984), by Genesis Project. Two code bodies: `ASM/` is the game
itself (KickAssembler 6502, ~12k lines, five separately-assembled programs
overlaid by the Sparkle loader); `CPP/` is an offline tool that converts
authored assets (PNGs, LDtk level data) into the `.bin` / `.asm` data files the
assembler then packs.

**Build**

- Asset tool: `make -C CPP` → `CPP/SabreWulfAssetGen`. Run it **from the repo
  root** (its input paths are relative to it).
- Game: `make` at the repo root — KickAssembler + SPOT + Sparkle → `.d64`.
  Windows-only as written (`.exe` paths, `del`). To assemble a single program
  on any platform: `java -jar Extras/KickAss/KickAss.jar ASM/<path>.asm -o <out>.prg`.
- **Assets are not a makefile target.** Run the asset tool before `make`, or
  `make` will silently pack whatever stale `Out/*.bin` are lying around.

**Test** — There is no automated suite. The available checks are: all five
programs assemble without error, and the asset tool regenerates the committed
generated files (`ASM/Frontend/FE_SpriteData-Generated.asm` and friends)
byte-identically. Run both before calling a change done.

**Layout**

- `ASM/Common/` — resident kernel at `$0400`, shared defines, `ZPUsage.asm`
  (the single source of truth for zero page).
- `ASM/Boot|Intro|Frontend|Game/` — the four overlay programs. Intro and
  Frontend deliberately share load address `$1800`.
- `SabreWulf.sls` — the Sparkle loader script. This is the real linker script;
  its bundle order must match the `LoadFileIndex_*` enum in `BaseCodeDefines.asm`.
- `CPP/Code/`, `CPP/Common/` — the asset tool. `CPP/ThirdParty/` is vendored.
- `docs/review/` — subsystem-by-subsystem review notes; read the relevant one
  before working in an area.

**Generated output — never edit by hand** — `Out/` (gitignored), and the
committed `*-Generated.asm` files. The `.sym` files are assembler output but are
committed because programs import each other's symbols; regenerate rather than
hand-edit them.

**Gotchas**

- The memory map at the top of `ASM/Game/SabreWulfMain.asm` is authoritative and
  kept current. Read it before moving anything.
- Zero page `$50-$5a` is main-loop-only scratch and `$5b-$60` is IRQ-time
  scratch. That split is load-bearing: putting IRQ-time state back into
  `$50-$5a` reintroduces a corruption window. See `ASM/Common/ZPUsage.asm`.
- `UpdateSingleSprite` / `UpdateSingleSpriteFlipped` are self-modifying and
  therefore not re-entrant — main loop only, never from an IRQ.
- A few constants are hand-duplicated between ASM and C++
  (`NumAnimationsPerCritter`, `MaxNumCrittersOnScreen`). Change one, change both.
- Timing is PAL-only throughout (game clock, attract timers, intro raster splits).
- `DoIntro()` shells out to `Extras/SPOT/SPOT.exe`, a Windows binary. That one
  step can't run on Linux; everything else in the tool can.
- `CPP/C64_Palettes.txt` is read at runtime relative to the **repo root**, so the
  asset tool must be run from there. Several source images deliberately carry a
  non-C64 marker colour (`#ff0044` in the LDtk screens) and will never match a
  palette; they are scanned by exact RGB, not by palette index.
