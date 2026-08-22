class ImageSelectorModal {
    constructor() {
        this.modal = null;
        this.currentConfig = null;
        this.currentContainer = null;
        this.dropZone = null;
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;

        this.createModalHTML();
        this.attachEventListeners();
        this.initialized = true;
    }

    createModalHTML() {
        const modalHTML = `
            <div class="image-selector-modal" id="imageSelectorModal" data-overlay>
                <div class="image-selector-modal-content">
                    <button class="image-selector-modal-close" id="imageSelectorModalClose"><i class="fas fa-times"></i></button>
                    <div class="image-selector-modal-body">
                        <h3 class="image-selector-title" id="imageSelectorTitle">Select Image</h3>
                        
                        <div class="image-selector-drop-zone" id="imageSelectorDropZone">
                            <i class="fas fa-cloud-upload-alt" style="font-size: 48px; color: var(--accent); margin-bottom: 15px;"></i>
                            <div class="drop-zone-text">Drag and drop an image here</div>
                            <div class="drop-zone-subtext">or use the options below</div>
                        </div>

                        <div class="image-selector-options">
                            <button class="selector-option-btn" id="selectorBrowseBtn">
                                <i class="fas fa-folder-open"></i>
                                <span>Browse Files</span>
                            </button>
                            <button class="selector-option-btn" id="selectorGalleryBtn">
                                <i class="fas fa-images"></i>
                                <span>Choose from Gallery</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = modalHTML;
        document.body.appendChild(tempDiv.firstElementChild);

        this.modal = document.getElementById('imageSelectorModal');
        this.dropZone = document.getElementById('imageSelectorDropZone');
    }

    attachEventListeners() {
        const closeBtn = document.getElementById('imageSelectorModalClose');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && this.modal.classList.contains('visible')) {
                this.close();
            }
        });

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });

        const browseBtn = document.getElementById('selectorBrowseBtn');
        if (browseBtn) {
            browseBtn.addEventListener('click', () => {
                this.handleBrowse();
            });
        }

        const galleryBtn = document.getElementById('selectorGalleryBtn');
        if (galleryBtn) {
            galleryBtn.addEventListener('click', () => {
                this.handleGallery();
            });
        }

        this.attachDropZoneHandlers();
    }

    attachDropZoneHandlers() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, () => {
                this.dropZone.classList.add('drag-active');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, () => {
                this.dropZone.classList.remove('drag-active');
            });
        });

        this.dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                if (this.isValidImageFile(file)) {
                    window.imagePreviewManager.handleFileChange({ target: { files: [file] } }, this.currentConfig);
                    this.close();
                } else {
                    if (window.showWarning) {
                        window.showWarning('Please drop a valid image file (PNG format required)');
                    } else {
                        console.warn('Please drop a valid image file');
                    }
                }
            }
        });
    }

    isValidImageFile(file) {
        if (!this.currentConfig || !this.currentConfig.accept) return true;

        const acceptTypes = this.currentConfig.accept.split(',').map(t => t.trim());

        for (const acceptType of acceptTypes) {
            if (acceptType.startsWith('.')) {
                if (file.name.toLowerCase().endsWith(acceptType.toLowerCase())) {
                    return true;
                }
            } else if (acceptType.includes('*')) {
                const [type] = acceptType.split('/');
                if (file.type.startsWith(type + '/')) {
                    return true;
                }
            } else if (file.type === acceptType) {
                return true;
            }
        }

        return false;
    }

    open(config, container) {
        if (!this.initialized) this.init();
        if (!this.modal) return;

        this.currentConfig = config;
        this.currentContainer = container;

        const title = document.getElementById('imageSelectorTitle');
        if (title) {
            title.textContent = config.label || 'Select Image';
        }

        const galleryBtn = document.getElementById('selectorGalleryBtn');
        if (galleryBtn) {
            if (config.gallery && config.gallery.length > 0) {
                galleryBtn.style.display = 'flex';
            } else {
                galleryBtn.style.display = 'none';
            }
        }

        this.modal.classList.add('visible');
        document.body.style.overflow = 'hidden';
    }

    close() {
        if (this.modal) {
            this.modal.classList.remove('visible');
            document.body.style.overflow = '';
        }
    }

    handleBrowse() {
        const fileInput = this.currentContainer.querySelector(`#${this.currentConfig.id}`);
        if (fileInput) {
            fileInput.click();
            this.close();
        }
    }

    handleGallery() {
        this.close();
        const galleryModal = window.imagePreviewManager.initGalleryModal();
        galleryModal.open(this.currentConfig, this.currentContainer);
    }
}

