// compressor-manager.js - Unified compression manager for SIDquake.
// Wraps optional compressors (TSCrunch and Exomizer) behind a single async API
// and lazy-loads them on first use to keep startup cost low.
//
// The two are a deliberate ratio/speed pair, measured on real exports:
//   TSCrunch  ~33 cycles/byte to decrunch (a 27 KB image in ~0.9 s on a PAL C64)
//   Exomizer  ~9-16% smaller, ~129 cycles/byte (the same image in ~3.6 s)
// Neither dominates, so both are offered; Exomizer is the default (the smaller
// file wins for most exports) and TSCrunch is there when depack speed matters.

// The page and the compression worker both run this file, so every global goes
// through G rather than `window` - see compressor-worker.js.
const G = (typeof window !== 'undefined') ? window : self;
const inWorker = (typeof importScripts === 'function');

/** Load a classic script, wherever this is running. */
async function loadCompressorScript(src) {
    if (inWorker) { importScripts(src); return; }
    if (!G.loadScript) throw new Error(`Cannot load ${src}: no script loader`);
    await G.loadScript(src);
}

class CompressorManager {
    constructor() {
        this.compressors = {
            'none': null,
            'tscrunch': null,
            'exomizer': null
        };

        this.initialized = false;
    }

    async initializeCompressors() {
        if (this.initialized) return;

        // Lazy-load TSCrunch only when first needed
        try {
            if (!G.loadTSCrunch) await loadCompressorScript('tscrunch-load.js');
            if (G.loadTSCrunch) await G.loadTSCrunch();
        } catch (error) {
            console.warn('TSCrunch loader failed:', error);
        }

        if (G.TSCrunch) {
            try {
                this.compressors.tscrunch = new TSCrunchCompressor();
            } catch (error) {
                console.warn('TSCrunch initialization failed:', error);
            }
        }

        // Exomizer lives in a ~180 KB WASM module, so it is NOT fetched here -
        // constructing the wrapper is free and the module loads inside
        // compressPRG(), only for an export that actually asks for it. A load
        // failure surfaces as a throw from compress(), which the exporter
        // already handles by falling back to an uncompressed image.
        this.compressors.exomizer = new ExomizerCompressor();

        this.initialized = true;
    }

    async waitForInit() {
        if (!this.initialized) {
            await this.initializeCompressors();
        }
    }

    isAvailable(type) {
        if (type === 'none') return true;
        return this.compressors[type] !== null;
    }

    async compress(data, type, uncompressedStart, executeAddress) {
        if (type === 'none') {
            return {
                data: data,
                type: 'none',
                originalSize: data.length,
                compressedSize: data.length,
                ratio: 1.0
            };
        }

        // Crunching is one long synchronous call - ten seconds and more on a
        // full-RAM export - so on the page it runs in a worker and the tab stays
        // alive. Anything that stops the worker, from a browser without them to a
        // job that dies inside one, falls through to the in-page path below,
        // which is what this always did.
        try {
            const offThread = await this._compressOffThread(data, type, uncompressedStart, executeAddress);
            if (offThread) return offThread;
        } catch (error) {
            console.warn('Compression worker failed, crunching on the page instead:', error);
        }

        await this.waitForInit();
        const compressor = this.compressors[type];
        if (!compressor) {
            throw new Error(`Compressor '${type}' not available`);
        }

        // Strip the 2-byte PRG load address before handing data to the compressor;
        // it will be re-added by the SFX wrapper.
        const hasLoadAddress = data.length >= 2 &&
            (data[0] | (data[1] << 8)) === uncompressedStart;

        const dataToCompress = hasLoadAddress ? data.slice(2) : data;

        let result = await compressor.compressPRG(
            dataToCompress,
            uncompressedStart,
            executeAddress
        );

        return {
            data: result.data || result,
            type: type,
            originalSize: result.originalSize || data.length,
            compressedSize: result.compressedSize || (result.data ? result.data.length : result.length)
        };
    }

    /**
     * Hand one compression to the worker. Resolves to the same shape compress()
     * returns, or null when there is no worker to use - inside the worker
     * itself, in a browser without them, or when one refuses to start. A worker
     * that fails mid-job rejects, and the caller (the exporter) already treats a
     * failed compression as "ship it uncompressed".
     */
    async _compressOffThread(data, type, uncompressedStart, executeAddress) {
        if (inWorker || typeof Worker === 'undefined') return null;
        if (this._workerBroken) return null;
        try {
            if (!this.worker) {
                const cb = G.cacheBust || (s => s);
                this.worker = new Worker(cb('compressor-worker.js'));
                this._jobs = new Map();
                this._nextJob = 1;
                this.worker.onmessage = (e) => {
                    const job = this._jobs.get(e.data.id);
                    if (!job) return;
                    this._jobs.delete(e.data.id);
                    if (e.data.ok) job.resolve(e.data);
                    else job.reject(new Error(e.data.error || 'compression failed'));
                };
                // A worker that dies takes every job with it; let them fail so
                // the exporter can fall back rather than wait forever.
                this.worker.onerror = () => {
                    this._workerBroken = true;
                    for (const job of this._jobs.values()) job.reject(new Error('compression worker failed'));
                    this._jobs.clear();
                };
            }
        } catch (error) {
            this._workerBroken = true;
            return null;
        }
        const id = this._nextJob++;
        const copy = new Uint8Array(data);   // transferred, so never the caller's buffer
        const answer = new Promise((resolve, reject) => this._jobs.set(id, { resolve, reject }));
        this.worker.postMessage({
            id, type, data: copy.buffer, uncompressedStart, executeAddress,
        }, [copy.buffer]);
        const done = await answer;
        return {
            data: new Uint8Array(done.data),
            type,
            originalSize: done.originalSize || data.length,
            compressedSize: done.compressedSize || done.data.byteLength,
        };
    }
}

