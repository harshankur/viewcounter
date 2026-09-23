/**
 * The one blocking dialog (FRONTEND.md §1.1 and §2).
 *
 * Replaces alert/confirm/prompt everywhere. Rendered once into #modal-root.
 * By construction, not by each call site remembering:
 *  - a backdrop blocks the page and focus is trapped inside the dialog,
 *  - Escape and a backdrop click run the SAME cancel handler, which is always
 *    the safest option, never the destructive one,
 *  - focus returns to whatever opened the dialog.
 */

import { byId, clear, el, focusableWithin, uniqueId } from './dom.js';
import { KEY } from './constants.js';
import { t } from './i18n.js';

/** Visual weight of a dialog button. */
export const VARIANT = Object.freeze({
    PRIMARY: 'primary',
    SECONDARY: 'secondary',
    DANGER: 'danger',
});

let active = null;

function root() {
    return byId('modal-root');
}

function trapFocus(event, dialog) {
    if (event.key !== KEY.TAB) return;
    const focusable = focusableWithin(dialog);
    if (focusable.length === 0) {
        event.preventDefault();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

/** Close the open dialog without running any handler. */
export function closeModal() {
    if (!active) return;
    const { opener, onKeydown } = active;
    document.removeEventListener('keydown', onKeydown, true);
    clear(root());
    root().hidden = true;
    document.body.classList.remove('modal-open');
    active = null;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
}

/**
 * Open a dialog.
 *
 * @param {{ title: string, body: Node|Node[], actions: Array<{ label: string, variant?: string,
 *   onClick?: () => (boolean|void|Promise<boolean|void>) }>, onCancel?: () => void,
 *   role?: 'dialog'|'alertdialog', initialFocus?: HTMLElement, wide?: boolean }} options
 *   An action's onClick may return false to keep the dialog open (for example
 *   when a form does not validate). The first action with variant SECONDARY
 *   labelled as cancel is not special: cancel is `onCancel`, always.
 */
export function openModal({ title, body, actions, onCancel = () => {}, role = 'dialog', initialFocus, wide = false }) {
    closeModal();

    const titleId = uniqueId('modal-title');
    const cancel = () => {
        closeModal();
        onCancel();
    };

    const buttons = actions.map((action) => el('button', {
        className: `btn btn-${action.variant || VARIANT.SECONDARY}`,
        text: action.label,
        attrs: { type: 'button' },
        on: {
            click: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                    const keepOpen = action.onClick ? (await action.onClick()) === false : false;
                    if (!keepOpen) closeModal();
                } finally {
                    button.disabled = false;
                }
            },
        },
    }));

    const dialog = el('div', {
        className: `modal term-window${wide ? ' modal-wide' : ''}`,
        attrs: { role, 'aria-modal': 'true', 'aria-labelledby': titleId },
    }, [
        el('div', { className: 'term-titlebar' }, [
            el('div', { className: 'term-dots', attrs: { 'aria-hidden': 'true' } }, [
                el('span', { className: 'term-dot red' }),
                el('span', { className: 'term-dot amber' }),
                el('span', { className: 'term-dot green' }),
            ]),
            el('h2', { className: 'modal-title', text: title, attrs: { id: titleId } }),
            el('button', {
                className: 'icon-btn modal-close',
                text: '×',
                attrs: { type: 'button', 'aria-label': t('common.close') },
                on: { click: cancel },
            }),
        ]),
        el('div', { className: 'modal-body' }, Array.isArray(body) ? body : [body]),
        el('div', { className: 'modal-actions' }, buttons),
    ]);

    const backdrop = el('div', { className: 'modal-backdrop', on: { mousedown: (event) => {
        if (event.target === event.currentTarget) cancel();
    } } }, [dialog]);

    const onKeydown = (event) => {
        if (event.key === KEY.ESCAPE) {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
        }
        trapFocus(event, dialog);
    };

    active = { opener: document.activeElement, onKeydown };
    document.addEventListener('keydown', onKeydown, true);
    root().append(backdrop);
    root().hidden = false;
    document.body.classList.add('modal-open');

    const target = initialFocus || focusableWithin(dialog.querySelector('.modal-body'))[0] || buttons[buttons.length - 1];
    target?.focus();
    return dialog;
}

/**
 * A yes/no confirmation. Resolves true only when the confirm button is used;
 * Escape, the backdrop, the close button, and Cancel all resolve false.
 *
 * @param {{ title: string, message: string, confirmLabel: string, danger?: boolean,
 *   detail?: Node }} options
 * @returns {Promise<boolean>}
 */
export function confirmModal({ title, message, confirmLabel, danger = false, detail }) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const cancelButtonFirst = { label: t('common.cancel'), variant: VARIANT.SECONDARY, onClick: () => settle(false) };
        openModal({
            title,
            role: 'alertdialog',
            body: [el('p', { className: 'modal-message', text: message }), detail].filter(Boolean),
            actions: [
                cancelButtonFirst,
                { label: confirmLabel, variant: danger ? VARIANT.DANGER : VARIANT.PRIMARY, onClick: () => settle(true) },
            ],
            onCancel: () => settle(false),
        });
    });
}
