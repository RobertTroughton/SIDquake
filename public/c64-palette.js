// c64-palette.js - the one C64 colour table.
//
// There were two: a muted set in ui.js that painted every swatch, colour picker
// and palette editor, and the real VICE PAL values in petscii-converter.js that
// the image conversion matched against. So a user chose "Red" from #753d3d and
// shipped #813338 - which for a tool whose whole job is C64 aesthetics is the
// wrong way round.
//
// These are the Pepto PAL values, the same set VICE ships as its default.
// Loaded as a classic script before ui.js (see the loader in index.html).
//
// charsetlab-core.js keeps its own table of MANY palettes on purpose: it matches
// an incoming image against whichever palette its author used, so it is asking a
// different question and is not a duplicate of this.
(function () {
    const COLORS = [
        { value: 0, name: 'Black', hex: '#000000' },
        { value: 1, name: 'White', hex: '#FFFFFF' },
        { value: 2, name: 'Red', hex: '#813338' },
        { value: 3, name: 'Cyan', hex: '#75CEC8' },
        { value: 4, name: 'Purple', hex: '#8E3C97' },
        { value: 5, name: 'Green', hex: '#56AC4D' },
        { value: 6, name: 'Blue', hex: '#2E2C9B' },
        { value: 7, name: 'Yellow', hex: '#EDF171' },
        { value: 8, name: 'Orange', hex: '#8E5029' },
        { value: 9, name: 'Brown', hex: '#553800' },
        { value: 10, name: 'Light Red', hex: '#C46C71' },
        { value: 11, name: 'Dark Grey', hex: '#4A4A4A' },
        { value: 12, name: 'Grey', hex: '#7B7B7B' },
        { value: 13, name: 'Light Green', hex: '#A9FF9F' },
        { value: 14, name: 'Light Blue', hex: '#706DEB' },
        { value: 15, name: 'Light Grey', hex: '#B2B2B2' },
    ];

    for (const c of COLORS) {
        c.rgb = [
            parseInt(c.hex.slice(1, 3), 16),
            parseInt(c.hex.slice(3, 5), 16),
            parseInt(c.hex.slice(5, 7), 16),
        ];
    }

    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    g.C64_PALETTE = COLORS;
    /** [[r,g,b], ...] in colour-index order, for the image converters. */
    g.C64_PALETTE_RGB = COLORS.map(c => c.rgb.slice());
})();
