/**
 * Controls shared by the tables: the pager and the segmented control. The
 * table itself is dataTable.js.
 */

import { el, replaceChildren } from './dom.js';
import { formatNumber } from './format.js';
import { t } from './i18n.js';

/**
 * Previous / next pagination with a live summary.
 * @param {(page: number) => void} onChange
 */
export function createPager(onChange) {
    let page = 1;
    let pages = 1;

    const summary = el('span', { className: 'pager-summary', attrs: { 'aria-live': 'polite' } });
    const prev = el('button', {
        className: 'btn btn-secondary btn-small',
        text: t('pager.previous'),
        attrs: { type: 'button' },
        on: { click: () => page > 1 && onChange(page - 1) },
    });
    const next = el('button', {
        className: 'btn btn-secondary btn-small',
        text: t('pager.next'),
        attrs: { type: 'button' },
        on: { click: () => page < pages && onChange(page + 1) },
    });

    const element = el('div', { className: 'pager' }, [prev, summary, next]);

    return {
        element,
        /** @param {number} currentPage @param {number} pageSize @param {number} total */
        update(currentPage, pageSize, total) {
            page = currentPage;
            pages = Math.max(1, Math.ceil(total / pageSize));
            prev.disabled = page <= 1;
            next.disabled = page >= pages;
            replaceChildren(summary, [t('pager.summary', {
                page: formatNumber(page),
                pages: formatNumber(pages),
                total: formatNumber(total),
                count: total,
            })]);
        },
    };
}

/** A segmented control: one pressed button among several (a single choice). */
export function createSegmented({ label, options, value, onChange }) {
    let current = value;
    const buttons = new Map();
    const group = el('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': label } });

    const render = () => {
        for (const [key, button] of buttons) {
            const active = key === current;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }
    };

    for (const option of options) {
        const button = el('button', {
            className: 'segmented-btn',
            text: option.label,
            attrs: { type: 'button' },
            on: {
                click: () => {
                    if (current === option.value) return;
                    current = option.value;
                    render();
                    onChange(current);
                },
            },
        });
        buttons.set(option.value, button);
        group.append(button);
    }
    render();

    return {
        element: group,
        getValue: () => current,
        /** Show a value chosen elsewhere, without reporting it as a change. */
        setValue(value) {
            current = value;
            render();
        },
    };
}
