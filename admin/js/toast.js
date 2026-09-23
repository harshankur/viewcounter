/**
 * Non-blocking notices (FRONTEND.md §2): the same shape as the modal, one
 * helper and one root. Errors interrupt (role=alert); everything else is
 * polite (role=status).
 */

import { byId, el } from './dom.js';
import { TOAST_DURATION_MS } from './constants.js';
import { t } from './i18n.js';

export const TOAST_TYPE = Object.freeze({
    SUCCESS: 'success',
    ERROR: 'error',
    INFO: 'info',
});

/**
 * @param {string} message
 * @param {string} [type]
 */
export function showToast(message, type = TOAST_TYPE.INFO) {
    const toast = el('div', {
        className: `toast toast-${type}`,
        attrs: { role: type === TOAST_TYPE.ERROR ? 'alert' : 'status' },
    }, [
        el('span', { className: 'toast-prompt', text: '❯', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'toast-message', text: message }),
    ]);

    const dismiss = () => {
        toast.classList.add('toast-leaving');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // Reduced-motion users get no animation, so no animationend either.
        setTimeout(() => toast.remove(), TOAST_DURATION_MS);
    };

    toast.append(el('button', {
        className: 'icon-btn toast-close',
        text: '×',
        attrs: { type: 'button', 'aria-label': t('common.dismiss') },
        on: { click: dismiss },
    }));

    byId('toast-root').append(toast);
    setTimeout(dismiss, TOAST_DURATION_MS);
    return toast;
}
