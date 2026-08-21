// visualizer-registry.js - Define available visualizers (UI metadata only)

const VISUALIZERS = [
    {
        id: 'default',
        name: 'Just the text',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Default',
        description: 'Your tune title, your name, and the song details. No effects.',
        preview: 'prg/default.png',
        config: 'prg/default.json'
    },
    {
        id: 'DefaultWithLogo',
        name: 'Text with a picture',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Default With Logo',
        description: 'The same information, with your own logo across the top.',
        preview: 'prg/defaultwithlogo.png',
        config: 'prg/defaultwithlogo.json'
    },
    {
        id: 'RaistlinBars',
        // What a first-time visitor lands on. Picked deliberately: the grid is
        // sorted by name, so index 0 was whatever happened to sort first - which
        // for a long time was the text-only player, i.e. a visualizer tool
        // opening on no visualizer.
        defaultPick: true,
        name: 'Bars',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Raistlin Bars',
        description: 'A row of bars that dance to the music.',
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
        name: 'Bars with a picture',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Raistlin Bars With Logo',
        description: 'Dancing bars beneath your own logo.',
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
        name: 'Mirrored bars',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Raistlin Mirror Bars',
        description: 'Bars that grow out from the middle of the screen, both ways.',
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
        name: 'Mirrored bars with a picture',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Raistlin Mirror Bars With Logo',
        description: 'Bars growing both ways, beneath your own logo.',
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
        name: 'Colour blobs',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Musical Blobs',
        description: 'Each voice painted as drifting columns of colour, under a logo.',
        preview: 'prg/musicalblobs.png',
        config: 'prg/musicalblobs.json'
    },
    {
        id: 'SimpleBitmapWithScroller',
        name: 'Full-screen picture',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Simple Bitmap',
        description: 'One full-screen image, with an optional message scrolling across it.',
        preview: 'prg/simplebitmap.png',
        config: 'prg/simplebitmapwithscroller.json'
    },
    {
        id: 'SimpleRaster',
        name: 'Coloured stripes',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Simple Raster',
        description: 'Bands of colour rolling down the screen. The classic C64 look.',
        preview: 'prg/simpleraster.png',
        config: 'prg/simpleraster.json'
    },
    {
        id: 'ScrapColumns',
        name: '3D columns',
        // The scene name, kept as a credit line on the card.
        sceneName: 'Scrap Columns',
        description: 'A spectrum drawn as columns receding into the distance.',
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
        const base = byId[methods.realtime];
        for (const [method, id] of Object.entries(methods)) {
            const v = byId[id];
            if (!v) continue;
            v.dataSourceGroup = group;
            v.dataSource = method;
            if (method !== 'realtime') {
                v.hidden = true;   // only the realtime base shows in the grid
                // The variants are the same look by another route, so they carry
                // the same name. Which route is in use is said separately (the
                // Method tab, the footer summary, the export manifest) rather
                // than smuggled into the name as "(Shadow)" / "(Spectrometer)".
                if (base) {
                    v.name = base.name;
                    v.sceneName = base.sceneName;
                    v.description = base.description;
                }
            }
        }
    }
})();

window.VISUALIZERS = VISUALIZERS;