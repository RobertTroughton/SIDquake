// sid-player.js - SID Playback Component
// Wraps reSID (via WASM) to provide playback UI for SIDquake
// Uses a shared SIDPlayback instance to avoid multiple AudioContexts

var _activeSIDPlayerInstance = null;

class SIDPlayer {
    constructor(containerEl) {
        this.container = containerEl;
        this.isPlaying = false;
        this.currentSubtune = 0;
        this.totalSubtunes = 1;
        this.playTimeInterval = null;
        this.loaded = false;
        this._pendingData = null;
        this._pendingUrl = null;
        this._lastLoadedData = null;
        this._lastLoadedFilename = null;
        this._ownershipLost = false;
        this.buildUI();
    }

    buildUI() {
        this.container.innerHTML = `
            <div class="sid-player">
                <button class="sid-player-btn sid-player-play" title="Play" aria-label="Play" disabled>
                    <i class="fas fa-play"></i>
                </button>
                <button class="sid-player-btn sid-player-stop" title="Stop" aria-label="Stop" disabled>
                    <i class="fas fa-stop"></i>
                </button>
                <button class="sid-player-btn sid-player-restart" title="Restart" aria-label="Restart" disabled>
                    <i class="fas fa-undo"></i>
                </button>
                <div class="sid-player-subtune">
                    <button class="sid-player-btn sid-player-prev" title="Previous subtune" aria-label="Previous tune" disabled>
                        <i class="fas fa-step-backward"></i>
                    </button>
                    <span class="sid-player-subtune-display">1/1</span>
                    <button class="sid-player-btn sid-player-next" title="Next subtune" aria-label="Next tune" disabled>
                        <i class="fas fa-step-forward"></i>
                    </button>
                </div>
                <div class="sid-player-time">0:00</div>
                <div class="sid-player-quality">
                    <select class="sid-player-quality-select" title="Sampling quality" aria-label="Sampling quality">
                        <option value="0">Fast</option>
                        <option value="1">Interpolate</option>
                        <option value="2">Resample</option>
                    </select>
                </div>
                <div class="sid-player-model">
                    <select class="sid-player-model-select" title="SID chip model" aria-label="SID chip model">
                        <option value="auto">Tune's chip</option>
                        <option value="6581">MOS 6581</option>
                        <option value="8580">MOS 8580</option>
                    </select>
                </div>
                <div class="sid-player-speed" role="group" aria-label="Playback speed">
                    <button class="sid-player-speed-btn active" data-speed="1">1x</button>
                    <button class="sid-player-speed-btn" data-speed="2">2x</button>
                    <button class="sid-player-speed-btn" data-speed="4">4x</button>
                    <button class="sid-player-speed-btn" data-speed="10">10x</button>
                </div>
                <div class="sid-player-volume">
                    <i class="fas fa-volume-up"></i>
                    <input type="range" class="sid-player-volume-slider" min="0" max="100" step="1" title="Volume">
                </div>
            </div>
            <div class="sid-player-credit">Playback by <a href="https://github.com/libsidplayfp/libsidplayfp" target="_blank" rel="noopener">libsidplayfp</a> + reSIDfp</div>
        `;

        // Show the active engine in the credit (sid-playback.js may load
        // before or after this component builds - cover both orders).
        if (window.updateSIDEngineCredits) window.updateSIDEngineCredits();

        this.els = {
            playBtn: this.container.querySelector('.sid-player-play'),
            stopBtn: this.container.querySelector('.sid-player-stop'),
            restartBtn: this.container.querySelector('.sid-player-restart'),
            prevBtn: this.container.querySelector('.sid-player-prev'),
            nextBtn: this.container.querySelector('.sid-player-next'),
            subtuneContainer: this.container.querySelector('.sid-player-subtune'),
            subtuneDisplay: this.container.querySelector('.sid-player-subtune-display'),
            time: this.container.querySelector('.sid-player-time'),
            qualitySelect: this.container.querySelector('.sid-player-quality-select'),
            modelSelect: this.container.querySelector('.sid-player-model-select'),
            speedGroup: this.container.querySelector('.sid-player-speed'),
            volumeSlider: this.container.querySelector('.sid-player-volume-slider'),
        };

        this.els.playBtn.addEventListener('click', () => this.togglePlay());
        this.els.stopBtn.addEventListener('click', () => this.stop());
        this.els.restartBtn.addEventListener('click', () => this.restart());
        this.els.prevBtn.addEventListener('click', () => this.prevSubtune());
        this.els.nextBtn.addEventListener('click', () => this.nextSubtune());

        // Restore sampling quality (persisted; falls back to the old
        // session-only key from before settings were persistent)
        const savedQuality = SIDPlayer.getSavedQuality();
        this.els.qualitySelect.value = savedQuality !== null ? savedQuality : '1';

        this.els.qualitySelect.addEventListener('change', () => {
            const method = parseInt(this.els.qualitySelect.value, 10);
            try { localStorage.setItem('sidquake-sampling', String(method)); } catch (e) { /* ok */ }
            const player = getSharedSIDPlayback();
            player.setSamplingMethod(method);
            // Sync all other quality selects on the page
            document.querySelectorAll('.sid-player-quality-select').forEach(sel => {
                if (sel !== this.els.qualitySelect) sel.value = method;
            });
        });

        // Chip model: a page-wide preference rather than a per-tune one, so a
        // listener who prefers one chip keeps it across tunes. 'auto' hands the
        // choice back to each tune's own header.
        this.els.modelSelect.value = SIDPlayer.getSavedModel();

        this.els.modelSelect.addEventListener('change', () => {
            const choice = this.els.modelSelect.value;
            try { localStorage.setItem('sidquake-sid-model', choice); } catch (e) { /* ok */ }
            const player = getSharedSIDPlayback();
            player.setModel(parseInt(choice, 10) || 0);
            document.querySelectorAll('.sid-player-model-select').forEach(sel => {
                if (sel !== this.els.modelSelect) sel.value = choice;
            });
            if (window.hvscBrowser && window.hvscBrowser.refreshInfoPanel) {
                window.hvscBrowser.refreshInfoPanel();
            }
        });

        // Volume: restore the saved level and keep all sliders in sync.
        let savedVol = 1;
        try {
            const v = parseFloat(localStorage.getItem('sidquake-volume'));
            if (!isNaN(v) && v >= 0 && v <= 1) savedVol = v;
        } catch (e) { /* ok */ }
        this.els.volumeSlider.value = Math.round(savedVol * 100);
        this.els.volumeSlider.addEventListener('input', () => {
            const vol = this.els.volumeSlider.value / 100;
            getSharedSIDPlayback().setVolume(vol);
            document.querySelectorAll('.sid-player-volume-slider').forEach(sl => {
                if (sl !== this.els.volumeSlider) sl.value = this.els.volumeSlider.value;
            });
        });

        // Fast-forward: 1x/2x/4x/10x. Tempo scales, pitch doesn't (the C64
        // just runs faster). Only the libsidplayfp engine supports it - the
        // group is hidden after load when the active engine can't.
        this.els.speedGroup.querySelectorAll('.sid-player-speed-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mult = parseInt(btn.dataset.speed, 10);
                getSharedSIDPlayback().setSpeed(mult);
                document.querySelectorAll('.sid-player-speed-btn').forEach(b => {
                    const on = parseInt(b.dataset.speed, 10) === mult;
                    b.classList.toggle('active', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
            });
        });
    }

