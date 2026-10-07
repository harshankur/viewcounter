/**
 * The admin analysis over in-memory rows, mirroring db/analysis.js so the API
 * and UI suites (and the demo) see the same shapes and the same arithmetic.
 *
 * NOT evidence that the SQL is right: that is asserted statement by statement
 * in tests/adminAnalysis.test.js and run against MySQL and MariaDB by
 * tests/e2e/run.js. Keep this in step with the SQL, not the reverse.
 */

const { ANALYSIS, ANALYSIS_TOP_N, TREND_BUCKET } = require('../../constants');
const {
    ACQUISITION_DIMENSIONS, BREAKDOWN_COLUMNS, breakdownTotals, chooseBucket, emptySections, tallyEventProperties,
} = require('../../db/analysis');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const PAGEVIEW = 'pageview';

const isoDay = (date) => date.toISOString().slice(0, 10);

/** The label of the trend bucket a timestamp falls in, as the SQL writes it (UTC here). */
function bucketStart(date, bucket) {
    if (bucket === TREND_BUCKET.HOUR) return `${isoDay(date)} ${date.toISOString().slice(11, 13)}:00`;
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (bucket === TREND_BUCKET.WEEK) {
        const weekday = (day.getUTCDay() + 6) % 7;
        return isoDay(new Date(day.getTime() - weekday * DAY_MS));
    }
    if (bucket === TREND_BUCKET.MONTH) return `${isoDay(day).slice(0, 8)}01`;
    return isoDay(day);
}

/** The visitor a row counts towards, as visitor_hash does in the SQL. */
const visitorOf = (row) => row.visitorHash ?? row.sessionId ?? row.id;
const place = (name, row) => (name == null ? null : `${name}, ${row.country ?? '?'}`);
const withVersion = (name, version, parts) =>
    (name == null ? null : [name, version == null ? null : String(version).split('.').slice(0, parts).join('.')].filter((x) => x != null).join(' '));

/** Each breakdown's value for a row, mirroring BREAKDOWN_COLUMNS. */
const BREAKDOWN_VALUE = {
    source: (row) => row.sourceType,
    referrer: (row) => row.referrerDomain,
    referrerUrl: (row) => row.referrer,
    utmSource: (row) => row.utmSource,
    utmMedium: (row) => row.utmMedium,
    utmCampaign: (row) => row.utmCampaign,
    utmTerm: (row) => row.utmTerm,
    utmContent: (row) => row.utmContent,
    page: (row) => row.pagePath,
    title: (row) => row.pageTitle,
    hostname: (row) => row.hostname,
    country: (row) => row.country,
    region: (row) => place(row.region, row),
    city: (row) => place(row.city, row),
    language: (row) => row.language,
    deviceSize: (row) => row.deviceSize,
    deviceType: (row) => row.deviceType,
    browser: (row) => row.browser,
    browserVersion: (row) => withVersion(row.browser, row.browserVersion, 1),
    os: (row) => row.os,
    osVersion: (row) => withVersion(row.os, row.osVersion, 2),
    eventType: (row) => row.eventType,
    app: (row) => row.appId,
};

const average = (values) => {
    const present = values.filter((value) => value !== null && value !== undefined);
    return present.length ? present.reduce((sum, value) => sum + Number(value), 0) / present.length : null;
};
const byTime = (a, b) => a.timestamp - b.timestamp || String(a.id).localeCompare(String(b.id));
/** Views desc, then the value, as the SQL's ORDER BY views DESC, value. */
const topN = (entries, n, key = 'views', label = 'value') => entries
    .sort((a, b) => b[key] - a[key] || String(a[label] ?? '').localeCompare(String(b[label] ?? '')))
    .slice(0, n);

