// sid-playback.js - SID playback engine for SIDquake
// Wraps a WASM SID engine with AudioWorkletNode for glitch-free output.
//
// Two engines expose the same audio_* API:
//   - 'fp' (default): libsidplayfp + reSIDfp in sidplayfp.wasm - a full C64
//     environment (real KERNAL/BASIC ROMs, cycle-exact CPU/CIA/VIC) that
//     correctly plays RSID tunes, main-loop/NMI digi players and raster-timed
//     code, with a more accurate (nonlinear) 6581 filter.
//   - 'resid': the old lightweight reSID engine inside sidquake.wasm, kept
//     as a fallback (?engine=resid) for one release before removal.
// Select with ?engine=fp / ?engine=resid or localStorage 'sidquake-engine'.

class SIDPlayback {
    constructor(bufferSize = 4096) {
        this.bufferSize = bufferSize;
        this.audioCtx = null;
        this.workletNode = null;
        this.gainNode = null;
        this.module = null;
        this.api = null;
        this.loaded = false;
        this.playing = false;
        this.volume = SIDPlayback.loadSavedVolume();
        this.speed = 1;
        this.wasmBuffer = null;
        this.wasmBufferPtr = 0;

        // Worklet queue management: keep enough audio buffered that main-thread
        // work (sorting/rendering the browser, layout, GC) can't starve the
        // audio thread. The worklet reports its fill level with each request
        // and we top up to the high-water mark, at most a few chunks per
        // task so the UI stays responsive even at high fast-forward speeds.
        this.bufferLowWater = 16384;    // samples (~0.37s @ 44.1kHz): worklet asks below this
        this.bufferHighWater = 32768;   // samples (~0.74s): fill target
        this._fillPending = false;
        this._workletBuffered = 0;

        // Metadata cache (avoid crossing WASM boundary every frame)
        this._title = '';
        this._author = '';
        this._copyright = '';
        this._subtunes = 0;
        this._startSong = 0;
        this._sidModel = 6581;
        this._sidCount = 1;
        this._isNTSC = false;

        this._loadAddress = 0;
        this._initAddress = 0;
        this._playAddress = 0;
        this._dataSize = 0;

        this._loadCallback = null;

        // Load-race protection: each load claims a generation number and only
        // the most recent one may touch engine state or fire the callback.
        // Loads are additionally serialized through a promise chain so two
        // overlapping loadFromArrayBuffer calls can't interleave.
        this._loadGen = 0;
        this._loadChain = Promise.resolve();
    }

    /** Volume saved from a previous session (default 1.0). */
    static loadSavedVolume() {
        try {
            const v = parseFloat(localStorage.getItem('sidquake-volume'));
            if (!isNaN(v) && v >= 0 && v <= 1) return v;
        } catch (e) { /* no localStorage */ }
        return 1.0;
    }

    /** Which playback engine to use: 'fp' (libsidplayfp, default) or 'resid'. */
    static engineName() {
        try {
            const qs = new URLSearchParams(window.location.search).get('engine');
            if (qs === 'fp' || qs === 'resid') return qs;
            const stored = localStorage.getItem('sidquake-engine');
            if (stored === 'fp' || stored === 'resid') return stored;
        } catch (e) {
            // no window/localStorage access - fall through to default
        }
        return 'fp';
    }

    /** Lazy-load and instantiate the libsidplayfp module (public/sidplayfp.js). */
    static _loadFPModule() {
        if (!window._sidplayfpModulePromise) {
            window._sidplayfpModulePromise = (async () => {
                if (typeof SIDPlayfpModule !== 'function') {
                    if (window.loadScript) {
                        await window.loadScript('sidplayfp.js');
                    } else {
                        await new Promise((resolve, reject) => {
                            const s = document.createElement('script');
                            s.src = (window.cacheBust || (x => x))('sidplayfp.js');
                            s.onload = resolve;
                            s.onerror = reject;
                            document.head.appendChild(s);
                        });
                    }
                }
                return SIDPlayfpModule();
            })();
        }
        return window._sidplayfpModulePromise;
    }

