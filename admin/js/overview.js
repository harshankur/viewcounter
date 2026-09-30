/**
 * The Overview: every statistic for the app and period chosen at the top,
 * read from live views only (the trash never counts).
 *
 * Clicking a row in any breakdown narrows the whole page to that value, as a
 * filter chip above; "Show these views" opens exactly those rows in the Views
 * table. "Right now" refreshes itself while the Overview is on screen.
 */

import { api } from './api.js';
import { createAppTabs } from './appTabs.js';
import {
    heatmap, heatmapTable, minuteChart, rankTable, regionName, statTiles, trendChart, trendTable, worldMap,
} from './charts.js';
import { el, replaceChildren, uniqueId } from './dom.js';
import {
    formatCompact, formatDateTime, formatDecimal, formatDuration, formatNumber, formatPercent, formatTime, periodStart,
} from './format.js';
import { icon } from './icons.js';
import { currentLocale, t, tOr } from './i18n.js';
import { createListbox } from './listbox.js';
import { createSegmented } from './table.js';
import { ALL_APPS, RANGE, REALTIME_REFRESH_MS, STORAGE_KEY, VIEW_STATUS } from './constants.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Mirrors ADMIN_RANGE_DAYS on the server. */
const RANGE_DAYS = { [RANGE.DAY]: 1, [RANGE.WEEK]: 7, [RANGE.MONTH]: 30, [RANGE.QUARTER]: 90, [RANGE.YEAR]: 365 };
const DEFAULT_RANGE = RANGE.MONTH;
const DEFAULT_METRIC = 'visitors';

const present = (value) => value !== null && value !== undefined && !Number.isNaN(value);

// ---- Remembered choices (this browser only) -------------------------------------

function readStored(key, fallback) {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function store(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage blocked: the choice simply is not remembered.
    }
}

