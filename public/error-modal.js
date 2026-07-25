// error-modal.js - Unified error/notification modal.
// Provides error, warning, success, info and confirm dialogs through a single
// global instance, so the rest of the app does not depend on alert()/confirm()
// (which block the audio thread on some browsers).

class ErrorModal {
    constructor() {
        this.modalElement = null;
        this.timeoutId = null;
        this.initialized = false;
        this.dismissOnBackdrop = false;
        // Element focused before the modal opened, restored on hide.
        this._previouslyFocused = null;
        // What Escape does for the current modal (Cancel for a confirm, plain
        // hide otherwise) - kept in sync per _show so Escape never leaves a
        // confirm() promise unresolved.
        this._dismissHandler = null;
    }

    /** Initialize the modal DOM elements, creating them if absent. */
    init() {
        if (this.initialized) return;

        // The modal element is normally pre-rendered in index.html; fall back to
        // injecting it dynamically so this module works standalone too.
        this.modalElement = document.getElementById('modalOverlay');

        if (!this.modalElement) {
            this.createModalHTML();
        }

        // Single backdrop handler for the lifetime of the overlay; gated per-show
        // so errors/confirms can't be dismissed by clicking outside.
        this.modalElement.addEventListener('click', (e) => {
            if (this.dismissOnBackdrop && e.target === this.modalElement) {
                this.hide();
            }
        });

        // Keyboard support while the modal is open: Escape dismisses (routed
        // through the per-modal handler so a confirm still resolves), Tab is
        // trapped inside the dialog so focus can't wander to the page behind it.
        document.addEventListener('keydown', (e) => {
            if (!this.modalElement.classList.contains('visible')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (this._dismissHandler) this._dismissHandler();
                else this.hide();
            } else if (e.key === 'Tab') {
                this._trapTab(e);
            }
        });

        this.initialized = true;
    }

