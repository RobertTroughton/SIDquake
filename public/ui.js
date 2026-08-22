// UI controller for SIDquake web app.

// C64 hardware palette (16 colors). Index matches the C64 color number.
// The swatches, colour pickers and palette editors all draw from the shared
// table in c64-palette.js - see the note there about why there used to be two.
const C64_COLORS = window.C64_PALETTE;

class UIController {
    constructor() {
        this.analyzer = null;
        this.currentFileName = null;
        this.hasModifications = false;
        this.analysisResults = null;
        this.prgExporter = null;
        this.sidHeader = null;
        this.originalMetadata = {};  // baseline for detecting metadata edits
        // Loop/length analysis of the tune's DEFAULT song, run once on load (see
        // runTuneAnalysis). Shared by the spectrometer memory readout and the song
        // length that baked players show. Null until a tune is analysed.
        this.tuneAnalysis = null;
        // Forced song loop (fade-out tunes): per-SID decision state. The toggle
        // itself (forceLoopToggle, Song tab) holds the choice; these track whether
        // the user has decided, so the one-time fade-out prompt never nags.
        this._loopChoiceTouched = false;   // user set the toggle themselves
        this._loopChoiceAsked = false;     // fade-out prompt already shown for this SID
        // The single in-flight loop/length scan. Both the background scan started
        // on load and an export that needs the result go through _ensureAnalysis,
        // so a Generate pressed mid-scan adopts the running job - two concurrent
        // runs would fight over the bake core's one shared render cache.
        this._analysisJob = null;
        // Bumped on every SID load. A scan carries the token it started with, so a
        // job that finishes after the user moved on cannot write its result into
        // the new tune's state.
        this._analysisToken = 0;
        this._analysisCancelled = false;   // last scan ended because the user stopped it
        // Seconds of music the scan looks through for THIS tune when the user has
        // asked it to keep looking; 0 = whatever Advanced settings says. Cleared
        // on a new tune (see processFile).
        this._scanWindowOverride = 0;
        // Whether the loaded tune is invisible to the live bar methods, and which
        // tune that answer belongs to (an _analysisToken). See checkVuVisibility.
        this._vuBlind = null;
        this._vuBlindFor = -1;
        this.selectedVisualizer = null;
        this.visualizerConfig = null;
        // Sticky image selections (Logo / Bitmap) so a user's chosen image
        // survives switching visualizers. Keyed by logical slot (an input's
        // convertType, e.g. 'logo'), which is stable even though the Logo input
        // has different element ids across configs (logo-input / bitmap-input).
        this._imageSelectionMemory = {};
        this._pendingImageRestore = null;
        // Sticky visualizer choice for the session: the grid card the user picked
        // and the data source they settled on. A new SID re-selects them when the
        // tune can take them, instead of dropping back to the alphabetically
        // first compatible player. Only a deliberate pick writes these - an
        // auto-selected fallback leaves them alone, so the choice comes back on
        // the next tune that can take it.
        this._lastVisualizerId = null;
        this._lastDataSource = null;
        // Sticky option values for the session, keyed by option element id, so a
        // new tune keeps the bar style / colours / palettes / font the user set.
        // Holds only values the user actually changed (see _rememberOptionValues).
        this._optionMemory = {};
        // ...and the same choices come back after a refresh or in a new tab.
        // Someone setting up a music disk closes the tab between tunes, and
        // starting from the alphabetically first player every time is the same
        // annoyance a reload should not reintroduce.
        this._restoreSessionMemory();
        // Only the newest placement preview is shown; a user can change player
        // faster than the placement runs.
        this._planToken = 0;
        // Same guard for the VU-visibility check, which also runs per selection.
        this._vuToken = 0;
        this._textPreviewToken = 0;
        this.hvscBrowserWindow = null;
        this.mainPlayer = null;
        this.elements = this.cacheElements();
        this.initEventListeners();
    }

    /** Lazy-load WASM + SID analyzer (only needed when processing a SID file). */
    async ensureAnalyzer() {
        if (this.analyzer) return this.analyzer;
        await window.loadScript('sidquake.js');
        await window.loadScript('sidquake-core.js');
        this.analyzer = new SIDAnalyzer();
        return this.analyzer;
    }

    /** Lazy-load PRG export dependencies (builder + png-converter + compressor + data files). */
    async ensurePRGExporter() {
        if (this.prgExporter) return this.prgExporter;
        await Promise.all([
            window.loadScript('png-converter.js'),
            window.loadScript('compressor-manager.js'),
            window.loadScript('bar-styles-data.js'),
            window.loadScript('color-palettes-data.js'),
            window.loadScript('font-data.js'),
            window.loadScript('petscii-converter.js'),
            window.loadScript('petscii-sanitizer.js'),
            window.loadScript('charsetlab-core.js'),
            window.loadScript('c64fonts.js'),      // ROM glyphs: lets the logo converter detect PETSCII art
        ]);
        await window.loadScript('prg-builder.js');
        this.prgExporter = new SIDquakePRGExporter(this.analyzer);
        window.currentAnalyzer = this.analyzer;
        return this.prgExporter;
    }

    cacheElements() {
        return {
            uploadSection: document.getElementById('uploadSection'),
            uploadBtn: document.getElementById('uploadBtn'),
            hvscBtn: document.getElementById('hvscBtn'),
            randomBtn: document.getElementById('randomBtn'),
            hvscSelected: document.getElementById('hvscSelected'),
            selectedFile: document.getElementById('selectedFile'),

            fileInput: document.getElementById('fileInput'),
            songTitleSection: document.getElementById('songTitleSection'),
            songTitle: document.getElementById('songTitle'),
            songAuthor: document.getElementById('songAuthor'),
            loading: document.getElementById('loading'),
            progressBar: document.getElementById('progressBar'),
            progressFill: document.getElementById('progressFill'),
            progressText: document.getElementById('progressText'),
            errorMessage: document.getElementById('errorMessage'),
            infoSection: document.getElementById('infoSection'),
            infoPanels: document.getElementById('infoPanels'),
            modalOverlay: document.getElementById('modalOverlay'),
            modalIcon: document.getElementById('modalIcon'),
            modalMessage: document.getElementById('modalMessage'),
            busyOverlay: document.getElementById('busyOverlay'),
            busyMessage: document.getElementById('busyMessage'),
            busySubmessage: document.getElementById('busySubmessage'),
            busyHint: document.getElementById('busyHint'),
            busyNote: document.getElementById('busyNote'),
            busyCancel: document.getElementById('busyCancel'),
            sidTitle: document.getElementById('sidTitle'),
            sidAuthor: document.getElementById('sidAuthor'),
            sidCopyright: document.getElementById('sidCopyright'),
            sidFormat: document.getElementById('sidFormat'),
            sidVersion: document.getElementById('sidVersion'),
            sidSongs: document.getElementById('sidSongs'),
            loadAddress: document.getElementById('loadAddress'),
            initAddress: document.getElementById('initAddress'),
            playAddress: document.getElementById('playAddress'),
            memoryRange: document.getElementById('memoryRange'),
            fileSize: document.getElementById('fileSize'),
            zpUsage: document.getElementById('zpUsage'),
            clockType: document.getElementById('clockType'),
            sidModel: document.getElementById('sidModel'),
            sidChipCount: document.getElementById('sidChipCount'),
            maxCycles: document.getElementById('maxCycles'),
            exportSection: document.getElementById('exportSection'),
            visualizerGrid: document.getElementById('visualizerGrid'),
            compressionType: document.getElementById('compressionType'),
            exportModifiedSIDButton: document.getElementById('exportModifiedSIDButton'),
            exportPRGButton: document.getElementById('exportPRGButton'),
            exportStatus: document.getElementById('exportStatus'),
            exportHint: document.getElementById('exportHint'),
            memoryMap: document.getElementById('memoryMap'),
            bakeTimeline: document.getElementById('bakeTimeline'),
            loopInfo: document.getElementById('loopInfo')
        };
    }

    initEventListeners() {
        this.elements.uploadBtn.addEventListener('click', () => {
            this.elements.fileInput.click();
        });

        this.elements.hvscBtn.addEventListener('click', () => {
            this.openHVSCBrowser();
        });

        this.elements.randomBtn.addEventListener('click', () => {
            this.selectRandomSID();
        });

        this.elements.uploadSection.addEventListener('click', () => {
            this.elements.fileInput.click();
        });

        this.elements.fileInput.addEventListener('change', (e) => {
            this.handleFileSelect(e);
        });

        this.elements.exportModifiedSIDButton.addEventListener('click', () => {
            this.exportModifiedSID();
        });

        this.elements.exportPRGButton.addEventListener('click', () => {
            this.exportPRGWithVisualizer();
        });

        // Song Looping toggle (Song tab): a manual change is a decision - the
        // fade-out prompt won't second-guess it - and the status line + Studio
        // manifest refresh so every later export reflects the new choice.
        const forceLoopToggle = document.getElementById('forceLoopToggle');
        if (forceLoopToggle) {
            forceLoopToggle.addEventListener('change', () => {
                this._loopChoiceTouched = true;
                this.updateSongLoopStatus();
                if (window.studioModal) window.studioModal.queueRefresh();
            });
        }

        this.setupDragAndDrop();
        this.setupEditableFields();

        // Receive selection events from the HVSC browser. The browser runs in
        // THIS window and self-posts (hvsc-browser.js emitSelection), so only a
        // same-window, same-origin message is legitimate. Without this check any
        // page that can reference our window (an opener, or a framing page) could
        // post a forged {type:'sid-selected', url:...} and make the app fetch and
        // load an attacker-chosen SID as if the user picked it from HVSC.
        window.addEventListener('message', (e) => {
            if (e.source !== window || e.origin !== location.origin) return;
            if (e.data && e.data.type === 'sid-selected') {
                this.handleHVSCSelection(e.data);
            }
        });

        const closeBtn = document.getElementById('hvscModalClose');
        const closeHVSCModal = (fromHistory = false) => {
            const modal = document.getElementById('hvscModal');
            if (!modal.classList.contains('visible')) return;
            modal.classList.remove('visible');
            if (!fromHistory) this.popModalHistory();
            if (window.hvscBrowser) {
                hvscBrowser.stopPreview();
                // Browser closed: drop the shareable ?tune= param from the URL.
                if (hvscBrowser.clearShareUrl) hvscBrowser.clearShareUrl();
            }
            // Return focus to whatever opened the browser.
            if (this._hvscPreviouslyFocused && typeof this._hvscPreviouslyFocused.focus === 'function') {
                this._hvscPreviouslyFocused.focus();
            }
            this._hvscPreviouslyFocused = null;
        };

        if (closeBtn) {
            closeBtn.addEventListener('click', () => closeHVSCModal());
        }

        // Click on backdrop (not modal content) closes the modal.
        const hvscModal = document.getElementById('hvscModal');
        if (hvscModal) {
            hvscModal.addEventListener('click', (e) => {
                if (e.target === hvscModal) closeHVSCModal();
            });
        }
        this._closeHVSCModal = closeHVSCModal;
        this.wireModalHistory();

        // While the browser is open it owns the keyboard: Escape closes it and
        // Tab is trapped inside so focus can't fall through to the covered page.
        // Defer when another modal is layered above (that modal owns the keyboard).
        // This list used to be maintained by hand here and had already drifted -
        // overlay-stack.js reads it off the overlays actually on screen instead.
        document.addEventListener('keydown', (e) => {
            if (!document.getElementById('hvscModal')?.classList.contains('visible')) return;
            if (window.overlayAbove && window.overlayAbove('hvscModal')) return;
            if (e.key === 'Escape') closeHVSCModal();
            else if (e.key === 'Tab') this._trapHvscTab(e);
            return;
        });

        // The drifting background notes: an off switch of their own, because
        // "I find this distracting" is not the same preference as the OS
        // reduced-motion setting.
        // Reads and writes the stored preference directly: floating-notes.js
        // loads when the browser is idle, so its class may not exist yet - and
        // when it does not, the preference it reads on arrival is already right.
        const notesToggle = document.getElementById('notesToggle');
        if (notesToggle) {
            let off = false;
            try { off = localStorage.getItem('sidquakeNotesOff') === '1'; } catch (e) { /* blocked */ }
            notesToggle.checked = !off;
            notesToggle.addEventListener('change', () => {
                const nowOff = !notesToggle.checked;
                try { localStorage.setItem('sidquakeNotesOff', nowOff ? '1' : '0'); } catch (e) { /* blocked */ }
                if (window.FreshFloatingNotes) window.FreshFloatingNotes.setTurnedOff(nowOff);
            });
        }

        // Show placeholder content until a SID is loaded.
        this.initializeAttractMode();
    }

    async ensureMainPlayer() {
        if (this.mainPlayer) return this.mainPlayer;
        const container = document.getElementById('mainPlayerContainer');
        if (!container) return null;
        await Promise.all([
            window.loadScript('sid-playback.js'),
            window.loadScript('sid-player.js')
        ]);
        this.mainPlayer = new SIDPlayer(container);
        return this.mainPlayer;
    }

    // Android has no Escape key, and Back is what people press to leave a
    // full-screen thing. Without this it navigates off the site instead, which
    // on a phone is the only way out of a modal.
    pushModalHistory(id) {
        try {
            history.pushState(Object.assign({}, history.state || {}, { sqModal: id }), '', location.href);
            this._modalHistoryDepth = (this._modalHistoryDepth || 0) + 1;
        } catch (e) { /* history unavailable - Escape and the close button still work */ }
    }

    /** Consume the entry pushed for a modal the user just closed some other way. */
    popModalHistory() {
        if (!this._modalHistoryDepth) return;
        this._modalHistoryDepth--;
        try { history.back(); } catch (e) { /* nothing to go back to */ }
    }

    wireModalHistory() {
        if (this._modalHistoryWired) return;
        this._modalHistoryWired = true;
        window.addEventListener('popstate', () => {
            // Topmost first, so Back peels one layer at a time.
            if (this._modalHistoryDepth) this._modalHistoryDepth--;
            const hvsc = document.getElementById('hvscModal');
            if (hvsc && hvsc.classList.contains('visible')) {
                if (this._closeHVSCModal) this._closeHVSCModal(true);
                return;
            }
            if (window.studioModal && window.studioModal.isOpen) {
                window.studioModal.close(true);
            }
        });
    }

    async openHVSCBrowser() {
        const modal = document.getElementById('hvscModal');
        // Remember what to restore focus to, then move focus into the browser.
        this._hvscPreviouslyFocused = document.activeElement;
        modal.classList.add('visible');
        this.pushModalHistory('hvsc');
        const searchBar = document.getElementById('hvscSearchBar');
        if (searchBar) searchBar.focus();

        await window.loadScript('hvsc-browser.js');

        if (typeof hvscBrowser.initializeHVSC === 'function') {
            hvscBrowser.initializeHVSC();
        } else if (!window.hvscBrowserInitialized) {
            hvscBrowser.fetchDirectory('C64Music');
            window.hvscBrowserInitialized = true;
        }
    }

    // Keep Tab focus cycling within the open HVSC browser modal.
    _trapHvscTab(e) {
        const content = document.querySelector('#hvscModal .hvsc-modal-content');
        if (!content) return;
        const focusable = [...content.querySelectorAll(
            'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter(el => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!content.contains(active)) {
            e.preventDefault();
            first.focus();
            return;
        }
        if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }

    async selectRandomSID() {
        // Cancellable: this fetches a pool file and then a tune, and a phone on a
        // slow connection should not be stuck behind an overlay with no way out.
        const randomAc = new AbortController();
        this.showBusy('Finding Random SID', 'Exploring HVSC collection...', () => randomAc.abort());

        try {
            await window.loadScript('hvsc-random.js');

            const result = await window.hvscRandom.selectRandomSID(5, (message) => {
                this.updateBusy('Finding Random SID', message);
            });

            this.hideBusy();

            this.elements.hvscSelected.style.display = 'block';
            this.elements.selectedFile.textContent = result.name;

            this.showModal('Downloading SID from HVSC...', true);

            const response = await fetch(result.url, { signal: randomAc.signal });

            if (!response.ok) {
                throw new Error('Failed to download SID file');
            }

            const blob = await response.blob();
            const file = new File([blob], result.name, { type: 'application/octet-stream' });

            await this.processFile(file, { autoplay: true });

        } catch (error) {
            this.hideBusy();
            // A user cancel is not a failure - say nothing and leave them where
            // they were.
            if (error && error.name === 'AbortError') return;
            console.error('Error selecting random SID:', error);
            this.showModal('Failed to select random SID: ' + error.message, false);
        }
    }

    async handleHVSCSelection(data) {

        this.elements.hvscSelected.style.display = 'block';
        this.elements.selectedFile.textContent = data.name;

        const modal = document.getElementById('hvscModal');
        modal.classList.remove('visible');

        this.showModal('Downloading SID from HVSC...', true);

        try {
            const response = await fetch(data.url);

            if (!response.ok) {
                throw new Error(`Failed to fetch ${data.url}: ${response.status}`);
            }

            const blob = await response.blob();
            const file = new File([blob], data.name, { type: 'application/octet-stream' });

            await this.processFile(file, { autoplay: true });

        } catch (error) {
            console.error('Error downloading HVSC file:', error);
            const hint = window.hvscFetchHint ? window.hvscFetchHint(error.message) : null;
            this.showModal(
                hint && hint !== error.message ? hint : 'Failed to download SID from HVSC',
                false
            );
        }
    }

    initializeAttractMode() {
        this.elements.sidTitle.value = 'Song Title';
        this.elements.sidAuthor.value = 'Artist Name';
        this.elements.sidCopyright.value = 'Copyright Info';

        this.elements.sidFormat.textContent = 'PSID';
        this.elements.sidVersion.textContent = 'v2';
        this.elements.sidSongs.textContent = '1/1';

        this.elements.loadAddress.textContent = '$1000';
        this.elements.initAddress.textContent = '$1000';
        this.elements.playAddress.textContent = '$1003';
        this.elements.memoryRange.textContent = '$1000 - $2FFF';
        this.elements.fileSize.textContent = '8192 bytes';
        this.elements.zpUsage.textContent = '$02-$FF';
        this.elements.clockType.textContent = 'PAL';
        this.elements.sidModel.textContent = 'MOS 6581';

        const numCallsElement = document.getElementById('numCallsPerFrame');
        if (numCallsElement) {
            numCallsElement.textContent = '1';
        }

        const maxCyclesElement = document.getElementById('maxCycles');
        if (maxCyclesElement) {
            maxCyclesElement.textContent = '4000';
        }

        if (this.elements.sidChipCount) {
            this.elements.sidChipCount.textContent = '1';
        }

        const modifiedMemoryElement = document.getElementById('modifiedMemoryCount');
        if (!modifiedMemoryElement) {
            const infoPanels = document.getElementById('infoPanels');
            const technicalPanel = infoPanels.querySelector('.panel:nth-child(2)');

            const modifiedRow = document.createElement('div');
            modifiedRow.id = 'modifiedMemoryRow';
            modifiedRow.className = 'info-row';
            modifiedRow.innerHTML = `
        <span class="info-label">Modified Memory:</span>
        <span class="info-value" id="modifiedMemoryCount">0 locations</span>
    `;

            // Insert above the Clock Type row to keep panel ordering consistent.
            const clockTypeRow = technicalPanel.querySelector('.info-row:nth-last-child(3)');
            if (clockTypeRow) {
                technicalPanel.insertBefore(modifiedRow, clockTypeRow);
            } else {
                technicalPanel.appendChild(modifiedRow);
            }
        } else {
            modifiedMemoryElement.textContent = '0 locations';
        }

        this.buildAttractModeVisualizerGrid();
    }

    buildAttractModeVisualizerGrid() {
        const grid = document.getElementById('visualizerGrid');
        if (!grid) return;

        grid.innerHTML = '';

        // Same filter the real grid applies: the shadow / spectrometer variants
        // are reached through the Method tab, not as separate cards, so showing
        // them here rendered the same list two different ways.
        const shown = VISUALIZERS.filter(v => !v.hidden);
        for (let i = 0; i < shown.length; i++) {
            const viz = shown[i];
            const card = this.createVisualizerCard(viz);
            card.classList.add('disabled');
            card.style.pointerEvents = 'none';

            // Highlight the first card so the grid doesn't look unselected.
            if (i === 0) {
                card.classList.add('selected');
            }

            grid.appendChild(card);
        }
    }

    setupDragAndDrop() {
        const uploadSection = this.elements.uploadSection;

        // The dedicated drop zone keeps its own local highlight...
        uploadSection.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadSection.classList.add('dragover');
        });
        uploadSection.addEventListener('dragleave', () => {
            uploadSection.classList.remove('dragover');
        });

        // ...but the file load is handled at the document level so a drop
        // ANYWHERE loads the tune. Previously a drop a few px outside the zone -
        // or anywhere while the Studio modal was open (the zone isn't even
        // visible then) - hit the browser default and NAVIGATED the tab to the
        // .sid file, silently discarding the loaded tune and all Studio settings.
        // A dragenter/leave counter drives a whole-window "drop to load" cue
        // without the flicker a naive dragleave (fired crossing child elements)
        // would cause. processFile validates the extension, so non-SID drops are
        // rejected gracefully rather than needing a guard here.
        let dragDepth = 0;
        const hasFiles = (e) => e.dataTransfer &&
            Array.from(e.dataTransfer.types || []).includes('Files');

