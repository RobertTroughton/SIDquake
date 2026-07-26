/*
 * How a measurement compares to HVSC's published length. Shared by scan.mjs
 * (live counters) and report.mjs (the table), so the two can never drift apart.
 *
 *   match  - within 1 s of HVSC
 *   close  - within 5 s
 *   off    - within 30 s
 *   wild   - further out than that; worth looking at by hand
 *   half   } our length is about half / double HVSC's. Usually means one of us
 *   double } locked onto a harmonic of the real period rather than the period,
 *            so these are the most interesting rows in the whole report.
 *   noloop - we found neither a repeat nor an end within the scan budget
 *   capped - we ran out of scan budget; the number is a lower bound, not a
 *            measurement (re-run those with a bigger --budget-mult)
 *   nohvsc - HVSC has no parseable time for this subtune
 *   error  - the tune failed to render
 */

export const CLASSES = ['match', 'close', 'half', 'double', 'off', 'wild', 'noloop', 'capped', 'nohvsc', 'error'];

export function classify(r) {
    if (r.error) return 'error';
    if (r.capped) return 'capped';
    if (!r.looped && !r.fadedOut) return 'noloop';
    if (r.hvscMs == null || !r.hvscMs) return 'nohvsc';
    const ours = r.ms, theirs = r.hvscMs;
    const d = Math.abs(ours - theirs) / 1000;
    if (d <= 1) return 'match';
    if (d <= 5) return 'close';
    // Harmonic checks come before the coarse bands: "30 s vs 60 s" is a far more
    // useful label than "off by 30 s", and it points straight at a period that
    // was resolved an octave out.
    const ratio = theirs > 0 ? ours / theirs : 0;
    if (ratio > 0.45 && ratio < 0.55) return 'half';
    if (ratio > 1.9 && ratio < 2.1) return 'double';
    if (d <= 30) return 'off';
    return 'wild';
}
