// tscrunch-load.js - build the TSCrunch facade from the ES module in lib/.
//
// Loaded on first use only: the cruncher itself is the heavy part and an export
// that uses Exomizer (the default) never fetches it. Both the page and the
// compression worker run this file, so the option shaping below lives in one
// place rather than once per caller.
(function (root) {
    root.loadTSCrunch = async function () {
        if (root.TSCrunch) return;

        const { Cruncher, createSFX } = await import('./lib/index.js');

        if (typeof root.Buffer === 'undefined') {
            root.Buffer = {
                from: function (data) {
                    if (data instanceof Uint8Array) return data;
                    if (Array.isArray(data)) return new Uint8Array(data);
                    return new Uint8Array(0);
                }
            };
        }

        root.TSCrunch = {
            compress: function (data, options = {}) {
                const {
                    prg = true, sfx = true, sfxMode = 0,
                    jumpAddress = 0x1000, blank = false, inplace = false
                } = options;

                const dataArray = Array.from(data);
                let sourceData = dataArray;
                let loadAddress = 0x0801;

                if (prg && dataArray.length >= 2) {
                    loadAddress = dataArray[0] | (dataArray[1] << 8);
                    sourceData = dataArray.slice(2);
                }

                const cruncher = new Cruncher(sourceData);
                cruncher.ocrunch({ inplace, verbose: false, sfxMode: sfx });

                let compressed = cruncher.crunched;
                if (sfx) {
                    compressed = Array.from(createSFX(root.Buffer.from(compressed), {
                        jumpAddress, decrunchAddress: loadAddress,
                        optimalRun: cruncher.optimalRun, sfxMode, blank
                    }));
                }

                return new Uint8Array(compressed);
            }
        };

        if (typeof root.dispatchEvent === 'function' && typeof Event !== 'undefined') {
            root.dispatchEvent(new Event('tscrunch-ready'));
        }
    };
})(typeof window !== 'undefined' ? window : self);
