/**
 * The admin analysis: everything the insights show, read from exactly the rows
 * a listing with the same filters returns.
 *
 * Nothing here collects anything. Visits, bounces, and page flow are read from
 * the rotating visitor hash the way privacy-first analytics does it: a
 * visitor's page views belong to one visit until they pause for
 * ANALYSIS.VISIT_GAP_SECONDS. The hash changes every unique-visitor window, so
 * a visit can never be linked to the same person on another day.
 *
 * Every identifier and expression interpolated into SQL here is a fixed
 * literal from this file or constants.js. Caller input reaches the statements
 * only as bound parameters, through the shared filter.
 */

const {
    ANALYSIS,
    ANALYSIS_TOP_N,
    EVENT_TYPE,
    TREND_BUCKET,
    TREND_BUCKET_MAX_DAYS,
} = require('../constants');

const PAGEVIEW = `'${EVENT_TYPE.PAGEVIEW}'`;

/**
 * Columns the analysis reads. `visitor_hash` is here only so the database can
 * count visitors and group visits; it is never selected into a result. `id`
 * only orders views that share a timestamp.
 */
const ANALYSIS_COLUMNS = [
    'id', 'timestamp', 'visitor_hash', 'is_unique', 'admin_modified_at', 'event_type',
    'page_path', 'page_title', 'hostname', 'referrer', 'referrer_domain', 'source_type',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'country', 'region', 'city', 'language',
    'devicesize', 'device_type', 'browser', 'browser_version', 'os', 'os_version',
    'engaged_ms', 'scroll_depth',
];

/**
 * Time-series bucket expressions, keyed by TREND_BUCKET. Each bucket is
 * labelled by the moment it starts (YYYY-MM-DD, or YYYY-MM-DD HH:00 by hour).
 */
const BUCKET_EXPRESSION = {
    [TREND_BUCKET.HOUR]: "DATE_FORMAT(timestamp, '%Y-%m-%d %H:00')",
    [TREND_BUCKET.DAY]: "DATE_FORMAT(timestamp, '%Y-%m-%d')",
    [TREND_BUCKET.WEEK]: "DATE_FORMAT(DATE_SUB(DATE(timestamp), INTERVAL WEEKDAY(timestamp) DAY), '%Y-%m-%d')",
    [TREND_BUCKET.MONTH]: "DATE_FORMAT(timestamp, '%Y-%m-01')",
};

/** "Bavaria, DE": a region or city name alone is ambiguous across countries. */
const placeIn = (column) => `CASE WHEN ${column} IS NULL THEN NULL ELSE CONCAT(${column}, ', ', COALESCE(country, '?')) END`;
/** "Chrome 129": the name with its major version (or major.minor for systems). */
const withVersion = (name, version, parts) =>
    `CASE WHEN ${name} IS NULL THEN NULL ELSE CONCAT_WS(' ', ${name}, SUBSTRING_INDEX(${version}, '.', ${parts})) END`;

