// compressor-worker.js - crunch an export off the main thread.
//
// Both compressors are one long synchronous call: Exomizer runs inside its WASM
// module and TSCrunch is plain JS. On a full-RAM export that is ten seconds and
// more with no yield, which on the page means a frozen tab and Chrome offering
// to kill it halfway through a build. Here it costs the same time and the page
// keeps painting - the busy overlay animates and Cancel still answers.
//
// The work itself is compressor-manager.js, which this imports rather than
// reimplements; it detects the worker and loads its dependencies with
// importScripts. A browser that cannot start this worker falls back to the
// main-thread path in the manager, which is what everyone had before.

importScripts('compressor-manager.js');

const manager = new CompressorManager();

self.onmessage = async (e) => {
    const { id, type, data, uncompressedStart, executeAddress } = e.data || {};
    try {
        const result = await manager.compress(
            new Uint8Array(data), type, uncompressedStart, executeAddress);
        const out = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data);
        self.postMessage({
            id, ok: true, data: out.buffer,
            originalSize: result.originalSize, compressedSize: result.compressedSize,
        }, [out.buffer]);
    } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
};
