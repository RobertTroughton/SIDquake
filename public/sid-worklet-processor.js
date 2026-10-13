// sid-worklet-processor.js - AudioWorklet processor for SID playback
// Receives Float32 audio samples from the main thread via MessagePort
// and outputs them in the audio thread's process() callback.

// Ask the page for more below this many queued samples: ~0.37 s at 44.1 kHz,
// slack for heavy main-thread work (re-renders, GC, layout).
const LOW_WATER_SAMPLES = 16384;
// While a request has come back empty, ask again after this many 128-sample
// render quanta (~0.2 s) rather than wait forever.
const STARVED_RETRY_QUANTA = 64;

class SIDWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];
        this._offset = 0;
        this._active = false;
        this._totalSamples = 0;
        this._requested = false;
        this._starved = 0;      // quanta spent empty since the last request

        this.port.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'samples') {
                this._queue.push(msg.samples);
                this._totalSamples += msg.samples.length;
                this._requested = false;
                this._starved = 0;
            } else if (msg.type === 'start') {
                this._active = true;
                this._requested = false;
            } else if (msg.type === 'pause') {
                // Stop consuming but keep the queue, so a resume plays on from
                // where the listener was.
                this._active = false;
                this._requested = false;
            } else if (msg.type === 'stop') {
                this._active = false;
                for (const buf of this._queue) this._recycle(buf, 0);
                this._queue.length = 0;
                this._offset = 0;
                this._totalSamples = 0;
                this._requested = false;
            }
        };
    }

    // Hand a spent block back to the page for reuse, with how much audio is still
    // queued here: the engine runs that far ahead of what is heard.
    _recycle(buf, buffered) {
        this.port.postMessage({ type: 'recycle', buffer: buf.buffer, buffered }, [buf.buffer]);
    }

    process(inputs, outputs) {
        const output = outputs[0][0];

        if (!this._active) {
            output.fill(0);
            return true;
        }

        let written = 0;
        while (written < output.length && this._queue.length > 0) {
            const buf = this._queue[0];
            const avail = buf.length - this._offset;
            const need = output.length - written;
            const n = Math.min(avail, need);

            output.set(buf.subarray(this._offset, this._offset + n), written);

            written += n;
            this._offset += n;
            this._totalSamples -= n;

            if (this._offset >= buf.length) {
                this._queue.shift();
                this._offset = 0;
                this._recycle(buf, this._totalSamples);
            }
        }

        for (let i = written; i < output.length; i++) {
            output[i] = 0;
        }

        // Request more samples when the buffer runs low, reporting the fill
        // level so the page tops up to its high-water mark.
        //
        // A request can come back with nothing (the engine rendered no samples
        // that once), and no answer means no next request, hence the retry.
        if (this._requested && this._totalSamples === 0 && ++this._starved >= STARVED_RETRY_QUANTA) {
            this._requested = false;
            this._starved = 0;
        }
        if (this._totalSamples < LOW_WATER_SAMPLES && !this._requested) {
            this._requested = true;
            this.port.postMessage({ type: 'need-samples', buffered: this._totalSamples });
        }

        return true;
    }
}

registerProcessor('sid-worklet-processor', SIDWorkletProcessor);
