/**
 * The admin operation log and the view register log. Both are read-only here:
 * the UI has no way to alter a log entry, and neither does the API.
 */

import { api } from './api.js';
import { clampText } from './clamp.js';
import { el, replaceChildren } from './dom.js';
import { formatNumber, orNone } from './format.js';
import { t, tOr } from './i18n.js';
import { createListbox } from './listbox.js';
import { createPager, headerCell, messageRow, timeCell } from './table.js';

/** Sentinel for "no filter" in a filter listbox. */
const ALL = '';

function filterListbox(label, allLabel, values, labelFor, onChange) {
    return createListbox({
        label,
        options: [{ value: ALL, label: allLabel }, ...values.map((value) => ({ value, label: labelFor(value) }))],
        value: ALL,
        onChange,
    });
}

/**
 * A paged, filterable, read-only log table, optionally with a notice above it.
 * @param {{ title: string, columns: string[], filters: object[], fetchPage: (query: object) => Promise<object>,
 *   renderRow: (entry: object) => HTMLElement, meta: object, reportError: (error: unknown) => void,
 *   emptyKey: string, notice?: string }} options
 */
function createLogPanel({ title, columns, filters, fetchPage, renderRow, meta, reportError, emptyKey, notice }) {
    const state = { page: 1, pageSize: meta.pageSizeDefault, total: 0, entries: [], query: {}, seq: 0 };

    const tbody = el('tbody');
    const table = el('table', { className: 'data-table log-table' }, [
        el('thead', {}, [el('tr', {}, columns.map((key) => headerCell({ label: t(`logColumns.${key}`), className: `col-${key}` })))]),
        tbody,
    ]);
    const pager = createPager((page) => {
        state.page = page;
        load();
    });

    const toolbar = el('div', { className: 'toolbar' }, [
        el('div', { className: 'toolbar-group' }, filters.map((filter) => filter.listbox.element)),
    ]);

    const element = el('section', { className: 'panel', attrs: { 'aria-label': title } }, [
        toolbar,
        notice ? el('p', { className: 'notice', text: notice }) : null,
        el('div', { className: 'table-wrap' }, [table]),
        pager.element,
    ]);

    async function load() {
        const seq = ++state.seq;
        table.setAttribute('aria-busy', 'true');
        try {
            const result = await fetchPage({ ...state.query, page: state.page, pageSize: state.pageSize });
            if (seq !== state.seq) return;
            state.entries = result.entries;
            state.total = result.total;
            replaceChildren(tbody, state.entries.length
                ? state.entries.map(renderRow)
                : [messageRow(columns.length, t(emptyKey))]);
            pager.update(state.page, state.pageSize, state.total);
        } catch (error) {
            if (seq === state.seq) reportError(error);
        } finally {
            if (seq === state.seq) table.removeAttribute('aria-busy');
        }
    }

    for (const filter of filters) {
        filter.onValue = (value) => {
            state.query[filter.param] = value || undefined;
            state.page = 1;
            load();
        };
    }

    return { element, load };
}

/**
 * @param {{ meta: object, appIds: () => string[], reportError: (error: unknown) => void }} deps
 */
export function createAdminLogPanel({ meta, appIds, reportError }) {
    const filters = [];
    const actionFilter = { param: 'action' };
    actionFilter.listbox = filterListbox(t('logs.filterAction'), t('logs.allActions'), meta.actions,
        (action) => tOr(`actions.${action}`, action), (value) => actionFilter.onValue(value));
    const appFilter = { param: 'appId' };
    appFilter.listbox = filterListbox(t('logs.filterApp'), t('logs.allApps'), appIds(), (id) => id,
        (value) => appFilter.onValue(value));
    filters.push(actionFilter, appFilter);

    const renderRow = (entry) => el('tr', {}, [
        timeCell(entry.createdAt, { seconds: true }),
        el('td', { className: 'col-action' }, [clampText(tOr(`actions.${entry.action}`, entry.action))]),
        el('td', { className: 'col-app' }, [clampText(orNone(entry.appId))]),
        el('td', { className: 'col-rows' }, [clampText(formatNumber(entry.targetCount))]),
        el('td', { className: 'col-fields' }, [clampText(
            entry.fields.length ? entry.fields.map((field) => tOr(`fields.${field}`, field)).join(', ') : t('common.none'),
        )]),
        el('td', { className: 'col-session' }, [clampText(entry.sessionId ? entry.sessionId.slice(0, 8) : t('logs.system'), {
            className: 'mono',
        })]),
        el('td', { className: 'col-ip' }, [clampText(orNone(entry.maskedIp), { className: 'mono' })]),
    ]);

    const panel = createLogPanel({
        title: t('tabs.adminLog'),
        columns: ['time', 'action', 'app', 'rows', 'fields', 'session', 'ip'],
        filters,
        fetchPage: api.adminLog,
        renderRow,
        meta,
        reportError,
        emptyKey: 'logs.emptyAdmin',
    });
    return panel;
}

/**
 * Why old entries leave the view log. Empty when the host did not say (an
 * embedding app that configures no retention), so the UI never guesses.
 * @param {number|undefined} days
 */
function viewLogNotice(days) {
    if (typeof days !== 'number') return '';
    return days > 0 ? t('logs.viewLogRetention', { count: days }) : t('logs.viewLogRetentionOff');
}

/**
 * @param {{ meta: object, appIds: () => string[], reportError: (error: unknown) => void }} deps
 */
export function createViewLogPanel({ meta, appIds, reportError }) {
    const sourceFilter = { param: 'source' };
    sourceFilter.listbox = filterListbox(t('logs.filterSource'), t('logs.allSources'), meta.sources,
        (source) => tOr(`logSources.${source}`, source), (value) => sourceFilter.onValue(value));
    const appFilter = { param: 'appId' };
    appFilter.listbox = filterListbox(t('logs.filterApp'), t('logs.allApps'), appIds(), (id) => id,
        (value) => appFilter.onValue(value));

    const renderRow = (entry) => el('tr', {}, [
        timeCell(entry.createdAt, { seconds: true }),
        el('td', { className: 'col-app' }, [clampText(entry.appId)]),
        el('td', { className: 'col-source' }, [clampText(tOr(`logSources.${entry.source}`, entry.source))]),
        el('td', { className: 'col-event' }, [clampText(orNone(entry.eventType))]),
        el('td', { className: 'col-unique' }, [clampText(entry.isUnique ? t('common.yes') : t('common.no'))]),
        el('td', { className: 'col-view' }, [clampText(entry.viewId, { className: 'mono' })]),
    ]);

    return createLogPanel({
        title: t('tabs.viewLog'),
        columns: ['time', 'app', 'source', 'event', 'unique', 'view'],
        filters: [sourceFilter, appFilter],
        fetchPage: api.viewLog,
        renderRow,
        meta,
        reportError,
        emptyKey: 'logs.emptyViews',
        notice: viewLogNotice(meta.viewLogRetentionDays),
    });
}
