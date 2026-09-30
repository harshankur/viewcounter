/**
 * Charts for the Overview: stat tiles with sparklines, a trend line for any
 * headline number, ranked tables with bars, a world map, a weekday-by-hour
 * heatmap, and a per-minute column chart. Hand-drawn SVG, no library, no
 * HTML parsing.
 *
 * Built to the data-viz method the project follows:
 *  - one series per chart, in one hue (--chart-series), so no legend box: the
 *    card title names the series;
 *  - magnitude on the map and the heatmap is a one-hue sequential ramp
 *    (--map-1..--map-5), validated for monotone lightness in both themes,
 *    with a separate "none" neutral (--map-0);
 *  - thin marks, 2px lines, >= 8px markers with a surface ring, hairline grid;
 *  - every value is readable without hovering (ranked tables, a table view
 *    for the trend and the heatmap, a list beside the map), and hover and
 *    keyboard focus show the same tooltip.
 */

import { clampText } from './clamp.js';
import { el, replaceChildren } from './dom.js';
import { formatNumber, formatPercent, formatPeriod } from './format.js';
import { icon } from './icons.js';
import { t, tOr, currentLocale } from './i18n.js';
import { CHART, KEY } from './constants.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** An SVG element with attributes and children. */
function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value !== null && value !== undefined && value !== false) node.setAttribute(name, String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
}

const text = (value) => document.createTextNode(value);
const present = (value) => value !== null && value !== undefined && !Number.isNaN(value);

// ---- Tooltip -----------------------------------------------------------------

/**
 * One tooltip per chart. Values lead, labels follow; the row for the charted
 * series is keyed with a short stroke of the mark's colour, never a box.
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
 * A tiny line of a series, for a stat tile. Decoration: the tile's number and
 * the trend chart carry the values. Gaps (no data) break the line.
 * @param {Array<number|null>} values
 */
