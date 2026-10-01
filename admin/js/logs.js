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
import { createDataTable } from './dataTable.js';
import { el, replaceChildren } from './dom.js';
import { formatDate, formatHeadline, formatNumber, formatTime, orNone } from './format.js';
import { icon } from './icons.js';
import { t, tOr } from './i18n.js';
import { createListbox } from './listbox.js';
import { createPager } from './table.js';
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

/** A cell of two lines: what matters, and a detail under it. */
const two = (primary, secondary) => [
    clampText(primary, { className: 'cell-primary' }),
    clampText(secondary, { className: 'cell-secondary' }),
];
const one = (text, className = '') => [clampText(text, { className })];
/** When something happened, to the second: logs order events moments apart. */
const when = (value) => two(formatDate(value), formatTime(value, { seconds: true }));

/**
 * A paged, filterable, read-only log table under a title and an explanation.
 * Its columns can be chosen, ordered, and sized like those of the views table.
 * @param {{ name: string, title: string, intro: string, columns: object[], rowKey: (entry: object) => string,
 *   rowAttrs?: (entry: object) => object, filters: object[], fetchPage: (query: object) => Promise<object>,
 *   meta: object, reportError: (error: unknown) => void, emptyKey: string, notice?: string, above?: Node[],
 *   controls?: Node[], onLoad?: (query: object) => void, tableClassName?: string }} options
 */
function createLogPanel({
    name, title, intro, columns, rowKey, rowAttrs, filters, fetchPage, meta, reportError, emptyKey, notice,
    above = [], controls = [], onLoad, tableClassName = '',
}) {
    const state = { page: 1, pageSize: meta.pageSizeDefault, total: 0, entries: [], query: {}, seq: 0 };

    const grid = createDataTable({
        storageKey: name,
        className: `log-table ${tableClassName}`.trim(),
        columns: columns.map((column) => ({ ...column, label: t(`logColumns.${column.id}`) })),
        rowKey,
        rowAttrs,
        empty: () => t(emptyKey),
    });
    const { table } = grid;
    const pager = createPager((page) => {
        state.page = page;
        load();
    });

    const toolbar = el('div', { className: 'toolbar' }, [
        el('div', { className: 'toolbar-group' }, filters.map((filter) => filter.listbox.element)),
        el('div', { className: 'toolbar-group' }, [...controls, grid.chooserButton]),
    ]);

    const element = el('section', { className: 'panel', attrs: { 'aria-label': title } }, [
        el('header', { className: 'panel-header' }, [
            el('h2', { className: 'panel-title', text: title }),
            el('p', { className: 'panel-intro', text: intro }),
        ]),
        ...above,
        toolbar,
        notice ? el('p', { className: 'notice', text: notice }) : null,
        grid.element,
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
            grid.setRows(state.entries);
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

    const columns = [
        { id: 'time', width: 140, cell: (entry) => when(entry.createdAt) },
        { id: 'action', width: 176, cell: (entry) => one(tOr(`actions.${entry.action}`, entry.action)) },
        { id: 'app', width: 144, cell: (entry) => one(orNone(entry.appId)) },
        { id: 'rows', width: 84, cell: (entry) => one(formatNumber(entry.targetCount)) },
        {
            id: 'fields', width: 240, minWidth: 160, grow: true,
            cell: (entry) => one(entry.fields.length ? entry.fields.map((field) => tOr(`fields.${field}`, field)).join(', ') : t('common.none')),
        },
        { id: 'session', width: 116, cell: (entry) => one(entry.sessionId ? entry.sessionId.slice(0, 8) : t('logs.system'), 'mono') },
        { id: 'ip', width: 170, cell: (entry) => one(orNone(entry.maskedIp), 'mono') },
    ];

    return createLogPanel({
        name: 'admin-log',
        title: t('tabs.adminLog'),
        intro: t('logs.adminIntro'),
        columns,
        rowKey: (entry) => entry.id,
        filters: [actionFilter, appFilter],
        fetchPage: api.adminLog,
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
                    value: formatHeadline(count),
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

    const outcomeBadge = (entry) => {
        const counted = entry.requests > 1 ? ` ×${formatNumber(entry.requests)}` : '';
        return [el('span', {
            className: `badge ${OUTCOME_BADGE[entry.outcome] ?? 'badge-muted'}`,
            text: `${tOr(`outcomes.${entry.outcome}`, entry.outcome)}${counted}`,
        })];
    };

    const detailText = (entry) => {
        const reason = entry.reason && entry.reason !== 'bot' ? tOr(`rejectionReasons.${entry.reason}`, entry.reason) : null;
        return [reason, entry.detail].filter(Boolean).join(': ') || t('common.none');
    };

    const viewLink = (entry) => [entry.viewId && entry.appId
        ? el('button', {
            className: 'link-btn mono',
            attrs: { type: 'button', title: t('logs.openView'), 'aria-label': t('logs.openViewNamed', { id: entry.viewId }) },
            on: { click: () => openView(entry.appId, entry.viewId) },
        }, [el('span', { text: entry.viewId.slice(0, 8) }), icon('arrowRight')])
        : clampText(t('common.none'))];

    const eventName = (entry) => (entry.eventType ? tOr(`eventTypes.${entry.eventType}`, entry.eventType) : t('common.none'));
    const columns = [
        { id: 'time', width: 140, cell: (entry) => when(entry.at) },
        { id: 'app', width: 160, cell: (entry) => two(orNone(entry.appId), orNone(entry.hostname)) },
        {
            // A page view's type goes without saying; an event names its type.
            id: 'source', width: 144,
            cell: (entry) => two(tOr(`logSources.${entry.source}`, entry.source), entry.source === 'event' ? eventName(entry) : t('common.none')),
        },
        { id: 'outcome', width: 152, cell: outcomeBadge },
        { id: 'detail', width: 240, minWidth: 160, grow: true, cell: (entry) => one(detailText(entry)) },
        { id: 'view', width: 112, cell: viewLink },
        { id: 'site', width: 200, hidden: true, cell: (entry) => one(orNone(entry.hostname)) },
        { id: 'event', width: 150, hidden: true, cell: (entry) => one(eventName(entry)) },
        { id: 'requests', width: 104, hidden: true, cell: (entry) => one(formatNumber(entry.requests)) },
    ];

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
        name: 'tracking-log',
        title: t('tabs.trackingLog'),
        intro: t('logs.trackingIntro'),
        columns,
        rowKey: (entry) => entry.id,
        rowAttrs: (entry) => ({ dataset: { outcome: entry.outcome } }),
        filters: [appFilter, sourceFilter, outcomeFilter],
        fetchPage: api.trackingLog,
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
