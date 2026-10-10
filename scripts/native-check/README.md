# Native checks

`run.sh` builds the C++ that becomes `sidquake.wasm` (the analyser and the reSID
engine) or `sidplayfp.wasm` (libsidplayfp) with plain g++, links it to
`driver.cpp` and runs it under AddressSanitizer + UBSan or valgrind:

    scripts/native-check/run.sh                      # reSID + analyser, ASan/UBSan
    scripts/native-check/run.sh sidplayfp            # libsidplayfp, ASan/UBSan
    scripts/native-check/run.sh --valgrind sidplayfp SID/drax-twine.sid SID/magnar-withlove.sid

The driver renders tune A, then B, then A again and says whether the two
renders of A match, and with the analyser linked runs `sid_analyze` on every
tune. A mismatch, a sanitizer report or a valgrind error exits non-zero.

This is the tool for a bug WASM hides: an out-of-bounds read inside the heap or
an uninitialised value never traps there. It is not the reference for output:
the goldens (`scripts/test-goldens.js`) run against the real `.wasm`, and a
native build can differ from it where the WASM build differs (32-bit `long`,
heap layout, floating-point library). Both engines' history-dependent renders
were found this way, and one only showed in the WASM build, because it came
from heap addresses (see `scripts/test-render-determinism.js`).

Known report: UBSan flags a left shift of a negative value in the vendored
`residfp/ExternalFilter.h`. It is how reSIDfp scales a signed sample; C++20
defines it, and every compiler here does what C++20 says. UBSan reports are
printed but do not fail the run.
