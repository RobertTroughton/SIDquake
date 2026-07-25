// color-palettes-data.js - Spectrometer Colour Data for SIDquake Web
// This module generates the colour lookup tables that the web app injects
// into the spectrometer players at PRG build time.
//
// Colours come from an editable palette rather than fixed schemes:
//   * a 6-colour "fade" (bright -> dark) drives both Dynamic Pulse (mode 0)
//     and Fixed Gradient (mode 1); presets below, user-editable in the UI.
//   * a list of column hues drives Rainbow Columns (mode 2), spread across
//     the bars; also user-editable.
//
// Different visualizers have different max heights:
// - Water (RaistlinBars): MAX_BAR_HEIGHT = 111 (14 rows * 8 - 1), needs ~116 entries
// - Mirror (RaistlinMirrorBars): MAX_BAR_HEIGHT = 71 (9 rows * 8 - 1), needs ~76 entries

// C64 Color Palette Reference:
// $00 = Black       $08 = Orange
// $01 = White       $09 = Brown
// $02 = Red         $0A = Light Red
// $03 = Cyan        $0B = Dark Grey
// $04 = Purple      $0C = Grey
// $05 = Green       $0D = Light Green
// $06 = Blue        $0E = Light Blue
// $07 = Yellow      $0F = Light Grey

// Size constants - extra bytes for safety margin
// MAX_BAR_HEIGHT = TOP_SPECTRUM_HEIGHT * 8 - 1, COLOR_TABLE_SIZE = MAX_BAR_HEIGHT + 9
const COLOR_TABLE_SIZE_WATER = 120;        // For RaistlinBars (TOP=14, MAX_BAR_HEIGHT=111)
const COLOR_TABLE_SIZE_MIRROR = 80;        // For RaistlinMirrorBars (TOP=9, MAX_BAR_HEIGHT=71)
const COLOR_TABLE_SIZE_WATER_LOGO = 72;    // For RaistlinBarsWithLogo (TOP=8, MAX_BAR_HEIGHT=63)
const COLOR_TABLE_SIZE_MIRROR_LOGO = 48;   // For RaistlinMirrorBarsWithLogo (TOP=5, MAX_BAR_HEIGHT=39)

// -----------------------------------------------------------------------------
// COLOUR FADE (Dynamic Pulse + Fixed Gradient)
//
// Six C64 colours ordered brightest -> darkest. index 0 is the peak colour
// (tallest bars / top rows), index 5 the base colour (quiet bars / water
// line). Editable in the UI; these named presets seed the picker.
// -----------------------------------------------------------------------------
const FADE_LENGTH = 6;

const FADE_PRESETS = [
    { name: "Spectrum",   colors: [0x01, 0x0F, 0x0D, 0x07, 0x05, 0x02] },  // white, lt grey, lt green, yellow, green, red
    { name: "Twilight",   colors: [0x01, 0x07, 0x0E, 0x04, 0x06, 0x0B] },  // white, yellow, lt blue, purple, blue, dk grey
    { name: "Ember",      colors: [0x01, 0x0F, 0x07, 0x0A, 0x08, 0x02] },  // white, lt grey, yellow, lt red, orange, red
    { name: "Frost",      colors: [0x01, 0x0D, 0x0E, 0x03, 0x0C, 0x0B] },  // white, lt green, lt blue, cyan, grey, dk grey
    { name: "Monochrome", colors: [0x01, 0x0F, 0x0F, 0x0C, 0x0C, 0x0B] }   // white, lt grey, lt grey, grey, grey, dk grey
];

const DEFAULT_FADE = FADE_PRESETS[0].colors.slice();

// Exponent > 1 compresses the light end into the top of the range: a bar has
// to get genuinely tall before it goes bright, and only a full-height bar
// reaches the peak colour - bright pulses can't flood the display.
const HEIGHT_CURVE = 1.5;
// The per-row (fixed gradient) map uses a gentler curve - with only 5-14 rows
// a strong curve would drown the bright colours completely.
const ROW_CURVE = 1.3;

// Map a normalized position 0..1 onto a colour ramp (0 -> ramp[0]).
function rampColor(ramp, u, curve) {
    const idx = Math.floor(Math.pow(Math.max(0, Math.min(1, u)), curve) * ramp.length);
    return ramp[Math.min(ramp.length - 1, idx)];
}