        document.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (dragDepth++ === 0) document.body.classList.add('file-dragging');
        });
        document.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        document.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            if (--dragDepth <= 0) {
                dragDepth = 0;
                document.body.classList.remove('file-dragging');
            }
        });
        document.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth = 0;
            document.body.classList.remove('file-dragging');
            uploadSection.classList.remove('dragover');
            this.acceptFiles(e.dataTransfer.files).catch((err) => {
                console.error('Error processing dropped file:', err);
            });
        });
    }

    // Title / Author / Copyright. Real inputs: they were contenteditable spans
    // with role="button" and an aria-label that overrode their contents, so a
    // screen reader announced "Edit title, button" and never the title. This is
    // a form, and the text goes on the C64 screen, so it says how much room is
    // left and warns when a character cannot survive the trip.
    setupEditableFields() {
        for (const field of [this.elements.sidTitle, this.elements.sidAuthor, this.elements.sidCopyright]) {
            if (!field) continue;
            field.addEventListener('input', () => this.onMetadataInput(field));
            field.addEventListener('blur', () => {
                // Collapse the whitespace only once the user has stopped typing;
                // doing it per keystroke fights them mid-word.
                const tidy = field.value.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
                if (tidy !== field.value) {
                    field.value = tidy;
                    this.onMetadataInput(field);
                }
            });
        }
        this.updateMetadataCounts();
    }

    // One edit: push it to the WASM header (what a saved .sid is built from), to
    // the cached header (what the PRG's text rows are painted from), and to the
    // counters and the warning line.
    onMetadataInput(field) {
        const text = field.value;
        // The DOM field uses 'title' but the WASM analyzer expects 'name'.
        const fieldName = field.dataset.field;
        const analyzerFieldName = fieldName === 'title' ? 'name' : fieldName;

        this.analyzer.updateMetadata(analyzerFieldName, text);
        for (const h of [this.sidHeader, this.analyzer.sidHeader]) {
            if (h) h[analyzerFieldName] = text;
        }
        if (window.studioModal) window.studioModal.refreshHeader();
        this.updateMetadataCounts();
        this.checkForModifications();
        // What these lines will look like on the C64. Debounced: it decodes a
        // charset and repaints, and someone typing a title does it per keystroke.
        clearTimeout(this._textPreviewTimer);
        this._textPreviewTimer = setTimeout(() => this.renderTextPreview(), 200);
        if (window.studioModal) window.studioModal.queueRefresh();
    }

    /** Characters left in each 31-char header field, and what the C64 can't show. */
    updateMetadataCounts() {
        const fields = [this.elements.sidTitle, this.elements.sidAuthor, this.elements.sidCopyright];
        const lost = new Set();
        for (const field of fields) {
            if (!field) continue;
            const count = document.getElementById(field.id + 'Count');
            const left = 31 - field.value.length;
            if (count) {
                count.textContent = left <= 8 ? `${left} left` : '';
                count.classList.toggle('is-low', left <= 3);
            }
            for (const ch of this.unrepresentableChars(field.value)) lost.add(ch);
        }

        const warn = document.getElementById('metadataWarning');
        if (!warn) return;
        if (!lost.size) { warn.hidden = true; warn.textContent = ''; return; }
        const list = [...lost].map(c => `"${c}"`).join(' ');
        warn.hidden = false;
        warn.textContent = `The C64 has no ${list} — ${lost.size === 1 ? 'it' : 'they'} `
            + `will show as ${lost.size === 1 ? 'a space' : 'spaces'}.`;
    }

    // Which characters of `text` the PETSCII conversion would silently replace.
    // prg-builder sanitises metadata with reportUnknown off, so this was only
    // ever discovered by looking at the exported PRG in an emulator.
    unrepresentableChars(text) {
        if (!text || typeof PETSCIISanitizer === 'undefined') return [];
        try {
            const result = new PETSCIISanitizer().sanitize(text, { reportUnknown: true });
            const warning = (result.warnings || []).find(w => w.type === 'unknown_characters');
            // The sanitizer reports them quoted or as U+XXXX; show the character
            // where it is printable, since that is what the user typed.
            return warning ? warning.characters.map(c => c.replace(/^"|"$/g, '')) : [];
        } catch (e) {
            return [];
        }
    }

    checkForModifications() {
        const currentTitle = this.elements.sidTitle.value.trim();
        const currentAuthor = this.elements.sidAuthor.value.trim();
        const currentCopyright = this.elements.sidCopyright.value.trim();

        const hasChanges =
            currentTitle !== this.originalMetadata.title ||
            currentAuthor !== this.originalMetadata.author ||
            currentCopyright !== this.originalMetadata.copyright;

        this.hasModifications = hasChanges;

        this.elements.exportModifiedSIDButton.disabled = !hasChanges;

        if (this.elements.exportHint) {
            this.elements.exportHint.style.display = hasChanges ? 'none' : 'block';
        }
    }

    async handleFileSelect(event) {
        await this.acceptFiles(event.target.files);
    }

    // ---------------------------------------------------------------------
    // Quick export
    // ---------------------------------------------------------------------

    // Two decisions and a button: which look, then press it. Everything the
    // Studio offers still applies - this just sets the look and reuses the same
    // export - but a first release should not require walking six tabs to find
    // out that every default was already correct.
    renderQuickExport() {
        const box = document.getElementById('quickExport');
        const looks = document.getElementById('quickExportLooks');
        if (!box || !looks) return;
        if (!this.sidHeader) { box.hidden = true; return; }

        const compatible = (typeof VISUALIZERS !== 'undefined' ? VISUALIZERS : [])
            .filter(v => !v.hidden && this.visualizerExportable(v).ok);
        if (!compatible.length) { box.hidden = true; return; }

        // A handful of clearly different looks, in the order someone would scan
        // them - not the whole grid again. Plain text first, then the same
        // thing with a picture, then bars, bars with a picture, and two that
        // are neither: each step is one visible change from the one before it.
        const QUICK_LOOKS = 6;
        const order = ['default', 'DefaultWithLogo', 'RaistlinBars',
            'RaistlinBarsWithLogo', 'RaistlinMirrorBars', 'MusicalBlobs'];
        const picks = order.map(id => compatible.find(v => v.id === id)).filter(Boolean);
        // A tune that cannot take one of them (too little room, wrong call
        // rate) would otherwise leave a gap, so top the row back up from
        // whatever else is exportable.
        for (const v of compatible) {
            if (picks.length >= QUICK_LOOKS) break;
            if (!picks.includes(v)) picks.push(v);
        }
        picks.length = Math.min(picks.length, QUICK_LOOKS);
        if (!picks.length) picks.push(compatible[0]);

        const current = this.selectedVisualizer?.dataSourceGroup || this.selectedVisualizer?.id;
        // The selected player may not be one of the few offered here. Something
        // still has to carry the group's tab stop, or it cannot be reached by
        // keyboard at all.
        const marked = picks.some(v => v.id === current) ? current : null;
        const esc = (t) => String(t).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        looks.innerHTML = picks.map((v, i) => {
            const on = v.id === marked;
            const tabbable = marked ? on : i === 0;
            return `<button type="button" class="quick-look${on ? ' selected' : ''}"
                     role="radio" aria-checked="${on}" tabindex="${tabbable ? 0 : -1}"
                     data-id="${esc(v.id)}">
                <img src="${esc(v.preview)}" alt="" aria-hidden="true">
                <span>${esc(v.name)}</span>
            </button>`;
        }).join('');
        box.hidden = false;
        this._wireQuickExport();
        // The bars-are-blind warning belongs to the look now selected, so it is
        // re-decided with the row (the check itself is cached per tune).
        this.renderVuNotes();
    }

    _wireQuickExport() {
        const looks = document.getElementById('quickExportLooks');
        if (looks && !looks.dataset.wired) {
            looks.dataset.wired = '1';
            looks.addEventListener('click', (e) => {
                const btn = e.target.closest('.quick-look');
                if (btn) this.quickPickLook(btn.dataset.id);
            });
            looks.addEventListener('keydown', (e) => {
                const btns = [...looks.querySelectorAll('.quick-look')];
                const here = e.target.closest('.quick-look');
                const i = here ? btns.indexOf(here) : 0;
                let next = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = btns[(i + 1) % btns.length];
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = btns[(i - 1 + btns.length) % btns.length];
                else if (e.key === ' ' || e.key === 'Enter') next = here;
                else return;
                e.preventDefault();
                if (next) { this.quickPickLook(next.dataset.id); next.focus(); }
            });
        }
        const go = document.getElementById('quickExportBtn');
        if (go && !go.dataset.wired) {
            go.dataset.wired = '1';
            go.addEventListener('click', () => this.exportPRGWithVisualizer());
        }
    }

    async quickPickLook(id) {
        const viz = (typeof VISUALIZERS !== 'undefined') && VISUALIZERS.find(v => v.id === id);
        if (!viz) return;
        await this.selectVisualizer(viz);
        this.renderQuickExport();
        await this.quickChooseImage();
    }

    // A look built around a picture is not finished when it is picked: without
    // this the quick path exports the player's stock logo, which is the one
    // image nobody wants on their release. So the gallery opens straight away
    // for the picture slot the chosen look has.
    //
    // Once per look, not once per picture slot: the slot is remembered across
    // visualizers (and across sessions), so keying on it meant the first look
    // picked was the only one that ever asked - every other look silently
    // inherited whatever that one ended on. Closing the gallery is still an
    // answer, and coming back to a look already asked about is not re-asked.
    async quickChooseImage() {
        try { await this._optionsReady; } catch (e) { return; }
        const config = this.currentVisualizerConfig;
        const mgr = window.imagePreviewManager;
        const container = document.getElementById('studioPanels');
        if (!config || !config.inputs || !mgr || !container) return;
        // The look, not the variant: switching bar method is not a new picture.
        const look = this.selectedVisualizer?.dataSourceGroup || this.selectedVisualizer?.id;
        this._quickImageAsked = this._quickImageAsked || new Set();
        if (!look || this._quickImageAsked.has(look)) return;
        for (const input of config.inputs) {
            if (!this._isImageInput(input) || !(input.gallery || []).length) continue;
            this._quickImageAsked.add(look);
            mgr.initGalleryModal().open(input, container);
            return;   // one picture at a time; the rest stay on the Picture tab
        }
    }

    // ---------------------------------------------------------------------
    // Batch queue
    // ---------------------------------------------------------------------

    // One or many SIDs, from the picker or a drop. The first is loaded as
    // always; the rest wait in a queue that can be exported with whatever
    // settings the user then chooses. Dropping a folder of tunes used to load
    // one and silently discard the others.
    async acceptFiles(fileList) {
        const all = [...(fileList || [])];
        // A settings file dropped on the page applies itself. It carries no
        // tune, so it never disturbs what is loaded.
        const recipes = all.filter(f => /\.json$/i.test(f.name));
        for (const f of recipes) {
            try {
                const parsed = JSON.parse(await f.text());
                // Held for the run: every tune in a queue gets these settings,
                // rather than the first one's carrying over by luck.
                if (await this.applyRecipe(parsed)) this._queueRecipe = parsed;
            } catch (e) {
                this.setRecipeNote(`Could not read ${f.name}.`, true);
            }
        }
        const files = all.filter(f => /\.sid$/i.test(f.name));
        if (!files.length) return;
        this.elements.hvscSelected.style.display = 'none';
        this._queue = files.map(f => ({ file: f, state: 'pending', note: '' }));
        this._queue[0].state = 'loaded';
        this.renderQueue();
        await this.processFile(files[0]);
    }

    renderQueue() {
        const box = document.getElementById('sidQueue');
        if (!box) return;
        this._wireQueueControls();
        const q = this._queue || [];
        // One file is not a queue - the Studio already tells you what is loaded.
        if (q.length < 2) { box.hidden = true; return; }
        box.hidden = false;

        const done = q.filter(i => i.state === 'done').length;
        const failed = q.filter(i => i.state === 'failed').length;
        document.getElementById('sidQueueTitle').textContent =
            `${q.length} tunes queued${done ? ` · ${done} exported` : ''}${failed ? ` · ${failed} failed` : ''}`;

        const note = document.getElementById('sidQueueNote');
        if (note) {
            // Say when a dropped settings file - not the panels in front of the
            // user - is what every tune will be built with.
            const fromRecipe = this._queueRecipe
                ? ' Every tune is built from the settings file you dropped.' : '';
            note.textContent = (this._queueRunning
                ? 'Exporting each tune with the settings below. Every file lands in your downloads.'
                : 'Set up the first tune the way you want the whole set, then export them all. '
                + 'Each one is measured and built with the same visualizer and options.')
                + fromRecipe;
        }

        const icon = { pending: '·', loaded: '▸', building: '…', done: '✓', failed: '✕' };
        document.getElementById('sidQueueList').innerHTML = q.map((item, i) => `
            <li class="sq-item sq-${item.state}">
                <span class="sq-mark" aria-hidden="true">${icon[item.state] || '·'}</span>
                <span class="sq-name">${String(item.file.name).replace(/[&<>"]/g, c =>
                    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span>
                <span class="sq-note">${item.note ? String(item.note).replace(/[&<>]/g, '') : ''}</span>
            </li>`).join('');

        document.getElementById('sidQueueRun').hidden = this._queueRunning;
        document.getElementById('sidQueueStop').hidden = !this._queueRunning;
    }

    _wireQueueControls() {
        if (this._queueWired) return;
        this._queueWired = true;
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };
        on('sidQueueRun', () => this.runQueue());
        const dest = document.getElementById('queueDestination');
        if (dest) {
            // showDirectoryPicker is Chromium-only, so the folder option is only
            // offered where it exists; the zip is the answer everywhere else.
            const folderOpt = dest.querySelector('option[value="folder"]');
            if (folderOpt && typeof window.showDirectoryPicker !== 'function') folderOpt.remove();
            try {
                const saved = localStorage.getItem('sidquakeQueueDest');
                if (saved && dest.querySelector(`option[value="${saved}"]`)) dest.value = saved;
            } catch (e) { /* blocked */ }
            dest.addEventListener('change', async () => {
                try { localStorage.setItem('sidquakeQueueDest', dest.value); } catch (e) { /* blocked */ }
                this._outputDir = null;
                if (dest.value === 'folder') await this._pickOutputDir();
                this._renderDestinationNote();
            });
            this._renderDestinationNote();
        }
        on('sidQueueStop', () => { this._queueStop = true; });
        on('sidQueueClear', () => {
            this._queue = [];
            this._queueStop = true;
            // Clearing the set clears what it was going to be built from too.
            this._queueRecipe = null;
            this.renderQueue();
        });
    }

    /** Where a queue run should put its files. */
    queueDestination() {
        const el = document.getElementById('queueDestination');
        return (el && el.value) || 'downloads';
    }

    async _pickOutputDir() {
        try {
            this._outputDir = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
            // The user closed the picker, or the browser refused: fall back to
            // the zip rather than silently exporting somewhere they did not ask.
            this._outputDir = null;
            const el = document.getElementById('queueDestination');
            if (el) el.value = 'zip';
        }
    }

    _renderDestinationNote() {
        const note = document.getElementById('queueDestinationNote');
        if (!note) return;
        const where = this.queueDestination();
        if (where === 'zip') {
            note.textContent = 'One download at the end, with every file in it.';
        } else if (where === 'folder') {
            note.textContent = this._outputDir
                ? `Writing into “${this._outputDir.name}”.`
                : 'Choose the folder when the run starts.';
        } else {
            note.textContent = 'One download per tune.';
        }
    }

    // Export every queued tune with the current settings. The visualizer choice
    // and the option values are already sticky across a load, so "the same look
    // for the whole set" needs nothing extra - but a tune the chosen visualizer
    // cannot fit falls back to another one, and that is worth reporting.
    async runQueue() {
        if (this._queueRunning || !(this._queue || []).length) return;
        this._queueRunning = true;
        this._queueStop = false;
        const wanted = this._lastVisualizerId;
        const recipe = this._queueRecipe || null;

        // Collect what the run produces instead of downloading each file.
        const where = this.queueDestination();
        if (where === 'folder' && !this._outputDir) {
            await this._pickOutputDir();
            this._renderDestinationNote();
        }
        const collected = [];
        if (where !== 'downloads') this._fileSink = (data, name) => collected.push({ data, name });

        this.renderQueue();
        try {
            for (const item of this._queue) {
                if (this._queueStop) { item.state = item.state === 'done' ? 'done' : 'pending'; continue; }
                item.state = 'building';
                item.note = '';
                this.renderQueue();
                try {
                    await this.processFile(item.file);
                    // Re-apply the settings file the set was dropped with. Not
                    // its song block: sub-tune and loop answer belong to the
                    // tune it was made from.
                    if (recipe) await this.applyRecipe(recipe, { perTune: false, quiet: true });
                    const got = this.selectedVisualizer?.dataSourceGroup
                        || this.selectedVisualizer?.id;
                    if (wanted && got !== wanted) {
                        item.note = `used ${this.selectedVisualizer?.name || 'another player'}`;
                    }
                    await this.exportPRGWithVisualizer();
                    item.state = this._lastExportOk ? 'done' : 'failed';
                    if (!this._lastExportOk) item.note = this._lastExportMessage || 'export failed';
                } catch (e) {
                    item.state = 'failed';
                    item.note = e && e.message ? e.message : 'failed';
                }
                this.renderQueue();
            }
        } finally {
            this._fileSink = null;
            this._queueRunning = false;
            this._queueStop = false;
            await this._deliverQueueFiles(collected);
            this.renderQueue();
        }
    }

    /**
     * Hand over what a run collected: written into the chosen folder, or bundled
     * into one zip. Anything that cannot be written falls back to a download, so
     * a refused permission never loses a file the user has already waited for.
     */
    async _deliverQueueFiles(files) {
        if (!files.length) return;
        const dir = this._outputDir;
        if (dir) {
            const failed = [];
            for (const f of files) {
                try {
                    const handle = await dir.getFileHandle(f.name, { create: true });
                    const w = await handle.createWritable();
                    await w.write(f.data);
                    await w.close();
                } catch (e) {
                    failed.push(f);
                }
            }
            if (!failed.length) {
                this.showExportStatus(`${files.length} files written into “${dir.name}”.`, 'success');
                return;
            }
            this.showExportStatus(
                `${failed.length} of ${files.length} files could not be written into “${dir.name}” — `
                + 'they are in your downloads instead.', 'warning');
            for (const f of failed) this._downloadDirect(f.data, f.name);
            return;
        }

        if (typeof window.makeZip !== 'function') {
            for (const f of files) this._downloadDirect(f.data, f.name);
            return;
        }
        this._downloadDirect(
            window.makeZip(files.map(f => ({
                name: f.name,
                bytes: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data),
            }))),
            'sidquake-set.zip');
        this.showExportStatus(`${files.length} files bundled into sidquake-set.zip.`, 'success');
    }

    /** downloadFile without the queue's diversion. */
    _downloadDirect(data, filename) {
        const sink = this._fileSink;
        this._fileSink = null;
        try { this.downloadFile(data, filename); } finally { this._fileSink = sink; }
    }

    // opts.autoplay: the tune was chosen by an explicit click (Random SID, an
    // HVSC pick), so start it playing rather than making the user hunt for the
    // play button under whatever opened on top.
    async processFile(file, opts = {}) {
        if (!file.name.toLowerCase().endsWith('.sid')) {
            this.showModal('Please select a valid SID file', false);
            return;
        }

        this.currentFileName = file.name;
        this.hasModifications = false;
        const autoplay = !!(opts && opts.autoplay);
        this.elements.exportModifiedSIDButton.disabled = true;

        // A scan for the previous tune is now pointless, and its result must not
        // land on this one: bump the token first, then stop it.
        this._analysisToken++;
        this.cancelAnalysis();
        this._hideAnalysisChip();
        // Stopping the previous tune's scan is not a decision about this one.
        this._analysisCancelled = false;

        this.showBusy('Loading SID File', 'Initializing...');
        this.hideMessages();

        try {
            // Inside the try so a failed dynamic script load can't leave the
            // full-screen busy overlay stuck forever.
            await this.ensureAnalyzer();
            this.updateBusy('Loading SID File', 'Reading and analyzing file...');

            const buffer = await file.arrayBuffer();

            const player = await this.ensureMainPlayer();
            if (player) {
                player.loadFromBinary(new Uint8Array(buffer), file.name, { autoplay });
            }

            this.updateBusy('Parsing SID Header', 'Extracting metadata...');

            const header = await this.analyzer.loadSID(buffer);
            this.sidHeader = header;
            this.analyzer.sidHeader = header;
            if (window.studioModal) window.studioModal.refreshHeader();

            this.originalMetadata = {
                title: header.name || '',
                author: header.author || '',
                copyright: header.copyright || ''
            };

            this.updateFileInfo(header);
            this.updateTechnicalInfo(header);
            this.updateSongTitle(header);

            const songs = header.songs || 1;
            this.updateBusy('Analyzing SID Music',
                songs > 1
                    ? `Running all ${songs} tunes to see what the music touches. The page pauses while it does.`
                    : 'Running the music to see what it touches. The page pauses while it does.');

            const frameCount = 30000;
            // sid_analyze blocks the main thread, so give the browser a frame to
            // put the message above on screen first - otherwise the freeze
            // arrives before the explanation for it does.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            this.analysisResults = await this.analyzer.analyze(frameCount);

            this.analyzer.analysisResults = this.analysisResults;

            this.updateZeroPageInfo(this.analysisResults.zpAddresses);
            this.updateModifiedMemoryCount();
            this.updateNumCallsPerFrame(this.analysisResults.numCallsPerFrame);
            this.updateMaxCycles(this.analysisResults.maxCycles);
            this.updateSidChipCount(this.analysisResults.sidChipCount, this.analysisResults.sidChipAddresses);

            this.elements.songTitleSection.classList.remove('disabled');
            this.elements.songTitleSection.classList.add('visible');
            const openStudioBtn = document.getElementById('openStudioBtn');
            if (openStudioBtn) openStudioBtn.style.display = '';

            this.showExportSection();
            this.renderQuickExport();

            // Cleared for the new tune; startBackgroundAnalysis below refills it
            // while the user is choosing a visualizer.
            this.tuneAnalysis = null;

            // ...and so does a widened search window: a long tune the user chose
            // to keep looking at says nothing about the next one.
            this._scanWindowOverride = 0;
            // New SID: the forced-loop decision belongs to the previous tune.
            this._loopChoiceTouched = false;
            this._loopChoiceAsked = false;
            const forceLoopToggle = document.getElementById('forceLoopToggle');
            if (forceLoopToggle) forceLoopToggle.checked = false;
            // A length typed for the previous tune says nothing about this one.
            const manualLen = document.getElementById('songLengthManual');
            if (manualLen) manualLen.value = '';
            this.updateSongLoopStatus();

            this.hideBusy();

            // Everything from here on happens in the Studio modal.
            if (window.studioModal) window.studioModal.openForNewFile();

            // Find the loop / end point in the background, so it is ready by the
            // time the user reaches Export instead of stopping them there.
            this.startBackgroundAnalysis();

            this.showModal(`Successfully analyzed: ${file.name}`, true);
        } catch (error) {
            this.hideBusy();
            this.showModal(`Error: ${error.message}`, false);
            console.error(error);
        }
    }

    showExportSection() {
        this.addSongSelector();

        this.initVisualizerSelection();

        // Kick off PRG exporter load eagerly so the user doesn't wait when they click Export.
        this.ensurePRGExporter().catch(err => {
            console.warn('PRG exporter background load failed, will retry on use:', err);
        });
    }

    // The tune selector is song metadata, so it sits on the Song tab - the
    // export manifest's "Music -> edit" has always pointed there, at a panel
    // that did not have it. The Spectrometer's multi-tune caveat is about the
    // visualizer choice instead, so it stays on the Visualizer tab.
    addSongSelector() {
        const mount = document.getElementById('songSelectorMount');
        const noteMount = document.getElementById('fftMultiSongMount');
        if (mount) mount.innerHTML = '';
        if (noteMount) noteMount.innerHTML = '';

        if (mount && this.sidHeader && this.sidHeader.songs > 1) {
            mount.innerHTML = `
            <div id="songSelectorContainer" class="export-option song-selector-container">
                <label for="songSelector">Which tune to use:</label>
                <select id="songSelector">
                    ${Array.from({ length: Math.min(this.sidHeader.songs, 256) }, (_, i) => i + 1)
                    .map(num => `<option value="${num}" ${num === this.sidHeader.startSong ? 'selected' : ''}>
                        Tune ${num} of ${this.sidHeader.songs}${num === this.sidHeader.startSong ? ' (the usual one)' : ''}
                    </option>`).join('')}
                </select>
            </div>`;
        }

        if (noteMount && this.sidHeader && this.sidHeader.songs > 1) {
            noteMount.innerHTML = `
            <div id="fftMultiSongNote" style="display:none;margin-top:8px;padding:8px 10px;border:1px solid rgba(255,183,77,.4);border-radius:6px;background:rgba(255,183,77,.08);font-size:12px;line-height:1.4">
                <b style="color:#ffb74d">This file holds several tunes.</b> The best-looking bars are worked
                out in advance, and that can only be done for one tune. If you carry on: the exported
                program plays and shows <b>only the tune chosen on the Song tab</b>, the buttons that switch
                between tunes stop working, and no song length is shown.
                To keep every tune, pick one of the live methods on the Method tab instead.
                <label style="display:flex;gap:6px;margin-top:8px;align-items:center;cursor:pointer">
                    <input type="checkbox" id="fftMultiSongConsent"> Yes — just the one tune</label>
            </div>`;
        }
        this.updateMultiSongNote();
    }

    // Show the multi-song caveat only when a multi-song SID is paired with the
    // FFT (Spectrometer) source, which bakes a single subtune.
    updateMultiSongNote() {
        const note = document.getElementById('fftMultiSongNote');
        if (!note) return;
        const multiSong = !!(this.sidHeader && this.sidHeader.songs > 1);
        const isFFT = this.selectedVisualizer?.dataSource === 'fft';
        // Only warn about the spectrometer caveat when a spectrometer export is
        // actually on offer - if the FFT variant can't fit this tune's memory, the
        // note is just noise (the user isn't being offered a spectrometer at all).
        const usableFFT = isFFT && this._variantFitsMemory(this.selectedVisualizer);
        note.style.display = (multiSong && usableFFT) ? 'block' : 'none';
    }

    async initVisualizerSelection() {
        this.selectedVisualizer = null;
        await window.loadScript('visualizer-configs.js');
        this.visualizerConfig = new VisualizerConfig();
        await Promise.all([
            this.loadAllVisualizerConfigs(),
            this.ensurePRGExporter()
        ]);
        this.buildVisualizerGrid();
    }

    async loadAllVisualizerConfigs() {
        // Fetch all configs concurrently - loading them one at a time made
        // the visualizer grid wait for N sequential round-trips.
        await Promise.all(VISUALIZERS.filter(viz => viz.config).map(async (viz) => {
            try {
                const config = await this.visualizerConfig.loadConfig(viz.id);
                if (config && config.maxCallsPerFrame !== undefined) {
                    viz.maxCallsPerFrame = config.maxCallsPerFrame;
                }
                viz.configData = config;
            } catch (error) {
                console.warn(`Could not load config for ${viz.id}:`, error);
            }
        }));
    }

    buildVisualizerGrid() {
        const grid = document.getElementById('visualizerGrid');
        if (!grid) return;

        grid.innerHTML = '';
        // Cards are radios (see createVisualizerCard), so the grid is the group.
        grid.setAttribute('role', 'radiogroup');
        grid.setAttribute('aria-label', 'Visualizer');

        const requiredCalls = this.analysisResults?.numCallsPerFrame || 1;

        const compatible = [];
        const incompatible = [];

        const modifiedAddresses = this.analysisResults?.modifiedAddresses || [];

        for (const viz of VISUALIZERS) {
            // Shadow/FFT variants are reached through the base card's data-source
            // selector, not shown as separate cards.
            if (viz.hidden) continue;
            if (viz.configData) {
                const validLayouts = this.prgExporter.selectValidLayouts(
                    viz.configData,
                    this.sidHeader.loadAddress,
                    // Full music-data size: dataBytes alone (analyzer's count of
                    // non-executed bytes) underestimates the SID's footprint and
                    // could mark a layout valid that overlaps the tune.
                    this.sidHeader.fileSize || this.analysisResults?.dataBytes || 0x2000,
                    modifiedAddresses
                );

                if (validLayouts.filter(l => l.valid).length === 0) {
                    incompatible.push(viz);
                } else {
                    compatible.push(viz);
                }
            } else {
                compatible.push(viz);
            }
        }

        compatible.sort((a, b) => a.name.localeCompare(b.name));
        incompatible.sort((a, b) => a.name.localeCompare(b.name));

        // Re-select the session's visualizer if this tune can take it; otherwise
        // fall back to the first compatible one so the export button is usable
        // immediately. Neither is a deliberate pick, so neither updates the
        // sticky choice (remember: false).
        const remembered = compatible.find(v => v.id === this._lastVisualizerId);
        const autoSelect = remembered || compatible.find(v => v.defaultPick) || compatible[0];

        for (const viz of compatible) {
            const card = this.createVisualizerCard(viz);
            grid.appendChild(card);

            if (viz === autoSelect) {
                this.selectVisualizer(viz, { remember: false });
                card.classList.add('selected');
            }
        }

        if (compatible.length > 0 && incompatible.length > 0) {
            const separator = document.createElement('div');
            separator.className = 'visualizer-separator';
            separator.innerHTML = '<span>These looks won\'t work with this tune — each says why</span>';
            separator.style.cssText = `
            grid-column: 1 / -1;
            text-align: center;
            padding: 20px;
            color: var(--text-muted);
            font-style: italic;
            border-top: 1px dashed #333;
            margin: 10px 0;
        `;
            grid.appendChild(separator);
        }

        for (const viz of incompatible) {
            const card = this.createVisualizerCard(viz);
            grid.appendChild(card);
        }
    }

    createVisualizerCard(visualizer) {
        const card = document.createElement('div');
        card.className = 'visualizer-card';
        card.dataset.id = visualizer.id;

        const requiredCalls = this.analysisResults?.numCallsPerFrame || 1;
        const requiredSidChips = this.analysisResults?.sidChipCount || 1;
        // Gate a bar card by the group's BEST source (Spectrometer), since that's
        // the default - a fast/multi-SID tune should still offer the card and just
        // restrict the "Live from SID" sub-options.
        const caps = this.groupCaps(visualizer);
        const tooManyCalls = requiredCalls > caps.maxCalls;
        const tooManySidChips = requiredSidChips > caps.maxSid;
        // No free memory layout for this tune (the SID sits where the player's
        // banks need to go, or its self-modified memory blows the save/restore
        // budget). Such a card can't build a working PRG, so it must not be
        // selectable - otherwise the export produces a crashing layout.
        const noMemoryFit = !this._visualizerFitsMemory(visualizer);
        const isDisabled = tooManyCalls || tooManySidChips || noMemoryFit;

        if (isDisabled) {
            card.classList.add('disabled');
        }

        // Why a look can't be built for THIS tune. Phrased around the look, not
        // the tune: "needs a slower tune" reads as "your music is wrong", and a
        // first-timer takes that personally. The specifics an expert wants (which
        // addresses are in the way, what the cap is) come after the plain
        // sentence rather than instead of it.
        let disabledMessage = '';
        if (noMemoryFit) {
            const lo = this.sidHeader?.loadAddress;
            const size = this.sidHeader?.fileSize || this.analysisResults?.dataBytes || 0;
            const hex = (n) => '$' + n.toString(16).toUpperCase().padStart(4, '0');
            const where = (lo != null && size)
                ? ` (it sits at ${hex(lo)}-${hex(lo + size - 1)})` : '';
            disabledMessage = `This look needs C64 memory your tune is already using${where}.`;
        } else if (tooManyCalls) {
            disabledMessage = `This look can't keep up with your tune — it plays `
                + `${requiredCalls} times per frame and this one handles `
                + `${caps.maxCalls}.`;
        } else if (tooManySidChips) {
            disabledMessage = caps.maxSid === 1
                ? `This look works with one SID chip; your tune uses ${requiredSidChips}.`
                : `This look works with up to ${caps.maxSid} SID chips; your tune uses ${requiredSidChips}.`;
        }

        const esc = (t) => String(t).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

        card.innerHTML = `
        <div class="visualizer-preview">
            <img src="${visualizer.preview}" alt="" aria-hidden="true"
                 onerror="this.onerror=null;this.src='previews/default.png'">
        </div>
        <div class="visualizer-info">
            <h3>${visualizer.name}</h3>
            ${visualizer.sceneName ? `<p class="visualizer-scene-name">${esc(visualizer.sceneName)}</p>` : ''}
            <p>${visualizer.description}</p>
            ${isDisabled ? `<p class="visualizer-reason">${esc(disabledMessage)}</p>` : ''}
        </div>
        <div class="visualizer-selected-badge"><i class="fas fa-check" aria-hidden="true"></i> Selected</div>
    `;

        // Radio semantics rather than a blanket aria-label: the label used to
        // override the card's contents, so neither the description nor the
        // "Selected" state was ever spoken.
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', 'false');
        if (isDisabled) {
            // Reachable, and it says why. Skipping it entirely left the user
            // asking a question the interface refused to answer.
            card.tabIndex = -1;
            card.setAttribute('aria-disabled', 'true');
        } else {
            const choose = () => this.selectVisualizer(visualizer);
            card.tabIndex = 0;
            card.addEventListener('click', choose);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose();
                }
            });
        }

        // Animate the preview on hover for visualizers that have an animated
        // version. Opt-in via `animated: true` in the registry (with a
        // prg/<id>.gif next to the .png) - that way we don't probe/404 for the
        // ones that only have a still. Probe first so a missing GIF never flickers.
        //
        // UNREACHABLE TODAY: no registry entry sets `animated: true` and there
        // are no .gif files in public/prg/, so every card shows a still of a
        // motion effect. The code is correct and waits on the assets - one
        // recording per visualizer, which has to be made in an emulator. Keep it
        // rather than rewriting it when they arrive.
        const img = card.querySelector('.visualizer-preview img');
        if (img && visualizer.animated && /\.png$/i.test(visualizer.preview)) {
            const still = visualizer.preview;
            const anim = visualizer.preview.replace(/\.png$/i, '.gif');
            let animOk = null; // null=unknown, true/false once probed
            card.addEventListener('mouseenter', () => {
                if (animOk === false) return;
                if (animOk === true) { img.src = anim; return; }
                const probe = new Image();
                probe.onload = () => { animOk = true; if (card.matches(':hover')) img.src = anim; };
                probe.onerror = () => { animOk = false; };
                probe.src = anim;
            });
            card.addEventListener('mouseleave', () => { img.src = still; });
        }

        return card;
    }

    // Best (most permissive) call/SID caps across a visualizer's data-source
    // group - a group is offered if ANY of its sources can handle the tune.
    groupCaps(visualizer) {
        const members = visualizer.dataSourceGroup
            ? VISUALIZERS.filter(v => v.dataSourceGroup === visualizer.dataSourceGroup)
            : [visualizer];
        let maxCalls = 0, maxSid = 0;
        for (const m of members) {
            maxCalls = Math.max(maxCalls, m.configData?.maxCallsPerFrame ?? Infinity);
            maxSid = Math.max(maxSid, m.configData?.maxSIDChips ?? Infinity);
        }
        return { maxCalls, maxSid };
    }

    // Is a specific data-source variant usable for the current tune?
    dataSourceUsable(variant) {
        const requiredCalls = this.analysisResults?.numCallsPerFrame || 1;
        const requiredSid = this.analysisResults?.sidChipCount || 1;
        const maxCalls = variant?.configData?.maxCallsPerFrame ?? Infinity;
        const maxSid = variant?.configData?.maxSIDChips ?? Infinity;
        if (requiredCalls > maxCalls) return { ok: false, reason: `needs ≤${maxCalls} call${maxCalls > 1 ? 's' : ''}/frame` };
        if (requiredSid > maxSid) return { ok: false, reason: maxSid === 1 ? 'single-SID only' : `needs ≤${maxSid} SID chips` };
        return { ok: true };
    }

    // Can this specific variant's graphics + code (+ save/restore) be placed
    // around the current tune? Mirrors the exporter's relocation placement via
    // selectValidLayouts. Unknown state (no config / not analysed yet) is treated
    // as "fits" so nothing is hidden before we can judge.
    _variantFitsMemory(variant) {
        if (!variant?.configData || !this.prgExporter || !this.sidHeader) return true;
        const sidSize = this.sidHeader.fileSize || this.analysisResults?.dataBytes || 0x2000;
        const modified = this.analysisResults?.modifiedAddresses || [];
        const layouts = this.prgExporter.selectValidLayouts(
            variant.configData, this.sidHeader.loadAddress, sidSize, modified);
        return layouts.some(l => l.valid);
    }

    // Does the visualizer's card belong on offer for this tune? A bar card is
    // offered if ANY of its data-source variants (realtime / shadow / FFT) can be
    // placed - selection then falls back to a variant that fits. E.g. a tune whose
    // heavy self-modification blocks realtime's save/restore can still run via the
    // FFT or shadow variants, which need none.
    _visualizerFitsMemory(visualizer) {
        const members = visualizer?.dataSourceGroup
            ? VISUALIZERS.filter(v => v.dataSourceGroup === visualizer.dataSourceGroup)
            : [visualizer];
        return members.some(m => this._variantFitsMemory(m));
    }

    // Can the selected variant actually be built for this tune? Combines the
    // calls/frame + SID-chip caps with the per-variant memory-fit check. Used to
    // block an export that would otherwise produce a broken/crashing PRG.
    visualizerExportable(viz) {
        if (!viz) return { ok: false, reason: 'no visualizer selected' };
        const u = this.dataSourceUsable(viz);
        if (!u.ok) return u;
        if (!this._variantFitsMemory(viz)) return { ok: false, reason: 'no room in C64 memory alongside this tune' };
        return { ok: true };
    }

    async selectVisualizer(visualizer, { remember = true } = {}) {
        const cards = document.querySelectorAll('.visualizer-card');
        cards.forEach(card => {
            const on = card.dataset.id === visualizer.id;
            card.classList.toggle('selected', on);
            card.setAttribute('aria-checked', on ? 'true' : 'false');
        });

        // Bar styles default to the VU meter (Clever) source: it reads the tune as
        // it plays, so it works on any tune, needs no precomputed stream in RAM,
        // and never truncates a long one. The Spectrometer is the better-looking
        // option and stays a click away on the Method tab, but it has to render
        // and store the whole tune first, so it is not what a first export should
        // silently opt into. If the tune is too fast/multi-SID for the VU meter,
        // fall back to the first source that can handle it.
        // A source the user chose earlier in the session is tried first, so a
        // deliberate "shadow for this release" survives loading the next tune.
        let target = visualizer;
        if (visualizer.dataSourceGroup) {
            const members = VISUALIZERS.filter(v => v.dataSourceGroup === visualizer.dataSourceGroup);
            const byMethod = m => members.find(v => v.dataSource === m);
            const order = this._lastDataSource
                ? [this._lastDataSource, ...['realtime', 'fft', 'shadow'].filter(m => m !== this._lastDataSource)]
                : ['realtime', 'fft', 'shadow'];
            const preferred = order.map(byMethod).filter(Boolean);
            // Prefer a source that can actually be built for this tune (fits memory
            // + within the calls/SID caps); fall back to calls-usable, then FFT
            // (the one source that needs no save/restore room of its own).
            target = preferred.find(v => this.visualizerExportable(v).ok)
                || preferred.find(v => this.dataSourceUsable(v).ok)
                || byMethod('fft') || visualizer;
        }
        this.selectedVisualizer = target;

        if (remember) {
            this._lastVisualizerId = visualizer.id;
            this._saveSessionMemory();
        }

        // The quick path shows the same choice; keep the two from disagreeing.
        this.renderQuickExport();

        this.elements.exportPRGButton.disabled = false;

        // The memory map reflects the last export - it's now stale for the newly
        // selected visualizer, so hide it until the next export regenerates it.
        this.clearMemoryMap();
        this.updateMultiSongNote();

        // Kept so a caller that needs the rendered panels (the quick path, which
        // opens the logo picker over them) can wait for them. Not awaited here:
        // the rest of this method must not sit behind a config fetch.
        this._optionsReady = this.loadVisualizerOptions(target);

        // ...but where this player WILL go can be worked out now, so say so
        // rather than making the user export to find out. Not awaited: it
        // fetches the player's reloc table, and the panels must not wait on it.
        this.renderPlacementPlan();
        // The font and text colours come with the player, so the on-screen text
        // changes with it.
        this.renderTextPreview();
    }

    // What the user gets after Generate: the file, what it is, and how to run it.
    // A .prg means nothing to someone six weeks into the C64, and "run it with
    // SYS 16640" was the entire previous explanation, arriving in a dialog that
    // dismissed itself.
    renderExportDone(info) {
        const el = document.getElementById('exportDone');
        if (!el) return;
        const esc = (s) => String(s).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

        const notes = [];
        if (info.compressionFailed) {
            notes.push(`<p class="ed-note ed-warn">${esc(info.compressionType.toUpperCase())} compression `
                + `wasn't available, so this one is uncompressed. It still runs — after loading it, `
                + `type <code>SYS ${info.sysAddress}</code> and press Return.</p>`);
        } else if (!info.isCompressed) {
            notes.push(`<p class="ed-note">This one is uncompressed, so it doesn't start on its own: `
                + `after loading it, type <code>SYS ${info.sysAddress}</code> and press Return.</p>`);
        }

        // The length is a nice-to-have that is easy to skip by accident; offer it
        // back here rather than leaving the user to work out what they lost.
        const multiSong = !!(this.sidHeader && this.sidHeader.songs > 1);
        const noLength = !multiSong && this.showSongLength()
            && !this.manualSongLengthSeconds()
            && !(this.tuneAnalysis && (this.tuneAnalysis.looped || this.tuneAnalysis.fadedOut));
        if (noLength) {
            notes.push('<p class="ed-note">The C64 shows a running clock but no total length, '
                + 'because the tune was never measured. '
                + '<button type="button" class="ed-link" id="exportDoneMeasure">Measure it and build again</button></p>');
        }

        // Remembered once dismissed: an experienced user does not need to be told
        // what an emulator is on every export.
        let howOpen = true;
        try { howOpen = localStorage.getItem('sidquakeHowToRunClosed') !== '1'; } catch (e) { /* blocked */ }

        // Disk blocks, because that is the unit a release is budgeted in - a .d64
        // side holds 664. 254 usable bytes per block, plus the two-byte load
        // address the PRG carries.
        const blocks = info.bytes ? Math.ceil(info.bytes / 254) : null;
        const hex = (n) => '$' + n.toString(16).toUpperCase().padStart(4, '0');
        const facts = [`${esc(info.sizeKB)} KB`];
        if (blocks) facts.push(`${blocks} disk block${blocks === 1 ? '' : 's'}`);
        if (info.span) facts.push(`runs at ${hex(info.span.lo)}-${hex(info.span.hi)}`);

        // An uncompressed export writes the gaps between components out as
        // zeros, so a scattered layout costs real bytes and real blocks.
        if (!info.isCompressed && info.spanBytes && info.usedBytes
            && info.spanBytes - info.usedBytes > 8 * 1024) {
            const wasted = ((info.spanBytes - info.usedBytes) / 1024).toFixed(1);
            notes.push(`<p class="ed-note">About ${wasted} KB of this file is empty space `
                + `between the parts, written out because the file has to be one `
                + `continuous block. Compressing it removes that.</p>`);
        }

        el.innerHTML = `
            <h4 class="ed-title">Your file is ready</h4>
            <p class="ed-file"><strong>${esc(info.filename)}</strong> · ${facts.join(' · ')} · saved to your downloads</p>
            <p class="ed-what">It's a Commodore 64 program. It runs on a real C64, or on a C64 emulator on your computer.</p>
            ${notes.join('')}
            <details class="ed-how" id="exportDoneHow"${howOpen ? ' open' : ''}>
                <summary>How to run it</summary>
                <ol>
                    <li>Get <a href="https://vice-emu.sourceforge.io/" target="_blank" rel="noopener">VICE</a>, a free Commodore 64 emulator, and install it.</li>
                    <li>Open the C64 emulator (<code>x64sc</code>).</li>
                    <li>Drag <strong>${esc(info.filename)}</strong> onto its window. That's it — your tune plays.</li>
                </ol>
                <p class="ed-note">On real hardware, copy it to a disk or an SD2IEC / Ultimate cartridge and load it as usual.</p>
            </details>
            <p class="ed-share">Releasing it? C64 music and demos get shared on
                <a href="https://csdb.dk/" target="_blank" rel="noopener">CSDb</a>.
                Tunes made with SIDquake are listed on the Releases tab.</p>
        `;
        el.hidden = false;

        const how = document.getElementById('exportDoneHow');
        if (how) how.addEventListener('toggle', () => {
            try { localStorage.setItem('sidquakeHowToRunClosed', how.open ? '0' : '1'); } catch (e) { /* blocked */ }
        });
        const measure = document.getElementById('exportDoneMeasure');
        if (measure) measure.addEventListener('click', () => {
            this._analysisCancelled = false;
            this.startBackgroundAnalysis();
            if (window.studioModal) window.studioModal.activate('song');
            this.updateSongLoopStatus();
        });
    }

    /** Hide + empty the memory-map + bake-timeline panels (they describe the last export). */
    clearMemoryMap() {
        for (const el of [this.elements.memoryMap, this.elements.bakeTimeline, this.elements.loopInfo]) {
            if (!el) continue;
            el.style.display = 'none';
            el.innerHTML = '';
        }
        // The "your file is ready" panel describes the same last export.
        const done = document.getElementById('exportDone');
        if (done) { done.hidden = true; done.innerHTML = ''; }
    }

    // Switch the active visualizer to another data-source variant in the same
    // group (realtime/shadow/FFT) and re-render its options. The grid card stays
    // selected - only the underlying variant + export config change.
    selectDataSource(method) {
        const group = this.selectedVisualizer?.dataSourceGroup;
        if (!group) return;
        const variant = VISUALIZERS.find(v => v.dataSourceGroup === group && v.dataSource === method);
        if (variant && variant !== this.selectedVisualizer) {
            this.selectedVisualizer = variant;
            this._lastDataSource = method;
            this._saveSessionMemory();
            this.clearMemoryMap();
            this.updateMultiSongNote();
            this.loadVisualizerOptions(variant);
            this.renderPlacementPlan();
        }
    }

    async loadVisualizerOptions(visualizer) {
        // Request token: if the user clicks another visualizer while this
        // one's config is still fetching, the stale render must not overwrite
        // the newer panels (export would then read mismatched option values).
        const req = this._optionsRequest = (this._optionsRequest || 0) + 1;

        const config = visualizer.config ? await this.visualizerConfig.loadConfig(visualizer.id) : null;
        if (req !== this._optionsRequest) return;  // superseded by a newer selection

        // Values persist by option id across visualizer switches AND across SID
        // loads: fold the current panel values into the session memory before
        // re-render, restore matching ids after. The OUTGOING config's per-option
        // defaults decide what gets remembered - a value that still equals its
        // old default was never touched by the user, so it must NOT override the
        // new config's own default (e.g. switching from the FFT player, whose
        // colour effect defaults to Dynamic Pulse, to a Real-time player that
        // defaults to Waveform).
        const prevDefaults = this._configDefaults(this.currentVisualizerConfig);
        this._rememberOptionValues(this._captureOptionValues(), prevDefaults);

        // File inputs (Logo / Bitmap) aren't captured above - the browser won't
        // let us re-assign their value, and they're skipped by the snapshot.
        // Instead remember the user's chosen image by logical slot and restore
        // it after the new panels render (see _restoreImageSelections). Must run
        // before currentVisualizerConfig is reassigned - it reads the old one.
        this._rememberImageSelections();
        this._pendingImageRestore = this._imageSelectionMemory;

        // Stash so createOptionHTML / createFontSelectorHTML can read fields
        // off the parsed visualizer config (e.g. fontType) without us having
        // to thread it through every call site.
        this.currentVisualizerConfig = config;

        // How the bars are worked out: its own Studio tab, present only for the
        // players that offer a choice.
        const methodMount = document.getElementById('methodMount');
        if (methodMount) {
            const methodHTML = this.createMethodPanelHTML(visualizer);
            methodMount.innerHTML = methodHTML
                ? this._wrapOptionsPanel(`<div class="option-group">${methodHTML}</div>`) : '';
            // The bars-from-notes methods can be blind to a tune; say so here
            // rather than in the exported file. Not awaited - it runs the 6510
            // over 1,200 frames.
            if (methodHTML) this.checkVuVisibility();
        }
        const vizExtras = document.getElementById('vizExtras');
        if (vizExtras) vizExtras.innerHTML = '';

        // Derived middle tabs: group this visualizer's inputs/options, render
        // each group with the existing option renderers, and hand the finished
        // panels to the Studio. The tab set is a pure projection of the config.
        const groups = window.studioModal ? window.studioModal.deriveGroups(config) : [];
        for (const group of groups) {
            let inner = '';
            if (group.kind === 'input') {
                inner += this.createFileInputHTML(group.input);
            }
            let revealNoteAdded = false;
            for (const option of group.options) {
                // Progressive disclosure: the first control gated on the scroll
                // text gets a caption explaining WHY it just appeared. The note
                // row shares the showWhen condition so it folds away with them.
                if (group.id === 'scroller' && option.showWhen && !revealNoteAdded) {
                    revealNoteAdded = true;
                    const showWhenJson = JSON.stringify(option.showWhen).replace(/"/g, '&quot;');
                    inner += `<div class="option-row studio-reveal-note" data-show-when="${showWhenJson}">`
                        + 'A font charset and scroll colour are embedded only because you added scroll text.</div>';
                }
                inner += this.createOptionHTML(option);
            }
            const sub = group.id === 'scroller'
                ? '<p class="studio-panel-sub">Optional — leave blank for no scroller. Anything the scroller needs (font, colour) unfolds below as you type.</p>'
                : '';
            group.html = `
                <h3 class="studio-panel-title">${group.label}</h3>${sub}
                ${this._wrapOptionsPanel(`<div class="option-group">${inner}</div>`)}`;
        }
        if (window.studioModal) window.studioModal.setDerivedTabs(groups);

        // Export tab: compression, then everything else folded away. Compression
        // is a real choice with a visible consequence (file size vs depack time);
        // the frame rate, stored length, analysis engine and loop-search window
        // are knobs most users should never have to judge.
        const exportMount = document.getElementById('exportConfigMount');
        if (exportMount) {
            exportMount.innerHTML = this._wrapOptionsPanel(
                this.createCompressionOptionsHTML() +
                this.createAdvancedSettingsHTML(config));
        }

        this._wireAdvancedSettings();
        this._wireRecipeControls();
        await this.attachOptionEventListeners(config);
        this._restoreOptionValues(this._optionMemory);
        await this._restoreImageSelections(config, req);
        this._pendingImageRestore = null;
        this.updateConditionalVisibility();
        if (window.studioModal) window.studioModal.queueRefresh();
    }

    _wrapOptionsPanel(inner) {
        return `<div class="visualizer-options-panel"><div class="options-content">${inner}</div></div>`;
    }

    // Snapshot every option control's value (keyed by element id) so a
    // visualizer switch keeps the user's choices where ids match.
    _captureOptionValues() {
        const values = {};
        const root = document.getElementById('studioPanels');
        if (!root) return values;
        for (const el of root.querySelectorAll('input[id], select[id], textarea[id]')) {
            if (el.type === 'file' || el.type === 'radio' || el.type === 'checkbox') continue;
            values[el.id] = el.value;
        }
        const compression = document.querySelector('input[name="compression-type"]:checked');
        if (compression) values['__compression'] = compression.value;
        return values;
    }

    // Fold a snapshot into the session's sticky option values. `defaults` is the
    // OUTGOING config's per-option defaults: a value still equal to its default
    // was never chosen, so it must not be remembered (and must clear an earlier
    // memory of the same option, or a value the user has since reverted would
    // keep coming back). What survives is only what the user actually set, which
    // is what a new tune should inherit.
    _rememberOptionValues(values, defaults = {}) {
        for (const [id, value] of Object.entries(values)) {
            if (defaults[id] !== undefined && String(defaults[id]) === String(value)) {
                delete this._optionMemory[id];
            } else {
                this._optionMemory[id] = value;
            }
        }
        this._saveSessionMemory();
    }

    /**
     * The player, data source, option values and gallery image picks, so a
     * reload does not start over. Only gallery picks are kept: a file the user
     * uploaded cannot be re-read from a name, and storing one would promise
     * something the next page load could not deliver.
     */
    _saveSessionMemory() {
        // The option snapshot is a sweep of every control on the Studio panels,
        // so it also picks up things that belong to the tune in front of the
        // user rather than to the session: its title, author, copyright,
        // sub-tune and typed-in length. Carrying those into a NEW session would
        // stamp one tune's credits onto the next. The advanced settings are
        // excluded for a different reason - they have their own store
        // (sidquakeAdvanced), and two copies of one setting drift apart.
        const options = {};
        for (const [id, value] of Object.entries(this._optionMemory || {})) {
            if (UIController.PER_TUNE_OPTION_IDS.has(id)) continue;
            if (/^adv[A-Z]/.test(id)) continue;
            options[id] = value;
        }
        const images = {};
        for (const [slot, sel] of Object.entries(this._imageSelectionMemory || {})) {
            if (sel && sel.kind === 'gallery' && sel.file) images[slot] = { kind: 'gallery', file: sel.file };
        }
        try {
            localStorage.setItem('sidquakeSession', JSON.stringify({
                v: 1,
                visualizer: this._lastVisualizerId,
                dataSource: this._lastDataSource,
                options,
                images,
            }));
        } catch (e) { /* storage blocked: the session memory is just not kept */ }
    }

    _restoreSessionMemory() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('sidquakeSession') || 'null'); }
        catch (e) { return; }
        if (!saved || saved.v !== 1) return;
        this._lastVisualizerId = saved.visualizer || null;
        this._lastDataSource = saved.dataSource || null;
        if (saved.options && typeof saved.options === 'object') {
            this._optionMemory = { ...saved.options };
        }
        if (saved.images && typeof saved.images === 'object') {
            this._imageSelectionMemory = { ...saved.images };
        }
    }

    // Per-option default values (keyed by id) for a parsed visualizer config,
    // matching what each renderer seeds its control with. Used to tell a value
    // the user actually chose from one that's merely the outgoing config's
    // default (which must not carry over and mask the new config's default).
    _configDefaults(config) {
        const defaults = {};
        for (const opt of (config?.options || [])) {
            if (!opt.id) continue;
            if (opt.type === 'paletteEditor') {
                const kind = opt.kind === 'columns' ? 'columns'
                    : opt.kind === 'waveform' ? 'waveform' : 'fade';
                defaults[opt.id] = this._paletteDefaults(kind).map(v => v & 0x0F).join(',');
            } else if (opt.type === 'textarea') {
                defaults[opt.id] = String(opt.default || '');
            } else if (opt.type === 'range') {
                defaults[opt.id] = String(opt.default != null ? opt.default : (opt.min || 0));
            } else {
                defaults[opt.id] = String(opt.default != null ? opt.default : 0);
            }
        }
        return defaults;
    }

    _restoreOptionValues(values, prevDefaults = {}) {
        const root = document.getElementById('studioPanels');
        if (!root) return;
        for (const [id, value] of Object.entries(values)) {
            if (id === '__compression') {
                const radio = document.querySelector(`input[name="compression-type"][value="${value}"]`);
                if (radio) radio.checked = true;
                continue;
            }
            // An untouched value (still equal to the outgoing config's default)
            // must not override the new config's own default for that option.
            if (prevDefaults[id] !== undefined && String(prevDefaults[id]) === String(value)) continue;
            const el = document.getElementById(id);
            if (!el || !root.contains(el) || el.value === value) continue;
            // Grid-backed hidden inputs (font / bar style / effect / palette):
            // only restore a value the freshly rendered grid actually offers,
            // and move the selection highlight with it.
            const grid = document.getElementById(`${id}-grid`);
            if (grid) {
                const thumb = grid.querySelector(`.bar-style-thumbnail[data-value="${value}"]`);
                if (!thumb) continue;
                this.selectGridThumb(grid, thumb);
                continue;
            }
            // Palette editors carry their state in a hidden input; move the
            // restored colours onto the freshly rendered swatches too.
            const paletteEditor = root.querySelector(`.palette-editor[data-editor-id="${id}"]`);
            if (paletteEditor) {
                const vals = value.split(',').map(s => parseInt(s, 10) & 0x0F).filter(n => !isNaN(n));
                if (vals.length) {
                    this.applyPaletteValues(paletteEditor, vals);
                    this.markPaletteDirty(paletteEditor);
                }
                continue;
            }
            el.value = value;
            // Sliders + textareas drive displays/visibility off their input event.
            if (el.classList.contains('color-slider') || el.classList.contains('range-slider') ||
                el.tagName === 'TEXTAREA') {
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }

    // Is `inputConfig` an image (PNG) file input?
    _isImageInput(inputConfig) {
        return inputConfig && inputConfig.type === 'file' && inputConfig.accept
            && (inputConfig.accept.includes('image/') || inputConfig.accept.includes('.png'));
    }

    // The logical slot for a file input: its convertType (e.g. 'logo') or 'raw'.
    // A slot is stable across visualizers even when the element id isn't, so a
    // Logo picked under id "bitmap-input" restores under id "logo-input" too -
    // but a plain bitmap ('raw') never fills a logo slot and vice versa.
    _imageSlot(inputConfig) {
        return (inputConfig && inputConfig.convertType) || 'raw';
    }

    // Record the user's current image selections (Logo / Bitmap) into the
    // sticky memory, keyed by slot. Only genuine selections (a gallery pick or
    // an uploaded file) are stored - an untouched default sets nothing, and we
    // never erase memory for a slot the current visualizer lacks, so a choice
    // survives hopping through a visualizer that has no logo.
    _rememberImageSelections() {
        const cfg = this.currentVisualizerConfig;
        if (!cfg || !cfg.inputs) return;
        for (const input of cfg.inputs) {
            if (!this._isImageInput(input)) continue;
            const el = document.getElementById(input.id);
            if (!el) continue;
            if (el.dataset.gallerySelected === 'true' && el.dataset.galleryFile) {
                this._imageSelectionMemory[this._imageSlot(input)] = { kind: 'gallery', file: el.dataset.galleryFile };
                this._saveSessionMemory();
            } else if (el.files && el.files.length) {
                // The file in the input is the FITTED one - the placement
                // rendered for THIS player's band. Carrying that to the next
                // player fits an already-fitted image, and a second pass over a
                // scaled logo resamples its pixels into shades no C64 mode has.
                // The manager keeps what the user actually chose; remember that.
                const fit = window.imagePreviewManager
                    && window.imagePreviewManager.logoFit.get(input.id);
                this._imageSelectionMemory[this._imageSlot(input)] = {
                    kind: 'custom', fileObj: (fit && fit.original) || el.files[0],
                };
            }
        }
    }

    // The remembered selection that should fill `inputConfig`, or null. A
    // gallery pick only applies if the new input actually offers that file, so
    // a logo from one gallery can't leak into an input backed by another.
    _pendingImageFor(inputConfig) {
        const mem = this._pendingImageRestore;
        if (!mem || !this._isImageInput(inputConfig)) return null;
        const entry = mem[this._imageSlot(inputConfig)];
        if (!entry) return null;
        if (entry.kind === 'gallery' && !(inputConfig.gallery || []).some(g => g.file === entry.file)) return null;
        return entry;
    }

    // After a visualizer's panels re-render, refill any image input that has a
    // remembered selection for its slot (the default was skipped for it in
    // attachOptionEventListeners, so there's no flash).
    async _restoreImageSelections(config, req) {
        const mem = this._pendingImageRestore;
        if (!config || !config.inputs || !mem) return;
        const container = document.getElementById('studioPanels');
        const mgr = window.imagePreviewManager;
        if (!container || !mgr) return;
        for (const inputConfig of config.inputs) {
            const entry = this._pendingImageFor(inputConfig);
            if (!entry) continue;
            try {
                if (entry.kind === 'gallery') {
                    const item = (inputConfig.gallery || []).find(g => g.file === entry.file);
                    const name = item ? item.name : entry.file.split('/').pop().replace(/\.[^.]+$/, '');
                    await mgr.loadGalleryImage(container, inputConfig, entry.file, name);
                    // Move the inline gallery's "selected" highlight off the
                    // default card and onto the restored one.
                    const wrapper = container.querySelector(`[data-input-id="${CSS.escape(inputConfig.id)}"]`);
                    if (wrapper) {
                        wrapper.querySelectorAll('.gallery-item-card.selected').forEach(c => c.classList.remove('selected'));
                        const card = wrapper.querySelector(`.gallery-item-card[data-file="${CSS.escape(entry.file)}"]`);
                        if (card) card.classList.add('selected');
                    }
                } else if (entry.fileObj) {
                    const el = document.getElementById(inputConfig.id);
                    if (el) {
                        const dt = new DataTransfer();
                        dt.items.add(entry.fileObj);
                        el.files = dt.files;
                        delete el.dataset.gallerySelected;
                        delete el.dataset.galleryFile;
                        await mgr.handleFileChange({ target: { files: el.files } }, inputConfig);
                    }
                }
            } catch (e) {
                // Restore failed (e.g. gallery fetch error) - fall back to the
                // default we'd otherwise have skipped.
                mgr.loadDefaultImage(inputConfig);
            }
            if (req !== this._optionsRequest) return;  // superseded by a newer selection
        }
    }

    // Advanced ("Pro") settings, collapsed by default and persisted to
    // localStorage. These are the knobs most users never touch: how much of a
    // tune we render looking for its loop, how long a repeat must be before we
    // call it the loop, and the spectrometer's output frame rate. The export
    // modals and the on-load analysis read their values from here rather than
    // asking each time (see getAdvancedSettings / _wireAdvancedSettings).
    getAdvancedSettings() {
        if (!this._advanced) {
            let s = {};
            try { s = JSON.parse(localStorage.getItem('sidquakeAdvanced') || '{}') || {}; } catch (e) { /* first run / blocked */ }
            // framesPerKeyframe is the fps MODE: 'best' (highest that fits RAM,
            // the default) or a fixed 1/2/3 (50/25/16.66 fps).
            this._advanced = {
                scanLenText: typeof s.scanLenText === 'string' ? s.scanLenText : '',
                minLoopSeconds: Number.isFinite(s.minLoopSeconds) ? Math.min(60, Math.max(1, s.minLoopSeconds)) : 2,
                framesPerKeyframe: (s.framesPerKeyframe === 'best' || [1, 2, 3].includes(s.framesPerKeyframe)) ? s.framesPerKeyframe : 'best',
                // Seconds of bars stored for a tune with NO detected loop. The
                // index costs `segments` bytes per keyframe out of a fixed RAM
                // budget, so a shorter stream buys back spectral detail - see
                // UIController.STORED_LENGTH_CHOICES.
                storedSeconds: Number.isFinite(s.storedSeconds) ? Math.min(600, Math.max(30, s.storedSeconds)) : 480,
                // A VIC bank base the user would rather the graphics went in, or
                // 0 for automatic. Soft - see createBankOptionHTML.
                preferredGfxBank: [0x4000, 0x8000, 0xC000].includes(s.preferredGfxBank) ? s.preferredGfxBank : 0,
                // Memory the export must not touch, as the user typed it. Kept
                // as text so a half-finished entry survives a re-render;
                // parseReservedRanges turns it into ranges.
                reservedText: typeof s.reservedText === 'string' ? s.reservedText : '',
                // SID engine the spectrometer analysis renders with. 'fp'
                // (libsidplayfp) is the default because it plays every tune; 'resid'
                // (the lightweight core in sidquake.wasm) is ~2.1x faster but gets a
                // different bake on roughly a quarter of tunes and cannot play some
                // at all. See spectrometer-bake-core.js for the measurements.
                bakeEngine: (s.bakeEngine === 'fp' || s.bakeEngine === 'resid') ? s.bakeEngine : 'fp',
                open: !!s.open,
            };
        }
        // maxLoopSeconds is derived from the typed "m:ss" (blank => undefined,
        // so callers fall back to their own default scan window).
        return {
            ...this._advanced,
            maxLoopSeconds: this._parseMMSS(this._advanced.scanLenText) || undefined,
            reservedRanges: UIController.parseReservedRanges(this._advanced.reservedText).ranges,
        };
    }

    // Two export knobs spectrometer players expose: the output frame rate, and how
    // much of a non-looping tune to store. The scan window and min-loop length are
    // not user-facing (they sit at sensible defaults in getAdvancedSettings).
    createFrameRateOptionHTML() {
        const a = this.getAdvancedSettings();
        const fpk = (v, label) => `<option value="${v}"${a.framesPerKeyframe === v ? ' selected' : ''}>${label}</option>`;
        const bestSel = a.framesPerKeyframe === 'best' ? ' selected' : '';
        const len = UIController.STORED_LENGTH_CHOICES
            .map(c => `<option value="${c.secs}"${a.storedSeconds === c.secs ? ' selected' : ''}>${c.label}</option>`)
            .join('');
        return `
        <div class="option-group">
            <div class="option-row">
                <label class="option-label" for="advFps">Spectrometer frame rate</label>
                <div class="option-control">
                    <select id="advFps" class="number-input">
                        <option value="best"${bestSel}>Best (fits memory)</option>
                        ${fpk(1, '50 fps')}${fpk(2, '25 fps')}${fpk(3, '16.66 fps')}
                    </select>
                </div>
            </div>
            <p class="flow-note">Higher rates animate more smoothly; an export drops to the highest rate that fits C64 memory if the chosen one is too big.</p>
            <div class="option-row">
                <label class="option-label" for="advStoredLen">Max stored bars (no-loop tunes)</label>
                <div class="option-control">
                    <select id="advStoredLen" class="number-input">${len}</select>
                </div>
            </div>
        </div>`;
    }

    // The SID engine the tune ANALYSIS renders with. Deliberately not part of
    // createFrameRateOptionHTML: every visualizer runs the analysis, not just the
    // spectrometer ones - players with a timer show the song length from it, and a
    // detected fade-out is what unlocks the Song Looping option. Keeping this knob
    // inside the spectrometer-only block meant the setting still applied everywhere
    // but could only be reached from an FFT player.
    createAnalysisEngineOptionHTML() {
        const a = this.getAdvancedSettings();
        return `
        <div class="option-group">
            <div class="option-group-title">Tune analysis</div>
            <div class="option-row">
                <label class="option-label" for="advBakeEngine">Analysis SID engine</label>
                <div class="option-control">
                    <select id="advBakeEngine" class="number-input">
                        <option value="fp"${a.bakeEngine === 'fp' ? ' selected' : ''}>libsidplayfp (accurate, the default)</option>
                        <option value="resid"${a.bakeEngine === 'resid' ? ' selected' : ''}>reSID (about twice as fast)</option>
                    </select>
                </div>
            </div>
            <p class="flow-note">Which SID core renders the tune while its loop and length are worked out. libsidplayfp runs a full C64, so it plays everything. reSID scans about twice as fast, but it has no C64 environment — it resolves a different loop on some tunes, and any it can't play at all are re-scanned on libsidplayfp automatically. Playback is unaffected either way.</p>
        </div>`;
    }

    // Stored-length choices for a non-looping tune, labelled with the spectral
    // detail each one buys. The thresholds are where chooseSegments() (see
    // spectrometer-bake.js) drops a level: the index budget is budgetBytes minus
    // the fixed 10 KB codebook, spent at segments x 50 bytes per second.
    static STORED_LENGTH_CHOICES = [
        { secs: 70,  label: '1:10 \u2014 5 slices (finest)' },
        { secs: 90,  label: '1:30 \u2014 4 slices' },
        { secs: 180, label: '3:00 \u2014 2 slices' },
        { secs: 480, label: '8:00 \u2014 1 slice (longest, the default)' },
    ];

    // Persist the frame-rate + stored-length controls; called after the options
    // HTML is (re)rendered.
    _wireAdvancedSettings() {
        const save = () => {
            try { localStorage.setItem('sidquakeAdvanced', JSON.stringify(this._advanced)); } catch (e) { /* storage blocked */ }
        };
        const fps = document.getElementById('advFps');
        if (fps) fps.addEventListener('change', () => {
            const cur = this._advanced || {};
            cur.framesPerKeyframe = fps.value === 'best' ? 'best' : (parseInt(fps.value, 10) || 2);
            this._advanced = cur;
            save();
        });
        const len = document.getElementById('advStoredLen');
        if (len) len.addEventListener('change', () => {
            const cur = this._advanced || {};
            cur.storedSeconds = parseInt(len.value, 10) || 480;
            this._advanced = cur;
            save();
        });
        const details = document.getElementById('advancedSettings');
        if (details) details.addEventListener('toggle', () => {
            const cur = this._advanced || {};
            cur.open = details.open;
            this._advanced = cur;
            save();
        });
        // The scan window and the shortest-loop threshold are both part of the
        // analysis cache key, so changing either makes anything already measured
        // describe a different search. Same treatment as the engine below.
        const rescan = () => {
            // The setting is the new starting point, so a per-tune "keep looking"
            // widening does not silently stack on top of it.
            this._scanWindowOverride = 0;
            this._analysisToken++;
            this.cancelAnalysis();
            this._hideAnalysisChip();
            this.tuneAnalysis = null;
            this._analysisCancelled = false;
            save();
            this.updateSongLoopStatus();
            this.startBackgroundAnalysis();
        };
        const scanLen = document.getElementById('advScanLen');
        if (scanLen) scanLen.addEventListener('change', () => {
            const cur = this._advanced || {};
            // Kept as typed: getAdvancedSettings parses it, and blank means
            // "use the caller's own default" rather than zero.
            cur.scanLenText = this._parseMMSS(scanLen.value) ? scanLen.value.trim() : '';
            scanLen.value = cur.scanLenText;
            this._advanced = cur;
            rescan();
        });
        const minLoop = document.getElementById('advMinLoop');
        if (minLoop) minLoop.addEventListener('change', () => {
            const cur = this._advanced || {};
            cur.minLoopSeconds = Math.min(60, Math.max(1, parseInt(minLoop.value, 10) || 2));
            minLoop.value = cur.minLoopSeconds;
            this._advanced = cur;
            rescan();
        });
        const bank = document.getElementById('advGfxBank');
        if (bank) bank.addEventListener('change', () => {
            const cur = this._advanced || {};
            cur.preferredGfxBank = parseInt(bank.value, 10) || 0;
            this._advanced = cur;
            save();
            // Placement is decided at build time, so nothing to re-analyse.
        });
        const reserved = document.getElementById('advReserved');
        if (reserved) reserved.addEventListener('change', () => {
            const cur = this._advanced || {};
            const parsed = UIController.parseReservedRanges(reserved.value);
            cur.reservedText = reserved.value.trim();
            this._advanced = cur;
            save();
            const note = document.getElementById('advReservedNote');
            if (note) {
                // Keep the explanation to put back: a typo should not cost the
                // user the only description of what the field is for.
                if (!note.dataset.help) note.dataset.help = note.textContent;
                note.classList.toggle('is-bad', parsed.bad.length > 0);
                note.textContent = parsed.bad.length
                    ? `Not an address range: ${parsed.bad.join(', ')} — the rest of what you typed is being used.`
                    : note.dataset.help;
            }
            // Placement is decided at build time, so nothing to re-analyse -
            // but what the page says about placement is now out of date.
            this.renderPlacementPlan();
        });
        const eng = document.getElementById('advBakeEngine');
        if (eng) eng.addEventListener('change', () => {
            const cur = this._advanced || {};
            cur.bakeEngine = eng.value === 'resid' ? 'resid' : 'fp';
            this._advanced = cur;
            // The rendered rows are engine-specific, so a previous analysis of this
            // tune no longer describes what an export would bake - and a scan still
            // running is rendering with the old engine.
            rescan();
        });
    }

    // The loop-search knobs. Both are part of the analysis cache key, so changing
    // either invalidates whatever has been measured (see _wireAdvancedSettings).
    createScanWindowOptionHTML() {
        const a = this.getAdvancedSettings();
        return `
        <div class="option-group">
            <div class="option-group-title">Loop search</div>
            <div class="option-row">
                <label class="option-label" for="advScanLen">Give up searching after</label>
                <div class="option-control advanced-num">
                    <input type="text" id="advScanLen" class="number-input" inputmode="numeric"
                           size="5" placeholder="10:00" value="${a.scanLenText || ''}">
                    <span class="advanced-unit">m:ss</span>
                </div>
            </div>
            <p class="flow-note">How much of the tune to play through looking for its loop. Blank uses the default, 10:00. A tune whose loop is longer than this is stored as a fade-out instead.</p>
            <div class="option-row">
                <label class="option-label" for="advMinLoop">Shortest loop to believe</label>
                <div class="option-control advanced-num">
                    <input type="number" id="advMinLoop" class="number-input" min="1" max="60" step="1"
                           value="${a.minLoopSeconds}">
                    <span class="advanced-unit">seconds</span>
                </div>
            </div>
            <p class="flow-note">A repeat shorter than this is treated as a repeated phrase rather than the tune looping.</p>
        </div>`;
    }

    // Which VIC bank the graphics go in. Automatic placement maximises the
    // largest free CPU block, which is right when nothing else has a claim on
    // memory - but a disk with a shared loader wants every PRG in the same bank,
    // and only the person building it knows that. A preference that cannot be
    // made to work is ignored rather than failing the export, and the export
    // says so.
    createBankOptionHTML() {
        const cur = this.getAdvancedSettings().preferredGfxBank || '';
        const opt = (v, label) =>
            `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${label}</option>`;
        return `
        <div class="option-group">
            <div class="option-group-title">Memory</div>
            <div class="option-row">
                <label class="option-label" for="advGfxBank">Put the graphics in</label>
                <div class="option-control">
                    <select id="advGfxBank" class="number-input">
                        ${opt('', 'Wherever leaves most room (the default)')}
                        ${opt(0x4000, 'VIC bank 1 — $4000')}
                        ${opt(0x8000, 'VIC bank 2 — $8000')}
                        ${opt(0xC000, 'VIC bank 3 — $C000')}
                    </select>
                </div>
            </div>
            <p class="flow-note">Only matters if something else has a claim on C64 memory — a shared loader across a disk, say. If the tune leaves no room in the bank you choose, the export uses one that works and tells you.</p>
            <div class="option-row">
                <label class="option-label" for="advReserved">Keep this memory free</label>
                <div class="option-control">
                    <input type="text" id="advReserved" class="number-input" style="width:16em"
                           spellcheck="false" placeholder="e.g. $C000-$CFFF"
                           value="${String(this.getAdvancedSettings().reservedText || '').replace(/"/g, '&quot;')}"
                           aria-describedby="advReservedNote">
                </div>
            </div>
            <p class="flow-note" id="advReservedNote">Addresses the export must not use, so a loader or an intro can keep them. Separate several with commas; a bare address means its page. Unlike the bank above this is not a preference — if what is left cannot hold the player, the export says so rather than using the memory anyway.</p>
        </div>`;
    }

    // Everything on the Export tab that a normal export never needs. Collapsed by
    // default; the open/closed state is remembered like the settings themselves.
    createAdvancedSettingsHTML(config) {
        const a = this.getAdvancedSettings();
        return `
        <details class="advanced-settings" id="advancedSettings"${a.open ? ' open' : ''}>
            <summary class="advanced-summary">Advanced settings</summary>
            <div class="advanced-body">
                <p class="flow-note">These are already set to what a normal export wants. Nothing here needs changing to build a working PRG.</p>
                ${config?.spectrometerBake ? this.createFrameRateOptionHTML() : ''}
                ${this.createAnalysisEngineOptionHTML()}
                ${this.createScanWindowOptionHTML()}
                ${this.createBankOptionHTML()}
            </div>
        </details>`;
    }

    // ---------------------------------------------------------------------
    // Recipes: the whole setup as a small file
    // ---------------------------------------------------------------------

    // Everything that decides what an export looks like, in one JSON. A music
    // disk wants every tune built the same way, and a release ought to be
    // rebuildable next year - neither was possible when the settings existed
    // only as live DOM state in one browser tab.
    //
    // A custom uploaded image can only be referenced by name: the file itself is
    // not ours to keep, and a JSON cannot carry a file handle the browser will
    // accept back. Gallery picks restore in full.
    /**
     * @param {object|null} built - what an export produced, recorded so two
     *   builds of the same recipe can be diffed. The pipeline is deterministic
     *   (no timestamp reaches the PRG), so the same inputs give the same bytes.
     */
    buildRecipe(built = null) {
        const viz = this.selectedVisualizer;
        const images = {};
        for (const [slot, sel] of Object.entries(this._imageSelectionMemory || {})) {
            if (!sel) continue;
            images[slot] = sel.kind === 'gallery'
                ? { kind: 'gallery', file: sel.file }
                : { kind: 'custom', name: (sel.fileObj && sel.fileObj.name) || 'your own image' };
        }
        const songSel = document.getElementById('songSelector');
        const forceLoop = document.getElementById('forceLoopToggle');
        return {
            sidquake: { recipe: 1 },
            player: viz ? { card: this._lastVisualizerId || viz.id, dataSource: viz.dataSource || null } : null,
            // The session memory holds only values the user actually chose; the
            // live panels add whatever this player exposes right now.
            options: Object.assign({}, this._optionMemory, this._captureOptionValues()),
            images,
            song: {
                subtune: songSel ? parseInt(songSel.value, 10) : null,
                forceLoop: !!(forceLoop && forceLoop.checked),
                showLength: this.showSongLength(),
                manualLengthSeconds: this.manualSongLengthSeconds(),
            },
            analysis: this.getAdvancedSettings(),
            naming: { template: (document.getElementById('filenameTemplate') || {}).value || '{name}' },
            ...(built ? { built } : {}),
        };
    }

    /** FNV-1a over the PRG bytes: enough to tell two builds apart. */
    static prgHash(bytes) {
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * The last export's `built` block, but only while the settings still match
     * the ones that produced it - otherwise the recipe would claim a build its
     * own settings would not reproduce.
     */
    _builtIfStillCurrent() {
        if (!this._lastBuilt) return null;
        return JSON.stringify(this.buildRecipe()) === this._lastBuiltFrom ? this._lastBuilt : null;
    }

    /** Whether to drop a settings file next to every PRG. */
    recipeAlways() {
        const el = document.getElementById('recipeAlways');
        return !!(el && el.checked);
    }

    saveRecipe(built = null, baseName = null) {
        const recipe = this.buildRecipe(built);
        const base = baseName || (this.currentFileName || 'sidquake').replace(/\.sid$/i, '');
        this.downloadFile(JSON.stringify(recipe, null, 2), `${base}.sqrecipe.json`);
        this.setRecipeNote(`Saved ${base}.sqrecipe.json.`);
        return `${base}.sqrecipe.json`;
    }

    /**
     * @param {object} recipe
     * @param {object} [opts]
     * @param {boolean} [opts.perTune=true] - apply the song block too. False
     *   when replaying a recipe across a queue: sub-tune, forced loop and a
     *   typed-in length describe the tune the recipe was made from, not the
     *   next one.
     * @param {boolean} [opts.quiet=false] - skip the note; a queue run reports
     *   per tune instead.
     */
    async applyRecipe(recipe, opts = {}) {
        const { perTune = true, quiet = false } = opts;
        if (!recipe || !recipe.sidquake || recipe.sidquake.recipe !== 1) {
            this.setRecipeNote('That does not look like a SIDquake settings file.', true);
            return false;
        }

        // Advanced settings first: they change what an analysis means, and
        // getAdvancedSettings is read by everything downstream.
        if (recipe.analysis) {
            const a = this.getAdvancedSettings();
            this._advanced = Object.assign({}, a, recipe.analysis);
            try { localStorage.setItem('sidquakeAdvanced', JSON.stringify(this._advanced)); } catch (e) { /* blocked */ }
        }

        // The option memory is what survives a player switch, so seed it before
        // selecting the player and its panels will pick the values up.
        if (recipe.options) this._optionMemory = Object.assign({}, recipe.options);
        if (recipe.images) {
            this._imageSelectionMemory = {};
            for (const [slot, sel] of Object.entries(recipe.images)) {
                if (sel && sel.kind === 'gallery' && sel.file) {
                    this._imageSelectionMemory[slot] = { kind: 'gallery', file: sel.file };
                }
            }
        }

        const missing = Object.entries(recipe.images || {})
            .filter(([, sel]) => sel && sel.kind === 'custom')
            .map(([, sel]) => sel.name);

        if (recipe.player && recipe.player.card) {
            const card = (typeof VISUALIZERS !== 'undefined')
                && VISUALIZERS.find(v => v.id === recipe.player.card);
            if (card) {
                this._lastDataSource = recipe.player.dataSource || this._lastDataSource;
                await this.selectVisualizer(card);
            }
        }

        // Seeding the memory alone is not enough: rendering the panels folds the
        // live DOM into that memory FIRST (loadVisualizerOptions), so whatever
        // was on screen would overwrite the recipe on its way past. Put the
        // values on the controls now the panels exist, and restore the memory
        // behind them so a later player switch still carries them.
        if (recipe.options) {
            this._restoreOptionValues(recipe.options);
            this._optionMemory = Object.assign({}, recipe.options);
        }

        if (recipe.song && perTune) {
            const songSel = document.getElementById('songSelector');
            if (songSel && recipe.song.subtune) songSel.value = String(recipe.song.subtune);
            const forceLoop = document.getElementById('forceLoopToggle');
            if (forceLoop) forceLoop.checked = !!recipe.song.forceLoop;
            this._loopChoiceTouched = true;   // the recipe decided; don't prompt
            const show = document.getElementById('showSongLengthToggle');
            if (show) show.checked = recipe.song.showLength !== false;
            const manual = document.getElementById('songLengthManual');
            if (manual) manual.value = recipe.song.manualLengthSeconds
                ? this._mmss(recipe.song.manualLengthSeconds) : '';
            this.updateSongLoopStatus();
        }

        if (recipe.naming && recipe.naming.template) {
            const tpl = document.getElementById('filenameTemplate');
            if (tpl) tpl.value = recipe.naming.template;
        }

        if (recipe.options && recipe.options.__compression) {
            const radio = document.querySelector(
                `input[name="compression-type"][value="${recipe.options.__compression}"]`);
            if (radio) radio.checked = true;
        }

        if (window.studioModal) window.studioModal.queueRefresh();
        if (!quiet) {
            this.setRecipeNote(missing.length
                ? `Settings applied. Pick your own image again for: ${missing.join(', ')} — a settings file can't carry the image itself.`
                : 'Settings applied.');
        }
        return true;
    }

    setRecipeNote(text, isError = false) {
        const el = document.getElementById('recipeNote');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? 'var(--warning)' : '';
    }

    _wireRecipeControls() {
        if (this._recipeWired) return;
        this._recipeWired = true;
        const save = document.getElementById('recipeSave');
        if (save) save.addEventListener('click', () => this.saveRecipe(this._builtIfStillCurrent()));
        const always = document.getElementById('recipeAlways');
        if (always) {
            try { always.checked = localStorage.getItem('sidquakeRecipeAlways') === '1'; }
            catch (e) { /* storage blocked: leave it off */ }
            always.addEventListener('change', () => {
                try { localStorage.setItem('sidquakeRecipeAlways', always.checked ? '1' : '0'); }
                catch (e) { /* blocked */ }
            });
        }
        const btn = document.getElementById('recipeLoadBtn');
        const input = document.getElementById('recipeLoad');
        if (btn && input) {
            btn.addEventListener('click', () => input.click());
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                input.value = '';
                if (!file) return;
                try {
                    await this.applyRecipe(JSON.parse(await file.text()));
                } catch (e) {
                    this.setRecipeNote('Could not read that settings file.', true);
                }
            });
        }
    }

    createCompressionOptionsHTML() {
        return `
        <div class="option-group">
            <div class="option-group-title">Compression</div>
            <div class="compression-options">
                <label class="compression-radio-option">
                    <input type="radio"
                           name="compression-type"
                           value="none">
                    <div class="compression-details">
                        <span class="compression-name">None</span>
                        <span class="compression-desc">Biggest file, and you have to type a SYS command to start it</span>
                    </div>
                </label>
                <label class="compression-radio-option">
                    <input type="radio"
                           name="compression-type"
                           value="exomizer"
                           checked>
                    <div class="compression-details">
                        <span class="compression-name">Exomizer</span>
                        <span class="compression-desc">Smallest file. Starts on its own, after a short pause while it unpacks.</span>
                    </div>
                </label>
                <label class="compression-radio-option">
                    <input type="radio"
                           name="compression-type"
                           value="tscrunch">
                    <div class="compression-details">
                        <span class="compression-name">TSCrunch</span>
                        <span class="compression-desc">Slightly bigger, but starts almost instantly on the C64.</span>
                    </div>
                </label>
            </div>
        </div>
    `;
    }

    // Does the current visualizer offer a choice of generation method (i.e. it
    // belongs to a data-source group with more than one variant)? Drives the
    // conditional "Method" tab.
    hasMethodChoice(visualizer = this.selectedVisualizer) {
        const group = visualizer?.dataSourceGroup;
        if (!group || typeof VISUALIZERS === 'undefined') return false;
        return VISUALIZERS.filter(v => v.dataSourceGroup === group).length > 1;
    }

    // "Method" tab: pick how the bars are generated. Large pros/cons cards for
    // Spectrometer (baked FFT) vs the two live methods. The internal ids
    // (fft / realtime / shadow) are mapped to friendly names here.
    createMethodPanelHTML(visualizer) {
        const group = visualizer?.dataSourceGroup;
        if (!group) return '';
        const members = VISUALIZERS.filter(v => v.dataSourceGroup === group);
        if (members.length < 2) return '';
        const current = visualizer.dataSource || 'realtime';
        const variantOf = m => members.find(v => v.dataSource === m);

        const cards = [
            { m: 'fft', name: 'Best looking', tags: ['follows the actual sound'],
              desc: 'SIDquake listens to the whole tune here in the browser and stores what it '
                  + 'hears, so the bars follow the real sound exactly.',
              rows: [['pro', 'The bars match the music closely'],
                     ['pro', 'Works with any tune, however it is written'],
                     ['pro', 'Leaves the C64 the most time for other things'],
                     ['con', 'Makes a bigger file'],
                     ['con', 'Only one tune per file'],
                     ['con', 'A tune that never repeats is cut short — there is only room to store so much'],
                     ['con', 'Has to listen to the tune first — usually under a minute']] },
            { m: 'realtime', name: 'Live · careful', tags: ['recommended', 'works out the bars on the C64', 'smaller file'],
              desc: 'The C64 works the bars out as it plays, from the notes the tune is playing. '
                  + 'This version takes extra care not to disturb the music.',
              rows: [['pro', 'The music sounds exactly as written'],
                     ['pro', 'Keeps every tune in a multi-tune file'],
                     ['pro', 'Smaller file'],
                     ['pro', 'Nothing to work out first — exports straight away'],
                     ['con', 'Leaves the C64 less spare time (it plays the tune twice over)']] },
            { m: 'shadow', name: 'Live · light', tags: ['works out the bars on the C64', 'smallest file'],
              desc: 'The same note-based bars by the older, lighter route.',
              rows: [['pro', 'Leaves the C64 more spare time than the careful version'],
                     ['pro', 'Keeps every tune in a multi-tune file'],
                     ['pro', 'Smallest file'],
                     ['pro', 'Nothing to work out first — exports straight away'],
                     ['con', 'A few tunes sound slightly different this way']] },
        ].filter(c => variantOf(c.m));

        const html = cards.map(c => {
            // Gate on the full build check (calls/SID caps + memory placement) so a
            // method that can't fit this tune (e.g. Clever's save/restore) shows as
            // unavailable here instead of erroring only at export time.
            const u = this.visualizerExportable(variantOf(c.m));
            const sel = current === c.m;
            const rows = c.rows.map(([k, t]) => `<li class="mc-${k}">${t}</li>`).join('');
            const tags = c.tags.map(t => `<span class="mc-tag">${t}</span>`).join('');
            const dis = u.ok ? '' : ' disabled';
            const why = u.ok ? '' : ` <em>— ${u.reason || 'not available for this tune'}</em>`;
            return `<button type="button" class="method-card${sel ? ' selected' : ''}${dis}" data-method="${c.m}"${u.ok ? '' : ` disabled title="${u.reason || 'not available for this tune'}"`}>
                <span class="mc-head"><span class="mc-name">${c.name}</span><span class="mc-tags">${tags}</span></span>
                <span class="mc-desc">${c.desc}${why}</span>
                <ul class="mc-list">${rows}</ul>
            </button>`;
        }).join('');
        return `<div class="method-cards">${html}</div>`
            + '<p class="method-vu-note" id="methodVuNote" hidden></p>';
    }

    /**
     * Both live methods claim a bar only for a voice with the gate open and a
     * waveform selected. Some tunes drive the SID audibly without ever meeting
     * that test, so the bars sit empty while the music plays. Say so wherever the
     * choice is being made rather than letting someone find out from the
     * exported file.
     *
     * The FFT method reads the rendered audio, so it is unaffected - which makes
     * it the answer whenever this fires.
     *
     * The answer is about the TUNE, and it costs 1,200 frames of 6510, so it is
     * worked out once per tune and re-shown from there on every visualizer switch.
     */
    async checkVuVisibility() {
        const h = this.sidHeader;
        if (!h || !this.analyzer || !this.analyzer.Module) return this.renderVuNotes();
        if (this._vuBlindFor === this._analysisToken) return this.renderVuNotes();
        const token = ++this._vuToken;
        let res;
        try {
            const cb = window.cacheBust || (s => s);
            const { analyzeVuVisibility } = await import(cb('./spectrometer-shadow-detect.js'));
            const sidBytes = this.analyzer.createModifiedSID();
            if (!sidBytes) return;
            res = analyzeVuVisibility(this.analyzer.Module, sidBytes, {
                initAddress: h.initAddress,
                playAddress: h.playAddress,
                loadAddress: h.loadAddress,
                subtune: Math.max(0, (h.startSong || 1) - 1),
                numChips: this.analysisResults?.sidChipCount || 1,
                frames: 1200,
            });
        } catch (e) {
            return;   // a warning that cannot be worked out is simply not shown
        }
        if (token !== this._vuToken || !res || !res.frames) return;

        // Only a long leading stretch the listener can actually hear. Frames with
        // every gate closed are ordinary - across the tunes in SID/ they run from
        // 26% to 95% on tunes whose bars are fine - and a tune that genuinely
        // opens with silence has nothing wrong with it either.
        this._vuBlind = (res.leadingSeconds >= 3 && res.leadingAudible) ? res : null;
        this._vuBlindFor = this._analysisToken;
        this.renderVuNotes();
    }

    /**
     * Show the VU-blind warning where the user actually is. The Method panel
     * carries it for whoever opens the Studio; the quick path has no method
     * picker, so it gets the same warning under the looks - but only while a
     * live method is what would be exported.
     */
    renderVuNotes() {
        const res = this._vuBlind;
        const lead = res ? this._mmss(res.leadingSeconds) : '';
        const opening = res
            ? `Heads up: this tune plays its first ${lead} without opening a note the way the `
              + 'live methods look for, so their bars will be empty over that stretch. '
            : '';
        const method = document.getElementById('methodVuNote');
        if (method) {
            method.textContent = opening && `${opening}Best looking reads the sound itself and is unaffected.`;
            method.hidden = !opening;
        }
        const quick = document.getElementById('quickExportWarn');
        if (quick) {
            // dataSource is set only on the bar players this check covers, and
            // 'fft' is the method it does not apply to.
            const source = this.selectedVisualizer?.dataSource;
            const live = !!source && source !== 'fft';
            quick.textContent = opening && `${opening}For bars that follow the sound instead, `
                + 'choose Best looking under Method in "Change everything".';
            quick.hidden = !opening || !live;
        }
    }

    async createLayoutSelectorHTML(visualizer, config) {
        const sidLoadAddress = this.sidHeader?.loadAddress || 0x1000;
        // Full music-data size (see buildVisualizerGrid): keep layout validity
        // consistent with what the export pipeline actually places in memory.
        const sidSize = this.sidHeader?.fileSize || this.analysisResults?.dataBytes || 0x2000;
        const modifiedAddresses = this.analysisResults?.modifiedAddresses || [];

        let sidStart = sidLoadAddress;
        let sidEnd = sidLoadAddress + sidSize - 1;

        // Cap at $FFFF to prevent overflow display issues for high-memory SIDs.
        if (sidEnd > 0xFFFF) sidEnd = 0xFFFF;

        await this.ensurePRGExporter();

        const layouts = this.prgExporter.selectValidLayouts(config, sidLoadAddress, sidSize, modifiedAddresses);

        layouts.sort((a, b) => a.vizStart - b.vizStart);

        const validLayouts = layouts.filter(l => l.valid);

        if (validLayouts.length === 0) {
            return '<div class="option-warning"><i class="fas fa-exclamation-triangle"></i> No compatible memory layouts available</div>';
        }

        let html = '<div class="layout-options">';

        html += `
        <div class="sid-memory-info">
            <span class="sid-memory-label">SID Memory:</span>
            <span class="sid-memory-range">${this.formatHex(sidStart, 4)}-${this.formatHex(sidEnd, 4)}</span>
        </div>
        `;

        let firstValidIndex = -1;
        layouts.forEach((layoutInfo, index) => {
            const layout = layoutInfo.layout;

            const rangeStart = this.formatHex(layoutInfo.vizStart, 4);
            const rangeEnd = this.formatHex(layoutInfo.vizEnd - 1, 4);

            const isValid = layoutInfo.valid;

            if (isValid && firstValidIndex === -1) {
                firstValidIndex = index;
            }

            // Fallback name derived from the high nibble of the start address (e.g. bank4000).
            const bankName = `bank${(layoutInfo.vizStart >> 12).toString(16).toUpperCase()}000`;

            html += `
        <label class="layout-radio-option ${!isValid ? 'disabled' : ''}" 
               ${!isValid ? `title="${layoutInfo.overlapReason}"` : ''}>
            <input type="radio" 
                   name="memory-layout" 
                   value="${layoutInfo.key}" 
                   ${isValid && index === firstValidIndex ? 'checked' : ''}
                   ${!isValid ? 'disabled' : ''}>
            <div class="layout-details">
                <span class="layout-name">${layout.name || bankName}</span>
                <span class="layout-range">${rangeStart}-${rangeEnd}</span>
            </div>
        </label>
    `;
        });

        html += '</div>';
        return html;
    }

    createFileInputHTML(config) {
        // Image inputs use the rich preview UI; everything else uses a plain file picker.
        const isImageInput = config.accept && (
            config.accept.includes('image/') ||
            config.accept.includes('.png')
        );

        if (isImageInput) {
            return `
        <div class="option-row option-row-full">
            <label class="option-label" id="${config.id}-label">${config.label}</label>
            <div class="option-control">
                <div id="${config.id}-preview-container" class="image-input-container" role="group" aria-labelledby="${config.id}-label">
                </div>
            </div>
        </div>
    `;
        } else {
            return `
        <div class="option-row">
            <label class="option-label" for="${config.id}">${config.label}</label>
            <div class="option-control">
                <input type="file" 
                       id="${config.id}" 
                       accept="${config.accept}" 
                       style="display: none;">
                <button type="button"
                        class="file-button"
                        aria-label="${config.label}: choose file"
                        data-file-input="${config.id}">
                    Choose File
                </button>
                <span class="file-status" id="${config.id}-status">
                    ${config.default ? 'Using default' : 'No file selected'}
                </span>
            </div>
        </div>
    `;
        }
    }

    createOptionHTML(config) {
        // showWhen serialized into a data attribute so updateConditionalVisibility can re-evaluate after option changes.
        let dataAttrs = '';
        if (config.showWhen) {
            const showWhenJson = JSON.stringify(config.showWhen).replace(/"/g, '&quot;');
            dataAttrs = ` data-show-when="${showWhenJson}" data-option-id="${config.id}"`;
        }
        let html = `<div class="option-row"${dataAttrs}>`;

        if (config.type === 'number') {
            // Number options whose id mentions "color" and span 0-15 are C64 palette indices; render as a color slider.
            if (config.id && config.id.toLowerCase().includes('color') &&
                config.min === 0 && config.max === 15) {
                html += this.createColorSliderHTML(config);
            } else {
                html += `
                <label class="option-label" for="${config.id}">${config.label}</label>
                <div class="option-control">
                    <input type="number"
                           id="${config.id}"
                           class="number-input"
                           value="${config.default || 0}"
                           min="${config.min || 0}"
                           max="${config.max || 255}">
                    ${config.description ? `<span class="option-hint">${config.description}</span>` : ''}
                </div>
            `;
            }
        } else if (config.type === 'range') {
            // Plain value slider with a live readout (e.g. the loop-detection length).
            const def = config.default != null ? config.default : (config.min || 0);
            const unit = config.unit || '';
            html += `
            <label class="option-label" for="${config.id}">${config.label}</label>
            <div class="option-control">
                <div class="range-control">
                    <input type="range"
                           id="${config.id}"
                           class="range-slider"
                           min="${config.min || 0}"
                           max="${config.max || 100}"
                           step="${config.step || 1}"
                           value="${def}"
                           data-unit="${unit}">
                    <span class="range-value" id="${config.id}-display">${def}${unit}</span>
                </div>
                ${config.description ? `<span class="option-hint">${config.description}</span>` : ''}
            </div>
        `;
        } else if (config.type === 'fontSelector') {
            // Font selector - dynamically populated from FONT_DATA based on fontType
            html += this.createFontSelectorHTML(config, this.currentVisualizerConfig?.fontType || '1x2');
        } else if (config.type === 'imageGrid' || (config.type === 'select' && config.id === 'barStyle')) {
            // Image grid for bar styles - render as clickable thumbnails
            html += this.createBarStyleGridHTML(config);
        } else if (config.type === 'select') {
            // Regular select dropdown
            const selectClass = 'select-input';
            html += `
            <label class="option-label" for="${config.id}">${config.label}</label>
            <div class="option-control">
                <select id="${config.id}" class="${selectClass}">
                    ${config.values.map(v =>
                `<option value="${v.value}" ${v.value === config.default ? 'selected' : ''}>
                            ${v.label}
                        </option>`
            ).join('')}
                </select>
            </div>
        `;
        } else if (config.type === 'date') {
            html += `
            <label class="option-label" for="${config.id}">${config.label}</label>
            <div class="option-control">
                <input type="date" id="${config.id}" class="date-input">
                <span class="date-preview" id="${config.id}-preview">Not set</span>
            </div>
        `;
        } else if (config.type === 'textarea') {
            html += `
            <label class="option-label" for="${config.id}">${config.label}</label>
            <div class="option-control">
                <div class="textarea-container">
                    <textarea
                        id="${config.id}"
                        maxlength="${config.maxLength || 255}"
                        rows="3"
                        placeholder="${config.description || ''}"
                    >${config.default || ''}</textarea>
                    ${config.loadSave ? `
                        <div class="textarea-controls">
                            <button type="button" class="load-text-btn" data-target="${config.id}">Load</button>
                            <button type="button" class="save-text-btn" data-target="${config.id}">Save</button>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
        } else if (config.type === 'colorPicker') {
            // Color picker using color slider UI
            html += this.createColorSliderHTML(config);
        } else if (config.type === 'paletteEditor') {
            // Editable colour fade / column palette with presets + Load/Save
            html += this.createPaletteEditorHTML(config);
        }

        html += '</div>';
        return html;
    }

    // Editable palette: a row of colour swatches the user edits by clicking a
    // swatch then a C64 colour, plus optional presets and file Load/Save. Used
    // for the 6-colour fade (Dynamic Pulse + Fixed Gradient) and the Rainbow
    // Columns hues. A hidden input holds the comma-separated values that
    // prg-builder reads at export time.
    createPaletteEditorHTML(config) {
        const D = window.COLOR_PALETTES_DATA || {};
        const kind = config.kind === 'columns' ? 'columns'
            : config.kind === 'waveform' ? 'waveform' : 'fade';
        const values = this._paletteDefaults(kind);
        const presets = kind === 'fade' ? (D.FADE_PRESETS || []) : [];

        // Waveform is a grid (one editable brightness ramp per SID voice
        // family); fade / columns are a single flat row of swatches.
        const swatchesBlock = kind === 'waveform'
            ? this._waveGridHTML(values)
            : `<div class="palette-swatches palette-swatches--${kind}">${values.map((v, i) => {
                    const c = C64_COLORS[v & 0x0F];
                    return `
                    <button type="button" class="palette-swatch" data-index="${i}" data-value="${v & 0x0F}"
                            title="Slot ${i + 1}: ${c.name} (click to change)">
                        <span class="palette-swatch-chip" style="background:${c.hex}"></span>
                    </button>`;
                }).join('')}</div>`;

        // Fade presets shown as clickable preview icons (replaces the old
        // dropdown). Each icon's thumbnail is drawn later from the preset's own
        // colours, so it always shows exactly what that preset produces.
        const selectedPreset = presets.length ? this._matchFadePreset(values, presets) : -1;
        const presetGrid = presets.length ? `
            <div class="palette-presets" role="group" aria-label="Fade presets">
                ${presets.map((p, i) => `
                    <button type="button" class="palette-preset-icon ${i === selectedPreset ? 'selected' : ''}"
                            data-preset="${i}" title="${p.name} preset"
                            aria-pressed="${i === selectedPreset ? 'true' : 'false'}">
                        <canvas class="palette-preset-canvas" width="120" height="80"
                                data-fade="${p.colors.map(c => c & 0x0F).join(',')}"></canvas>
                        <span class="palette-preset-check"><i class="fas fa-check"></i></span>
                        <span class="palette-preset-name">${p.name}</span>
                    </button>`).join('')}
            </div>` : '';

        const frameTitle = kind === 'waveform' ? 'Waveform colours'
            : kind === 'columns' ? 'Column colours' : 'Fade colours';

        // A "Custom" flag lights up when the current colours match no preset.
        const customFlag = presets.length
            ? `<span class="palette-custom-flag"${selectedPreset === -1 ? '' : ' hidden'}>Custom</span>` : '';

        const hint = kind === 'waveform'
            ? 'Each row is one voice waveform, fading brightest (left) to darkest (right). Click any colour to change it.'
            : presets.length
                ? 'Pick a preset, or click a colour below to fine-tune.'
                : 'Click a colour to change it.';

        return `
        <label class="option-label" id="${config.id}-label">${config.label}</label>
        <div class="option-control palette-editor" role="group" aria-labelledby="${config.id}-label" data-editor-id="${config.id}" data-kind="${kind}">
            <div class="palette-frame">
                <div class="palette-frame-head">
                    <span class="palette-frame-title">${frameTitle}</span>
                    ${customFlag}
                </div>
                ${kind === 'fade' ? `<div class="palette-live">
                    <canvas class="palette-live-canvas" width="240" height="80"
                            aria-label="These colours on the bars"></canvas>
                    <span class="palette-live-label">Your colours</span>
                </div>` : ''}
                ${presetGrid}
                ${swatchesBlock}
                <div class="palette-hint">${hint}</div>
                <div class="palette-controls">
                    <button type="button" class="palette-load" data-target="${config.id}">Load palette…</button>
                    <button type="button" class="palette-save" data-target="${config.id}" disabled>Save palette</button>
                </div>
            </div>
            <input type="hidden" id="${config.id}" value="${values.map(v => v & 0x0F).join(',')}">
        </div>
    `;
    }

    // Default swatch values for a palette editor of the given kind.
    _paletteDefaults(kind) {
        const D = window.COLOR_PALETTES_DATA || {};
        if (kind === 'columns') return (D.DEFAULT_COLUMNS || [2, 10, 8, 7, 13, 5, 3, 14, 6, 4]).slice();
        if (kind === 'waveform') return (D.DEFAULT_WAVE_RAMPS
            || [11, 11, 5, 5, 3, 13, 13, 1, 11, 11, 12, 12, 15, 15, 15, 1,
                11, 11, 6, 6, 4, 14, 14, 1, 11, 2, 10, 2, 10, 1, 10, 1]).slice();
        return (D.DEFAULT_FADE || [1, 13, 3, 5, 2, 9]).slice();
    }

    // Waveform editor: one row per SID voice family, each an editable ramp of
    // WAVE_RAMP_LENGTH swatches. `values` is family-major, dark -> bright; the
    // swatches keep that DOM order (so syncPaletteInput / applyPaletteValues
    // stay index-correct) but CSS lays each row out brightest-on-the-left.
    _waveGridHTML(values) {
        const D = window.COLOR_PALETTES_DATA || {};
        const families = D.WAVE_FAMILY_LABELS || ['Triangle', 'Sawtooth', 'Pulse', 'Noise'];
        const per = D.WAVE_RAMP_LENGTH || 8;
        const rows = families.map((family, f) => {
            let cells = '';
            for (let l = 0; l < per; l++) {
                const idx = f * per + l;
                const v = (values[idx] != null ? values[idx] : 0) & 0x0F;
                const c = C64_COLORS[v];
                const prefix = `${family} — level ${l + 1}`;
                cells += `
                    <button type="button" class="palette-swatch" data-index="${idx}" data-value="${v}"
                            data-title-prefix="${prefix}" title="${prefix}: ${c.name} (click to change)">
                        <span class="palette-swatch-chip" style="background:${c.hex}"></span>
                    </button>`;
            }
            return `
                <div class="palette-wave-row">
                    <span class="palette-wave-row-label">${family}</span>
                    <div class="palette-wave-cells">${cells}</div>
                </div>`;
        }).join('');
        return `
            <div class="palette-wave-grid">
                <div class="palette-wave-legend">
                    <span class="palette-wave-row-label"></span>
                    <div class="palette-wave-legend-scale"><span>Brightest</span><span>Darkest</span></div>
                </div>
                ${rows}
            </div>`;
    }

    // Return the index of the fade preset whose colours exactly match `values`,
    // or -1 (Custom) if none do.
    _matchFadePreset(values, presets) {
        const list = presets || (window.COLOR_PALETTES_DATA && window.COLOR_PALETTES_DATA.FADE_PRESETS) || [];
        const v = values.map(x => x & 0x0F);
        return list.findIndex(p => p.colors.length === v.length
            && p.colors.every((c, i) => (c & 0x0F) === v[i]));
    }

    // Highlight preset icon `index` (-1 = none/Custom) and toggle the Custom flag.
    _selectFadePreset(editor, index) {
        editor.querySelectorAll('.palette-preset-icon').forEach(icon => {
            const on = parseInt(icon.dataset.preset) === index;
            icon.classList.toggle('selected', on);
            icon.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        const flag = editor.querySelector('.palette-custom-flag');
        if (flag) flag.hidden = index !== -1;
    }

    // Re-evaluate which preset (if any) the editor's current colours match and
    // update the icon highlight. No-op for non-fade editors.
    _syncFadePresetSelection(editor) {
        if (editor.dataset.kind !== 'fade') return;
        const input = document.getElementById(editor.dataset.editorId);
        if (!input) return;
        const values = input.value.split(',').map(s => parseInt(s, 10) & 0x0F);
        this._selectFadePreset(editor, this._matchFadePreset(values));
    }

    /**
     * Redraw the fade editor's own preview from the values currently in it. The
     * presets have always shown what they produce; the colours the user then
     * edits by hand did not, so fine-tuning was done against six flat swatches
     * with no idea what the bars would look like.
     */
    _drawLivePalette(editor) {
        if (!editor || editor.dataset.kind !== 'fade') return;
        const canvas = editor.querySelector('.palette-live-canvas');
        const input = document.getElementById(editor.dataset.editorId);
        if (!canvas || !input) return;
        const values = input.value.split(',').map(v => parseInt(v, 10) & 0x0F);
        this._drawFadePresetCanvas(canvas, values);
    }

    // Draw a preset's live preview: a small spectrum whose bars are coloured by
    // the preset's own fade (the Dynamic Pulse mapping), so the thumbnail can
    // never drift from what the preset actually produces.
    _drawFadePresetCanvas(canvas, colors) {
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return;
        const W = canvas.width, H = canvas.height;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, W, H);

        const D = window.COLOR_PALETTES_DATA;
        const table = D && D.getHeightColorTable ? D.getHeightColorTable('water', colors) : null;
        const maxH = table ? table.length - 9 : 111;   // COLOR_TABLE_SIZE_WATER - 9

        // Fixed silhouette spanning the height range so every fade colour shows.
        const fracs = [0.35, 0.6, 0.85, 1.0, 0.5, 0.75, 0.45, 0.9, 0.55, 0.7];
        const n = fracs.length;
        const slot = Math.floor(W / n);
        const barW = Math.max(1, slot - 1);
        for (let i = 0; i < n; i++) {
            const f = fracs[i];
            const idx = table
                ? table[Math.min(table.length - 1, Math.round(f * maxH))]
                : (colors[Math.floor((1 - f) * colors.length)] & 0x0F);
            ctx.fillStyle = (C64_COLORS[idx & 0x0F] || C64_COLORS[0]).hex;
            const barH = Math.max(2, Math.round(f * (H - 2)));
            ctx.fillRect(i * slot, H - barH, barW, barH);
        }
    }

    createColorSliderHTML(config) {
        const defaultValue = config.default || 0;
        const defaultColor = C64_COLORS[defaultValue];

        return `
        <label class="option-label" for="${config.id}">${config.label}</label>
        <div class="option-control color-slider-control">
            <div class="slider-wrapper">
                <input type="range"
                       id="${config.id}"
                       class="color-slider"
                       min="0"
                       max="15"
                       value="${defaultValue}"
                       data-config-id="${config.id}">
                <div class="color-slider-track">
                    ${C64_COLORS.map(c => `
                        <div class="color-segment"
                             style="background: ${c.hex}"
                             data-value="${c.value}"
                             data-name="${c.name}"
                             title="${c.value}: ${c.name}">
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="color-value" id="${config.id}-display">
                <span class="color-swatch" style="background: ${defaultColor.hex}"></span>
                <span class="color-text">
                    <span class="color-number">${defaultValue}</span>:
                    <span class="color-name">${defaultColor.name}</span>
                </span>
            </div>
        </div>
    `;
    }

    // Build the font list for a given font type from FONT_DATA.
    _fontList(config, fontType) {
        let fonts = [];
        if (typeof FONT_DATA !== 'undefined' && FONT_DATA.KNOWN_FONTS[fontType]) {
            const dim = FONT_DATA.FONT_DIMENSIONS[fontType];
            fonts = FONT_DATA.KNOWN_FONTS[fontType].map((font, index) => ({
                value: index,
                label: font.name,
                shortLabel: font.id,
                id: font.id,
                isROM: !!font.isROM,
                caseType: font.caseType ?? FONT_DATA.FONT_CASE_MIXED,
                imagePath: font.isROM ? '' : `${dim.folder}/font-${fontType}-${font.id}.png`
            }));
            // Visualizers with no ROM-charset fallback path (font chars are only
            // ever populated by injection) set excludeROM so the ROM sentinel
            // isn't offered. Values stay as the original KNOWN_FONTS indices.
            if (config.excludeROM) fonts = fonts.filter(f => !f.isROM);
        }
        return fonts;
    }

    // Case badge (upper / lower / both): "ABC" = uppercase only, "abc" =
    // lowercase only, "Aa" = both. Doubles as its own legend.
    _fontCaseBadge(caseType) {
        let text, title;
        if (caseType === FONT_DATA.FONT_CASE_UPPER_ONLY) { text = 'ABC'; title = 'Uppercase only'; }
        else if (caseType === FONT_DATA.FONT_CASE_LOWER_ONLY) { text = 'abc'; title = 'Lowercase only'; }
        else { text = 'Aa'; title = 'Upper & lowercase'; }
        return `<span class="font-case-badge" title="${title}">${text}</span>`;
    }

    // One font thumbnail tile (shared by the modal grid and the compact preview).
    _fontThumbHTML(v, isSelected) {
        if (v.isROM) {
            return `<div class="bar-style-thumbnail placeholder ${isSelected ? 'selected' : ''}"
                     role="radio" aria-checked="${isSelected}" tabindex="${isSelected ? 0 : -1}"
                     data-value="${v.value}" data-font-id="${v.id}"
                     aria-label="${v.label}" title="${v.label}">
                    <span>ROM</span>${this._fontCaseBadge(v.caseType)}
                    <span class="selected-check"><i class="fas fa-check"></i></span>
                    <span class="style-name">${v.label}</span></div>`;
        }
        return `<div class="bar-style-thumbnail ${isSelected ? 'selected' : ''}"
                 role="radio" aria-checked="${isSelected}" tabindex="${isSelected ? 0 : -1}"
                 data-value="${v.value}" data-font-id="${v.id}" data-font-path="${v.imagePath}"
                 aria-label="${v.label}" title="${v.label}">
                <img class="font-thumbnail-img" alt="${v.label}">
                ${this._fontCaseBadge(v.caseType)}
                <span class="selected-check"><i class="fas fa-check"></i></span>
                <span class="style-name">${v.shortLabel}</span></div>`;
    }

    // Font control (mirrors the Logo tab): a small preview of the selected
    // font on top, with the full font selector grid inline below. Fonts can
    // only be chosen from our gallery (custom font loading isn't supported yet
    // — glyph layout is ambiguous).
    createFontSelectorHTML(config, fontType) {
        const defaultValue = config.default || 0;
        const fonts = this._fontList(config, fontType);

        if (fonts.length === 0) {
            return `
                <div class="bar-style-container">
                    <span class="bar-style-label">${config.label}</span>
                    <div class="font-no-fonts">No fonts available for this visualizer</div>
                    <input type="hidden" id="${config.id}" value="0">
                </div>
            `;
        }

        const selected = fonts.find(f => f.value === defaultValue) || fonts[0];
        const thumbs = fonts.map(f => this._fontThumbHTML(f, f.value === defaultValue)).join('');

        // Load thumbnails for both the small preview and the full grid.
        setTimeout(() => {
            this.loadFontThumbnails(config.id + '-current', fontType);
            this.loadFontThumbnails(config.id, fontType);
        }, 0);

        return `
            <div class="bar-style-container font-selector" data-config-id="${config.id}" data-font-type="${fontType}">
                <span class="bar-style-label" id="${config.id}-grid-label">${config.label}</span>
                <!-- The current-font preview mirrors the grid below; it is not a
                     second control, so it stays out of the tab order and the
                     accessibility tree. -->
                <div class="font-selector-current" id="${config.id}-current-grid" aria-hidden="true">
                    ${this._fontThumbHTML(selected, true)}
                </div>
                <div class="bar-style-grid font-selector-grid" id="${config.id}-grid" data-config-id="${config.id}"
                     role="radiogroup" aria-labelledby="${config.id}-grid-label">
                    ${thumbs}
                </div>
                <input type="hidden" id="${config.id}" value="${defaultValue}">
            </div>
        `;
    }

    // Refresh the small font preview to mirror the current hidden value.
    updateFontPreview(configId, fontType) {
        const cur = document.getElementById(configId + '-current-grid');
        const hidden = document.getElementById(configId);
        if (!cur || !hidden) return;
        const config = (this.currentVisualizerConfig?.options || []).find(o => o.id === configId) || { id: configId };
        const f = this._fontList(config, fontType).find(x => x.value === (parseInt(hidden.value) || 0));
        if (!f) return;
        cur.innerHTML = this._fontThumbHTML(f, true);
        this.loadFontThumbnails(configId + '-current', fontType);
    }

    async loadFontThumbnails(configId, fontType) {
        const grid = document.getElementById(`${configId}-grid`);
        if (!grid) return;

        const thumbnailDivs = grid.querySelectorAll('.bar-style-thumbnail');
        for (const div of thumbnailDivs) {
            const fontPath = div.dataset.fontPath;
            const img = div.querySelector('.font-thumbnail-img');
            if (fontPath && img) {
                try {
                    // Generate 64x64 thumbnail from top-left of font PNG
                    const thumbnailDataUrl = await FONT_DATA.generateFontThumbnail(fontPath);
                    img.src = thumbnailDataUrl;
                } catch (e) {
                    // Show placeholder on error
                    div.classList.add('placeholder');
                    img.style.display = 'none';
                    const fontId = div.dataset.fontId || div.dataset.value;
                    div.querySelector('.style-name').insertAdjacentHTML('beforebegin', `<span>${fontId}</span>`);
                }
            }
        }
    }

    // Move a grid's selection: the hidden input the exporter reads, the visual
    // state, the radio state, and the roving tabindex that keeps the group to a
    // single tab stop. Used by clicks, by the arrow keys, and by the session
    // option memory when it restores a value.
    selectGridThumb(grid, thumbnail) {
        if (!grid || !thumbnail) return;
        const configId = grid.dataset.configId;
        const hiddenInput = configId && document.getElementById(configId);
        if (hiddenInput) hiddenInput.value = parseInt(thumbnail.dataset.value);

        for (const t of grid.querySelectorAll('.bar-style-thumbnail')) {
            const on = t === thumbnail;
            t.classList.toggle('selected', on);
            t.setAttribute('aria-checked', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
        }

        // The colour-effect grid gates which palette editor is shown.
        if (configId === 'colorEffect') this.updateConditionalVisibility();
    }

    createBarStyleGridHTML(config) {
        const defaultValue = config.default || 0;

        // Generate thumbnails for each style option
        const thumbnailsHTML = config.values.map(v => {
            const isSelected = v.value === defaultValue;
            // Use custom image path from config if available, otherwise use bar-style convention
            const imagePath = v.image || `prg/bar-styles/style-${v.value}.png`;
            // Use shortLabel if available, otherwise extract first word from label
            const displayLabel = v.shortLabel || v.label.split(' - ')[0] || v.label;

            return `
                <div class="bar-style-thumbnail ${isSelected ? 'selected' : ''}"
                     role="radio" aria-checked="${isSelected}" tabindex="${isSelected ? 0 : -1}"
                     data-value="${v.value}"
                     aria-label="${v.label}"
                     title="${v.label}">
                    <img src="${imagePath}"
                         alt="Style ${v.value}"
                         onerror="this.onerror=null;this.parentElement.classList.add('placeholder'); this.style.display='none'; this.parentElement.querySelector('.style-name').insertAdjacentHTML('beforebegin', '<span>${v.value}</span>');">
                    <span class="selected-check"><i class="fas fa-check"></i></span>
                    <span class="style-name">${displayLabel}</span>
                </div>
            `;
        }).join('');

        return `
            <div class="bar-style-container">
                <span class="bar-style-label" id="${config.id}-grid-label">${config.label}</span>
                <div class="bar-style-grid" id="${config.id}-grid" data-config-id="${config.id}"
                     role="radiogroup" aria-labelledby="${config.id}-grid-label">
                    ${thumbnailsHTML}
                </div>
                <input type="hidden" id="${config.id}" value="${defaultValue}">
            </div>
        `;
    }

    async attachOptionEventListeners(config) {
        // Scope element queries to the Studio panels (every option control is
        // re-rendered inside them on each visualizer selection). Document-wide
        // queries would also match persistent elements outside (e.g. the main
        // #fileInput) and stack duplicate listeners on them.
        const panel = document.getElementById('studioPanels') || document;

        // Lazy-load and initialize image preview manager if not already created
        if (!window.imagePreviewManager) {
            await window.loadScript('image-preview-manager.js');
            window.imagePreviewManager = new ImagePreviewManager();
        }

        // Set up image previews for image inputs
        if (config && config.inputs) {
            config.inputs.forEach(inputConfig => {
                const isImageInput = inputConfig.accept && (inputConfig.accept.includes('image/') || inputConfig.accept.includes('.png'));
                if (isImageInput) {
                    const container = document.getElementById(`${inputConfig.id}-preview-container`);
                    if (container) {
                        const previewElement = window.imagePreviewManager.createImagePreview(inputConfig);
                        container.appendChild(previewElement);
                        // Skip the default when a remembered selection is about to
                        // be restored onto this input (_restoreImageSelections),
                        // so the preview doesn't flash the default first.
                        if (!this._pendingImageFor(inputConfig)) {
                            window.imagePreviewManager.loadDefaultImage(inputConfig);
                        }
                    }
                }
            });
        }

        if (config && config.options) {
            config.options.forEach(optionConfig => {
                if (optionConfig.type === 'textarea') {
                    const textarea = document.getElementById(optionConfig.id);
                    if (!textarea) return;

                    // Create the drop zone (lazy-loaded)
                    if (typeof TextDropZone !== 'undefined') {
                        TextDropZone.create(optionConfig.id);
                    } else {
                        window.loadScript('text-drop-zone.js').then(() => TextDropZone.create(optionConfig.id));
                    }

                    // Initialize sanitizer (already loaded by ensurePRGExporter)
                    if (!window.petsciiSanitizer && typeof PETSCIISanitizer !== 'undefined') {
                        window.petsciiSanitizer = new PETSCIISanitizer();
                    }

                    // Add warning display element if it doesn't exist
                    if (!document.getElementById(`${optionConfig.id}-warnings`)) {
                        const warningDiv = document.createElement('div');
                        warningDiv.id = `${optionConfig.id}-warnings`;
                        warningDiv.className = 'textarea-warnings';
                        warningDiv.style.cssText = `
                        margin-top: 5px;
                        padding: 8px;
                        background: #fff3cd;
                        border: 1px solid #ffc107;
                        border-radius: 4px;
                        color: #856404;
                        font-size: 0.85em;
                        display: none;
                    `;
                        textarea.parentNode.appendChild(warningDiv);
                    }

                    // Add character counter if maxLength is specified
                    if (optionConfig.maxLength) {
                        const counterDiv = document.createElement('div');
                        counterDiv.id = `${optionConfig.id}-counter`;
                        counterDiv.className = 'textarea-counter';
                        counterDiv.style.cssText = `
                        margin-top: 3px;
                        text-align: right;
                        color: #6c757d;
                        font-size: 0.85em;
                    `;
                        textarea.parentNode.appendChild(counterDiv);
                    }

                    // Real-time validation function
                    const validateTextarea = () => {
                        const text = textarea.value;
                        const warningDiv = document.getElementById(`${optionConfig.id}-warnings`);
                        const counterDiv = document.getElementById(`${optionConfig.id}-counter`);

                        // Sanitize the text
                        const result = window.petsciiSanitizer.sanitize(text, {
                            maxLength: optionConfig.maxLength,
                            preserveNewlines: false,
                            reportUnknown: true
                        });

                        // Update character counter
                        if (counterDiv && optionConfig.maxLength) {
                            const remaining = optionConfig.maxLength - text.length;
                            counterDiv.textContent = `${text.length} / ${optionConfig.maxLength} characters`;

                            if (remaining < 0) {
                                counterDiv.style.color = '#dc3545';
                            } else if (remaining < 20) {
                                counterDiv.style.color = '#ffc107';
                            } else {
                                counterDiv.style.color = '#6c757d';
                            }
                        }

                        // Show warnings
                        if (result.hasWarnings && warningDiv) {
                            let warningHTML = '<strong><i class="fas fa-exclamation-triangle"></i> Character compatibility issues:</strong><br>';

                            result.warnings.forEach(warning => {
                                if (warning.type === 'unknown_characters') {
                                    warningHTML += `Found incompatible characters: `;
                                    warning.characters.forEach((char, idx) => {
                                        if (idx > 0) warningHTML += ', ';
                                        warningHTML += `"${char}"`;
                                    });
                                    warningHTML += '<br>These will be replaced with spaces on export.';
                                } else if (warning.type === 'truncated') {
                                    warningHTML += `Text will be truncated to ${optionConfig.maxLength} characters.`;
                                }
                            });

                            warningDiv.innerHTML = warningHTML;
                            warningDiv.style.display = 'block';
                        } else if (warningDiv) {
                            warningDiv.style.display = 'none';
                        }
                    };

                    // Attach event listeners
                    textarea.addEventListener('input', () => {
                        validateTextarea();
                        // Some options (e.g. font/scroll colour) only show when this has text.
                        this.updateConditionalVisibility();
                    });
                    textarea.addEventListener('paste', () => {
                        setTimeout(() => {
                            validateTextarea();
                            this.updateConditionalVisibility();
                        }, 10); // Small delay to let paste complete
                    });

                    // Initial validation if there's default text
                    if (textarea.value) {
                        validateTextarea();
                    }
                }
            });
        }

        // Traditional file input handlers (for non-image files). Scoped to
        // buttons that name a target input via data-file-input; other
        // .file-button uses (logo Browse/Gallery, Choose Font) wire themselves.
        panel.querySelectorAll('.file-button[data-file-input]').forEach(button => {
            button.addEventListener('click', (e) => {
                const inputId = e.currentTarget.dataset.fileInput;
                const el = document.getElementById(inputId);
                if (el) el.click();
            });
        });

        panel.querySelectorAll('input[type="file"]:not([accept*="image"]):not([accept*=".png"])').forEach(input => {
            input.addEventListener('change', (e) => {
                const statusEl = document.getElementById(`${e.target.id}-status`);
                if (statusEl && e.target.files.length > 0) {
                    statusEl.textContent = e.target.files[0].name;
                    statusEl.classList.add('has-file');
                }
            });
        });

        // Date input handlers
        panel.querySelectorAll('input[type="date"]').forEach(input => {
            input.addEventListener('change', (e) => {
                const previewEl = document.getElementById(`${e.target.id}-preview`);
                if (previewEl) {
                    previewEl.textContent = this.formatDateForDisplay(e.target.value);
                }
            });
        });

        // Color slider handlers
        panel.querySelectorAll('.color-slider').forEach(slider => {
            // Handle slider input changes (for programmatic changes)
            slider.addEventListener('input', (e) => {
                this.updateColorDisplay(e.target);
            });
        });

        // Plain range sliders: keep the live value readout in sync.
        panel.querySelectorAll('.range-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const disp = document.getElementById(`${e.target.id}-display`);
                if (disp) disp.textContent = `${e.target.value}${e.target.dataset.unit || ''}`;
            });
        });

        // Handle direct clicks on color segments
        panel.querySelectorAll('.color-segment').forEach(segment => {
            segment.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent event bubbling
                const value = parseInt(e.target.dataset.value);
                const slider = e.target.closest('.slider-wrapper').querySelector('.color-slider');
                if (slider) {
                    slider.value = value;
                    // Trigger the input event manually
                    const event = new Event('input', { bubbles: true });
                    slider.dispatchEvent(event);
                }
            });
        });

        // Bar style / colour effect / font grids. They are radio groups: one tab
        // stop for the whole grid, arrows to move (so a 30-font grid costs one
        // Tab, not thirty), and the value lives in the hidden input as before.
        panel.querySelectorAll('.bar-style-grid').forEach(grid => {
            grid.addEventListener('click', (e) => {
                const thumbnail = e.target.closest('.bar-style-thumbnail');
                if (thumbnail) this.selectGridThumb(grid, thumbnail);
            });

            grid.addEventListener('keydown', (e) => {
                const thumbs = [...grid.querySelectorAll('.bar-style-thumbnail')];
                if (!thumbs.length) return;
                const here = e.target.closest('.bar-style-thumbnail');
                const i = here ? thumbs.indexOf(here) : 0;
                let next = null;
                switch (e.key) {
                    case 'ArrowRight': case 'ArrowDown': next = thumbs[(i + 1) % thumbs.length]; break;
                    case 'ArrowLeft': case 'ArrowUp': next = thumbs[(i - 1 + thumbs.length) % thumbs.length]; break;
                    case 'Home': next = thumbs[0]; break;
                    case 'End': next = thumbs[thumbs.length - 1]; break;
                    case ' ': case 'Enter': next = here; break;
                    default: return;
                }
                e.preventDefault();
                if (next) {
                    this.selectGridThumb(grid, next);
                    next.focus();
                }
            });
        });

        // Method tab: pick the generation method (Spectrometer / Real-time cards).
        panel.querySelectorAll('.method-card[data-method]').forEach(card => {
            card.addEventListener('click', () => {
                if (card.disabled) return;
                this.selectDataSource(card.dataset.method);
            });
        });

        // Font control: the inline grid's clicks are handled by the generic
        // bar-style-grid handler (updates the hidden value + selection); we
        // just keep the small preview in sync on top.
        panel.querySelectorAll('.font-selector').forEach(fs => {
            const configId = fs.dataset.configId;
            const fontType = fs.dataset.fontType;
            const grid = fs.querySelector('.font-selector-grid');
            if (grid) grid.addEventListener('click', () => this.updateFontPreview(configId, fontType));
        });

        // Initial update of conditional visibility
        this.updateConditionalVisibility();

        // Textarea load/save handlers
        panel.querySelectorAll('.load-text-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                this.loadScrollText(e.target.getAttribute('data-target'));
            });
        });

        panel.querySelectorAll('.save-text-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                this.saveScrollText(e.target.getAttribute('data-target'));
            });
        });

        // Palette editors (colour fade + column colours + waveform colours)
        panel.querySelectorAll('.palette-editor').forEach(editor => {
            // Clicking a swatch opens the 16-colour modal to recolour that slot.
            editor.querySelectorAll('.palette-swatch').forEach(sw => {
                sw.addEventListener('click', () => {
                    this.openColorModal(parseInt(sw.dataset.value), (value) => {
                        this.setPaletteSwatch(sw, value);
                        this.syncPaletteInput(editor);
                        this._syncFadePresetSelection(editor);
                        this.markPaletteDirty(editor);
                    });
                });
            });
            // Fade presets -> clickable preview icons. Draw each thumbnail from
            // the preset's own colours, and load that fade when clicked.
            editor.querySelectorAll('.palette-preset-icon').forEach(icon => {
                const canvas = icon.querySelector('.palette-preset-canvas');
                if (canvas) {
                    const colors = (canvas.dataset.fade || '').split(',')
                        .map(n => parseInt(n, 10) & 0x0F);
                    this._drawFadePresetCanvas(canvas, colors);
                }
                icon.addEventListener('click', () => {
                    const p = (window.COLOR_PALETTES_DATA.FADE_PRESETS || [])[parseInt(icon.dataset.preset)];
                    if (!p) return;
                    this.applyPaletteValues(editor, p.colors);
                    this.markPaletteDirty(editor);
                });
            });
            // ...and the editor's own preview, from whatever is in it now.
            this._drawLivePalette(editor);
            editor.querySelector('.palette-load')?.addEventListener('click', () => this.loadPalette(editor));
            editor.querySelector('.palette-save')?.addEventListener('click', () => this.savePalette(editor));
        });
    }

    // Once the user has changed a palette, its Save button becomes usable.
    markPaletteDirty(editor) {
        editor.dataset.dirty = '1';
        const save = editor.querySelector('.palette-save');
        if (save) save.disabled = false;
    }

    // A single reusable 16-colour picker modal, created on first use and reused
    // by every palette swatch / slot. onPick receives the chosen 0..15 value.
    openColorModal(currentValue, onPick) {
        let overlay = document.getElementById('colorPickerModal');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'colorPickerModal';
            overlay.className = 'color-picker-overlay';
            overlay.setAttribute('data-overlay', '');
            overlay.innerHTML = `
                <div class="color-picker-dialog" role="dialog" aria-label="Choose colour">
                    <div class="color-picker-head">
                        <span>Choose a colour</span>
                        <button type="button" class="color-picker-close" aria-label="Close">&times;</button>
                    </div>
                    <div class="color-picker-grid">
                        ${C64_COLORS.map(c => `
                            <button type="button" class="color-picker-cell" data-value="${c.value}"
                                    title="${c.value}: ${c.name}">
                                <span class="color-picker-chip" style="background:${c.hex}"></span>
                                <span class="color-picker-label">${c.name}</span>
                            </button>`).join('')}
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const close = () => this._closeColorModal();
            overlay.querySelector('.color-picker-close').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            overlay.querySelectorAll('.color-picker-cell').forEach(cell => {
                cell.addEventListener('click', () => {
                    if (this._colorModalPick) this._colorModalPick(parseInt(cell.dataset.value) & 0x0F);
                    this._closeColorModal();
                });
            });
            // Escape closes; Tab is trapped so focus can't fall through to the
            // Studio/palette behind the picker.
            this._colorModalKeyHandler = (e) => {
                if (e.key === 'Escape') { close(); return; }
                if (e.key !== 'Tab') return;
                const focusable = [...overlay.querySelectorAll('button')]
                    .filter(el => !el.disabled && el.offsetParent !== null);
                if (!focusable.length) return;
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                else if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            };
        }
        this._colorModalPick = onPick;
        // Return focus here (the swatch that opened the picker) on close.
        this._colorModalOpener = document.activeElement;
        overlay.querySelectorAll('.color-picker-cell').forEach(cell => {
            cell.classList.toggle('selected', parseInt(cell.dataset.value) === (currentValue & 0x0F));
        });
        overlay.classList.add('visible');
        document.addEventListener('keydown', this._colorModalKeyHandler);
        // Focus the currently-selected colour (else the first) so keyboard users
        // land inside the dialog.
        const selected = overlay.querySelector('.color-picker-cell.selected') ||
            overlay.querySelector('.color-picker-cell');
        if (selected) selected.focus();
    }

    _closeColorModal() {
        const overlay = document.getElementById('colorPickerModal');
        if (overlay) overlay.classList.remove('visible');
        if (this._colorModalKeyHandler) document.removeEventListener('keydown', this._colorModalKeyHandler);
        this._colorModalPick = null;
        if (this._colorModalOpener && typeof this._colorModalOpener.focus === 'function') {
            this._colorModalOpener.focus();
        }
        this._colorModalOpener = null;
    }

    setPaletteSwatch(swatch, value) {
        const v = value & 0x0F;
        swatch.dataset.value = v;
        const chip = swatch.querySelector('.palette-swatch-chip');
        if (chip) chip.style.background = C64_COLORS[v].hex;
        const prefix = swatch.dataset.titlePrefix
            ? `${swatch.dataset.titlePrefix}: `
            : `Slot ${parseInt(swatch.dataset.index) + 1}: `;
        swatch.title = `${prefix}${C64_COLORS[v].name} (click to change)`;
    }

    syncPaletteInput(editor) {
        const input = document.getElementById(editor.dataset.editorId);
        if (!input) return;
        input.value = Array.from(editor.querySelectorAll('.palette-swatch'))
            .map(s => parseInt(s.dataset.value) & 0x0F).join(',');
        this._drawLivePalette(editor);
    }

    applyPaletteValues(editor, values) {
        const swatches = editor.querySelectorAll('.palette-swatch');
        swatches.forEach((sw, i) => {
            if (values[i] !== undefined) this.setPaletteSwatch(sw, values[i]);
        });
        this.syncPaletteInput(editor);
        this._syncFadePresetSelection(editor);
    }

    savePalette(editor) {
        const input = document.getElementById(editor.dataset.editorId);
        if (!input) return;
        // Store as space-free hex so the file is tiny and human-editable.
        const hex = input.value.split(',')
            .map(s => (parseInt(s.trim(), 10) & 0x0F).toString(16)).join(',');
        const blob = new Blob([hex + '\n'], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${editor.dataset.editorId}.pal`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    loadPalette(editor) {
        const count = editor.querySelectorAll('.palette-swatch').length;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.pal,.fade,.txt';
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                // Accept hex or decimal, separated by commas/space/newlines.
                const vals = String(ev.target.result).trim().split(/[\s,]+/)
                    .map(s => parseInt(s, 16))
                    .filter(n => !isNaN(n))
                    .map(n => n & 0x0F);
                if (!vals.length) return;
                // Pad/truncate to this editor's slot count.
                while (vals.length < count) vals.push(vals[vals.length - 1]);
                this.applyPaletteValues(editor, vals.slice(0, count));
                this.markPaletteDirty(editor);
            };
            reader.readAsText(file);
        };
        fileInput.click();
    }

    updateColorDisplay(slider) {
        const value = parseInt(slider.value);
        const color = C64_COLORS[value];
        const displayEl = document.getElementById(`${slider.id}-display`);

        if (displayEl) {
            displayEl.innerHTML = `
            <span class="color-swatch" style="background: ${color.hex}"></span>
            <span class="color-text">
                <span class="color-number">${value}</span>:
                <span class="color-name">${color.name}</span>
            </span>
        `;
        }
    }

    updateConditionalVisibility() {
        // Find all option rows with showWhen conditions
        document.querySelectorAll('.option-row[data-show-when]').forEach(row => {
            const showWhen = JSON.parse(row.dataset.showWhen);
            let shouldShow = true;

            // Evaluate each condition in showWhen
            for (const [dependsOnId, condition] of Object.entries(showWhen)) {
                const dependsOnElement = document.getElementById(dependsOnId);
                if (dependsOnElement) {
                    if (condition === 'nonempty') {
                        // Text/textarea condition: visible only when the field has content
                        if (dependsOnElement.value.trim().length === 0) {
                            shouldShow = false;
                            break;
                        }
                    } else {
                        // Numeric condition: value must be one of the allowed values
                        const currentValue = parseInt(dependsOnElement.value);
                        if (!condition.includes(currentValue)) {
                            shouldShow = false;
                            break;
                        }
                    }
                }
            }

            // Toggle visibility
            row.style.display = shouldShow ? '' : 'none';
        });
    }

    updateFileInfo(header) {
        this.elements.sidTitle.value = header.name || '';
        this.elements.sidAuthor.value = header.author || '';
        this.elements.sidCopyright.value = header.copyright || '';
        this.updateMetadataCounts();

        this.elements.sidFormat.textContent = header.format;
        this.elements.sidVersion.textContent = `v${header.version}`;
        this.elements.sidSongs.textContent = `${header.startSong}/${header.songs}`;
    }

    updateTechnicalInfo(header) {
        this.elements.loadAddress.textContent = this.formatHex(header.loadAddress, 4);
        this.elements.initAddress.textContent = this.formatHex(header.initAddress, 4);
        this.elements.playAddress.textContent = this.formatHex(header.playAddress, 4);

        const endAddr = header.loadAddress + header.fileSize - 1;
        this.elements.memoryRange.textContent =
            `${this.formatHex(header.loadAddress, 4)} - ${this.formatHex(endAddr, 4)}`;

        this.elements.fileSize.textContent = `${header.fileSize} bytes`;
        this.elements.clockType.textContent = header.clockType;
        this.elements.sidModel.textContent = header.sidModel;

        // Always show the modified memory count.
        this.updateModifiedMemoryCount();
    }

    updateModifiedMemoryCount() {
        const allModified = this.analysisResults?.modifiedAddresses || [];

        // Apply the same filtering as save/restore routines
        const filtered = allModified.filter(addr => {
            if (addr >= 0x0100 && addr <= 0x01FF) return false; // Stack
            if (addr >= 0xD400 && addr <= 0xD7FF) return false; // SID I/O
            return true;
        });

        const modifiedCount = filtered.length;

        // Check if the row already exists
        let modifiedRow = document.getElementById('modifiedMemoryRow');
        if (!modifiedRow) {
            // Create the row if it doesn't exist
            const infoPanels = document.getElementById('infoPanels');
            const technicalPanel = infoPanels.querySelector('.panel:nth-child(2)'); // Technical Details panel

            modifiedRow = document.createElement('div');
            modifiedRow.id = 'modifiedMemoryRow';
            modifiedRow.className = 'info-row';
            modifiedRow.innerHTML = `
            <span class="info-label">Modified Memory:</span>
            <span class="info-value" id="modifiedMemoryCount">-</span>
        `;

            // Insert before Clock Type row (which is third from last)
            const clockRow = technicalPanel.querySelector('#clockType').closest('.info-row');
            technicalPanel.insertBefore(modifiedRow, clockRow);
        }

        // Update the value
        const countElement = document.getElementById('modifiedMemoryCount');
        // An init routine that never returned means its subtune was skipped, so we
        // have NO memory map for it. Saying "None" there is actively misleading -
        // it reads as "this tune is easy to place around" when the truth is the
        // opposite, and exports built on it overwrite memory the tune is using.
        const initTimeouts = this.analysisResults?.initTimeouts || 0;
        if (initTimeouts > 0 && modifiedCount === 0) {
            countElement.textContent = 'Unknown (init did not finish)';
            countElement.title = `${initTimeouts} subtune(s) had an init routine that never returned, ` +
                `so their memory use could not be traced. Exports that need this information ` +
                `(anything but the default player) may not work for this tune.`;
            return;
        }
        countElement.title = '';
        if (modifiedCount === 0) {
            countElement.textContent = 'None';
        } else if (modifiedCount === 1) {
            countElement.textContent = '1 location';
        } else {
            countElement.textContent = `${modifiedCount} locations`;
        }
    }

    updateSongTitle(header) {
        this.elements.songTitle.textContent = header.name || 'Unknown Title';
        this.elements.songAuthor.textContent = header.author || 'Unknown Author';
    }

    updateZeroPageInfo(zpAddresses) {
        if (!zpAddresses || zpAddresses.length === 0) {
            this.elements.zpUsage.textContent = 'None';
            return;
        }

        // Sort addresses
        const sorted = [...zpAddresses].sort((a, b) => a - b);

        // Group into ranges
        const ranges = [];
        let currentRange = { start: sorted[0], end: sorted[0] };

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === currentRange.end + 1) {
                currentRange.end = sorted[i];
            } else {
                ranges.push(currentRange);
                currentRange = { start: sorted[i], end: sorted[i] };
            }
        }
        ranges.push(currentRange);

        // Format ranges
        const formatted = ranges.map(r => {
            if (r.start === r.end) {
                return this.formatHex(r.start, 2);
            } else {
                return `${this.formatHex(r.start, 2)}-${this.formatHex(r.end, 2)}`;
            }
        });

        this.elements.zpUsage.textContent = formatted.join(', ');
    }

    updateNumCallsPerFrame(numCalls) {
        const element = document.getElementById('numCallsPerFrame');
        if (element) {
            element.textContent = numCalls || '1';
        }
    }

    updateMaxCycles(maxCycles) {
        const element = document.getElementById('maxCycles');
        if (element) {
            element.textContent = maxCycles || '-';
        }
    }

    updateSidChipCount(sidChipCount, sidChipAddresses) {
        if (this.elements.sidChipCount) {
            const count = sidChipCount || 1;

            if (count <= 1 || !sidChipAddresses || sidChipAddresses.length <= 1) {
                // Single SID - just show "1"
                this.elements.sidChipCount.textContent = '1';
            } else {
                // Multiple SIDs - show count and list extra SID addresses
                const extraAddresses = sidChipAddresses.slice(1); // Skip the first ($D400)
                const extraLines = extraAddresses.map((addr, idx) =>
                    `<div style="font-size: 0.85em; text-align: right;">Extra SID ${idx + 1}: ${this.formatHex(addr, 4)}</div>`
                ).join('');

                this.elements.sidChipCount.innerHTML = `<div style="text-align: right;">${count}</div>${extraLines}`;
            }
        }
    }

    // Export functions
    exportModifiedSID() {
        const modifiedData = this.analyzer.createModifiedSID();

        if (!modifiedData) {
            this.showExportStatus('Failed to create modified SID', 'error');
            return;
        }

        const baseName = this.currentFileName ?
            this.currentFileName.replace('.sid', '') : 'modified';

        this.downloadFile(modifiedData, `${baseName}_edited.sid`);
        this.showExportStatus('SID file exported successfully!', 'success');

        // Update the original metadata to reflect the saved state
        this.originalMetadata = {
            title: this.elements.sidTitle.value.trim(),
            author: this.elements.sidAuthor.value.trim(),
            copyright: this.elements.sidCopyright.value.trim()
        };

        // Reset modification state
        this.hasModifications = false;
        this.elements.exportModifiedSIDButton.disabled = true;
        if (this.elements.exportHint) {
            this.elements.exportHint.style.display = 'block';
        }
    }

    async exportPRGWithVisualizer() {
        // The queue needs to know how each build went; this method reports
        // everything through the UI and returns nothing.
        this._lastExportOk = false;
        if (!this.selectedVisualizer) {
            this.showExportStatus('Choose what people will see first — pick one on the Visualizer tab.', 'error');
            return;
        }

        // Refuse to build when the selection can't actually work for this tune
        // (too many calls/frame, too many SID chips, or no memory layout fits). The
        // alternative is emitting a PRG whose save/restore or player overruns memory
        // and crashes on the C64 - better to stop with a clear reason.
        const exportable = this.visualizerExportable(this.selectedVisualizer);
        if (!exportable.ok) {
            this.showExportStatus(`Can't build this visualizer for this tune: ${exportable.reason}. Pick one that isn't greyed out (e.g. Simple Raster).`, 'error');
            return;
        }

        // Multi-song + Spectrometer needs explicit consent: the FFT stream is baked for
        // the default song only, so the export can't honour the song selector. Block
        // until the user ticks the acknowledgement in the multi-song note.
        const multiSong = !!(this.sidHeader && this.sidHeader.songs > 1);
        const isFFT = this.selectedVisualizer.dataSource === 'fft';
        if (multiSong && isFFT) {
            const consent = document.getElementById('fftMultiSongConsent');
            if (!consent || !consent.checked) {
                this.showExportStatus('This file holds several tunes. Confirm on the Visualizer tab '
                    + 'that only one of them should be used, or pick a live method on the Method tab.', 'error');
                const note = document.getElementById('fftMultiSongNote');
                if (note) note.style.outline = '2px solid #ffb74d';
                // Take the user to the thing they have to answer, and put focus
                // on it - a highlight on a tab they cannot see says nothing, and
                // an outline alone is colour-only.
                if (window.studioModal) window.studioModal.activate('visualizer');
                if (consent) {
                    consent.setAttribute('aria-invalid', 'true');
                    consent.focus();
                } else if (note) {
                    note.scrollIntoView({ block: 'nearest' });
                }
                return;
            }
        }

        // The slow tune render is only run when a feature needs it; its settings
        // come from Advanced settings:
        //  - Spectrometer: analyse with a progress overlay and use the Advanced
        //    frame rate, resolving 'Best'/fallback to what fits.
        //  - All other players: scan for the loop / end point (cancellable), which
        //    feeds the shown song length AND the Song Looping (forced loop) option.
        // bakeParams carries the resolved frame-rate / search-window to the bake.
        const adv = this.getAdvancedSettings();
        let bakeParams = null;
        if (isFFT) {
            // Silent analyse under the busy overlay - no export modal. Cancellable:
            // the spectrometer needs the bake, so cancelling aborts the whole export
            // (the user can then change the logo/settings and try again).
            if (!this.tuneAnalysis) {
                // Usually already done or well under way - the scan started when the
                // SID loaded. Adopt that job rather than starting a second render:
                // the bake core keeps one shared cache, so two would fight.
                this._hideAnalysisChip();
                this.showBusy('Analysing SID Music', 'Preparing…', () => this.cancelAnalysis());
                try {
                    await this._ensureAnalysis({
                        holdOnLoopFound: true,
                        onProgress: this._analysisProgressCallback(
                            'Analysing SID Music',
                            'Deep-analysing the SID tune for a better visualisation. This finishes early ' +
                            'as soon as the tune\'s loop is found, but can take several minutes on long ' +
                            'tunes — or cancel to change settings first.'),
                    });
                } finally { this.hideBusy(); }
                // User cancelled: bail out of the export silently (no error, nothing built).
                if (this._analysisCancelled) return;
            }
            const a = this.tuneAnalysis;
            if (!a) {
                this.showModal('Could not analyse this tune for the spectrometer. Try a different visualizer.', false);
                return;
            }
            const { rates, budget } = await this.computeBakeRates(a);
            const resolved = this.resolveAdvancedRate(rates, adv.framesPerKeyframe);
            if (!resolved) {
                // Nothing fits even at the lowest rate - a genuinely too-long tune.
                const kb = b => `${(b / 1024).toFixed(1)} KB`;
                this.showModal(`This tune is too long for the spectrometer: even 16.66 fps needs ` +
                    `${kb(rates[2].est.bytes)}, over the ${kb(budget)} budget. Try a shorter ` +
                    `tune or a non-spectrometer visualizer.`, false);
                return;
            }
            bakeParams = {
                framesPerKeyframe: resolved.rate.fpk,
                // The window the measurement used, widening included: a different
                // one here re-renders the tune and can resolve a different loop.
                maxLoopSeconds: this.scanWindowSeconds(),
                minLoopSeconds: adv.minLoopSeconds,
                outputMaxSeconds: adv.storedSeconds,
                // Must match the engine the analysis above rendered with, or the
                // export would re-render (and could resolve a different loop).
                bakeEngine: adv.bakeEngine,
            };
        } else if (!multiSong && !this.tuneAnalysis && !this._analysisCancelled
            && this.showSongLength() && !this.manualSongLengthSeconds()) {
            // Every visualizer benefits from knowing how the song ends: players with
            // a timer show the length, and a detected FADE-OUT is what unlocks the
            // Song Looping option (restart the tune when it ends) - which works on
            // all players. The scan normally started when the SID loaded, so by now
            // it has usually finished; this only blocks when it hasn't.
            //
            // If the user already stopped it from the corner chip, that answer
            // stands: export with no length rather than asking again here.
            this._hideAnalysisChip();
            this.showBusy('Finding song length', 'Preparing…', () => this.cancelAnalysis());
            try {
                await this._ensureAnalysis({
                    holdOnLoopFound: true,
                    onProgress: this._analysisProgressCallback(
                        'Finding song length',
                        'Analysing the SID to find its loop or end point. This finishes early as ' +
                        'soon as the loop is found, but can take several minutes on long tunes ' +
                        '— or cancel to export without length/loop info.'),
                });
            }
            finally { this.hideBusy(); }
        }

        // Song Looping: if the analysis just revealed that this song fades out and
        // ends (no natural repeat), report it once and let the user choose whether
        // to add a forced loop. The decision lives in the Song tab's toggle, so it
        // stays visible and editable for every further export of this SID - e.g.
        // if the restart turns out not to reset the tune cleanly, untick and
        // re-export without re-answering prompts.
        const forceSongLoop = await this._resolveForceLoopChoice();

        // Re-entry guard. A second trigger while an export is already running (a
        // double-click, or the button pressed again mid-bake) would start a second
        // concurrent export. The spectrometer bake drives a single shared WASM audio
        // instance, so two runs corrupt each other's render - and their progress
        // callbacks interleave into the "Rendering… %" that jumps backwards. Ignore it.
        if (this._exporting) return;
        this._exporting = true;
        if (this.elements.exportPRGButton) this.elements.exportPRGButton.disabled = true;

        // The memory layout (bank) is chosen automatically: passing no layoutKey
        // makes the builder pick the first bank that doesn't overlap the SID.
        const selectedLayoutKey = null;

        // Get the selected compression type from radio buttons
        const compressionRadio = document.querySelector('input[name="compression-type"]:checked');
        const compressionType = compressionRadio ? compressionRadio.value : 'exomizer';

        // Show busy overlay
        this.showBusy('Creating PRG File', 'Preparing components...');

        // Get the selected song (default to startSong if selector doesn't exist)
        const songSelector = document.getElementById('songSelector');
        const selectedSong = songSelector ? parseInt(songSelector.value) : this.sidHeader.startSong;

        try {
            const baseName = this.exportBaseName();

            // Update progress
            this.updateBusy('Loading Visualizer', 'Reading configuration...');

            // Load the visualizer config to get the SYS address
            const vizConfig = await this.visualizerConfig.loadConfig(this.selectedVisualizer.id);
            let visualizerSysAddress = 0x4100; // default fallback

            if (selectedLayoutKey && vizConfig && vizConfig.layouts[selectedLayoutKey]) {
                const layout = vizConfig.layouts[selectedLayoutKey];
                // Use sysAddress if available, otherwise fall back to baseAddress + 0x100
                if (layout.sysAddress) {
                    visualizerSysAddress = parseInt(layout.sysAddress);
                } else if (layout.baseAddress) {
                    visualizerSysAddress = parseInt(layout.baseAddress) + 0x100;
                }
            }

            const options = {
                sidLoadAddress: this.sidHeader.loadAddress,
                sidInitAddress: this.sidHeader.initAddress,
                sidPlayAddress: this.sidHeader.playAddress,
                visualizerFile: this.selectedVisualizer.binary,
                visualizerLoadAddress: visualizerSysAddress,  // Use the actual address
                compressionType: compressionType,
                visualizerId: this.selectedVisualizer.id,
                selectedSong: selectedSong - 1,
                layoutKey: selectedLayoutKey,
                // Loop/length of the default song (from the on-load analysis) so any
                // player with length fields can show the song length - reusing that
                // result, never a fresh render. The exporter only applies it to
                // single-song tunes and skips it for spectrometer players (which derive
                // the length from their own bake instead).
                tuneAnalysis: this.tuneAnalysis || null,
                // Forced song loop (Song tab toggle): restart fade-out tunes when
                // they end. The exporter applies it to single-song tunes only.
                forceSongLoop: forceSongLoop,
                // Every option's value as it stands now. The builder used to read
                // the DOM as each option came up, so anything that changed
                // mid-build would land half-applied - and it is what a caller
                // without a page would have to supply.
                optionValues: this._captureOptionValues(),
                // Soft VIC-bank preference (Advanced settings). Ignored when the
                // tune leaves no room for it.
                preferredGfxBank: this.getAdvancedSettings().preferredGfxBank || null,
                reservedRanges: this.getAdvancedSettings().reservedRanges,
                // Song length on the C64 (Song tab): whether to show one at all, and
                // a length the user typed rather than one the scan measured.
                showSongLength: this.showSongLength(),
                manualLengthSeconds: this.manualSongLengthSeconds(),
                // Frame rate + loop-search window chosen in the spectrometer export modal.
                bakeParams: bakeParams,
                // Progress for the visualisation build (the slow analysis is already
                // done and cached by this point, so this stage is quick - keep it simple).
                onProgress: () => {
                    this.updateBusy('Building PRG', 'Adding the visualisation…');
                }
            };

            // Ensure PRG exporter is loaded
            this.updateBusy('Building PRG', 'Loading export components...');
            await this.ensurePRGExporter();

            // Update progress
            this.updateBusy('Building PRG', 'Assembling components...');

            const exportResult = await this.prgExporter.createPRG(options);
            const prgData = exportResult.data;
            // The ACTUAL compression state - compression can silently fall back to
            // uncompressed if the compressor is unavailable or errors, so never
            // trust the requested `compressionType` for naming/labeling.
            const isCompressed = exportResult.compressed;
            const compressionFailed = compressionType !== 'none' && !isCompressed;

            // Snapshot the final (uncompressed) runtime layout now, before the next
            // export clears the builder, so we can draw the memory map below.
            const memInfo = this.prgExporter.builder.getInfo();
            // Loop/timing info from the baked FFT stream (null for non-FFT exports).
            const bakeInfo = this.prgExporter.lastBakeInfo;

            // Update progress for compression if needed
            if (compressionType !== 'none') {
                this.updateBusy('Compressing', `Applying ${compressionType.toUpperCase()} compression...`);
                // Small delay to show the message
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // The builder auto-picks the bank, so use the SYS address it actually
            // chose (not the 0x4100 UI fallback) for the filename and memory map.
            const realSysAddress = this.prgExporter.lastSysAddress || visualizerSysAddress;

            // Generate filename based on the ACTUAL compression state: a crunched
            // file self-executes (songname.prg), but an uncompressed image needs
            // its SYS address in the name so the user can run it. If compression
            // was requested but fell back, this correctly produces the -sys name.
            let filename;

            if (isCompressed) {
                // Compressed: just songname.prg
                filename = `${baseName}.prg`;
            } else {
                // Uncompressed: songname-sys{decimal_address}.prg
                filename = `${baseName}-sys${realSysAddress}.prg`;
            }

            // Saved PRG filenames are always fully lowercase.
            filename = filename.toLowerCase();

            this.downloadFile(prgData, filename);

            // Hide busy overlay
            this.hideBusy();

            const sizeKB = (prgData.length / 1024).toFixed(2);
            let statusMsg = `PRG exported successfully! Size: ${sizeKB}KB`;

            if (isCompressed) {
                statusMsg += ` (${compressionType.toUpperCase()} compressed)`;
            } else if (compressionFailed) {
                statusMsg += ` (uncompressed - ${compressionType.toUpperCase()} compression unavailable)`;
            }

            // A failed-compression export still produced a working uncompressed
            // file, but the user asked for compression - warn rather than claim
            // plain success so it's clear why the file is larger and -sys named.
            this.showExportStatus(statusMsg, compressionFailed ? 'warning' : 'success');

            // The file is the result, so say what it is and what to do with it on
            // the page rather than in a dialog that dismisses itself after two
            // seconds. (It used to do both, for one event.)
            this._lastExportOk = true;
            const wanted = this.getAdvancedSettings().preferredGfxBank;
            if (wanted && this.prgExporter.lastGfxBankPreferenceHonoured === false) {
                this.showExportStatus('The graphics could not go in the bank you asked for — '
                    + 'this tune leaves no room there, so a bank that works was used instead.', 'warning');
            }
            this.renderExportDone({
                filename,
                sizeKB,
                isCompressed,
                compressionFailed,
                compressionType,
                sysAddress: realSysAddress,
                bytes: prgData.length,
                // The runtime span the PRG covers. build() allocates
                // highest-lowest+1 and zero-fills, so a tune low in memory with
                // graphics high leaves a large hole that is still written out.
                span: memInfo ? { lo: memInfo.lowestAddress, hi: memInfo.highestAddress } : null,
                spanBytes: memInfo ? memInfo.totalSize : null,
                usedBytes: memInfo
                    ? memInfo.components.reduce((n, c) => n + c.size, 0) : null,
            });

            // Record what this build actually produced, so a recipe kept next to
            // the PRG says which bytes it made as well as which settings.
            const built = {
                filename,
                bytes: prgData.length,
                blocks: Math.ceil(prgData.length / 254),
                loadAddress: prgData.length >= 2 ? prgData[0] | (prgData[1] << 8) : null,
                sysAddress: realSysAddress,
                compression: isCompressed ? compressionType : 'none',
                span: memInfo ? { lo: memInfo.lowestAddress, hi: memInfo.highestAddress } : null,
                spanBytes: memInfo ? memInfo.totalSize : null,
                loopFrames: this.tuneAnalysis ? (this.tuneAnalysis.loopFrames ?? null) : null,
                prgHash: UIController.prgHash(prgData),
            };
            // Remember the settings that produced it too: a later "Save these
            // settings" must not attach this build to a changed recipe.
            this._lastBuilt = built;
            this._lastBuiltFrom = JSON.stringify(this.buildRecipe());
            if (this.recipeAlways()) this.saveRecipe(built, baseName);

            this.renderBakeTimeline(bakeInfo);
            this.renderLoopInfo();
            this.renderMemoryMap(memInfo, {
                compressed: isCompressed,
                fileSize: prgData.length,
                sysAddress: realSysAddress,
            });

            // The timeline + memory map render on the Export tab - show them.
            if (window.studioModal) window.studioModal.activate('export');

        } catch (error) {
            this.hideBusy();
            console.error('Export error:', error);
            this.showExportStatus(`Export failed: ${error.message}`, 'error');
            // Also show error modal for better visibility on serious errors
            if (window.showError) {
                window.showError('Export failed', {
                    details: error.message,
                    duration: 0
                });
            }
        } finally {
            this._exporting = false;
            if (this.elements.exportPRGButton) this.elements.exportPRGButton.disabled = false;
        }
    }

    // -------------------------------------------------------------------------
    // Memory map: draw the runtime C64 layout of the PRG we just built, so it's
    // easy to see where the SID, player code+graphics, spectrometer data and free
    // RAM all ended up. Reads the (uncompressed) component list the builder placed.
    // -------------------------------------------------------------------------
    /**
     * Option ids that describe the tune currently open, not the session. They
     * come out of _captureOptionValues because it sweeps the whole panel, but
     * they must never be carried into a new session.
     */
    /**
     * Parse "keep this memory free" as the user types it: a comma or
     * space-separated list of `$C000-$CFFF` style ranges. Hex with or without
     * the `$`, and a bare address means that single page.
     * @returns {{ranges: Array<{start:number,end:number}>, bad: string[]}}
     *   ranges are [start, end) so they drop straight into the placement code.
     */
    static parseReservedRanges(text) {
        const ranges = [];
        const bad = [];
        for (const piece of String(text || '').split(/[,\s]+/).filter(Boolean)) {
            const m = /^\$?([0-9a-f]{1,4})(?:\s*-\s*\$?([0-9a-f]{1,4}))?$/i.exec(piece);
            if (!m) { bad.push(piece); continue; }
            const start = parseInt(m[1], 16);
            // A bare address reserves its page: "$C000" plainly means the page,
            // not the single byte, and a one-byte reservation is never useful.
            const end = m[2] !== undefined ? parseInt(m[2], 16) + 1 : (start & 0xff00) + 0x100;
            if (!(end > start) || end > 0x10000) { bad.push(piece); continue; }
            ranges.push({ start, end });
        }
        return { ranges, bad };
    }

    /**
     * How much of a tune must have been scanned before "use what it has found"
     * is worth offering. Below this the answer would be a fade-out at a few
     * seconds, which is worse than no answer.
     */
    static get STOP_OFFER_SECONDS() { return 45; }

    /**
     * Seconds of music the scan assumes a tune runs to, before anyone asks for
     * more. The render goes to twice this, so the default listens to 20 minutes.
     */
    static get DEFAULT_SCAN_WINDOW() { return 600; }

    /**
     * Where "keep looking" stops doubling. At this window the render listens to
     * two hours of one tune; past that the answer is a typed-in length, not more
     * waiting.
     */
    static get MAX_SCAN_WINDOW() { return 3600; }

    static get PER_TUNE_OPTION_IDS() {
        return new Set(['sidTitle', 'sidAuthor', 'sidCopyright', 'songSelector', 'songLengthManual']);
    }

    static get MEMMAP_CATEGORIES() {
        return {
            sid:         { label: 'SID music',            color: '#4fc3f7' },
            code:        { label: 'Visualizer code',       color: '#7e6bf5' },
            gfx:         { label: 'Graphics (logo)',      color: '#c77dff' },
            // The baked spectrometer stream is two adjacent arrays - the codebook
            // (bar-shape dictionary) and the per-keyframe indices into it. Two
            // related warm hues so they read as a pair yet stay tellable apart.
            spectrometer:     { label: 'Spectrometer codebook', color: '#ffb74d' },
            spectrometerIndex:{ label: 'Spectrometer index',    color: '#ff8a65' },
            saverestore: { label: 'Save / restore',       color: '#90a4ae' },
            data:        { label: 'Player data',          color: '#66bb6a' },
        };
    }

    memMapCategory(name) {
        const n = (name || '').toLowerCase();
        if (n.includes('sid music')) return 'sid';
        if (n.includes('spectrometer')) return n.includes('index') ? 'spectrometerIndex' : 'spectrometer';
        if (n.includes('graphics') || n.includes('bitmap') || n.includes('screen') ||
            n.includes('charset') || n.includes('color') || n.includes('colour') ||
            n.includes('logo') || n.includes('sprite') || n.includes('font')) return 'gfx';
        if (n.includes('save') || n.includes('restore')) return 'saverestore';
        if (n.includes('visualizer')) return 'code';
        return 'data'; // data block, shadow order, small patches, etc.
    }

    // ---------------------------------------------------------------------
    // Forced song loop (Song tab): status line + one-time fade-out prompt.
    // ---------------------------------------------------------------------

    _mmss(s) { const t = Math.round(s || 0), m = Math.floor(t / 60), sec = t % 60; return `${m}:${String(sec).padStart(2, '0')}`; }

    // Keep the Song tab's "Song Looping" panel truthful for the current tune:
    // what we know about how the song ends, and whether the toggle can apply.
    /** The typed song length in whole seconds, or 0 when the field is empty/invalid. */
    manualSongLengthSeconds() {
        const el = document.getElementById('songLengthManual');
        const secs = this._parseMMSS(el && el.value);
        return Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
    }

    /** Is the song length wanted on the C64 screen at all? */
    showSongLength() {
        const el = document.getElementById('showSongLengthToggle');
        return !el || el.checked;
    }

    // One-time wiring for the Song tab's length controls. The panel is static
    // markup, so this runs once and the handlers survive every reload.
    _wireSongLengthControls() {
        if (this._songLengthWired) return;
        this._songLengthWired = true;
        const on = (id, evt, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(evt, fn);
        };
        on('songLengthMeasure', 'click', () => {
            // An explicit "measure" overrides an earlier decision to stop.
            this._analysisCancelled = false;
            this.startBackgroundAnalysis();
            this.updateSongLoopStatus();
        });
        on('songLengthStop', 'click', () => {
            this.cancelAnalysis();
            this._hideAnalysisChip();
            this.updateSongLoopStatus();
        });
        on('songLengthKeepLooking', 'click', () => this.keepLooking());
        on('songLengthManual', 'input', () => {
            this.updateSongLoopStatus();
            if (window.studioModal) window.studioModal.queueRefresh();
        });
        on('showSongLengthToggle', 'change', () => {
            this.updateSongLoopStatus();
            if (window.studioModal) window.studioModal.queueRefresh();
        });
    }

    /**
     * Why a scan came back with no loop. Running out of window and being stopped
     * on purpose are different answers, and the first one used to read as "this
     * tune has no loop" when it only meant "we did not look far enough".
     */
    _scanEndedBecause(a) {
        const scanned = this._mmss(a.analyzedSeconds);
        if (a.stoppedEarly) return `You stopped the search after ${scanned}, and nothing repeated in it`;
        if (a.cappedAtMaxSeconds) return `Nothing repeated in ${scanned}, which is as far as the scan looks`;
        if (a.truncated) return `Nothing repeated in ${scanned}, and the tune was still playing at `
            + `${this._mmss(a.loopStartSeconds)} where the analysis stops`;
        return `No repeat or fade-out found in ${scanned} of scanning`;
    }

    updateSongLoopStatus() {
        const status = document.getElementById('songLoopStatus');
        const toggle = document.getElementById('forceLoopToggle');
        if (!status || !toggle) return;
        this._wireSongLengthControls();
        const a = this.tuneAnalysis;
        const multiSong = !!(this.sidHeader && this.sidHeader.songs > 1);
        const manual = this.manualSongLengthSeconds();
        const scanning = this.analysisRunning;

        // Length controls: measuring and typing are alternatives, and neither is
        // offered when a multi-song SID rules a length out entirely.
        const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
        const canMeasure = !!this.sidHeader && !multiSong && !a;
        show('songLengthMeasure', canMeasure && !scanning);
        show('songLengthStop', scanning);
        // A scan that resolved nothing is the one case where searching further
        // can still produce an answer, so the offer only appears there.
        const unresolved = !!a && !a.looped && !a.fadedOut && !multiSong;
        const further = unresolved && !scanning ? this.nextScanWindowSeconds() : null;
        show('songLengthKeepLooking', !!further);
        const keep = document.getElementById('songLengthKeepLooking');
        if (keep && further) keep.textContent = `Keep looking (up to ${this._mmss(further * 2)})`;
        const manualWrap = document.querySelector('.song-length-manual');
        if (manualWrap) manualWrap.hidden = !this.sidHeader || multiSong || !!(a && a.looped);
        const showToggleRow = document.getElementById('showSongLengthToggle')?.closest('.info-row');
        if (showToggleRow) showToggleRow.hidden = !this.sidHeader || multiSong;

        let text;
        let enabled = true;
        if (!this.sidHeader) {
            text = 'Load a SID first.';
            enabled = false;
        } else if (multiSong) {
            text = 'Multi-song SID — the C64 shows a running clock, with no total length, ' +
                'and forced looping applies to single-song exports only.';
            enabled = false;
        } else if (scanning) {
            text = 'Measuring the song length — playing the tune through to find where it ' +
                'loops or fades out. Carry on choosing a visualizer; this runs in the background.';
        } else if (!a && manual) {
            text = `Song length ${this._mmss(manual)}, as typed. The C64 clock counts up to it ` +
                'and wraps there.';
        } else if (!a && this._analysisCancelled) {
            text = 'Measuring stopped — the export will show a running clock with no total. ' +
                'Measure again, or type the length in.';
        } else if (!a) {
            text = 'Song length not measured yet. It is worked out in the background once the ' +
                'Studio opens, and at the latest when you export.';
        } else if (a.looped) {
            text = `This song loops naturally (repeats at ${this._mmss(a.storedSeconds)}) — no forced loop needed.`;
            enabled = false;
        } else if (a.fadedOut) {
            text = `This song doesn't loop — it fades out and ends at about ${this._mmss(a.loopStartSeconds)}. ` +
                (toggle.checked
                    ? 'A loop will be added: the exported PRG restarts the song there.'
                    : 'No loop will be added: the exported PRG goes silent there.');
        } else if (manual) {
            text = `${this._scanEndedBecause(a)}, so the typed length ${this._mmss(manual)} ` +
                'is used instead. Forced looping is unavailable.';
            enabled = false;
        } else {
            text = `${this._scanEndedBecause(a)} — so the C64 shows a running clock with no total, `
                + 'and forced looping is unavailable. '
                + (further
                    ? `Keep looking listens to up to ${this._mmss(further * 2)} of the tune. It starts `
                      + 'the search over, so allow about as long as this one took. Or type the length '
                      + 'in if you know it.'
                    : 'Type the length in if you know it.');
            enabled = false;
        }
        // The length can be measured or typed and still deliberately left off the
        // screen; say so rather than showing a figure the export will not use.
        if (!multiSong && this.sidHeader && !this.showSongLength()) {
            text += ' The C64 will show a running clock only — "show the song length" is unticked.';
        }
        status.textContent = text;
        toggle.disabled = !enabled;
    }

    // One-time offer when an export's analysis first shows a fade-out. Returns
    // the effective forced-loop choice for this export. Never prompts twice for
    // the same SID, and never overrides a choice the user made on the Song tab.
    async _resolveForceLoopChoice() {
        this.updateSongLoopStatus();
        const toggle = document.getElementById('forceLoopToggle');
        const a = this.tuneAnalysis;
        const multiSong = !!(this.sidHeader && this.sidHeader.songs > 1);
        const eligible = !!(a && !a.looped && a.fadedOut && !multiSong);
        if (!eligible) return false;
        // During a queue run there is nobody watching each tune go by, and a
        // modal per file would stall the batch. Use the toggle as it stands.
        if (this._queueRunning) return !!(toggle && toggle.checked && !toggle.disabled);
        if (!this._loopChoiceAsked && !this._loopChoiceTouched && window.errorModal) {
            this._loopChoiceAsked = true;
            const at = this._mmss(a.loopStartSeconds);
            // confirm() with custom actions: our callbacks resolve our own promise
            // (Escape routes to the secondary action, so it resolves false).
            const add = await new Promise((resolve) => {
                window.errorModal.confirm(
                    `This song doesn't loop — it fades out and ends at about ${at}. ` +
                    `Add a loop so the exported PRG restarts the song from the beginning? ` +
                    `You can change this any time on the Song tab (Song Looping) — for example ` +
                    `if the restart doesn't reset this tune cleanly.`,
                    {
                        title: 'Song fades out',
                        actions: [
                            { label: 'No loop — let it end', callback: () => resolve(false), secondary: true },
                            { label: 'Add loop', callback: () => resolve(true) },
                        ],
                    });
            });
            if (toggle) toggle.checked = add;
            this.updateSongLoopStatus();
            if (window.studioModal) window.studioModal.queueRefresh();
        }
        return !!(toggle && toggle.checked && !toggle.disabled);
    }

    // Song timeline panel, shared by every export path. The baked-FFT players
    // describe the exact stored stream; everyone else describes the analysed tune.
    // Both render the SAME graphic, so "how does this tune end?" is always shown
    // and always looks the same - it used to appear only for the spectrometer.
    //
    // d = { mode, storedSeconds, introSeconds, title, subtitle, bars,
    //       analyzedSeconds, cappedAtMaxSeconds }
    //   mode 'loop'   - the tune repeats on its own
    //        'forced' - no natural repeat; we ADDED one (Song tab). Drawn in amber
    //                   with a dashed arc so an added loop never reads as the
    //                   tune's own.
    //        'fade'   - no natural repeat; the tune fades out and holds silent
    //        'cut'    - no natural repeat and the tune was STILL PLAYING where the
    //                   analysis had to stop. Not an ending, so nothing here is
    //                   presented as the song's length.
    //        'none'   - nothing conclusive; the whole stored span replays
    //   bars - true when the stream also drives baked FFT bars (wording differs).
    _timelineHTML(d) {
        const mmss = s => { const t = Math.round(s || 0), m = Math.floor(t / 60), sec = t % 60; return `${m}:${String(sec).padStart(2, '0')}`; };
        const storedSec = Math.max(0, d.storedSeconds || 0);
        const introSec = Math.max(0, Math.min(storedSec, d.introSeconds || 0));
        const loopSec = storedSec - introSec;
        const introPct = storedSec > 0 ? (introSec / storedSec * 100) : 0;
        const x2 = Math.round(introPct * 10);   // per-mille x for the loop-back arc target
        const forced = d.mode === 'forced';
        const faded = d.mode === 'fade';
        const cut = d.mode === 'cut';
        const bars = !!d.bars;
        // Nothing wraps back on a fade or a cut, so no arc is drawn for those.
        const arc = !faded && !cut;
        const accent = forced ? '#ffb74d' : '#66bb6a';        // amber = we added it
        const bodyBg = forced
            ? 'linear-gradient(rgba(255,183,77,.30),rgba(255,183,77,.18));box-shadow:inset 0 0 0 1px rgba(255,183,77,.55);color:#ffe0b2'
            : 'linear-gradient(rgba(102,187,106,.32),rgba(102,187,106,.2));box-shadow:inset 0 0 0 1px rgba(102,187,106,.5);color:#c8f0cc';
        // The mid tick collides with the 0:00 / end labels when it lands near either
        // edge - e.g. a fade-at-cap puts it within a few % of the end. Skip it there;
        // the note below states the exact time anyway.
        const showMidTick = introSec > 0 && introPct >= 12 && introPct <= 86;

        let note;
        if (d.mode === 'loop') {
            note = introSec === 0
                ? `The whole <b>${mmss(loopSec)}</b> loops seamlessly (no intro).`
                : `Plays the <b>${mmss(introSec)}</b> intro once, then loops the <b>${mmss(loopSec)}</b> body — wrapping back at <b>${mmss(storedSec)}</b>.`;
        } else if (forced) {
            note = `No natural repeat — the tune fades to silence, so SIDquake added a loop (Song tab): it restarts from the top at <b>${mmss(storedSec)}</b>.`;
        } else if (faded) {
            const tail = bars ? 'the bars fade with it and hold empty' : 'the exported PRG goes silent there';
            note = d.cappedAtMaxSeconds
                ? `No repeat found within the <b>${mmss(d.analyzedSeconds)}</b> analysed (our cap) — rather than restart out of sync, it stops at <b>${mmss(introSec)}</b> and holds.`
                : `The tune fades to silence around <b>${mmss(introSec)}</b> — ${tail} (no restart).`;
        } else if (cut) {
            const tail = bars
                ? 'the bars stop there and hold'
                : 'the C64 shows a running clock with no total length';
            note = `No repeat found, and the tune was still playing at <b>${mmss(introSec)}</b> — `
                + `as far as the analysis goes. That is not the song's end, so ${tail}.`;
        } else {
            note = `No repeat detected — the full <b>${mmss(storedSec)}</b> replays from the start.`;
        }

        const bodyLabel = faded ? 'fade' : (cut ? 'cut here' : (forced ? 'plays, then restarts' : 'loop body'));
        const legendBody = faded ? 'Fade to silence (held)'
            : cut ? 'Still playing where the analysis stops'
            : (forced ? 'Whole tune — loop added by SIDquake' : 'Loop body (repeats)');

        // Raster-frame counts. Tools and tune databases work in frames, not mm:ss,
        // and the frame count is the exact figure - mm:ss is the rounded one - so
        // these are shown verbatim with a one-click copy rather than left to be
        // re-derived from the displayed times.
        const totalF = Math.max(0, Math.round(d.totalFrames || 0));
        const introF = Math.max(0, Math.min(totalF, Math.round(d.introFrames || 0)));
        let pairs = [];
        if (totalF > 0) {
            if (d.mode === 'loop') {
                if (introF > 0) pairs.push(['intro', introF]);
                pairs.push(['loop', totalF - introF], ['total', totalF]);
            } else if (forced) {
                pairs.push(['loop', totalF]);
            } else if (faded) {
                pairs.push(['music ends', introF], ['stored', totalF]);
            } else {
                pairs.push(['total', totalF]);
            }
        }
        const clock = d.frameHz ? `${d.frameHz.toFixed(4)} Hz` : '';
        const copyText = pairs.map(([k, v]) => `${k.replace(/ /g, '-')}=${v}`).join(' ')
            + (clock ? ` @${clock}` : '');
        const framesRow = pairs.length ? `
        <div class="bt-frames">
            <span class="bt-fr-label">Frames${clock ? ` <span class="bt-fr-hz">${clock}</span>` : ''}</span>
            ${pairs.map(([k, v]) => `<span class="bt-fr-val">${k} <code>${v}</code></span>`).join('')}
            <button type="button" class="bt-copy" data-copy="${copyText.replace(/"/g, '&quot;')}"
                    title="Copy frame counts">Copy</button>
        </div>` : '';

        return `
        <style>
        .bt-panel{margin-top:16px;padding:14px 16px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.03);font-size:13px}
        .bt-panel h4{margin:0 0 4px;font-size:14px;display:flex;align-items:center;gap:8px}
        .bt-panel .bt-badge{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:99px;background:rgba(255,183,77,.18);color:#ffb74d;border:1px solid rgba(255,183,77,.45)}
        .bt-panel .bt-sub{opacity:.7;font-size:12px;margin-bottom:12px}
        .bt-panel .bt-arc{width:100%;height:20px;display:block;overflow:visible}
        .bt-panel .bt-track{position:relative;height:26px;border-radius:4px;overflow:hidden;background:rgba(0,0,0,.35)}
        .bt-panel .bt-seg{position:absolute;top:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:11px;white-space:nowrap;overflow:hidden}
        .bt-panel .bt-intro{background:repeating-linear-gradient(45deg,rgba(144,164,174,.25),rgba(144,164,174,.25) 6px,rgba(144,164,174,.4) 6px,rgba(144,164,174,.4) 12px);color:#cfd8dc}
        .bt-panel .bt-ticks{position:relative;height:16px;margin-top:4px}
        .bt-panel .bt-tick{position:absolute;transform:translateX(-50%);font-size:10px;opacity:.75;font-family:monospace;white-space:nowrap}
        .bt-panel .bt-tick.bt-start{transform:none}
        .bt-panel .bt-tick.bt-end{transform:translateX(-100%)}
        .bt-panel .bt-note{margin-top:12px;font-size:12px;opacity:.9}
        .bt-panel .bt-note b{color:#8ddf91;font-weight:600}
        .bt-panel .bt-legend{margin-top:10px;display:flex;gap:14px;font-size:11px;opacity:.85}
        .bt-panel .bt-legend span{display:inline-flex;align-items:center;gap:6px}
        .bt-panel .bt-sw{width:12px;height:12px;border-radius:2px;display:inline-block}
        .bt-panel .bt-frames{margin-top:10px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:11px}
        .bt-panel .bt-fr-label{opacity:.6;text-transform:uppercase;letter-spacing:.05em;font-size:10px}
        .bt-panel .bt-fr-hz{opacity:.8;text-transform:none;letter-spacing:0;font-family:monospace}
        .bt-panel .bt-fr-val{opacity:.85}
        .bt-panel .bt-fr-val code{font-family:monospace;font-size:12px;color:#e0e0e0;background:rgba(255,255,255,.07);padding:1px 6px;border-radius:3px;margin-left:3px;user-select:all}
        .bt-panel .bt-copy{margin-left:auto;font:inherit;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:3px 9px;border-radius:4px;cursor:pointer;color:inherit;opacity:.75;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18)}
        .bt-panel .bt-copy:hover{opacity:1;background:rgba(255,255,255,.13)}
        </style>
        <h4>🔁 ${d.title}${forced ? '<span class="bt-badge">loop added</span>' : ''}</h4>
        ${d.subtitle ? `<div class="bt-sub">${d.subtitle}</div>` : '<div class="bt-sub"></div>'}
        <svg class="bt-arc" viewBox="0 0 1000 20" preserveAspectRatio="none" aria-hidden="true">
            ${arc ? `<path d="M 1000 18 C ${(1000 + x2) / 2} -2, ${(1000 + x2) / 2} -2, ${x2} 16"
                  fill="none" stroke="${accent}" stroke-width="1.5" vector-effect="non-scaling-stroke"
                  ${forced ? 'stroke-dasharray="5 4"' : ''} opacity="0.85"/>` : ''}
        </svg>
        <div class="bt-track">
            ${introSec > 0 ? `<div class="bt-seg bt-intro" style="left:0;width:${introPct}%">${introPct > 14 ? (faded || cut ? 'plays through' : 'intro') : ''}</div>` : ''}
            <div class="bt-seg" style="left:${introPct}%;width:${100 - introPct}%;background:${bodyBg}">${(100 - introPct) > 14 ? bodyLabel : ''}</div>
        </div>
        <div class="bt-ticks">
            <span class="bt-tick bt-start" style="left:0%">0:00</span>
            ${showMidTick ? `<span class="bt-tick" style="left:${introPct}%">${faded ? '⤓' : cut ? '⌁' : '⟲'} ${mmss(introSec)}</span>` : ''}
            <span class="bt-tick bt-end" style="left:100%">${mmss(storedSec)}</span>
        </div>
        <div class="bt-legend">
            ${introSec > 0 ? `<span><i class="bt-sw" style="background:rgba(144,164,174,.4)"></i>${faded || cut ? 'Tune (plays once)' : 'Intro (plays once)'}</span>` : ''}
            <span><i class="bt-sw" style="background:${forced ? 'rgba(255,183,77,.45)' : 'rgba(102,187,106,.4)'}"></i>${legendBody}</span>
        </div>
        <div class="bt-note">${note}</div>${framesRow}`;
    }

    // Wire the frames row's Copy button. Done after innerHTML rather than with an
    // inline handler so the panel stays plain markup (and CSP-safe).
    _wireTimelineCopy(el) {
        const btn = el.querySelector('.bt-copy');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const text = btn.getAttribute('data-copy') || '';
            try {
                await navigator.clipboard.writeText(text);
            } catch (e) {
                // Clipboard API needs a secure context - fall back to a selection copy.
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch (e2) { /* best-effort */ }
                document.body.removeChild(ta);
            }
            const was = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = was; }, 1200);
        });
    }

    // Timeline for every non-FFT export: built from the tune analysis rather than a
    // baked stream. FFT players draw the richer bake timeline instead (it knows the
    // exact stored stream and its size), so this stands down when that one is up.
    renderLoopInfo() {
        const el = this.elements.loopInfo;
        if (!el) return;
        const a = this.tuneAnalysis;
        const bt = this.elements.bakeTimeline;
        const timelineShown = bt && bt.style.display !== 'none' && bt.innerHTML.trim();
        if (!a || timelineShown) { el.style.display = 'none'; el.innerHTML = ''; return; }
        // A forced loop is recorded as the frame the export restarts the music on.
        const forcedFrames = (this.prgExporter && this.prgExporter.lastMusicLoopFrames) || 0;
        const fps = a.isNtsc ? 60 : 50;
        // Keyframes are stored at one per `fpk` raster frames, so the exact frame
        // count is keyframes * fpk - derived, never re-timed from the mm:ss figures.
        const frameHz = a.frameHz || (a.isNtsc ? 59.826 : 50.1245);
        const fpk = Math.max(1, Math.round(frameHz / (a.keyframeHz || 25)));
        const nkFrames = (a.numKeyframes || 0) * fpk;
        let mode, storedSeconds, introSeconds, totalFrames, introFrames;
        if (a.looped) {
            mode = 'loop';
            storedSeconds = a.storedSeconds || 0;
            introSeconds = a.loopStartSeconds || 0;
            totalFrames = nkFrames;
            introFrames = (a.loopStart || 0) * fpk;
        } else if (forcedFrames > 0) {
            // The whole tune plays, then restarts from the top - no intro segment.
            // forcedFrames is the frame the PRG actually restarts on, so it is the
            // authority here rather than anything re-derived from seconds.
            mode = 'forced';
            storedSeconds = forcedFrames / fps;
            introSeconds = 0;
            totalFrames = forcedFrames;
            introFrames = 0;
        } else if (a.fadedOut || a.truncated) {
            // 'cut' is the same geometry as a fade - the music runs to loopStart
            // and the stream holds - but it is not an ending, so it is never
            // described as one.
            mode = a.truncated ? 'cut' : 'fade';
            storedSeconds = a.storedSeconds || 0;
            introSeconds = a.loopStartSeconds || 0;
            totalFrames = nkFrames;
            introFrames = (a.loopStart || 0) * fpk;
        } else {
            mode = 'none';
            storedSeconds = a.storedSeconds || 0;
            introSeconds = 0;
            totalFrames = nkFrames;
            introFrames = 0;
        }
        el.classList.add('bt-panel');
        el.style.display = 'block';
        el.innerHTML = this._timelineHTML({
            mode, storedSeconds, introSeconds, totalFrames, introFrames, frameHz, bars: false,
            title: 'Song timeline',
            subtitle: `${a.isNtsc ? 'NTSC' : 'PAL'} · ${this._mmss(a.analyzedSeconds)} analysed`,
            analyzedSeconds: a.analyzedSeconds,
            cappedAtMaxSeconds: a.cappedAtMaxSeconds,
        });
        this._wireTimelineCopy(el);
    }

    // Draw the baked FFT stream's loop/timing timeline from the last export.
    // info is prgExporter.lastBakeInfo (null for non-FFT exports -> hidden).
    renderBakeTimeline(info) {
        const el = this.elements.bakeTimeline;
        if (!el) return;
        if (!info || !info.numKeyframes || !info.keyframeHz) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }

        const hz = info.keyframeHz;
        const nk = info.numKeyframes;
        const loopK = Math.max(0, Math.min(nk, info.loopStart || 0));
        const kb = b => (b / 1024).toFixed(1) + ' KB';

        // forced = no repeat was found but the user chose the Song Looping option:
        // the stream wraps back to 0:00 and the music restarts with it.
        // faded = no repeat was found and the bars fade off and hold empty.
        const forced = !!info.forcedLoop;
        const mode = info.looped ? 'loop'
            : forced ? 'forced'
            : info.fadedOut ? 'fade'
            : info.truncated ? 'cut' : 'none';
        // One keyframe per `fpk` raster frames - the C64 cadence divisor the exporter
        // patches - so the stream's exact frame counts are just keyframes * fpk.
        const fpk = Math.max(1, info.framesPerKeyframe || 2);
        el.classList.add('bt-panel');
        el.innerHTML = this._timelineHTML({
            mode,
            storedSeconds: nk / hz,
            introSeconds: loopK / hz,
            totalFrames: nk * fpk,
            introFrames: loopK * fpk,
            frameHz: hz * fpk,
            bars: true,
            title: 'Spectrometer timeline',
            // Segment count is the spectral detail: 5 slices animate independently,
            // 1 means all 40 bars share an index and move (or freeze) together.
            subtitle: `${hz} fps · ${info.segments || 1}\u00d7${info.segmentWidth || 40} bars · ${kb(info.totalBytes)}`,
            analyzedSeconds: info.analyzedSeconds,
            cappedAtMaxSeconds: info.cappedAtMaxSeconds,
        });
        el.style.display = 'block';
        this._wireTimelineCopy(el);
    }

    /**
     * Say where this tune and player will land, before the user commits to an
     * export. The map that already exists is only drawn on success, so until now
     * the only way to find out which VIC bank a tune forced, or what the SYS
     * address would be, was to export and look.
     *
     * This is deliberately a plan and says so: the data block, the player stub
     * and any bitmaps are placed later, so the span here is a floor, not the
     * final size.
     */
    async renderPlacementPlan() {
        const el = document.getElementById('placementPlan');
        if (!el) return;
        const config = this.currentVisualizerConfig;
        const hide = () => { el.hidden = true; el.innerHTML = ''; };
        if (!config || !config.relocatable || !this.sidHeader || !this.prgExporter) return hide();

        // Only the newest plan is shown: the user can change player faster than
        // the placement runs.
        const token = ++this._planToken;
        let result;
        try {
            const sidInfo = this.prgExporter.extractSIDMusicData();
            const adv = this.getAdvancedSettings();
            result = await this.prgExporter.previewPlacement(
                config, sidInfo.loadAddress, sidInfo.data,
                adv.preferredGfxBank || null, adv.reservedRanges);
        } catch (e) {
            // "It will not fit" is already reported by the card grid; nothing
            // useful to say here, so say nothing.
            if (token === this._planToken) hide();
            return;
        }
        if (token !== this._planToken) return;

        const { plan, info } = result;
        const hex = v => '$' + v.toString(16).toUpperCase().padStart(4, '0');
        const sz = n => (n >= 1024 ? (n / 1024).toFixed(n % 1024 ? 1 : 0) + ' KB' : n + ' B');
        const gfxAt = plan.gfxBankBase + plan.gfxOffset;
        const wanted = this.getAdvancedSettings().preferredGfxBank;
        const missedBank = !!wanted && result.gfxBankHonoured === false;

        el.hidden = false;
        el.innerHTML = `
            <h4>Where it goes</h4>
            <dl>
                <dt>Run it with</dt><dd>SYS ${plan.visualizerLoadAddress}</dd>
                <dt>Music</dt><dd>${hex(info.lowestAddress)} onwards</dd>
                <dt>Player code</dt><dd>${hex(plan.codePage)} (${sz(plan.codeBlob.length)})</dd>
                <dt>Graphics</dt><dd>${hex(gfxAt)}, VIC bank ${plan.gfxBankNum}</dd>
                <dt>Uses so far</dt><dd>${hex(info.lowestAddress)}–${hex(info.highestAddress)}</dd>
            </dl>
            <p class="pp-note">${missedBank
                ? 'This tune leaves no room in the bank you asked for, so a bank that works was chosen. '
                : ''}A plan, not the finished file: the song data and anything you add still have to go in.</p>`;
    }

    /**
     * The three metadata lines as the C64 will show them: the same case
     * conversion, PETSCII substitution, 32-column centring and font the export
     * applies, drawn with the selected charset. Typing a title with a character
     * the machine has no glyph for, or one that will not fit, used to be
     * invisible until the export.
     */
    // DEAD: the "On screen" row it drew into was removed from the File
    // Information panel - three lines of C64 text squeezed into a 256x24 canvas
    // read as overlapping mush, and the export's own text preview covers the
    // same ground properly. Everything below no-ops on the missing element.
    async renderTextPreview() {
        const row = document.getElementById('textPreviewRow');
        const canvas = document.getElementById('textPreview');
        const note = document.getElementById('textPreviewNote');
        if (!row || !canvas) return;
        const config = this.currentVisualizerConfig;
        if (!this.sidHeader || !config || !this.prgExporter) { row.hidden = true; return; }

        const token = ++this._textPreviewToken;
        const cb = window.cacheBust || (s => s);
        let charset = null, caseType;
        try {
            if (typeof FONT_DATA === 'undefined') await window.loadScript('font-data.js');
            if (config.fontType) {
                const idx = parseInt(this.getOptionValue('font'), 10) || 0;
                caseType = await FONT_DATA.getFontCaseType(config.fontType, idx);
                // null means the ROM charset: the player keeps its baked-in
                // $d018 path, and we draw with the ROM glyphs too.
                charset = await FONT_DATA.getFontData(config.fontType, idx);
            }
            if (!charset) {
                if (typeof C64Fonts === 'undefined') await window.loadScript('c64fonts.js');
                charset = C64Fonts && (caseType === 1 ? C64Fonts.lowercase : C64Fonts.uppercase);
            }
        } catch (e) {
            row.hidden = true;
            return;
        }
        if (token !== this._textPreviewToken || !charset) { row.hidden = true; return; }

        const ex = this.prgExporter;
        const lines = ['name', 'author', 'copyright'].map((f) => {
            let str = this.sidHeader[f] || '';
            if (typeof FONT_DATA !== 'undefined' && caseType !== undefined) {
                str = FONT_DATA.convertTextForFont(str, caseType);
            }
            return ex.stringToPETSCII(ex.centerString(str, 32), 32);
        });

        const COLS = 32, CELL = 8;
        canvas.width = COLS * CELL;
        canvas.height = lines.length * CELL;
        const pal = window.C64_PALETTE_RGB;
        const bg = pal[parseInt(this.getOptionValue('backgroundColor'), 10) || 0] || pal[0];
        const fg = pal[(parseInt(this.getOptionValue('textColor'), 10)) || 1] || pal[1];
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(canvas.width, canvas.height);
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const code = lines[Math.floor(y / CELL)][Math.floor(x / CELL)] & 0xff;
                const byte = charset[code * 8 + (y % CELL)] || 0;
                const on = byte & (0x80 >> (x % CELL));
                const c = on ? fg : bg;
                const o = (y * canvas.width + x) * 4;
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        row.hidden = false;

        if (note) {
            // Say when a line was trimmed to fit, since the preview alone shows
            // the result without saying why.
            const tooLong = [['name', 'Title'], ['author', 'Author'], ['copyright', 'Copyright']]
                .filter(([f]) => (this.sidHeader[f] || '').trim().length > 32)
                .map(([, label]) => label);
            note.textContent = tooLong.length
                ? `${tooLong.join(' and ')} will not fit the 32 columns and ${tooLong.length > 1 ? 'are' : 'is'} cut short.`
                : '';
        }
    }

    /** An option's current value, from the live control. */
    getOptionValue(id) {
        const el = document.getElementById(id);
        return el ? el.value : '';
    }

    renderMemoryMap(info, meta = {}) {
        const el = this.elements.memoryMap;
        if (!el || !info || !info.components || info.components.length === 0) return;

        const CATS = UIController.MEMMAP_CATEGORIES;
        const comps = info.components
            .filter(c => !c.hidden)   // input sub-regions that just fill a labelled base region
            .map(c => ({ ...c, cat: this.memMapCategory(c.name) }))
            .sort((a, b) => a.loadAddress - b.loadAddress || b.size - a.size);

        // Tiny regions fully contained inside a larger one are patches (option
        // bytes, baked pointers written into the data block/bank) - fold them away
        // so the map shows real memory regions, not every one-byte poke. Only fold
        // small ones (< 64 B): substantial data placed inside a bigger block - a
        // bitmap's MAP/SCR/COL or a scroll text sitting inside a fixed-bank
        // player's single "Visualizer Binary" component - must still be itemised.
        const folded = comps.filter(c =>
            c.size >= 0x40 ||
            !comps.some(o => o !== c && o.size > c.size &&
                o.loadAddress <= c.loadAddress && o.endAddress >= c.endAddress));

        // Resolve PARTIAL overlaps by write priority (the same layering build()
        // uses): a higher-priority component - a user input such as a bitmap logo,
        // then option patches - owns its bytes, so clip lower-priority regions to
        // the parts they still hold in the final image. Without this a large logo
        // that straddles two base-graphics blocks shows as overlapping both.
        const byPri = [...folded].sort((a, b) =>
            (b.priority || 0) - (a.priority || 0) || b.size - a.size);
        const claimed = [];   // [lo,hi] byte ranges already owned by a higher layer
        const display = [];
        for (const c of byPri) {
            let segs = [[c.loadAddress, c.endAddress]];
            for (const [lo, hi] of claimed) {
                segs = segs.flatMap(([s, e]) => {
                    if (hi < s || lo > e) return [[s, e]];
                    const out = [];
                    if (s < lo) out.push([s, lo - 1]);
                    if (e > hi) out.push([hi + 1, e]);
                    return out;
                });
            }
            for (const [s, e] of segs) display.push({ ...c, loadAddress: s, endAddress: e, size: e - s + 1 });
            claimed.push([c.loadAddress, c.endAddress]);
        }
        display.sort((a, b) => a.loadAddress - b.loadAddress || b.size - a.size);

        const SPAN = 0x10000;
        const pct = v => (v / SPAN * 100);
        const hex = v => '$' + v.toString(16).toUpperCase().padStart(4, '0');
        const sz = n => n >= 1024 ? (n / 1024).toFixed(n % 1024 ? 1 : 0) + ' KB' : n + ' B';

        // Only the placed regions are drawn (in their category colour); every gap
        // is the bar's hatched "unused" background, so free RAM anywhere - including
        // under the KERNAL/IO - simply reads as unused instead of leaving bare gaps.
        let bar = '';
        for (const c of display) {
            const w = Math.max(pct(c.size), 0.4);
            bar += `<div class="mm-seg" style="left:${pct(c.loadAddress)}%;width:${w}%;background:${CATS[c.cat].color}" ` +
                   `title="${c.name} ${hex(c.loadAddress)}-${hex(c.endAddress)} (${sz(c.size)})"></div>`;
        }

        const ticks = [0x0000, 0x4000, 0x8000, 0xC000, 0xFFFF]
            .map(t => `<span class="mm-tick" style="left:${Math.min(pct(t), 99.5)}%">${hex(t)}</span>`).join('');

        const rows = display.map(c =>
            `<tr><td><span class="mm-dot" style="background:${CATS[c.cat].color}"></span>${c.name}</td>` +
            `<td class="mm-mono">${hex(c.loadAddress)}–${hex(c.endAddress)}</td>` +
            `<td class="mm-mono mm-right">${sz(c.size)}</td></tr>`).join('');

        el.innerHTML = `
        <style>
        #memoryMap{margin-top:16px;padding:14px 16px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.03);font-size:13px}
        #memoryMap h4{margin:0 0 4px;font-size:14px;display:flex;align-items:center;gap:8px}
        #memoryMap .mm-sub{opacity:.7;font-size:12px;margin-bottom:12px}
        #memoryMap .mm-bar{position:relative;height:30px;border-radius:4px;overflow:hidden;margin-bottom:4px;background:repeating-linear-gradient(45deg,rgba(255,255,255,.05),rgba(255,255,255,.05) 5px,rgba(255,255,255,.09) 5px,rgba(255,255,255,.09) 10px)}
        #memoryMap .mm-seg{position:absolute;top:0;bottom:0}
        #memoryMap .mm-ruler{position:relative;height:16px;margin-bottom:12px}
        #memoryMap .mm-tick{position:absolute;transform:translateX(-50%);font-size:10px;opacity:.6;font-family:monospace}
        #memoryMap .mm-tick:first-child{transform:none}
        #memoryMap .mm-tick:last-child{transform:translateX(-100%)}
        #memoryMap table{width:100%;border-collapse:collapse;margin-top:4px}
        #memoryMap td{padding:3px 6px;border-bottom:1px solid rgba(255,255,255,.06)}
        #memoryMap .mm-mono{font-family:monospace;opacity:.85}
        #memoryMap .mm-right{text-align:right}
        #memoryMap .mm-dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;vertical-align:middle}
        </style>
        <h4><i class="fas fa-memory"></i> C64 Memory Map</h4>
        <div class="mm-sub">Runtime layout of the exported PRG${meta.compressed ? ' (shown uncompressed; the file itself is crunched)' : ''}.</div>
        <div class="mm-bar">${bar}</div>
        <div class="mm-ruler">${ticks}</div>
        <table><tbody>${rows}</tbody></table>`;
        el.style.display = 'block';
    }

    // Helper functions
    // The name the exported PRG gets, from the template on the Export tab.
    // Placeholders: {name} the SID's filename, {title} / {author} the metadata,
    // {index} the tune's position in a queue (2 digits), {song} the sub-tune.
    // Anything outside a-z 0-9 - ! is dropped, because that is what survives a
    // C64 directory and a .d64 image intact.
    exportBaseName() {
        const clean = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9\-!]/g, '');
        const sidName = clean((this.currentFileName || '').replace(/\.sid$/i, ''));
        const songSel = document.getElementById('songSelector');
        const idx = (this._queue || []).findIndex(i => i.file && i.file.name === this.currentFileName);
        const fields = {
            name: sidName,
            title: clean(this.sidHeader && this.sidHeader.name),
            author: clean(this.sidHeader && this.sidHeader.author),
            song: songSel ? clean(songSel.value) : '',
            index: idx >= 0 ? String(idx + 1).padStart(2, '0') : '',
        };

        const tplEl = document.getElementById('filenameTemplate');
        const template = (tplEl && tplEl.value.trim()) || '{name}';
        let out = template.replace(/\{(\w+)\}/g, (m, key) =>
            (Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : ''));
        out = clean(out).replace(/-+/g, '-').replace(/^-|-$/g, '');

        // A title made entirely of characters the C64 has no room for would
        // otherwise produce a file called ".prg".
        return out || sidName || 'output';
    }

    downloadFile(data, filename) {
        // A queue run diverts every file it produces - into a zip it builds, or
        // straight into a folder the user picked - rather than 14 downloads.
        if (this._fileSink) { this._fileSink(data, filename); return; }
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    showExportStatus(message, type) {
        // Kept for the queue, which reports per-file reasons long after this
        // status has auto-hidden.
        this._lastExportMessage = message;
        const status = this.elements.exportStatus;
        if (status) {
            // An error is announced at once and stays until something replaces
            // it; anything else is polite and self-clearing (see below).
            status.setAttribute('role', type === 'error' ? 'alert' : 'status');
            status.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
            status.textContent = message;
            status.className = `export-status visible ${type}`;

            // Cancel the previous auto-hide so an older message's timer can't
            // dismiss a newer one early (or hide a sticky 'info' status).
            if (this._exportStatusTimer) {
                clearTimeout(this._exportStatusTimer);
                this._exportStatusTimer = null;
            }

            // Errors and warnings stay put. A build failure that erases itself
            // after five seconds is not a report - it was also the only thing
            // saying why nothing downloaded.
            if (type !== 'info' && type !== 'error' && type !== 'warning') {
                this._exportStatusTimer = setTimeout(() => {
                    status.classList.remove('visible');
                }, 5000);
            }
        }
    }

    formatHex(value, digits) {
        return '$' + value.toString(16).toUpperCase().padStart(digits, '0');
    }

    formatDateForDisplay(dateString) {
        if (!dateString) return 'Not Set';

        const date = new Date(dateString);
        const months = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];

        const day = date.getDate();
        const month = months[date.getMonth()];
        const year = date.getFullYear();

        // Add ordinal suffix
        const suffix = this.getOrdinalSuffix(day);

        return `${day}${suffix} ${month} ${year}`;
    }

    getOrdinalSuffix(day) {
        if (day > 3 && day < 21) return 'th';
        switch (day % 10) {
            case 1: return 'st';
            case 2: return 'nd';
            case 3: return 'rd';
            default: return 'th';
        }
    }

    // showBusy(message, submessage, onCancel?): when onCancel is supplied the
    // overlay grows a Cancel button that invokes it (once) - used by the long,
    // interruptible tasks (song-length scan, spectrometer analysis). Tasks that
    // pass no handler get the plain spinner, exactly as before.
    showBusy(message, submessage = '', onCancel = null) {
        if (this.elements.busyOverlay) {
            this._busyOpener = document.activeElement;
            this.elements.busyMessage.textContent = message;
            this.elements.busySubmessage.textContent = submessage;
            this.setBusyNote('');          // a new job has found nothing yet
            this._wireBusyCancel(onCancel);
            this.elements.busyOverlay.classList.add('visible');
            // The page behind is covered by an opaque blur, and the Studio stops
            // trapping Tab while this is up - without inert, focus wanders around
            // a page the user cannot see.
            this._setPageInert(true);
            this._announceBusy(`${message}. ${submessage}`, true);
            // Cancel is the only thing that can be done here, so put focus on it.
            const cancel = document.getElementById('busyCancel');
            if (cancel && !cancel.hidden) cancel.focus();
        }
    }

    /** Hide the page behind a full-screen overlay from the keyboard and from AT. */
    _setPageInert(on) {
        const page = document.querySelector('.container');
        if (!page) return;
        try { page.inert = on; } catch (e) { /* older browser; the Tab trap still applies */ }
    }

    // The progress counter changes several times a second. Feeding every tick to
    // a live region makes a screen reader unusable, so announce on a slow
    // throttle and force the milestones (start, outcome) through.
    _announceBusy(text, force = false) {
        const now = Date.now();
        if (!force && now - (this._lastBusyAnnounce || 0) < 10000) return;
        this._lastBusyAnnounce = now;
        const el = document.getElementById('busyAnnounce');
        if (el) el.textContent = text;
    }

    // Show/reset the overlay's Cancel button. A fresh click handler is attached
    // each time (cloning drops any stale listener); with no handler the button
    // hides. The click disables the button and notes "Cancelling…" so the user
    // sees the request registered while the task unwinds to its next abort check.
    _wireBusyCancel(onCancel) {
        const btn = this.elements.busyCancel;
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        this.elements.busyCancel = fresh;
        fresh.disabled = false;
        fresh.textContent = 'Cancel';
        if (onCancel) {
            fresh.hidden = false;
            fresh.addEventListener('click', () => {
                fresh.disabled = true;
                if (this.elements.busySubmessage) this.elements.busySubmessage.textContent = 'Cancelling…';
                try { onCancel(); } catch (e) { /* best-effort */ }
            }, { once: true });
        } else {
            fresh.hidden = true;
        }
    }

    // m:ss for progress/timeline text (e.g. 84 -> "1:24").
    _mmss(s) {
        const t = Math.round(s || 0), m = Math.floor(t / 60);
        return `${m}:${String(t % 60).padStart(2, '0')}`;
    }

    // Busy-overlay progress callback for the tune analysis. Shows the elapsed tune
    // time scanned rather than a bare % - the scan stops the moment the loop is
    // confirmed, so a % of the full search window can jump from 10% straight to
    // done, which reads as broken. The search cap is shown as "up to" because
    // finishing well short of it is the normal, good case.
    //
    // The counter + cap are shown HALVED. Confirming a loop needs two passes, so
    // internally we scan up to 2x the song length (cap 20:00). Displaying the raw
    // figure confuses users - a 5 min tune scanning to 10 min looks wrong - so we
    // present the song-time equivalent: the loop lands when the counter hits the
    // song's length, and the cap reads 10:00.
    _analysisProgressCallback(title, hint) {
        return (label, frac, extra) => {
            // Anything the scan FOUND goes on its own line and stays there; the
            // counter keeps the line above it. extra.news comes from the render
            // (see spectrometer-bake-core.js), so the two do not have to agree on
            // wording - 'maybe' is a candidate still being checked, 'found' is
            // settled.
            if (extra && extra.news) {
                const at = extra.seconds != null ? ` (at ${this._mmss(extra.seconds / 2)})` : '';
                this.setBusyNote(label + at, extra.news);
            }
            const sub = (extra && extra.seconds != null)
                ? `Scanned ${this._mmss(extra.seconds / 2)} of up to ${this._mmss(extra.totalSeconds / 2)}`
                : `${label}… ${Math.round((frac || 0) * 100)}%`;
            this.updateBusy(title, sub, hint);
        };
    }

    /**
     * The overlay's found-something line: what the job has turned up, as opposed
     * to where it has got to. It STAYS until the job replaces it or ends - a
     * candidate loop used to be written over the progress counter and vanish on
     * the next tick, a few hundred milliseconds later, which read as a flicker
     * rather than as news.
     * @param {string} text
     * @param {'maybe'|'found'} [kind] - 'found' for something settled.
     */
    setBusyNote(text, kind = 'maybe') {
        const el = this.elements.busyNote;
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('is-found', !!text && kind === 'found');
    }

    updateBusy(message, submessage = '', hint = '') {
        if (this.elements.busyOverlay && this.elements.busyOverlay.classList.contains('visible')) {
            this.elements.busyMessage.textContent = message;
            this.elements.busySubmessage.textContent = submessage;
            // Optional persistent hint line (e.g. "this is slow, please be patient").
            // Cleared whenever a caller doesn't pass one, so it can't leak between tasks.
            if (this.elements.busyHint) {
                this.elements.busyHint.textContent = hint;
                this.elements.busyHint.hidden = !hint;
            }
            this._announceBusy(`${message}. ${submessage}`);
        }
    }

    hideBusy(outcome = '') {
        if (this.elements.busyOverlay) {
            this.elements.busyOverlay.classList.remove('visible');
            // Drop the cancel button + its handler so it never leaks into the next task.
            this._wireBusyCancel(null);
            this._setPageInert(false);
            if (outcome) this._announceBusy(outcome, true);
            // Back to whatever was focused when the overlay took over.
            if (this._busyOpener && typeof this._busyOpener.focus === 'function'
                && this._busyOpener.isConnected) {
                this._busyOpener.focus();
            }
            this._busyOpener = null;
        }
    }

    // ---------------------------------------------------------------------
    // Loop/length analysis: one job, started early, joined later
    // ---------------------------------------------------------------------

    /** Is a loop/length scan running right now? */
    get analysisRunning() { return !!this._analysisJob; }

    // The single in-flight scan for the loaded tune. A caller that needs the
    // result (an export) adopts the running job and receives its progress; the
    // load path just starts it and ignores the promise. Resolves to the analysis
    // or null (cancelled / failed / superseded).
    _ensureAnalysis({ onProgress = null, holdOnLoopFound = false } = {}) {
        if (this.tuneAnalysis) return Promise.resolve(this.tuneAnalysis);
        if (this._analysisJob) {
            const job = this._analysisJob;
            if (onProgress) {
                job.listeners.push(onProgress);
                // Catch the new listener up, so an overlay opened mid-scan shows
                // the current position instead of "Preparing…" until the next tick.
                if (job.last) { try { onProgress(...job.last); } catch (e) { /* listener threw */ } }
            }
            return job.promise;
        }
        const ac = new AbortController();
        // Two ways out of a long scan, and they mean different things. Cancel
        // throws the render away and leaves the tune unmeasured; Stop keeps what
        // has been rendered and measures that.
        const stopAc = new AbortController();
        const job = { ac, stopAc, listeners: onProgress ? [onProgress] : [], last: null };
        const fanout = (label, frac, extra) => {
            job.last = [label, frac, extra];
            for (const fn of job.listeners) {
                try { fn(label, frac, extra); } catch (e) { /* listener threw; keep scanning */ }
            }
        };
        this._analysisCancelled = false;
        job.promise = this.runTuneAnalysis({
            signal: ac.signal, stopSignal: stopAc.signal, onProgress: fanout, holdOnLoopFound,
        })
            .finally(() => { if (this._analysisJob === job) this._analysisJob = null; });
        this._analysisJob = job;
        return job.promise;
    }

    /** Stop the running scan, if any. The tune still exports, just without a length. */
    cancelAnalysis() {
        if (!this._analysisJob) return;
        this._analysisCancelled = true;
        this._analysisJob.ac.abort();
    }

    /**
     * Stop searching but keep what has been found. Different from Cancel: the
     * render so far is analysed and used, so a tune whose loop is further out
     * than anyone wants to wait for still gets a length.
     */
    stopSearching() {
        if (!this._analysisJob) return;
        this._analysisJob.stopAc.abort();
    }

    /**
     * How far the scan looks for the tune in hand, in seconds of music. The
     * Advanced setting is where it starts; "Keep looking" raises it for this
     * tune only, so one long tune never slows down every tune after it.
     * The render itself goes to twice this (a loop needs two passes to confirm).
     */
    scanWindowSeconds() {
        return this._scanWindowOverride || this.getAdvancedSettings().maxLoopSeconds
            || UIController.DEFAULT_SCAN_WINDOW;
    }

    /** What a "keep looking" would search to, or null when there is nowhere left to go. */
    nextScanWindowSeconds() {
        const now = this.scanWindowSeconds();
        if (now >= UIController.MAX_SCAN_WINDOW) return null;
        return Math.min(UIController.MAX_SCAN_WINDOW, now * 2);
    }

    /**
     * Search further for a tune that came back with nothing. The render cannot
     * pick up where it stopped - the engine is torn down with it - so this
     * restarts the scan with the window doubled. That is the whole cost, and the
     * status line states it before the user commits.
     */
    async keepLooking() {
        const next = this.nextScanWindowSeconds();
        if (!next || !this.sidHeader) return;
        this._scanWindowOverride = next;
        // Anything still running was measuring a shorter window; drop it and its
        // result, and wait for it to actually let go before starting the next one
        // (startBackgroundAnalysis refuses to run two).
        this._analysisToken++;
        const running = this._analysisJob;
        this.cancelAnalysis();
        if (running) { try { await running.promise; } catch (e) { /* aborted */ } }
        this._hideAnalysisChip();
        this.tuneAnalysis = null;
        this._analysisCancelled = false;
        this.updateSongLoopStatus();
        if (window.studioModal) window.studioModal.queueRefresh();
        this.startBackgroundAnalysis();
    }

    // Start the scan when the SID loads and report it in the corner chip, so the
    // wait overlaps with choosing a visualizer instead of landing on the Generate
    // button. Not started on the main-thread fallback path: there the render runs
    // on the page and would freeze the UI it exists to keep usable.
    async startBackgroundAnalysis() {
        if (this.tuneAnalysis || this._analysisJob || !this.sidHeader) return;
        // Only once the user is actually heading for an export. Someone who loaded
        // a tune to listen to it should not pay for the engine WASM and a
        // full-tune render they will never use; the Studio opening is the signal
        // that they will. studio-modal.js calls this again from open().
        if (!window.studioModal || !window.studioModal.isOpen) return;
        const token = this._analysisToken;
        const cb = window.cacheBust || (s => s);
        let offMainThread = false;
        try {
            const { analysisRunsOffMainThread } = await import(cb('./spectrometer-bake-runner.js'));
            offMainThread = await analysisRunsOffMainThread();
        } catch (e) { /* no worker, no background scan */ }
        // The probe is async - another SID may have loaded, or an export may have
        // started the scan itself, while it resolved.
        if (!offMainThread || token !== this._analysisToken) return;
        if (this.tuneAnalysis || this._analysisJob) return;

        this._showAnalysisChip('Analysing tune…');
        this._ensureAnalysis({
            onProgress: (label, frac, extra) => {
                if (token !== this._analysisToken) return;
                this._showAnalysisChip(this._analysisChipText(extra));
            },
        }).then(() => {
            if (token !== this._analysisToken) return;
            this._finishAnalysisChip();
            this.updateSongLoopStatus();
            if (window.studioModal) window.studioModal.queueRefresh();
        });
    }

    _analysisChipText(extra) {
        // extra.seconds is the doubled search window; halve it for the offer
        // threshold the same way the label does.
        this._analysisScanned = (extra && extra.seconds != null) ? extra.seconds / 2 : 0;
        if (extra && extra.loopFound) return 'Loop found';
        // extra.seconds counts the doubled search window, same as the overlay.
        if (extra && extra.seconds != null) return `Analysing tune… ${this._mmss(extra.seconds / 2)} scanned`;
        return 'Analysing tune…';
    }

    _showAnalysisChip(text) {
        const chip = document.getElementById('analysisChip');
        if (!chip) return;
        chip.hidden = false;
        chip.classList.remove('is-done', 'is-failed');
        clearTimeout(this._analysisChipTimer);
        const label = document.getElementById('analysisChipText');
        if (label) label.textContent = text;
        this._announceAnalysis(text);
        if (!this._analysisChipWired) {
            this._analysisChipWired = true;
            const cancel = document.getElementById('analysisChipCancel');
            if (cancel) cancel.addEventListener('click', () => {
                this.cancelAnalysis();
                this._hideAnalysisChip();
            });
            // Stop searching, but keep the answer: the scan runs to a cap of
            // several minutes on a tune whose loop is a long way out, and
            // "measure what you have" is usually what someone watching wants.
            const stop = document.getElementById('analysisChipStop');
            if (stop) stop.addEventListener('click', () => {
                stop.disabled = true;
                this.stopSearching();
            });
        }
        const stopBtn = document.getElementById('analysisChipStop');
        // Only worth offering once there is something to keep.
        if (stopBtn && !stopBtn.disabled) {
            stopBtn.hidden = !(this._analysisScanned > UIController.STOP_OFFER_SECONDS);
        }
    }

    // The counter moves several times a second; feeding every tick to a live
    // region makes a screen reader unusable, so announce on a slow throttle and
    // force the final outcome through.
    _announceAnalysis(text, force = false) {
        const now = Date.now();
        if (!force && now - (this._lastAnalysisAnnounce || 0) < 10000) return;
        this._lastAnalysisAnnounce = now;
        const el = document.getElementById('analysisChipAnnounce');
        if (el) el.textContent = text;
    }

    _finishAnalysisChip() {
        const chip = document.getElementById('analysisChip');
        if (!chip || chip.hidden) return;
        const label = document.getElementById('analysisChipText');
        const a = this.tuneAnalysis;
        let msg;
        if (a) {
            chip.classList.add('is-done');
            const len = this._mmss(a.looped ? a.storedSeconds : (a.loopStartSeconds || a.storedSeconds));
            msg = a.looped ? `Song length ${len} — loops`
                : a.fadedOut ? `Song length ${len} — fades out`
                    : a.truncated ? `Still playing at ${len} — no length shown`
                        : `Analysed — ${len}`;
        } else {
            chip.classList.add('is-failed');
            msg = this._analysisCancelled
                ? 'Stopped — the export just won\'t show a song length'
                : 'Couldn\'t work out the song length';
        }
        if (label) label.textContent = msg;
        this._announceAnalysis(msg, true);
        // The outcome also lands on the Song tab, so the chip gets out of the way.
        clearTimeout(this._analysisChipTimer);
        this._analysisChipTimer = setTimeout(() => this._hideAnalysisChip(), 8000);
    }

    _resetAnalysisChipStop() {
        const stop = document.getElementById('analysisChipStop');
        if (stop) { stop.disabled = false; stop.hidden = true; }
        this._analysisScanned = 0;
    }

    _hideAnalysisChip() {
        clearTimeout(this._analysisChipTimer);
        this._resetAnalysisChipStop();
        const chip = document.getElementById('analysisChip');
        if (!chip) return;
        chip.hidden = true;
        chip.classList.remove('is-done', 'is-failed');
    }

    // Render + loop-detect the tune's DEFAULT song, so the spectrometer memory
    // readout and the baked song-length are ready with no separate Analyse button.
    // Uses the default subtune (startSong-1), never a hard-coded song 0.
    // Fully guarded: any failure leaves tuneAnalysis null and never blocks the load.
    //
    // Call _ensureAnalysis rather than this directly - it owns the single in-flight
    // job and the abort plumbing.
    async runTuneAnalysis(opts = {}) {
        // The scan can outlive the tune it was started for (it now runs in the
        // background). Carry the token it began with and only publish a result
        // that still belongs to the loaded SID.
        const token = this._analysisToken;
        const mine = () => token === this._analysisToken;

        this.tuneAnalysis = null;
        if (!this.sidHeader) return null;
        let sidBytes = null;
        try { sidBytes = this.analyzer && this.analyzer.createModifiedSID && this.analyzer.createModifiedSID(); } catch (e) { /* no tune */ }
        if (!sidBytes) return null;
        // The default song, 0-indexed - NOT a hard-coded song 0.
        const defaultSong = Math.max(0, (this.sidHeader.startSong || 1) - 1);
        // Scan window: assume tunes up to ~10 min and search 2x that (a loop needs
        // at least two passes to confirm). The render stops early the moment a loop
        // OR a long silence is found, so long tunes rarely cost the full window.
        const adv = this.getAdvancedSettings();
        const maxLoopSeconds = opts.maxLoopSeconds || this.scanWindowSeconds();
        const minLoopSeconds = adv.minLoopSeconds;
        const baseProgress = opts.onProgress || this._analysisProgressCallback('Analysing SID Music',
            'Deep-analysing the SID tune for a better visualisation. This finishes early as soon ' +
            'as the tune\'s loop is found, but can take several minutes on long tunes — please wait.');
        // Watch for the render's early exit so we can hold its "Loop found" message
        // on screen below - a cached analysis fires no progress, so it never pauses.
        let loopFoundEarly = false;
        const onProgress = (label, frac, extra) => {
            if (extra && extra.loopFound) loopFoundEarly = true;
            baseProgress(label, frac, extra);
        };
        const cb = window.cacheBust || (s => s);
        const scanOptions = {
            subtune: defaultSong, numBars: 40, maxHeight: 111,
            maxSeconds: Math.max(30, maxLoopSeconds * 2),
            minLoopSeconds,
            engine: adv.bakeEngine,
            // This is a measurement, not a stream: how much of a non-looping tune
            // the spectrometer can STORE is an export-time cap (see
            // computeBakeRates), and applying it here made every tune that plays
            // past it look like it ended there.
            measureOnly: true,
        };
        try {
            // A scan already done for these exact bytes and settings is the same
            // scan. The bake core's render cache only lives as long as the page,
            // so without this a reload - or the next run of the same queue -
            // measures every tune again from scratch.
            const storeKey = await this._analysisCacheKey(sidBytes, scanOptions);
            if (storeKey) {
                const { readAnalysis } = await import(cb('./analysis-store.js'));
                const hit = await readAnalysis(storeKey);
                if (hit) {
                    if (!mine()) return null;
                    this.tuneAnalysis = hit;
                    return this.tuneAnalysis;
                }
            }
            const { analyzeSpectrometer } = await import(cb('./spectrometer-bake-runner.js'));
            const result = await analyzeSpectrometer(sidBytes, {
                ...scanOptions,
                onProgress,
                signal: opts.signal,
                stopSignal: opts.stopSignal,
            });
            if (storeKey && result) {
                const { writeAnalysis } = await import(cb('./analysis-store.js'));
                writeAnalysis(storeKey, result);
            }
            // Another SID was loaded while this ran - the result describes a tune
            // that is no longer open, so drop it rather than publish it.
            if (!mine()) return null;
            this.tuneAnalysis = result;
            // The scan stopped early on a confirmed loop: without a pause a blocking
            // overlay closes the same instant the message appears, and the early
            // exit just looks like the progress broke. Give it a moment to be read.
            // Only worth it when something is actually showing the message.
            if (loopFoundEarly && this.tuneAnalysis && opts.holdOnLoopFound) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        } catch (e) {
            // A user cancel (AbortError) is expected, not a failure - stay quiet and
            // just leave tuneAnalysis null; the caller checks signal.aborted to react.
            if (!(e && e.name === 'AbortError')) console.warn('Tune loop/length analysis failed:', e);
            if (mine()) this.tuneAnalysis = null;
        }
        return mine() ? this.tuneAnalysis : null;
    }

    /**
     * The key a scan's result is remembered under: the tune's content (title
     * and author excluded, so renaming does not throw a measurement away) plus
     * every setting that changes what the scan finds.
     */
    async _analysisCacheKey(sidBytes, o) {
        const cb = window.cacheBust || (s => s);
        try {
            const { tuneKey } = await import(cb('./spectrometer-bake-core.js'));
            const base = tuneKey(sidBytes, o.subtune, 44100, o.maxSeconds, o.minLoopSeconds, o.engine);
            // v2 distinguishes a tune that faded out from one still playing where
            // the analysis stopped; v3 measures to where the music really ends
            // rather than to the spectrometer's stored-length cap. Older entries
            // answer a different question, so they must not be read back.
            return `${base}|${o.numBars}x${o.maxHeight}|${o.outputMaxSeconds || 0}|v3`;
        } catch (e) {
            return null;   // no key, no cache - the scan still runs
        }
    }

    // Price each frame rate (50/25/16.66) against this tune's stored length and
    // the C64 RAM budget. Returns { rates:[{fpk,hz,est}], budget }.
    async computeBakeRates(analysis) {
        const cb = window.cacheBust || (s => s);
        const { estimateBakeBytes, _internals } = await import(cb('./spectrometer-bake.js'));
        const budget = (_internals && _internals.DEFAULTS && _internals.DEFAULTS.budgetBytes) || 28672;
        // The analysis measures the whole tune. What the spectrometer STORES of a
        // non-looping one is capped by the Advanced stored-length choice, so that
        // is what the rates are priced against - a 15-minute ambient piece is cut
        // to fit, not refused as too long.
        const dur = analysis.looped ? analysis.storedSeconds
            : Math.min(analysis.storedSeconds, this.getAdvancedSettings().storedSeconds);
        const rates = [{ fpk: 1, hz: '50' }, { fpk: 2, hz: '25' }, { fpk: 3, hz: '16.66' }]
            .map(r => ({ ...r, est: estimateBakeBytes(dur, { framesPerKeyframe: r.fpk, frameHz: analysis.frameHz }) }));
        return { rates, budget };
    }

    // Resolve the Advanced frame-rate MODE ('best' | 1 | 2 | 3) against the
    // fitting rates. 'best' picks the highest fps that fits; a fixed rate is
    // used if it fits, else we drop to the best that does (fellBack = true).
    // Returns { rate, fellBack } or null when nothing fits even at 16.66 fps.
    resolveAdvancedRate(rates, mode) {
        const best = rates.find(r => r.est.fits) || null;   // rates ordered 50→25→16.66
        if (mode === 'best') return best ? { rate: best, fellBack: false } : null;
        const wanted = rates.find(r => r.fpk === mode);
        if (wanted && wanted.est.fits) return { rate: wanted, fellBack: false };
        return best ? { rate: best, fellBack: true } : null;
    }

    // Parse a "max song length" the user typed: "m:ss", or a bare number = minutes.
    // Returns seconds, or null when blank/invalid (caller falls back to the default).
    _parseMMSS(str) {
        if (str == null) return null;
        str = String(str).trim();
        if (!str) return null;
        if (str.includes(':')) {
            const [m, s] = str.split(':');
            return (parseInt(m, 10) || 0) * 60 + (parseInt(s, 10) || 0);
        }
        const n = parseFloat(str);
        return isNaN(n) ? null : Math.round(n * 60);   // bare number = minutes
    }

    // Build a lightweight modal (reuses the modal-overlay CSS) with a title, a body we
    // can rewrite as the flow progresses, and a settable button row. Returns imperative
    // handles - the flows below drive it. Kept apart from ErrorModal (text-only body).
    // UNUSED. Kept because it is the shape a future in-flow prompt would take -
    // but if it is ever wired up it MUST be registered in studio-modal.js's
    // modal-precedence list and given a Tab trap and focus restore, or it
    // inherits the bug logoFitModal had: Escape closing the Studio underneath it
    // and Tab being yanked out from behind the dialog. It builds its own element
    // rather than reusing #modalOverlay, so the id-based check would miss it.
    _flowModal(title) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay flow-modal visible';
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.innerHTML = '<div class="modal-title"></div><div class="flow-modal-body"></div><div class="modal-actions"></div>';
        overlay.appendChild(content);
        document.body.appendChild(overlay);
        content.querySelector('.modal-title').textContent = title;
        const body = content.querySelector('.flow-modal-body');
        const actionsEl = content.querySelector('.modal-actions');
        const setActions = (actions) => {
            actionsEl.innerHTML = '';
            for (const a of actions) {
                const btn = document.createElement('button');
                btn.className = 'modal-action-btn ' + (a.secondary ? 'secondary' : 'primary');
                btn.textContent = a.label;
                if (a.disabled) btn.disabled = true;
                btn.addEventListener('click', a.onClick);
                actionsEl.appendChild(btn);
            }
        };
        return { body, setActions, close: () => overlay.remove() };
    }

    showModal(message, isSuccess, options = {}) {
        // Use the unified error modal system
        if (window.errorModal) {
            if (isSuccess) {
                window.errorModal.success(message, options);
            } else {
                // For errors, show with manual dismiss for important errors
                // or auto-dismiss for minor warnings
                window.errorModal.error(message, {
                    duration: options.autoDismiss ? 3000 : 0,
                    ...options
                });
            }
        } else {
            // Fallback for when error modal isn't loaded yet
            this.elements.modalIcon.textContent = isSuccess ? '\u2713' : '\u2717';
            this.elements.modalIcon.className = isSuccess ? 'modal-icon success' : 'modal-icon error';
            this.elements.modalMessage.textContent = message;

            this.elements.modalOverlay.classList.add('visible');

            setTimeout(() => {
                this.elements.modalOverlay.classList.remove('visible');
            }, 2000);
        }
    }

    hideMessages() {
        this.elements.errorMessage.classList.remove('visible');
        // A new file is on the way in: clear the Studio's per-file state.
        if (window.studioModal) window.studioModal.resetForNewFile();
    }

    loadScrollText(textareaId) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt';

        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const textarea = document.getElementById(textareaId);
                    if (textarea) {
                        textarea.value = e.target.result;
                        // Run the same validation/disclosure as typing.
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                };
                reader.readAsText(file);
            }
        };

        input.click();
    }

    saveScrollText(textareaId) {
        const textarea = document.getElementById(textareaId);
        if (!textarea) return;

        const text = textarea.value;
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'scrolltext.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Initialize UI - called directly since scripts are loaded dynamically after DOM is ready
(function initUI() {
    // Initialize the UI controller (WASM + PRG exporter load lazily on demand)
    window.uiController = new UIController();

    // Deep link: /?tune=<HVSC path> opens the HVSC browser at that tune
    // (hvsc-browser.js reads the param itself during initialization).
    try {
        if (new URLSearchParams(location.search).get('tune')) {
            window.uiController.openHVSCBrowser();
        }
    } catch (e) { /* non-fatal */ }

    // Load non-critical cosmetic scripts when idle
    var loadWhenIdle = window.requestIdleCallback || function(cb) { setTimeout(cb, 2000); };
    loadWhenIdle(function() { window.loadScript('floating-notes.js'); });
})();