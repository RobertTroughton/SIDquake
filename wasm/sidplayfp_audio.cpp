// sidplayfp_audio.cpp - libsidplayfp-based audio playback engine for SIDquake
//
// Drop-in replacement for the lightweight engine in sid_audio.cpp: exposes the
// exact same audio_* C API, but backed by libsidplayfp's full C64 environment
// (cycle-exact 6510 + CIA + VIC-II, real KERNAL/BASIC ROMs) with reSIDfp SID
// emulation. This makes RSID tunes, main-loop/NMI digi players, raster-timed
// code and the nonlinear 6581 filter work correctly.
//
// Built as a SEPARATE wasm module (public/sidplayfp.wasm) - see
// scripts/build-sidplayfp-wasm.sh and 0-build.bat. The export/analysis engine
// (sid_processor.cpp + cpu6510_wasm.cpp) is untouched.

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstring>

#include <sidplayfp/sidplayfp.h>
#include <sidplayfp/SidConfig.h>
#include <sidplayfp/SidInfo.h>
#include <sidplayfp/SidTune.h>
#include <sidplayfp/SidTuneInfo.h>
#include "residfp.h"

#include "roms_data.h"

namespace {

struct EngineState {
    sidplayfp*      engine   = nullptr;
    ReSIDfpBuilder* builder  = nullptr;
    SidTune*        tune     = nullptr;

    double sampleRate     = 48000.0;
    int    samplingMethod = 1;      // 0=fast, 1=interpolate, 2=resample
    int    forcedModel    = 0;      // 0 = follow tune header, else 6581/8580
    int    speed          = 1;      // fast-forward multiplier (1 = realtime)
    bool   loaded         = false;