    /** Keep Tab focus cycling within the modal's focusable controls. */
    _trapTab(e) {
        const focusable = this.modalElement.querySelectorAll(
            'button, [href], summary, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    createModalHTML() {
        const modalHTML = `
            <div class="modal-overlay" id="modalOverlay">
                <div class="modal-content">
                    <div class="modal-icon" id="modalIcon"></div>
                    <div class="modal-title" id="modalTitle"></div>
                    <div class="modal-message" id="modalMessage"></div>
                    <div class="modal-details" id="modalDetails"></div>
                    <div class="modal-actions" id="modalActions"></div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = modalHTML;
        document.body.appendChild(tempDiv.firstElementChild);
        this.modalElement = document.getElementById('modalOverlay');
    }

    /**
     * Show an error message
     * @param {string} message - Primary error message
     * @param {Object} options - Optional configuration
     * @param {string} options.title - Error title
     * @param {string} options.details - Technical details (collapsible)
     * @param {number} options.duration - Auto-dismiss duration in ms (0 for manual)
     * @param {Array} options.actions - Array of {label, callback} for action buttons
     * @param {boolean} options.log - Whether to log to console (default: true)
     */
    error(message, options = {}) {
        const defaultOptions = {
            title: 'Error',
            icon: '\u2717',
            iconClass: 'error',
            duration: 0,  // errors require explicit dismissal
            log: true,
            ...options
        };

        if (defaultOptions.log) {
            console.error(`[SIDquake Error] ${message}`, options.details || '');
        }

        this._show(message, defaultOptions);
    }

    /**
     * Show a warning message
     * @param {string} message - Warning message
     * @param {Object} options - Optional configuration
     */
    warning(message, options = {}) {
        const defaultOptions = {
            title: 'Warning',
            icon: '\u26A0',
            iconClass: 'warning',
            duration: 4000,
            log: true,
            ...options
        };

        if (defaultOptions.log) {
            console.warn(`[SIDquake Warning] ${message}`);
        }

        this._show(message, defaultOptions);
    }

    /**
     * Show a success message
     * @param {string} message - Success message
     * @param {Object} options - Optional configuration
     */
    success(message, options = {}) {
        const defaultOptions = {
            title: '',
            icon: '\u2713',
            iconClass: 'success',
            duration: 2000,
            log: false,
            ...options
        };

        this._show(message, defaultOptions);
    }

    /**
     * Show an info message
     * @param {string} message - Info message
     * @param {Object} options - Optional configuration
     */
    info(message, options = {}) {
        const defaultOptions = {
            title: '',
            icon: '\u2139',
            iconClass: 'info',
            duration: 3000,
            log: false,
            ...options
        };

        this._show(message, defaultOptions);
    }

    /**
     * Show a confirmation dialog
     * @param {string} message - Confirmation message
     * @param {Object} options - Optional configuration
     * @returns {Promise<boolean>} - Resolves to true if confirmed, false if cancelled
     */
    confirm(message, options = {}) {
        return new Promise((resolve) => {
            const defaultOptions = {
                title: 'Confirm',
                icon: '?',
                iconClass: 'confirm',
                duration: 0,
                actions: [
                    { label: 'Cancel', callback: () => resolve(false), secondary: true },
                    { label: 'Confirm', callback: () => resolve(true) }
                ],
                ...options
            };

            this._show(message, defaultOptions);
        });
    }

    /** Internal method to display the modal. */
    _show(message, options) {
        if (!this.initialized) this.init();

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        const iconEl = document.getElementById('modalIcon');
        const titleEl = document.getElementById('modalTitle');
        const messageEl = document.getElementById('modalMessage');
        const detailsEl = document.getElementById('modalDetails');
        const actionsEl = document.getElementById('modalActions');

        if (iconEl) {
            iconEl.textContent = options.icon || '';
            iconEl.className = `modal-icon ${options.iconClass || ''}`;
        }

        if (titleEl) {
            titleEl.textContent = options.title || '';
            titleEl.style.display = options.title ? 'block' : 'none';
        }

        if (messageEl) {
            messageEl.textContent = message;
        }

        // Optional collapsible block for technical details (stack traces, etc.)
        if (detailsEl) {
            if (options.details) {
                detailsEl.innerHTML = `
                    <details class="error-details">
                        <summary>Technical Details</summary>
                        <pre>${this._escapeHtml(options.details)}</pre>
                    </details>
                `;
                detailsEl.style.display = 'block';
            } else {
                detailsEl.innerHTML = '';
                detailsEl.style.display = 'none';
            }
        }

        if (actionsEl) {
            actionsEl.innerHTML = '';

            if (options.actions && options.actions.length > 0) {
                options.actions.forEach(action => {
                    const btn = document.createElement('button');
                    btn.className = `modal-action-btn ${action.secondary ? 'secondary' : 'primary'}`;
                    btn.textContent = action.label;
                    btn.addEventListener('click', () => {
                        this.hide();
                        if (action.callback) action.callback();
                    });
                    actionsEl.appendChild(btn);
                });
                actionsEl.style.display = 'flex';
            } else if (options.duration === 0) {
                // Manual-dismiss modal with no custom actions: provide a default OK button.
                const btn = document.createElement('button');
                btn.className = 'modal-action-btn primary';
                btn.textContent = 'OK';
                btn.addEventListener('click', () => this.hide());
                actionsEl.appendChild(btn);
                actionsEl.style.display = 'flex';
            } else {
                actionsEl.style.display = 'none';
            }
        }

        // Escape/dismiss routing: for a dialog with actions (confirm), Escape
        // means Cancel - invoke the secondary action's callback (else the last)
        // so the confirm() promise resolves - otherwise Escape just hides.
        if (options.actions && options.actions.length > 0) {
            const cancel = options.actions.find(a => a.secondary) ||
                options.actions[options.actions.length - 1];
            this._dismissHandler = () => { this.hide(); if (cancel.callback) cancel.callback(); };
        } else {
            this._dismissHandler = () => this.hide();
        }

        // ARIA: mark the dialog and point AT its title/message. Must-acknowledge
        // modals (duration 0: error/confirm) are alertdialogs; transient toasts
        // are plain dialogs. Only capture the prior focus on a fresh open, so
        // re-showing over an already-open modal keeps the original anchor.
        const content = this.modalElement.querySelector('.modal-content');
        if (content) {
            content.setAttribute('role', options.duration === 0 ? 'alertdialog' : 'dialog');
            content.setAttribute('aria-modal', 'true');
            content.setAttribute('aria-describedby', 'modalMessage');
            if (options.title) content.setAttribute('aria-labelledby', 'modalTitle');
            else content.removeAttribute('aria-labelledby');
        }

        const wasVisible = this.modalElement.classList.contains('visible');
        if (!wasVisible) this._previouslyFocused = document.activeElement;

        this.modalElement.classList.add('visible');

        // Move focus into the dialog (primary button if any, else the first
        // focusable, else the content itself) so keyboard/screen-reader users
        // land inside it instead of on the now-inert page behind.
        const primary = actionsEl && actionsEl.querySelector('.modal-action-btn.primary');
        const target = primary ||
            (this.modalElement.querySelector('.modal-content button, .modal-content summary')) ||
            content;
        if (target) {
            if (target === content) target.setAttribute('tabindex', '-1');
            target.focus();
        }

        if (options.duration > 0) {
            this.timeoutId = setTimeout(() => {
                this.hide();
            }, options.duration);
        }

        // Allow click-outside dismissal only for transient (auto-dismiss) modals;
        // errors/confirms must be acknowledged explicitly.
        this.dismissOnBackdrop = options.duration > 0;
    }

    /** Hide the modal. */
    hide() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        if (this.modalElement) {
            this.modalElement.classList.remove('visible');
        }

        // Restore focus to whatever was focused before the modal opened, so
        // keyboard focus doesn't jump to the top of the page on dismiss.
        if (this._previouslyFocused && typeof this._previouslyFocused.focus === 'function') {
            this._previouslyFocused.focus();
        }
        this._previouslyFocused = null;
    }

    /** Escape HTML to prevent XSS when rendering details/messages. */
    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

window.errorModal = new ErrorModal();

// Convenience functions used throughout the app.
window.showError = (message, options) => window.errorModal.error(message, options);
window.showWarning = (message, options) => window.errorModal.warning(message, options);
window.showSuccess = (message, options) => window.errorModal.success(message, options);
window.showInfo = (message, options) => window.errorModal.info(message, options);
window.showConfirm = (message, options) => window.errorModal.confirm(message, options);

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ErrorModal;
}