export function sparkline(values) {
    const { WIDTH, HEIGHT, PAD } = CHART.SPARK;
    const root = svg('svg', {
        class: 'sparkline', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none',
        'aria-hidden': 'true', focusable: 'false',
    });
    const known = values.filter(present);
    if (known.length < 2) return root;
    const max = Math.max(...known);
    const min = Math.min(0, ...known);
    const x = (index) => (index / (values.length - 1)) * WIDTH;
    const y = (value) => PAD + (HEIGHT - 2 * PAD) * (1 - (max === min ? 0.5 : (value - min) / (max - min)));
    let d = '';
    let drawing = false;
    values.forEach((value, index) => {
        if (!present(value)) {
            drawing = false;
            return;
        }
        d += `${drawing ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
        drawing = true;
    });
    root.append(svg('path', { class: 'sparkline-line', d, 'vector-effect': 'non-scaling-stroke' }));
    return root;
}

/**
 * The headline numbers: label, value, change against the period before, and
 * a sparkline of the period. With `onSelect`, each tile is a toggle button
 * that picks the metric the trend chart shows.
 *
 * @param {Array<{ key: string, label: string, value: string, exact?: string,
 *   delta?: { text: string, direction: 'up'|'down'|'flat', tone: 'good'|'bad'|'neutral', period: string } | null,
 *   note?: string, spark: Array<number|null> }>} tiles
 * @param {{ selected?: string, onSelect?: (key: string) => void, label?: string }} [options]
 */
export function statTiles(tiles, { selected, onSelect, label } = {}) {
    return el('div', { className: 'stat-tiles', attrs: { role: 'group', 'aria-label': label ?? null } }, tiles.map((tile) => {
        const direction = { up: 'arrowUp', down: 'arrowDown' }[tile.delta?.direction];
        const content = [
            el('span', { className: 'stat-label', text: tile.label }),
            el('span', {
                className: 'stat-value',
                text: tile.value,
                attrs: tile.exact && tile.exact !== tile.value ? { title: tile.exact } : {},
            }),
            tile.delta
                ? el('span', { className: `stat-delta tone-${tile.delta.tone}` }, [
                    direction ? icon(direction) : null,
                    el('span', { className: 'stat-delta-value', text: tile.delta.text }),
                    el('span', { className: 'stat-delta-period', text: tile.delta.period }),
                ])
                : el('span', { className: 'stat-delta stat-note', text: tile.note ?? '' }),
            sparkline(tile.spark),
        ];
        if (!onSelect) return el('div', { className: 'stat-tile', dataset: { metric: tile.key } }, content);
        const active = tile.key === selected;
        return el('button', {
            className: `stat-tile selectable${active ? ' active' : ''}`,
            attrs: { type: 'button', 'aria-pressed': String(active) },
            dataset: { metric: tile.key },
            on: { click: () => onSelect(tile.key) },
        }, content);
    }));
}

// ---- Nice axis ---------------------------------------------------------------

/**
 * A clean upper bound and tick step for an axis from zero.
 * @param {number} max
 * @param {{ integer?: boolean }} [options] integer keeps steps whole (counts, milliseconds)
 */
export function niceScale(max, { integer = true } = {}) {
    if (!(max > 0)) return integer ? { top: CHART.Y_TICKS, step: 1 } : { top: 1, step: 1 / CHART.Y_TICKS };
    const rough = max / CHART.Y_TICKS;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    let step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough);
    if (integer) step = Math.max(1, Math.round(step));
    return { top: Math.ceil(max / step - 1e-9) * step, step };
}

// ---- Over time -----------------------------------------------------------------

/**
 * One metric over time: a line (with a soft wash under counts), a crosshair
 * that snaps to the nearest period, and the same readout from the keyboard
 * (arrow keys, Home, End). A period with nothing to average is a gap, not a
 * zero.
 *
 * @param {{ points: object[], bucket: string, lastInProgress?: boolean,
 *   metric: { label: string, value: (point: object) => number|null, format: (value: number) => string,
 *     tick?: (value: number) => string, integer?: boolean, area?: boolean } }} data
 */
export function trendChart({ points, bucket, metric, lastInProgress = false }) {
    const card = el('div', { className: 'chart-body' });
    const tooltip = createTooltip(card);
    const values = points.map((point) => {
        const value = metric.value(point);
        return present(value) ? value : null;
    });
    const known = values.filter(present);
    if (known.length === 0) {
        card.append(el('p', { className: 'chart-empty', text: t('charts.noData') }));
        return card;
    }

    const { WIDTH, HEIGHT, MARGIN } = CHART.TREND;
    const plotW = WIDTH - MARGIN.left - MARGIN.right;
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const max = Math.max(...known);
    const { top, step } = niceScale(max, { integer: metric.integer !== false });
    const tick = metric.tick ?? metric.format;
    const x = (index) => MARGIN.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    const y = (value) => MARGIN.top + plotH - (value / top) * plotH;

    const grid = [];
    for (let index = 0; index * step <= top + step / 2; index++) {
        const value = index * step;
        grid.push(svg('line', { class: index === 0 ? 'chart-baseline' : 'chart-grid', x1: MARGIN.left, x2: WIDTH - MARGIN.right, y1: y(value), y2: y(value) }));
        grid.push(svg('text', {
            class: 'chart-tick', x: MARGIN.left - CHART.TICK_GAP, y: y(value), 'text-anchor': 'end', 'dominant-baseline': 'middle',
        }, [text(tick(value))]));
    }

    const last = points.length - 1;
    const labelIndexes = [...new Set([0, Math.floor(last / 2), last])];
    const xLabels = labelIndexes.map((index) => svg('text', {
        class: 'chart-tick',
        x: x(index),
        y: HEIGHT - MARGIN.bottom + CHART.X_LABEL_GAP,
        'text-anchor': index === 0 ? 'start' : index === last ? 'end' : 'middle',
    }, [text(formatPeriod(points[index].period, bucket))]));

    // Segments between gaps; a lone value between two gaps is a dot.
    let line = '';
    let drawing = false;
    const lonely = [];
    values.forEach((value, index) => {
        if (value === null) {
            drawing = false;
            return;
        }
        line += `${drawing ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
        if (!drawing && values[index + 1] === null) lonely.push(index);
        if (!drawing && index === last) lonely.push(index);
        drawing = true;
    });
    const gapless = known.length === values.length;
    const area = gapless && metric.area !== false
        ? `${line}L${x(last).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`
        : null;
    const lastKnown = values.findLastIndex(present);

    const crosshair = svg('line', { class: 'chart-crosshair', y1: MARGIN.top, y2: MARGIN.top + plotH, visibility: 'hidden' });
    const focusDot = svg('circle', { class: 'chart-dot', r: CHART.DOT_RADIUS, visibility: 'hidden' });
    const peak = values.indexOf(max);

    const plot = svg('svg', {
        class: 'trend-svg',
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        role: 'img',
        tabindex: 0,
        'aria-label': t('charts.trendLabel', {
            metric: metric.label,
            from: formatPeriod(points[0].period, bucket),
            to: formatPeriod(points[last].period, bucket),
            peak: metric.format(max),
            peakAt: formatPeriod(points[peak].period, bucket, { long: true }),
        }),
    }, [
        ...grid,
        area ? svg('path', { class: 'chart-area', d: area }) : null,
        svg('path', { class: 'chart-line', d: line }),
        ...lonely.filter((index) => index !== lastKnown).map((index) => svg('circle', {
            class: 'chart-dot', cx: x(index), cy: y(values[index]), r: CHART.DOT_RADIUS,
        })),
        svg('circle', { class: 'chart-dot', cx: x(lastKnown), cy: y(values[lastKnown]), r: CHART.DOT_RADIUS }),
        ...xLabels,
        crosshair,
        focusDot,
    ]);

    let activeIndex = -1;
    function highlight(index, at) {
        activeIndex = index;
        const value = values[index];
        crosshair.setAttribute('x1', x(index));
        crosshair.setAttribute('x2', x(index));
        crosshair.setAttribute('visibility', 'visible');
        focusDot.setAttribute('cx', x(index));
        focusDot.setAttribute('cy', y(value ?? 0));
        focusDot.setAttribute('visibility', value === null ? 'hidden' : 'visible');
        const period = formatPeriod(points[index].period, bucket, { long: true });
        tooltip.show({
            title: lastInProgress && index === last ? t('charts.inProgress', { period }) : period,
            rows: [{ value: value === null ? t('common.none') : metric.format(value), label: metric.label, key: true }],
        }, at ?? anchorOf(card, crosshair));
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
        const index = Math.min(last, Math.max(0, Math.round(ratio * last)));
        highlight(index, pointIn(card, event));
    });
    plot.addEventListener('pointerleave', reset);
    plot.addEventListener('blur', reset);
    plot.addEventListener('keydown', (event) => {
        const moves = {
            [KEY.ARROW_RIGHT]: Math.min(last, activeIndex + 1),
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

/**
 * Every metric per period, as a table: the accessible twin of the trend
 * chart, and the place to read all of them side by side.
 * @param {{ points: object[], bucket: string, metrics: Array<{ label: string,
 *   value: (point: object) => number|null, format: (value: number) => string }> }} data
 */
export function trendTable({ points, bucket, metrics }) {
    return el('table', { className: 'chart-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: t('charts.period'), attrs: { scope: 'col' } }),
            ...metrics.map((metric) => el('th', { text: metric.label, attrs: { scope: 'col' } })),
        ])]),
        el('tbody', {}, [...points].reverse().map((point) => el('tr', {}, [
            el('th', { text: formatPeriod(point.period, bucket, { long: true }), attrs: { scope: 'row' } }),
            ...metrics.map((metric) => {
                const value = metric.value(point);
                return el('td', { text: present(value) ? metric.format(value) : t('common.none') });
            }),
        ]))),
    ]);
}