    /** 'auto' (follow the tune header), '6581' or '8580'. */
    static getSavedModel() {
        try {
            const v = localStorage.getItem('sidquake-sid-model');
            if (v === '6581' || v === '8580') return v;
        } catch (e) { /* ok */ }
        return 'auto';
    }

    static getSavedQuality() {
        try {
            const v = localStorage.getItem('sidquake-sampling');
            if (v !== null) return v;
        } catch (e) { /* ok */ }
        return sessionStorage.getItem('sidSamplingMethod');
    }

    takeOwnership() {
        // Stop any other SIDPlayer that's currently playing
        if (_activeSIDPlayerInstance && _activeSIDPlayerInstance !== this) {
            _activeSIDPlayerInstance.onLostOwnership();
        }
        _activeSIDPlayerInstance = this;
    }

    onLostOwnership() {
        // Another player took over the shared playback instance
        this.isPlaying = false;
        this._ownershipLost = true;
        this.els.playBtn.innerHTML = '<i class="fas fa-play"></i>';
        this.els.playBtn.title = 'Play';
        this.stopTimeUpdate();
    }

    // opts.autoplay: start as soon as the tune is ready. Only pass it from a
    // path the user actually clicked (Random SID, an HVSC pick) - the browser's
    // autoplay policy needs that gesture, and starting sound unasked otherwise
    // is rude.
    // opts.subtune: which tune of a multi-tune file to start on, 1-based, when
    // that has already been decided elsewhere (the tune previewed in the
    // collection browser). Without it the file's own start song is used.
    async loadFromBinary(data, filename, opts = {}) {
        this._autoplayOnLoad = !!opts.autoplay;
        this._startSubtune = parseInt(opts.subtune, 10) || 0;
        this.stop();
        this.takeOwnership();
        this._ownershipLost = false;

        // Normalize to a plain Uint8Array first: `data.buffer` would hand the
        // ENTIRE underlying ArrayBuffer to the engine, which is wrong for a
        // subarray view with a non-zero byteOffset.
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

        // Store a copy so we can reload if another player takes over
        this._lastLoadedData = bytes.slice();
        this._lastLoadedFilename = filename;

        const player = getSharedSIDPlayback();

        player.setLoadCallback(() => {
            this.onLoaded(filename);
        });

        try {
            await player.loadFromArrayBuffer(this._lastLoadedData.buffer);
        } catch (e) {
            console.error('SIDPlayer: Failed to load SID data:', e);
        }
    }