// Normalize a fade to a plain 6-entry array of 0..15 values.
function normalizeFade(fade) {
    if (!fade || !fade.length) return DEFAULT_FADE.slice();
    const out = [];
    for (let i = 0; i < FADE_LENGTH; i++) {
        out[i] = (fade[i] !== undefined ? fade[i] : DEFAULT_FADE[i]) & 0x0F;
    }
    return out;
}

// Height -> colour table for Dynamic Pulse: the whole bar takes the colour of
// its current height, so quiet bars sit in the base colours and only peaks
// reach the bright end.
function generateHeightColorTable(tableSize, fade) {
    const ramp = normalizeFade(fade).slice().reverse();  // dark -> bright
    const result = new Uint8Array(tableSize);

    // tableSize = MAX_BAR_HEIGHT + 9 (safety margin); use the actual MAX_BAR_HEIGHT
    // as the 100% reference so bars reach the peak colour exactly at their top.
    const maxHeight = tableSize - 9;

    for (let i = 0; i < tableSize; i++) {
        result[i] = rampColor(ramp, i / maxHeight, HEIGHT_CURVE);
    }

    return result;
}

// Color effect types
const COLOR_EFFECT_HEIGHT = 0;        // Dynamic - color based on bar height
const COLOR_EFFECT_LINE_GRADIENT = 1; // Static - fixed colours per screen row (fade)
const COLOR_EFFECT_COLUMNS = 2;       // Static - fixed colour per bar column
const COLOR_EFFECT_WAVEFORM = 3;      // Dynamic - color based on voice waveform (live/shadow analysis only)

const NUM_FREQUENCY_BARS = 40;      // bars per spectrometer display

// Line counts for different visualizer types
const LINE_COUNT_WATER = 17;        // TOP_SPECTRUM_HEIGHT (14) + BOTTOM_SPECTRUM_HEIGHT (3)
const LINE_COUNT_WATER_LOGO = 11;   // TOP_SPECTRUM_HEIGHT (8) + BOTTOM_SPECTRUM_HEIGHT (3)
const LINE_COUNT_MIRROR = 18;       // TOTAL_SPECTRUM_HEIGHT (9 * 2)
const LINE_COUNT_MIRROR_LOGO = 10;  // TOTAL_SPECTRUM_HEIGHT (5 * 2)

// Generate line gradient colours for water-style visualizers.
// Returns colours from top to bottom: the fade runs bright at the top down to
// its base colour at the water line. The reflection rows are one constant
// colour (the water-line colour) - no darkening; the sparse reflection dither
// is what makes them read faint.
function generateLineGradientWater(topHeight, bottomHeight, fade) {
    const ramp = normalizeFade(fade).slice().reverse();  // dark -> bright
    const totalLines = topHeight + bottomHeight;
    const result = new Uint8Array(totalLines);

    for (let line = 0; line < topHeight; line++) {
        const u = (topHeight - 1 - line) / (topHeight - 1);
        result[line] = rampColor(ramp, u, ROW_CURVE);
    }

    // Reflection: constant, equal to the water-line (bottom) row colour.
    const waterLineColor = result[topHeight - 1];
    for (let line = 0; line < bottomHeight; line++) {
        result[topHeight + line] = waterLineColor;
    }

    return result;
}

// Generate line gradient colours for mirror-style visualizers.
// Bars grow outward from the centre line, so the centre rows are the base
// colour and the outer rows the bright end - the fade mirrored top/bottom.
function generateLineGradientMirror(halfHeight, fade) {
    const ramp = normalizeFade(fade).slice().reverse();  // dark -> bright
    const totalLines = halfHeight * 2;
    const result = new Uint8Array(totalLines);

    // Top half: line 0 is the outer edge (brightest), centre is the base colour
    for (let line = 0; line < halfHeight; line++) {
        const u = (halfHeight - 1 - line) / (halfHeight - 1);
        result[line] = rampColor(ramp, u, ROW_CURVE);
    }

    // Mirror for the bottom half
    for (let line = 0; line < halfHeight; line++) {
        result[halfHeight + line] = result[halfHeight - 1 - line];
    }

    return result;
}