function readCardTabs() {
    try {
        const parsed = JSON.parse(readStored(STORAGE_KEY.OVERVIEW_CARDS, '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

// ---- Periods ----------------------------------------------------------------------

/** The label of the bucket a moment falls in, as the server writes it (UTC). */
export function bucketLabel(date, bucket) {
    const iso = date.toISOString();
    if (bucket === 'hour') return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00`;
    if (bucket === 'month') return `${iso.slice(0, 8)}01`;
    if (bucket === 'week') {
        const day = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
        return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    }
    return iso.slice(0, 10);
}

/** The period after `period` by one bucket, labelled as the server labels it. */
export function nextPeriod(period, bucket) {
    const date = periodStart(period, bucket);
    if (bucket === 'hour') return bucketLabel(new Date(date.getTime() + HOUR_MS), bucket);
    if (bucket === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setTime(date.getTime() + (bucket === 'week' ? 7 : 1) * DAY_MS);
    return date.toISOString().slice(0, 10);
}

/** A period with no views: counts are zero, averages unknown. */
const emptyPeriod = (period) => ({
    period, views: 0, pageviews: 0, uniqueViews: 0, visitors: 0, visits: 0,
    bounceRate: null, avgVisitMs: null, pagesPerVisit: null, avgEngagedMs: null, avgScroll: null,
});

/**
 * Every period from `from` (or the first with views) to the last, with the
 * quiet ones as zero, so a quiet day reads as a dip rather than vanishing.
 * @param {object[]} trend as the server sends it, ordered
 * @param {string} bucket
 * @param {Date|null} [from] the start of a bounded range
 * @param {Date} [to]
 */
export function fillGaps(trend, bucket, from = null, to = new Date()) {
    const first = from ? bucketLabel(from, bucket) : trend[0]?.period;
    const last = from ? bucketLabel(to, bucket) : trend[trend.length - 1]?.period;
    if (!first || !last) return trend;
    const byPeriod = new Map(trend.map((point) => [point.period, point]));
    const filled = [];
    for (let period = first; period <= last; period = nextPeriod(period, bucket)) {
        filled.push(byPeriod.get(period) || emptyPeriod(period));
    }
    // Anything outside the window (a clock a moment apart) is kept, not lost.
    for (const point of trend) if (point.period < first || point.period > last) filled.push(point);
    return filled.sort((a, b) => a.period.localeCompare(b.period));
}

// ---- Metrics ------------------------------------------------------------------

const read = (key) => (source) => (source ? source[key] ?? null : null);
const COUNT = { format: formatNumber, tile: formatCompact, tick: formatCompact, kind: 'count', better: 'up' };
const DURATION = { format: formatDuration, tile: formatDuration, tick: formatDuration, kind: 'duration', better: 'up', area: false };

/** The headline numbers, in tile order. `read` takes totals or a trend point. */
const METRICS = [
    { key: 'visitors', label: () => t('overview.metrics.visitors'), help: () => t('overview.help.visitors'), read: read('visitors'), ...COUNT },
    { key: 'visits', label: () => t('overview.metrics.visits'), help: () => t('overview.help.visits'), read: read('visits'), ...COUNT },
    { key: 'pageviews', label: () => t('overview.metrics.pageviews'), help: () => t('overview.help.pageviews'), read: read('pageviews'), ...COUNT },
    { key: 'views', label: () => t('overview.metrics.views'), help: () => t('overview.help.views'), read: read('views'), ...COUNT },
    {
        key: 'bounceRate', label: () => t('overview.metrics.bounceRate'), help: () => t('overview.help.bounceRate'),
        read: read('bounceRate'), format: formatPercent, tile: formatPercent, tick: formatPercent,
        kind: 'rate', better: 'down', integer: false, area: false,
    },
    { key: 'avgVisitMs', label: () => t('overview.metrics.avgVisitMs'), help: () => t('overview.help.avgVisitMs'), read: read('avgVisitMs'), ...DURATION },
    {
        key: 'pagesPerVisit', label: () => t('overview.metrics.pagesPerVisit'), help: () => t('overview.help.pagesPerVisit'),
        read: read('pagesPerVisit'), format: (value) => formatDecimal(value, 2), tile: (value) => formatDecimal(value, 1),
        tick: (value) => formatDecimal(value, 1), kind: 'ratio', better: 'up', integer: false, area: false,
    },
    { key: 'avgEngagedMs', label: () => t('overview.metrics.avgEngagedMs'), help: () => t('overview.help.avgEngagedMs'), read: read('avgEngagedMs'), ...DURATION },
    {
        key: 'avgScroll', label: () => t('overview.metrics.avgScroll'), help: () => t('overview.help.avgScroll'),
        read: (source) => (present(source?.avgScroll) ? source.avgScroll / 100 : null),
        format: formatPercent, tile: formatPercent, tick: formatPercent, kind: 'rate', better: 'up', integer: false, area: false,
    },
];
const metricByKey = (key) => METRICS.find((metric) => metric.key === key) ?? METRICS[0];

function signed(value, options) {
    return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1, signDisplay: 'exceptZero', ...options }).format(value);
}

/**
 * The change against the period before: relative for counts and averages,
 * in percentage points for rates. Toned good or bad by which way is better.
 */
export function delta(metric, totals, previous, range) {
    if (!previous || !RANGE_DAYS[range]) return null;
    const now = metric.read(totals);
    const before = metric.read(previous);
    if (!present(now) || !present(before)) return null;
    const period = t(`overview.vsPrevious.${range}`);
    let change;
    let text;
    if (metric.kind === 'rate') {
        change = now - before;
        text = t('overview.points', { value: signed(change * 100) });
    } else if (before === 0) {
        if (now === 0) return { text: signed(0, { style: 'percent' }), direction: 'flat', tone: 'neutral', period };
        return { text: t('overview.deltaNew'), direction: 'up', tone: metric.better === 'up' ? 'good' : 'bad', period };
    } else {
        change = (now - before) / before;
        text = signed(change, { style: 'percent' });
    }
    const direction = Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
    const tone = direction === 'flat' ? 'neutral' : (direction === 'up') === (metric.better === 'up') ? 'good' : 'bad';
    return { text, direction, tone, period };
}

// ---- Values in breakdowns -------------------------------------------------------

function languageName(code) {
    try {
        const name = new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(code);
        return name && name !== code ? `${name} (${code})` : code;
    } catch {
        return code;
    }
}

/** "Bavaria, DE" as "Bavaria, Germany". */
function placeName(value) {
    const cut = value.lastIndexOf(', ');
    if (cut < 0) return value;
    const code = value.slice(cut + 2);
    return code === '?' ? value.slice(0, cut) : `${value.slice(0, cut)}, ${regionName(code)}`;
}

/** What a missing value means in each breakdown. */
function noneLabel(dim) {
    if (dim === 'referrer' || dim === 'referrerUrl') return t('overview.noReferrer');
    if (dim.startsWith('utm')) return t('overview.notTagged');
    if (dim === 'title') return t('overview.noTitle');
    return t('overview.unknown');
}

/** A breakdown value as the admin reads it. */
export function valueLabel(dim, value) {
    if (value === null || value === undefined || value === '') return noneLabel(dim);
    switch (dim) {
        case 'source': return tOr(`sources.${value}`, value);
        case 'country': return regionName(value);
        case 'region':
        case 'city': return placeName(value);
        case 'language': return languageName(value);
        case 'deviceSize': return tOr(`deviceSizes.${value}`, value);
        case 'deviceType': return tOr(`deviceTypes.${value}`, value);
        case 'eventType': return tOr(`eventTypes.${value}`, value);
        default: return value;
    }
}

const dimLabel = (dim) => t(`overview.dims.${dim}`);

// ---- Panel ----------------------------------------------------------------------

/**
 * @param {{ meta: object, context: { apps: () => object[], appId: () => string, setAppId: (id: string) => void,
 *   reportError: (error: unknown) => void, openViews: (filters: object) => void } }} deps
 */
export function createOverviewPanel({ meta, context }) {
    const rememberedRange = readStored(STORAGE_KEY.OVERVIEW_RANGE, DEFAULT_RANGE);
    const state = {
        range: meta.ranges.includes(rememberedRange) ? rememberedRange : DEFAULT_RANGE,
        eventType: '',
        eventTypes: [],
        where: {},
        metric: metricByKey(readStored(STORAGE_KEY.OVERVIEW_METRIC, DEFAULT_METRIC)).key,
        trendView: 'chart',
        data: null,
        seq: 0,
        visible: false,
        stale: true,
        cardTabs: readCardTabs(),
    };
    const realtime = { seq: 0, timer: null, data: null, failed: false, updatedAt: null };

    const contentId = uniqueId('overview-content');
    const appTabs = createAppTabs({ context, controls: contentId });

    // ---- Filters --------------------------------------------------------------

    const rangeFilter = createSegmented({
        label: t('toolbar.range'),
        value: state.range,
        options: meta.ranges.map((value) => ({ value, label: t(`ranges.${value}`) })),
        onChange: (value) => {
            state.range = value;
            store(STORAGE_KEY.OVERVIEW_RANGE, value);
            load();
        },
    });

    const eventTypeOptions = () => [
        { value: '', label: t('toolbar.allEventTypes') },
        ...state.eventTypes.map((type) => ({ value: type, label: tOr(`eventTypes.${type}`, type) })),
    ];
    const eventTypePicker = createListbox({
        label: t('toolbar.eventType'),
        options: eventTypeOptions(),
        value: '',
        className: 'event-type-picker',
        onChange: (value) => {
            state.eventType = value;
            load();
        },
    });

    const chips = el('div', { className: 'filter-chips', attrs: { 'aria-live': 'polite' } });
    const showViews = el('button', {
        className: 'btn btn-secondary btn-small',
        attrs: { type: 'button' },
        on: { click: () => context.openViews({ range: state.range, eventType: state.eventType, where: { ...state.where } }) },
    }, [el('span', { text: t('overview.showViews') }), icon('arrowRight')]);

    function renderChips() {
        const entries = Object.entries(state.where);
        replaceChildren(chips, [
            ...entries.map(([dim, value]) => {
                const label = `${dimLabel(dim)}: ${valueLabel(dim, value)}`;
                return el('button', {
                    className: 'chip',
                    attrs: { type: 'button', 'aria-label': t('overview.removeFilter', { filter: label }), title: t('overview.removeFilter', { filter: label }) },
                    dataset: { dim },
                    on: { click: () => {
                        delete state.where[dim];
                        load();
                    } },
                }, [icon('filter'), el('span', { className: 'chip-text', text: label }), icon('close')]);
            }),
            entries.length > 1 ? el('button', {
                className: 'btn btn-ghost btn-small',
                text: t('overview.clearFilters'),
                attrs: { type: 'button' },
                on: { click: () => {
                    state.where = {};
                    load();
                } },
            }) : null,
        ]);
    }

    /** Narrow everything to one breakdown value. */
    function selectValue(dim, value) {
        if (dim === 'app') {
            if (value) context.setAppId(value);
            return;
        }
        if (dim === 'eventType' && value) {
            state.eventType = value;
            eventTypePicker.setValue(value);
        } else {
            state.where = { ...state.where, [dim]: value };
        }
        load();
        filtersRow.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }

    const filtersRow = el('div', { className: 'toolbar overview-filters' }, [
        el('div', { className: 'toolbar-group' }, [rangeFilter.element, eventTypePicker.element, chips]),
        el('div', { className: 'toolbar-group' }, [showViews]),
    ]);

    // ---- Headline ---------------------------------------------------------------

    const tilesHost = el('div', { className: 'overview-tiles' });
    const span = el('p', { className: 'overview-span' });
    const help = el('details', { className: 'metric-help' }, [
        el('summary', { text: t('overview.helpTitle') }),
        el('dl', {}, METRICS.flatMap((metric) => [el('dt', { text: metric.label() }), el('dd', { text: metric.help() })])),
    ]);

    // ---- Cards ------------------------------------------------------------------

    /**
     * A titled card whose body is one of several views, chosen in its header.
     * @param {{ id: string, title: string, tabs: Array<{ key: string, label: string, render: () => Node }>,
     *   footer?: () => Node|null }} options
     */
    function card({ id, title, tabs, footer }) {
        const titleId = uniqueId('card-title');
        const body = el('div', { className: 'card-body' });
        const foot = el('div', { className: 'card-footer' });
        let current = tabs.some((tab) => tab.key === state.cardTabs[id]) ? state.cardTabs[id] : tabs[0].key;
        const picker = tabs.length > 1 ? createSegmented({
            label: t('overview.cardView', { card: title }),
            value: current,
            options: tabs.map((tab) => ({ value: tab.key, label: tab.label })),
            onChange: (key) => {
                current = key;
                state.cardTabs = { ...state.cardTabs, [id]: key };
                store(STORAGE_KEY.OVERVIEW_CARDS, JSON.stringify(state.cardTabs));
                render();
            },
        }) : null;
        const element = el('section', { className: 'chart-card', attrs: { 'aria-labelledby': titleId }, dataset: { card: id } }, [
            el('header', { className: 'chart-card-header' }, [
                el('h3', { className: 'chart-title', text: title, attrs: { id: titleId } }),
                picker?.element,
            ]),
            body,
            foot,
        ]);
        function render() {
            if (!state.data) return;
            replaceChildren(body, [tabs.find((tab) => tab.key === current).render()]);
            const note = footer?.();
            foot.hidden = !note;
            replaceChildren(foot, note ? [note] : []);
        }
        return { element, render };
    }

    const columns = {
        visitors: { label: t('overview.columns.visitors'), value: (row) => row.visitors, format: formatNumber },
        views: { label: t('overview.columns.views'), value: (row) => row.views, format: formatNumber },
        share: {
            label: t('overview.columns.share'),
            value: (row) => row.share,
            format: formatPercent,
            className: 'rank-share',
        },
        pageviews: { label: t('overview.columns.pageviews'), value: (row) => row.views, format: formatNumber },
        visits: { label: t('overview.columns.visits'), value: (row) => row.visits, format: formatNumber },
        bounceRate: { label: t('overview.columns.bounceRate'), value: (row) => row.bounceRate, format: formatPercent },
        engaged: { label: t('overview.columns.timeOnPage'), value: (row) => row.avgEngagedMs, format: formatDuration, className: 'rank-share' },
        scroll: {
            label: t('overview.columns.scroll'),
            value: (row) => (present(row.avgScroll) ? row.avgScroll / 100 : null),
            format: formatPercent,
            className: 'rank-share',
        },
        steps: { label: t('overview.columns.steps'), value: (row) => row.steps, format: formatNumber },
        count: { label: t('overview.columns.count'), value: (row) => row.count, format: formatNumber },
    };

    const byViews = (entries, key = 'views') => {
        const max = Math.max(0, ...entries.map((entry) => entry[key]));
        return (entry) => (max ? entry[key] / max : 0);
    };

    /**
     * A breakdown's rows, each a filter, with the rest folded into "Everything
     * else". How visits arrived counts page views; the rest count every view.
     */
    function breakdown(dim, { labelHeader = dimLabel(dim), filter = true } = {}) {
        const entries = state.data.breakdowns[dim] ?? [];
        const base = state.data.breakdownTotals?.[dim] ?? state.data.totals.views;
        const share = (views) => (base ? views / base : null);
        const bar = byViews(entries);
        const rows = entries.map((entry) => {
            const label = valueLabel(dim, entry.value);
            const active = Object.hasOwn(state.where, dim) && state.where[dim] === entry.value;
            return {
                ...entry,
                label,
                share: share(entry.views),
                bar: bar(entry),
                onSelect: filter && !active ? () => selectValue(dim, entry.value) : undefined,
                selectLabel: t('overview.filterBy', { dimension: dimLabel(dim), value: label }),
            };
        });
        const shown = entries.reduce((sum, entry) => sum + entry.views, 0);
        const rest = base - shown;
        if (entries.length && rest > 0) {
            rows.push({
                label: t('overview.other'), views: rest, visitors: null, share: share(rest),
                bar: Math.min(1, bar({ views: rest })), muted: true,
            });
        }
        const counted = meta.acquisitionDimensions.includes(dim) ? columns.pageviews : columns.views;
        return rankTable({
            labelHeader, columns: [columns.visitors, counted, columns.share], rows, empty: t('overview.empty'),
        });
    }

    const appDetail = (appId) => (context.appId() === ALL_APPS ? appId : undefined);
    const pageRow = (entry, key = 'views') => ({
        ...entry,
        label: valueLabel('page', entry.page),
        detail: appDetail(entry.appId),
        onSelect: () => selectValue('page', entry.page),
        selectLabel: t('overview.filterBy', { dimension: dimLabel('page'), value: valueLabel('page', entry.page) }),
        key,
    });

    function pagesTable() {
        const bar = byViews(state.data.pages);
        return rankTable({
            labelHeader: dimLabel('page'),
            columns: [columns.visitors, columns.views, columns.engaged, columns.scroll],
            rows: state.data.pages.map((entry) => ({ ...pageRow(entry), bar: bar(entry) })),
            empty: t('overview.empty'),
        });
    }

    function landingTable(entries, withBounce) {
        const bar = byViews(entries, 'visits');
        return rankTable({
            labelHeader: dimLabel('page'),
            columns: withBounce ? [columns.visits, columns.bounceRate] : [columns.visits],
            rows: entries.map((entry) => ({ ...pageRow(entry, 'visits'), bar: bar(entry) })),
            empty: t('overview.noVisits'),
        });
    }

    function flowTable() {
        const bar = byViews(state.data.transitions, 'steps');
        return rankTable({
            labelHeader: t('overview.flowHeader'),
            columns: [columns.steps],
            rows: state.data.transitions.map((entry) => ({
                ...entry,
                label: t('overview.flowStep', { from: valueLabel('page', entry.from), to: valueLabel('page', entry.to) }),
                detail: appDetail(entry.appId),
                bar: bar(entry),
            })),
            empty: t('overview.noFlow'),
        });
    }

    function eventPropertiesTable() {
        const bar = byViews(state.data.eventProperties, 'count');
        return rankTable({
            labelHeader: t('overview.propertyHeader'),
            columns: [columns.count],
            rows: state.data.eventProperties.map((entry) => ({
                ...entry,
                label: t('overview.property', { key: entry.key, value: entry.value }),
                detail: valueLabel('eventType', entry.eventType),
                bar: bar(entry),
            })),
            empty: t('overview.noProperties'),
        });
    }

    /** Ordered buckets, every one shown (a zero is information here). */
    function distribution(entries, bounds, keyOf, labelFor, header) {
        const counts = new Map(entries.map((entry) => [keyOf(entry), entry.views]));
        const total = entries.reduce((sum, entry) => sum + entry.views, 0);
        const max = Math.max(0, ...counts.values());
        if (total === 0) return el('p', { className: 'chart-empty', text: t('overview.noEngagement') });
        return rankTable({
            labelHeader: header,
            columns: [
                { label: t('overview.columns.pageviews'), value: (row) => row.views, format: formatNumber },
                { label: t('overview.columns.share'), value: (row) => row.views / total, format: formatPercent },
            ],
            rows: bounds.map((bound, index) => {
                const views = counts.get(bound) ?? 0;
                return { label: labelFor(bound, bounds[index + 1]), views, bar: max ? views / max : 0 };
            }),
        });
    }

    const timeOnPage = () => distribution(
        state.data.timeOnPage, [0, 10, 30, 60, 180, 600], (entry) => entry.fromSeconds,
        (from, to) => {
            if (to === undefined) return t('overview.orMore', { from: formatDuration(from * 1000) });
            if (from === 0) return t('overview.under', { to: formatDuration(to * 1000) });
            return t('overview.between', { from: formatDuration(from * 1000), to: formatDuration(to * 1000) });
        },
        t('overview.dims.timeOnPage'),
    );

    const scrollDepth = () => distribution(
        state.data.scrollDepth, [0, 25, 50, 75, 100], (entry) => entry.from,
        (from, to) => (to === undefined ? t('overview.scrollAll') : t('overview.scrollBetween', { from, to: to - 1 })),
        t('overview.dims.scrollDepth'),
    );

    const regionTable = (dim) => () => (meta.hasCityData || (state.data.breakdowns[dim] ?? []).some((entry) => entry.value !== null)
        ? breakdown(dim)
        : el('p', { className: 'chart-empty', text: t('overview.noCityData') }));

    const attribution = () => el('p', { className: 'card-note' }, (meta.attributions ?? []).flatMap((credit, index) => [
        index ? ' · ' : null,
        credit.url
            ? el('a', { text: credit.text, attrs: { href: credit.url, target: '_blank', rel: 'noopener noreferrer' } })
            : credit.text,
    ]));

    let heatmapView = 'chart';
    const cards = {
        apps: card({ id: 'apps', title: t('overview.cards.apps'), tabs: [
            { key: 'apps', label: dimLabel('app'), render: () => breakdown('app') },
        ] }),
        sources: card({ id: 'sources', title: t('overview.cards.sources'), tabs: [
            { key: 'source', label: t('overview.tabs.channels'), render: () => breakdown('source') },
            { key: 'referrer', label: t('overview.tabs.referrers'), render: () => breakdown('referrer') },
            { key: 'referrerUrl', label: t('overview.tabs.referringPages'), render: () => breakdown('referrerUrl') },
        ] }),
        pages: card({ id: 'pages', title: t('overview.cards.pages'), tabs: [
            { key: 'top', label: t('overview.tabs.topPages'), render: pagesTable },
            { key: 'entry', label: t('overview.tabs.entryPages'), render: () => landingTable(state.data.entryPages, true) },
            { key: 'exit', label: t('overview.tabs.exitPages'), render: () => landingTable(state.data.exitPages, false) },
            { key: 'title', label: t('overview.tabs.titles'), render: () => breakdown('title') },
            { key: 'hostname', label: t('overview.tabs.sites'), render: () => breakdown('hostname') },
        ] }),
        locations: card({ id: 'locations', title: t('overview.cards.locations'), footer: attribution, tabs: [
            { key: 'map', label: t('overview.tabs.map'), render: () => worldMap({
                countries: state.data.countries,
                onSelect: (code) => selectValue('country', code),
            }) },
            { key: 'country', label: t('overview.tabs.countries'), render: () => breakdown('country') },
            { key: 'region', label: t('overview.tabs.regions'), render: regionTable('region') },
            { key: 'city', label: t('overview.tabs.cities'), render: regionTable('city') },
            { key: 'language', label: t('overview.tabs.languages'), render: () => breakdown('language') },
        ] }),
        devices: card({ id: 'devices', title: t('overview.cards.devices'), tabs: [
            { key: 'deviceSize', label: t('overview.tabs.screenSizes'), render: () => breakdown('deviceSize') },
            { key: 'deviceType', label: t('overview.tabs.deviceTypes'), render: () => breakdown('deviceType') },
        ] }),
        browsers: card({ id: 'browsers', title: t('overview.cards.browsers'), tabs: [
            { key: 'browser', label: t('overview.tabs.browsers'), render: () => breakdown('browser') },
            { key: 'browserVersion', label: t('overview.tabs.versions'), render: () => breakdown('browserVersion') },
        ] }),
        systems: card({ id: 'systems', title: t('overview.cards.systems'), tabs: [
            { key: 'os', label: t('overview.tabs.systems'), render: () => breakdown('os') },
            { key: 'osVersion', label: t('overview.tabs.versions'), render: () => breakdown('osVersion') },
        ] }),
        campaigns: card({ id: 'campaigns', title: t('overview.cards.campaigns'), tabs: [
            { key: 'utmSource', label: t('overview.tabs.utmSource'), render: () => breakdown('utmSource') },
            { key: 'utmMedium', label: t('overview.tabs.utmMedium'), render: () => breakdown('utmMedium') },
            { key: 'utmCampaign', label: t('overview.tabs.utmCampaign'), render: () => breakdown('utmCampaign') },
            { key: 'utmTerm', label: t('overview.tabs.utmTerm'), render: () => breakdown('utmTerm') },
            { key: 'utmContent', label: t('overview.tabs.utmContent'), render: () => breakdown('utmContent') },
        ] }),
        events: card({ id: 'events', title: t('overview.cards.events'), tabs: [
            { key: 'eventType', label: t('overview.tabs.eventTypes'), render: () => breakdown('eventType') },
            { key: 'properties', label: t('overview.tabs.properties'), render: eventPropertiesTable },
        ] }),
        engagement: card({ id: 'engagement', title: t('overview.cards.engagement'), tabs: [
            { key: 'time', label: t('overview.tabs.timeOnPage'), render: timeOnPage },
            { key: 'scroll', label: t('overview.tabs.scrollDepth'), render: scrollDepth },
        ] }),
        when: card({
            id: 'when',
            title: t('overview.cards.when', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
            tabs: [
                { key: 'chart', label: t('charts.showChart'), render: () => {
                    heatmapView = 'chart';
                    return heatmap({ hours: state.data.hours });
                } },
                { key: 'table', label: t('charts.showTable'), render: () => {
                    heatmapView = 'table';
                    return el('div', { className: 'chart-table-wrap' }, [heatmapTable({ hours: state.data.hours })]);
                } },
            ],
            footer: () => (heatmapView === 'chart' ? el('p', { className: 'card-note', text: t('overview.whenNote') }) : null),
        }),
        flow: card({ id: 'flow', title: t('overview.cards.flow'), tabs: [
            { key: 'flow', label: t('overview.cards.flow'), render: flowTable },
        ] }),
    };
    cards.locations.element.classList.add('card-wide');
    cards.when.element.classList.add('card-wide');

    // ---- Trend ------------------------------------------------------------------

    const trendTitleId = uniqueId('trend-title');
    const trendTitle = el('h3', { className: 'chart-title', attrs: { id: trendTitleId } });
    const trendBody = el('div', { className: 'card-body' });
    const trendViewPicker = createSegmented({
        label: t('overview.trendView'),
        value: state.trendView,
        options: [{ value: 'chart', label: t('charts.showChart') }, { value: 'table', label: t('charts.showTable') }],
        onChange: (value) => {
            state.trendView = value;
            renderTrend();
        },
    });
    const trendCard = el('section', { className: 'chart-card trend-card', attrs: { 'aria-labelledby': trendTitleId } }, [
        el('header', { className: 'chart-card-header' }, [trendTitle, trendViewPicker.element]),
        trendBody,
    ]);

    /** The trend across the whole range, as the server bounded it, or across the data for all time. */
    function trendPoints() {
        const bounds = state.data.window;
        return bounds
            ? fillGaps(state.data.trend, state.data.bucket, new Date(bounds.from), new Date(bounds.to))
            : fillGaps(state.data.trend, state.data.bucket);
    }

    /** "Now" as the server saw it, so the last period reads "so far" by the same clock. */
    const serverNow = () => (state.data.window ? new Date(state.data.window.to) : new Date());

    function renderTrend() {
        const metric = metricByKey(state.metric);
        trendTitle.textContent = t('overview.trendTitle', { metric: metric.label() });
        const points = trendPoints();
        if (state.trendView === 'table') {
            replaceChildren(trendBody, [el('div', { className: 'chart-body chart-table-wrap' }, [trendTable({
                points,
                bucket: state.data.bucket,
                metrics: METRICS.map((entry) => ({ label: entry.label(), value: entry.read, format: entry.format })),
            })])]);
            return;
        }
        // The last bucket is still filling up if it has not ended, so its dip
        // is not a real decline; the tooltip says "so far".
        const last = points[points.length - 1]?.period;
        const lastInProgress = Boolean(last) && periodStart(nextPeriod(last, state.data.bucket), state.data.bucket) > serverNow();
        replaceChildren(trendBody, [trendChart({
            points,
            bucket: state.data.bucket,
            lastInProgress,
            metric: {
                label: metric.label(),
                value: metric.read,
                format: metric.format,
                tick: metric.tick,
                integer: metric.integer !== false,
                area: metric.area !== false,
            },
        })]);
    }

    // ---- Right now ----------------------------------------------------------------

    const liveTitleId = uniqueId('live-title');
    const liveBody = el('div', { className: 'card-body live-body' });
    const liveUpdated = el('p', { className: 'card-note live-updated' });
    const liveCard = el('section', { className: 'chart-card live-card', attrs: { 'aria-labelledby': liveTitleId } }, [
        el('header', { className: 'chart-card-header' }, [
            el('h3', { className: 'chart-title' }, [
                el('span', { className: 'live-dot', attrs: { 'aria-hidden': 'true' } }),
                el('span', { text: t('overview.live.title'), attrs: { id: liveTitleId } }),
            ]),
        ]),
        liveBody,
        liveUpdated,
    ]);

    function renderLive() {
        const data = realtime.data;
        if (!data) return;
        const bar = byViews(data.pages, 'visitors');
        replaceChildren(liveBody, [
            el('div', { className: 'live-headline' }, [
                el('span', { className: 'live-count', text: formatNumber(data.visitors) }),
                el('span', { className: 'live-caption', text: t('overview.live.visitors', { count: data.visitors, minutes: meta.realtimeVisitorMinutes }) }),
            ]),
            minuteChart({ minutes: data.minutes, nowMinute: data.nowMinute }),
            rankTable({
                labelHeader: t('overview.live.pages'),
                columns: [columns.visitors],
                rows: data.pages.map((entry) => ({
                    ...entry,
                    label: valueLabel('page', entry.page),
                    detail: appDetail(entry.appId),
                    bar: bar(entry),
                })),
                empty: t('overview.live.nobody'),
            }),
        ]);
        liveUpdated.textContent = t('overview.live.updated', {
            time: formatTime(realtime.updatedAt, { seconds: true }),
            seconds: REALTIME_REFRESH_MS / 1000,
        });
    }

    async function loadRealtime() {
        const appId = context.appId();
        if (!appId) return;
        const mine = ++realtime.seq;
        try {
            const data = appId === ALL_APPS ? await api.realtimeAll() : await api.realtime(appId);
            if (mine !== realtime.seq) return;
            realtime.data = data;
            realtime.updatedAt = new Date();
            realtime.failed = false;
            renderLive();
        } catch (error) {
            // Refreshed every few seconds: say it once, not on every attempt.
            if (mine === realtime.seq && !realtime.failed) context.reportError(error);
            if (mine === realtime.seq) realtime.failed = true;
        }
    }

    function startRealtime() {
        stopRealtime();
        loadRealtime();
        realtime.timer = setInterval(() => {
            if (document.visibilityState === 'visible') loadRealtime();
        }, REALTIME_REFRESH_MS);
    }

    function stopRealtime() {
        clearInterval(realtime.timer);
        realtime.timer = null;
    }

    // ---- Layout -----------------------------------------------------------------

    const grid = el('div', { className: 'overview-grid' });
    const content = el('div', { className: 'overview-content', attrs: { id: contentId } }, [
        filtersRow,
        tilesHost,
        span,
        el('div', { className: 'overview-top' }, [trendCard, liveCard]),
        grid,
        help,
    ]);

    const element = el('section', { className: 'panel overview', attrs: { 'aria-label': t('tabs.overview') } }, [
        el('header', { className: 'panel-header' }, [
            el('h2', { className: 'panel-title', text: t('tabs.overview') }),
            el('p', { className: 'panel-intro', text: t('overview.intro') }),
        ]),
        appTabs.element,
        content,
    ]);

    /** Cards in pairs, wide ones on their own row; a card left alone at the end spans the row. */
    function layoutCards() {
        const allApps = context.appId() === ALL_APPS;
        const order = [
            cards.sources, cards.pages, cards.locations,
            cards.devices, cards.browsers, cards.systems, cards.campaigns, cards.events, cards.engagement,
            cards.when, cards.flow, allApps ? cards.apps : null,
        ].filter(Boolean);
        cards.flow.element.classList.toggle('card-wide', !allApps);
        replaceChildren(grid, order.map((entry) => entry.element));
        return order;
    }

    function render() {
        const { data } = state;
        if (!data) return;
        const totals = data.totals ?? {};
        statTilesRender(totals, data.previous);

        span.textContent = totals.firstAt
            ? t('overview.span', {
                from: formatDateTime(totals.firstAt),
                to: formatDateTime(totals.lastAt),
                countries: formatNumber(totals.countries),
                count: totals.countries,
                unique: formatPercent(totals.views ? totals.uniqueViews / totals.views : 0),
                modified: formatNumber(totals.modified),
            })
            : t('overview.empty');
        renderChips();
        renderTrend();
        for (const entry of layoutCards()) entry.render();
    }

    function statTilesRender(totals, previous) {
        const points = trendPoints();
        replaceChildren(tilesHost, [statTiles(METRICS.map((metric) => {
            const value = metric.read(totals);
            return {
                key: metric.key,
                label: metric.label(),
                value: present(value) ? metric.tile(value) : t('common.none'),
                exact: present(value) ? metric.format(value) : undefined,
                delta: delta(metric, totals, previous, state.range),
                note: RANGE_DAYS[state.range] ? t('overview.noComparison') : t('overview.allTime'),
                spark: points.map(metric.read),
            };
        }), {
            selected: state.metric,
            label: t('overview.tilesLabel'),
            onSelect: (key) => {
                state.metric = key;
                store(STORAGE_KEY.OVERVIEW_METRIC, key);
                statTilesRender(totals, previous);
                renderTrend();
            },
        })]);
    }

    function syncEventTypes(types) {
        const next = [...new Set([...(types ?? []), ...(state.eventType ? [state.eventType] : [])])].sort();
        if (next.length === state.eventTypes.length && next.every((type, index) => type === state.eventTypes[index])) return;
        state.eventTypes = next;
        eventTypePicker.setOptions(eventTypeOptions(), state.eventType);
    }

    /**
     * Fetch and draw the analysis. The previous render stays up, dimmed, until
     * the new one arrives: no flash, no layout jump.
     */
    async function load() {
        const appId = context.appId();
        if (!appId) return;
        const mine = ++state.seq;
        state.stale = false;
        renderChips();
        element.classList.add('loading');
        try {
            const query = { status: VIEW_STATUS.ACTIVE, range: state.range, eventType: state.eventType, where: state.where };
            const result = appId === ALL_APPS ? await api.analyticsAll(query) : await api.analytics(appId, query);
            if (mine !== state.seq) return;
            state.data = result;
            syncEventTypes(result.eventTypes);
            render();
        } catch (error) {
            if (mine === state.seq) context.reportError(error);
        } finally {
            if (mine === state.seq) element.classList.remove('loading');
        }
    }

    return {
        element,
        syncApps() {
            appTabs.render();
        },
        /** The app changed: filters of one app mean nothing in another. */
        appChanged() {
            state.where = {};
            state.eventType = '';
            eventTypePicker.setValue('');
            realtime.data = null;
            state.stale = true;
            if (state.visible) {
                load();
                startRealtime();
            }
        },
        show() {
            state.visible = true;
            load();
            startRealtime();
        },
        hide() {
            state.visible = false;
            stopRealtime();
        },
        /** Views changed elsewhere (edited, trashed, restored): numbers are out of date. */
        invalidate() {
            state.stale = true;
            if (state.visible) load();
        },
    };
}
