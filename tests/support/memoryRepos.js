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
    ADMIN_SORT_COLUMNS,
    MODIFIED_FILTER,
    SORT_ORDER,
    VIEW_STATUS,
} = require('../../constants');

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

    const rowsOf = (appId) => {
        if (!tables.has(appId)) tables.set(appId, []);
        return tables.get(appId);
    };

    const pick = (appId, ids, predicate) => {
        const wanted = new Set(ids);
        return rowsOf(appId).filter((row) => wanted.has(row.id) && predicate(row));
    };

    const isDeleted = (row) => row.deletedAt !== null;

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

        async listViews(appId, { status, modified, search, sort, order, page, pageSize }) {
            let rows = rowsOf(appId).filter((row) => {
                if (status === VIEW_STATUS.ACTIVE && isDeleted(row)) return false;
                if (status === VIEW_STATUS.DELETED && !isDeleted(row)) return false;
                if (modified === MODIFIED_FILTER.MODIFIED && row.adminModifiedAt === null) return false;
                if (modified === MODIFIED_FILTER.UNMODIFIED && row.adminModifiedAt !== null) return false;
                if (search) {
                    const needle = search.toLowerCase();
                    const haystack = [row.pagePath, row.pageTitle, row.referrerDomain, row.note, row.eventType, row.sessionId];
                    const hit = row.id === search || haystack.some((value) => String(value ?? '').toLowerCase().includes(needle));
                    if (!hit) return false;
                }
                return true;
            });

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
            return { views: rows.slice(start, start + pageSize).map((row) => ({ ...row })), total: rows.length };
        },

        async updateContent(appId, ids, columnValues) {
            const matched = pick(appId, ids, (row) => !isDeleted(row));
            for (const row of matched) {
                for (const [column, value] of Object.entries(columnValues)) {
                    const field = COLUMN_TO_FIELD[column];
                    row[field] = column === 'event_data' && typeof value === 'string' ? JSON.parse(value) : value;
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

        async writeViewLog({ appId, source, viewId, eventType, isUnique }) {
            viewLog.unshift({ id: crypto.randomUUID(), createdAt: now(), appId, source, viewId, eventType, isUnique });
            return true;
        },

        async listAdminLog({ page, pageSize, action, appId }) {
            const entries = adminLog.filter((entry) => (!action || entry.action === action) && (!appId || entry.appId === appId));
            const start = (page - 1) * pageSize;
            return { entries: entries.slice(start, start + pageSize), total: entries.length };
        },

        async listViewLog({ page, pageSize, appId, source }) {
            const entries = viewLog.filter((entry) => (!appId || entry.appId === appId) && (!source || entry.source === source));
            const start = (page - 1) * pageSize;
            return { entries: entries.slice(start, start + pageSize), total: entries.length };
        },
    };

    return { adminRepo, logRepo, tables, adminLog, viewLog };
}

module.exports = { createMemoryRepos, makeView };
