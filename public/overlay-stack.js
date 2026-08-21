// overlay-stack.js - which overlay currently owns the keyboard.
//
// The Studio and the tool page both trap Tab and act on Escape, and both must
// stand down when another overlay is layered above them. That used to be a
// hardcoded list of element ids in each file, which drifted: ui.js's copy was
// already missing the logo placement tool, so Escape there closed the wrong
// thing.
//
// The contract is now in the markup. Every overlay carries `data-overlay` and
// shows itself by adding `.visible`; anything asking "is something above me?"
// asks this instead of keeping its own list. Loaded as a classic script before
// ui.js (see the loader in index.html).
(function () {
    function zOf(el) {
        const v = parseInt(getComputedStyle(el).zIndex, 10);
        return Number.isNaN(v) ? 0 : v;
    }

    /**
     * True when a visible overlay other than `selfId` is painted above it.
     * "Above" is the CSS stacking rule these overlays actually follow: a higher
     * z-index wins, and a tie is broken by document order. An overlay nested
     * inside the caller's own element is part of it, not above it.
     * @param {string} selfId - element id of the overlay doing the asking
     */
    function overlayAbove(selfId) {
        const self = document.getElementById(selfId);
        if (!self) return false;
        const selfZ = zOf(self);
        for (const el of document.querySelectorAll('[data-overlay].visible')) {
            if (el === self || self.contains(el)) continue;
            const z = zOf(el);
            if (z > selfZ) return true;
            if (z === selfZ
                && (self.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return true;
        }
        return false;
    }

    /** Every visible overlay, bottom to top, as {id, z}. For diagnostics. */
    function overlayOrder() {
        return [...document.querySelectorAll('[data-overlay].visible')]
            .map(el => ({ id: el.id, z: zOf(el) }))
            .sort((a, b) => a.z - b.z);
    }

    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    g.overlayAbove = overlayAbove;
    g.overlayOrder = overlayOrder;
})();
