// logo-fit.js - place an arbitrary image into a visualizer's logo area.
//
// charsetlab-core only accepts a 320x200 image, a 384x272 VICE grab or a
// 320-wide strip of whole character rows, and a player only displays the top
// N character rows of the screen (charsetRows). Anything else - a 240x88 logo,
// a 320x200 image with the artwork down the middle - either fails to convert
// or has most of itself flattened away. This module works out where such an
// image should sit on the C64 screen and renders it there, filling the space
// around it with the image's own edge colour.
//
// Every offset is a multiple of 8: a logo moved by whole character cells
// converts to the same cells it would have on its own, a logo moved by 3px
// does not.
//
// plan()/autoPlace() are pure (RGBA in, numbers out) and run in Node so the
// placement maths can be regression-tested; render() needs a browser canvas.
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.LogoFit = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    var W = 320, H = 200;
    // A VICE grab's inner screen starts here (borders L32/T35).
    var VICE_W = 384, VICE_H = 272, VICE_X = 32, VICE_Y = 35;

    function snap8(v) { return Math.round(v / 8) * 8; }

    // The visible logo band in pixels for a charsetRows value.
    function bandHeight(rows) {
        var px = (rows == null ? 25 : rows) * 8;
        return Math.max(8, Math.min(H, px));
    }

    // Sizes charsetlab-core takes as-is: a C64 screen, a VICE grab, or a
    // 320-wide strip of whole character rows.
    function isNativeSize(w, h) {
        return (w === VICE_W && h === VICE_H) || (w === W && h >= 8 && h <= H && h % 8 === 0);
    }

    // Why this image can't be a logo, or null when it can.
    //
    // Only these sizes are accepted. Anything else needs a decision nothing can
    // make for the user: a 360px-wide image has 40 columns too many and no
    // offset drops them in the right place, and a height that isn't a multiple
    // of 8 can't line up with the character grid at all. Cropping or resampling
    // to cover that up wrecks the pixel art either way, so say so instead.
    function sizeError(w, h) {
        if (isNativeSize(w, h)) return null;
        return 'A logo has to be ' + W + '×' + H + ' (a C64 screen), ' + VICE_W + '×' + VICE_H +
            ' (a VICE screenshot with its borders), or ' + W + ' wide by any multiple of 8 high' +
            ' (e.g. ' + W + '×88). This one is ' + w + '×' + h + '.';
    }

    // The part of the image the C64 screen actually is: all of it, or the inner
    // screen of a VICE grab. Measuring a grab's colours over the whole thing
    // would read its border as the background and its entire screen as artwork.
    function screenRegion(w, h) {
        return (w === VICE_W && h === VICE_H)
            ? { x: VICE_X, y: VICE_Y, w: W, h: H }
            : { x: 0, y: 0, w: w, h: h };
    }

    // Most common opaque colour around the 1px edge ring of `region` - what the
    // space around a moved logo should be filled with. A fully transparent or
    // empty edge falls back to black (the usual C64 screen background).
    function edgeBackground(rgba, w, h, region) {
        var r = region || screenRegion(w, h);
        var counts = {}, best = null, bestN = 0;
        function add(x, y) {
            var p = (y * w + x) * 4;
            if (rgba[p + 3] < 128) return;
            var k = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
            counts[k] = (counts[k] || 0) + 1;
            if (counts[k] > bestN) { bestN = counts[k]; best = k; }
        }
        for (var x = r.x; x < r.x + r.w; x++) { add(x, r.y); add(x, r.y + r.h - 1); }
        for (var y = r.y; y < r.y + r.h; y++) { add(r.x, y); add(r.x + r.w - 1, y); }
        return best == null ? { r: 0, g: 0, b: 0 }
            : { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255 };
    }

    // Bounding box (in source coordinates) of everything in `region` that isn't
    // the background; transparent pixels count as background, since that's what
    // they'll be filled with. Null for a blank image.
    function contentBounds(rgba, w, h, bg, region) {
        var r = region || screenRegion(w, h);
        var key = (bg.r << 16) | (bg.g << 8) | bg.b;
        var x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (var y = r.y; y < r.y + r.h; y++) {
            for (var x = r.x; x < r.x + r.w; x++) {
                var p = (y * w + x) * 4;
                if (rgba[p + 3] < 128) continue;
                if (((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]) === key) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
        return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    // Pull a snapped offset back onto the 8px grid inside [lo,hi] - the range
    // that keeps the content fully in view. Content that fills its window to
    // within 8px can leave no grid position inside that range at all; then the
    // nearest multiple of 8 to the middle of it wins, which splits the few
    // pixels that spill between the two edges rather than dropping them all off
    // one of them.
    function clamp8(v, lo, hi) {
        var l = Math.ceil(lo / 8) * 8, u = Math.floor(hi / 8) * 8;
        if (l > u) return snap8((lo + hi) / 2);
        return Math.min(Math.max(v, l), u);
    }

    /**
     * Where the source image should sit on the 320x200 screen so its content
     * lands inside the top `band` pixels.
     *
     * The image is only ever scaled down, and only when its content is too big
     * for the band; a source that's already screen-sized keeps its horizontal
     * placement (the artist put it there) and is only moved vertically.
     *
     * @returns { scale, dx, dy } - draw the source at (dx,dy) sized w*scale by
     *          h*scale. dx/dy are multiples of 8.
     */
    function autoPlace(bounds, w, h, band) {
        if (!bounds) return { scale: 1, dx: snap8((W - w) / 2), dy: 0 };
        var cw = bounds.x1 - bounds.x0 + 1, ch = bounds.y1 - bounds.y0 + 1;
        // Artwork that already fits is never resized. Artwork that doesn't is
        // scaled to a hair inside the screen/band, so there's always room to
        // snap the result onto the character grid.
        var scale = (cw <= W && ch <= band) ? 1
            : Math.min(1, (W - 8) / cw, (band - Math.min(8, band >> 1)) / ch);
        var dx;
        if (scale === 1 && (w === W || w === VICE_W)) {
            dx = (W - w) / 2;                       // 0, or -32 for a VICE grab
        } else {
            dx = snap8((W - cw * scale) / 2 - bounds.x0 * scale);
            dx = clamp8(dx, -bounds.x0 * scale, W - (bounds.x1 + 1) * scale);
        }
        var dy = snap8((band - ch * scale) / 2 - bounds.y0 * scale);
        dy = clamp8(dy, -bounds.y0 * scale, band - (bounds.y1 + 1) * scale);
        return { scale: scale, dx: dx, dy: dy };
    }

    /**
     * Analyse an image and decide how to place it.
     *
     * @param {Uint8Array|Uint8ClampedArray} rgba - w*h*4 bytes
     * @param {number} w
     * @param {number} h
     * @param {object} [opts] - { band: visible logo height in px (default 200),
     *                            background: {r,g,b} to override the detected one }
     * @returns place { width, height, band, background, bounds, scale, dx, dy,
     *                  native, needsFit }
     *          needsFit is false when the image is already a size the converter
     *          takes with its content inside the band - leave it untouched.
     */
    function plan(rgba, w, h, opts) {
        opts = opts || {};
        var band = Math.max(8, Math.min(H, opts.band == null ? H : opts.band));
        var region = screenRegion(w, h);
        var background = opts.background || edgeBackground(rgba, w, h, region);
        var bounds = contentBounds(rgba, w, h, background, region);
        var native = isNativeSize(w, h);
        // Where the converter's screen window starts inside this source.
        var baseY = (w === VICE_W && h === VICE_H) ? VICE_Y : 0;
        var inBand = !bounds || (bounds.y0 >= baseY && bounds.y1 - baseY < band);
        var place = autoPlace(bounds, w, h, band);
        place.width = w;
        place.height = h;
        place.band = band;
        place.background = background;
        place.bounds = bounds;
        place.native = native;
        place.needsFit = !(native && inBand);
        return place;
    }

    // Human-readable summary of what a fit did, for the notice under the
    // preview.
    function describe(place) {
        var bits = [];
        if (place.width !== W || place.height !== H) bits.push(place.width + '×' + place.height + ' image');
        if (place.scale < 1) bits.push('scaled to ' + Math.round(place.scale * 100) + '%');
        bits.push('artwork in the top ' + (place.band / 8) + ' character rows');
        return bits.join(', ');
    }

    function cssColour(bg) {
        return 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')';
    }

    /**
     * Blit the source onto a 320x200 screen following `place`, filling the space
     * around it (and anything transparent in it) with the surround colour.
     *
     * Nothing here blends or interpolates. Scaling is nearest neighbour, and a
     * semi-transparent pixel keeps its own colour instead of being mixed with
     * what is behind it, because the converter ignores the alpha channel
     * completely: a blended edge hands it colours that are in no C64 palette
     * slot the artist used, and one stray pixel of an in-between shade in a
     * character cell is enough to put the whole logo out of reach of every
     * mode - including multicolour bitmap, whose pixels are 2px wide.
     *
     * @param {Uint8Array|Uint8ClampedArray} rgba - the source image, w*h*4
     * @param {object} place - from plan(), carrying width/height/scale/dx/dy/background
     * @returns {Uint8ClampedArray} 320*200*4 opaque pixels
     */
    function composite(rgba, place) {
        var out = new Uint8ClampedArray(W * H * 4);
        var bg = place.background, s = place.scale, sw = place.width, sh = place.height;
        for (var i = 0; i < out.length; i += 4) {
            out[i] = bg.r; out[i + 1] = bg.g; out[i + 2] = bg.b; out[i + 3] = 255;
        }
        var dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
        var x0 = Math.max(0, place.dx), y0 = Math.max(0, place.dy);
        var x1 = Math.min(W, place.dx + dw), y1 = Math.min(H, place.dy + dh);
        for (var y = y0; y < y1; y++) {
            var sy = Math.min(sh - 1, Math.floor((y - place.dy) * sh / dh));
            for (var x = x0; x < x1; x++) {
                var sx = Math.min(sw - 1, Math.floor((x - place.dx) * sw / dw));
                var sp = (sy * sw + sx) * 4;
                if (rgba[sp + 3] < 128) continue;       // see-through: keep the surround
                var dp = (y * W + x) * 4;
                out[dp] = rgba[sp]; out[dp + 1] = rgba[sp + 1]; out[dp + 2] = rgba[sp + 2];
            }
        }
        return out;
    }

    // composite() onto a fresh canvas, ready to be turned into a PNG or drawn.
    function render(rgba, place) {
        var canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        canvas.getContext('2d').putImageData(new ImageData(composite(rgba, place), W, H), 0, 0);
        return canvas;
    }

    function toPngBlob(canvas) {
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
                blob ? resolve(blob) : reject(new Error('Could not encode the fitted logo'));
            }, 'image/png');
        });
    }

    return {
        W: W,
        H: H,
        VICE_W: VICE_W,
        VICE_H: VICE_H,
        snap8: snap8,
        bandHeight: bandHeight,
        isNativeSize: isNativeSize,
        sizeError: sizeError,
        screenRegion: screenRegion,
        edgeBackground: edgeBackground,
        contentBounds: contentBounds,
        autoPlace: autoPlace,
        plan: plan,
        describe: describe,
        cssColour: cssColour,
        composite: composite,
        render: render,
        toPngBlob: toPngBlob
    };
});
