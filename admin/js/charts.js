/**
 * Charts for the insights panel: stat tiles, a views-over-time line, a world
 * map, and breakdown bars. Hand-drawn SVG, no library, no HTML parsing.
 *
 * Built to the data-viz method the project follows:
 *  - single-series marks in one hue (--chart-series), so no legend box;
 *  - the map is a one-hue sequential scale (--map-1..--map-5) with a separate
 *    "no views" neutral, validated for monotone lightness in both themes;
 *  - thin marks, 2px lines, >= 8px markers with a surface ring, hairline grid;
 *  - every value is readable without hovering (direct labels, a ranked list
 *    beside the map, a table view of the trend), and hover and keyboard focus
 *    show the same tooltip.
 */

import { el, replaceChildren } from './dom.js';
import { formatNumber, formatPercent, formatCompact, formatPeriod } from './format.js';
import { t, tOr, currentLocale } from './i18n.js';
import { CHART, KEY } from './constants.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element with attributes and children. */
function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value !== null && value !== undefined && value !== false) node.setAttribute(name, String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
}

// ---- Tooltip -----------------------------------------------------------------

/**
 * One tooltip per chart card. Values lead, labels follow; rows are keyed with
 * a short stroke of the mark's colour, never a filled box.
 */
export function createTooltip(host) {
    const node = el('div', { className: 'chart-tooltip', attrs: { role: 'status', 'aria-live': 'polite' } });
    node.hidden = true;
    host.append(node);

    return {
        /**
         * @param {{ title: string, rows: Array<{ value: string, label: string, key?: boolean }> }} content
         * @param {{ x: number, y: number }} at position within the host
         */
        show({ title, rows }, at) {
            replaceChildren(node, [
                el('div', { className: 'chart-tooltip-title', text: title }),
                ...rows.map((row) => el('div', { className: 'chart-tooltip-row' }, [
                    row.key ? el('span', { className: 'chart-tooltip-key', attrs: { 'aria-hidden': 'true' } }) : null,
                    el('strong', { text: row.value }),
                    el('span', { text: row.label }),
                ])),
            ]);
            node.hidden = false;
            const hostWidth = host.clientWidth;
            const width = node.offsetWidth;
            const left = Math.min(Math.max(at.x + CHART.TOOLTIP_OFFSET, 0), Math.max(hostWidth - width, 0));
            node.style.left = `${left}px`;
            node.style.top = `${Math.max(at.y - node.offsetHeight - CHART.TOOLTIP_OFFSET, 0)}px`;
        },
        hide() {
            node.hidden = true;
        },
    };
}

/** Pointer position within an element, from a pointer event. */
function pointIn(host, event) {
    const box = host.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
}

/** Centre-top of an element, within a host, for keyboard-driven tooltips. */
function anchorOf(host, target) {
    const box = host.getBoundingClientRect();
    const mark = target.getBoundingClientRect();
    return { x: mark.left - box.left + mark.width / 2, y: mark.top - box.top };
}

// ---- Stat tiles --------------------------------------------------------------

/**
 * A KPI row: label, then value. Proportional figures, compact above a
 * thousand, with the exact number in the title.
 * @param {Array<{ label: string, value: number, format?: 'number'|'percent', hint?: string }>} tiles
 */
export function statTiles(tiles) {
    return el('div', { className: 'stat-tiles' }, tiles.map((tile) => {
        const exact = tile.format === 'percent' ? formatPercent(tile.value) : formatNumber(tile.value);
        const shown = tile.format === 'percent' ? exact : formatCompact(tile.value);
        return el('div', { className: 'stat-tile' }, [
            el('div', { className: 'stat-label', text: tile.label }),
            el('div', { className: 'stat-value', text: shown, attrs: shown === exact ? {} : { title: exact } }),
            tile.hint ? el('div', { className: 'stat-hint', text: tile.hint }) : null,
        ]);
    }));
}

// ---- Nice axis ---------------------------------------------------------------

