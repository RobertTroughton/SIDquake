// sidquake-core.js - Core SID analysis functionality using WASM

/**
 * SIDAnalyzer wraps the SIDquake WASM module and exposes a JS-friendly API
 * for loading SID files, running emulation-based analysis, and producing a
 * modified SID for export. WASM heap allocations are managed here; callers
 * never touch raw pointers.
 */
class SIDAnalyzer {
    constructor() {
        this.wasmModule = null;
        this.wasmReady = false;
        this.api = null;
        this.Module = null;
        this.initPromise = this.initWASM();
    }

    async initWASM() {
        try {
            // The Emscripten glue (sidquake.js) exposes the module factory as a
            // global (SIDquakeModule) or on window; accept either.
            const moduleFactory =
                (typeof SIDquakeModule !== 'undefined' && SIDquakeModule) ||
                (typeof window !== 'undefined' && window.SIDquakeModule);
            if (typeof moduleFactory !== 'function') {
                throw new Error('SID WASM module factory not found (sidquake.js failed to load?)');
            }
            this.Module = await moduleFactory();
            this.wasmModule = this.Module;
            // Expose globally so PNGConverter and other consumers can share the same instance
            window.SIDquakeModule = this.Module;

            if (!this.Module.HEAPU8) {
                console.error('HEAPU8 not found in module');
                throw new Error('WASM memory arrays not available');
            }

            // cwrap bindings to the C exports in wasm/sid_processor.cpp
            this.api = {
                sid_init: this.Module.cwrap('sid_init', null, []),
                sid_load: this.Module.cwrap('sid_load', 'number', ['number', 'number']),
                sid_analyze: this.Module.cwrap('sid_analyze', 'number', ['number', 'number']),
                // Header strings are Latin-1 (ISO 8859-1), not UTF-8 - bind as
                // raw pointers and decode/encode with the helpers below.
                sid_get_header_string: this.Module.cwrap('sid_get_header_string', 'number', ['number']),
                sid_get_header_value: this.Module.cwrap('sid_get_header_value', 'number', ['number']),
                sid_set_header_string: this.Module.cwrap('sid_set_header_string', null, ['number', 'number']),
                sid_create_modified: this.Module.cwrap('sid_create_modified', 'number', ['number']),
                sid_get_modified_count: this.Module.cwrap('sid_get_modified_count', 'number', []),
                sid_get_modified_address: this.Module.cwrap('sid_get_modified_address', 'number', ['number']),
                sid_get_zp_count: this.Module.cwrap('sid_get_zp_count', 'number', []),
                // Subtunes whose init never returned inside its cycle budget: a
                // non-zero count means the maps below are INCOMPLETE, not empty.
                sid_get_init_timeouts: this.Module.cwrap('sid_get_init_timeouts', 'number', []),
                sid_get_longest_init_cycles: this.Module.cwrap('sid_get_longest_init_cycles', 'number', []),
                sid_get_zp_address: this.Module.cwrap('sid_get_zp_address', 'number', ['number']),
                sid_get_code_bytes: this.Module.cwrap('sid_get_code_bytes', 'number', []),
                sid_get_data_bytes: this.Module.cwrap('sid_get_data_bytes', 'number', []),
                sid_get_sid_writes: this.Module.cwrap('sid_get_sid_writes', 'number', ['number']),
                sid_get_sid_chip_count: this.Module.cwrap('sid_get_sid_chip_count', 'number', []),
                sid_get_sid_chip_address: this.Module.cwrap('sid_get_sid_chip_address', 'number', ['number']),
                sid_get_clock_type: this.Module.cwrap('sid_get_clock_type', 'string', []),
                sid_get_sid_model: this.Module.cwrap('sid_get_sid_model', 'string', []),
                sid_get_num_calls_per_frame: this.Module.cwrap('sid_get_num_calls_per_frame', 'number', []),
                sid_get_cia_timer_detected: this.Module.cwrap('sid_get_cia_timer_detected', 'number', []),
                sid_get_cia_timer_value: this.Module.cwrap('sid_get_cia_timer_value', 'number', []),
                sid_get_max_cycles: this.Module.cwrap('sid_get_max_cycles', 'number', []),
                sid_cleanup: this.Module.cwrap('sid_cleanup', null, []),

                malloc: (size) => this.Module._malloc(size),
                free: (ptr) => this.Module._free(ptr)
            };

            this.api.sid_init();
            this.wasmReady = true;

            return true;

        } catch (error) {
            console.error('Failed to initialize WASM module:', error);
            this.wasmReady = false;
            throw error;
        }
    }