    async loadFromUrl(url, filename) {
        this.stop();
        this.takeOwnership();

        const player = getSharedSIDPlayback();

        player.setLoadCallback(() => {
            this.onLoaded(filename);
        });

        try {
            await player.loadFromUrl(url);
        } catch (e) {
            console.error('SIDPlayer: Failed to load SID URL:', e);
        }
    }

    onLoaded(filename) {
        const player = getSharedSIDPlayback();
        this.totalSubtunes = player.getSubtuneCount() || 1;
        const startSong = this._startSubtune || player.getStartSong();
        this._startSubtune = 0;
        this.currentSubtune = Math.max(0, Math.min(startSong - 1, this.totalSubtunes - 1));
        this.loaded = true;

        this.els.playBtn.disabled = false;
        this.els.stopBtn.disabled = false;
        this.els.restartBtn.disabled = false;

        this.updateSubtuneDisplay();

        // Apply the saved chip choice; 'auto' leaves it to the tune's header
        player.setModel(parseInt(SIDPlayer.getSavedModel(), 10) || 0);

        // Apply saved sampling quality
        const savedQuality = SIDPlayer.getSavedQuality();
        if (savedQuality !== null) {
            player.setSamplingMethod(parseInt(savedQuality, 10));
        }

        // Apply the saved volume to the (possibly fresh) audio graph and show
        // the speed group only when the engine supports fast-forward.
        player.setVolume(player.volume);
        this.els.speedGroup.style.display = player.supportsSpeed() ? '' : 'none';
        const speed = player.getSpeed ? player.getSpeed() : 1;
        this.els.speedGroup.querySelectorAll('.sid-player-speed-btn').forEach(b => {
            const on = parseInt(b.dataset.speed, 10) === speed;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });

        // Asked for on load: play now the tune is ready. _syncPlayButton already
        // handles the case where the audio context is still suspended, so a
        // blocked start shows PLAY rather than a lying PAUSE.
        if (this._autoplayOnLoad) {
            this._autoplayOnLoad = false;
            this.play();
        }
    }