class GalleryModal {
    constructor() {
        this.modal = null;
        this.currentConfig = null;
        this.currentContainer = null;
        this.selectedItem = null;
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;

        this.modal = document.getElementById('galleryModal');
        if (!this.modal) {
            console.warn('Gallery modal element not found in DOM');
            return;
        }

        const closeBtn = document.getElementById('galleryModalClose');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && this.modal.classList.contains('visible')) {
                this.close();
            }
        });

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });

        this.initialized = true;
    }

    open(config, container) {
        if (!this.initialized) this.init();
        if (!this.modal) return;

        this.currentConfig = config;
        this.currentContainer = container;
        this.selectedItem = null;
        this.populateGeneration = (this.populateGeneration || 0) + 1;

        const subtitle = document.getElementById('gallerySubtitle');
        if (subtitle) {
            subtitle.textContent = `Select ${config.label || 'an image'}`;
        }

        this.populateGallery(config.gallery);

        this.modal.classList.add('visible');
        document.body.style.overflow = 'hidden';
    }

    close() {
        // Stop any in-flight badge classification loop (annotateLogoTypes checks
        // this generation) so it doesn't keep churning after the modal is gone.
        this.populateGeneration = (this.populateGeneration || 0) + 1;
        if (this.modal) {
            this.modal.classList.remove('visible');
            document.body.style.overflow = '';
        }
    }

    populateGallery(gallery) {
        const gridContainer = document.getElementById('galleryGridContainer');
        const itemCount = document.getElementById('galleryItemCount');

        if (!gridContainer) return;

        gridContainer.innerHTML = '';

        if (!gallery || gallery.length === 0) {
            gridContainer.innerHTML = '<div class="gallery-loading">No images available</div>';
            if (itemCount) {
                itemCount.textContent = '0 items';
            }
            return;
        }

        gridContainer.setAttribute('role', 'radiogroup');
        gridContainer.setAttribute('aria-label', 'Image gallery');

        gallery.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'gallery-item-card';
            card.dataset.file = item.file;
            card.dataset.name = item.name;
            card.dataset.index = index;

            // Build with DOM APIs rather than interpolated innerHTML: name/file
            // come from remote gallery JSON, so a quote or markup in them must
            // never break the attribute or inject HTML.
            const preview = document.createElement('div');
            preview.className = 'gallery-item-preview';
            const img = document.createElement('img');
            img.src = item.file;
            img.alt = item.name;
            preview.appendChild(img);

            const info = document.createElement('div');
            info.className = 'gallery-item-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'gallery-item-name';
            nameEl.textContent = item.name;
            info.appendChild(nameEl);

            const badge = document.createElement('div');
            badge.className = 'gallery-item-selected-badge';
            badge.innerHTML = '<i class="fas fa-check"></i> Selected';

            card.append(preview, info, badge);

            // The radio wiring lives on the manager, not on this modal.
            window.imagePreviewManager._makeGalleryCardRadio(gridContainer, card, false, () => {
                this.selectedItem = item;
                setTimeout(() => {
                    this.selectImage();
                }, 200);
            });

            gridContainer.appendChild(card);
        });

        if (itemCount) {
            itemCount.textContent = `${gallery.length} ${gallery.length === 1 ? 'item' : 'items'}`;
        }

        // Logo inputs: classify each image with the CharSet Lab engine and
        // badge its type (MC BMP / MIXED / ECM / ...); images this player
        // can't convert are dimmed with the reason in the tooltip.
        this.annotateLogoTypes(gallery);
    }

    // Sequentially badge the gallery cards with each logo's detected type.
    // Runs only for logo-converted inputs; a reopen (new generation) or a
    // different input config stops a stale pass.
    async annotateLogoTypes(gallery) {
        const config = this.currentConfig;
        if (!config || !gallery || !window.imagePreviewManager.isLogoInput(config)) return;
        const generation = this.populateGeneration;
        for (const item of gallery) {
            // Yield a macrotask before each image so the analysis (even at ~38ms
            // apiece) never queues up ahead of user input - clicks on cards and the
            // close button stay responsive while the badges fill in progressively.
            await new Promise(r => setTimeout(r, 0));
            if (generation !== this.populateGeneration) return;
            const info = await window.imagePreviewManager.classifyLogoFile(item.file, config);
            if (generation !== this.populateGeneration) return;
            if (!info) continue;
            const card = document.querySelector(`.gallery-item-card[data-file="${CSS.escape(item.file)}"]`);
            if (!card) continue;
            const preview = card.querySelector('.gallery-item-preview');
            if (!preview || preview.querySelector('.gallery-item-type-badge')) continue;
            const badge = document.createElement('div');
            badge.className = 'gallery-item-type-badge' + (info.ok ? '' : ' unusable');
            badge.textContent = info.label;
            badge.title = info.title;
            preview.appendChild(badge);
            if (!info.ok) {
                card.classList.add('gallery-item-unusable');
                card.title = info.title;
            }
        }
    }

    async selectImage() {
        if (!this.selectedItem) return;

        await window.imagePreviewManager.loadGalleryImage(
            this.currentContainer,
            this.currentConfig,
            this.selectedItem.file,
            this.selectedItem.name
        );

        this.close();
    }
}

class ImagePreviewManager {
    constructor() {
        this.previewCache = new Map();
        this.galleryModal = null;
        this.selectorModal = null;
        this.logoTypeCache = new Map();
        // Per-input logo placement: the decoded source image plus where it sits
        // on the C64 screen (see logo-fit.js). Keyed by input id.
        this.logoFit = new Map();
        this.logoFitModal = null;
    }

    // ─── Logo type classification (badges) ───

