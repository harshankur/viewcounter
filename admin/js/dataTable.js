/**
 * A data table whose columns the admin chooses, orders, and sizes.
 *
 * The admin picks which columns matter, and in what order. The table then
 * shows as many of them as fit its width, in that order, and keeps the rest
 * of each row one tap away, under it. A wider window shows more columns, a
 * narrow one fewer, a phone shows the first few as a card, and nothing ever
 * scrolls sideways (FRONTEND.md §12: reflow, never a horizontal scrollbar).
 *
 * Column edges drag to resize, by mouse, touch, or keyboard. Choices are
 * remembered per table in this browser.
 */

import { el, replaceChildren, uniqueId } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { openModal, VARIANT } from './modal.js';
import { KEY, SORT_ORDER, STORAGE_KEY, TABLE } from './constants.js';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * What a table remembers: the columns in the admin's order, which of them are
 * hidden, and any widths set by hand.
 * @param {string} storageKey
 * @param {Array<{ id: string, hidden?: boolean }>} columns
 */
function loadPreferences(storageKey, columns) {
    const defaults = () => ({
        order: columns.map((column) => column.id),
        hidden: new Set(columns.filter((column) => column.hidden).map((column) => column.id)),
        widths: {},
    });
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY.TABLE_PREFIX + storageKey));
        if (!stored || !Array.isArray(stored.order)) return { ...defaults(), defaults };
        const known = new Set(columns.map((column) => column.id));
        const order = stored.order.filter((id) => known.has(id));
        const hidden = new Set((stored.hidden || []).filter((id) => known.has(id)));
        // A column added since the choice was saved joins where it sits by
        // default, shown or hidden as it is by default.
        columns.forEach((column, index) => {
            if (order.includes(column.id)) return;
            order.splice(Math.min(index, order.length), 0, column.id);
            if (column.hidden) hidden.add(column.id);
        });
        const widths = {};
        for (const [id, width] of Object.entries(stored.widths || {})) {
            if (known.has(id) && Number.isFinite(width)) widths[id] = width;
        }
        return { order, hidden, widths, defaults };
    } catch {
        return { ...defaults(), defaults };
    }
}

function savePreferences(storageKey, { order, hidden, widths }) {
    try {
        localStorage.setItem(STORAGE_KEY.TABLE_PREFIX + storageKey, JSON.stringify({ order, hidden: [...hidden], widths }));
    } catch {
        // Storage blocked: the choice lasts until the page is reloaded.
    }
}

/**
 * @param {{
 *   storageKey: string,
 *   columns: Array<{ id: string, label: string, width: number, minWidth?: number, grow?: boolean, hidden?: boolean,
 *     sortKey?: string, available?: () => boolean, cell: (row: object) => Array<Node|string|null> }>,
 *   rowKey: (row: object) => string,
 *   rowAttrs?: (row: object) => { className?: string, dataset?: Record<string, string> },
 *   select?: { header: () => Node, cell: (row: object) => Node },
 *   actions?: { label: string, width: number, cell: (row: object) => Node },
 *   sort?: () => { key: string, order: string }, onSort?: (key: string) => void,
 *   empty: () => string, className?: string, id?: string,
 * }} options
 *   `columns` are in their default order; `hidden` ones start unchosen; the
 *   first shown column with `grow` takes the spare width.
 */
