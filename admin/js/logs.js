/**
 * The tracking log and the admin log. Both are read-only here: the UI has no
 * way to alter a log entry, and neither does the API.
 *
 * They answer different questions from Views. Views holds what was recorded,
 * the rows every statistic is computed from. The tracking log holds what
 * arrived: every tracking request and what became of it, including the ones
 * never stored (bots and refusals). The admin log holds what admins did.
 */

import { api } from './api.js';
import { statTiles } from './charts.js';
import { clampText } from './clamp.js';
import { el, replaceChildren } from './dom.js';
import { formatCompact, formatNumber, orNone } from './format.js';
import { icon } from './icons.js';
import { t, tOr } from './i18n.js';
import { createListbox } from './listbox.js';
import { createPager, headerCell, messageRow, timeCell } from './table.js';
import { TRACKING_LOG_REFRESH_MS } from './constants.js';

/** Sentinel for "no filter" in a filter listbox. */
const ALL = '';
/** Badge styling for each tracking outcome. */
const OUTCOME_BADGE = { recorded: 'badge-success', repeat: 'badge-muted', bot: 'badge-info', rejected: 'badge-danger' };

function filterListbox(label, allLabel, values, labelFor, onChange) {
    return createListbox({
        label,
        options: [{ value: ALL, label: allLabel }, ...values.map((value) => ({ value, label: labelFor(value) }))],
        value: ALL,
        onChange,
    });
}

/**
 * A paged, filterable, read-only log table under a title and an explanation.
 * @param {{ title: string, intro: string, columns: string[], filters: object[], fetchPage: (query: object) => Promise<object>,
 *   renderRow: (entry: object) => HTMLElement, meta: object, reportError: (error: unknown) => void,
 *   emptyKey: string, notice?: string, above?: Node[], controls?: Node[], onLoad?: (query: object) => void,
 *   tableClassName?: string }} options
 */
