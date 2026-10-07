/**
 * In-memory stand-ins for AdminRepository and LogRepository.
 *
 * Used by the admin API suite and the Playwright UI suite, which need stateful
 * behaviour (delete a row, see it in the trash) to exercise the real router,
 * sessions, CSRF, and validation end to end. This is NOT evidence that the SQL
 * is right: the repositories' SQL is asserted statement by statement in
 * tests/adminRepository.test.js and run against real MySQL and MariaDB by
 * tests/e2e/run.js. Keep these semantics in step with the SQL, not the reverse.
 */

const crypto = require('crypto');

const {
    ADMIN_RANGE_DAYS,
    ADMIN_SORT_COLUMNS,
    MODIFIED_FILTER,
    SORT_ORDER,
    VIEW_STATUS,
} = require('../../constants');
const { memoryAnalysis, memoryRealtime, BREAKDOWN_VALUE } = require('./memoryAnalysis');
const { FILTER_COLUMNS } = require('../../db/analysis');
const ReferrerParser = require('../../utils/referrerParser');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Column name -> API field, for applying an edit's column values. */
const COLUMN_TO_FIELD = {
    page_path: 'pagePath',
    page_title: 'pageTitle',
    referrer: 'referrer',
    referrer_domain: 'referrerDomain',
    source_type: 'sourceType',
    devicesize: 'deviceSize',
    event_type: 'eventType',
    event_data: 'eventData',
};

const SORT_FIELD = Object.fromEntries(
    Object.entries(ADMIN_SORT_COLUMNS).map(([api, column]) => [api, COLUMN_TO_FIELD[column] || ({
        timestamp: 'timestamp',
        country: 'country',
        browser: 'browser',
        os: 'os',
        hostname: 'hostname',
        utm_campaign: 'utmCampaign',
        language: 'language',
        engaged_ms: 'engagedMs',
        admin_modified_at: 'adminModifiedAt',
        deleted_at: 'deletedAt',
    })[column]])
);

/**
 * A plausible view row, overridable field by field.
 * @param {object} [overrides]
 */
function makeView(overrides = {}) {
    return {
        id: crypto.randomUUID(),
        timestamp: new Date('2026-09-01T12:00:00Z'),
        maskedIp: '203.0.113.0',
        country: 'DE',
        deviceSize: 'large',
        pagePath: '/',
        pageTitle: 'Home',
        referrer: null,
        referrerDomain: null,
        sourceType: 'direct',
        browser: 'Chrome',
        browserVersion: '140.0',
        os: 'macOS',
        osVersion: '15',
        deviceType: 'desktop',
        sessionId: null,
        eventType: 'pageview',
        eventData: null,
        isUnique: true,
        hostname: null,
        language: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
        region: null,
        city: null,
        engagedMs: null,
        scrollDepth: null,
        lastSeenAt: null,
        note: null,
        adminModifiedAt: null,
        deletedAt: null,
        ...overrides,
    };
}

/**
 * @param {{ views?: Record<string, object[]>, now?: () => Date }} [options]
 */
