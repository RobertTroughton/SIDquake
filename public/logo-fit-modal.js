// logo-fit-modal.js - the "Adjust logo" crop tool.
//
// Shows the logo exactly as it will land on the C64 screen: the top band is
// what the visualizer displays, everything below it is dimmed. The image can
// be dragged (or nudged with the arrow keys) around that screen and the colour
// filling the space around it can be changed. Movement always snaps to the
// 8x8 character grid - see logo-fit.js for why.
//
// Opened from the logo preview in image-preview-manager.js.
class LogoFitModal {
    constructor() {
        this.modal = null;
        this.canvas = null;
        this.place = null;
        this.source = null;
        this.autoPlace = null;
        this.autoBackground = null;
        this.onApply = null;
        this.drag = null;
    }

    init() {
        if (this.modal) return;

        const html = `
            <div class="logo-fit-modal" id="logoFitModal">
                <div class="logo-fit-content" role="dialog" aria-modal="true" aria-label="Adjust logo">
                    <button class="logo-fit-close" id="logoFitClose" aria-label="Close"><i class="fas fa-times"></i></button>
                    <h3 class="logo-fit-title">Adjust logo</h3>
                    <div class="logo-fit-hint">Drag the image to move it. It snaps to the C64's 8x8 character grid; the dimmed area isn't shown by this visualizer.</div>
                    <div class="logo-fit-stage">
                        <canvas class="logo-fit-canvas" id="logoFitCanvas" width="320" height="200" tabindex="0"></canvas>
                        <div class="logo-fit-band-edge" id="logoFitBandEdge"></div>
                        <div class="logo-fit-outside" id="logoFitOutside"></div>
                    </div>
                    <div class="logo-fit-nudge">
                        <button type="button" class="file-button" data-nudge="left" title="Move left"><i class="fas fa-arrow-left"></i></button>
                        <button type="button" class="file-button" data-nudge="up" title="Move up"><i class="fas fa-arrow-up"></i></button>
                        <button type="button" class="file-button" data-nudge="down" title="Move down"><i class="fas fa-arrow-down"></i></button>
                        <button type="button" class="file-button" data-nudge="right" title="Move right"><i class="fas fa-arrow-right"></i></button>
                        <button type="button" class="file-button" id="logoFitAuto"><i class="fas fa-wand-magic-sparkles"></i> Auto-place</button>
                    </div>
                    <div class="logo-fit-scale" id="logoFitScaleRow">
                        <label for="logoFitScale">Size</label>
                        <input type="range" id="logoFitScale" class="range-slider" min="10" max="400" step="1">
                        <span class="logo-fit-scale-value" id="logoFitScaleValue">100%</span>
                    </div>
                    <div class="logo-fit-colours">
                        <label>Surround colour</label>
                        <div class="logo-fit-swatches" id="logoFitSwatches"></div>
                    </div>
                    <div class="logo-fit-actions">
                        <button type="button" class="file-button" id="logoFitCancel">Cancel</button>
                        <button type="button" class="file-button primary" id="logoFitApply"><i class="fas fa-check"></i> Use this</button>
                    </div>
                </div>
            </div>
        `;
        const temp = document.createElement('div');
        temp.innerHTML = html;
        document.body.appendChild(temp.firstElementChild);

        this.modal = document.getElementById('logoFitModal');
        this.canvas = document.getElementById('logoFitCanvas');
        this.scaleInput = document.getElementById('logoFitScale');

        this.modal.addEventListener('click', e => { if (e.target === this.modal) this.close(); });
        document.getElementById('logoFitClose').addEventListener('click', () => this.close());
        document.getElementById('logoFitCancel').addEventListener('click', () => this.close());
        document.getElementById('logoFitApply').addEventListener('click', () => this.apply());
        document.getElementById('logoFitAuto').addEventListener('click', () => {
            this.place = Object.assign({}, this.place, this.autoPlace, { background: this.autoBackground });
            this.syncControls();
            this.redraw();
        });

        this.modal.querySelectorAll('[data-nudge]').forEach(btn => {
            btn.addEventListener('click', () => this.nudge(btn.dataset.nudge));
        });

        this.scaleInput.addEventListener('input', () => {
            // Keep the artwork centred on the same point as it shrinks/grows,
            // then re-snap to the character grid.
            const next = Math.max(0.1, this.scaleInput.value / 100);
            const cx = this.place.dx + this.place.width * this.place.scale / 2;
            const cy = this.place.dy + this.place.height * this.place.scale / 2;
            this.place.scale = next;
            this.place.dx = LogoFit.snap8(cx - this.place.width * next / 2);
            this.place.dy = LogoFit.snap8(cy - this.place.height * next / 2);
            this.syncControls();
            this.redraw();
        });

        document.addEventListener('keydown', e => {
            if (!this.modal.classList.contains('visible')) return;
            if (e.key === 'Escape') { this.close(); return; }
            const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
            if (dirs[e.key]) { e.preventDefault(); this.nudge(dirs[e.key]); }
        });

        this.attachDragHandlers();
    }

