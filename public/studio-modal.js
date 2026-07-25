// SIDquake Studio modal: the load -> configure -> export workspace.
//
// The tab rail is DERIVED, never mutated ad hoc: two fixed anchor tabs
// (Song, Visualizer) and Export bracket a dynamic middle whose tabs are a
// pure projection of the selected visualizer's config (deriveGroups). The
// tab set only changes on decisions (SID load, visualizer pick) - typing
// never adds or removes a tab; showWhen-gated controls reveal inline
// inside the tab that owns their trigger instead.
//
// Panels stay mounted (display toggling only): prg-builder.js reads every
// option value straight from the DOM by element id, so inactive tabs must
// keep their controls in the document.

class StudioModal {
    constructor() {
        this.modal = document.getElementById('studioModal');
        this.rail = document.getElementById('studioRail');
        this.panels = document.getElementById('studioPanels');
        this.footSum = document.getElementById('studioFootSum');
        this.manifestEl = document.getElementById('exportManifest');
        this.derivedGroups = [];
        this.activeTab = 'visualizer';
        this.visited = new Set();
        this._refreshQueued = false;

        this.initEvents();
        this.renderRail();
    }

    // uiController is created after this script loads; always look it up live.
    get ui() { return window.uiController; }

    // ---------------------------------------------------------------------
    // Modal chrome
    // ---------------------------------------------------------------------

    get isOpen() { return this.modal.classList.contains('visible'); }