/** Page views grouped into visits: each visit is its page views in order. */
function visitsOf(rows) {
    const byVisitor = new Map();
    for (const row of rows.filter((r) => r.eventType === PAGEVIEW)) {
        const key = `${row.appId}\u0000${visitorOf(row)}`;
        if (!byVisitor.has(key)) byVisitor.set(key, []);
        byVisitor.get(key).push(row);
    }
    const visits = [];
    for (const views of byVisitor.values()) {
        views.sort(byTime);
        let current = null;
        for (const view of views) {
            const gap = current ? (view.timestamp - current.at(-1).timestamp) / 1000 : Infinity;
            if (gap > ANALYSIS.VISIT_GAP_SECONDS) {
                current = [];
                visits.push(current);
            }
            current.push(view);
        }
    }
    return visits;
}

const visitDuration = (visit) =>
    (Math.floor((visit.at(-1).timestamp - visit[0].timestamp) / 1000) * 1000) + (visit.at(-1).engagedMs ?? 0);

function totalsOf(rows) {
    const pageviews = rows.filter((row) => row.eventType === PAGEVIEW);
    const visits = visitsOf(rows);
    const times = rows.map((row) => row.timestamp.getTime());
    return {
        views: rows.length,
        pageviews: pageviews.length,
        uniqueViews: rows.filter((row) => row.isUnique).length,
        visitors: new Set(rows.map(visitorOf)).size,
        countries: new Set(rows.map((row) => row.country).filter(Boolean)).size,
        modified: rows.filter((row) => row.adminModifiedAt !== null).length,
        visits: visits.length,
        bounceRate: visits.length ? visits.filter((visit) => visit.length === 1).length / visits.length : null,
        avgVisitMs: average(visits.map(visitDuration)),
        pagesPerVisit: average(visits.map((visit) => visit.length)),
        avgEngagedMs: average(pageviews.map((row) => row.engagedMs)),
        avgScroll: average(pageviews.map((row) => row.scrollDepth)),
        engagedViews: pageviews.filter((row) => row.engagedMs !== null && row.engagedMs !== undefined).length,
        firstAt: rows.length ? new Date(Math.min(...times)) : null,
        lastAt: rows.length ? new Date(Math.max(...times)) : null,
    };
}

/**
 * @param {object[]} rows the rows a listing with the query would return
 * @param {object[]|null} previousRows the same for the period before, when the range is bounded
 * @param {{ spanDays?: number, now?: Date }} [options] a bounded range's length, which sets the bucket
 */