    attachDragHandlers() {
        // Pointer movement is in CSS pixels; the canvas is drawn at 320x200.
        const toScreenPx = () => {
            const rect = this.canvas.getBoundingClientRect();
            return { sx: LogoFit.W / rect.width, sy: LogoFit.H / rect.height };
        };

        this.canvas.addEventListener('pointerdown', e => {
            this.canvas.setPointerCapture(e.pointerId);
            this.drag = { x: e.clientX, y: e.clientY, dx: this.place.dx, dy: this.place.dy };
            this.canvas.classList.add('dragging');
        });
        this.canvas.addEventListener('pointermove', e => {
            if (!this.drag) return;
            const s = toScreenPx();
            this.place.dx = this.drag.dx + LogoFit.snap8((e.clientX - this.drag.x) * s.sx);
            this.place.dy = this.drag.dy + LogoFit.snap8((e.clientY - this.drag.y) * s.sy);
            this.redraw();
        });
        ['pointerup', 'pointercancel'].forEach(ev => this.canvas.addEventListener(ev, () => {
            this.drag = null;
            this.canvas.classList.remove('dragging');
        }));
    }

    nudge(dir) {
        if (dir === 'left') this.place.dx -= 8;
        else if (dir === 'right') this.place.dx += 8;
        else if (dir === 'up') this.place.dy -= 8;
        else if (dir === 'down') this.place.dy += 8;
        this.redraw();
    }

    // The 16 C64 colours (Pepto), plus the colour picked from the image edges.
    buildSwatches() {
        const holder = document.getElementById('logoFitSwatches');
        holder.innerHTML = '';
        const palette = (typeof CharsetLabCore !== 'undefined' && CharsetLabCore.PALETTES[0].colors) || [];
        const names = (typeof CharsetLabCore !== 'undefined' && CharsetLabCore.COLOUR_NAMES) || [];
        const entries = [{ rgb: this.autoBackground, label: 'From image', auto: true }];
        palette.forEach((c, i) => entries.push({
            rgb: { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 },
            label: names[i] || ('Colour ' + i)
        }));
        entries.forEach(entry => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'logo-fit-swatch' + (entry.auto ? ' auto' : '');
            btn.style.background = LogoFit.cssColour(entry.rgb);
            btn.title = entry.label;
            btn.dataset.rgb = [entry.rgb.r, entry.rgb.g, entry.rgb.b].join(',');
            btn.addEventListener('click', () => {
                this.place.background = entry.rgb;
                this.syncControls();
                this.redraw();
            });
            holder.appendChild(btn);
        });
    }

    // Reflect the current place in the swatch selection and the size slider.
    syncControls() {
        const key = [this.place.background.r, this.place.background.g, this.place.background.b].join(',');
        document.getElementById('logoFitSwatches').querySelectorAll('.logo-fit-swatch').forEach(sw => {
            sw.classList.toggle('selected', sw.dataset.rgb === key);
        });
        const pct = Math.round(this.place.scale * 100);
        this.scaleInput.value = pct;
        document.getElementById('logoFitScaleValue').textContent = pct + '%';
    }

    redraw() {
        const ctx = this.canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = LogoFit.cssColour(this.place.background);
        ctx.fillRect(0, 0, LogoFit.W, LogoFit.H);
        ctx.drawImage(this.source, this.place.dx, this.place.dy,
            Math.max(1, Math.round(this.place.width * this.place.scale)),
            Math.max(1, Math.round(this.place.height * this.place.scale)));
    }

    /**
     * @param {object} opts
     *   source     - decoded image (any canvas drawable)
     *   place      - current placement (from LogoFit.plan / a previous adjust)
     *   autoPlace  - the automatic placement, for the "Auto-place" button
     *   title      - modal heading
     *   onApply(place) - called with the accepted placement
     */
    open(opts) {
        this.init();
        this.source = opts.source;
        this.place = Object.assign({}, opts.place);
        this.autoPlace = Object.assign({}, opts.autoPlace || opts.place);
        this.autoBackground = (opts.autoPlace || opts.place).background;
        this.onApply = opts.onApply;

        this.modal.querySelector('.logo-fit-title').textContent = opts.title || 'Adjust logo';

        // Dim everything the visualizer won't show.
        const pct = (this.place.band / LogoFit.H) * 100;
        document.getElementById('logoFitOutside').style.top = pct + '%';
        document.getElementById('logoFitBandEdge').style.top = pct + '%';

        this.buildSwatches();
        this.syncControls();
        this.redraw();

        this.modal.classList.add('visible');
        document.body.style.overflow = 'hidden';
        this.canvas.focus();
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('visible');
        document.body.style.overflow = '';
    }

    apply() {
        const cb = this.onApply;
        this.close();
        if (cb) cb(Object.assign({}, this.place));
    }
}
