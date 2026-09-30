/**
 * The views table, used twice: the Views tab (live rows, optionally with the
 * trashed ones shown inline) and the Trash tab (trashed rows only). These
 * rows are the data every statistic on the Overview is computed from.
 *
 * Selection is a set of view IDs that survives paging, so a batch can span
 * pages, and is cleared whenever the query changes shape (app, filter,
 * search) so an action can never reach rows the admin can no longer see.
 */

import { api } from './api.js';
import { appEntries, createAppTabs } from './appTabs.js';
import { clampText } from './clamp.js';
import { el, replaceChildren, debounce, uniqueId } from './dom.js';
import { formatDateTime, formatNumber, orNone } from './format.js';
import { icon } from './icons.js';
import { t, tOr } from './i18n.js';
import { createListbox } from './listbox.js';
import { confirmModal } from './modal.js';
import { createPager, createSegmented, headerCell, messageRow, timeCell } from './table.js';
import { showToast, TOAST_TYPE } from './toast.js';
import { openDetails, openEditor, openNoteEditor } from './viewDialogs.js';
import { valueLabel } from './overview.js';
import {
    ALL_APPS,
    CLAMP_LINES,
    RANGE,
    MODIFIED_FILTER,
    SEARCH_DEBOUNCE_MS,
    SORT_ORDER,
    VIEW_STATUS,
} from './constants.js';

/** Which rows a panel shows. */
export const PANEL_MODE = Object.freeze({
    VIEWS: 'views',
    TRASH: 'trash',
});

/** Columns in display order; `sort` names the API sort key. */
const COLUMNS = [
    { key: 'timestamp', sort: 'timestamp', className: 'col-time' },
    { key: 'app', className: 'col-app' },
    { key: 'page', sort: 'page', className: 'col-page' },
    { key: 'source', sort: 'source', className: 'col-source' },
    { key: 'device', sort: 'deviceSize', className: 'col-device' },
    { key: 'country', sort: 'country', className: 'col-country' },
    { key: 'client', sort: 'browser', className: 'col-client' },
    { key: 'event', sort: 'eventType', className: 'col-event' },
    { key: 'status', className: 'col-status' },
    { key: 'actions', className: 'col-actions' },
];
/** Plus the selection column. */
const COLUMN_COUNT = COLUMNS.length + 1;

/**
 * @param {{ mode: string, meta: object, context: { apps: () => object[], appId: () => string,
 *   setAppId: (id: string) => void, refreshApps: () => Promise<void>, reportError: (error: unknown) => void,
 *   viewsChanged: () => void } }} deps
 */