function memoryAnalysis(rows, previousRows, { spanDays, now = new Date() } = {}) {
    const totals = totalsOf(rows);
    const previous = previousRows ? totalsOf(previousRows) : null;
    const window = spanDays ? { from: new Date(now.getTime() - spanDays * DAY_MS), to: now } : null;
    if (rows.length === 0) return { totals, previous, window, ...emptySections(totals) };

    const bucket = window ? chooseBucket(window.from, window.to) : chooseBucket(totals.firstAt, totals.lastAt);
    const trend = new Map();
    for (const row of rows) {
        const period = bucketStart(row.timestamp, bucket);
        const entry = trend.get(period) || { period, rows: [], visits: [] };
        entry.rows.push(row);
        trend.set(period, entry);
    }
    // A visit counts in the period it began.
    for (const visit of visitsOf(rows)) trend.get(bucketStart(visit[0].timestamp, bucket)).visits.push(visit);

    const breakdowns = {};
    for (const dim of Object.keys(BREAKDOWN_COLUMNS)) {
        const groups = new Map();
        for (const row of rows) {
            if (ACQUISITION_DIMENSIONS.has(dim) && row.eventType !== PAGEVIEW) continue;
            const value = BREAKDOWN_VALUE[dim](row) ?? null;
            const group = groups.get(value) || { value, views: 0, visitors: new Set() };
            group.views += 1;
            group.visitors.add(visitorOf(row));
            groups.set(value, group);
        }
        breakdowns[dim] = topN([...groups.values()], ANALYSIS_TOP_N)
            .map((group) => ({ value: group.value, views: group.views, visitors: group.visitors.size }));
    }

    const pageGroups = new Map();
    for (const row of rows.filter((r) => r.eventType === PAGEVIEW)) {
        const key = `${row.appId}\u0000${row.pagePath}`;
        const group = pageGroups.get(key) || { appId: row.appId, page: row.pagePath ?? null, views: 0, visitors: new Set(), engaged: [], scroll: [] };
        group.views += 1;
        group.visitors.add(visitorOf(row));
        group.engaged.push(row.engagedMs);
        group.scroll.push(row.scrollDepth);
        pageGroups.set(key, group);
    }
    const pages = topN([...pageGroups.values()], ANALYSIS_TOP_N, 'views', 'page').map((group) => ({
        appId: group.appId, page: group.page, views: group.views, visitors: group.visitors.size,
        avgEngagedMs: average(group.engaged), avgScroll: average(group.scroll),
    }));

    const visits = visitsOf(rows);
    const landing = (pick) => {
        const groups = new Map();
        for (const visit of visits) {
            const view = pick(visit);
            const key = `${view.appId}\u0000${view.pagePath}`;
            const group = groups.get(key) || { appId: view.appId, page: view.pagePath ?? null, visits: 0, bounces: 0 };
            group.visits += 1;
            if (visit.length === 1) group.bounces += 1;
            groups.set(key, group);
        }
        return topN([...groups.values()], ANALYSIS_TOP_N, 'visits', 'page');
    };
    const transitions = new Map();
    for (const visit of visits) {
        for (let i = 0; i < visit.length - 1; i++) {
            const from = visit[i].pagePath ?? null;
            const to = visit[i + 1].pagePath ?? null;
            if (to === null || to === from) continue;
            const key = JSON.stringify([visit[i].appId, from, to]);
            const entry = transitions.get(key) || { appId: visit[i].appId, from, to, steps: 0 };
            entry.steps += 1;
            transitions.set(key, entry);
        }
    }

    const pageviews = rows.filter((row) => row.eventType === PAGEVIEW);
    const bucketCounts = (values, bounds) => {
        const counts = new Map();
        for (const value of values) {
            const from = bounds.filter((bound) => value >= bound.at).at(-1).label;
            counts.set(from, (counts.get(from) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => a[0] - b[0]);
    };
    const scrollDepth = bucketCounts(pageviews.map((row) => row.scrollDepth).filter((v) => v !== null && v !== undefined),
        [0, 25, 50, 75, 100].map((at) => ({ at, label: at })))
        .map(([from, views]) => ({ from, views }));
    const timeOnPage = bucketCounts(pageviews.map((row) => row.engagedMs).filter((v) => v !== null && v !== undefined),
        [0, 10, 30, 60, 180, 600].map((s) => ({ at: s * 1000, label: s })))
        .map(([fromSeconds, views]) => ({ fromSeconds, views }));

    const heatmapFrom = totals.lastAt.getTime() - ANALYSIS.HEATMAP_MAX_DAYS * DAY_MS;
    const hours = new Map();
    for (const row of rows) {
        if (row.timestamp.getTime() < heatmapFrom) continue;
        const hour = Math.floor(row.timestamp.getTime() / HOUR_MS);
        hours.set(hour, (hours.get(hour) || 0) + 1);
    }

    const types = new Set(breakdowns.eventType.map((entry) => entry.value).filter((value) => value !== null));
    const byCountry = new Map();
    for (const row of rows) {
        if (!row.country) continue;
        const eventType = types.has(row.eventType) ? row.eventType : null;
        const key = `${row.country}|${eventType}`;
        const entry = byCountry.get(key) || { country: row.country, eventType, views: 0 };
        entry.views += 1;
        byCountry.set(key, entry);
    }

    const events = rows.filter((row) => row.eventType !== PAGEVIEW && row.eventData)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, ANALYSIS.EVENT_PROPERTIES_SAMPLE)
        .map((row) => ({ event_type: row.eventType, event_data: row.eventData }));

    return {
        totals,
        previous,
        window,
        bucket,
        trend: [...trend.values()].sort((a, b) => a.period.localeCompare(b.period)).map(({ period, rows: inPeriod, visits: started }) => {
            const periodPageviews = inPeriod.filter((row) => row.eventType === PAGEVIEW);
            return {
                period,
                views: inPeriod.length,
                pageviews: periodPageviews.length,
                uniqueViews: inPeriod.filter((row) => row.isUnique).length,
                visitors: new Set(inPeriod.map(visitorOf)).size,
                visits: started.length,
                bounceRate: started.length ? started.filter((visit) => visit.length === 1).length / started.length : null,
                avgVisitMs: average(started.map(visitDuration)),
                pagesPerVisit: average(started.map((visit) => visit.length)),
                avgEngagedMs: average(periodPageviews.map((row) => row.engagedMs)),
                avgScroll: average(periodPageviews.map((row) => row.scrollDepth)),
            };
        }),
        breakdowns,
        breakdownTotals: breakdownTotals(totals),
        pages,
        entryPages: landing((visit) => visit[0]).map((group) => ({
            appId: group.appId, page: group.page, visits: group.visits, bounceRate: group.visits ? group.bounces / group.visits : null,
        })),
        exitPages: landing((visit) => visit.at(-1)).map((group) => ({ appId: group.appId, page: group.page, visits: group.visits })),
        transitions: [...transitions.values()]
            .sort((a, b) => b.steps - a.steps || String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)))
            .slice(0, ANALYSIS.TRANSITIONS_TOP_N),
        scrollDepth,
        timeOnPage,
        hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, views]) => ({ hour, views })),
        countries: [...byCountry.values()].sort((a, b) => a.country.localeCompare(b.country)),
        eventProperties: tallyEventProperties(events),
    };
}