function createMemoryRepos({ views = {}, now = () => new Date() } = {}) {
    /** @type {Map<string, object[]>} */
    // Rows are held by reference, so a test can inspect the very objects it
    // seeded after driving the API.
    const tables = new Map(Object.entries(views).map(([appId, rows]) => [appId, [...rows]]));
    const adminLog = [];
    const viewLog = [];
    /** Counted rejections, keyed like the database's primary key. */
    const rejections = new Map();

    const rowsOf = (appId) => {
        if (!tables.has(appId)) tables.set(appId, []);
        return tables.get(appId);
    };

    const pick = (appId, ids, predicate) => {
        const wanted = new Set(ids);
        return rowsOf(appId).filter((row) => wanted.has(row.id) && predicate(row));
    };

    const isDeleted = (row) => row.deletedAt !== null;

    /** Rows of these apps matching a listing query, each tagged with its app. */
    const filtered = (appIds, { status, modified, search, range, eventType, where = {} } = {}, window) => {
        const days = ADMIN_RANGE_DAYS[range];
        // 'previous' is the period of the same length just before the range.
        const cutoff = days ? now().getTime() - days * DAY_MS * (window === 'previous' ? 2 : 1) : null;
        const until = days && window === 'previous' ? now().getTime() - days * DAY_MS : null;
        return appIds.flatMap((appId) => rowsOf(appId).map((row) => Object.assign(row, { appId }))).filter((row) => {
            if ((status || VIEW_STATUS.ACTIVE) === VIEW_STATUS.ACTIVE && isDeleted(row)) return false;
            if (status === VIEW_STATUS.DELETED && !isDeleted(row)) return false;
            if (modified === MODIFIED_FILTER.MODIFIED && row.adminModifiedAt === null) return false;
            if (modified === MODIFIED_FILTER.UNMODIFIED && row.adminModifiedAt !== null) return false;
            if (cutoff !== null && row.timestamp.getTime() < cutoff) return false;
            if (until !== null && row.timestamp.getTime() >= until) return false;
            if (eventType && row.eventType !== eventType) return false;
            for (const [dim, value] of Object.entries(where)) {
                if (Object.hasOwn(FILTER_COLUMNS, dim) && (BREAKDOWN_VALUE[dim](row) ?? null) !== value) return false;
            }
            if (search) {
                const needle = search.toLowerCase();
                const haystack = [row.pagePath, row.pageTitle, row.referrerDomain, row.hostname, row.utmCampaign,
                    row.note, row.eventType, row.sessionId];
                const hit = row.id === search || haystack.some((value) => String(value ?? '').toLowerCase().includes(needle));
                if (!hit) return false;
            }
            return true;
        });
    };

    const adminRepo = {
        async summarizeApps(appIds) {
            return appIds.map((appId) => {
                const rows = rowsOf(appId);
                return {
                    appId,
                    active: rows.filter((row) => !isDeleted(row)).length,
                    deleted: rows.filter(isDeleted).length,
                    modified: rows.filter((row) => !isDeleted(row) && row.adminModifiedAt !== null).length,
                    available: true,
                };
            });
        },

        async existingTables(appIds) {
            return appIds.filter((appId) => tables.has(appId));
        },

        async listViews(apps, { status, modified, search, range, eventType, where, sort, order, page, pageSize }) {
            const appIds = Array.isArray(apps) ? apps : [apps];
            let rows = filtered(appIds, { status, modified, search, range, eventType, where });

            const field = SORT_FIELD[sort] || 'timestamp';
            const direction = order === SORT_ORDER.ASC ? 1 : -1;
            rows = [...rows].sort((a, b) => {
                const left = a[field] ?? '';
                const right = b[field] ?? '';
                if (left < right) return -direction;
                if (left > right) return direction;
                return 0;
            });

            const start = (page - 1) * pageSize;
            // Like the SQL, never the visitor hash.
            const views = rows.slice(start, start + pageSize).map((row) => {
                const view = { ...row };
                delete view.visitorHash;
                return view;
            });
            return { views, total: rows.length };
        },

        async analyze(appIds, query) {
            const rows = filtered(appIds, query);
            const previous = ADMIN_RANGE_DAYS[query.range] ? filtered(appIds, query, 'previous') : null;
            const analysis = memoryAnalysis(rows, previous, { spanDays: ADMIN_RANGE_DAYS[query.range], now: now() });
            return { ...analysis, eventTypes: await adminRepo.eventTypes(appIds, query.status) };
        },

        async eventTypes(appIds, status) {
            return [...new Set(filtered(appIds, { status })
                .map((row) => row.eventType).filter((type) => type !== null && type !== undefined))].sort();
        },

        async realtime(appIds) {
            return memoryRealtime(filtered(appIds, { status: VIEW_STATUS.ACTIVE }), now());
        },

        async updateContent(appId, ids, columnValues) {
            const matched = pick(appId, ids, (row) => !isDeleted(row));
            for (const row of matched) {
                for (const [column, value] of Object.entries(columnValues)) {
                    const field = COLUMN_TO_FIELD[column];
                    row[field] = column === 'event_data' && typeof value === 'string' ? JSON.parse(value) : value;
                }
                // Same site as the row's own: internal, as the SQL decides per row.
                if (Object.hasOwn(columnValues, 'referrer')) {
                    row.sourceType = ReferrerParser.parse(columnValues.referrer, row.hostname).sourceType;
                }
                row.adminModifiedAt = now();
            }
            return matched.map((row) => row.id);
        },

        async setNote(appId, ids, note) {
            const matched = pick(appId, ids, () => true);
            for (const row of matched) row.note = note;
            return matched.map((row) => row.id);
        },

        async softDelete(appId, ids) {
            const matched = pick(appId, ids, (row) => !isDeleted(row));
            for (const row of matched) row.deletedAt = now();
            return matched.map((row) => row.id);
        },

        async restore(appId, ids) {
            const matched = pick(appId, ids, isDeleted);
            for (const row of matched) row.deletedAt = null;
            return matched.map((row) => row.id);
        },

        async purge(appId, ids) {
            const matched = new Set(pick(appId, ids, isDeleted).map((row) => row.id));
            tables.set(appId, rowsOf(appId).filter((row) => !matched.has(row.id)));
            return [...matched];
        },

        async purgeExpired(appId, days) {
            const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000;
            const before = rowsOf(appId).length;
            tables.set(appId, rowsOf(appId).filter((row) => !(isDeleted(row) && row.deletedAt.getTime() < cutoff)));
            return before - rowsOf(appId).length;
        },
    };

    const logRepo = {
        async writeAdminLog({ action, sessionId = null, maskedIp = null, appId = null, targetIds = [], targetCount = targetIds.length, fields = [] }) {
            adminLog.unshift({
                id: crypto.randomUUID(), createdAt: now(), action, sessionId, maskedIp, appId, targetCount, targetIds, fields,
            });
            return true;
        },

        async writeViewLog({ appId, source, viewId, eventType, isUnique, hostname = null }) {
            viewLog.unshift({ id: crypto.randomUUID(), createdAt: now(), appId, source, viewId, eventType, isUnique, hostname });
            return true;
        },

        async recordRejections(rows) {
            for (const row of rows) {
                const entry = { appId: '', detail: '', hostname: '', ...row };
                const key = [entry.minute.getTime(), entry.source, entry.reason, entry.appId, entry.detail, entry.hostname].join('|');
                const existing = rejections.get(key);
                if (existing) existing.requests += row.requests;
                else rejections.set(key, { key, ...entry, minute: new Date(entry.minute) });
            }
            return true;
        },

        async pruneViewLog(days) {
            const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000;
            const before = viewLog.length;
            const kept = viewLog.filter((entry) => entry.createdAt.getTime() >= cutoff);
            viewLog.splice(0, viewLog.length, ...kept);
            let pruned = before - kept.length;
            for (const [key, entry] of rejections) {
                if (entry.minute.getTime() < cutoff) { rejections.delete(key); pruned += 1; }
            }
            return pruned;
        },

        async listAdminLog({ page, pageSize, action, appId }) {
            const entries = adminLog.filter((entry) => (!action || entry.action === action) && (!appId || entry.appId === appId));
            const start = (page - 1) * pageSize;
            return { entries: entries.slice(start, start + pageSize), total: entries.length };
        },

        async listTrackingLog({ page, pageSize, appId, source, outcome }) {
            const accepted = viewLog.map((entry) => ({
                id: entry.id, at: entry.createdAt, appId: entry.appId, source: entry.source,
                outcome: entry.isUnique ? 'recorded' : 'repeat', reason: null, detail: null,
                hostname: entry.hostname ?? null, viewId: entry.viewId, eventType: entry.eventType, requests: 1,
            }));
            const refused = [...rejections.values()].map((entry) => ({
                id: entry.key, at: entry.minute, appId: entry.appId || null, source: entry.source,
                outcome: entry.reason === 'bot' ? 'bot' : 'rejected', reason: entry.reason, detail: entry.detail || null,
                hostname: entry.hostname || null, viewId: null, eventType: null, requests: entry.requests,
            }));
            const entries = [...accepted, ...refused]
                .filter((entry) => (!appId || entry.appId === appId) && (!source || entry.source === source)
                    && (!outcome || entry.outcome === outcome))
                .sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));
            const start = (page - 1) * pageSize;
            return { entries: entries.slice(start, start + pageSize), total: entries.length };
        },

        async trackingSummary({ hours, appId }) {
            const since = now().getTime() - hours * 60 * 60 * 1000;
            const accepted = viewLog.filter((entry) => entry.createdAt.getTime() >= since && (!appId || entry.appId === appId));
            const reasons = {};
            for (const entry of rejections.values()) {
                if (entry.minute.getTime() < since || (appId && entry.appId !== appId)) continue;
                reasons[entry.reason] = (reasons[entry.reason] || 0) + entry.requests;
            }
            const bots = reasons.bot || 0;
            return {
                hours,
                outcomes: {
                    recorded: accepted.filter((entry) => entry.isUnique).length,
                    repeat: accepted.filter((entry) => !entry.isUnique).length,
                    bot: bots,
                    rejected: Object.values(reasons).reduce((sum, value) => sum + value, 0) - bots,
                },
                reasons,
            };
        },
    };

    return { adminRepo, logRepo, tables, adminLog, viewLog, rejections };
}

module.exports = { createMemoryRepos, makeView };
