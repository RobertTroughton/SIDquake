class TextDropZone {
    static create(textareaId, config = {}) {
        const textarea = document.getElementById(textareaId);
        if (!textarea) return;

        // Create drop zone wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'text-drop-zone';
        textarea.parentNode.insertBefore(wrapper, textarea);
        wrapper.appendChild(textarea);

        // Add drop indicator
        const dropIndicator = document.createElement('div');
        dropIndicator.className = 'text-drop-indicator';
        dropIndicator.innerHTML = '<i class="fas fa-file-alt"></i> Drop text file here';
        wrapper.appendChild(dropIndicator);

        // Add persistent hint about drag-drop
        const dropHint = document.createElement('div');
        dropHint.className = 'text-drop-hint';
        dropHint.innerHTML = '<i class="fas fa-upload"></i> Drag & drop .txt file or type below';
        wrapper.insertBefore(dropHint, textarea);

        // Scrolltext boxes get extra rows since they hold longer content
        if (textareaId.toLowerCase().includes('scroll')) {
            textarea.rows = 6;
        }

        this.attachDragDrop(wrapper, textarea);
    }

    static attachDragDrop(wrapper, textarea) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            wrapper.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            wrapper.addEventListener(eventName, () => {
                wrapper.classList.add('drag-active');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            wrapper.addEventListener(eventName, () => {
                wrapper.classList.remove('drag-active');
            });
        });

        // Scrolltext for a C64 PRG is at most a few KB; refuse huge files
        // rather than stuffing megabytes into the textarea (and downstream
        // sanitizer/exporter).
        const MAX_TEXT_FILE_SIZE = 64 * 1024;

        wrapper.addEventListener('drop', async (e) => {
            const file = e.dataTransfer.files[0];
            if (!file || !(file.type.startsWith('text/') || file.name.endsWith('.txt'))) return;

            if (file.size > MAX_TEXT_FILE_SIZE) {
                if (window.showWarning) {
                    window.showWarning(`Text file too large (max ${MAX_TEXT_FILE_SIZE / 1024} KB)`);
                }
                return;
            }

            try {
                const text = await file.text();
                textarea.value = text;
                // Fire 'input' (not 'change'): the validators and conditional
                // reveals in ui.js listen on 'input', so a dropped file must
                // trigger the same sanitisation/disclosure as typing.
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (err) {
                console.error('TextDropZone: could not read dropped file:', err);
                if (window.showWarning) {
                    window.showWarning('Could not read the dropped file');
                }
            }
        });
    }
}

window.TextDropZone = TextDropZone;