/** Breakdown dimensions: API name -> expression. Fixed literals. */
const BREAKDOWN_COLUMNS = {
    source: 'source_type',
    referrer: 'referrer_domain',
    referrerUrl: 'referrer',
    utmSource: 'utm_source',
    utmMedium: 'utm_medium',
    utmCampaign: 'utm_campaign',
    utmTerm: 'utm_term',
    utmContent: 'utm_content',
    page: 'page_path',
    title: 'page_title',
    hostname: 'hostname',
    country: 'country',
    region: placeIn('region'),
    city: placeIn('city'),
    language: 'language',
    deviceSize: 'devicesize',
    deviceType: 'device_type',
    browser: 'browser',
    browserVersion: withVersion('browser', 'browser_version', 1),
    os: 'os',
    osVersion: withVersion('os', 'os_version', 2),
    eventType: 'event_type',
    app: 'app_id',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The coarsest bucket that keeps a chart of this span readable. */
function chooseBucket(firstAt, lastAt) {
    if (!firstAt || !lastAt) return TREND_BUCKET.DAY;
    const days = (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / DAY_MS;
    for (const bucket of [TREND_BUCKET.HOUR, TREND_BUCKET.DAY, TREND_BUCKET.WEEK]) {
        if (days <= TREND_BUCKET_MAX_DAYS[bucket]) return bucket;
    }
    return TREND_BUCKET.MONTH;
}

/**
 * Page views grouped into visits. Appended after `WITH v AS (...)`, it adds:
 *   t       each page view with its step in the visit, the steps left, and the next page
 *   visits  one row per visit: pages, duration, entry and exit page
 * A visit's duration runs from its first page view to its last, plus how long
 * the last page was visible when the tracker reported it.
 */
const VISITS_CTE = `,
    p AS (
        SELECT app_id, visitor_hash, id, timestamp, page_path, engaged_ms,
            CASE WHEN LAG(timestamp) OVER (PARTITION BY app_id, visitor_hash ORDER BY timestamp, id) IS NULL
                   OR TIMESTAMPDIFF(SECOND,
                        LAG(timestamp) OVER (PARTITION BY app_id, visitor_hash ORDER BY timestamp, id),
                        timestamp) > ${ANALYSIS.VISIT_GAP_SECONDS}
                 THEN 1 ELSE 0 END AS starts_visit
        FROM v WHERE event_type = ${PAGEVIEW}
    ),
    s AS (
        SELECT p.*, SUM(starts_visit) OVER (
            PARTITION BY app_id, visitor_hash ORDER BY timestamp, id ROWS UNBOUNDED PRECEDING) AS visit_no
        FROM p
    ),
    t AS (
        SELECT s.*,
            ROW_NUMBER() OVER (PARTITION BY app_id, visitor_hash, visit_no ORDER BY timestamp, id) AS step,
            ROW_NUMBER() OVER (PARTITION BY app_id, visitor_hash, visit_no ORDER BY timestamp DESC, id DESC) AS steps_left,
            LEAD(page_path) OVER (PARTITION BY app_id, visitor_hash, visit_no ORDER BY timestamp, id) AS next_page
        FROM s
    ),
    visits AS (
        SELECT app_id, visitor_hash, visit_no, COUNT(*) AS pages,
            TIMESTAMPDIFF(SECOND, MIN(timestamp), MAX(timestamp)) * 1000
                + COALESCE(MAX(CASE WHEN steps_left = 1 THEN engaged_ms END), 0) AS duration_ms,
            MAX(CASE WHEN step = 1 THEN page_path END) AS entry_page,
            MAX(CASE WHEN steps_left = 1 THEN page_path END) AS exit_page
        FROM t GROUP BY app_id, visitor_hash, visit_no
    )`;

const num = (value) => (value === null || value === undefined ? null : Number(value));
const rate = (part, whole) => (whole > 0 ? Number(part) / whole : null);

/** Everything but the totals, for a filter that matches nothing. */
function emptySections() {
    return {
        bucket: TREND_BUCKET.DAY,
        trend: [],
        breakdowns: Object.fromEntries(Object.keys(BREAKDOWN_COLUMNS).map((dim) => [dim, []])),
        pages: [],
        entryPages: [],
        exitPages: [],
        transitions: [],
        scrollDepth: [],
        timeOnPage: [],
        hours: [],
        countries: [],
        eventProperties: [],
    };
}

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<[any]> }} pool
 * @param {(appId: string) => string} table the quoted table name of a validated app ID
 * @param {string[]} appIds
 * @param {(window?: string) => { clause: string, params: unknown[] }} filter the WHERE clause for the
 *   requested rows, or with 'previous' for the period of the same length before them
 * @param {{ hasPrevious: boolean }} options
 */
