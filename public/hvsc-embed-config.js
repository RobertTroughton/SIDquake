// hvsc-embed-config.js — settles the embed's configuration from the ?query on
// hvsc-embed.html, before anything else runs.
//
// Three kinds of option, three destinations:
//   * wiring and behaviour -> window.HVSC_EMBED, read by hvsc-browser.js
//   * chrome               -> hvsc-no-* classes on <html>, acted on by the CSS
//                             in hvsc-embed.html (so nothing depends on when
//                             a given control is built) plus one pass over the
//                             few controls that carry configurable text
//   * palette              -> custom properties set on <html>, which override
//                             the :root block in styles.css
//
// Everything here arrives from a URL, so nothing is trusted: colours are
// accepted only as hex or a CSS colour keyword, fonts only as a family list,
// and every other constrained option is matched against its allowed values.
// No caller-supplied string ever reaches the page as raw CSS.
//
// The options are documented for embedders in docs/EMBED.md and on the site's
// "Embed HVSC" tab; keep all three in step.

(function () {
    'use strict';

    var params = new URLSearchParams(location.search);
    var root = document.documentElement;

    // ---- readers -----------------------------------------------------------

    /** A yes/no option. A bare `?viz` with no value counts as on. */
    function flag(name, dflt) {
        if (!params.has(name)) return dflt;
        var v = (params.get(name) || '').trim().toLowerCase();
        if (v === '') return true;
        return ['0', 'false', 'no', 'off', 'hide'].indexOf(v) === -1;
    }

    /** Free text, trimmed. An explicitly empty value means "nothing here". */
    function text(name, dflt) {
        var v = params.get(name);
        return v === null ? dflt : v.trim();
    }

    /** One of a fixed set of words, case-insensitively. */
    function choice(name, allowed, dflt) {
        var v = (params.get(name) || '').trim().toLowerCase();
        return allowed.indexOf(v) === -1 ? dflt : v;
    }

    /** A whole number inside a range. */
    function number(name, lo, hi, dflt) {
        var v = parseFloat(params.get(name));
        if (!isFinite(v)) return dflt;
        return Math.min(hi, Math.max(lo, v));
    }

    // ---- colours -----------------------------------------------------------

    var HEX_LENGTHS = [3, 4, 6, 8];

    /**
     * A colour we are willing to paste into a stylesheet: `#rgb`/`#rrggbb`
     * (with or without the leading `#`, which is awkward in a query string) or
     * a CSS colour keyword. Anything else — including function syntax, which
     * could carry a url() — is refused.
     *
     * A keyword has to be one the browser knows, not merely word-shaped: a
     * misspelt `nothex` would otherwise be stored as a custom property, come
     * out invalid where it is used, and leave that surface unpainted.
     */
    function colour(raw) {
        if (raw === null || raw === undefined) return null;
        var v = String(raw).trim().replace(/^#/, '');
        if (/^[0-9a-f]+$/i.test(v) && HEX_LENGTHS.indexOf(v.length) !== -1) return '#' + v.toLowerCase();
        if (/^[a-z]{3,20}$/i.test(v) && isKnownColour(v.toLowerCase())) return v.toLowerCase();
        return null;
    }

    function colourParam(name) { return colour(params.get(name)); }

    /**
     * Does the browser recognise this keyword? Assigning an unrecognised value
     * to fillStyle leaves the previous one in place, so two different starting
     * points that end up agreeing means it was understood. Without a canvas to
     * ask we can't tell, and refuse rather than risk an unpainted surface.
     */
    function isKnownColour(css) {
        var ctx = probe();
        if (!ctx) return false;
        ctx.fillStyle = '#000000';
        ctx.fillStyle = css;
        var fromBlack = ctx.fillStyle;
        ctx.fillStyle = '#ffffff';
        ctx.fillStyle = css;
        return fromBlack === ctx.fillStyle;
    }

    // Resolve an accepted colour to [r,g,b] so the accent's lighter and tinted
    // relatives can be derived from whatever the embedder picked. A canvas
    // normalises keywords for us without needing a laid-out element, which
    // matters because this runs from <head>.
    var probeCtx;
    function probe() {
        if (probeCtx === undefined) {
            try { probeCtx = document.createElement('canvas').getContext('2d'); }
            catch (e) { probeCtx = null; }
        }
        return probeCtx;
    }

    function rgbOf(css) {
        var ctx = probe();
        if (!ctx) return null;
        ctx.fillStyle = '#000000';
        ctx.fillStyle = css;
        var m = String(ctx.fillStyle).match(/^#([0-9a-f]{6})$/i);
        if (m) {
            var n = parseInt(m[1], 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
        var parts = String(ctx.fillStyle).match(/(\d+(?:\.\d+)?)/g);
        return parts && parts.length >= 3 ? [+parts[0], +parts[1], +parts[2]] : null;
    }

    function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

    /** Move a colour `amount` (0..1) of the way toward white (or black). */
    function shade(rgb, amount) {
        var to = amount >= 0 ? 255 : 0;
        var a = Math.abs(amount);
        return '#' + rgb.map(function (c) {
            return ('0' + clamp255(c + (to - c) * a).toString(16)).slice(-2);
        }).join('');
    }

    function rgba(rgb, alpha) {
        return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + alpha + ')';
    }

    /** Hue in degrees (0..360) of a colour; null for a grey, which has none. */
    function hueOf(rgb) {
        var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        if (d === 0) return null;
        var h;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        return h < 0 ? h + 360 : h;
    }

    function setVar(name, value) {
        if (value) root.style.setProperty(name, value);
    }

    // ---- palette -----------------------------------------------------------

    // A preset is just a set of defaults for the individual colour options
    // below, so `theme=light&accent=c0392b` does what it looks like it does.
    // `dark` is the stylesheet's own palette and therefore sets nothing.
    var THEMES = {
        dark: {},
        light: {
            bg: '#f4f5f7',
            panel: '#ffffff',
            surface: '#eceef2',
            bar: '#e7e9ef',
            hover: '#dbdee7',
            text: '#1b1d21',
            text2: '#494c54',
            muted: '#5b5e67',
            border: '#d2d5dd',
            accent: '#9a6b12',
            accent2: '#5a45c8',
            infobg: '#ffffff'
        }
    };

    // Colour option -> the custom property it drives. The accent and the two
    // border tones are handled separately because they have relatives to keep
    // in step.
    var COLOUR_VARS = {
        bg: '--bg-primary',
        panel: '--bg-secondary',
        surface: '--bg-surface',
        bar: '--bg-elevated',
        hover: '--bg-hover',
        text: '--text-primary',
        text2: '--text-secondary',
        muted: '--text-muted',
        accent2: '--accent-secondary',
        infobg: '--hvsc-info-bg'
    };

    var preset = THEMES[choice('theme', ['dark', 'light'], 'dark')];

    function pickColour(name) {
        return colourParam(name) || preset[name] || null;
    }

    /** Perceived brightness, 0..1, of an [r,g,b]. */
    function luminance(rgb) {
        return (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255;
    }

    // Whether the widget is being painted on a light or a dark ground decides
    // which way its emphasised tones move: a "lighter accent" on a white page
    // is a paler one nobody can read.
    var groundRgb = rgbOf(pickColour('panel') || pickColour('bg') || '#131318');
    var onLight = !!groundRgb && luminance(groundRgb) > 0.5;
    var emphasise = onLight ? -0.18 : 0.22;

    Object.keys(COLOUR_VARS).forEach(function (name) {
        setVar(COLOUR_VARS[name], pickColour(name));
    });

    // The accent carries a family: a lighter tone for hover and focus rings,
    // two translucent tints, and the gradient used on emphasised surfaces.
    // Deriving them keeps a custom accent from being surrounded by amber.
    var accent = pickColour('accent');
    if (accent) {
        var rgb = rgbOf(accent);
        setVar('--accent', accent);
        if (rgb) {
            var light = shade(rgb, emphasise);
            setVar('--accent-light', light);
            setVar('--text-accent', light);
            setVar('--accent-dim', rgba(rgb, 0.12));
            setVar('--accent-glow', rgba(rgb, 0.2));
            setVar('--border-accent', rgba(rgb, 0.25));
            setVar('--accent-gradient', 'linear-gradient(90deg, ' + accent + ' 0%, ' + light + ' 100%)');
            setVar('--shadow-glow', '0 0 12px ' + rgba(rgb, 0.1));
        }
    }

    // Separators and the (higher contrast) outline of a control move together,
    // so a light palette doesn't keep near-black hairlines.
    var border = pickColour('border');
    if (border) {
        var borderRgb = rgbOf(border);
        setVar('--border', border);
        if (borderRgb) {
            // Away from the ground in both cases, so a control's outline keeps
            // the contrast WCAG 1.4.11 wants whichever way round the page is.
            setVar('--border-light', shade(borderRgb, onLight ? -0.12 : 0.12));
            setVar('--border-control', shade(borderRgb, onLight ? -0.42 : 0.42));
        }
    }

    // Spectrum strip: the bars run as a hue ramp from the lowest band to the
    // highest, so the two options name the ends by colour and only the hue is
    // taken (saturation and lightness track the signal). See hvsc-visualizer.js.
    ['viz1', 'viz2'].forEach(function (name, i) {
        var c = colourParam(name);
        var h = c && rgbOf(c);
        h = h && hueOf(h);
        if (h !== null && h !== undefined) {
            setVar(i === 0 ? '--hvsc-viz-hue-start' : '--hvsc-viz-hue-end', String(Math.round(h)));
        }
    });

    // Corner roundness, one number for every control in the widget.
    var radius = params.has('radius') ? number('radius', 0, 24, 6) : null;
    if (radius !== null) {
        ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'].forEach(function (v) {
            setVar(v, radius + 'px');
        });
    }

    // A font family list, restricted to the characters one is made of.
    var font = text('font', '');
    if (font && font.length <= 120 && /^[\w\s,'"-]+$/.test(font)) {
        // Two properties: the widget's own body font (hvsc-embed.html reads
        // --hvsc-font so its default stays the system stack) and the design
        // token the shared components are built on.
        setVar('--hvsc-font', font);
        setVar('--font-sans', font);
    }

    // ---- chrome ------------------------------------------------------------

    var titleText = text('title', 'HVSC Browser');
    var placeholder = text('placeholder', 'Search HVSC by title, author, or comment...');
    var selectLabel = text('selectlabel', 'Select');
    var infoTitle = text('infotitle', 'SID Info');

    // Each entry is [option, default, class added when the option is off].
    var CHROME = [
        ['header', true, 'hvsc-no-header'],
        ['badge', true, 'hvsc-no-badge'],
        ['search', true, 'hvsc-no-search'],
        ['nav', true, 'hvsc-no-nav'],
        ['sortui', true, 'hvsc-no-sortui'],
        ['year', true, 'hvsc-no-year'],
        ['info', true, 'hvsc-no-info'],
        ['stil', true, 'hvsc-no-stil'],
        ['download', true, 'hvsc-no-download'],
        ['share', true, 'hvsc-no-share'],
        ['player', true, 'hvsc-no-player'],
        ['credit', true, 'hvsc-no-credit'],
        ['viz', true, 'hvsc-no-viz'],
        ['status', true, 'hvsc-no-status'],
        ['count', true, 'hvsc-no-count'],
        ['path', true, 'hvsc-no-path'],
        ['select', true, 'hvsc-no-select']
    ];

    CHROME.forEach(function (opt) {
        if (!flag(opt[0], opt[1])) root.classList.add(opt[2]);
    });
    // An empty title is the same request as hiding it, and lets the header
    // collapse when the search box has gone too.
    if (!titleText) root.classList.add('hvsc-no-title');

    document.addEventListener('DOMContentLoaded', function () {
        var titleEl = document.querySelector('.browser-title-text');
        if (titleEl) titleEl.textContent = titleText;
        var search = document.getElementById('hvscSearchBar');
        if (search) search.placeholder = placeholder;
        var infoHead = document.querySelector('.sid-info-panel .panel-header');
        if (infoHead) infoHead.textContent = infoTitle;
        var label = document.querySelector('.hvsc-choose-label');
        if (label) label.textContent = selectLabel;
        var btn = document.querySelector('.hvsc-choose-btn');
        if (btn && selectLabel) btn.title = selectLabel + ' the highlighted tune';
    });

    // ---- wiring and behaviour ---------------------------------------------

    // Embedders should pass ?origin=<their site> so results are posted only to
    // them; fall back to the referrer's origin, else '*' (which emitSelection
    // treats as an unknown parent and refuses to hand tune data to).
    var targetOrigin = params.get('origin');
    if (!targetOrigin && document.referrer) {
        try { targetOrigin = new URL(document.referrer).origin; } catch (e) { /* opaque referrer */ }
    }

    /** An HVSC folder option as an index path, or null. */
    function folder(name) {
        var p = text(name, '');
        if (!p) return null;
        p = p.replace(/^\/+/, '').replace(/^HVSC\//, '').replace(/\/+$/, '');
        if (!p) return null;
        return (p === 'C64Music' || p.indexOf('C64Music/') === 0) ? p : 'C64Music/' + p;
    }

    window.HVSC_EMBED = {
        mode: choice('mode', ['link', 'file', 'play'], 'link'),
        targetOrigin: targetOrigin || '*',
        // Confines browsing and searching to a subtree; null = whole collection.
        root: folder('root'),
        autoplay: flag('autoplay', false),
        query: text('q', ''),
        sort: choice('sort', ['name', 'year', 'match'], ''),
        sortDir: choice('dir', ['asc', 'desc'], '')
    };
    window.HVSC_EMBED_START = folder('start');
    // Deep link to a specific tune (?tune=<path>), like the main site.
    window.HVSC_EMBED_TUNE = params.get('tune') || null;
})();