    // Inputs converted by the CharSet Lab engine get type badges.
    isLogoInput(config) {
        return !!config && (config.convertType === 'logo' || config.convertType === 'charset');
    }

    // Classify a gallery/default logo by path (cached per path + input
    // constraints). Resolves to { ok, label, title } or null on any failure.
    classifyLogoFile(filepath, inputConfig) {
        const key = [filepath, (inputConfig.charsetModes || []).join(','),
            inputConfig.charsetRows || 25, inputConfig.charsetMaxChars || 256].join('|');
        if (!this.logoTypeCache.has(key)) {
            const promise = this.loadDefaultFile(filepath)
                .then(data => this.classifyLogoData(data, inputConfig))
                .catch(() => null);
            this.logoTypeCache.set(key, promise);
        }
        return this.logoTypeCache.get(key);
    }

    // Classify raw PNG bytes with the same analysis the export runs: the
    // badge shows exactly what this input would convert the image to.
    async classifyLogoData(pngData, inputConfig) {
        if (typeof CharsetLabCore === 'undefined') {
            await window.loadScript('charsetlab-core.js');
        }
        if (typeof C64Fonts === 'undefined') {
            await window.loadScript('c64fonts.js');   // enables the PET badge for ROM-glyph art
        }
        const imageData = await this.pngDataToImageData(pngData);
        let report;
        try {
            // shift:false skips the ±7px alignment search (the dominant cost -
            // ~450ms vs ~38ms per image), which a fitting image doesn't need: the
            // search refines alignment and char count, not the mode class the
            // badge shows.
            const opts = { modes: inputConfig.charsetModes, rowLimit: inputConfig.charsetRows };
            report = CharsetLabCore.analyse(imageData.data, imageData.width, imageData.height,
                Object.assign({ shift: false }, opts));
            // Artwork that isn't on the character grid - anything drawn outside a
            // C64 tool - only fits once that search has run, and the export always
            // runs it. Pay the cost rather than calling such an image unusable.
            if (!report.chosen) {
                report = CharsetLabCore.analyse(imageData.data, imageData.width, imageData.height, opts);
            }
        } catch (err) {
            return { ok: false, label: '?', title: err.message || String(err) };
        }
        const LABELS = {
            'PETSCII': 'PET', 'Hires': 'HI CHAR', 'Multicolour': 'MC CHAR', 'Mixed': 'MIXED',
            'ECM': 'ECM', 'Hires Bitmap': 'HI BMP', 'Multicolour Bitmap': 'MC BMP'
        };
        let r = report.chosen;
        if (!r) {
            return { ok: false, label: '✗', title: 'Not usable here: ' + CharsetLabCore.failureReason(report) };
        }
        const maxChars = inputConfig.charsetMaxChars || 256;
        if (!r.isBitmap && r.charCount > maxChars) {
            // Mirror the exporter: an over-budget charset result falls back to
            // a fitted bitmap attempt when this input's modes allow one.
            const bmp = (report.attempts || []).find(a => a.ok && a.isBitmap);
            if (bmp) r = bmp;
            else return { ok: false, label: '✗ ' + (LABELS[r.label] || r.label), title: `Needs ${r.charCount} unique characters; this player only has room for ${maxChars}.` };
        }
        return {
            ok: true,
            label: LABELS[r.label] || r.label,
            title: r.label + (r.charCount != null ? ` — ${r.charCount} chars` : '') + (r.isBitmap ? ' bitmap' : ''),
            // The fitted result itself, so the preview can draw what the C64
            // will actually show rather than the PNG that went in.
            result: r,
        };
    }