    // Idempotent init: concurrent callers (e.g. the browser's warm-up racing a
    // deep-linked preview) share one promise instead of double-initialising
    // the module/AudioContext/worklet (which left a caller with a half-built
    // instance and a null workletNode).
    init() {
        if (!this._initPromise) {
            this._initPromise = this._doInit().catch((e) => {
                this._initPromise = null;  // allow retry after a failed init
                throw e;
            });
        }
        return this._initPromise;
    }

    async _doInit() {
        if (this.module) return;

        if (SIDPlayback.engineName() === 'fp') {
            // libsidplayfp engine: a separate, lazily fetched WASM module.
            this.module = await SIDPlayback._loadFPModule();
        } else if (window.SIDquakeModule && typeof window.SIDquakeModule.cwrap === 'function') {
            // Module already instantiated by sidquake-core.js
            this.module = window.SIDquakeModule;
        } else if (typeof SIDquakeModule === 'function') {
            // Module factory not yet called - instantiate it
            this.module = await SIDquakeModule();
        } else {
            throw new Error('SID WASM module factory not loaded. Include sidquake.js first.');
        }

        this._bindAPI();

        // Create audio context
        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AC();

        // Surface suspend/resume transitions (autoplay policy) so the player
        // UI can show whether audio is actually flowing rather than intended.
        this.audioCtx.addEventListener('statechange', () => {
            if (this._onAudioState) this._onAudioState(this.audioCtx.state);
        });

        // Init the WASM audio engine with the browser's sample rate
        this.api.audio_init(this.audioCtx.sampleRate);

        // Allocate a persistent WASM buffer for audio samples (int16)
        this.wasmBufferPtr = this.module._malloc(this.bufferSize * 2);

        // Register AudioWorklet processor and create node
        await this.audioCtx.audioWorklet.addModule('sid-worklet-processor.js');
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'sid-worklet-processor');

        // Top up the worklet's queue when it runs low (it reports how much
        // it still has buffered so we know how far to fill).
        this.workletNode.port.onmessage = (e) => {
            if (e.data.type === 'need-samples' && this.playing && this.loaded) {
                this._workletBuffered = e.data.buffered || 0;
                this._fillWorkletQueue();
            }
        };

        // Gain node for volume control
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.volume;
        this.workletNode.connect(this.gainNode);