/** A clean upper bound and tick step for a count axis. */
function niceScale(max, ticks = CHART.Y_TICKS) {
    if (max <= 0) return { top: ticks, step: 1 };
    const rough = max / ticks;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough);
    const whole = Math.max(1, Math.round(step));
    return { top: Math.ceil(max / whole) * whole, step: whole };
}

// ---- Views over time ---------------------------------------------------------

/**
 * A single-series line with a soft area wash, a crosshair that snaps to the
 * nearest period, and the same readout from the keyboard (arrow keys).
 *
 * @param {{ points: Array<{ period: string, views: number, uniqueViews: number }>, bucket: string }} data
 * @returns {HTMLElement}
 */
export function trendChart({ points, bucket, lastInProgress = false }) {
    const card = el('div', { className: 'chart-body' });
    const tooltip = createTooltip(card);
    if (points.length === 0) {
        card.append(el('p', { className: 'chart-empty', text: t('insights.noData') }));
        return card;
    }

    const { WIDTH, HEIGHT, MARGIN } = CHART.TREND;
    const plotW = WIDTH - MARGIN.left - MARGIN.right;
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const max = Math.max(...points.map((point) => point.views));
    const { top, step } = niceScale(max);
    const x = (index) => MARGIN.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    const y = (value) => MARGIN.top + plotH - (value / top) * plotH;

    const grid = [];
    for (let value = 0; value <= top; value += step) {
        grid.push(svg('line', { class: value === 0 ? 'chart-baseline' : 'chart-grid', x1: MARGIN.left, x2: WIDTH - MARGIN.right, y1: y(value), y2: y(value) }));
        grid.push(svg('text', { class: 'chart-tick', x: MARGIN.left - CHART.TICK_GAP, y: y(value), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, [document.createTextNode(formatCompact(value))]));
    }

    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    const xLabels = labelIndexes.map((index) => svg('text', {
        class: 'chart-tick',
        x: x(index),
        y: HEIGHT - MARGIN.bottom + CHART.X_LABEL_GAP,
        'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
    }, [document.createTextNode(formatPeriod(points[index].period, bucket))]));

    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.views).toFixed(1)}`).join('');
    const area = `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    const last = points.length - 1;

    const crosshair = svg('line', { class: 'chart-crosshair', y1: MARGIN.top, y2: MARGIN.top + plotH, visibility: 'hidden' });
    const focusDot = svg('circle', { class: 'chart-dot', r: CHART.DOT_RADIUS, visibility: 'hidden' });

    const plot = svg('svg', {
        class: 'trend-svg',
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        role: 'img',
        tabindex: 0,
        'aria-label': t('insights.trendLabel', {
            from: formatPeriod(points[0].period, bucket),
            to: formatPeriod(points[last].period, bucket),
            peak: formatNumber(max),
        }),
    }, [
        ...grid,
        svg('path', { class: 'chart-area', d: area }),
        svg('path', { class: 'chart-line', d: line }),
        svg('circle', { class: 'chart-dot', cx: x(last), cy: y(points[last].views), r: CHART.DOT_RADIUS }),
        ...xLabels,
        crosshair,
        focusDot,
    ]);

    let activeIndex = -1;
    function highlight(index, at) {
        activeIndex = index;
        const point = points[index];
        crosshair.setAttribute('x1', x(index));
        crosshair.setAttribute('x2', x(index));
        crosshair.setAttribute('visibility', 'visible');
        focusDot.setAttribute('cx', x(index));
        focusDot.setAttribute('cy', y(point.views));
        focusDot.setAttribute('visibility', 'visible');
        const inProgress = lastInProgress && index === last;
        tooltip.show({
            title: inProgress
                ? t('insights.inProgress', { period: formatPeriod(point.period, bucket, { long: true }) })
                : formatPeriod(point.period, bucket, { long: true }),
            rows: [
                { value: formatNumber(point.views), label: t('insights.views'), key: true },
                { value: formatNumber(point.uniqueViews), label: t('insights.uniqueViews') },
            ],
        }, at ?? anchorOf(card, focusDot));
    }
    function reset() {
        activeIndex = -1;
        crosshair.setAttribute('visibility', 'hidden');
        focusDot.setAttribute('visibility', 'hidden');
        tooltip.hide();
    }

    plot.addEventListener('pointermove', (event) => {
        const box = plot.getBoundingClientRect();
        const svgX = ((event.clientX - box.left) / box.width) * WIDTH;
        const ratio = (svgX - MARGIN.left) / plotW;
        const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
        highlight(index, pointIn(card, event));
    });
    plot.addEventListener('pointerleave', reset);
    plot.addEventListener('blur', reset);
    plot.addEventListener('keydown', (event) => {
        const moves = {
            [KEY.ARROW_RIGHT]: Math.min(points.length - 1, activeIndex + 1),
            [KEY.ARROW_LEFT]: Math.max(0, activeIndex < 0 ? last : activeIndex - 1),
            [KEY.HOME]: 0,
            [KEY.END]: last,
        };
        if (event.key in moves) {
            event.preventDefault();
            highlight(moves[event.key]);
        } else if (event.key === KEY.ESCAPE) {
            reset();
        }
    });

    card.append(plot);
    return card;
}