function createLogPanel({
    title, intro, columns, filters, fetchPage, renderRow, meta, reportError, emptyKey, notice,
    above = [], controls = [], onLoad, tableClassName = '',
}) {
    const state = { page: 1, pageSize: meta.pageSizeDefault, total: 0, entries: [], query: {}, seq: 0 };

    const tbody = el('tbody');
    const table = el('table', { className: `data-table log-table ${tableClassName}`.trim() }, [
        el('thead', {}, [el('tr', {}, columns.map((key) => headerCell({ label: t(`logColumns.${key}`), className: `col-${key}` })))]),
        tbody,
    ]);
    const pager = createPager((page) => {
        state.page = page;
        load();
    });

    const toolbar = el('div', { className: 'toolbar' }, [
        el('div', { className: 'toolbar-group' }, filters.map((filter) => filter.listbox.element)),
        controls.length ? el('div', { className: 'toolbar-group' }, controls) : null,
    ]);

    const element = el('section', { className: 'panel', attrs: { 'aria-label': title } }, [
        el('header', { className: 'panel-header' }, [
            el('h2', { className: 'panel-title', text: title }),
            el('p', { className: 'panel-intro', text: intro }),
        ]),
        ...above,
        toolbar,
        notice ? el('p', { className: 'notice', text: notice }) : null,
        el('div', { className: 'table-wrap' }, [table]),
        pager.element,
    ]);

    async function load() {
        const seq = ++state.seq;
        table.setAttribute('aria-busy', 'true');
        onLoad?.(state.query);
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

    return { element, load, show: load, hide() {} };
}

/**
 * @param {{ meta: object, appIds: () => string[], reportError: (error: unknown) => void }} deps
 */
export function createAdminLogPanel({ meta, appIds, reportError }) {
    const actionFilter = { param: 'action' };
    actionFilter.listbox = filterListbox(t('logs.filterAction'), t('logs.allActions'), meta.actions,
        (action) => tOr(`actions.${action}`, action), (value) => actionFilter.onValue(value));
    const appFilter = { param: 'appId' };
    appFilter.listbox = filterListbox(t('logs.filterApp'), t('logs.allApps'), appIds(), (id) => id,
        (value) => appFilter.onValue(value));

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

    return createLogPanel({
        title: t('tabs.adminLog'),
        intro: t('logs.adminIntro'),
        columns: ['time', 'action', 'app', 'rows', 'fields', 'session', 'ip'],
        filters: [actionFilter, appFilter],
        fetchPage: api.adminLog,
        renderRow,
        meta,
        reportError,
        emptyKey: 'logs.emptyAdmin',
    });
}

/**
 * Why old entries leave the tracking log. Empty when the host did not say (an
 * embedding app that configures no retention), so the UI never guesses.
 * @param {number|undefined} days
 */
function trackingLogNotice(days) {
    if (typeof days !== 'number') return '';
    return days > 0 ? t('logs.trackingRetention', { count: days }) : t('logs.trackingRetentionOff');
}

/**
 * @param {{ meta: object, appIds: () => string[], reportError: (error: unknown) => void,
 *   openView: (appId: string, viewId: string) => void }} deps
 */
export function createTrackingLogPanel({ meta, appIds, reportError, openView }) {
    const sourceFilter = { param: 'source' };
    sourceFilter.listbox = filterListbox(t('logs.filterSource'), t('logs.allSources'), meta.sources,
        (source) => tOr(`logSources.${source}`, source), (value) => sourceFilter.onValue(value));
    const outcomeFilter = { param: 'outcome' };
    outcomeFilter.listbox = filterListbox(t('logs.filterOutcome'), t('logs.allOutcomes'), meta.outcomes,
        (outcome) => tOr(`outcomes.${outcome}`, outcome), (value) => outcomeFilter.onValue(value));
    const appFilter = { param: 'appId' };
    appFilter.listbox = filterListbox(t('logs.filterApp'), t('logs.allApps'), appIds(), (id) => id,
        (value) => appFilter.onValue(value));

    // What each outcome means, so nobody has to guess why a row is not a view.
    const legend = el('dl', { className: 'outcome-legend' }, meta.outcomes.flatMap((outcome) => [
        el('dt', {}, [el('span', { className: `badge ${OUTCOME_BADGE[outcome] ?? 'badge-muted'}`, text: tOr(`outcomes.${outcome}`, outcome) })]),
        el('dd', { text: t(`logs.outcomeHelp.${outcome}`) }),
    ]));

    // The last day at a glance, for the app filter's app or all of them.
    const summaryTiles = el('div', { className: 'tracking-summary' });
    const summaryReasons = el('p', { className: 'panel-summary' });
    let summarySeq = 0;
    async function loadSummary(query) {
        const mine = ++summarySeq;
        try {
            const summary = await api.trackingSummary({ appId: query.appId });
            if (mine !== summarySeq) return;
            replaceChildren(summaryTiles, [statTiles(meta.outcomes.map((outcome) => {
                const count = summary.outcomes[outcome] ?? 0;
                return {
                    key: outcome,
                    label: tOr(`outcomes.${outcome}`, outcome),
                    value: formatCompact(count),
                    exact: formatNumber(count),
                    note: t('logs.lastHours', { count: summary.hours }),
                    spark: [],
                };
            }), { label: t('logs.summaryLabel', { count: summary.hours }) })]);
            // Bots have their own tile; the list is why requests were refused.
            const reasons = Object.entries(summary.reasons).filter(([reason]) => reason !== 'bot').sort((a, b) => b[1] - a[1]);
            summaryReasons.textContent = reasons.length
                ? t('logs.reasons', {
                    list: reasons.map(([reason, count]) => `${tOr(`rejectionReasons.${reason}`, reason)} ${formatNumber(count)}`).join(' · '),
                })
                : t('logs.noReasons');
        } catch (error) {
            if (mine === summarySeq) reportError(error);
        }
    }

    const outcomeCell = (entry) => {
        const counted = entry.requests > 1 ? ` ×${formatNumber(entry.requests)}` : '';
        return el('td', { className: 'col-outcome' }, [
            el('span', {
                className: `badge ${OUTCOME_BADGE[entry.outcome] ?? 'badge-muted'}`,
                text: `${tOr(`outcomes.${entry.outcome}`, entry.outcome)}${counted}`,
            }),
        ]);
    };

    const detailText = (entry) => {
        const reason = entry.reason && entry.reason !== 'bot' ? tOr(`rejectionReasons.${entry.reason}`, entry.reason) : null;
        return [reason, entry.detail].filter(Boolean).join(': ') || t('common.none');
    };

    const viewCell = (entry) => el('td', { className: 'col-view' }, [entry.viewId && entry.appId
        ? el('button', {
            className: 'link-btn mono',
            attrs: { type: 'button', title: t('logs.openView'), 'aria-label': t('logs.openViewNamed', { id: entry.viewId }) },
            on: { click: () => openView(entry.appId, entry.viewId) },
        }, [el('span', { text: entry.viewId.slice(0, 8) }), icon('arrowRight')])
        : clampText(t('common.none'))]);

    const renderRow = (entry) => el('tr', { dataset: { outcome: entry.outcome } }, [
        timeCell(entry.at, { seconds: true }),
        el('td', { className: 'col-app' }, [
            clampText(orNone(entry.appId), { className: 'cell-primary' }),
            clampText(orNone(entry.hostname), { className: 'cell-secondary' }),
        ]),
        el('td', { className: 'col-source' }, [
            clampText(tOr(`logSources.${entry.source}`, entry.source), { className: 'cell-primary' }),
            // A page view's type goes without saying; an event names its type.
            clampText(entry.eventType && entry.source === 'event' ? tOr(`eventTypes.${entry.eventType}`, entry.eventType) : t('common.none'), {
                className: 'cell-secondary',
            }),
        ]),
        outcomeCell(entry),
        el('td', { className: 'col-detail' }, [clampText(detailText(entry))]),
        viewCell(entry),
    ]);

    // Auto-refresh: for watching a site's views arrive after setting it up.
    let timer = null;
    let visible = false;
    const liveToggle = el('input', {
        className: 'switch-input',
        attrs: { type: 'checkbox', role: 'switch' },
        on: { change: () => schedule() },
    });
    const liveSwitch = el('label', { className: 'switch' }, [
        liveToggle,
        el('span', { className: 'switch-track', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'switch-label', text: t('logs.autoRefresh', { seconds: TRACKING_LOG_REFRESH_MS / 1000 }) }),
    ]);

    const panel = createLogPanel({
        title: t('tabs.trackingLog'),
        intro: t('logs.trackingIntro'),
        columns: ['time', 'app', 'source', 'outcome', 'detail', 'view'],
        filters: [appFilter, sourceFilter, outcomeFilter],
        fetchPage: api.trackingLog,
        renderRow,
        meta,
        reportError,
        emptyKey: 'logs.emptyTracking',
        notice: trackingLogNotice(meta.viewLogRetentionDays),
        above: [
            el('details', { className: 'metric-help' }, [el('summary', { text: t('logs.outcomesTitle') }), legend]),
            summaryTiles,
            summaryReasons,
        ],
        controls: [liveSwitch],
        onLoad: loadSummary,
        tableClassName: 'tracking-table',
    });

    function schedule() {
        clearInterval(timer);
        timer = null;
        if (visible && liveToggle.checked) {
            timer = setInterval(() => {
                if (document.visibilityState === 'visible') panel.load();
            }, TRACKING_LOG_REFRESH_MS);
        }
    }

    return {
        ...panel,
        show() {
            visible = true;
            panel.load();
            schedule();
        },
        hide() {
            visible = false;
            schedule();
        },
    };
}
