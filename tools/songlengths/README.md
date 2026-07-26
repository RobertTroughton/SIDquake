# Song length scanner

Measures every tune in HVSC with SIDquake's own loop detector and compares the
results against HVSC's published `DOCUMENTS/Songlengths.md5`.

Two commands: **scan** (the hours-long part) then **report** (seconds).

```
node tools\songlengths\scan.mjs --limit 20      # trial run on 20 songs
node tools\songlengths\report.mjs               # build the three outputs
```

Then open `tools\songlengths\out\songlengths-report.html`.

Once the trial looks right, drop `--limit` and let it run. **Stopping and
restarting is expected and safe** — see [Resuming](#resuming).

---

## What it produces

Everything lands in `tools/songlengths/out/`.

| File | What it is |
|---|---|
| `Songlengths.ours.md5` | HVSC's file byte-for-byte, except the times we disagree with by more than `--threshold` (default 1 s). Comments, ordering and CRLF line endings are all preserved, so `diff` against the original shows exactly what changed and nothing else. |
| `Songlengths.frames.txt` | Our measurements with raster-frame counts as well as times: intro length, loop period, total length, and PAL/NTSC. Format is documented in the file's own header. |
| `songlengths-report.html` | Sortable, filterable table of every subtune. Click a column to sort, click the class chips to filter, type to search paths. |

Entries we could not measure confidently — the scan budget ran out, the tune
failed to render, no loop or ending was found — are **never** written into
`Songlengths.ours.md5`. They still appear in the report so you can see them.

## How a length is defined

HVSC counts a tune's whole playing time: a 20 s intro followed by a 30 s loop is
50 s. We measure the same way — `lengthFrames` is from the start to the point the
music repeats, i.e. intro **plus one loop**, not just the loop. Tunes that end
rather than repeat are measured to where the music stops.

Frame counts are the raster frame, which is what a SID player actually counts:
PAL 50.1245 Hz, NTSC 59.826 Hz. A tune's loop period is always a whole number of
frames, so the frame figure is the exact one and the `M:SS.mmm` time is derived
from it.

## Result classes

| Class | Meaning |
|---|---|
| `match` | within 1 s of HVSC |
| `close` | within 5 s |
| `half` / `double` | our length is about half or double HVSC's — usually means one of us locked onto a harmonic rather than the true period. **The most interesting rows in the report.** |
| `off` | within 30 s |
| `wild` | further out than that |
| `noloop` | neither a repeat nor an ending was found |
| `capped` | ran out of scan budget; the number is a lower bound, not a measurement |
| `nohvsc` | HVSC has no parseable time for this subtune |
| `error` | the tune failed to render |

## Resuming

Every result is appended to `out/results-<n>.jsonl` the instant it lands. An
interrupted run loses at most the few songs that were mid-flight.

To carry on, **run the exact same command again** — finished songs are skipped.
Nothing is ever rewritten in place, so a power cut cannot corrupt the journal; a
half-written final line is detected and dropped on the next read. Ctrl-C is a
supported way to stop.

`out/progress.log` gets a heartbeat every 5 minutes, so an unattended overnight
run leaves a record of how it went.

Use `--redo` to throw the journal away and start over.

## Options

### scan.mjs

| Option | Default | |
|---|---|---|
| `--md5 <file>` | `<hvsc>/DOCUMENTS/Songlengths.md5` | source list |
| `--hvsc <dir>` | `public/HVSC/C64Music` | folder holding `DEMOS/`, `MUSICIANS/`, … |
| `--out <dir>` | `tools/songlengths/out` | journal + outputs |
| `--jobs <n>` | CPU count − 1 | worker threads |
| `--engine <name>` | `resid` | `resid` (fast) or `fp` (libsidplayfp) |
| `--limit <n>` | all | measure at most n songs **this session** — already-finished songs don't count towards it, so re-running with `--limit 20` does the *next* 20 |
| `--shuffle` | off | sample across the whole collection instead of taking the first n — pair with `--limit` for a representative trial |
| `--redo` | off | ignore the existing journal |
| `--min-loop <s>` | 2 | shortest repeat counted as a loop |
| `--budget-mult <x>` | 2.5 | **first** attempt scans HVSC's length × this, plus 15 s |
| `--max-budget <s>` | 900 | ceiling for any single scan |
| `--no-escalate` | off | don't retry a capped scan at the ceiling |
| `--only <classes>` | — | re-measure entries **already in the journal** whose class is in this comma-separated list, e.g. `--only capped,error` |
| `--budget <s>` | `--max-budget` | fixed scan window for an `--only` pass |
| `--exclude-rsid` | off | drop RSID tunes (they are measured by default) |
| `--include-basic` | off | keep C64-BASIC tunes (excluded by default) |

### report.mjs

| Option | Default | |
|---|---|---|
| `--out <dir>` | `tools/songlengths/out` | where the journal is |
| `--md5 <file>` | from `run-meta.json` | source list |
| `--threshold <s>` | 1.0 | how far apart before we rewrite an entry |

## Using HVSC's own numbers to help us

HVSC's length is a **hint, not a ceiling**. It drives the scan in three stages:

1. **First attempt** scans `--budget-mult` × HVSC's length + 15 s. Confirming a
   loop needs a bit over two passes of it, so 2.5× is enough for a tune whose
   published length is about right — and it avoids burning 15 minutes on every
   tune that never repeats.
2. **Automatic escalation.** If that attempt runs out without resolving anything,
   it is retried once at `--max-budget`. Their list is hand-curated and can be
   short, and some tunes simply have a longer period than what was timed. (The
   retry re-renders from the start, which is why it's one big jump rather than
   several small steps.)
3. **Manual recheck**, for whatever still hasn't resolved:

   ```
   node tools\songlengths\scan.mjs --only capped --budget 1800
   ```

   This re-measures only the `capped` rows from the journal at a 30-minute window.
   Results are appended; the newest line for a subtune wins, so just re-run
   `report.mjs` afterwards. Repeat with a bigger budget as far as you care to.

This works. On a deliberately starved test (60 s budget) all six tunes capped;
rechecking at 240 s resolved three of them — two found real loops, one found its
ending — and the automatic escalation produced identical numbers to the manual
two-pass.

## What gets excluded, and what doesn't

**C64-BASIC tunes are skipped by default.** The tune *is* a BASIC program started
by `RUN`, so nothing ever drives the SID from our side and it measures as nothing.
Detected from RSID flags bit 1, not the filename — the flag catches 589 of the 590
files HVSC names `*_BASIC.sid`, so it is the reliable test. `--include-basic` keeps
them.

**Plain RSID tunes are measured.** They render perfectly well through libsidplayfp
despite SIDquake's own *analyser* rejecting the format, so excluding them would
throw away ~3,300 tunes for nothing. The report has a **Format** column (sortable)
so you can see at a glance whether RSID entries behave differently as a group.
`--exclude-rsid` drops them if you decide they aren't comparable.

The filter runs **before** `--limit`, so `--limit 100` measures 100 real tunes
rather than 100 candidates minus whatever got dropped.

## Can we match HVSC exactly?

Partly, and it's worth being clear about where the ceiling is.

Where a tune has a **clean repeat**, there is a right answer and both lists should
find it — expect `match`/`close`, and treat anything else as worth investigating
on one side or the other.

Where a tune **fades or just stops**, there is no algorithmic answer. HVSC's value
is a human decision about where a listener should stop hearing it, made by ear
over many years. We measure where the signal drops below a silence threshold.
Those two things are both defensible and will systematically differ — usually with
ours slightly longer, because a quiet tail is still above our floor after a person
would have called it done. That's a difference in definition, not an error in
either list, and it's why `Songlengths.ours.md5` only rewrites entries we actually
resolved.

So: expect strong agreement on looping tunes, and a persistent spread on fade-outs.
The `noloop`/`capped` classes keep the two apart in the report.

### On frames vs times

Worth defending HVSC slightly here: the same tune runs at 50.1245 Hz on PAL and
59.826 Hz on NTSC, so a bare frame count is ambiguous unless you also record which
clock it was measured on — and their list has to serve players on hardware, PC and
mobile across both. A time value is portable in a way a frame count isn't.

`Songlengths.frames.txt` records the video standard per tune alongside the frame
count, which is what makes the frame figure unambiguous. That's the part their
format is missing, rather than the frame count itself being the obvious choice.

## How long will it take, and how do I make it quicker

The SID render is ~90% of the work, so runtime is roughly *(seconds of audio
rendered) ÷ (engine speed) ÷ (cores)*.

Two things dominate:

- **`--engine resid`** (the default here) renders about 2.1× faster than
  libsidplayfp. It is *not* the default in the app, because it bakes different
  bars on roughly a quarter of tunes and cannot play some at all — but for
  measuring lengths in bulk that trade is worth making, and tunes it renders
  silent are detected and re-scanned on libsidplayfp automatically. Watch the
  `fp-rescue` counter: if it is high, `--engine fp` throughout may be no slower.
- **`--budget-mult`** decides how much audio gets rendered per tune — see
  [Using HVSC's own numbers](#using-hvscs-own-numbers-to-help-us) above. Lower it
  and the first pass is quicker but more tunes escalate; raise it and fewer do.
  Tunes that neither loop nor fade are the expensive ones: they burn the first
  budget *and* the escalation. If a trial run shows a lot of escalation, either
  raise `--budget-mult` (fewer wasted first passes) or `--no-escalate` the bulk
  run and mop up afterwards with `--only capped`.

## Notes

- Entries are matched to `.sid` files through the `; /path` comment above each
  line, not by recomputing HVSC's MD5 (which is a SID-specific digest, not a
  plain file hash). The MD5 is carried through untouched as a key.
- Multi-subtune SIDs are measured per subtune, one task each — the number of
  times on the HVSC line is what decides how many subtunes exist.
- Each worker keeps one engine instance alive across thousands of tunes. That is
  verified not to leak state between them (same results shared vs fresh, and in
  reverse order), but it is worth re-checking if the engine is ever rebuilt.

### A faster measurement is possible

This tool detects loops from the *rendered audio*, reusing the same analysis the
spectrometer bake uses — proven code, but it pays for full SID synthesis on every
tune. The SID **register writes** are also exactly periodic when a tune loops, and
getting them needs only the 6510 emulation (`wasm/cpu6510_wasm.cpp` already has
SID write tracking), skipping audio synthesis entirely. That would likely be
several times faster and more precise. It is a second detector with its own
failure modes, and nothing to validate it against until this run exists — so it
is deliberately not what this tool does. The results here would be the thing to
validate it against.