    togglePlay() {
        const player = getSharedSIDPlayback();
        // Playback intended but blocked by the autoplay policy (e.g. arriving
        // via a shared link): this click IS the missing gesture - resume the
        // audio instead of treating the (visually un-pressed) button as pause.
        if (this.isPlaying && player.isAudible && !player.isAudible()) {
            if (player.audioCtx) player.audioCtx.resume().catch(() => {});
            return;
        }
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    // Make the play button and timer reflect what's audible, not what was
    // requested: with the AudioContext suspended pre-gesture, the button keeps
    // showing PLAY and the timer stays parked until sound actually starts.
    _syncPlayButton() {
        const player = getSharedSIDPlayback();
        const audible = this.isPlaying && (!player.isAudible || player.isAudible());
        this.els.playBtn.innerHTML = audible ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
        this.els.playBtn.title = audible ? 'Pause' : 'Play';
        if (audible) this.startTimeUpdate();
        else this.stopTimeUpdate();
    }

    async play() {
        if (!this.loaded) return;
        this.takeOwnership();
        const player = getSharedSIDPlayback();

        // If another player loaded different data while we lost ownership,
        // reload our SID data before playing
        if (this._ownershipLost && this._lastLoadedData) {
            this._ownershipLost = false;
            player.setLoadCallback(() => {
                this.onLoaded(this._lastLoadedFilename);
                player.setSubtune(this.currentSubtune);
                player.play();
                this.isPlaying = true;
                player.setAudioStateCallback(() => this._syncPlayButton());
                this._syncPlayButton();
            });
            await player.loadFromArrayBuffer(this._lastLoadedData.buffer);
            return;
        }

        player.pause();
        player.setSubtune(this.currentSubtune);
        player.play();
        this.isPlaying = true;
        player.setAudioStateCallback(() => this._syncPlayButton());
        this._syncPlayButton();
    }

    pause() {
        const player = getSharedSIDPlayback();
        player.pause();
        this.isPlaying = false;
        this.els.playBtn.innerHTML = '<i class="fas fa-play"></i>';
        this.els.playBtn.title = 'Play';
        this.stopTimeUpdate();
    }

    stop() {
        if (_activeSIDPlayerInstance === this && _sharedSIDPlayback) {
            _sharedSIDPlayback.stop();
        }
        this.isPlaying = false;
        this.els.playBtn.innerHTML = '<i class="fas fa-play"></i>';
        this.els.playBtn.title = 'Play';
        this.els.time.textContent = '0:00';
        this.stopTimeUpdate();
    }

    restart() {
        if (!this.loaded) return;
        this.play();
    }

    prevSubtune() {
        if (this.currentSubtune > 0) {
            this.currentSubtune--;
            this.updateSubtuneDisplay();
            if (window.hvscVisualizer && window.hvscVisualizer.reset) window.hvscVisualizer.reset();
            if (this.isPlaying) this.play();
        }
    }

    nextSubtune() {
        if (this.currentSubtune < this.totalSubtunes - 1) {
            this.currentSubtune++;
            this.updateSubtuneDisplay();
            if (window.hvscVisualizer && window.hvscVisualizer.reset) window.hvscVisualizer.reset();
            if (this.isPlaying) this.play();
        }
    }

    /** Play a specific tune of a multi-tune file, 0-indexed. */
    setSubtune(index) {
        const want = Math.max(0, Math.min(index | 0, this.totalSubtunes - 1));
        if (!this.loaded || want === this.currentSubtune) return;
        this.currentSubtune = want;
        this.updateSubtuneDisplay();
        if (window.hvscVisualizer && window.hvscVisualizer.reset) window.hvscVisualizer.reset();
        if (this.isPlaying) this.play();
    }

    updateSubtuneDisplay() {
        this.els.subtuneDisplay.textContent = `${this.currentSubtune + 1}/${this.totalSubtunes}`;
        this.els.prevBtn.disabled = this.currentSubtune <= 0;
        this.els.nextBtn.disabled = this.currentSubtune >= this.totalSubtunes - 1;
        // Whoever is hosting the player may be showing the same choice elsewhere
        // (the Studio's "which tune to use").
        if (typeof this.onSubtuneChange === 'function') this.onSubtuneChange(this.currentSubtune);
    }

    startTimeUpdate() {
        this.stopTimeUpdate();
        this.playTimeInterval = setInterval(() => {
            if (this.isPlaying) {
                const player = getSharedSIDPlayback();
                const seconds = player.getPlayTime();
                const mins = Math.floor(seconds / 60);
                const secs = seconds % 60;
                this.els.time.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
            }
        }, 500);
    }

    stopTimeUpdate() {
        if (this.playTimeInterval) {
            clearInterval(this.playTimeInterval);
            this.playTimeInterval = null;
        }
    }

    cleanup() {
        this.stop();
    }

    reset() {
        this.cleanup();
        this.loaded = false;
        this.totalSubtunes = 1;
        this.currentSubtune = 0;
        this.els.playBtn.disabled = true;
        this.els.stopBtn.disabled = true;
        this.els.restartBtn.disabled = true;
        this.els.prevBtn.disabled = true;
        this.els.nextBtn.disabled = true;
        this.els.subtuneDisplay.textContent = '1/1';
        this.els.time.textContent = '0:00';
    }
}