/**
 * TSCrunch wrapper. TSCrunch expects PRG-format input (load address as first
 * two bytes) and produces a self-extracting executable.
 */
class TSCrunchCompressor {
    constructor() {
        this.originalSize = 0;
        this.compressedSize = 0;
    }

    async compressPRG(data, uncompressedStart, executeAddress) {
        try {
            this.originalSize = data.length;

            // Ensure prgData has the expected load address as its first two bytes.
            let prgData;
            if (data.length >= 2 && (data[0] | (data[1] << 8)) === uncompressedStart) {
                prgData = data;
            } else {
                prgData = new Uint8Array(data.length + 2);
                prgData[0] = uncompressedStart & 0xFF;
                prgData[1] = (uncompressedStart >> 8) & 0xFF;
                prgData.set(data, 2);
            }

            const options = {
                prg: true,
                sfx: true,
                sfxMode: 0,
                jumpAddress: executeAddress,
                blank: false,
                inplace: false
            };

            const compressed = TSCrunch.compress(prgData, options);

            this.compressedSize = compressed.length;

            return {
                data: compressed,
                originalSize: this.originalSize,
                compressedSize: this.compressedSize,
                ratio: this.compressedSize / this.originalSize
            };

        } catch (error) {
            console.error('TSCrunch compression failed:', error);
            throw error;
        }
    }
}

/**
 * Exomizer 3 wrapper (public/exomizer.js + .wasm, built from wasm/exomizer by
 * scripts/build-exomizer-wasm.sh). Like TSCrunch it takes PRG-format input and
 * produces a self-extracting executable - here via exomizer's own
 * `sfx <jmpaddress>` command, so the crunched image is exactly what the
 * command line tool would emit.
 */
class ExomizerCompressor {
    constructor() {
        this.originalSize = 0;
        this.compressedSize = 0;
    }

    /**
     * Exomizer's C sources keep global state they never tear down (named
     * buffers, chunk pools, the sfx assembler's symbol table), so one module
     * instance may serve exactly one compression. Instantiating is a few
     * milliseconds and an export compresses once, so we simply make a fresh
     * instance per call rather than teaching upstream to reset itself.
     */
    async createModule() {
        if (typeof ExomizerModule !== 'function') {
            await loadCompressorScript('exomizer.js');
        }
        if (typeof ExomizerModule !== 'function') {
            throw new Error('Exomizer: exomizer.js did not define ExomizerModule');
        }
        // eslint-disable-next-line no-undef
        return ExomizerModule();
    }

    async compressPRG(data, uncompressedStart, executeAddress) {
        this.originalSize = data.length;

        // Ensure prgData carries the expected load address as its first two bytes.
        let prgData;
        if (data.length >= 2 && (data[0] | (data[1] << 8)) === uncompressedStart) {
            prgData = data;
        } else {
            prgData = new Uint8Array(data.length + 2);
            prgData[0] = uncompressedStart & 0xFF;
            prgData[1] = (uncompressedStart >> 8) & 0xFF;
            prgData.set(data, 2);
        }

        const module = await this.createModule();
        let inPtr = 0;
        try {
            inPtr = module._malloc(prgData.length);
            module.HEAPU8.set(prgData, inPtr);

            const size = module._exo_compress_sfx(inPtr, prgData.length, executeAddress & 0xFFFF, 0);
            if (size <= 0) throw new Error(`Exomizer: compression failed (code ${size})`);

            // Re-read HEAPU8 through the module: crunching a large image can grow
            // the WASM heap, which detaches any view captured beforehand.
            const outPtr = module._exo_output_ptr();
            const compressed = new Uint8Array(module.HEAPU8.subarray(outPtr, outPtr + size));
            module._exo_free();

            this.compressedSize = compressed.length;
            return {
                data: compressed,
                originalSize: this.originalSize,
                compressedSize: this.compressedSize,
                ratio: this.compressedSize / this.originalSize
            };
        } catch (error) {
            console.error('Exomizer compression failed:', error);
            throw error;
        } finally {
            if (inPtr && module._free) module._free(inPtr);
        }
    }
}

G.CompressorManager = CompressorManager;