// ---- Ranked tables -------------------------------------------------------------

/**
 * A ranked breakdown: each label with a bar behind it scaled to the leading
 * row, then one column per measure, all visible. A row with `onSelect` is a
 * button that narrows everything to that value.
 *
 * @param {{ labelHeader: string, columns: Array<{ label: string, value: (row: object) => number|null,
 *   format: (value: number) => string, className?: string }>,
 *   rows: Array<{ label: string, detail?: string, bar: number, muted?: boolean,
 *     onSelect?: () => void, selectLabel?: string }>, empty?: string }} data
 */
export function rankTable({ labelHeader, columns, rows, empty }) {
    if (rows.length === 0) return el('p', { className: 'chart-empty', text: empty ?? t('charts.noData') });
    return el('table', { className: 'rank-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { className: 'rank-label-head', text: labelHeader, attrs: { scope: 'col' } }),
            ...columns.map((column) => el('th', {
                className: `rank-num ${column.className ?? ''}`.trim(), text: column.label, attrs: { scope: 'col' },
            })),
        ])]),
        el('tbody', {}, rows.map((row) => {
            const bar = el('span', { className: 'rank-bar', attrs: { 'aria-hidden': 'true' } });
            bar.style.width = `${Math.max(0, Math.min(1, row.bar)) * 100}%`;
            const labelText = [
                clampText(row.label, { className: 'rank-text' }),
                row.detail ? clampText(row.detail, { className: 'rank-detail' }) : null,
            ];
            const label = row.onSelect
                ? el('button', {
                    className: 'rank-select',
                    attrs: { type: 'button', title: row.selectLabel ?? null, 'aria-label': row.selectLabel ?? null },
                    on: { click: row.onSelect },
                }, [bar, ...labelText, icon('filter', { className: 'rank-filter-icon' })])
                : el('span', { className: 'rank-static' }, [bar, ...labelText]);
            return el('tr', { className: row.muted ? 'rank-muted' : '' }, [
                el('th', { className: 'rank-label', attrs: { scope: 'row' } }, [label]),
                ...columns.map((column) => {
                    const value = column.value(row);
                    return el('td', {
                        className: `rank-num ${column.className ?? ''}`.trim(),
                        text: present(value) ? column.format(value) : t('common.none'),
                    });
                }),
            ]);
        })),
    ]);
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