/**
 * @param {object[]} liveRows live rows of the apps
 * @param {Date} now
 */
function memoryRealtime(liveRows, now) {
    const at = now.getTime();
    const since = (date, minutes) => Boolean(date) && date.getTime() >= at - minutes * MINUTE_MS;
    // Here now: a view recorded, or one that last reported its engagement, in the last few minutes.
    const recent = liveRows.filter((row) => since(row.timestamp, ANALYSIS.REALTIME_VISITOR_MINUTES)
        || since(row.lastSeenAt, ANALYSIS.REALTIME_VISITOR_MINUTES));
    const minutes = new Map();
    for (const row of liveRows.filter((r) => since(r.timestamp, ANALYSIS.REALTIME_CHART_MINUTES))) {
        const minute = Math.floor(row.timestamp.getTime() / MINUTE_MS);
        minutes.set(minute, (minutes.get(minute) || 0) + 1);
    }
    const pages = new Map();
    for (const row of recent.filter((r) => r.eventType === PAGEVIEW)) {
        const key = `${row.appId}\u0000${row.pagePath}`;
        const entry = pages.get(key) || { appId: row.appId, page: row.pagePath ?? null, visitors: new Set() };
        entry.visitors.add(visitorOf(row));
        pages.set(key, entry);
    }
    return {
        visitors: new Set(recent.map(visitorOf)).size,
        nowMinute: Math.floor(at / MINUTE_MS),
        minutes: [...minutes.entries()].sort((a, b) => a[0] - b[0]).map(([minute, views]) => ({ minute, views })),
        pages: [...pages.values()].map((entry) => ({ appId: entry.appId, page: entry.page, visitors: entry.visitors.size }))
            .sort((a, b) => b.visitors - a.visitors || String(a.page).localeCompare(String(b.page)))
            .slice(0, ANALYSIS_TOP_N),
    };
}

module.exports = { memoryAnalysis, memoryRealtime, bucketStart, visitsOf, BREAKDOWN_VALUE };