    initEvents() {
        document.getElementById('studioClose').addEventListener('click', () => this.close());

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.close();
        });

        const openBtn = document.getElementById('openStudioBtn');
        if (openBtn) openBtn.addEventListener('click', () => this.open());

        // Escape closes the Studio, and Tab is trapped inside it - but both
        // defer when another modal is layered above (that modal owns the
        // keyboard then; the error modal traps its own Tab/Escape).
        document.addEventListener('keydown', (e) => {
            if (!this.isOpen) return;
            const above = ['hvscModal', 'galleryModal', 'busyOverlay', 'modalOverlay',
                'imageSelectorModal', 'colorPickerModal']
                .some(id => document.getElementById(id)?.classList.contains('visible'));
            if (above) return;
            if (e.key === 'Escape') this.close();
            else if (e.key === 'Tab') this._trapTab(e);
        });

        // Any interaction inside a panel marks its tab visited and refreshes
        // the manifest/footer/rail (statuses + include/skip rows track live).
        for (const evt of ['input', 'change', 'click']) {
            this.panels.addEventListener(evt, () => {
                this.visited.add(this.activeTab);
                this.queueRefresh();
            });
        }
    }

    open() {
        if (this.isOpen) return;
        // Remember what to return focus to when the Studio closes.
        this._previouslyFocused = document.activeElement;
        // The SID player lives on the landing card; carry it into the header
        // so playback control (and the music) follows the user into the Studio.
        const player = document.getElementById('mainPlayerContainer');
        const mount = document.getElementById('studioPlayerMount');
        if (player && mount && player.parentElement !== mount) mount.appendChild(player);
        this.refreshHeader();
        this.modal.classList.add('visible');
        // Move keyboard focus into the Studio so Tab/Escape act on it, not on
        // the (now visually covered but still tabbable) landing page behind.
        const close = document.getElementById('studioClose');
        if (close) close.focus();
        this.queueRefresh();
    }

    close() {
        this.modal.classList.remove('visible');
        const player = document.getElementById('mainPlayerContainer');
        const card = document.getElementById('songTitleSection');
        const openBtn = document.getElementById('openStudioBtn');
        if (player && card && player.parentElement !== card) {
            card.insertBefore(player, openBtn || null);
        }
        // Restore focus to whatever opened the Studio.
        if (this._previouslyFocused && typeof this._previouslyFocused.focus === 'function') {
            this._previouslyFocused.focus();
        }
        this._previouslyFocused = null;
    }

    // Keep Tab focus cycling within the Studio's visible, focusable controls.
    _trapTab(e) {
        const content = this.modal.querySelector('.studio-modal-content');
        if (!content) return;
        const focusable = [...content.querySelectorAll(
            'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            // Skip hidden controls (inactive panels stay mounted but display:none).
            .filter(el => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        // If focus somehow sits outside the Studio, pull it back in.
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

    // A new SID was loaded: clear per-file state and land on the Visualizer
    // tab (the first decision the user makes for the new tune).
    openForNewFile() {
        this.visited.clear();
        this.visited.add('song');
        this.activate('visualizer');
        this.refreshHeader();
        this.open();
        if (this.isOpen) this.queueRefresh();
    }

    resetForNewFile() {
        this.visited.clear();
    }

    refreshHeader() {
        const h = this.ui?.sidHeader;
        document.getElementById('studioSongTitle').textContent = h ? (h.name || 'Untitled') : 'No SID loaded';
        document.getElementById('studioSongAuthor').textContent = h?.author ? `— ${h.author}` : '';
    }

    // ---------------------------------------------------------------------
    // Tabs: fixed anchors + derived middle
    // ---------------------------------------------------------------------

    tabList() {
        // The Method tab (Spectrometer vs Real-time) only appears when the
        // chosen visualizer actually offers a choice of generation method.
        const method = this.ui?.hasMethodChoice?.()
            ? [{ id: 'method', label: 'Method', icon: 'fa-microchip' }] : [];
        return [
            { id: 'song', label: 'Song', icon: 'fa-file-audio' },
            { id: 'visualizer', label: 'Visualizer', icon: 'fa-tv' },
            ...method,
            ...this.derivedGroups.map(g => ({ id: g.id, label: g.label, icon: g.icon })),
            { id: 'export', label: 'Export', icon: 'fa-download' },
        ];
    }

    // Bottom-right Prev/Next rail in the footer - a guided path through the
    // tabs. On the last (Export) tab, Next is replaced by the Generate PRG
    // button, so the wizard leads straight into the export.
    renderNav() {
        const nav = document.getElementById('studioNavBtns');
        if (!nav) return;
        const tabs = this.tabList();
        const i = tabs.findIndex(t => t.id === this.activeTab);
        const prev = i > 0 ? tabs[i - 1] : null;
        const next = i >= 0 && i < tabs.length - 1 ? tabs[i + 1] : null;
        const onExport = this.activeTab === 'export';

        const parts = [];
        if (prev) parts.push(
            `<button type="button" class="studio-nav-btn prev" data-go="${prev.id}">`
            + `<i class="fas fa-chevron-left"></i> Previous</button>`);
        if (next && !onExport) parts.push(
            `<button type="button" class="studio-nav-btn next" data-go="${next.id}">`
            + `Next <i class="fas fa-chevron-right"></i></button>`);
        nav.innerHTML = parts.join('');
        nav.querySelectorAll('[data-go]').forEach(b =>
            b.addEventListener('click', () => this.activate(b.dataset.go)));

        // Generate PRG lives only on the Export tab.
        const exportBtn = document.getElementById('exportPRGButton');
        if (exportBtn) exportBtn.style.display = onExport ? '' : 'none';
    }

    // Group a visualizer config's inputs/options into derived tabs.
    //  - each image input gets its own tab (Logo, Bitmap, ...)
    //  - scrollText + everything gated on it -> Scroller
    //  - bar style / colour effect / palette + their dependents -> Style
    //  - the rest (font, text/background colours) -> Text
    //  - a leftover-only colour group with no font folds into the first
    //    input tab (e.g. the bitmap's border colour belongs with the bitmap)
    deriveGroups(config) {
        const groups = [];
        const inputs = config?.inputs || [];
        const options = config?.options || [];

        const isImage = (inp) => inp.accept && (inp.accept.includes('image/') || inp.accept.includes('.png'));
        for (const inp of inputs) {
            groups.push({
                id: 'input:' + inp.id,
                kind: 'input',
                label: inp.label || 'Image',
                icon: 'fa-image',
                input: inp,
                image: isImage(inp),
                options: [],
            });
        }

        const textareaIds = new Set(options.filter(o => o.type === 'textarea').map(o => o.id));
        const barStyleIds = new Set(['barStyle']);
        const colorIds = new Set(['colorEffect', 'colorFade', 'barColumns', 'waveColors']);
        const dependsOn = (o, ids) => o.showWhen && Object.keys(o.showWhen).some(k => ids.has(k));

        const scroller = [], barStyle = [], color = [], text = [];
        for (const o of options) {
            if (textareaIds.has(o.id) || dependsOn(o, textareaIds)) scroller.push(o);
            else if (barStyleIds.has(o.id) || dependsOn(o, barStyleIds)) barStyle.push(o);
            else if (colorIds.has(o.id) || dependsOn(o, colorIds)) color.push(o);
            else text.push(o);
        }

        const hasFont = text.some(o => o.type === 'fontSelector');
        if (text.length && !hasFont && groups.length) {
            // Colours-only leftovers ride along with the first input tab.
            groups[0].options.push(...text);
            text.length = 0;
        }

        if (text.length) groups.push({ id: 'text', kind: 'options', label: 'Text', icon: 'fa-font', options: text });
        if (barStyle.length) groups.push({ id: 'barstyle', kind: 'options', label: 'Bar Style', icon: 'fa-chart-bar', options: barStyle });
        if (color.length) groups.push({ id: 'color', kind: 'options', label: 'Colour Effect', icon: 'fa-palette', options: color });
        if (scroller.length) groups.push({ id: 'scroller', kind: 'options', label: 'Scroller', icon: 'fa-scroll', options: scroller });

        return groups;
    }

    // Install the derived tabs' panels. Each group arrives with pre-built
    // inner HTML (rendered by UIController with its option renderers).
    setDerivedTabs(groups) {
        for (const el of this.panels.querySelectorAll('.studio-panel[data-derived]')) el.remove();

        const exportPanel = this.panels.querySelector('[data-studio-tab="export"]');
        const prevTabs = this._prevTabIds || [];
        for (const g of groups) {
            const sec = document.createElement('section');
            sec.className = 'studio-panel';
            sec.dataset.studioTab = g.id;
            sec.dataset.derived = '1';
            sec.innerHTML = g.html || '';
            this.panels.insertBefore(sec, exportPanel);
        }
        this.derivedGroups = groups;

        // Rule: if the active tab no longer exists, fall back to Visualizer -
        // that's where the user just acted when the tab set changed.
        if (!this.tabList().some(t => t.id === this.activeTab)) {
            this.activeTab = 'visualizer';
        }

        this.renderRail(prevTabs);
        this.showActivePanel();
        this._prevTabIds = this.tabList().map(t => t.id);
        this.queueRefresh();
    }

    activate(tabId) {
        if (!this.tabList().some(t => t.id === tabId)) return;
        this.activeTab = tabId;
        this.visited.add(tabId);
        this.renderRail();
        this.renderNav();
        this.showActivePanel();
        this.queueRefresh();
    }

    showActivePanel() {
        for (const p of this.panels.querySelectorAll('.studio-panel')) {
            p.classList.toggle('active', p.dataset.studioTab === this.activeTab);
        }
    }

    tabStatus(id) {
        if (id === 'export') return { glyph: '▸', cls: 'st-attn', title: 'Review & generate' };
        if (id === 'scroller') {
            const ta = this.derivedGroups.find(g => g.id === 'scroller')
                ?.options.find(o => o.type === 'textarea');
            const el = ta && document.getElementById(ta.id);
            if (el && !el.value.trim()) return { glyph: '·', cls: 'st-default', title: 'Optional — blank' };
        }
        if (this.visited.has(id)) return { glyph: '✓', cls: 'st-done', title: 'Done' };
        return { glyph: '·', cls: 'st-default', title: 'Using defaults' };
    }

    renderRail(prevTabs) {
        const tabs = this.tabList();
        const prev = prevTabs || tabs.map(t => t.id);
        this.rail.innerHTML = '';
        tabs.forEach((t, i) => {
            if ((i === 2 && tabs.length > 3) || t.id === 'export') {
                const sep = document.createElement('div');
                sep.className = 'studio-rail-sep';
                this.rail.appendChild(sep);
            }
            const st = this.tabStatus(t.id);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'studio-tab'
                + (t.id === this.activeTab ? ' active' : '')
                + (!prev.includes(t.id) ? ' entering' : '');
            btn.innerHTML = `<i class="fas ${t.icon}"></i>${t.label}`
                + `<span class="studio-tab-status ${st.cls}" title="${st.title}">${st.glyph}</span>`;
            btn.addEventListener('click', () => this.activate(t.id));
            this.rail.appendChild(btn);
        });
    }

    // ---------------------------------------------------------------------
    // Manifest + footer (refreshed on any panel interaction)
    // ---------------------------------------------------------------------

    queueRefresh() {
        if (this._refreshQueued) return;
        this._refreshQueued = true;
        requestAnimationFrame(() => {
            this._refreshQueued = false;
            this.renderRail();
            this.renderNav();
            this.renderManifest();
            this.renderFooter();
        });
    }

    // Same evaluation updateConditionalVisibility uses - the manifest must
    // agree with what the panels actually show.
    evalShowWhen(showWhen) {
        if (!showWhen) return true;
        for (const [id, cond] of Object.entries(showWhen)) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (cond === 'nonempty') {
                if (!el.value.trim()) return false;
            } else if (Array.isArray(cond)) {
                if (!cond.includes(parseInt(el.value))) return false;
            }
        }
        return true;
    }

    optionValue(id) {
        const el = document.getElementById(id);
        return el ? el.value : null;
    }

    optionLabelFor(opt) {
        // imageGrid / select options carry a values[] list - map value to label.
        const v = parseInt(this.optionValue(opt.id));
        const hit = (opt.values || []).find(x => x.value === v);
        return hit ? (hit.shortLabel || hit.label) : null;
    }

    dataSourceLabel(viz) {
        if (!viz?.dataSource) return null;
        return { fft: 'Spectrometer', realtime: 'VU meter · Clever', shadow: 'VU meter · Shadow' }[viz.dataSource] || viz.dataSource;
    }

    fontName(opt, config) {
        const idx = parseInt(this.optionValue(opt.id)) || 0;
        const type = config?.fontType || '1x2';
        const f = (typeof FONT_DATA !== 'undefined') && FONT_DATA.KNOWN_FONTS[type]?.[idx];
        return f ? `${f.name} ${type.replace('x', '×')}` : `font #${idx}`;
    }

    inputSourceLabel(inp) {
        const el = document.getElementById(inp.id);
        if (el?.dataset.gallerySelected === 'true' && el.dataset.galleryFile) {
            const base = el.dataset.galleryFile.split('/').pop();
            return `${base} (gallery)`;
        }
        if (el?.files?.length) return el.files[0].name;
        return inp.default ? 'default artwork' : 'none';
    }

    manifestRow(key, val, tag, tagCls, goTab) {
        const go = goTab ? `<button type="button" class="mf-go" data-go="${goTab}">edit ›</button>` : '';
        return `<tr><td>${key}</td><td class="mf-val">${val}${go}</td>`
            + `<td><span class="mf-tag ${tagCls}">${tag}</span></td></tr>`;
    }

    renderManifest() {
        if (!this.manifestEl) return;
        const ui = this.ui;
        const viz = ui?.selectedVisualizer;
        const config = ui?.currentVisualizerConfig;
        const header = ui?.sidHeader;

        if (!viz || !header) {
            this.manifestEl.innerHTML = '<table><tbody>'
                + this.manifestRow('Player', 'Load a SID and pick a visualizer first', 'pending', 'skip', null)
                + '</tbody></table>';
            return;
        }

        const rows = [];
        // FFT variants' registry names often already say "(Spectrometer)" -
        // don't repeat the data-source label in that case.
        const ds = this.dataSourceLabel(viz);
        const showDs = ds && !viz.name.toLowerCase().includes(ds.split(' ')[0].toLowerCase());
        rows.push(this.manifestRow('Player',
            `${viz.name}${showDs ? ' · ' + ds : ''} · memory bank chosen automatically`,
            'ok', 'inc', 'visualizer'));

        const songSel = document.getElementById('songSelector');
        const tune = songSel ? `tune ${songSel.value} of ${header.songs}` :
            (header.songs > 1 ? `tune ${header.startSong} of ${header.songs}` : null);
        rows.push(this.manifestRow('Music',
            `${header.name || 'Unknown'} — ${header.author || 'Unknown'}${tune ? ' (' + tune + ')' : ''}`,
            'ok', 'inc', 'song'));

        // Song looping (Song tab): how the tune ends and whether a forced loop
        // will be added. Only shown once there is something to say - a natural
        // loop, a detected fade-out, or a pre-ticked loop request.
        const la = ui.tuneAnalysis;
        const loopToggle = document.getElementById('forceLoopToggle');
        const wantLoop = !!(loopToggle && loopToggle.checked);
        const lmmss = s => { const t = Math.round(s || 0), m = Math.floor(t / 60), sec = t % 60; return `${m}:${String(sec).padStart(2, '0')}`; };
        if (header.songs <= 1) {
            if (la && la.looped) {
                rows.push(this.manifestRow('Song loop', `loops naturally at ${lmmss(la.storedSeconds)}`, 'ok', 'inc', 'song'));
            } else if (la && la.fadedOut) {
                rows.push(wantLoop
                    ? this.manifestRow('Song loop', `fades out at ${lmmss(la.loopStartSeconds)} — loop added (restarts)`, 'included', 'inc', 'song')
                    : this.manifestRow('Song loop', `fades out at ${lmmss(la.loopStartSeconds)} — no loop (song ends)`, 'off', 'skip', 'song'));
            } else if (wantLoop) {
                rows.push(this.manifestRow('Song loop', 'restart after fade-out — detected at export', 'included', 'inc', 'song'));
            }
        }

        for (const g of this.derivedGroups) {
            if (g.kind !== 'input') continue;
            rows.push(this.manifestRow(g.label, this.inputSourceLabel(g.input), 'included', 'inc', g.id));
        }

        // Font: included only when its (possibly scrolltext-gated) condition holds.
        const allOpts = (config?.options) || [];
        const fontOpt = allOpts.find(o => o.type === 'fontSelector');
        if (fontOpt) {
            const owner = this.derivedGroups.find(g => (g.options || []).includes(fontOpt))?.id || null;
            if (this.evalShowWhen(fontOpt.showWhen)) {
                rows.push(this.manifestRow('Font', this.fontName(fontOpt, config) + ' · charset embedded',
                    'included', 'inc', owner));
            } else {
                rows.push(this.manifestRow('Font', '—', 'skipped: no scroll text', 'skip', owner));
            }
        }

        const taOpt = allOpts.find(o => o.type === 'textarea');
        if (taOpt) {
            const len = (this.optionValue(taOpt.id) || '').trim().length;
            const owner = this.derivedGroups.find(g => (g.options || []).includes(taOpt))?.id || null;
            rows.push(len
                ? this.manifestRow('Scrolltext', `${len} chars${taOpt.prependSpaces ? ` + ${taOpt.prependSpaces} lead spaces` : ''}`,
                    'included', 'inc', owner)
                : this.manifestRow('Scrolltext', '—', 'skipped: empty', 'skip', owner));
        }

        const styleGroups = this.derivedGroups.filter(g => g.id === 'barstyle' || g.id === 'color');
        for (const styleGroup of styleGroups) {
            const bits = [];
            for (const o of styleGroup.options) {
                if (!this.evalShowWhen(o.showWhen)) continue;
                const label = this.optionLabelFor(o);
                if (label) bits.push(`${o.label.toLowerCase()}: ${label}`);
            }
            rows.push(this.manifestRow(styleGroup.label, bits.join(' · ') || 'defaults', 'ok', 'inc', styleGroup.id));
        }

        if (viz.dataSource === 'fft' && config?.spectrometerBake) {
            const multiSong = header.songs > 1;
            const consent = document.getElementById('fftMultiSongConsent');
            if (multiSong && !(consent && consent.checked)) {
                rows.push(this.manifestRow('FFT bake',
                    'multi-song SID: confirm “default song only” on the Visualizer tab',
                    'action needed', 'warn', 'visualizer'));
            } else {
                const a = ui.tuneAnalysis;
                const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
                rows.push(this.manifestRow('FFT bake',
                    a ? `tune analysed · ${mmss(a.storedSeconds)} stored` : 'analysis pass runs at generate time',
                    a ? 'ready' : 'pending', a ? 'inc' : 'pend', 'export'));
            }
        }

        const comp = document.querySelector('input[name="compression-type"]:checked');
        rows.push(this.manifestRow('Compression',
            comp && comp.value === 'none' ? 'none (raw PRG)' : 'TSCrunch', 'ok', 'inc', 'export'));

        this.manifestEl.innerHTML = `<table><tbody>${rows.join('')}</tbody></table>`;
        for (const btn of this.manifestEl.querySelectorAll('.mf-go')) {
            btn.addEventListener('click', () => this.activate(btn.dataset.go));
        }
    }

    renderFooter() {
        if (!this.footSum) return;
        const viz = this.ui?.selectedVisualizer;
        if (!viz) { this.footSum.textContent = ''; return; }
        const bits = [viz.name];
        const ds = this.dataSourceLabel(viz);
        if (ds && !viz.name.toLowerCase().includes(ds.split(' ')[0].toLowerCase())) {
            bits.push(ds.toLowerCase());
        }
        for (const g of this.derivedGroups) {
            if (g.kind === 'input') bits.push(g.label.toLowerCase() + ': ' + this.inputSourceLabel(g.input));
        }
        const config = this.ui?.currentVisualizerConfig;
        const taOpt = (config?.options || []).find(o => o.type === 'textarea');
        if (taOpt) {
            const len = (this.optionValue(taOpt.id) || '').trim().length;
            bits.push(len ? `scroller: ${len} ch` : 'scroller: off');
        }
        this.footSum.textContent = bits.join(' · ');
    }
}

window.studioModal = new StudioModal();