/** The scale's legend: "none", then each class with its range. */
function scaleLegend(breaks, noneLabel) {
    const items = [el('span', { className: 'legend-item' }, [
        el('span', { className: 'legend-swatch map-0', attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: noneLabel }),
    ])];
    breaks.forEach((bound, index) => {
        const from = index === 0 ? 1 : breaks[index - 1] + 1;
        items.push(el('span', { className: 'legend-item' }, [
            el('span', { className: `legend-swatch map-${classOf(bound, breaks)}`, attrs: { 'aria-hidden': 'true' } }),
            el('span', { text: from === bound ? formatNumber(bound) : `${formatNumber(from)}–${formatNumber(bound)}` }),
        ]));
    });
    return el('div', { className: 'map-legend' }, items);
}

/** A region's name in the UI's language, or its code. */
export function regionName(code) {
    try {
        return new Intl.DisplayNames([currentLocale()], { type: 'region' }).of(code) ?? code;
    } catch {
        return code;
    }
}

/**
 * A choropleth of views by country, with a ranked list beside it that is both
 * the legend's companion and its table view. Clicking a country in the list
 * (with `onSelect`) narrows everything to it.
 *
 * @param {{ countries: Array<{ country: string, eventType: string|null, views: number }>,
 *   onSelect?: (code: string) => void }} data
 */