/** The trend as a table: the accessible twin of the chart. */
export function trendTable({ points, bucket }) {
    return el('table', { className: 'chart-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: t('insights.period'), attrs: { scope: 'col' } }),
            el('th', { text: t('insights.views'), attrs: { scope: 'col' } }),
            el('th', { text: t('insights.uniqueViews'), attrs: { scope: 'col' } }),
        ])]),
        el('tbody', {}, points.map((point) => el('tr', {}, [
            el('td', { text: formatPeriod(point.period, bucket, { long: true }) }),
            el('td', { text: formatNumber(point.views) }),
            el('td', { text: formatNumber(point.uniqueViews) }),
        ]))),
    ]);
}

// ---- Breakdown bars ----------------------------------------------------------

/**
 * Ranked horizontal bars for one nominal dimension: one hue, value at the
 * tip, the tail folded into "Other".
 *
 * @param {{ entries: Array<{ value: string|null, views: number }>, total: number,
 *   labelFor: (value: string|null) => string }} data
 */
export function barList({ entries, total, labelFor }) {
    const body = el('div', { className: 'chart-body bar-list' });
    const tooltip = createTooltip(body);
    const shown = entries.reduce((sum, entry) => sum + entry.views, 0);
    const rows = [...entries.map((entry) => ({ label: labelFor(entry.value), views: entry.views }))];
    if (total > shown) rows.push({ label: t('insights.other'), views: total - shown, other: true });
    if (rows.length === 0) {
        body.append(el('p', { className: 'chart-empty', text: t('insights.noData') }));
        return body;
    }
    const max = Math.max(...rows.map((row) => row.views));

    for (const row of rows) {
        const share = total > 0 ? row.views / total : 0;
        const bar = el('div', {
            className: `bar-row${row.other ? ' bar-other' : ''}`,
            attrs: { tabindex: 0 },
        }, [
            el('span', { className: 'bar-label clamp clamp-1', text: row.label, attrs: { title: row.label } }),
            el('span', { className: 'bar-track' }, [el('span', { className: 'bar-fill' })]),
            el('span', { className: 'bar-value', text: formatNumber(row.views) }),
        ]);
        bar.querySelector('.bar-fill').style.width = `${(row.views / max) * 100}%`;
        const show = (at) => tooltip.show({
            title: row.label,
            rows: [
                { value: formatNumber(row.views), label: t('insights.views'), key: true },
                { value: formatPercent(share), label: t('insights.share') },
            ],
        }, at);
        bar.addEventListener('pointermove', (event) => show(pointIn(body, event)));
        bar.addEventListener('pointerleave', () => tooltip.hide());
        bar.addEventListener('focus', () => show(anchorOf(body, bar)));
        bar.addEventListener('blur', () => tooltip.hide());
        body.append(bar);
    }
    return body;
}

// ---- World map ---------------------------------------------------------------

let mapAssetPromise = null;

/** The projected country shapes, fetched once and cached. */
function loadMapAsset() {
    if (!mapAssetPromise) {
        mapAssetPromise = fetch('assets/world-map.json', { credentials: 'same-origin' }).then((response) => response.json());
    }
    return mapAssetPromise;
}