    async pngDataToImageData(pngData) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([pngData], { type: 'image/png' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0);
                    resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
                } catch (err) { reject(err); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode PNG')); };
            img.src = url;
        });
    }

    // Update (or hide) the type badge in the corner of an input's preview.
    // `classified` is a promise from classifyLogoFile/classifyLogoData.
    async updatePreviewBadge(config, classified) {
        if (!this.isLogoInput(config)) return;
        const wrapper = document.querySelector(`[data-input-id="${config.id}"]`);
        if (!wrapper) return;
        const badgeEl = wrapper.querySelector('.logo-type-badge');
        if (!badgeEl) return;
        badgeEl.classList.remove('show', 'unusable');
        const info = await classified.catch(() => null);
        if (!info) return;
        badgeEl.textContent = info.label;
        badgeEl.title = info.title;
        badgeEl.classList.add('show');
        if (!info.ok) badgeEl.classList.add('unusable');
        // The badge alone is easy to miss, and an image the converter rejects
        // stops the export dead - spell the reason out next to the preview.
        this.setPreviewNote(config, 'warn', info.ok ? ''
            : `This image can't be used here: ${info.title.replace(/^Not usable here:\s*/i, '')}`);
        this.renderC64Preview(config, wrapper, info);
    }

    /**
     * Draw the conversion, so what a logo will look like on the machine - the
     * colour clash, the lost detail - is visible before the export rather than
     * after a round trip through an emulator. The preview otherwise shows the
     * source PNG, which is not what the C64 gets.
     */
    renderC64Preview(config, wrapper, info) {
        const canvas = wrapper.querySelector('.image-preview-c64');
        const toggle = wrapper.querySelector('.preview-c64-toggle');
        const img = wrapper.querySelector('.image-preview-img');
        if (!canvas || !toggle || !img) return;

        const show = (on) => {
            canvas.hidden = !on;
            img.style.visibility = on ? 'hidden' : '';
            toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
            toggle.innerHTML = on
                ? '<i class="fas fa-image"></i> Show the original'
                : '<i class="fas fa-tv"></i> Show it as the C64 will';
        };

        let drawn = null;
        try {
            drawn = info.ok && info.result && typeof CharsetLabCore !== 'undefined'
                ? CharsetLabCore.renderResult(info.result) : null;
        } catch (e) {
            drawn = null;   // a preview that cannot be drawn is simply not offered
        }
        if (!drawn) { toggle.hidden = true; show(false); return; }

        canvas.width = drawn.width;
        canvas.height = drawn.height;
        canvas.getContext('2d').putImageData(
            new ImageData(drawn.rgba, drawn.width, drawn.height), 0, 0);
        toggle.hidden = false;
        show(false);
        if (!toggle.dataset.wired) {
            toggle.dataset.wired = '1';
            toggle.addEventListener('click', () => show(canvas.hidden));
        }
    }

    // ─── Logo fitting (auto-placement + the Adjust crop tool) ───

    async ensureLogoFit() {
        if (typeof LogoFit === 'undefined') await window.loadScript('logo-fit.js');
    }

    // Decode any image the browser can read into its raw pixels. Non-PNG
    // uploads (JPEG, GIF, WebP) decode here too, so they end up as a converted
    // PNG instead of failing further down.
    async decodeImage(file) {
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('Could not read this image file'));
                im.src = url;
            });
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            return { width: canvas.width, height: canvas.height, rgba };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // Work out where `file` should sit in this input's logo band and remember
    // it (the Adjust tool re-renders from this state). Returns the PNG the
    // exporter should use: the original when it's already a size the converter
    // accepts with its artwork inside the band, otherwise a 320x200 render with
    // the artwork placed on the character grid.
    async prepareLogoImage(config, file) {
        await this.ensureLogoFit();
        const src = await this.decodeImage(file);
        // Sizes the C64 side isn't defined for are refused rather than cropped
        // or resampled into something the artist didn't draw.
        // An odd size is not a refusal any more. Throwing here happened BEFORE any
        // state was stored, so the Adjust tool - which has a size slider and a
        // position control and would have solved it in seconds - was unreachable
        // for exactly the images that needed it. plan() marks these needsFit, so
        // the user places them instead.
        const oddSize = LogoFit.sizeError(src.width, src.height);
        const band = LogoFit.bandHeight(config.charsetRows);
        // artRows: how many of the player's charsetRows the ARTWORK may use.
        // RaistlinBarsWithLogo converts 11 rows but keeps the last clear: the
        // raster split to the spectrum half lands inside it, and artwork there
        // shows up as a smear across the seam. The conversion still covers the
        // full band, so the reserved row exports as background.
        const artBand = LogoFit.bandHeight(config.artRows != null ? config.artRows : config.charsetRows);
        const place = LogoFit.plan(src.rgba, src.width, src.height, { band, artBand });
        this.logoFit.set(config.id, {
            src, band, place, original: file,
            // What the "Auto-place" button offers, which for an image that
            // needed no fitting is not where it currently sits.
            auto: Object.assign({}, place, place.auto)
        });
        // A logo that needs no placing still has to go through render() when the
        // player reserves rows its artwork reaches into - that pass is what
        // clears them.
        if (!place.needsFit && !place.clipped) return { file, fitted: false, place };
        if (oddSize) place.sizeNote = oddSize;
        return { file: await this.renderLogoFile(config), fitted: true, place };
    }

    // Render the remembered placement to a PNG File.
    async renderLogoFile(config) {
        const state = this.logoFit.get(config.id);
        const canvas = LogoFit.render(state.src.rgba, state.place);
        const blob = await LogoFit.toPngBlob(canvas);
        const base = ((state.original && state.original.name) || 'logo').replace(/\.[^.]+$/, '');
        return new File([blob], base + '.png', { type: 'image/png' });
    }

    // Put the file the exporter should read into the hidden <input type="file">.
    // Dropping onto the preview never goes through the input, so without this
    // the export silently fell back to the visualizer's default image.
    setInputFile(config, file) {
        const input = document.getElementById(config.id);
        if (!input || typeof DataTransfer === 'undefined') return;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
    }

    // The message strip under a logo preview: 'fit' says what was done to the
    // image, 'warn' says why it can't be converted.
    setPreviewNote(config, kind, text) {
        const wrapper = document.querySelector(`[data-input-id="${config.id}"]`);
        const el = wrapper && wrapper.querySelector(`.preview-note.${kind}`);
        if (!el) return;
        el.textContent = text || '';
        el.hidden = !text;
    }

    updateLogoNotice(config, fit) {
        if (!fit || !fit.fitted) {
            this.setPreviewNote(config, 'fit', '');
            return;
        }
        // An unusual size is worth naming: the placement is a guess the user
        // should look at, not a result they can take on trust.
        const odd = fit.place && fit.place.sizeNote ? `${fit.place.sizeNote} ` : '';
        this.setPreviewNote(config, 'fit',
            `${odd}Auto-placed: ${LogoFit.describe(fit.place)}. Use "Adjust logo" to move or recolour it.`);
    }

    // The placement state for an input, loading the current selection (or the
    // visualizer default) the first time the Adjust tool is opened on it.
    async ensureLogoState(config) {
        if (this.logoFit.has(config.id)) return this.logoFit.get(config.id);
        const input = document.getElementById(config.id);
        let file = input && input.files && input.files[0];
        if (!file && config.default) {
            const data = await this.loadDefaultFile(config.default);
            file = new File([new Blob([data], { type: 'image/png' })],
                config.default.split('/').pop(), { type: 'image/png' });
        }
        if (!file) return null;
        await this.prepareLogoImage(config, file);
        return this.logoFit.get(config.id);
    }

    async openLogoAdjust(config, opener = null) {
        const wrapper = document.querySelector(`[data-input-id="${config.id}"]`);
        const loading = wrapper && wrapper.querySelector('.image-preview-loading');
        let state;
        try {
            if (loading) loading.style.display = 'flex';
            state = await this.ensureLogoState(config);
            if (typeof LogoFitModal === 'undefined') await window.loadScript('logo-fit-modal.js');
            // The surround swatches are the 16 C64 colours out of the palette
            // the converter matches against.
            if (typeof CharsetLabCore === 'undefined') await window.loadScript('charsetlab-core.js');
        } catch (error) {
            this.showError(wrapper, `Could not open the logo adjuster: ${error.message}`);
            return;
        } finally {
            if (loading) loading.style.display = 'none';
        }
        if (!state) return;
        if (!this.logoFitModal) this.logoFitModal = new LogoFitModal();
        this.logoFitModal.open({
            src: state.src,
            place: state.place,
            autoPlace: state.auto,
            title: `Adjust ${(config.label || 'logo').toLowerCase()}`,
            returnFocusTo: opener || document.activeElement,
            onApply: place => this.applyLogoPlace(config, place)
        });
    }

    // Re-render the logo with the placement the crop tool returned, then push
    // it through the same steps a fresh upload takes.
    async applyLogoPlace(config, place) {
        const state = this.logoFit.get(config.id);
        if (!state) return;
        state.place = Object.assign({}, state.place, place);
        const wrapper = document.querySelector(`[data-input-id="${config.id}"]`);
        const img = wrapper && wrapper.querySelector('.image-preview-img');
        const loading = wrapper && wrapper.querySelector('.image-preview-loading');
        try {
            if (loading) loading.style.display = 'flex';
            const file = await this.renderLogoFile(config);
            this.setInputFile(config, file);
            // A hand-placed logo is no longer the gallery image it came from.
            const input = document.getElementById(config.id);
            if (input) {
                delete input.dataset.gallerySelected;
                delete input.dataset.galleryFile;
            }
            const data = await this.readFileAsArrayBuffer(file);
            const preview = await this.createPreviewFromPNGData(data);
            if (img) img.src = preview.dataUrl;
            this.setPreviewNote(config, 'fit', `Placed by hand: ${LogoFit.describe(state.place)}.`);
            this.updatePreviewBadge(config, this.classifyLogoData(data, config));
        } catch (error) {
            this.showError(wrapper, `Could not apply the logo placement: ${error.message}`);
        } finally {
            if (loading) loading.style.display = 'none';
        }
    }

    initGalleryModal() {
        if (!this.galleryModal) {
            this.galleryModal = new GalleryModal();
            this.galleryModal.init();
        }
        return this.galleryModal;
    }

    initSelectorModal() {
        if (!this.selectorModal) {
            this.selectorModal = new ImageSelectorModal();
            this.selectorModal.init();
        }
        return this.selectorModal;
    }

    createImagePreview(config) {
        const container = document.createElement('div');
        container.className = 'image-preview-container';

        const hasGallery = config.gallery && config.gallery.length > 0;
        const isLogo = this.isLogoInput(config);
        // A fresh preview means a fresh input: any placement remembered for this
        // id belongs to the visualizer that was on screen before, whose logo
        // band may be a different height.
        this.logoFit.delete(config.id);

        container.innerHTML = `
            <div class="image-preview-wrapper" data-input-id="${config.id}">
                <div class="image-preview-drop-zone">
                    <div class="image-preview-frame">
                        <img class="image-preview-img"
                             src=""
                             alt="${config.label} preview"
                             width="320"
                             height="200">
                        <div class="image-preview-overlay">
                            <div class="preview-overlay-content">
                                <i class="fas fa-upload"></i>
                                <div class="preview-click-hint">Drag &amp; drop, or click</div>
                            </div>
                        </div>
                        <div class="image-preview-loading">
                            <div class="preview-spinner"></div>
                            <div>Loading...</div>
                        </div>
                        <canvas class="image-preview-c64" width="320" height="200" hidden
                                aria-label="${config.label} as the C64 will show it"></canvas>
                        <div class="logo-type-badge"></div>
                    </div>
                </div>
                ${isLogo ? '<button type="button" class="file-button preview-c64-toggle" '
                    + 'data-act="c64" aria-pressed="false" hidden>'
                    + '<i class="fas fa-tv"></i> Show it as the C64 will</button>' : ''}
                <div class="image-preview-hint"><i class="fas fa-hand-pointer"></i> Drag &amp; drop an image here, or:</div>
                <div class="image-preview-actions">
                    <button type="button" class="file-button" data-act="browse"><i class="fas fa-folder-open"></i> Browse Files</button>
                    ${isLogo ? '<button type="button" class="file-button" data-act="adjust"><i class="fas fa-crop-alt"></i> Adjust logo</button>' : ''}
                </div>
                ${isLogo ? `<div class="image-preview-notice">
                    <div class="preview-note fit" hidden></div>
                    <div class="preview-note warn" hidden></div>
                </div>` : ''}
                ${hasGallery ? '<div class="image-inline-gallery gallery-grid-container"></div>' : ''}
            </div>
            <input type="file"
                   id="${config.id}"
                   accept="${config.accept}"
                   style="display: none;">
        `;

        const wrapper = container.querySelector('.image-preview-wrapper');
        const fileInput = container.querySelector('input[type="file"]');
        const previewFrame = wrapper.querySelector('.image-preview-frame');

        // Clicking the preview (or Browse) opens the native file picker; the
        // gallery is inline below, so there's no popup selector anymore.
        previewFrame.addEventListener('click', () => fileInput.click());
        wrapper.querySelector('[data-act="browse"]').addEventListener('click', () => fileInput.click());
        if (isLogo) {
            // Look the button up again on close rather than passing the node:
            // the Studio's panel-click refresh moves focus before this handler
            // runs, and the preview is rebuilt while the dialog is open.
            wrapper.querySelector('[data-act="adjust"]').addEventListener('click',
                () => this.openLogoAdjust(config,
                    () => document.querySelector(`[data-input-id="${config.id}"] [data-act="adjust"]`)));
        }

        // Inline gallery grid (matches the font picker's grid on the tab).
        if (hasGallery) {
            const gridEl = wrapper.querySelector('.image-inline-gallery');
            this.populateInlineGallery(gridEl, config, container);
        }

        // Drop an image straight onto the preview frame.
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
            previewFrame.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
        ['dragenter', 'dragover'].forEach(ev =>
            previewFrame.addEventListener(ev, () => previewFrame.classList.add('drag-active')));
        ['dragleave', 'drop'].forEach(ev =>
            previewFrame.addEventListener(ev, () => previewFrame.classList.remove('drag-active')));
        previewFrame.addEventListener('drop', e => {
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            if (!f) return;
            this.handleFileChange({ target: { files: [f] } }, config);
        });

        fileInput.addEventListener('change', (e) => {
            this.handleFileChange(e, config);
        });

        return container;
    }

    // Build the inline gallery grid on the tab (same cards/badges as the old
    // popup gallery, minus the modal). Clicking a card loads that image.
    populateInlineGallery(gridEl, config, container) {
        if (!gridEl) return;
        const gallery = config.gallery || [];
        gridEl.innerHTML = '';
        gridEl.setAttribute('role', 'radiogroup');
        if (config.label) gridEl.setAttribute('aria-label', config.label);

        gallery.forEach((item) => {
            const card = document.createElement('div');
            card.className = 'gallery-item-card';
            card.dataset.file = item.file;
            card.dataset.name = item.name;
            if (config.default && item.file === config.default) card.classList.add('selected');

            // DOM APIs (not innerHTML): name/file come from gallery JSON.
            const preview = document.createElement('div');
            preview.className = 'gallery-item-preview';
            const img = document.createElement('img');
            img.src = item.file;
            img.alt = item.name;
            img.loading = 'lazy';
            preview.appendChild(img);

            const info = document.createElement('div');
            info.className = 'gallery-item-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'gallery-item-name';
            nameEl.textContent = item.name;
            info.appendChild(nameEl);

            const badge = document.createElement('div');
            badge.className = 'gallery-item-selected-badge';
            badge.innerHTML = '<i class="fas fa-check"></i> Selected';

            card.append(preview, info, badge);
            this._makeGalleryCardRadio(gridEl, card, card.classList.contains('selected'),
                () => this.loadGalleryImage(container, config, item.file, item.name));
            gridEl.appendChild(card);
        });

        this.annotateInlineLogoTypes(gridEl, gallery, config);
    }

    // Gallery grids are radio groups: one tab stop for the grid, arrows to move
    // between images, Enter/Space to choose. They were <div>s with a click
    // handler, so picking a supplied logo was impossible without a mouse.
    _makeGalleryCardRadio(gridEl, card, isSelected, choose) {
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        card.setAttribute('aria-label', card.dataset.name || 'image');
        // Nothing selected yet: the first card carries the group's tab stop, or
        // the whole grid would be unreachable.
        const isFirst = !gridEl.querySelector('.gallery-item-card');
        const hasSelection = !!gridEl.querySelector('.gallery-item-card.selected');
        card.tabIndex = (isSelected || (isFirst && !hasSelection)) ? 0 : -1;
        const select = () => {
            for (const c of gridEl.querySelectorAll('.gallery-item-card')) {
                const on = c === card;
                c.classList.toggle('selected', on);
                c.setAttribute('aria-checked', on ? 'true' : 'false');
                c.tabIndex = on ? 0 : -1;
            }
            choose();
        };
        card.addEventListener('click', select);
        card.addEventListener('keydown', (e) => {
            const cards = [...gridEl.querySelectorAll('.gallery-item-card')];
            const i = cards.indexOf(card);
            let next = null;
            switch (e.key) {
                case 'ArrowRight': case 'ArrowDown': next = cards[(i + 1) % cards.length]; break;
                case 'ArrowLeft': case 'ArrowUp': next = cards[(i - 1 + cards.length) % cards.length]; break;
                case 'Home': next = cards[0]; break;
                case 'End': next = cards[cards.length - 1]; break;
                case ' ': case 'Enter': e.preventDefault(); select(); return;
                default: return;
            }
            e.preventDefault();
            if (next) { next.tabIndex = 0; next.focus(); }
        });
    }

    // Badge each inline gallery card with its detected logo type (scoped to
    // this grid). Stops early if the grid is torn down by a re-render.
    async annotateInlineLogoTypes(gridEl, gallery, config) {
        if (!this.isLogoInput(config)) return;
        for (const item of gallery) {
            await new Promise(r => setTimeout(r, 0));
            if (!gridEl.isConnected) return;
            const info = await this.classifyLogoFile(item.file, config);
            if (!gridEl.isConnected || !info) continue;
            const card = gridEl.querySelector(`.gallery-item-card[data-file="${CSS.escape(item.file)}"]`);
            if (!card) continue;
            const preview = card.querySelector('.gallery-item-preview');
            if (!preview || preview.querySelector('.gallery-item-type-badge')) continue;
            const badge = document.createElement('div');
            badge.className = 'gallery-item-type-badge' + (info.ok ? '' : ' unusable');
            badge.textContent = info.label;
            badge.title = info.title;
            preview.appendChild(badge);
            if (!info.ok) {
                card.classList.add('gallery-item-unusable');
                card.title = info.title;
                // A tooltip is the whole explanation for a dimmed card, and a
                // touchscreen has no way to ask for one. Say it on the card.
                if (!card.querySelector('.gallery-item-reason')) {
                    const why = document.createElement('div');
                    why.className = 'gallery-item-reason';
                    why.textContent = info.title;
                    card.appendChild(why);
                }
            }
        }
    }

    showError(container, message) {
        console.error(message);
        if (window.showError) {
            window.showError(message, { duration: 4000 });
        }
    }

    async loadDefaultImage(config) {
        const wrapper = document.querySelector(`[data-input-id="${config.id}"]`);
        if (!wrapper) return;

        const img = wrapper.querySelector('.image-preview-img');
        const loadingDiv = wrapper.querySelector('.image-preview-loading');

        try {
            loadingDiv.style.display = 'flex';

            if (config.default) {
                if (this.previewCache.has(config.default)) {
                    const cached = this.previewCache.get(config.default);
                    img.src = cached.dataUrl;
                    loadingDiv.style.display = 'none';
                    if (this.isLogoInput(config)) this.updatePreviewBadge(config, this.classifyLogoFile(config.default, config));
                    return;
                }

                const fileData = await this.loadDefaultFile(config.default);
                if (this.isLogoInput(config)) this.updatePreviewBadge(config, this.classifyLogoFile(config.default, config));

                if (config.default.toLowerCase().endsWith('.png') && this.isPNGFile(fileData)) {
                    const preview = await this.createPreviewFromPNGData(fileData);
                    this.previewCache.set(config.default, preview);
                    img.src = preview.dataUrl;
                } else {
                    const preview = await this.createPreviewFromData(fileData, config.default);
                    this.previewCache.set(config.default, preview);
                    img.src = preview.dataUrl;
                }
            }
        } catch (error) {
            console.error('Error loading default image:', error);
            this.showErrorPlaceholder(img);
        } finally {
            loadingDiv.style.display = 'none';
        }
    }

    async loadGalleryImage(container, config, filepath, name) {
        const wrapper = container.querySelector(`[data-input-id="${config.id}"]`);
        if (!wrapper) return;

        const img = wrapper.querySelector('.image-preview-img');
        const loadingDiv = wrapper.querySelector('.image-preview-loading');

        try {
            loadingDiv.style.display = 'flex';
            if (this.isLogoInput(config)) this.updatePreviewBadge(config, this.classifyLogoFile(filepath, config));

            const response = await fetch(filepath);
            if (!response.ok) {
                throw new Error(`Failed to load gallery image: ${filepath}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const fileData = new Uint8Array(arrayBuffer);

            if (filepath.toLowerCase().endsWith('.png') && this.isPNGFile(fileData)) {
                const blob = new Blob([fileData], { type: 'image/png' });
                let file = new File([blob], name + '.png', { type: 'image/png' });

                // Gallery logos are screen-sized already, so this normally only
                // records the placement the Adjust tool starts from; a gallery
                // whose artwork falls outside this player's rows gets moved up.
                let fit = null;
                if (this.isLogoInput(config)) {
                    try {
                        fit = await this.prepareLogoImage(config, file);
                        file = fit.file;
                    } catch (fitError) {
                        console.warn('Logo fit skipped:', fitError);
                    }
                    this.updateLogoNotice(config, fit);
                }

                const preview = await this.createPreviewFromPNGData(
                    fit && fit.fitted ? await this.readFileAsArrayBuffer(file) : fileData);
                img.src = preview.dataUrl;

                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                const fileInput = container.querySelector(`#${config.id}`);
                if (fileInput) {
                    fileInput.files = dataTransfer.files;
                    fileInput.dataset.gallerySelected = 'true';
                    fileInput.dataset.galleryFile = filepath;
                }
            } else {
                const preview = await this.createPreviewFromData(fileData, name);
                img.src = preview.dataUrl;

                const blob = new Blob([fileData], { type: 'image/png' });
                const file = new File([blob], name, { type: 'image/png' });

                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                const fileInput = container.querySelector(`#${config.id}`);
                if (fileInput) {
                    fileInput.files = dataTransfer.files;
                    fileInput.dataset.gallerySelected = 'true';
                    fileInput.dataset.galleryFile = filepath;
                }
            }
        } catch (error) {
            console.error('Error loading gallery image:', error);
            this.showErrorPlaceholder(img);
        } finally {
            loadingDiv.style.display = 'none';
        }
    }

    async handleFileChange(e, config) {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        const file = files[0];
        const wrapper = document.querySelector(`[data-input-id="${config.id}"]`);
        if (!wrapper) return;

        const img = wrapper.querySelector('.image-preview-img');
        const loadingDiv = wrapper.querySelector('.image-preview-loading');

        try {
            loadingDiv.style.display = 'flex';

            // A logo whose artwork sits outside the rows this visualizer shows
            // is placed onto the screen first (logo-fit.js); one that isn't a
            // size the C64 side is defined for is refused outright.
            let useFile = file, fit = null;
            if (this.isLogoInput(config)) {
                try {
                    fit = await this.prepareLogoImage(config, file);
                    useFile = fit.file;
                } catch (fitError) {
                    // Undecodable image - carry on with the original and let the
                    // classifier report what's wrong with it.
                    console.warn('Logo fit skipped:', fitError);
                }
                this.updateLogoNotice(config, fit);
            }

            // The exporter reads the file from this input, and a drag-and-drop
            // never touches it. Only a gallery pick comes through
            // loadGalleryImage, so anything arriving here replaces one.
            const input = document.getElementById(config.id);
            if (input) {
                delete input.dataset.gallerySelected;
                delete input.dataset.galleryFile;
            }
            this.setInputFile(config, useFile);

            const fileData = await this.readFileAsArrayBuffer(useFile);
            if (this.isLogoInput(config)) this.updatePreviewBadge(config, this.classifyLogoData(fileData, config));

            if (useFile.name.toLowerCase().endsWith('.png') && this.isPNGFile(fileData)) {
                const preview = await this.createPreviewFromPNGData(fileData);
                img.src = preview.dataUrl;
            } else {
                const preview = await this.createPreviewFromData(fileData, useFile.name);
                img.src = preview.dataUrl;
            }

            if (config.onChange) {
                config.onChange(useFile);
            }
        } catch (error) {
            console.error('Error loading file:', error);
            this.showErrorPlaceholder(img);
        } finally {
            loadingDiv.style.display = 'none';
        }
    }

    readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(new Uint8Array(e.target.result));
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    async loadDefaultFile(path) {
        const response = await fetch(path);
        if (!response.ok) {
            throw new Error(`Failed to load default file: ${path}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    }

    isPNGFile(data) {
        return data.length >= 8 &&
               data[0] === 0x89 && data[1] === 0x50 &&
               data[2] === 0x4E && data[3] === 0x47 &&
               data[4] === 0x0D && data[5] === 0x0A &&
               data[6] === 0x1A && data[7] === 0x0A;
    }

    async createPreviewFromPNGData(pngData) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([pngData], { type: 'image/png' });
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const dataUrl = e.target.result;
                resolve({
                    dataUrl: dataUrl,
                    sizeText: `${Math.round(pngData.length / 1024)}KB`
                });
            };
            
            reader.onerror = () => {
                reject(new Error('Failed to load PNG'));
            };
            
            reader.readAsDataURL(blob);
        });
    }

    async createPreviewFromData(data, filename) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([data], { type: 'application/octet-stream' });
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const dataUrl = e.target.result;
                resolve({
                    dataUrl: dataUrl,
                    sizeText: `${Math.round(data.length / 1024)}KB`
                });
            };
            
            reader.onerror = () => {
                reject(new Error('Failed to load image'));
            };
            
            reader.readAsDataURL(blob);
        });
    }

    showErrorPlaceholder(img) {
        img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzMzMyIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmaWxsPSIjNjY2IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIxNCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkVycm9yIGxvYWRpbmcgaW1hZ2U8L3RleHQ+PC9zdmc+';
    }
}