export function worldMap({ countries, onSelect }) {
    const body = el('div', { className: 'chart-body map-layout' });
    const mapHost = el('div', { className: 'map-host' });
    const tooltip = createTooltip(mapHost);
    const list = el('ol', { className: 'country-list', attrs: { 'aria-label': t('charts.topCountries') } });

    // Totals per country, and the per-type split for tooltips.
    const byCountry = new Map();
    for (const entry of countries) {
        const record = byCountry.get(entry.country) || { total: 0, types: [] };
        record.total += entry.views;
        record.types.push(entry);
        byCountry.set(entry.country, record);
    }
    const total = [...byCountry.values()].reduce((sum, record) => sum + record.total, 0);
    const breaks = classBreaks([...byCountry.values()].map((record) => record.total));

    function tooltipFor(code) {
        const record = byCountry.get(code);
        const views = record?.total ?? 0;
        const rows = [{ value: formatNumber(views), label: t('charts.views'), key: true }];
        for (const entry of [...(record?.types ?? [])].sort((a, b) => b.views - a.views).slice(0, CHART.TOOLTIP_TYPES)) {
            rows.push({
                value: formatNumber(entry.views),
                label: entry.eventType === null ? t('charts.otherTypes') : tOr(`eventTypes.${entry.eventType}`, entry.eventType),
            });
        }
        if (total > 0 && views > 0) rows.push({ value: formatPercent(views / total), label: t('charts.share') });
        return { title: regionName(code), rows };
    }

    const ranked = [...byCountry.entries()].filter(([, record]) => record.total > 0).sort((a, b) => b[1].total - a[1].total);
    const listMax = ranked[0]?.[1].total ?? 0;

    const marks = new Map();
    function setActive(code, on) {
        for (const mark of marks.get(code) || []) mark.classList.toggle('active', on);
    }

    loadMapAsset().then((asset) => {
        const paths = asset.shapes.map((shape) => svg('path', {
            d: shape.d, class: `country map-${classOf(byCountry.get(shape.code)?.total ?? 0, breaks)}`, 'data-code': shape.code,
        }));
        const dots = asset.points.map((point) => {
            const value = byCountry.get(point.code)?.total ?? 0;
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
            'aria-label': t('charts.mapLabel', { countries: formatNumber(ranked.length) }),
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
            if (onSelect && byCountry.has(code)) {
                mark.classList.add('selectable');
                mark.addEventListener('click', () => onSelect(code));
            }
        }
        replaceChildren(mapHost, [map, mapHost.querySelector('.chart-tooltip')]);
    }).catch(() => {
        replaceChildren(mapHost, [el('p', { className: 'chart-empty', text: t('charts.mapUnavailable') })]);
    });

    // The ranked list: every country with views, as a table would be. The
    // top ten show by default; the rest are one button away.
    let expanded = false;
    const renderList = () => {
        replaceChildren(list, []);
        if (ranked.length === 0) {
            list.append(el('li', { className: 'chart-empty', text: t('charts.noData') }));
            return;
        }
        const visible = expanded ? ranked : ranked.slice(0, CHART.COUNTRY_LIST_LIMIT);
        for (const [code, record] of visible) list.append(countryRow(code, record));
        if (ranked.length > CHART.COUNTRY_LIST_LIMIT) {
            list.append(el('li', { className: 'country-more' }, [el('button', {
                className: 'btn btn-ghost btn-small',
                text: expanded
                    ? t('charts.fewerCountries')
                    : t('charts.moreCountries', { count: ranked.length - CHART.COUNTRY_LIST_LIMIT }),
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
        const fill = el('span', { className: 'bar-fill' });
        fill.style.width = `${(record.total / listMax) * 100}%`;
        const content = [
            el('span', { className: 'country-name clamp clamp-1', text: regionName(code) }),
            el('span', { className: 'bar-track' }, [fill]),
            el('span', { className: 'bar-value', text: formatNumber(record.total) }),
        ];
        const item = onSelect
            ? el('li', {}, [el('button', {
                className: 'country-row',
                attrs: { type: 'button', 'aria-label': t('overview.filterBy', { dimension: t('overview.dims.country'), value: regionName(code) }) },
                dataset: { code },
                on: { click: () => onSelect(code) },
            }, content)])
            : el('li', { className: 'country-row', attrs: { tabindex: 0 }, dataset: { code } }, content);
        const target = item.querySelector('.country-row') ?? item;
        const on = () => {
            setActive(code, true);
            const mark = marks.get(code)?.[0];
            if (mark) tooltip.show(tooltipFor(code), anchorOf(mapHost, mark));
        };
        const off = () => {
            setActive(code, false);
            tooltip.hide();
        };
        target.addEventListener('pointerenter', on);
        target.addEventListener('pointerleave', off);
        target.addEventListener('focus', on);
        target.addEventListener('blur', off);
        return item;
    }
    renderList();

    body.append(el('div', { className: 'map-column' }, [mapHost, scaleLegend(breaks, t('charts.noViews'))]), list);
    return body;
}

// ---- Weekday by hour -----------------------------------------------------------

/** Monday first, in the UI's language. */
function weekdayNames(style) {
    const format = new Intl.DateTimeFormat(currentLocale(), { weekday: style, timeZone: 'UTC' });
    // 2024-01-01 was a Monday.
    return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2024, 0, 1 + day))));
}

function hourName(hour) {
    return new Intl.DateTimeFormat(currentLocale(), { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1, hour)));
}

/**
 * Views per weekday and hour of day, in the viewer's time zone, from the
 * server's hourly counts (hours since the epoch, UTC).
 * @param {Array<{ hour: number, views: number }>} hours
 * @returns {number[][]} [weekday Monday..Sunday][hour 0..23]
 */
export function weekHours(hours) {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const { hour, views } of hours) {
        const date = new Date(hour * HOUR_MS);
        grid[(date.getDay() + 6) % 7][date.getHours()] += views;
    }
    return grid;
}

/**
 * A weekday-by-hour heatmap on the sequential ramp. The grid is one focus
 * stop; arrow keys move a highlighted cell and read it out.
 * @param {{ hours: Array<{ hour: number, views: number }> }} data
 */
export function heatmap({ hours }) {
    const grid = weekHours(hours);
    const body = el('div', { className: 'chart-body heatmap-body' });
    const tooltip = createTooltip(body);
    const values = grid.flat();
    const breaks = classBreaks(values);
    const days = weekdayNames('short');
    const longDays = weekdayNames('long');
    const peak = Math.max(...values);
    const peakIndex = values.indexOf(peak);

    const cells = [];
    const matrix = el('div', {
        className: 'heatmap',
        attrs: {
            role: 'img',
            tabindex: 0,
            'aria-label': t('charts.heatmapLabel', {
                day: longDays[Math.floor(peakIndex / 24)],
                hour: hourName(peakIndex % 24),
                views: formatNumber(peak),
            }),
        },
    });
    matrix.append(el('span', { className: 'heatmap-corner', attrs: { 'aria-hidden': 'true' } }));
    for (let hour = 0; hour < 24; hour++) {
        matrix.append(el('span', {
            className: 'heatmap-hour',
            text: hour % CHART.HEATMAP_HOUR_LABEL_EVERY === 0 ? hourName(hour) : '',
            attrs: { 'aria-hidden': 'true' },
        }));
    }
    grid.forEach((row, day) => {
        matrix.append(el('span', { className: 'heatmap-day', text: days[day], attrs: { 'aria-hidden': 'true' } }));
        row.forEach((views, hour) => {
            const cell = el('span', {
                className: `heatmap-cell map-${classOf(views, breaks)}`,
                attrs: { 'aria-hidden': 'true' },
                dataset: { day: String(day), hour: String(hour) },
            });
            cells.push(cell);
            matrix.append(cell);
        });
    });

    let active = -1;
    function show(index, at) {
        if (active >= 0) cells[active].classList.remove('active');
        active = index;
        cells[index].classList.add('active');
        const day = Math.floor(index / 24);
        const hour = index % 24;
        tooltip.show({
            title: t('charts.heatmapCell', { day: longDays[day], from: hourName(hour), to: hourName((hour + 1) % 24) }),
            rows: [{ value: formatNumber(grid[day][hour]), label: t('charts.views'), key: true }],
        }, at ?? anchorOf(body, cells[index]));
    }
    function reset() {
        if (active >= 0) cells[active].classList.remove('active');
        active = -1;
        tooltip.hide();
    }

    matrix.addEventListener('pointermove', (event) => {
        const cell = event.target.closest?.('.heatmap-cell');
        if (!cell) return;
        show(Number(cell.dataset.day) * 24 + Number(cell.dataset.hour), pointIn(body, event));
    });
    matrix.addEventListener('pointerleave', reset);
    matrix.addEventListener('blur', reset);
    matrix.addEventListener('keydown', (event) => {
        const from = active < 0 ? peakIndex : active;
        const moves = {
            [KEY.ARROW_RIGHT]: Math.min(167, from + 1),
            [KEY.ARROW_LEFT]: Math.max(0, from - 1),
            [KEY.ARROW_DOWN]: Math.min(167, from + 24),
            [KEY.ARROW_UP]: Math.max(0, from - 24),
            [KEY.HOME]: Math.floor(from / 24) * 24,
            [KEY.END]: Math.floor(from / 24) * 24 + 23,
        };
        if (event.key in moves) {
            event.preventDefault();
            show(active < 0 ? peakIndex : moves[event.key]);
        } else if (event.key === KEY.ESCAPE) {
            reset();
        }
    });

    body.append(matrix, scaleLegend(breaks, t('charts.noViews')));
    return body;
}

/** The heatmap as a table: hours down, weekdays across. */
export function heatmapTable({ hours }) {
    const grid = weekHours(hours);
    const days = weekdayNames('short');
    return el('table', { className: 'chart-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: t('charts.hour'), attrs: { scope: 'col' } }),
            ...days.map((day) => el('th', { text: day, attrs: { scope: 'col' } })),
        ])]),
        el('tbody', {}, Array.from({ length: 24 }, (_, hour) => el('tr', {}, [
            el('th', { text: hourName(hour), attrs: { scope: 'row' } }),
            ...grid.map((row) => el('td', { text: formatNumber(row[hour]) })),
        ]))),
    ]);
}