/**
 * Class breaks for a sequential scale: up to CHART.MAP_CLASSES bins over the
 * non-zero counts, by quantile, with duplicate breaks merged.
 * @param {number[]} values
 * @returns {number[]} ascending upper bounds, one per class
 */
export function classBreaks(values) {
    const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    const breaks = [];
    for (let index = 1; index <= CHART.MAP_CLASSES; index++) {
        const bound = sorted[Math.min(sorted.length - 1, Math.ceil((index / CHART.MAP_CLASSES) * sorted.length) - 1)];
        if (!breaks.includes(bound)) breaks.push(bound);
    }
    return breaks;
}

function classOf(value, breaks) {
    if (!value) return 0;
    const index = breaks.findIndex((bound) => value <= bound);
    const position = index === -1 ? breaks.length - 1 : index;
    // Spread fewer classes across the whole ramp so the top class is always the darkest.
    return 1 + Math.round((position / Math.max(1, breaks.length - 1)) * (CHART.MAP_CLASSES - 1));
}

/**
 * A choropleth of views by country, for one event type or all of them, with a
 * ranked list beside it that is both the legend's companion and its table view.
 *
 * @param {{ countries: Array<{ country: string, eventType: string|null, views: number }>,
 *   type: string|null, total: number }} data type null means every type
 */