// -----------------------------------------------------------------------------
// RAINBOW COLUMNS (colorEffectMode 2)
//
// A list of column hues spread left-to-right across the bars, each hue in a
// solid block (no dithering). Editable in the UI; the default is a single
// smooth rainbow sweep, red (bass) through to purple (treble).
// -----------------------------------------------------------------------------
const DEFAULT_COLUMNS = [
    0x02,  // Red
    0x0A,  // Light Red
    0x08,  // Orange
    0x07,  // Yellow
    0x0D,  // Light Green
    0x05,  // Green
    0x03,  // Cyan
    0x0E,  // Light Blue
    0x06,  // Blue
    0x04   // Purple
];
const COLUMN_STOPS = DEFAULT_COLUMNS.length;

function generateBarColumnColors(numBars, columns) {
    const stops = (columns && columns.length) ? columns : DEFAULT_COLUMNS;
    const result = new Uint8Array(numBars);
    for (let i = 0; i < numBars; i++) {
        result[i] = stops[Math.floor(i * stops.length / numBars)] & 0x0F;
    }
    return result;
}

// =============================================================================
// VOICE WAVEFORM COLOUR MODE (colorEffectMode 3, live/shadow players only -
// baked FFT players have no register data at runtime)
//
// Each bar is coloured by the waveform of the SID voice that claimed it -
// the one register-level fact that actually maps to how the music sounds:
//   triangle -> greens (soft, flutey leads)
//   sawtooth -> reds/oranges (buzzy basses and leads)
//   pulse    -> blues (the classic SID lead/chord voice)
//   noise    -> greys (drums and hats)
// Brightness still tracks bar height within each family.
//
// The player consumes a 32-byte table: 4 families x 8 luminance levels,
// indexed by (waveFamily * 8) + (barHeight >> WAVE_LEVEL_SHIFT). Players
// with fewer than 8 usable levels get the master ramp resampled.
// =============================================================================

// The four SID waveform families, in table order. Surfaced in the UI so the
// user can recolour each one.
const WAVE_FAMILY_LABELS = ['Triangle', 'Sawtooth', 'Pulse', 'Noise'];

// Each family is a full, directly-editable brightness ramp - not a single hue
// we derive shades from. WAVE_RAMP_LENGTH entries per family, ordered
// dark -> bright (index 0 = the dimmest/shortest bar, the last entry = the
// brightest/tallest). The 4 ramps are stored back-to-back (family-major), so
// the editable value list is WAVE_RAMP_LENGTH * 4 entries long.
//
// Defaults:  triangle -> greens, pulse -> blues, noise -> reds, sawtooth -> greys.
// The dim end stays inside each family's own hue (never grey for the coloured
// families) so even short bars read as their waveform; each family uses a
// unique set of C64 colours and only shares white ($01) at the very top
// (the overbright peak). All of this is freely editable in the UI.
const WAVE_RAMP_LENGTH = 8;

const DEFAULT_WAVE_RAMPS = [
    // Triangle -> green:  dk grey - green -- cyan - light green - white
    0x0B, 0x0B, 0x05, 0x05, 0x03, 0x0D, 0x0D, 0x01,
    // Sawtooth -> grey:   dark grey - grey ----- light grey ---- white
    0x0B, 0x0B, 0x0C, 0x0C, 0x0F, 0x0F, 0x0F, 0x01,
    // Pulse -> blue:      dk grey - blue -- purple - light blue - white
    0x0B, 0x0B, 0x06, 0x06, 0x04, 0x0E, 0x0E, 0x01,
    // Noise -> red:       dk grey - red / light red dither ---- white
    0x0B, 0x02, 0x0A, 0x02, 0x0A, 0x01, 0x0A, 0x01
];

// Usable brightness levels per visualizer type: MAX_BAR_HEIGHT >> WAVE_LEVEL_SHIFT + 1
// (shift is 4 for the tall players, 3 for the short ones - see the .asm files)
const WAVE_LEVEL_COUNTS = {
    water: 7,       // 111 >> 4 = 0..6
    waterlogo: 8,   // 63 >> 3 = 0..7
    mirror: 5,      // 71 >> 4 = 0..4
    mirrorlogo: 5   // 39 >> 3 = 0..4
};