        // Analyser tap for visualizers (reads the live signal; not forwarded to
        // output, so it doesn't affect playback). Updates only while audio is
        // actually flowing (i.e. during play).
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.6;
        this.gainNode.connect(this.analyser);
    }

    /** AnalyserNode tapping the playback signal (or null before init). */
    getAnalyser() { return this.analyser || null; }

    _bindAPI() {
        const cwrap = this.module.cwrap;
        this.api = {
            audio_init:              cwrap('audio_init', null, ['number']),
            audio_load_sid:          cwrap('audio_load_sid', 'number', ['number', 'number']),
            audio_set_subtune:       cwrap('audio_set_subtune', null, ['number']),
            audio_generate:          cwrap('audio_generate', 'number', ['number', 'number']),
            audio_set_model:         cwrap('audio_set_model', null, ['number']),
            audio_set_sampling_method: cwrap('audio_set_sampling_method', null, ['number']),
            // Fast-forward is only exported by the fp engine; bind when present.
            audio_set_speed:         (typeof this.module._audio_set_speed === 'function')
                                         ? cwrap('audio_set_speed', null, ['number']) : null,
            // Header strings are Latin-1 (ISO 8859-1) per the SID spec - bind
            // as raw pointers and decode with _readLatin1 (cwrap's 'string'
            // assumes UTF-8 and turns e.g. "Søren" into "S�ren").
            audio_get_title:         cwrap('audio_get_title', 'number', []),
            audio_get_author:        cwrap('audio_get_author', 'number', []),
            audio_get_copyright:     cwrap('audio_get_copyright', 'number', []),
            audio_get_subtune_count: cwrap('audio_get_subtune_count', 'number', []),
            audio_get_default_subtune: cwrap('audio_get_default_subtune', 'number', []),
            audio_get_sid_model:     cwrap('audio_get_sid_model', 'number', []),
            audio_get_sid_count:     cwrap('audio_get_sid_count', 'number', []),
            audio_get_play_time:     cwrap('audio_get_play_time', 'number', []),
            audio_get_is_ntsc:       cwrap('audio_get_is_ntsc', 'number', []),
            audio_cleanup:           cwrap('audio_cleanup', null, []),
        };
    }

    /** Decode a NUL-terminated Latin-1 string from the WASM heap. */
    _readLatin1(ptr) {
        if (!ptr) return '';
        const heap = this.module.HEAPU8;
        let s = '';
        for (let i = ptr; heap[i]; i++) s += String.fromCharCode(heap[i]);
        return s;
    }

    _generateAndPost() {
        const generated = this.api.audio_generate(this.wasmBufferPtr, this.bufferSize);
        if (generated <= 0) return 0;

        // Read samples from WASM heap (use HEAPU8.buffer fresh after WASM call
        // to handle ALLOW_MEMORY_GROWTH buffer detachment)
        const heap = this.module.HEAPU8.buffer;
        const int16View = new Int16Array(heap, this.wasmBufferPtr, generated);

        // Convert int16 to float32 for the worklet
        const floatSamples = new Float32Array(generated);
        for (let i = 0; i < generated; i++) {
            floatSamples[i] = int16View[i] / 32768.0;
        }

        // Transfer the buffer to the worklet (zero-copy)
        this.workletNode.port.postMessage(
            { type: 'samples', samples: floatSamples },
            [floatSamples.buffer]
        );
        return generated;
    }

    // Fill the worklet queue up to the high-water mark, generating at most a
    // few chunks per task and yielding between batches, so heavy generation
    // (e.g. 10x fast-forward) can't lock up the UI.
    _fillWorkletQueue() {
        if (this._fillPending) return;
        const step = () => {
            this._fillPending = false;
            if (!this.playing || !this.loaded) return;
            for (let i = 0; i < 3 && this._workletBuffered < this.bufferHighWater; i++) {
                const got = this._generateAndPost();
                if (got <= 0) return;
                this._workletBuffered += got;
            }
            if (this._workletBuffered < this.bufferHighWater) {
                this._fillPending = true;
                setTimeout(step, 0);
            }
        };
        step();
    }

    loadFromArrayBuffer(arrayBuffer) {
        return this._enqueueLoad(arrayBuffer, ++this._loadGen);
    }

    /** Serialize loads and drop any that were superseded while queued. */
    _enqueueLoad(arrayBuffer, gen) {
        const run = this._loadChain.then(async () => {
            if (gen !== this._loadGen) return;  // a newer load supersedes this one
            await this._applyLoad(arrayBuffer);
            if (this._loadCallback && gen === this._loadGen) {
                this._loadCallback();
            }
        });
        // Keep the chain alive even when a load fails, so later loads still run.
        this._loadChain = run.catch(() => {});
        return run;
    }

    async _applyLoad(arrayBuffer) {
        await this.init();

        // Stop playback and flush worklet queue before loading new SID
        this.playing = false;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'stop' });
        }

        // Reset WASM SID state if a tune was already loaded
        if (this.loaded) {
            this.api.audio_cleanup();
            this.loaded = false;
        }

        const data = new Uint8Array(arrayBuffer);

        // Allocate WASM memory and copy SID file data
        const ptr = this.module._malloc(data.length);
        this.module.HEAPU8.set(data, ptr);

        // Load the SID file
        const result = this.api.audio_load_sid(ptr, data.length);
        this.module._free(ptr);

        if (result !== 0) {
            throw new Error(`Failed to load SID file (error ${result})`);
        }

        // Parse addresses from SID header (big-endian)
        this._parseSIDHeader(data);

        // Cache metadata
        this._title = this._readLatin1(this.api.audio_get_title());
        this._author = this._readLatin1(this.api.audio_get_author());
        this._copyright = this._readLatin1(this.api.audio_get_copyright());
        this._subtunes = this.api.audio_get_subtune_count();
        this._startSong = this.api.audio_get_default_subtune();
        this._sidModel = this.api.audio_get_sid_model();
        this._sidCount = this.api.audio_get_sid_count();
        this._isNTSC = this.api.audio_get_is_ntsc() !== 0;

        this.loaded = true;
    }

    async loadFromUrl(url) {
        // Claim the generation before fetching so a load started after us
        // (e.g. the user clicked another tune while this one was downloading)
        // wins even if our fetch resolves last.
        const gen = ++this._loadGen;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (gen !== this._loadGen) return;  // superseded while downloading
        return this._enqueueLoad(buffer, gen);
    }

    setSubtune(subtune) {
        if (!this.loaded) return;
        this.api.audio_set_subtune(subtune);
    }

    play() {
        if (!this.loaded || !this.workletNode) return;

        // Resume audio context if suspended (browser autoplay policy). If the
        // browser refuses (no user gesture yet - e.g. arriving via a shared
        // ?tune= link), retry on the first interaction so deep-linked tunes
        // start as soon as the user touches the page.
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
            if (!this._resumeHooked) {
                this._resumeHooked = true;
                const tryResume = () => {
                    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
                };
                ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
                    document.addEventListener(ev, tryResume, { once: true, capture: true }));
            }
        }

        this.playing = true;

        // Flush any stale samples and tell worklet to start accepting new ones
        this.workletNode.port.postMessage({ type: 'stop' });
        this.workletNode.port.postMessage({ type: 'start' });

        // Pre-fill the worklet queue so playback starts immediately
        this._workletBuffered = 0;
        this._fillWorkletQueue();

        // Fade in from silence to mask any transition click (~85ms)
        const now = this.audioCtx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(0, now);
        this.gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.085);

        // Route through the analyser so it's on the path to the destination and
        // therefore actually fed samples (a dead-end analyser reads silence in
        // some browsers). worklet -> gain -> analyser -> destination.
        (this.analyser || this.gainNode).connect(this.audioCtx.destination);
    }

    pause() {
        this.playing = false;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'stop' });
        }
        try {
            (this.analyser || this.gainNode).disconnect(this.audioCtx.destination);
        } catch (e) {
            // Already disconnected
        }
    }

    stop() {
        this.pause();
        if (this.loaded) {
            // Reset to start of current subtune
            this.api.audio_set_subtune(this._startSong > 0 ? this._startSong - 1 : 0);
        }
    }

    setVolume(vol) {
        this.volume = vol;
        if (this.gainNode) {
            this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
            this.gainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
        }
        try { localStorage.setItem('sidquake-volume', String(vol)); } catch (e) { /* ok */ }
    }

    /**
     * True when sound is actually coming out: playback intended AND the
     * AudioContext is running (not blocked by the autoplay policy).
     */
    isAudible() {
        return this.playing && !!this.audioCtx && this.audioCtx.state === 'running';
    }

    /** Register for AudioContext state changes ('running'/'suspended'/...). */
    setAudioStateCallback(fn) {
        this._onAudioState = fn;
    }

    /** Whether the active engine supports fast-forward (fp engine only). */
    supportsSpeed() {
        return !!(this.api && this.api.audio_set_speed);
    }

    /** Fast-forward multiplier (1 = realtime); no-op on the legacy engine. */
    setSpeed(mult) {
        this.speed = mult;
        if (this.api && this.api.audio_set_speed) {
            this.api.audio_set_speed(mult);
        }
    }

    getSpeed() { return this.speed; }

    setModel(model) {
        if (this.api) {
            this.api.audio_set_model(model);
            this._sidModel = model;
        }
    }

    setSamplingMethod(method) {
        // 0 = fast, 1 = interpolate, 2 = resample
        if (this.api) {
            this.api.audio_set_sampling_method(method);
        }
    }

    setLoadCallback(fn) {
        this._loadCallback = fn;
    }

    _parseSIDHeader(data) {
        if (data.length < 0x76) return;
        const be16 = (hi, lo) => (data[hi] << 8) | data[lo];
        const dataOffset = be16(0x06, 0x07);
        let loadAddr = be16(0x08, 0x09);
        this._initAddress = be16(0x0A, 0x0B);
        this._playAddress = be16(0x0C, 0x0D);
        const musicData = data.subarray(dataOffset);
        let musicLen = data.length - dataOffset;
        if (loadAddr === 0 && musicLen >= 2) {
            loadAddr = musicData[0] | (musicData[1] << 8);
            musicLen -= 2;
        }
        this._loadAddress = loadAddr;
        if (this._initAddress === 0) this._initAddress = loadAddr;
        this._dataSize = musicLen;
    }

    // ---- Metadata getters ----
    getTitle()        { return this._title; }
    getAuthor()       { return this._author; }
    getCopyright()    { return this._copyright; }
    getSubtuneCount() { return this._subtunes; }
    getStartSong()    { return this._startSong; }
    getSIDModel()     { return this._sidModel; }
    getSIDCount()     { return this._sidCount; }
    isNTSC()          { return this._isNTSC; }
    getLoadAddress()  { return this._loadAddress; }
    getInitAddress()  { return this._initAddress; }
    getPlayAddress()  { return this._playAddress; }
    getDataSize()     { return this._dataSize; }

    getPlayTime() {
        if (!this.api || !this.loaded) return 0;
        return Math.floor(this.api.audio_get_play_time());
    }

    cleanup() {
        this.pause();
        if (this.api) {
            this.api.audio_cleanup();
        }
        if (this.wasmBufferPtr && this.module) {
            this.module._free(this.wasmBufferPtr);
            this.wasmBufferPtr = 0;
        }
        this.loaded = false;
    }
}