export function worldMap({ countries, type }) {
    const body = el('div', { className: 'chart-body map-layout' });
    const mapHost = el('div', { className: 'map-host' });
    const tooltip = createTooltip(mapHost);
    const list = el('ol', { className: 'country-list', attrs: { 'aria-label': t('insights.topCountries') } });
    const legend = el('div', { className: 'map-legend' });
    body.append(el('div', { className: 'map-column' }, [mapHost, legend]), list);

    const regionName = (() => {
        try {
            const names = new Intl.DisplayNames([currentLocale()], { type: 'region' });
            return (code) => names.of(code) ?? code;
        } catch {
            return (code) => code;
        }
    })();

    // Totals per country for the selected type, and the per-type split for tooltips.
    const byCountry = new Map();
    for (const entry of countries) {
        const record = byCountry.get(entry.country) || { total: 0, selected: 0, types: [] };
        record.total += entry.views;
        if (type === null || entry.eventType === type) record.selected += entry.views;
        record.types.push(entry);
        byCountry.set(entry.country, record);
    }
    const selectedTotal = [...byCountry.values()].reduce((sum, record) => sum + record.selected, 0);
    const breaks = classBreaks([...byCountry.values()].map((record) => record.selected));

    function tooltipFor(code) {
        const record = byCountry.get(code);
        const views = record?.selected ?? 0;
        const rows = [{ value: formatNumber(views), label: type === null ? t('insights.views') : tOr(`eventTypes.${type}`, type), key: true }];
        if (record && type === null) {
            for (const entry of [...record.types].sort((a, b) => b.views - a.views).slice(0, CHART.TOOLTIP_TYPES)) {
                rows.push({
                    value: formatNumber(entry.views),
                    label: entry.eventType === null ? t('insights.otherTypes') : tOr(`eventTypes.${entry.eventType}`, entry.eventType),
                });
            }
        }
        if (selectedTotal > 0 && views > 0) rows.push({ value: formatPercent(views / selectedTotal), label: t('insights.share') });
        return { title: regionName(code), rows };
    }

    const ranked = [...byCountry.entries()]
        .filter(([, record]) => record.selected > 0)
        .sort((a, b) => b[1].selected - a[1].selected);
    const listMax = ranked[0]?.[1].selected ?? 0;

    const marks = new Map();
    function setActive(code, on) {
        for (const mark of marks.get(code) || []) mark.classList.toggle('active', on);
    }

    loadMapAsset().then((asset) => {
        const paths = asset.shapes.map((shape) => {
            const value = byCountry.get(shape.code)?.selected ?? 0;
            return svg('path', { d: shape.d, class: `country map-${classOf(value, breaks)}`, 'data-code': shape.code });
        });
        const dots = asset.points.map((point) => {
            const value = byCountry.get(point.code)?.selected ?? 0;
            if (!value) return null;
            return svg('circle', {
                cx: point.x, cy: point.y, r: CHART.DOT_RADIUS,
                class: `country country-point map-${classOf(value, breaks)}`, 'data-code': point.code,
            });
        });
        const map = svg('svg', {
            class: 'map-svg',
            viewBox: `0 0 ${asset.width} ${asset.height}`,
            role: 'img',
            'aria-label': t('insights.mapLabel', { countries: formatNumber(ranked.length) }),
        }, [...paths, ...dots]);

        for (const mark of map.querySelectorAll('[data-code]')) {
            const code = mark.getAttribute('data-code');
            marks.set(code, [...(marks.get(code) || []), mark]);
            mark.addEventListener('pointermove', (event) => {
                setActive(code, true);
                tooltip.show(tooltipFor(code), pointIn(mapHost, event));
            });
            mark.addEventListener('pointerleave', () => {
                setActive(code, false);
                tooltip.hide();
            });
        }
        replaceChildren(mapHost, [map, mapHost.querySelector('.chart-tooltip')]);
    }).catch(() => {
        replaceChildren(mapHost, [el('p', { className: 'chart-empty', text: t('insights.mapUnavailable') })]);
    });

    // Scale legend: "no views", then each class with its range.
    const legendItems = [el('span', { className: 'legend-item' }, [
        el('span', { className: 'legend-swatch map-0', attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: t('insights.noViews') }),
    ])];
    breaks.forEach((bound, index) => {
        const from = index === 0 ? 1 : breaks[index - 1] + 1;
        legendItems.push(el('span', { className: 'legend-item' }, [
            el('span', { className: `legend-swatch map-${classOf(bound, breaks)}`, attrs: { 'aria-hidden': 'true' } }),
            el('span', { text: from === bound ? formatNumber(bound) : `${formatNumber(from)}–${formatNumber(bound)}` }),
        ]));
    });
    replaceChildren(legend, legendItems);

    // The ranked list: every country with views, as a table would be. The top
    // ten show by default; the rest are one button away.
    let expanded = false;
    const renderList = () => {
        replaceChildren(list, []);
        if (ranked.length === 0) {
            list.append(el('li', { className: 'chart-empty', text: t('insights.noData') }));
            return;
        }
        const visible = expanded ? ranked : ranked.slice(0, CHART.COUNTRY_LIST_LIMIT);
        for (const [code, record] of visible) list.append(countryRow(code, record));
        if (ranked.length > CHART.COUNTRY_LIST_LIMIT) {
            list.append(el('li', { className: 'country-more' }, [el('button', {
                className: 'btn btn-ghost btn-small',
                text: expanded
                    ? t('insights.fewerCountries')
                    : t('insights.moreCountries', { count: ranked.length - CHART.COUNTRY_LIST_LIMIT }),
                attrs: { type: 'button', 'aria-expanded': String(expanded) },
                on: { click: () => {
                    expanded = !expanded;
                    renderList();
                    list.querySelector('.country-more button')?.focus();
                } },
            })]));
        }
    };

    function countryRow(code, record) {
        const item = el('li', { className: 'country-row', attrs: { tabindex: 0 } }, [
            el('span', { className: 'country-name clamp clamp-1', text: regionName(code) }),
            el('span', { className: 'bar-track' }, [el('span', { className: 'bar-fill' })]),
            el('span', { className: 'bar-value', text: formatNumber(record.selected) }),
        ]);
        item.querySelector('.bar-fill').style.width = `${(record.selected / listMax) * 100}%`;
        const on = () => {
            setActive(code, true);
            const mark = marks.get(code)?.[0];
            if (mark) tooltip.show(tooltipFor(code), anchorOf(mapHost, mark));
        };
        const off = () => {
            setActive(code, false);
            tooltip.hide();
        };
        item.addEventListener('pointerenter', on);
        item.addEventListener('pointerleave', off);
        item.addEventListener('focus', on);
        item.addEventListener('blur', off);
        return item;
    }
    renderList();

    return body;
}