    /**
     * Decode a NUL-terminated Latin-1 (ISO 8859-1) string from the WASM heap.
     * SID header fields use Latin-1 per the SID spec; cwrap's 'string' would
     * decode them as UTF-8 and mangle bytes like ø/ä/é into U+FFFD.
     */
    _readLatin1(ptr) {
        if (!ptr) return '';
        const heap = this.Module.HEAPU8;
        let s = '';
        for (let i = ptr; heap[i]; i++) s += String.fromCharCode(heap[i]);
        return s;
    }

    /** Encode a JS string as NUL-terminated Latin-1 into a fresh WASM buffer. */
    _writeLatin1(str) {
        const ptr = this.api.malloc(str.length + 1);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            this.Module.HEAPU8[ptr + i] = code <= 0xFF ? code : 0x3F; // '?' for non-Latin-1
        }
        this.Module.HEAPU8[ptr + str.length] = 0;
        return ptr;
    }

    async waitForWASM() {
        try {
            await this.initPromise;
            return this.wasmReady;
        } catch (error) {
            console.error('WASM initialization failed:', error);
            return false;
        }
    }

    /**
     * Load a SID file from an ArrayBuffer and return its parsed header.
     * @param {ArrayBuffer} arrayBuffer - Raw SID file bytes
     * @returns {Promise<Object>} Header info (name, author, addresses, flags, etc.)
     */
    async loadSID(arrayBuffer) {
        if (!await this.waitForWASM()) {
            throw new Error('WASM module not ready');
        }

        if (!this.Module) {
            throw new Error('WASM Module not available');
        }

        if (!this.Module.HEAPU8) {
            console.error('Available Module properties:', Object.keys(this.Module));
            throw new Error('WASM memory (HEAPU8) not available - module may not be properly initialized');
        }

        const data = new Uint8Array(arrayBuffer);
        let ptr = null;

        try {
            ptr = this.api.malloc(data.length);

            if (!ptr) {
                throw new Error('Failed to allocate memory in WASM heap');
            }

            // Copy file contents into the WASM heap before invoking the loader
            this.Module.HEAPU8.set(data, ptr);

            const result = this.api.sid_load(ptr, data.length);

            if (result < 0) {
                const errors = {
                    '-1': 'File too small',
                    '-2': 'Invalid SID file format',
                    '-3': 'RSID format not supported',
                    '-4': 'Unsupported SID version',
                    '-5': 'Missing load address',
                    '-7': 'SID data does not fit in C64 memory at its load address'
                };
                throw new Error(errors[result] || `Unknown error: ${result}`);
            }

            return {
                name: this._readLatin1(this.api.sid_get_header_string(0)),
                author: this._readLatin1(this.api.sid_get_header_string(1)),
                copyright: this._readLatin1(this.api.sid_get_header_string(2)),
                format: this._readLatin1(this.api.sid_get_header_string(3)),
                version: this.api.sid_get_header_value(0),
                loadAddress: this.api.sid_get_header_value(1),
                initAddress: this.api.sid_get_header_value(2),
                playAddress: this.api.sid_get_header_value(3),
                songs: this.api.sid_get_header_value(4),
                startSong: this.api.sid_get_header_value(5),
                flags: this.api.sid_get_header_value(6),
                fileSize: this.api.sid_get_header_value(7),
                clockType: this.api.sid_get_clock_type(),
                sidModel: this.api.sid_get_sid_model()
            };

        } catch (error) {
            console.error('Error in loadSID:', error);
            throw error;
        } finally {
            if (ptr !== null) {
                this.api.free(ptr);
            }
        }
    }

    /**
     * Run the SID through the 6510 emulator for the given number of frames and
     * collect the addresses written to, the zero-page locations used, and per-
     * register SID write counts.
     * @param {number} frameCount - Number of frames to emulate
     * @param {Function|null} progressCallback - Called as (current, total)
     */
    async analyze(frameCount = 30000, progressCallback = null) {
        if (!await this.waitForWASM()) {
            throw new Error('WASM module not ready');
        }

        let callbackPtr = 0;

        // sid_analyze is one synchronous WASM call: it holds the main thread for
        // its whole run, so nothing here can report progress while it works and
        // a Cancel button would be unclickable. This used to tick a setInterval
        // that the browser could not deliver until the call had already
        // finished, so the readout sat at 0% and then jumped. Report the start
        // and the finish, and let the caller say what is happening in between.
        if (progressCallback) progressCallback(0, frameCount);
        try {
            const result = this.api.sid_analyze(frameCount, callbackPtr);

            if (result < 0) {
                throw new Error(`Analysis failed: ${result}`);
            }

            const modifiedAddresses = [];
            const modifiedCount = this.api.sid_get_modified_count();
            for (let i = 0; i < modifiedCount; i++) {
                const addr = this.api.sid_get_modified_address(i);
                if (addr !== 0xFFFF) {  // 0xFFFF is the sentinel for an empty slot
                    modifiedAddresses.push(addr);
                }
            }

            const zpAddresses = [];
            const zpCount = this.api.sid_get_zp_count();
            for (let i = 0; i < zpCount; i++) {
                const addr = this.api.sid_get_zp_address(i);
                if (addr !== 0xFF) {  // 0xFF is the sentinel for an empty slot
                    zpAddresses.push(addr);
                }
            }

            const sidWrites = new Map();
            for (let reg = 0; reg < 0x20; reg++) {
                const count = this.api.sid_get_sid_writes(reg);
                if (count > 0) {
                    sidWrites.set(reg, count);
                }
            }

            if (progressCallback) {
                progressCallback(frameCount, frameCount);
            }

            const numCallsPerFrame = this.api.sid_get_num_calls_per_frame();
            const ciaTimerDetected = this.api.sid_get_cia_timer_detected() ? true : false;
            const ciaTimerValue = this.api.sid_get_cia_timer_value();
            const maxCycles = this.api.sid_get_max_cycles();
            const sidChipCount = this.api.sid_get_sid_chip_count();

            const sidChipAddresses = [];
            for (let i = 0; i < sidChipCount; i++) {
                const addr = this.api.sid_get_sid_chip_address(i);
                if (addr > 0) {
                    sidChipAddresses.push(addr);
                }
            }

            return {
                modifiedAddresses,
                zpAddresses,
                sidWrites,
                codeBytes: this.api.sid_get_code_bytes(),
                dataBytes: this.api.sid_get_data_bytes(),
                numCallsPerFrame,
                ciaTimerDetected,
                ciaTimerValue,
                maxCycles,
                sidChipCount,
                sidChipAddresses,
                // How many subtunes' init routines ran out of cycles. When this is
                // non-zero those songs were skipped entirely, so an empty
                // modifiedAddresses/zpAddresses means "we could not find out",
                // NOT "the tune touches nothing" - and placing player routines on
                // that assumption is what corrupts an export.
                initTimeouts: this.api.sid_get_init_timeouts ? this.api.sid_get_init_timeouts() : 0,
                longestInitCycles: this.api.sid_get_longest_init_cycles ? this.api.sid_get_longest_init_cycles() : 0
            };
        } finally {
            // Nothing to unwind: the run is one blocking call.
        }
    }

    /**
     * Update an editable header string (name/author/copyright).
     * SID header strings are limited to 31 characters plus a null terminator.
     */
    updateMetadata(field, value) {
        if (!this.wasmReady) {
            console.warn('WASM not ready, cannot update metadata');
            return false;
        }

        const fields = {
            'name': 0,
            'author': 1,
            'copyright': 2
        };

        if (field in fields) {
            const ptr = this._writeLatin1(value.substring(0, 31));
            try {
                this.api.sid_set_header_string(fields[field], ptr);
            } finally {
                this.api.free(ptr);
            }
            return true;
        }

        return false;
    }

    /**
     * Build a SID file reflecting any header edits and return its bytes.
     * The WASM side allocates the result; this method copies it out and frees it.
     */
    createModifiedSID() {
        if (!this.wasmReady || !this.Module) {
            console.error('WASM not ready, cannot create modified SID');
            return null;
        }

        // 4-byte slot for the WASM side to write the result length into
        const sizePtr = this.api.malloc(4);
        let dataPtr = 0;

        try {
            dataPtr = this.api.sid_create_modified(sizePtr);

            if (!dataPtr) {
                console.error('Failed to create modified SID - null pointer returned');
                return null;
            }

            const size = this.Module.HEAP32[sizePtr >> 2];

            if (size <= 0 || size > 65536) {
                console.error(`Invalid SID size: ${size}`);
                return null;
            }

            const data = new Uint8Array(size);
            data.set(this.Module.HEAPU8.subarray(dataPtr, dataPtr + size));

            return data;

        } catch (error) {
            console.error('Error creating modified SID:', error);
            return null;
        } finally {
            // Free the buffer the WASM side malloc'd for us - on every path,
            // including the invalid-size early returns (freeing 0 is a no-op).
            this.api.free(dataPtr);
            this.api.free(sizePtr);
        }
    }

    cleanup() {
        if (this.wasmReady && this.api) {
            this.api.sid_cleanup();
        }
    }
}

window.SIDAnalyzer = SIDAnalyzer;
