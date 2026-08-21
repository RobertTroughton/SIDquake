// UI controller for SIDquake web app.

// C64 hardware palette (16 colors). Index matches the C64 color number.
const C64_COLORS = [
    { value: 0, name: 'Black', hex: '#000000' },
    { value: 1, name: 'White', hex: '#FFFFFF' },
    { value: 2, name: 'Red', hex: '#753d3d' },
    { value: 3, name: 'Cyan', hex: '#7bb4b4' },
    { value: 4, name: 'Purple', hex: '#7d4488' },
    { value: 5, name: 'Green', hex: '#5c985c' },
    { value: 6, name: 'Blue', hex: '#343383' },
    { value: 7, name: 'Yellow', hex: '#cbcc7c' },
    { value: 8, name: 'Orange', hex: '#7c552f' },
    { value: 9, name: 'Brown', hex: '#523e00' },
    { value: 10, name: 'Light Red', hex: '#a76f6f' },
    { value: 11, name: 'Dark Grey', hex: '#4e4e4e' },
    { value: 12, name: 'Grey', hex: '#767676' },
    { value: 13, name: 'Light Green', hex: '#9fdb9f' },
    { value: 14, name: 'Light Blue', hex: '#6d6cbc' },
    { value: 15, name: 'Light Grey', hex: '#a3a3a3' }
];

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
        const closeHVSCModal = () => {
            const modal = document.getElementById('hvscModal');
            if (!modal.classList.contains('visible')) return;
            modal.classList.remove('visible');
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
            closeBtn.addEventListener('click', closeHVSCModal);
        }

        // Click on backdrop (not modal content) closes the modal.
        const hvscModal = document.getElementById('hvscModal');
        if (hvscModal) {
            hvscModal.addEventListener('click', (e) => {
                if (e.target === hvscModal) closeHVSCModal();
            });
        }

        // While the browser is open it owns the keyboard: Escape closes it and
        // Tab is trapped inside so focus can't fall through to the covered page.
        // Defer when another modal is layered above (that modal owns the keyboard).
        document.addEventListener('keydown', (e) => {
            if (!document.getElementById('hvscModal')?.classList.contains('visible')) return;
            const above = ['galleryModal', 'busyOverlay', 'modalOverlay',
                'imageSelectorModal', 'colorPickerModal']
                .some(id => document.getElementById(id)?.classList.contains('visible'));
            if (above) return;
            if (e.key === 'Escape') closeHVSCModal();
            else if (e.key === 'Tab') this._trapHvscTab(e);
        });

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

    async openHVSCBrowser() {
        const modal = document.getElementById('hvscModal');
        // Remember what to restore focus to, then move focus into the browser.
        this._hvscPreviouslyFocused = document.activeElement;
        modal.classList.add('visible');
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
        this.elements.sidTitle.querySelector('.text').textContent = 'Song Title';
        this.elements.sidAuthor.querySelector('.text').textContent = 'Artist Name';
        this.elements.sidCopyright.querySelector('.text').textContent = 'Copyright Info';

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

    setupEditableFields() {
        const editableFields = [this.elements.sidTitle, this.elements.sidAuthor, this.elements.sidCopyright];

        editableFields.forEach(field => {
            const textSpan = field.querySelector('.text');

            // Keyboard users need to reach and trigger the field the same way a
            // mouse click does.
            field.tabIndex = 0;
            field.setAttribute('role', 'button');
            field.setAttribute('aria-label', `Edit ${field.dataset.field || 'field'}`);

            field.addEventListener('click', (e) => {
                if (!field.classList.contains('editing') && !field.classList.contains('disabled')) {
                    this.startEditing(field);
                }
            });

            field.addEventListener('keydown', (e) => {
                if (!field.classList.contains('editing')) {
                    // Enter/Space begins editing (mirrors a click).
                    if ((e.key === 'Enter' || e.key === ' ') && !field.classList.contains('disabled')) {
                        e.preventDefault();
                        this.startEditing(field);
                    }
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.stopEditing(field);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.cancelEditing(field);
                }
            });

            // Blur on the inner text span fires when the user tabs/clicks away.
            // The 200ms delay lets a click on another control fire first so we
            // don't tear down editing state mid-interaction.
            textSpan.addEventListener('blur', () => {
                if (field.classList.contains('editing')) {
                    setTimeout(() => {
                        if (field.classList.contains('editing')) {
                            this.stopEditing(field);
                        }
                    }, 200);
                }
            });

            // Strip formatting from pasted content; SID metadata is plain text only.
            textSpan.addEventListener('paste', (e) => {
                e.preventDefault();

                let text = '';
                const clipboard = e.clipboardData || window.clipboardData;
                if (clipboard) {
                    text = clipboard.getData('text/plain') || clipboard.getData('Text') || '';
                }

                text = text.replace(/[\r\n\t]/g, ' ');
                text = text.replace(/\s+/g, ' ');
                text = text.trim();

                if (window.getSelection) {
                    const selection = window.getSelection();
                    if (!selection.rangeCount) return;
                    selection.deleteFromDocument();
                    selection.getRangeAt(0).insertNode(document.createTextNode(text));
                    selection.collapseToEnd();
                }
            });
        });
    }

    startEditing(field) {
        field.classList.add('editing');

        const textSpan = field.querySelector('.text');
        textSpan.contentEditable = 'true';
        textSpan.focus();

        field.dataset.originalValue = textSpan.textContent;

        const range = document.createRange();
        range.selectNodeContents(textSpan);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    stopEditing(field) {
        field.classList.remove('editing');

        const textSpan = field.querySelector('.text');
        textSpan.contentEditable = 'false';

        let text = textSpan.textContent || '';

        text = text.replace(/<[^>]*>/g, '');

        text = text.replace(/[\r\n\t]/g, ' ');
        text = text.replace(/\s+/g, ' ');
        text = text.trim();

        // SID header fields are limited to 31 chars (32 bytes including null terminator).
        if (text.length > 31) {
            text = text.substring(0, 31);
        }

        textSpan.textContent = text;

        // The DOM field uses 'title' but the WASM analyzer expects 'name'.
        const fieldName = field.dataset.field;
        let analyzerFieldName = fieldName;
        if (fieldName === 'title') analyzerFieldName = 'name';

        this.analyzer.updateMetadata(analyzerFieldName, text);

        // updateMetadata only writes the WASM copy, which is what a saved .sid is
        // built from. The PRG's on-screen title/author/copyright come from the
        // cached header object instead (prg-builder createPRG -> generateDataBlock),
        // so it has to move in step or an edit reaches the .sid and not the export.
        // sidHeader and analyzer.sidHeader are the same object today; update both
        // in case they ever stop being.
        for (const h of [this.sidHeader, this.analyzer.sidHeader]) {
            if (h) h[analyzerFieldName] = text;
        }
        if (window.studioModal) window.studioModal.refreshHeader();

        this.checkForModifications();
    }

    cancelEditing(field) {
        const textSpan = field.querySelector('.text');
        textSpan.textContent = field.dataset.originalValue || '';
        field.classList.remove('editing');
        textSpan.contentEditable = 'false';
    }

    checkForModifications() {
        const currentTitle = this.elements.sidTitle.querySelector('.text').textContent.trim();
        const currentAuthor = this.elements.sidAuthor.querySelector('.text').textContent.trim();
        const currentCopyright = this.elements.sidCopyright.querySelector('.text').textContent.trim();

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
    // Batch queue
    // ---------------------------------------------------------------------

    // One or many SIDs, from the picker or a drop. The first is loaded as
    // always; the rest wait in a queue that can be exported with whatever
    // settings the user then chooses. Dropping a folder of tunes used to load
    // one and silently discard the others.
    async acceptFiles(fileList) {
        const files = [...(fileList || [])].filter(f => /\.sid$/i.test(f.name));
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
            note.textContent = this._queueRunning
                ? 'Exporting each tune with the settings below. Every file lands in your downloads.'
                : 'Set up the first tune the way you want the whole set, then export them all. '
                + 'Each one is measured and built with the same visualizer and options.';
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
        on('sidQueueStop', () => { this._queueStop = true; });
        on('sidQueueClear', () => {
            this._queue = [];
            this._queueStop = true;
            this.renderQueue();
        });
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
        this.renderQueue();
        try {
            for (const item of this._queue) {
                if (this._queueStop) { item.state = item.state === 'done' ? 'done' : 'pending'; continue; }
                item.state = 'building';
                item.note = '';
                this.renderQueue();
                try {
                    await this.processFile(item.file);
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
            this._queueRunning = false;
            this._queueStop = false;
            this.renderQueue();
        }
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

            this.updateBusy('Analyzing SID Music', 'This may take a few moments...');

            const frameCount = 30000;
            let lastProgress = 0;

            this.analysisResults = await this.analyzer.analyze(frameCount, (current, total) => {
                const percent = Math.floor((current / total) * 100);
                if (percent !== lastProgress) {
                    lastProgress = percent;
                    this.updateBusy('Analyzing SID Music', `Processing frame ${current.toLocaleString()} of ${total.toLocaleString()} (${percent}%)`);
                }
            });

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

            // Cleared for the new tune; startBackgroundAnalysis below refills it
            // while the user is choosing a visualizer.
            this.tuneAnalysis = null;

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

    addSongSelector() {
        const existingSelector = document.getElementById('songSelectorContainer');
        if (existingSelector) {
            existingSelector.remove();
        }

        if (this.sidHeader && this.sidHeader.songs > 1) {
            const visualizerGrid = document.getElementById('visualizerGrid');
            const selectorContainer = document.createElement('div');
            selectorContainer.id = 'songSelectorContainer';
            selectorContainer.className = 'export-option song-selector-container';
            selectorContainer.innerHTML = `
            <label for="songSelector">Select Song:</label>
            <select id="songSelector">
                ${Array.from({ length: Math.min(this.sidHeader.songs, 256) }, (_, i) => i + 1)
                    .map(num => `<option value="${num}" ${num === this.sidHeader.startSong ? 'selected' : ''}>
                        Song ${num} of ${this.sidHeader.songs}${num === this.sidHeader.startSong ? ' (default)' : ''}
                    </option>`).join('')}
            </select>
            <div id="fftMultiSongNote" style="display:none;margin-top:8px;padding:8px 10px;border:1px solid rgba(255,183,77,.4);border-radius:6px;background:rgba(255,183,77,.08);font-size:12px;line-height:1.4">
                <b style="color:#ffb74d">This file holds several tunes.</b> The Spectrometer works out its
                bars in advance, and it can only do that for one of them. If you carry on: the exported
                program plays and shows <b>only the tune selected above</b>, the buttons that switch between
                tunes stop working, and no song length is shown.
                To keep all the tunes, pick a <b>VU meter</b> method on the Method tab instead.
                <label style="display:flex;gap:6px;margin-top:8px;align-items:center;cursor:pointer">
                    <input type="checkbox" id="fftMultiSongConsent"> Yes — just the one tune</label>
            </div>
        `;

            visualizerGrid.parentNode.insertBefore(selectorContainer, visualizerGrid);
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

        // Bar styles default to the Spectrometer (precomputed) source - the best
        // looking / lowest CPU option. If the tune is too fast/multi-SID for it,
        // fall back to the first source that can handle it (realtime, then shadow).
        // A source the user chose earlier in the session is tried first, so a
        // deliberate "shadow for this release" survives loading the next tune.
        let target = visualizer;
        if (visualizer.dataSourceGroup) {
            const members = VISUALIZERS.filter(v => v.dataSourceGroup === visualizer.dataSourceGroup);
            const byMethod = m => members.find(v => v.dataSource === m);
            const order = this._lastDataSource
                ? [this._lastDataSource, ...['fft', 'realtime', 'shadow'].filter(m => m !== this._lastDataSource)]
                : ['fft', 'realtime', 'shadow'];
            const preferred = order.map(byMethod).filter(Boolean);
            // Prefer a source that can actually be built for this tune (fits memory
            // + within the calls/SID caps); fall back to calls-usable, then FFT.
            target = preferred.find(v => this.visualizerExportable(v).ok)
                || preferred.find(v => this.dataSourceUsable(v).ok)
                || byMethod('fft') || visualizer;
        }
        this.selectedVisualizer = target;

        if (remember) this._lastVisualizerId = visualizer.id;

        this.elements.exportPRGButton.disabled = false;

        // The memory map reflects the last export - it's now stale for the newly
        // selected visualizer, so hide it until the next export regenerates it.
        this.clearMemoryMap();
        this.updateMultiSongNote();

        this.loadVisualizerOptions(target);
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

        el.innerHTML = `
            <h4 class="ed-title">Your file is ready</h4>
            <p class="ed-file"><strong>${esc(info.filename)}</strong> · ${esc(info.sizeKB)} KB · saved to your downloads</p>
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
            this.clearMemoryMap();
            this.updateMultiSongNote();
            this.loadVisualizerOptions(variant);
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

        // Method tab: how the bars are generated (its own tab now, not tucked
        // under the visualizer grid). vizExtras is left empty.
        const methodMount = document.getElementById('methodMount');
        if (methodMount) {
            const methodHTML = this.createMethodPanelHTML(visualizer);
            methodMount.innerHTML = methodHTML
                ? this._wrapOptionsPanel(`<div class="option-group">${methodHTML}</div>`) : '';
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
            } else if (el.files && el.files.length) {
                this._imageSelectionMemory[this._imageSlot(input)] = { kind: 'custom', fileObj: el.files[0] };
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
        return { ...this._advanced, maxLoopSeconds: this._parseMMSS(this._advanced.scanLenText) || undefined };
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
            </div>
        </details>`;
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
        const current = visualizer.dataSource || 'fft';
        const variantOf = m => members.find(v => v.dataSource === m);

        const cards = [
            { m: 'fft', name: 'Best looking', tags: ['recommended', 'follows the actual sound'],
              desc: 'SIDquake listens to the whole tune here in the browser and stores what it '
                  + 'hears, so the bars follow the real sound exactly.',
              rows: [['pro', 'The bars match the music closely'],
                     ['pro', 'Works with any tune, however it is written'],
                     ['pro', 'Leaves the C64 the most time for other things'],
                     ['con', 'Makes a bigger file'],
                     ['con', 'Only one tune per file'],
                     ['con', 'Has to listen to the tune first — usually under a minute']] },
            { m: 'realtime', name: 'Live · careful', tags: ['works out the bars on the C64', 'smaller file'],
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
        return `<div class="method-cards">${html}</div>`;
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
        this.elements.sidTitle.querySelector('.text').textContent = header.name || 'Unknown';
        this.elements.sidAuthor.querySelector('.text').textContent = header.author || 'Unknown';
        this.elements.sidCopyright.querySelector('.text').textContent = header.copyright || 'Unknown';

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
            title: this.elements.sidTitle.querySelector('.text').textContent.trim(),
            author: this.elements.sidAuthor.querySelector('.text').textContent.trim(),
            copyright: this.elements.sidCopyright.querySelector('.text').textContent.trim()
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
                this.showExportStatus('This is a multi-song SID. Tick “visualise the default song only” to export the spectrometer, or pick a VU meter method.', 'error');
                const note = document.getElementById('fftMultiSongNote');
                if (note) note.style.outline = '2px solid #ffb74d';
                // The consent checkbox lives on the Visualizer tab - show it.
                if (window.studioModal) window.studioModal.activate('visualizer');
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
                maxLoopSeconds: adv.maxLoopSeconds,
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
            // Sanitize filename: lowercase, remove .sid extension, keep only a-z, 0-9, -, !
            const baseName = this.currentFileName ?
                this.currentFileName
                    .replace(/\.sid$/i, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9\-!]/g, '') : 'output';

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
            this.renderExportDone({
                filename,
                sizeKB,
                isCompressed,
                compressionFailed,
                compressionType,
                sysAddress: realSysAddress,
            });

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
        on('songLengthManual', 'input', () => {
            this.updateSongLoopStatus();
            if (window.studioModal) window.studioModal.queueRefresh();
        });
        on('showSongLengthToggle', 'change', () => {
            this.updateSongLoopStatus();
            if (window.studioModal) window.studioModal.queueRefresh();
        });
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
            text = `No repeat or fade-out found in ${this._mmss(a.analyzedSeconds)} of scanning, ` +
                `so the typed length ${this._mmss(manual)} is used instead. Forced looping is unavailable.`;
            enabled = false;
        } else {
            text = `No repeat or fade-out found within the analysis window (${this._mmss(a.analyzedSeconds)} scanned) ` +
                '— forced looping is unavailable. Type the length in if you know it.';
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
        const bars = !!d.bars;
        // Nothing wraps back on a fade, so no arc is drawn for that case.
        const arc = !faded;
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
        } else {
            note = `No repeat detected — the full <b>${mmss(storedSec)}</b> replays from the start.`;
        }

        const bodyLabel = faded ? 'fade' : (forced ? 'plays, then restarts' : 'loop body');
        const legendBody = faded ? 'Fade to silence (held)'
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
            ${introSec > 0 ? `<div class="bt-seg bt-intro" style="left:0;width:${introPct}%">${introPct > 14 ? (faded ? 'plays through' : 'intro') : ''}</div>` : ''}
            <div class="bt-seg" style="left:${introPct}%;width:${100 - introPct}%;background:${bodyBg}">${(100 - introPct) > 14 ? bodyLabel : ''}</div>
        </div>
        <div class="bt-ticks">
            <span class="bt-tick bt-start" style="left:0%">0:00</span>
            ${showMidTick ? `<span class="bt-tick" style="left:${introPct}%">${faded ? '⤓' : '⟲'} ${mmss(introSec)}</span>` : ''}
            <span class="bt-tick bt-end" style="left:100%">${mmss(storedSec)}</span>
        </div>
        <div class="bt-legend">
            ${introSec > 0 ? `<span><i class="bt-sw" style="background:rgba(144,164,174,.4)"></i>${faded ? 'Tune (plays once)' : 'Intro (plays once)'}</span>` : ''}
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
        } else if (a.fadedOut) {
            mode = 'fade';
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
            : info.fadedOut ? 'fade' : 'none';
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
    downloadFile(data, filename) {
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
            let sub;
            if (extra && extra.loopFound) {
                sub = label;   // "Loop found — ..." stands on its own, no counter
            } else if (extra && extra.seconds != null) {
                sub = `${label}… ${this._mmss(extra.seconds / 2)} scanned (up to ${this._mmss(extra.totalSeconds / 2)})`;
            } else {
                sub = `${label}… ${Math.round((frac || 0) * 100)}%`;
            }
            this.updateBusy(title, sub, hint);
        };
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
        const job = { ac, listeners: onProgress ? [onProgress] : [], last: null };
        const fanout = (label, frac, extra) => {
            job.last = [label, frac, extra];
            for (const fn of job.listeners) {
                try { fn(label, frac, extra); } catch (e) { /* listener threw; keep scanning */ }
            }
        };
        this._analysisCancelled = false;
        job.promise = this.runTuneAnalysis({ signal: ac.signal, onProgress: fanout, holdOnLoopFound })
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

    _hideAnalysisChip() {
        clearTimeout(this._analysisChipTimer);
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
        const maxLoopSeconds = opts.maxLoopSeconds || adv.maxLoopSeconds || 600;
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
        try {
            const { analyzeSpectrometer } = await import(cb('./spectrometer-bake-runner.js'));
            const result = await analyzeSpectrometer(sidBytes, {
                subtune: defaultSong, numBars: 40, maxHeight: 111,
                maxSeconds: Math.max(30, maxLoopSeconds * 2),
                minLoopSeconds,
                engine: adv.bakeEngine,
                // Same cap the export will bake with, or the length/segment/memory
                // figures shown here would not be the ones the PRG ends up storing.
                outputMaxSeconds: adv.storedSeconds,
                onProgress,
                signal: opts.signal,
            });
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

    // Price each frame rate (50/25/16.66) against this tune's stored length and
    // the C64 RAM budget. Returns { rates:[{fpk,hz,est}], budget }.
    async computeBakeRates(analysis) {
        const cb = window.cacheBust || (s => s);
        const { estimateBakeBytes, _internals } = await import(cb('./spectrometer-bake.js'));
        const budget = (_internals && _internals.DEFAULTS && _internals.DEFAULTS.budgetBytes) || 28672;
        const dur = analysis.storedSeconds;
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