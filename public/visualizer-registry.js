// visualizer-registry.js - Define available visualizers (UI metadata only)

const VISUALIZERS = [
    {
        id: 'default',
        name: 'Default',
        description: 'Minimal player with textual information',
        preview: 'prg/default.png',
        config: 'prg/default.json'
    },
    {
        id: 'DefaultWithLogo',
        name: 'Default With Logo',
        description: 'Text information with a 9-row logo (charset, bitmap or PETSCII)',
        preview: 'prg/defaultwithlogo.png',
        config: 'prg/defaultwithlogo.json'
    },
    {
        id: 'RaistlinBars',
        name: 'Raistlin Bars',
        description: 'Spectrometer bars',
        preview: 'prg/raistlinbars.png',
        config: 'prg/raistlinbars.json'
    },
    {
        id: 'RaistlinBarsFFT',
        name: 'Raistlin Bars (Spectrometer)',
        description: 'Spectrometer bars',
        preview: 'prg/raistlinbars.png',
        config: 'prg/raistlinbarsfft.json'
    },
    {
        id: 'RaistlinBarsShadow',
        name: 'Raistlin Bars (Shadow)',
        description: 'Spectrometer bars via the shadow-register method (single play, no save/restore)',
        preview: 'prg/raistlinbars.png',
        config: 'prg/raistlinbarsshadow.json'
    },
    {
        id: 'RaistlinBarsWithLogo',
        name: 'Raistlin Bars With Logo',
        description: 'Spectrometer bars below an 80px tall logo',
        preview: 'prg/raistlinbarswithlogo.png',
        config: 'prg/raistlinbarswithlogo.json'
    },
    {
        id: 'RaistlinBarsShadowWithLogo',
        name: 'Raistlin Bars With Logo (Shadow)',
        description: 'Spectrometer bars below a logo via the shadow-register method',
        preview: 'prg/raistlinbarswithlogo.png',
        config: 'prg/raistlinbarswithlogoshadow.json'
    },
    {
        id: 'RaistlinBarsFFTWithLogo',
        name: 'Raistlin Bars With Logo (Spectrometer)',
        description: 'Spectrometer bars below a logo',
        preview: 'prg/raistlinbarswithlogo.png',
        config: 'prg/raistlinbarsfftwithlogo.json'
    },
    {
        id: 'RaistlinMirrorBars',
        name: 'Raistlin Mirror Bars',
        description: 'Spectrometer mirrored bars',
        preview: 'prg/raistlinmirrorbars.png',
        config: 'prg/raistlinmirrorbars.json'
    },
    {
        id: 'RaistlinMirrorBarsShadow',
        name: 'Raistlin Mirror Bars (Shadow)',
        description: 'Mirrored spectrometer bars via the shadow-register method',
        preview: 'prg/raistlinmirrorbars.png',
        config: 'prg/raistlinmirrorbarsshadow.json'
    },
    {
        id: 'RaistlinMirrorBarsFFT',
        name: 'Raistlin Mirror Bars (Spectrometer)',
        description: 'Mirrored spectrometer bars',
        preview: 'prg/raistlinmirrorbars.png',
        config: 'prg/raistlinmirrorbarsfft.json'
    },
    {
        id: 'RaistlinMirrorBarsWithLogo',
        name: 'Raistlin Mirror Bars With Logo',
        description: 'Spectrometer mirrored bars below an 80px tall logo',
        preview: 'prg/raistlinmirrorbarswithlogo.png',
        config: 'prg/raistlinmirrorbarswithlogo.json'
    },
    {
        id: 'RaistlinMirrorBarsFFTWithLogo',
        name: 'Raistlin Mirror Bars With Logo (Spectrometer)',
        description: 'Mirrored spectrometer bars below a logo',
        preview: 'prg/raistlinmirrorbarswithlogo.png',
        config: 'prg/raistlinmirrorbarsfftwithlogo.json'
    },
    {
        id: 'RaistlinMirrorBarsShadowWithLogo',
        name: 'Raistlin Mirror Bars With Logo (Shadow)',
        description: 'Mirrored spectrometer bars (below a logo) via the shadow-register method',
        preview: 'prg/raistlinmirrorbarswithlogo.png',
        config: 'prg/raistlinmirrorbarswithlogoshadow.json'
    },
    {
        id: 'MusicalBlobs',
        name: 'Musical Blobs',
        description: 'Per-channel spectrum painted as 80 vertical colour strips into a bitmap, below a character-set logo',
        preview: 'prg/musicalblobs.png',
        config: 'prg/musicalblobs.json'
    },
    {
        id: 'SimpleBitmapWithScroller',
        name: 'Simple Bitmap',
        description: 'Full-screen bitmap, with an optional scroller',
        preview: 'prg/simplebitmap.png',
        config: 'prg/simplebitmapwithscroller.json'
    },
    {
        id: 'SimpleRaster',
        name: 'Simple Raster',
        description: 'Minimal rasterbar effect',
        preview: 'prg/simpleraster.png',
        config: 'prg/simpleraster.json'
    },
    {
        id: 'ScrapColumns',
        name: 'Scrap Columns',
        description: '3D column spectrum visualizer by Scrap',
        preview: 'prg/scrapcolumns.png',
        config: 'prg/scrapcolumns.json'
    }
];

// Group the realtime / shadow / FFT builds of each bar style so the UI can offer
// one card per style with a "bar data source" selector, instead of a separate
// list entry per method. Non-realtime members are hidden from the grid; the UI
// swaps to them when the user picks that data source. (See ui.js selectDataSource.)
(function groupBarDataSources() {
    const GROUPS = {
        'RaistlinBars': { realtime: 'RaistlinBars', shadow: 'RaistlinBarsShadow', fft: 'RaistlinBarsFFT' },
        'RaistlinBarsWithLogo': { realtime: 'RaistlinBarsWithLogo', shadow: 'RaistlinBarsShadowWithLogo', fft: 'RaistlinBarsFFTWithLogo' },
        'RaistlinMirrorBars': { realtime: 'RaistlinMirrorBars', shadow: 'RaistlinMirrorBarsShadow', fft: 'RaistlinMirrorBarsFFT' },
        'RaistlinMirrorBarsWithLogo': { realtime: 'RaistlinMirrorBarsWithLogo', shadow: 'RaistlinMirrorBarsShadowWithLogo', fft: 'RaistlinMirrorBarsFFTWithLogo' },
    };
    const byId = Object.fromEntries(VISUALIZERS.map(v => [v.id, v]));
    for (const [group, methods] of Object.entries(GROUPS)) {
        for (const [method, id] of Object.entries(methods)) {
            const v = byId[id];
            if (!v) continue;
            v.dataSourceGroup = group;
            v.dataSource = method;
            if (method !== 'realtime') v.hidden = true;   // only the realtime base shows in the grid
        }
    }
})();

window.VISUALIZERS = VISUALIZERS;