async function runAnalysis(pool, table, appIds, filter, { hasPrevious }) {
    const cte = (window, columns = ANALYSIS_COLUMNS) => {
        const { clause, params } = filter(window);
        const branches = appIds.map((appId) => `SELECT ? AS app_id, ${columns.join(', ')} FROM ${table(appId)} WHERE ${clause}`);
        return { sql: `WITH v AS (${branches.join(' UNION ALL ')})`, params: appIds.flatMap((appId) => [appId, ...params]) };
    };
    const run = async (window, body, extraParams = [], columns) => {
        const { sql, params } = cte(window, columns);
        const [rows] = await pool.query(`${sql} ${body}`, [...params, ...extraParams]);
        return rows;
    };

    const readTotals = async (window) => {
        const [row = {}] = await run(window, `SELECT
                COUNT(*) AS views,
                COALESCE(SUM(event_type = ${PAGEVIEW}), 0) AS pageviews,
                COALESCE(SUM(is_unique), 0) AS unique_views,
                COUNT(DISTINCT visitor_hash) AS visitors,
                COUNT(DISTINCT country) AS countries,
                COALESCE(SUM(admin_modified_at IS NOT NULL), 0) AS modified,
                AVG(CASE WHEN event_type = ${PAGEVIEW} THEN engaged_ms END) AS avg_engaged_ms,
                AVG(CASE WHEN event_type = ${PAGEVIEW} THEN scroll_depth END) AS avg_scroll,
                COUNT(CASE WHEN event_type = ${PAGEVIEW} THEN engaged_ms END) AS engaged_views,
                MIN(timestamp) AS first_at,
                MAX(timestamp) AS last_at
             FROM v`);
        const [visitRow = {}] = await run(window, `${VISITS_CTE}
             SELECT COUNT(*) AS visits, COALESCE(SUM(pages = 1), 0) AS bounces,
                AVG(duration_ms) AS avg_visit_ms, AVG(pages) AS pages_per_visit
             FROM visits`);
        const visits = Number(visitRow.visits || 0);
        return {
            views: Number(row.views || 0),
            pageviews: Number(row.pageviews || 0),
            uniqueViews: Number(row.unique_views || 0),
            visitors: Number(row.visitors || 0),
            countries: Number(row.countries || 0),
            modified: Number(row.modified || 0),
            visits,
            bounceRate: rate(visitRow.bounces || 0, visits),
            avgVisitMs: num(visitRow.avg_visit_ms),
            pagesPerVisit: num(visitRow.pages_per_visit),
            avgEngagedMs: num(row.avg_engaged_ms),
            avgScroll: num(row.avg_scroll),
            engagedViews: Number(row.engaged_views || 0),
            firstAt: row.first_at ?? null,
            lastAt: row.last_at ?? null,
        };
    };

    const totals = await readTotals();
    const previous = hasPrevious ? await readTotals('previous') : null;
    if (totals.views === 0) return { totals, previous, ...emptySections() };

    const bucket = chooseBucket(totals.firstAt, totals.lastAt);
    const trend = await run(undefined, `SELECT ${BUCKET_EXPRESSION[bucket]} AS period, COUNT(*) AS views,
            COALESCE(SUM(is_unique), 0) AS unique_views, COUNT(DISTINCT visitor_hash) AS visitors
         FROM v GROUP BY period ORDER BY period`);

    const groups = Object.entries(BREAKDOWN_COLUMNS).map(([dim, expression]) =>
        `SELECT '${dim}' AS dim, CAST(${expression} AS CHAR) AS value, COUNT(*) AS views,
            COUNT(DISTINCT visitor_hash) AS visitors FROM v GROUP BY value`);
    const breakdownRows = await run(undefined, `SELECT dim, value, views, visitors FROM (
            SELECT dim, value, views, visitors,
                ROW_NUMBER() OVER (PARTITION BY dim ORDER BY views DESC, value) AS rank_in_dim
            FROM (${groups.join(' UNION ALL ')}) AS g
         ) AS ranked
         WHERE rank_in_dim <= ?
         ORDER BY dim, views DESC, value`, [ANALYSIS_TOP_N]);
    const breakdowns = Object.fromEntries(Object.keys(BREAKDOWN_COLUMNS).map((dim) => [dim, []]));
    for (const row of breakdownRows) {
        breakdowns[row.dim]?.push({ value: row.value ?? null, views: Number(row.views), visitors: Number(row.visitors) });
    }

    const pages = await run(undefined, `SELECT app_id, page_path AS page, COUNT(*) AS views,
            COUNT(DISTINCT visitor_hash) AS visitors, AVG(engaged_ms) AS avg_engaged_ms, AVG(scroll_depth) AS avg_scroll
         FROM v WHERE event_type = ${PAGEVIEW}
         GROUP BY app_id, page_path ORDER BY views DESC, page LIMIT ?`, [ANALYSIS_TOP_N]);

    const landings = await run(undefined, `${VISITS_CTE}
         SELECT kind, app_id, page, visits, bounces FROM (
            SELECT kind, app_id, page, visits, bounces,
                ROW_NUMBER() OVER (PARTITION BY kind ORDER BY visits DESC, page) AS rank_in_kind
            FROM (
                SELECT 'entry' AS kind, app_id, entry_page AS page, COUNT(*) AS visits, SUM(pages = 1) AS bounces
                FROM visits GROUP BY app_id, entry_page
                UNION ALL
                SELECT 'exit' AS kind, app_id, exit_page AS page, COUNT(*) AS visits, 0 AS bounces
                FROM visits GROUP BY app_id, exit_page
            ) AS g
         ) AS ranked
         WHERE rank_in_kind <= ?
         ORDER BY kind, visits DESC, page`, [ANALYSIS_TOP_N]);

    const transitions = await run(undefined, `${VISITS_CTE}
         SELECT app_id, page_path AS from_page, next_page AS to_page, COUNT(*) AS steps
         FROM t WHERE next_page IS NOT NULL AND next_page <> page_path
         GROUP BY app_id, page_path, next_page
         ORDER BY steps DESC, from_page, to_page LIMIT ?`, [ANALYSIS.TRANSITIONS_TOP_N]);

    const distributions = await run(undefined, `
         SELECT 'scroll' AS kind,
            CASE WHEN scroll_depth < 25 THEN 0 WHEN scroll_depth < 50 THEN 25 WHEN scroll_depth < 75 THEN 50
                 WHEN scroll_depth < 100 THEN 75 ELSE 100 END AS bucket,
            COUNT(*) AS views
         FROM v WHERE event_type = ${PAGEVIEW} AND scroll_depth IS NOT NULL GROUP BY bucket
         UNION ALL
         SELECT 'time' AS kind,
            CASE WHEN engaged_ms < 10000 THEN 0 WHEN engaged_ms < 30000 THEN 10 WHEN engaged_ms < 60000 THEN 30
                 WHEN engaged_ms < 180000 THEN 60 WHEN engaged_ms < 600000 THEN 180 ELSE 600 END AS bucket,
            COUNT(*) AS views
         FROM v WHERE event_type = ${PAGEVIEW} AND engaged_ms IS NOT NULL GROUP BY bucket
         ORDER BY kind, bucket`);

    const hours = await run(undefined, `SELECT FLOOR(UNIX_TIMESTAMP(timestamp) / 3600) AS hour, COUNT(*) AS views
         FROM v WHERE timestamp >= DATE_SUB(?, INTERVAL ${ANALYSIS.HEATMAP_MAX_DAYS} DAY)
         GROUP BY hour ORDER BY hour`, [totals.lastAt]);

    // Per-country counts, split by the leading event types so the map can
    // show where each type comes from; the rest are grouped as null.
    const types = breakdowns.eventType.map((entry) => entry.value).filter((value) => value !== null);
    const countryRows = await run(undefined, `SELECT country,
            CASE WHEN event_type IN (?) THEN event_type ELSE NULL END AS event_type,
            COUNT(*) AS views
         FROM v WHERE country IS NOT NULL
         GROUP BY country, CASE WHEN event_type IN (?) THEN event_type ELSE NULL END
         ORDER BY country`, [types.length ? types : [''], types.length ? types : ['']]);

    const eventRows = await run(undefined, `SELECT event_type, event_data FROM v
         WHERE event_type <> ${PAGEVIEW} AND event_data IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`, [ANALYSIS.EVENT_PROPERTIES_SAMPLE], [...ANALYSIS_COLUMNS, 'event_data']);

    return {
        totals,
        previous,
        bucket,
        trend: trend.map((row) => ({
            period: String(row.period),
            views: Number(row.views),
            uniqueViews: Number(row.unique_views),
            visitors: Number(row.visitors),
        })),
        breakdowns,
        pages: pages.map((row) => ({
            appId: row.app_id,
            page: row.page ?? null,
            views: Number(row.views),
            visitors: Number(row.visitors),
            avgEngagedMs: num(row.avg_engaged_ms),
            avgScroll: num(row.avg_scroll),
        })),
        entryPages: landings.filter((row) => row.kind === 'entry').map((row) => ({
            appId: row.app_id, page: row.page ?? null, visits: Number(row.visits), bounceRate: rate(row.bounces, Number(row.visits)),
        })),
        exitPages: landings.filter((row) => row.kind === 'exit').map((row) => ({
            appId: row.app_id, page: row.page ?? null, visits: Number(row.visits),
        })),
        transitions: transitions.map((row) => ({
            appId: row.app_id, from: row.from_page ?? null, to: row.to_page ?? null, steps: Number(row.steps),
        })),
        scrollDepth: distributions.filter((row) => row.kind === 'scroll').map((row) => ({ from: Number(row.bucket), views: Number(row.views) })),
        timeOnPage: distributions.filter((row) => row.kind === 'time').map((row) => ({ fromSeconds: Number(row.bucket), views: Number(row.views) })),
        hours: hours.map((row) => ({ hour: Number(row.hour), views: Number(row.views) })),
        countries: countryRows.map((row) => ({ country: row.country, eventType: row.event_type ?? null, views: Number(row.views) })),
        eventProperties: tallyEventProperties(eventRows),
    };
}