// Build the 32-byte runtime table (4 families x 8 levels) from the editable
// ramps. Each family's WAVE_RAMP_LENGTH-entry ramp is resampled onto the
// player's usable level count, so the whole dark->bright range is visible no
// matter how many height steps that particular player actually reaches.
function generateWaveColorTable(paletteType, rampValues) {
    const vals = (rampValues && rampValues.length === 4 * WAVE_RAMP_LENGTH)
        ? rampValues : DEFAULT_WAVE_RAMPS;
    const levels = WAVE_LEVEL_COUNTS[paletteType] || WAVE_RAMP_LENGTH;
    const result = new Uint8Array(4 * 8);

    for (let family = 0; family < 4; family++) {
        const ramp = vals.slice(family * WAVE_RAMP_LENGTH, (family + 1) * WAVE_RAMP_LENGTH);
        for (let level = 0; level < 8; level++) {
            // Resample the master ramp onto the usable level count; levels
            // beyond the reachable range just repeat the peak colour.
            const src = level < levels
                ? Math.round(level * (ramp.length - 1) / (levels - 1))
                : ramp.length - 1;
            result[family * 8 + level] = ramp[Math.min(ramp.length - 1, src)] & 0x0F;
        }
    }

    return result;
}

const HEIGHT_TABLE_SIZES = {
    water: COLOR_TABLE_SIZE_WATER,
    mirror: COLOR_TABLE_SIZE_MIRROR,
    waterlogo: COLOR_TABLE_SIZE_WATER_LOGO,
    mirrorlogo: COLOR_TABLE_SIZE_MIRROR_LOGO
};

// Get the height->colour table for a specific visualizer type + fade.
function getHeightColorTable(paletteType, fade) {
    const tableSize = HEIGHT_TABLE_SIZES[paletteType];
    if (!tableSize) return null;
    return generateHeightColorTable(tableSize, fade);
}

window.COLOR_PALETTES_DATA = {
    getHeightColorTable: getHeightColorTable,
    generateWaveColorTable: generateWaveColorTable,
    generateLineGradientWater: generateLineGradientWater,
    generateLineGradientMirror: generateLineGradientMirror,
    generateBarColumnColors: generateBarColumnColors,
    COLOR_TABLE_SIZE_WATER: COLOR_TABLE_SIZE_WATER,
    COLOR_TABLE_SIZE_MIRROR: COLOR_TABLE_SIZE_MIRROR,
    COLOR_TABLE_SIZE_WATER_LOGO: COLOR_TABLE_SIZE_WATER_LOGO,
    COLOR_TABLE_SIZE_MIRROR_LOGO: COLOR_TABLE_SIZE_MIRROR_LOGO,
    // Colour effect functions and constants
    COLOR_EFFECT_HEIGHT: COLOR_EFFECT_HEIGHT,
    COLOR_EFFECT_LINE_GRADIENT: COLOR_EFFECT_LINE_GRADIENT,
    COLOR_EFFECT_COLUMNS: COLOR_EFFECT_COLUMNS,
    COLOR_EFFECT_WAVEFORM: COLOR_EFFECT_WAVEFORM,
    NUM_FREQUENCY_BARS: NUM_FREQUENCY_BARS,
    LINE_COUNT_WATER: LINE_COUNT_WATER,
    LINE_COUNT_WATER_LOGO: LINE_COUNT_WATER_LOGO,
    LINE_COUNT_MIRROR: LINE_COUNT_MIRROR,
    LINE_COUNT_MIRROR_LOGO: LINE_COUNT_MIRROR_LOGO,
    // Editable-palette metadata for the UI
    FADE_PRESETS: FADE_PRESETS,
    DEFAULT_FADE: DEFAULT_FADE,
    FADE_LENGTH: FADE_LENGTH,
    DEFAULT_COLUMNS: DEFAULT_COLUMNS,
    COLUMN_STOPS: COLUMN_STOPS,
    DEFAULT_WAVE_RAMPS: DEFAULT_WAVE_RAMPS,
    WAVE_RAMP_LENGTH: WAVE_RAMP_LENGTH,
    WAVE_FAMILY_LABELS: WAVE_FAMILY_LABELS
};
