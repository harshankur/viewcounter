/**
 * Pieces shared by every data table: sortable headers, the pager, and the
 * empty and loading states.
 */

import { el, replaceChildren } from './dom.js';
import { formatNumber } from './format.js';
import { t } from './i18n.js';
import { SORT_ORDER } from './constants.js';

/**
 * A header cell. Sortable headers are buttons, so they are reachable and
 * operable by keyboard, and expose the sort through aria-sort.
 *
 * @param {{ label: string, sortKey?: string, sort?: string, order?: string,
 *   onSort?: (key: string) => void, className?: string }} options
 */
export function headerCell({ label, sortKey, sort, order, onSort, className = '' }) {
    if (!sortKey) return el('th', { className, text: label, attrs: { scope: 'col' } });

    const active = sort === sortKey;
    const ariaSort = active ? (order === SORT_ORDER.ASC ? 'ascending' : 'descending') : 'none';
    const indicator = active ? (order === SORT_ORDER.ASC ? '▲' : '▼') : '↕';

    return el('th', { className, attrs: { scope: 'col', 'aria-sort': ariaSort } }, [
        el('button', {
            className: `sort-btn${active ? ' active' : ''}`,
            attrs: { type: 'button' },
            dataset: { sortKey },
            on: { click: () => onSort(sortKey) },
        }, [
            el('span', { text: label }),
            el('span', { className: 'sort-indicator', text: indicator, attrs: { 'aria-hidden': 'true' } }),
        ]),
    ]);
}

/** A full-width row for empty or loading states. */
export function messageRow(columns, text, className = 'table-message') {
    return el('tr', {}, [el('td', { className, text, attrs: { colspan: String(columns) } })]);
}

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

    return { element: group, getValue: () => current };
}