/**
 * The most common property values of custom events: for each event type,
 * each top-level key with a text, number, or true/false value.
 *
 * @param {{ event_type: string, event_data: unknown }[]} rows newest first
 * @returns {{ eventType: string, key: string, value: string, count: number }[]}
 */
function tallyEventProperties(rows) {
    const counts = new Map();
    for (const row of rows) {
        let data = row.event_data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { continue; }
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        for (const [key, value] of Object.entries(data)) {
            if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
            const text = String(value).slice(0, 100);
            const id = JSON.stringify([row.event_type, key, text]);
            const entry = counts.get(id) || { eventType: row.event_type, key: key.slice(0, 100), value: text, count: 0 };
            entry.count += 1;
            counts.set(id, entry);
        }
    }
    return [...counts.values()]
        .sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType)
            || a.key.localeCompare(b.key) || a.value.localeCompare(b.value))
        .slice(0, ANALYSIS.EVENT_PROPERTIES_TOP_N);
}

/**
 * Right now: who is on the sites in the last few minutes, and views per
 * minute over the last half hour. Live views only, no other filter.
 *
 * @param {object} pool
 * @param {(appId: string) => string} table
 * @param {string[]} appIds
 */
async function runRealtime(pool, table, appIds) {
    const branches = appIds.map((appId) => `SELECT ? AS app_id, visitor_hash, page_path, event_type, timestamp
        FROM ${table(appId)}
        WHERE deleted_at IS NULL AND timestamp >= DATE_SUB(NOW(), INTERVAL ${ANALYSIS.REALTIME_CHART_MINUTES} MINUTE)`);
    const cte = `WITH v AS (${branches.join(' UNION ALL ')})`;
    const params = [...appIds];
    const recent = `timestamp >= DATE_SUB(NOW(), INTERVAL ${ANALYSIS.REALTIME_VISITOR_MINUTES} MINUTE)`;

    const [[summary = {}]] = await pool.query(`${cte}
        SELECT COUNT(DISTINCT CASE WHEN ${recent} THEN visitor_hash END) AS visitors,
            FLOOR(UNIX_TIMESTAMP(NOW()) / 60) AS now_minute
        FROM v`, params);
    const [minutes] = await pool.query(`${cte}
        SELECT FLOOR(UNIX_TIMESTAMP(timestamp) / 60) AS minute, COUNT(*) AS views
        FROM v GROUP BY minute ORDER BY minute`, params);
    const [pages] = await pool.query(`${cte}
        SELECT app_id, page_path AS page, COUNT(DISTINCT visitor_hash) AS visitors
        FROM v WHERE ${recent} AND event_type = ${PAGEVIEW}
        GROUP BY app_id, page_path ORDER BY visitors DESC, page LIMIT ?`, [...params, ANALYSIS_TOP_N]);

    return {
        visitors: Number(summary.visitors || 0),
        nowMinute: Number(summary.now_minute || 0),
        minutes: minutes.map((row) => ({ minute: Number(row.minute), views: Number(row.views) })),
        pages: pages.map((row) => ({ appId: row.app_id, page: row.page ?? null, visitors: Number(row.visitors) })),
    };
}

module.exports = {
    ANALYSIS_COLUMNS,
    BUCKET_EXPRESSION,
    BREAKDOWN_COLUMNS,
    VISITS_CTE,
    chooseBucket,
    emptySections,
    runAnalysis,
    runRealtime,
    tallyEventProperties,
};