export function createViewsPanel({ mode, meta, context }) {
    const isTrash = mode === PANEL_MODE.TRASH;
    const state = {
        showDeleted: false,
        modified: MODIFIED_FILTER.ANY,
        range: RANGE.ALL,
        eventType: '',
        knownEventTypes: [],
        /** Breakdown values carried over from the Overview, such as one country. */
        where: {},
        search: '',
        sort: isTrash ? 'deletedAt' : 'timestamp',
        order: SORT_ORDER.DESC,
        page: 1,
        pageSize: meta.pageSizeDefault,
        total: 0,
        rows: [],
        selection: new Map(),
        requestSeq: 0,
        focusSort: null,
    };

    const status = () => {
        if (isTrash) return VIEW_STATUS.DELETED;
        return state.showDeleted ? VIEW_STATUS.ALL : VIEW_STATUS.ACTIVE;
    };

    /** The filters of the listing, the same the Overview's analysis takes. */
    const filters = () => ({
        status: status(),
        modified: state.modified,
        range: state.range,
        eventType: state.eventType,
        where: state.where,
        search: state.search,
    });

    // ---- Toolbar -----------------------------------------------------------

    const tableId = uniqueId('views-table');
    const appTabs = createAppTabs({ context, controls: tableId, trash: isTrash });

    const searchInput = el('input', {
        className: 'input search-input',
        attrs: {
            type: 'search',
            placeholder: t('toolbar.searchPlaceholder'),
            'aria-label': t('toolbar.search'),
            maxlength: meta.searchMaxLength,
        },
        on: { input: debounce(() => {
            state.search = searchInput.value.trim();
            resetAndLoad();
        }, SEARCH_DEBOUNCE_MS) },
    });

    const modifiedFilter = createSegmented({
        label: t('toolbar.modifiedFilter'),
        value: MODIFIED_FILTER.ANY,
        options: Object.values(MODIFIED_FILTER).map((value) => ({ value, label: t(`modifiedFilter.${value}`) })),
        onChange: (value) => {
            state.modified = value;
            resetAndLoad();
        },
    });

    const showDeletedToggle = el('input', {
        className: 'switch-input',
        attrs: { type: 'checkbox', role: 'switch' },
        on: { change: () => {
            state.showDeleted = showDeletedToggle.checked;
            resetAndLoad();
        } },
    });

    const rangeFilter = createSegmented({
        label: t('toolbar.range'),
        value: RANGE.ALL,
        options: meta.ranges.map((value) => ({ value, label: t(`ranges.${value}`) })),
        onChange: (value) => {
            state.range = value;
            resetAndLoad();
        },
    });

    const eventTypeOptions = () => [
        { value: '', label: t('toolbar.allEventTypes') },
        ...state.knownEventTypes.map((type) => ({ value: type, label: tOr(`eventTypes.${type}`, type) })),
    ];
    const eventTypePicker = createListbox({
        label: t('toolbar.eventType'),
        options: eventTypeOptions(),
        value: '',
        className: 'event-type-picker',
        onChange: (value) => {
            state.eventType = value;
            resetAndLoad();
        },
    });

    const pageSizePicker = createListbox({
        label: t('toolbar.pageSize'),
        options: meta.pageSizes.map((size) => ({ value: String(size), label: t('toolbar.perPage', { count: size }) })),
        value: String(meta.pageSizeDefault),
        onChange: (value) => {
            state.pageSize = Number(value);
            state.page = 1;
            load();
        },
    });

    // Filters carried over from the Overview, each removable on its own.
    const chips = el('div', { className: 'filter-chips', attrs: { 'aria-live': 'polite' } });
    function renderChips() {
        replaceChildren(chips, Object.entries(state.where).map(([dim, value]) => {
            const label = `${t(`overview.dims.${dim}`)}: ${valueLabel(dim, value)}`;
            return el('button', {
                className: 'chip',
                attrs: { type: 'button', 'aria-label': t('overview.removeFilter', { filter: label }), title: t('overview.removeFilter', { filter: label }) },
                dataset: { dim },
                on: { click: () => {
                    state.where = Object.fromEntries(Object.entries(state.where).filter(([key]) => key !== dim));
                    resetAndLoad();
                } },
            }, [icon('filter'), el('span', { className: 'chip-text', text: label }), icon('close')]);
        }));
    }

    const toolbar = el('div', { className: 'toolbar' }, [
        el('div', { className: 'toolbar-group' }, [
            rangeFilter.element,
            isTrash ? null : eventTypePicker.element,
            searchInput,
            chips,
        ]),
        el('div', { className: 'toolbar-group' }, [
            modifiedFilter.element,
            isTrash ? null : el('label', { className: 'switch' }, [
                showDeletedToggle,
                el('span', { className: 'switch-track', attrs: { 'aria-hidden': 'true' } }),
                el('span', { className: 'switch-label', text: t('toolbar.showDeleted') }),
            ]),
            pageSizePicker.element,
        ]),
    ]);

    const summary = el('p', { className: 'panel-summary', attrs: { 'aria-live': 'polite' } });

    // ---- Batch bar ---------------------------------------------------------

    const batchCount = el('span', { className: 'batch-count' });
    const batchButton = (key, variant, handler) => el('button', {
        className: `btn btn-${variant} btn-small`,
        text: t(key),
        attrs: { type: 'button' },
        on: { click: handler },
    });

    const batchBar = el('div', { className: 'batch-bar', attrs: { role: 'region', 'aria-label': t('batch.region') } }, [
        batchCount,
        el('div', { className: 'batch-actions' }, [
            isTrash ? null : batchButton('batch.edit', 'secondary', () => editViews(selectedViews())),
            batchButton('batch.note', 'secondary', () => noteViews(selectedViews())),
            isTrash ? null : batchButton('batch.delete', 'danger', () => deleteViews(selectedViews())),
            batchButton('batch.restore', 'secondary', () => restoreViews(selectedViews())),
            isTrash ? batchButton('batch.purge', 'danger', () => purgeViews(selectedViews())) : null,
            batchButton('batch.clear', 'ghost', () => {
                state.selection.clear();
                renderSelection();
            }),
        ]),
    ]);
    batchBar.hidden = true;

    // ---- Table -------------------------------------------------------------

    const selectAll = el('input', {
        attrs: { type: 'checkbox', 'aria-label': t('table.selectPage') },
        on: { change: () => togglePage(selectAll.checked) },
    });
    const thead = el('thead');
    const tbody = el('tbody');
    const table = el('table', { className: 'data-table views-table', attrs: { id: tableId } }, [thead, tbody]);
    const pager = createPager((page) => {
        state.page = page;
        load();
    });

    const retention = isTrash ? el('p', { className: 'notice' }) : null;

    const element = el('section', {
        className: 'panel',
        attrs: { 'aria-label': isTrash ? t('tabs.trash') : t('tabs.views') },
    }, [
        el('header', { className: 'panel-header' }, [
            el('h2', { className: 'panel-title', text: isTrash ? t('tabs.trash') : t('tabs.views') }),
            el('p', { className: 'panel-intro', text: isTrash ? t('trash.intro') : t('views.intro') }),
        ]),
        appTabs.element,
        toolbar,
        retention,
        summary,
        batchBar,
        el('div', { className: 'table-wrap' }, [table]),
        pager.element,
    ]);

    // ---- Selection ---------------------------------------------------------

    function selectedViews() {
        return [...state.selection.values()];
    }

    function toggleRow(view, checked) {
        if (checked && !state.selection.has(view.id) && state.selection.size >= meta.maxBatchIds) {
            showToast(t('batch.limit', { count: meta.maxBatchIds }), TOAST_TYPE.ERROR);
            renderSelection();
            return;
        }
        if (checked) state.selection.set(view.id, view);
        else state.selection.delete(view.id);
        renderSelection();
    }

    function togglePage(checked) {
        for (const view of state.rows) {
            if (!checked) {
                state.selection.delete(view.id);
            } else if (!state.selection.has(view.id)) {
                if (state.selection.size >= meta.maxBatchIds) {
                    showToast(t('batch.limit', { count: meta.maxBatchIds }), TOAST_TYPE.ERROR);
                    break;
                }
                state.selection.set(view.id, view);
            }
        }
        renderSelection();
    }

    // ---- Rendering ---------------------------------------------------------

    function onSort(key) {
        state.focusSort = key;
        if (state.sort === key) {
            state.order = state.order === SORT_ORDER.ASC ? SORT_ORDER.DESC : SORT_ORDER.ASC;
        } else {
            state.sort = key;
            state.order = SORT_ORDER.DESC;
        }
        state.page = 1;
        load();
    }

    function renderHead() {
        replaceChildren(thead, [el('tr', {}, [
            el('th', { className: 'col-select', attrs: { scope: 'col' } }, [selectAll]),
            ...COLUMNS.map((column) => headerCell({
                label: t(`columns.${column.key}`),
                sortKey: column.sort,
                sort: state.sort,
                order: state.order,
                onSort,
                className: column.className,
            })),
        ])]);
    }

    function badge(key, className, title) {
        return el('span', { className: `badge ${className}`, text: t(key), attrs: title ? { title } : {} });
    }

    function actionButton(iconName, labelKey, handler, variant = '') {
        return el('button', {
            className: `icon-btn row-action ${variant}`.trim(),
            attrs: { type: 'button', 'aria-label': t(labelKey), title: t(labelKey) },
            on: { click: handler },
        }, [icon(iconName)]);
    }

    function renderRow(view) {
        const deleted = view.deletedAt !== null && view.deletedAt !== undefined;
        const checkbox = el('input', {
            attrs: {
                type: 'checkbox',
                'aria-label': t('table.selectRow', { time: formatDateTime(view.timestamp) }),
            },
            on: { change: (event) => toggleRow(view, event.currentTarget.checked) },
        });
        checkbox.checked = state.selection.has(view.id);

        const badges = [
            deleted ? badge('status.deleted', 'badge-danger', formatDateTime(view.deletedAt)) : null,
            view.adminModifiedAt ? badge('status.modified', 'badge-warning', formatDateTime(view.adminModifiedAt)) : null,
            view.note ? badge('status.note', 'badge-info', view.note) : null,
            view.isUnique ? null : badge('status.repeat', 'badge-muted'),
        ];

        const actions = [
            actionButton('info', 'rowActions.details', () => openDetails(view)),
            deleted ? null : actionButton('edit', 'rowActions.edit', () => editViews([view])),
            actionButton('note', 'rowActions.note', () => noteViews([view])),
            deleted
                ? actionButton('restore', 'rowActions.restore', () => restoreViews([view]))
                : actionButton('trash', 'rowActions.delete', () => deleteViews([view]), 'danger'),
            deleted && isTrash ? actionButton('purge', 'rowActions.purge', () => purgeViews([view]), 'danger') : null,
        ];

        const source = view.sourceType ? tOr(`sources.${view.sourceType}`, view.sourceType) : t('common.none');

        return el('tr', { className: deleted ? 'row-deleted' : '', dataset: { viewId: view.id } }, [
            el('td', { className: 'col-select' }, [checkbox]),
            timeCell(view.timestamp),
            el('td', { className: 'col-app' }, [clampText(view.appId, { className: 'mono' })]),
            el('td', { className: 'col-page' }, [
                clampText(orNone(view.pagePath), { className: 'cell-primary' }),
                clampText(view.hostname ? `${view.hostname} · ${orNone(view.pageTitle)}` : orNone(view.pageTitle), {
                    lines: CLAMP_LINES.SINGLE, className: 'cell-secondary',
                }),
            ]),
            el('td', { className: 'col-source' }, [
                clampText(source, { className: 'cell-primary' }),
                clampText(orNone(view.utmCampaign ?? view.referrerDomain), { className: 'cell-secondary' }),
            ]),
            el('td', { className: 'col-device' }, [
                clampText(view.deviceSize ? tOr(`deviceSizes.${view.deviceSize}`, view.deviceSize) : t('common.none'), { className: 'cell-primary' }),
                clampText(orNone(view.deviceType), { className: 'cell-secondary' }),
            ]),
            el('td', { className: 'col-country' }, [
                clampText(orNone(view.country), { className: 'cell-primary' }),
                clampText(orNone(view.city ?? view.region ?? view.language), { className: 'cell-secondary' }),
            ]),
            el('td', { className: 'col-client' }, [
                clampText(orNone(view.browser), { className: 'cell-primary' }),
                clampText(orNone(view.os), { className: 'cell-secondary' }),
            ]),
            el('td', { className: 'col-event' }, [clampText(view.eventType ? tOr(`eventTypes.${view.eventType}`, view.eventType) : t('common.none'))]),
            el('td', { className: 'col-status' }, [el('div', { className: 'badges' }, badges)]),
            el('td', { className: 'col-actions' }, [el('div', { className: 'row-actions' }, actions)]),
        ]);
    }

    /**
     * Reflect the selection without rebuilding any row, so the checkbox the
     * admin just used keeps keyboard focus.
     */
    function renderSelection() {
        const pageIds = state.rows.map((view) => view.id);
        const selectedOnPage = pageIds.filter((id) => state.selection.has(id)).length;
        selectAll.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
        selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
        selectAll.disabled = pageIds.length === 0;

        for (const row of tbody.querySelectorAll('tr[data-view-id]')) {
            const checkbox = row.querySelector('.col-select input');
            if (checkbox) checkbox.checked = state.selection.has(row.dataset.viewId);
        }

        batchBar.hidden = state.selection.size === 0;
        batchCount.textContent = t('batch.selected', { count: state.selection.size });
    }

    /** Rebuild the table from state. After a sort, focus returns to its header. */
    function render() {
        renderHead();
        if (state.rows.length === 0) {
            replaceChildren(tbody, [messageRow(COLUMN_COUNT, isTrash ? t('table.emptyTrash') : t('table.empty'))]);
        } else {
            replaceChildren(tbody, state.rows.map(renderRow));
        }
        renderSelection();
        pager.update(state.page, state.pageSize, state.total);
        if (state.focusSort) {
            thead.querySelector(`[data-sort-key="${state.focusSort}"]`)?.focus();
            state.focusSort = null;
        }

        const app = appEntries(context.apps()).find((entry) => entry.appId === context.appId());
        summary.textContent = app
            ? t('views.summary', {
                active: formatNumber(app.active),
                modified: formatNumber(app.modified),
                deleted: formatNumber(app.deleted),
                count: app.active,
            })
            : '';
        if (retention) {
            retention.textContent = meta.trashRetentionDays > 0
                ? t('trash.retention', { count: meta.trashRetentionDays })
                : t('trash.retentionOff');
        }
    }

    // ---- Loading -----------------------------------------------------------

    async function load() {
        const appId = context.appId();
        if (!appId) return;
        const seq = ++state.requestSeq;
        table.setAttribute('aria-busy', 'true');
        try {
            const query = {
                ...filters(),
                sort: state.sort,
                order: state.order,
                page: state.page,
                pageSize: state.pageSize,
            };
            const result = appId === ALL_APPS ? await api.allViews(query) : await api.views(appId, query);
            // A slower, older response must never overwrite a newer one.
            if (seq !== state.requestSeq) return;
            state.rows = result.views;
            state.total = result.total;
            // Rows name their app only under All apps; one app's tab already does.
            table.classList.toggle('has-app', appId === ALL_APPS);
            if (state.rows.length === 0 && state.page > 1 && state.total > 0) {
                state.page = Math.max(1, Math.ceil(state.total / state.pageSize));
                await load();
                return;
            }
            render();
        } catch (error) {
            if (seq === state.requestSeq) context.reportError(error);
        } finally {
            if (seq === state.requestSeq) table.removeAttribute('aria-busy');
        }
    }

    /**
     * Every event type the app holds in this status, whatever else is
     * filtered, so choosing one never hides the others. The current choice
     * stays on offer even if its last view was edited.
     */
    async function loadEventTypes() {
        const appId = context.appId();
        if (isTrash || !appId) return;
        try {
            const query = { status: status() };
            const { eventTypes } = appId === ALL_APPS ? await api.eventTypesAll(query) : await api.eventTypes(appId, query);
            if (appId !== context.appId()) return;
            state.knownEventTypes = [...new Set([...eventTypes, ...(state.eventType ? [state.eventType] : [])])].sort();
            eventTypePicker.setOptions(eventTypeOptions(), state.eventType);
        } catch (error) {
            context.reportError(error);
        }
    }

    function resetAndLoad() {
        state.page = 1;
        state.selection.clear();
        renderChips();
        load();
    }

    // ---- Operations --------------------------------------------------------

    /**
     * Run a mutation, report the outcome, and refresh. The server returns the
     * IDs it actually changed, which may be fewer than requested (a row
     * already restored, or already erased by someone else).
     */
    async function mutate(views, run, successKey) {
        // Grouped by app, since each app is its own table: a selection made
        // under "All apps" can span several.
        const byApp = new Map();
        for (const view of views) byApp.set(view.appId, [...(byApp.get(view.appId) || []), view.id]);
        // Each app is its own request and its own transaction. One that fails
        // must not hide what the others already did: those rows are changed
        // for real, so they leave the selection and the table is refreshed.
        const result = { attempted: 0, affected: 0, ids: [] };
        let failure = null;
        for (const [appId, ids] of byApp) {
            try {
                const part = await run(appId, ids);
                result.attempted += ids.length;
                result.affected += part.affected;
                result.ids.push(...part.ids);
            } catch (error) {
                failure ??= error;
            }
        }
        for (const id of result.ids) state.selection.delete(id);

        if (result.attempted > 0) {
            // Skipped means refused for a reason the server gave; rows whose
            // request failed are covered by the error instead.
            const skipped = result.attempted - result.affected;
            showToast(
                skipped > 0
                    ? t(`${successKey}Partial`, { count: result.affected, skipped })
                    : t(successKey, { count: result.affected }),
                TOAST_TYPE.SUCCESS,
            );
        }
        if (failure) context.reportError(failure);
        if (result.affected > 0 || !failure) {
            context.viewsChanged();
            try {
                await context.refreshApps();
                await load();
                loadEventTypes();
            } catch (error) {
                context.reportError(error);
            }
        }
        return !failure;
    }

    function editViews(views) {
        if (views.length === 0) return;
        openEditor({
            views,
            meta,
            onSubmit: (changes) => mutate(views, (appId, ids) => api.edit(appId, ids, changes), 'toasts.edited'),
        });
    }

    function noteViews(views) {
        if (views.length === 0) return;
        openNoteEditor({
            views,
            meta,
            onSubmit: (note) => mutate(
                views,
                (appId, ids) => api.note(appId, ids, note),
                note === null ? 'toasts.noteCleared' : 'toasts.noteSaved',
            ),
        });
    }

    async function deleteViews(views) {
        if (views.length === 0) return;
        const confirmed = await confirmModal({
            title: t('confirm.deleteTitle', { count: views.length }),
            message: meta.trashRetentionDays > 0
                ? t('confirm.deleteMessage', { count: views.length, days: meta.trashRetentionDays })
                : t('confirm.deleteMessageNoRetention', { count: views.length }),
            confirmLabel: t('confirm.deleteAction'),
            danger: true,
        });
        if (confirmed) await mutate(views, api.remove, 'toasts.deleted');
    }

    async function restoreViews(views) {
        if (views.length === 0) return;
        await mutate(views, api.restore, 'toasts.restored');
    }

    async function purgeViews(views) {
        if (views.length === 0) return;
        const confirmed = await confirmModal({
            title: t('confirm.purgeTitle', { count: views.length }),
            message: t('confirm.purgeMessage', { count: views.length }),
            confirmLabel: t('confirm.purgeAction'),
            danger: true,
        });
        if (confirmed) await mutate(views, api.purge, 'toasts.purged');
    }

    render();

    let visible = false;
    let stale = true;

    return {
        element,
        /** The app list or selected app changed. */
        syncApps() {
            appTabs.render();
        },
        /** The app changed: breakdown values of one app mean nothing in another. */
        appChanged() {
            state.where = {};
            state.page = 1;
            state.selection.clear();
            stale = true;
            if (visible) {
                resetAndLoad();
                loadEventTypes();
            }
        },
        /** Shown: start over after an app change, otherwise refresh the page, keeping the selection. */
        show() {
            visible = true;
            if (stale) {
                stale = false;
                resetAndLoad();
            } else {
                load();
            }
            loadEventTypes();
        },
        hide() {
            visible = false;
        },
        /** Rows changed elsewhere (in the other of Views and Trash). */
        invalidate() {
            if (visible) load();
        },
        /**
         * Show exactly the rows an Overview describes: its range, event type,
         * and breakdown values. Search and the admin-changes filter start over.
         * @param {{ range: string, eventType: string, where: Record<string, string|null> }} next
         */
        applyFilters({ range, eventType, where }) {
            state.range = range;
            state.eventType = eventType;
            state.where = { ...where };
            state.search = '';
            state.modified = MODIFIED_FILTER.ANY;
            searchInput.value = '';
            rangeFilter.setValue(range);
            modifiedFilter.setValue(MODIFIED_FILTER.ANY);
            if (eventType && !state.knownEventTypes.includes(eventType)) {
                state.knownEventTypes = [...state.knownEventTypes, eventType].sort();
            }
            eventTypePicker.setOptions(eventTypeOptions(), eventType);
            stale = true;
        },
        /**
         * Show one view by its ID, wherever it is: live or in the trash, in
         * any range. Every other filter starts over.
         * @param {string} viewId
         */
        findView(viewId) {
            state.range = RANGE.ALL;
            state.eventType = '';
            state.where = {};
            state.modified = MODIFIED_FILTER.ANY;
            state.search = viewId;
            searchInput.value = viewId;
            if (!isTrash) {
                state.showDeleted = true;
                showDeletedToggle.checked = true;
            }
            rangeFilter.setValue(RANGE.ALL);
            modifiedFilter.setValue(MODIFIED_FILTER.ANY);
            eventTypePicker.setOptions(eventTypeOptions(), '');
            stale = true;
        },
    };
}
