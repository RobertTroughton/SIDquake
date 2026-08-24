#!/usr/bin/env node
// test-image-memory.js - converted full-screen pictures keep their real C64
// graphics footprint when prg-builder maps the shared image blob into memory.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = {};
global.CompressorManager = class {};
global.PETSCIISanitizer = class {};
global.CharsetLabCore = require(path.join(ROOT, 'public', 'charsetlab-core.js'));

const sourceConfig = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'public', 'prg', 'simplebitmapwithscroller.json'), 'utf8'));
let currentBlob;
global.VisualizerConfig = class {
    async loadConfig() {
        const config = JSON.parse(JSON.stringify(sourceConfig));
        config.inputs[0].default = 'converted-image.bin';
        return config;
    }
    async loadDefaultFile() { return currentBlob; }
};

require(path.join(ROOT, 'public', 'prg-builder.js'));

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

function blob(mode, charCount) {
    const B = CharsetLabCore.IMAGE_BLOB;
    const out = new Uint8Array(B.SIZE);
    out[B.MODE] = mode;
    out[B.CHARCOUNT] = charCount & 0xff;
    out[B.CHARCOUNT + 1] = (charCount >> 8) & 0xff;
    out[B.BORDER] = 12;
    return out;
}

async function mappedGraphicsBytes(mode, charCount, layoutKey) {
    currentBlob = blob(mode, charCount);
    const exporter = new window.SIDquakePRGExporter({});
    const components = await exporter.processVisualizerInputs('SimpleBitmapWithScroller', layoutKey);
    const gfx = components.find(c => c.name === 'Graphics: picture data');
    const screen = components.find(c => c.name === 'Graphics: picture screen');
    const registers = components.filter(c => /_(d022|d023|d024)$/.test(c.name));
    const border = components.find(c => /_border$/.test(c.name));
    check(screen && screen.data.length === 1000, `${layoutKey}: screen RAM remains 1000 bytes`);
    check(registers.length === 3, `${layoutKey}: all shared colour registers are mapped`);
    check(border && border.data.length === 1 && border.data[0] === 12,
        `${layoutKey}: inferred border $0c is mapped into the player`);
    return gfx ? gfx.data.length : 0;
}

(async () => {
    const M = CharsetLabCore.IMAGE_MODES;
    for (const layoutKey of Object.keys(sourceConfig.layouts)) {
        check(await mappedGraphicsBytes(M.PETSCII_UPPER, 20, layoutKey) === 0,
            `${layoutKey}: PETSCII ships no graphics bytes`);
        check(await mappedGraphicsBytes(M.PETSCII_LOWER, 20, layoutKey) === 0,
            `${layoutKey}: lowercase PETSCII ships no graphics bytes`);
        check(await mappedGraphicsBytes(M.HIRES, 20, layoutKey) === 160,
            `${layoutKey}: a 20-char custom image ships 160 graphics bytes`);
        check(await mappedGraphicsBytes(M.BITMAP_MC, 0, layoutKey) === 8000,
            `${layoutKey}: bitmap fallback still ships all 8000 graphics bytes`);

        const layout = sourceConfig.layouts[layoutKey];
        const start = parseInt(layout.binaryDataStart);
        const coreLength = parseInt(layout.binaryCoreEnd) - start + 1;
        const binaryLength = fs.statSync(path.join(ROOT, 'public', layout.binary)).size;
        check(binaryLength - coreLength === 8192,
            `${layoutKey}: text export drops the assembled 8K bitmap placeholder`,
            `${binaryLength} -> ${coreLength} bytes`);

        // An untouched image-derived control is absent from the option patch
        // layer, so the input's inferred border survives. Once supplied, the
        // ordinary priority-2 option patch remains a supported manual override.
        const exporter = new window.SIDquakePRGExporter({});
        exporter._optionValues = { borderColor: undefined };
        const automatic = await exporter.processVisualizerOptions(
            'SimpleBitmapWithScroller', layoutKey);
        check(!automatic.some(c => c.name === 'option_borderColor'),
            `${layoutKey}: automatic border is not replaced by option default 0`);
        exporter._optionValues = { borderColor: '3' };
        const overridden = await exporter.processVisualizerOptions(
            'SimpleBitmapWithScroller', layoutKey);
        const borderPatch = overridden.find(c => c.name === 'option_borderColor');
        check(borderPatch && borderPatch.data[0] === 3,
            `${layoutKey}: a chosen border still overrides the inferred value`);
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