export function createDataTable({
    storageKey, columns, rowKey, rowAttrs = () => ({}), select, actions, sort, onSort, empty, className = '', id,
}) {
    const byId = new Map(columns.map((column) => [column.id, column]));
    const prefs = loadPreferences(storageKey, columns);
    const state = { rows: [], expanded: new Set(), signature: '', layout: null, focusHandle: null };
    let afterRender = () => {};

    const thead = el('thead');
    const tbody = el('tbody');
    const table = el('table', { className: `data-table ${className}`.trim(), attrs: { id: id ?? null } }, [thead, tbody]);
    const wrap = el('div', { className: 'table-wrap' }, [table]);

    const minWidthOf = (column) => column.minWidth ?? TABLE.MIN_WIDTH;
    const widthOf = (column) => clamp(prefs.widths[column.id] ?? column.width, minWidthOf(column), TABLE.MAX_WIDTH);
    const chosenColumns = () => prefs.order
        .filter((columnId) => !prefs.hidden.has(columnId))
        .map((columnId) => byId.get(columnId))
        .filter((column) => column && (column.available ? column.available() : true));

    /**
     * Which chosen columns fit, in order; the rest go under each row. Below
     * the card width, the first few are a card and the rest go under it.
     */
    function computeLayout() {
        const available = wrap.clientWidth;
        if (!available) return null;
        const chosen = chosenColumns();
        if (available < TABLE.CARDS_BELOW) {
            return { cards: true, shown: chosen.slice(0, TABLE.CARD_FIELDS), more: chosen.slice(TABLE.CARD_FIELDS), fill: null };
        }
        const fixed = (select ? TABLE.SELECT_WIDTH : 0) + (actions ? actions.width : 0);
        const fit = (reserved) => {
            let used = fixed + reserved;
            const shown = [];
            for (const column of chosen) {
                const width = widthOf(column);
                // The first column always shows; after it, strictly in order.
                if (shown.length && used + width > available) break;
                shown.push(column);
                used += width;
            }
            return shown;
        };
        let shown = fit(0);
        if (shown.length < chosen.length) shown = fit(TABLE.MORE_WIDTH);
        return { cards: false, shown, more: chosen.slice(shown.length), fill: shown.find((column) => column.grow) ?? shown.at(-1) ?? null };
    }

    // ---- Head ---------------------------------------------------------------

    function headerCell(column, layout) {
        const current = sort ? sort() : null;
        const sortable = Boolean(column.sortKey && onSort);
        const active = sortable && current?.key === column.sortKey;
        const ascending = current?.order === SORT_ORDER.ASC;
        const label = sortable
            ? el('button', {
                className: `sort-btn${active ? ' active' : ''}`,
                attrs: { type: 'button' },
                dataset: { sortKey: column.sortKey },
                on: { click: () => onSort(column.sortKey) },
            }, [el('span', { text: column.label }), icon(active ? (ascending ? 'arrowUp' : 'arrowDown') : 'sort', { className: 'sort-indicator' })])
            : el('span', { className: 'th-label', text: column.label });

        const th = el('th', {
            className: `col-${column.id}`,
            attrs: { scope: 'col', 'aria-sort': sortable ? (active ? (ascending ? 'ascending' : 'descending') : 'none') : null },
            dataset: { column: column.id },
        }, [label, layout.cards ? null : resizeHandle(column)]);
        if (!layout.cards && column !== layout.fill) th.style.width = `${widthOf(column)}px`;
        return th;
    }

    /** The draggable right edge of a header: pointer, touch, or arrow keys. */
    function resizeHandle(column) {
        const handle = el('span', {
            className: 'resize-handle',
            attrs: {
                role: 'separator',
                tabindex: 0,
                'aria-orientation': 'vertical',
                'aria-label': t('table.resize', { column: column.label }),
                'aria-valuemin': minWidthOf(column),
                'aria-valuemax': TABLE.MAX_WIDTH,
                'aria-valuenow': Math.round(widthOf(column)),
                title: t('table.resizeHint'),
            },
            dataset: { resize: column.id },
        });
        const setWidth = (width) => {
            prefs.widths[column.id] = clamp(Math.round(width), minWidthOf(column), TABLE.MAX_WIDTH);
            savePreferences(storageKey, prefs);
            // A rebuild replaces this handle; a keyboard user keeps their place.
            state.focusHandle = document.activeElement === handle ? column.id : null;
            refresh();
        };
        const reset = () => {
            delete prefs.widths[column.id];
            savePreferences(storageKey, prefs);
            state.focusHandle = column.id;
            refresh();
        };

        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            // Start from the width on screen: the column taking the spare room
            // is wider than the width it asks for.
            const startWidth = handle.parentElement.getBoundingClientRect().width;
            const startX = event.clientX;
            document.body.classList.add('resizing-column');
            const onMove = (move) => setWidth(startWidth + (move.clientX - startX));
            const onUp = () => {
                document.body.classList.remove('resizing-column');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        });
        handle.addEventListener('dblclick', reset);
        handle.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? TABLE.RESIZE_STEP_LARGE : TABLE.RESIZE_STEP;
            const current = handle.parentElement.getBoundingClientRect().width;
            if (event.key === KEY.ARROW_RIGHT) setWidth(current + step);
            else if (event.key === KEY.ARROW_LEFT) setWidth(current - step);
            else if (event.key === KEY.HOME) setWidth(minWidthOf(column));
            else if (event.key === KEY.ENTER) reset();
            else return;
            event.preventDefault();
        });
        return handle;
    }

    function renderHead(layout) {
        const cells = [];
        if (select) {
            const th = el('th', { className: 'col-select', attrs: { scope: 'col' } }, [select.header()]);
            th.style.width = `${TABLE.SELECT_WIDTH}px`;
            cells.push(th);
        }
        if (layout.more.length && !layout.cards) {
            const all = state.rows.length > 0 && state.rows.every((row) => state.expanded.has(rowKey(row)));
            const names = layout.more.map((column) => column.label).join(', ');
            const th = el('th', { className: 'col-more', attrs: { scope: 'col' } }, [el('button', {
                className: 'icon-btn more-toggle',
                attrs: {
                    type: 'button',
                    'aria-expanded': String(all),
                    'aria-label': t(all ? 'table.hideMoreAll' : 'table.showMoreAll', { columns: names }),
                    title: t(all ? 'table.hideMoreAll' : 'table.showMoreAll', { columns: names }),
                },
                on: { click: () => {
                    if (all) state.expanded.clear();
                    else for (const row of state.rows) state.expanded.add(rowKey(row));
                    render();
                    thead.querySelector('.more-toggle')?.focus();
                } },
            }, [icon(all ? 'chevronDown' : 'chevronRight')])]);
            th.style.width = `${TABLE.MORE_WIDTH}px`;
            cells.push(th);
        }
        cells.push(...layout.shown.map((column) => headerCell(column, layout)));
        if (actions) {
            const th = el('th', { className: 'col-actions', text: actions.label, attrs: { scope: 'col' } });
            th.style.width = `${actions.width}px`;
            cells.push(th);
        }
        replaceChildren(thead, [el('tr', {}, cells)]);
    }

    // ---- Rows ---------------------------------------------------------------

    function moreButton(row, layout, key) {
        const open = state.expanded.has(key);
        const labelKey = open ? 'table.hideMore' : 'table.showMore';
        return el('button', {
            className: layout.cards ? 'btn btn-ghost btn-small more-toggle' : 'icon-btn more-toggle',
            attrs: {
                type: 'button',
                'aria-expanded': String(open),
                'aria-label': t(labelKey, { count: layout.more.length }),
                title: layout.cards ? null : t(labelKey, { count: layout.more.length }),
            },
            on: { click: () => {
                if (open) state.expanded.delete(key);
                else state.expanded.add(key);
                render();
                [...tbody.querySelectorAll('tr[data-row-key]')].find((tr) => tr.dataset.rowKey === key)
                    ?.querySelector('.more-toggle')?.focus();
            } },
        }, [icon(open ? 'chevronDown' : 'chevronRight'), layout.cards ? el('span', { text: t(labelKey, { count: layout.more.length }) }) : null]);
    }

    function renderRow(row, layout, columnCount) {
        const key = rowKey(row);
        const { className: rowClass = '', dataset = {} } = rowAttrs(row);
        const cells = [];
        if (select) cells.push(el('td', { className: 'col-select' }, [select.cell(row)]));
        const more = layout.more.length ? el('td', { className: 'col-more' }, [moreButton(row, layout, key)]) : null;
        if (more && !layout.cards) cells.push(more);
        for (const column of layout.shown) {
            cells.push(el('td', { className: `col-${column.id}`, dataset: { label: column.label } }, column.cell(row)));
        }
        if (more && layout.cards) cells.push(more);
        if (actions) cells.push(el('td', { className: 'col-actions' }, [actions.cell(row)]));

        const rows = [el('tr', { className: rowClass, dataset: { ...dataset, rowKey: key } }, cells)];
        if (layout.more.length && state.expanded.has(key)) {
            // What did not fit, in the admin's order, under the row it belongs to.
            rows.push(el('tr', { className: `row-more ${rowClass}`.trim() }, [el('td', { attrs: { colspan: String(columnCount) } }, [
                el('dl', { className: 'more-list' }, layout.more.flatMap((column) => [
                    el('dt', { text: column.label }),
                    el('dd', { className: `col-${column.id}` }, column.cell(row)),
                ])),
            ])]));
        }
        return rows;
    }

    function render() {
        const layout = computeLayout();
        if (!layout) return;
        state.layout = layout;
        state.signature = signatureOf(layout);
        table.classList.toggle('cards', layout.cards);
        table.classList.toggle('has-more', layout.more.length > 0);
        renderHead(layout);
        const columnCount = layout.shown.length + (select ? 1 : 0) + (actions ? 1 : 0) + (layout.more.length ? 1 : 0);
        if (state.rows.length === 0) {
            replaceChildren(tbody, [el('tr', {}, [el('td', { className: 'table-message', text: empty(), attrs: { colspan: String(columnCount) } })])]);
        } else {
            replaceChildren(tbody, state.rows.flatMap((row) => renderRow(row, layout, columnCount)));
        }
        if (state.focusHandle) {
            thead.querySelector(`[data-resize="${state.focusHandle}"]`)?.focus({ preventScroll: true });
            state.focusHandle = null;
        }
        afterRender();
    }

    const signatureOf = (layout) => [
        layout.cards ? 'cards' : 'table',
        layout.shown.map((column) => column.id).join(','),
        layout.more.map((column) => column.id).join(','),
        layout.fill?.id ?? '',
    ].join('|');

    /**
     * Re-fit after the width, or a column's width, changed. Rebuilds only when
     * what is shown changes; otherwise it just sets widths, so dragging an
     * edge stays smooth.
     */
    function refresh() {
        const layout = computeLayout();
        if (!layout) return;
        if (signatureOf(layout) !== state.signature) {
            render();
            return;
        }
        state.layout = layout;
        for (const column of layout.shown) {
            const th = thead.querySelector(`th[data-column="${column.id}"]`);
            if (!th) continue;
            th.style.width = layout.cards || column === layout.fill ? '' : `${widthOf(column)}px`;
            th.querySelector('.resize-handle')?.setAttribute('aria-valuenow', String(Math.round(widthOf(column))));
        }
        if (state.focusHandle) {
            thead.querySelector(`[data-resize="${state.focusHandle}"]`)?.focus({ preventScroll: true });
            state.focusHandle = null;
        }
    }

    let frame = null;
    new ResizeObserver(() => {
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
            frame = null;
            refresh();
        });
    }).observe(wrap);

    // ---- Choosing columns ---------------------------------------------------

    function openChooser() {
        let draft = { order: [...prefs.order], hidden: new Set(prefs.hidden), widths: { ...prefs.widths } };
        const list = el('ol', { className: 'column-chooser' });
        const error = el('p', { className: 'field-error', attrs: { role: 'alert' } });
        error.hidden = true;

        function renderList(focus) {
            replaceChildren(list, draft.order.map((columnId, index) => {
                const column = byId.get(columnId);
                const checkbox = el('input', {
                    attrs: { type: 'checkbox' },
                    on: { change: (event) => {
                        if (event.currentTarget.checked) draft.hidden.delete(columnId);
                        else draft.hidden.add(columnId);
                        error.hidden = true;
                    } },
                });
                checkbox.checked = !draft.hidden.has(columnId);
                const move = (delta, labelKey, iconName) => el('button', {
                    className: 'icon-btn',
                    attrs: {
                        type: 'button',
                        'aria-label': t(labelKey, { column: column.label }),
                        title: t(labelKey, { column: column.label }),
                        disabled: index + delta < 0 || index + delta >= draft.order.length,
                    },
                    dataset: { move: `${columnId}:${delta}` },
                    on: { click: () => {
                        const order = [...draft.order];
                        [order[index], order[index + delta]] = [order[index + delta], order[index]];
                        draft.order = order;
                        renderList(`${columnId}:${delta}`);
                    } },
                }, [icon(iconName)]);
                const unavailable = column.available && !column.available();
                return el('li', { className: 'column-choice', dataset: { column: columnId } }, [
                    el('label', { className: 'column-choice-label' }, [
                        checkbox,
                        el('span', { text: column.label }),
                        unavailable && column.unavailableNote ? el('span', { className: 'column-choice-note', text: column.unavailableNote }) : null,
                    ]),
                    move(-1, 'table.moveUp', 'arrowUp'),
                    move(1, 'table.moveDown', 'arrowDown'),
                ]);
            }));
            if (focus) {
                // Keep the focus on the button just used, or its twin at an end of the list.
                const [columnId, delta] = focus.split(':');
                const same = list.querySelector(`[data-move="${columnId}:${delta}"]`);
                (same && !same.disabled ? same : list.querySelector(`[data-move="${columnId}:${-Number(delta)}"]`))?.focus();
            }
        }
        renderList();

        openModal({
            title: t('table.columnsTitle'),
            body: [el('p', { className: 'modal-message', text: t('table.columnsIntro') }), list, error],
            actions: [
                { label: t('table.columnsReset'), onClick: () => {
                    const fresh = prefs.defaults();
                    draft = { order: fresh.order, hidden: fresh.hidden, widths: {} };
                    error.hidden = true;
                    renderList();
                    return false;
                } },
                { label: t('common.cancel') },
                { label: t('table.columnsApply'), variant: VARIANT.PRIMARY, onClick: () => {
                    if (draft.order.every((columnId) => draft.hidden.has(columnId))) {
                        error.textContent = t('table.columnsNone');
                        error.hidden = false;
                        return false;
                    }
                    prefs.order = draft.order;
                    prefs.hidden = draft.hidden;
                    prefs.widths = draft.widths;
                    savePreferences(storageKey, prefs);
                    render();
                    return true;
                } },
            ],
        });
    }

    const chooserId = uniqueId('columns-button');
    const chooserButton = el('button', {
        className: 'btn btn-secondary btn-small columns-button',
        attrs: { type: 'button', id: chooserId, 'aria-haspopup': 'dialog' },
        on: { click: openChooser },
    }, [icon('columns'), el('span', { text: t('table.columns') })]);

    return {
        /** The bordered box holding the table. */
        element: wrap,
        table,
        /** The "Columns" button, for the toolbar's view controls. */
        chooserButton,
        /** Show these rows. Rows that are gone lose their expanded state. */
        setRows(rows) {
            state.rows = rows;
            const keys = new Set(rows.map(rowKey));
            for (const key of state.expanded) if (!keys.has(key)) state.expanded.delete(key);
            render();
        },
        /** Redraw as is: after a sort change, or when a column's availability changed. */
        render,
        /** Run after every redraw, for state the caller keeps on the rows (a selection, say). */
        onRender(callback) {
            afterRender = callback;
        },
        /** The sort header button for a key, to return focus to it after sorting. */
        sortButton: (key) => thead.querySelector(`[data-sort-key="${key}"]`),
    };
}
