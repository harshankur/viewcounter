/**
 * A password dialog over the current page, for the two times the admin UI
 * needs the password without leaving what the admin was doing: signing in
 * again after a session ends, and confirming an action that cannot be undone.
 */

import { ApiError } from './api.js';
import { el, uniqueId } from './dom.js';
import { t } from './i18n.js';
import { openModal, VARIANT } from './modal.js';
import { ERROR_CODE } from './constants.js';

/**
 * @param {{ title: string, message: string, submitLabel: string,
 *   submit: (password: string) => Promise<void> }} options
 * @returns {Promise<boolean>} whether `submit` succeeded; false if cancelled
 */
export function promptPassword({ title, message, submitLabel, submit }) {
    return new Promise((resolve) => {
        const inputId = uniqueId('password');
        const input = el('input', {
            className: 'input',
            attrs: { id: inputId, type: 'password', autocomplete: 'current-password', required: 'true' },
        });
        const error = el('p', { className: 'field-error', attrs: { role: 'alert' } });
        error.hidden = true;
        let settled = false;

        const attempt = async () => {
            if (!input.value) {
                input.focus();
                return false;
            }
            try {
                await submit(input.value);
                settled = true;
                resolve(true);
                return true;
            } catch (failure) {
                const code = failure instanceof ApiError ? failure.code : ERROR_CODE.SERVER_ERROR;
                error.textContent = t(`errors.${code}`);
                error.hidden = false;
                input.select();
                return false;
            }
        };

        const dialog = openModal({
            title,
            body: [
                el('p', { text: message }),
                el('label', { className: 'field-label', text: t('login.password'), attrs: { for: inputId } }),
                input,
                error,
            ],
            actions: [
                { label: t('common.cancel'), variant: VARIANT.SECONDARY },
                { label: submitLabel, variant: VARIANT.PRIMARY, onClick: attempt },
            ],
            onCancel: () => { if (!settled) resolve(false); },
            initialFocus: input,
        });

        // Enter submits, as on the sign-in screen.
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            dialog.querySelector('.modal-actions .btn-primary')?.click();
        });
        // A cancel button that closes the dialog is a cancel, too.
        dialog.querySelector('.modal-actions .btn-secondary')?.addEventListener('click', () => {
            if (!settled) resolve(false);
        });
    });
}