// ---- Right now -----------------------------------------------------------------

/**
 * Views per minute over the last half hour, oldest on the left. One focus
 * stop; arrow keys read each minute.
 * @param {{ minutes: Array<{ minute: number, views: number }>, nowMinute: number }} data
 *   minutes since the epoch
 */
export function minuteChart({ minutes, nowMinute }) {
    const body = el('div', { className: 'chart-body minute-body' });
    const tooltip = createTooltip(body);
    const { WIDTH, HEIGHT, GAP, SPAN } = CHART.MINUTES;
    const counts = new Map(minutes.map((entry) => [entry.minute, entry.views]));
    const series = Array.from({ length: SPAN }, (_, index) => {
        const minute = nowMinute - (SPAN - 1) + index;
        return { minute, views: counts.get(minute) ?? 0 };
    });
    const max = Math.max(1, ...series.map((entry) => entry.views));
    const barW = WIDTH / SPAN - GAP;
    const time = new Intl.DateTimeFormat(currentLocale(), { hour: 'numeric', minute: '2-digit' });
    const total = series.reduce((sum, entry) => sum + entry.views, 0);

    const bars = series.map((entry, index) => {
        const h = entry.views ? Math.max(2, (entry.views / max) * (HEIGHT - 2)) : 0;
        return svg('rect', {
            class: 'minute-bar', x: index * (barW + GAP), y: HEIGHT - h, width: barW, height: h, rx: 1.5,
        });
    });
    const hit = svg('rect', { class: 'minute-hit', x: 0, y: 0, width: WIDTH, height: HEIGHT, fill: 'transparent' });
    const plot = svg('svg', {
        class: 'minute-svg',
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        preserveAspectRatio: 'none',
        role: 'img',
        tabindex: 0,
        'aria-label': t('charts.minutesLabel', { count: SPAN, views: formatNumber(total) }),
    }, [svg('line', { class: 'chart-baseline', x1: 0, x2: WIDTH, y1: HEIGHT, y2: HEIGHT }), ...bars, hit]);

    let active = -1;
    function show(index, at) {
        if (active >= 0) bars[active].classList.remove('active');
        active = index;
        bars[index].classList.add('active');
        const entry = series[index];
        tooltip.show({
            title: time.format(new Date(entry.minute * MINUTE_MS)),
            rows: [{ value: formatNumber(entry.views), label: t('charts.views'), key: true }],
        }, at ?? { x: ((index + 0.5) / SPAN) * body.clientWidth, y: 0 });
    }
    function reset() {
        if (active >= 0) bars[active].classList.remove('active');
        active = -1;
        tooltip.hide();
    }
    plot.addEventListener('pointermove', (event) => {
        const box = plot.getBoundingClientRect();
        const index = Math.min(SPAN - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * SPAN)));
        show(index, pointIn(body, event));
    });
    plot.addEventListener('pointerleave', reset);
    plot.addEventListener('blur', reset);
    plot.addEventListener('keydown', (event) => {
        const moves = {
            [KEY.ARROW_RIGHT]: Math.min(SPAN - 1, active + 1),
            [KEY.ARROW_LEFT]: Math.max(0, active < 0 ? SPAN - 1 : active - 1),
            [KEY.HOME]: 0,
            [KEY.END]: SPAN - 1,
        };
        if (event.key in moves) {
            event.preventDefault();
            show(moves[event.key]);
        } else if (event.key === KEY.ESCAPE) {
            reset();
        }
    });

    body.append(plot, el('div', { className: 'minute-axis', attrs: { 'aria-hidden': 'true' } }, [
        el('span', { text: t('charts.minutesAgo', { count: SPAN }) }),
        el('span', { text: t('charts.now') }),
    ]));
    return body;
}
