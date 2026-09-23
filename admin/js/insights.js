/**
 * The insights panel above the views table: headline numbers, views over
 * time, a world map, and breakdowns, for exactly the rows the table's filters
 * select (one app or all, date range, search, modified filter).
 */

import { api } from './api.js';
import { barList, statTiles, trendChart, trendTable, worldMap } from './charts.js';
import { el, replaceChildren, uniqueId } from './dom.js';
import { formatDateTime } from './format.js';
import { t, tOr } from './i18n.js';
import { ALL_APPS, STORAGE_KEY } from './constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Breakdown cards, in display order; `allOnly` cards appear for every app at once. */
const BREAKDOWNS = [
    { dim: 'source', label: (v) => (v === null ? t('insights.unknown') : tOr(`sources.${v}`, v)) },
    { dim: 'deviceSize', label: (v) => (v === null ? t('insights.unknown') : tOr(`deviceSizes.${v}`, v)) },
    { dim: 'browser', label: (v) => v ?? t('insights.unknown') },
    { dim: 'os', label: (v) => v ?? t('insights.unknown') },
    { dim: 'eventType', label: (v) => (v === null ? t('insights.unknown') : tOr(`eventTypes.${v}`, v)) },
    { dim: 'app', label: (v) => v ?? t('insights.unknown'), allOnly: true },
];

/** The date after `period` by one bucket, as YYYY-MM-DD. */
function nextPeriod(period, bucket) {
    const date = new Date(`${period}T00:00:00Z`);
    if (bucket === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setTime(date.getTime() + (bucket === 'week' ? 7 : 1) * DAY_MS);
    return date.toISOString().slice(0, 10);
}

/**
 * Insert zero-count buckets between the first and last period, so a quiet
 * day reads as a dip rather than disappearing from the line.
 */
export function fillGaps(trend, bucket) {
    if (trend.length < 2) return trend;
    const byPeriod = new Map(trend.map((point) => [point.period, point]));
    const filled = [];
    const last = trend[trend.length - 1].period;
    for (let period = trend[0].period; period <= last; period = nextPeriod(period, bucket)) {
        filled.push(byPeriod.get(period) || { period, views: 0, uniqueViews: 0 });
    }
    return filled;
}

function readOpen() {
    try {
        return localStorage.getItem(STORAGE_KEY.INSIGHTS_OPEN) !== 'false';
    } catch {
        return true;
    }
}

function storeOpen(open) {
    try {
        localStorage.setItem(STORAGE_KEY.INSIGHTS_OPEN, String(open));
    } catch {
        // Storage blocked: the panel simply opens by default next time.
    }
}

/** A titled card; `control` sits in the header, beside the title. */
function card(titleKey, body, control, className = '') {
    const titleId = uniqueId('chart-title');
    return el('section', { className: `chart-card ${className}`.trim(), attrs: { 'aria-labelledby': titleId } }, [
        el('header', { className: 'chart-card-header' }, [
            el('h3', { className: 'chart-title', text: t(titleKey), attrs: { id: titleId } }),
            control,
        ]),
        body,
    ]);
}

/**
 * @param {{ reportError: (error: unknown) => void, onData?: (data: object) => void }} deps
 *   onData receives each analysis, so the filter row can offer the event types seen
 */
export function createInsightsPanel({ reportError, onData = () => {} }) {
    let open = readOpen();
    let seq = 0;
    let data = null;
    let showTrendTable = false;
    let allApps = false;

    const bodyId = uniqueId('insights-body');
    const toggle = el('button', {
        className: 'insights-toggle',
        attrs: { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId },
    }, [
        el('span', { className: 'prompt-char', text: '❯', attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: t('insights.title') }),
        el('span', { className: 'insights-caret', text: '▾', attrs: { 'aria-hidden': 'true' } }),
    ]);
    const caption = el('span', { className: 'insights-caption' });
    const body = el('div', { className: 'insights-body', attrs: { id: bodyId } });
    body.hidden = !open;

    const element = el('section', { className: 'insights', attrs: { 'aria-label': t('insights.title') } }, [
        el('div', { className: 'insights-header' }, [toggle, caption]),
        body,
    ]);

    toggle.addEventListener('click', () => {
        open = !open;
        storeOpen(open);
        toggle.setAttribute('aria-expanded', String(open));
        body.hidden = !open;
        if (open) render();
    });

    function trendCard() {
        const points = fillGaps(data.trend, data.bucket);
        const tableToggle = el('button', {
            className: 'btn btn-ghost btn-small',
            text: showTrendTable ? t('insights.showChart') : t('insights.showTable'),
            attrs: { type: 'button', 'aria-pressed': String(showTrendTable) },
            on: { click: () => {
                showTrendTable = !showTrendTable;
                render();
            } },
        });
        // The last bucket is still filling up if it has not ended yet, so its
        // dip is not a real decline; the tooltip says "so far".
        const lastPeriod = points[points.length - 1]?.period;
        const lastInProgress = Boolean(lastPeriod) && nextPeriod(lastPeriod, data.bucket) > new Date().toISOString().slice(0, 10);
        const content = showTrendTable
            ? el('div', { className: 'chart-body chart-table-wrap' }, [trendTable({ points, bucket: data.bucket })])
            : trendChart({ points, bucket: data.bucket, lastInProgress });
        return card('insights.trendTitle', content, tableToggle, 'chart-trend');
    }

    function mapCard() {
        // Every type, or the one chosen in the filter row above: the rows are
        // already filtered by the server, so the map just shows them.
        return card('insights.mapTitle', worldMap({ countries: data.countries, type: null }), null, 'chart-map');
    }

    function render() {
        if (!open || !data) return;
        const { totals } = data;
        const period = totals.firstAt
            ? t('insights.span', { from: formatDateTime(totals.firstAt), to: formatDateTime(totals.lastAt) })
            : t('insights.noData');

        replaceChildren(body, [
            statTiles([
                { label: t('insights.views'), value: totals.views },
                { label: t('insights.visitors'), value: totals.visitors },
                { label: t('insights.uniqueShare'), value: totals.views ? totals.uniqueViews / totals.views : 0, format: 'percent' },
                { label: t('insights.countries'), value: totals.countries },
                { label: t('insights.modified'), value: totals.modified },
            ]),
            el('p', { className: 'insights-span', text: period }),
            el('div', { className: 'insights-grid' }, [trendCard(), mapCard()]),
            el('div', { className: 'breakdown-grid' }, BREAKDOWNS
                .filter((breakdown) => !breakdown.allOnly || allApps)
                .map((breakdown) => card(`insights.breakdown.${breakdown.dim}`, barList({
                    entries: data.breakdowns[breakdown.dim],
                    total: totals.views,
                    labelFor: breakdown.label,
                })))),
        ]);
    }

    /**
     * Fetch and draw the analysis for a filter set. The previous render stays
     * up, dimmed, until the new one arrives: no flash, no layout jump.
     * @param {{ appId: string, status: string, modified: string, search: string, range: string }} query
     */
    async function load({ appId, ...filters }) {
        const mine = ++seq;
        allApps = appId === ALL_APPS;
        caption.textContent = allApps ? t('insights.scopeAll') : t('insights.scopeApp', { app: appId });
        element.classList.add('loading');
        try {
            const result = allApps ? await api.analyticsAll(filters) : await api.analytics(appId, filters);
            if (mine !== seq) return;
            data = result;
            onData(result);
            render();
        } catch (error) {
            if (mine === seq) reportError(error);
        } finally {
            if (mine === seq) element.classList.remove('loading');
        }
    }

    return { element, load };
}