// Shared singleton: only one AudioContext / SID engine in the page.
var _sharedSIDPlayback = null;

function getSharedSIDPlayback() {
    if (!_sharedSIDPlayback) {
        _sharedSIDPlayback = new SIDPlayback(4096);
    }
    return _sharedSIDPlayback;
}

// ---- Engine credit label ----
// The player UI shows which engine drives playback; keep it in sync with the
// selected engine so an ?engine=fp session is visibly running libsidplayfp.

SIDPlayback.engineCreditHTML = function() {
    if (SIDPlayback.engineName() === 'fp') {
        return 'Playback by <a href="https://github.com/libsidplayfp/libsidplayfp" target="_blank" rel="noopener">libsidplayfp</a> + reSIDfp';
    }
    return 'Playback by <a href="https://github.com/libsidplayfp/resid" target="_blank" rel="noopener">reSID</a>';
};

// Rewrite every credit element on the page (static markup in index.html /
// hvsc-embed.html defaults to the reSID label). Re-run by sid-player.js after
// it builds its own player UI.
function updateSIDEngineCredits() {
    try {
        document.querySelectorAll('.sid-player-credit').forEach((el) => {
            el.innerHTML = SIDPlayback.engineCreditHTML();
        });
    } catch (e) {
        // no DOM (tests) - ignore
    }
}
window.updateSIDEngineCredits = updateSIDEngineCredits;
updateSIDEngineCredits();