    // Metadata cached at load (values copied out of SidTuneInfo)
    char name[256]      = {0};
    char author[256]    = {0};
    char copyright[256] = {0};
    int  songs          = 0;
    int  startSong      = 0;
    int  sidCount       = 1;
    int  headerModel    = 6581;    // from PSID header (first chip)
    bool isNTSC         = false;
};

EngineState S;

void copyInfoString(char* dst, size_t dstLen, const SidTuneInfo* info, unsigned int idx) {
    dst[0] = 0;
    if (info->numberOfInfoStrings() > idx) {
        const char* s = info->infoString(idx);
        if (s) {
            strncpy(dst, s, dstLen - 1);
            dst[dstLen - 1] = 0;
        }
    }
}

// (Re)apply the engine configuration. Returns true on success.
bool applyConfig() {
    if (!S.engine || !S.builder) return false;

    SidConfig cfg;
    cfg.frequency    = (uint_least32_t)S.sampleRate;
    cfg.playback     = SidConfig::MONO;
    cfg.sidEmulation = S.builder;

    switch (S.samplingMethod) {
        case 2:  cfg.samplingMethod = SidConfig::RESAMPLE_INTERPOLATE; cfg.fastSampling = false; break;
        case 0:  cfg.samplingMethod = SidConfig::INTERPOLATE;          cfg.fastSampling = true;  break;
        default: cfg.samplingMethod = SidConfig::INTERPOLATE;          cfg.fastSampling = false; break;
    }

    if (S.forcedModel == 6581) {
        cfg.defaultSidModel = SidConfig::MOS6581;
        cfg.forceSidModel   = true;
    } else if (S.forcedModel == 8580) {
        cfg.defaultSidModel = SidConfig::MOS8580;
        cfg.forceSidModel   = true;
    } else {
        cfg.defaultSidModel = SidConfig::MOS6581;  // fallback when header says "any"
        cfg.forceSidModel   = false;               // follow the tune header
    }
    cfg.defaultC64Model = SidConfig::PAL;          // NTSC comes from the tune header
    cfg.forceC64Model   = false;

    // Deterministic renders. libsidplayfp defaults powerOnDelay to
    // DEFAULT_POWER_ON_DELAY (> MAX_POWER_ON_DELAY), which makes player.cpp
    // randomise it from an RNG seeded with wall-clock time - so every render
    // starts the C64 at a different phase and the FFT bake (and realtime
    // playback) comes out slightly different each time. VQ then amplifies that
    // into a wholly different codebook, so exports were never reproducible.
    // Pin it to a fixed, representative value (<= MAX_POWER_ON_DELAY skips the
    // random branch); the engine still adds its ~8000-cycle settling base.
    cfg.powerOnDelay = 0x1000;

    try {
        return S.engine->config(cfg);
    } catch (...) {
        return false;
    }
}

// The engine's fast-forward decimates in the mixer: the C64 runs (and the
// tune advances) N times faster while pitch is unchanged - the classic SID
// player fast-forward. Deprecated upstream like the buffer play(); same
// rationale for keeping it while pinned to 2.x.
void applySpeed() {
    if (!S.engine) return;
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    try { S.engine->fastForward((unsigned int)(S.speed * 100)); } catch (...) {}
#pragma GCC diagnostic pop
}

// Re-run engine load so a config change takes effect on the playing tune.
bool reloadTune() {
    if (!S.engine || !S.tune || !S.loaded) return true;  // nothing to reload
    try {
        if (!S.engine->load(S.tune)) return false;
        applySpeed();
        return true;
    } catch (...) {
        return false;
    }
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void audio_init(double sampleRate) {
    S.sampleRate = sampleRate > 0 ? sampleRate : 48000.0;

    if (!S.engine) {
        try {
            S.engine = new sidplayfp();
            S.engine->setRoms(ROM_KERNAL, ROM_BASIC, ROM_CHARGEN);

            S.builder = new ReSIDfpBuilder("SIDquake");
            S.builder->create(S.engine->info().maxsids());
        } catch (...) {
            delete S.builder; S.builder = nullptr;
            delete S.engine;  S.engine = nullptr;
            return;
        }
    }

    applyConfig();
}

// Returns 0 on success; negative values mirror sid_audio.cpp's error codes
// (-1 too short / bad data, -2 not a SID, -3 engine not initialised,
//  -4 engine load failed).
EMSCRIPTEN_KEEPALIVE
int audio_load_sid(const uint8_t* data, int length) {
    if (!S.engine) return -3;
    if (length < 0x7C) return -1;
    if (memcmp(data, "PSID", 4) != 0 && memcmp(data, "RSID", 4) != 0) return -2;

    S.loaded = false;

    try {
        // Detach the old tune from the engine BEFORE deleting it: the engine
        // keeps an internal pointer to the loaded tune, and applyConfig() /
        // engine->config() dereference it when settings changed, which would
        // be a use-after-free on a second load.
        if (S.tune) {
            S.engine->load(nullptr);
            delete S.tune;
            S.tune = nullptr;
        }
        S.tune = new SidTune(data, (uint_least32_t)length);
        if (!S.tune->getStatus()) {
            delete S.tune; S.tune = nullptr;
            return -1;
        }

        S.tune->selectSong(0);  // 0 = the tune's default song

        const SidTuneInfo* info = S.tune->getInfo();
        copyInfoString(S.name,      sizeof(S.name),      info, 0);
        copyInfoString(S.author,    sizeof(S.author),    info, 1);
        copyInfoString(S.copyright, sizeof(S.copyright), info, 2);
        S.songs     = (int)info->songs();
        S.startSong = (int)info->startSong();
        S.sidCount  = info->sidChips();
        S.isNTSC    = (info->clockSpeed() == SidTuneInfo::CLOCK_NTSC);
        S.headerModel = (info->sidModel(0) == SidTuneInfo::SIDMODEL_8580) ? 8580 : 6581;

        if (!applyConfig()) return -4;
        if (!S.engine->load(S.tune)) return -4;
        applySpeed();
    } catch (...) {
        return -4;
    }

    S.loaded = true;
    return 0;
}

// subtune is 0-based (same convention as sid_audio.cpp / sid-playback.js);
// SidTune::selectSong takes 1-based song numbers.
EMSCRIPTEN_KEEPALIVE
void audio_set_subtune(int subtune) {
    if (!S.loaded || !S.tune) return;
    try {
        S.tune->selectSong((unsigned int)(subtune + 1));
        S.engine->load(S.tune);  // re-init the C64 with the selected song
        applySpeed();
    } catch (...) {
        // keep previous state
    }
}

EMSCRIPTEN_KEEPALIVE
int audio_generate(int16_t* buffer, int numSamples) {
    if (!S.loaded || !S.engine || numSamples <= 0) return 0;
    try {
        // The buffer-based play() is deprecated in 2.16 in favour of
        // play(cycles) + mix(), but it is the mature Mixer-driven loop that
        // fills exactly the requested number of samples. The replacement
        // needs cycle->sample carry bookkeeping for no audible gain, so keep
        // it while we're pinned to 2.x.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
        return (int)S.engine->play((short*)buffer, (uint_least32_t)numSamples);
#pragma GCC diagnostic pop
    } catch (...) {
        return 0;
    }
}

// 6581 or 8580: force the chip model (UI override); anything else returns to
// the per-tune header selection.
EMSCRIPTEN_KEEPALIVE
void audio_set_model(int model) {
    S.forcedModel = (model == 6581 || model == 8580) ? model : 0;
    if (applyConfig()) reloadTune();
}

// Fast-forward multiplier (1 = realtime). Tune tempo speeds up Nx with
// unchanged pitch; emulation cost also scales Nx, so high factors may not
// sustain realtime on slower machines (the buffer just drains).
EMSCRIPTEN_KEEPALIVE
void audio_set_speed(int multiplier) {
    if (multiplier < 1) multiplier = 1;
    if (multiplier > 32) multiplier = 32;
    S.speed = multiplier;
    applySpeed();
}

// 0 = fast (interpolate + fastSampling), 1 = interpolate, 2 = resample
EMSCRIPTEN_KEEPALIVE
void audio_set_sampling_method(int method) {
    S.samplingMethod = method;
    if (applyConfig()) reloadTune();
}

// ---- Metadata accessors (same contract as sid_audio.cpp) ----

EMSCRIPTEN_KEEPALIVE
const char* audio_get_title() { return S.name; }

EMSCRIPTEN_KEEPALIVE
const char* audio_get_author() { return S.author; }

EMSCRIPTEN_KEEPALIVE
const char* audio_get_copyright() { return S.copyright; }

EMSCRIPTEN_KEEPALIVE
int audio_get_subtune_count() { return S.songs; }

EMSCRIPTEN_KEEPALIVE
int audio_get_default_subtune() { return S.startSong; }  // 1-based, like the header

EMSCRIPTEN_KEEPALIVE
int audio_get_sid_model() { return S.forcedModel ? S.forcedModel : S.headerModel; }

EMSCRIPTEN_KEEPALIVE
int audio_get_sid_count() { return S.sidCount; }

EMSCRIPTEN_KEEPALIVE
double audio_get_play_time() {
    if (!S.engine) return 0.0;
    return S.engine->timeMs() / 1000.0;
}

EMSCRIPTEN_KEEPALIVE
int audio_get_is_ntsc() { return S.isNTSC ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE
void audio_cleanup() {
    // Unload (rather than the deprecated stop()): detaches the engine from
    // the SidTune before we delete it, so the player holds no dangling
    // pointer to the dead tune.
    if (S.engine) S.engine->load(nullptr);
    delete S.tune;
    S.tune = nullptr;
    S.loaded = false;
    S.name[0] = S.author[0] = S.copyright[0] = 0;
    S.songs = S.startSong = 0;
    S.sidCount = 1;
    S.headerModel = 6581;
    S.isNTSC = false;
}

} // extern "C"
