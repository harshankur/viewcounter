/**
 * Data access for the admin UI: listing, editing, annotating, soft-deleting,
 * restoring, and permanently erasing views.
 *
 * Rows are addressed by `public_id` only. Every identifier interpolated into a
 * statement is either an app ID that has passed `isValidAppId` or a column name
 * taken from a fixed allowlist in constants.js, never caller text.
 */

const {
    ADMIN_RANGE_DAYS,
    ADMIN_SORT_COLUMNS,
    ANALYSIS_TOP_N,
    EDITABLE_FIELDS,
    MODIFIED_FILTER,
    SORT_ORDER,
    TREND_BUCKET,
    TREND_BUCKET_MAX_DAYS,
    VIEW_STATUS,
} = require('../constants');
const { getError, ErrorType } = require('../utils/errorUtils');
const { isValidAppId } = require('../utils/appIdUtils');
const { parseJson } = require('./LogRepository');

/**
 * Columns returned to the admin UI. Excludes the internal auto-increment `id`
 * (enumerable) and `visitor_hash` (the pseudonymous visitor identifier, which
 * an admin has no need to see).
 */
const ADMIN_VIEW_COLUMNS = [
    'public_id', 'timestamp', 'masked_ip', 'country', 'devicesize',
    'page_path', 'page_title', 'referrer', 'referrer_domain', 'source_type',
    'browser', 'browser_version', 'os', 'os_version', 'device_type',
    'session_id', 'event_type', 'event_data', 'is_unique',
    'note', 'admin_modified_at', 'deleted_at',
].join(', ');

/**
 * Columns an edit may write. The editable content fields plus the two
 * columns re-derived from `referrer`, which an admin cannot set directly.
 */
const WRITABLE_COLUMNS = new Set([
    ...Object.values(EDITABLE_FIELDS),
    'referrer_domain',
    'source_type',
]);

/** The row-state condition each operation requires of its targets. */
const STATE = {
    ACTIVE: 'deleted_at IS NULL',
    DELETED: 'deleted_at IS NOT NULL',
    ANY: '1 = 1',
};

/** Row condition for each listing status. */
const STATUS_CONDITION = {
    [VIEW_STATUS.ACTIVE]: STATE.ACTIVE,
    [VIEW_STATUS.DELETED]: STATE.DELETED,
    [VIEW_STATUS.ALL]: STATE.ANY,
};

const MODIFIED_CONDITION = {
    [MODIFIED_FILTER.ANY]: null,
    [MODIFIED_FILTER.MODIFIED]: 'admin_modified_at IS NOT NULL',
    [MODIFIED_FILTER.UNMODIFIED]: 'admin_modified_at IS NULL',
};

/**
 * Escape LIKE's wildcards so a search for "50%" matches that text rather than
 * everything starting with "50".
 * @param {string} text
 * @returns {string}
 */
function escapeLike(text) {
    return String(text).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Columns the analysis reads. `visitor_hash` is here only so the database can
 * count distinct visitors; it is never selected into a result set.
 */
const ANALYSIS_COLUMNS = [
    'country', 'event_type', 'source_type', 'devicesize', 'browser', 'os',
    'visitor_hash', 'is_unique', 'timestamp', 'admin_modified_at',
].join(', ');

/**
 * Time-series bucket expressions, keyed by TREND_BUCKET. Fixed literals: the
 * bucket is chosen in code from the data's span, never from caller input.
 * Every bucket is labelled by the date it starts on (YYYY-MM-DD).
 */
const BUCKET_EXPRESSION = {
    [TREND_BUCKET.DAY]: "DATE_FORMAT(timestamp, '%Y-%m-%d')",
    [TREND_BUCKET.WEEK]: "DATE_FORMAT(DATE_SUB(DATE(timestamp), INTERVAL WEEKDAY(timestamp) DAY), '%Y-%m-%d')",
    [TREND_BUCKET.MONTH]: "DATE_FORMAT(timestamp, '%Y-%m-01')",
};

/** Breakdown dimensions of the analysis: API name -> column. Fixed literals. */
const BREAKDOWN_COLUMNS = {
    source: 'source_type',
    deviceSize: 'devicesize',
    browser: 'browser',
    os: 'os',
    eventType: 'event_type',
    app: 'app_id',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The coarsest bucket that keeps a chart of this span readable. */
function chooseBucket(firstAt, lastAt) {
    if (!firstAt || !lastAt) return TREND_BUCKET.DAY;
    const days = (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / DAY_MS;
    if (days <= TREND_BUCKET_MAX_DAYS[TREND_BUCKET.DAY]) return TREND_BUCKET.DAY;
    if (days <= TREND_BUCKET_MAX_DAYS[TREND_BUCKET.WEEK]) return TREND_BUCKET.WEEK;
    return TREND_BUCKET.MONTH;
}

/**
 * The WHERE clause shared by the listing and the analysis, so the table and
 * the charts above it always describe the same rows.
 *
 * @param {{ status?: string, modified?: string, search?: string, range?: string,
 *   eventType?: string }} query
 * @returns {{ clause: string, params: unknown[] }}
 */
function buildFilter({ status, modified, search, range, eventType } = {}) {
    const where = [STATUS_CONDITION[status] || STATE.ACTIVE];
    const params = [];

    const modifiedCondition = MODIFIED_CONDITION[modified];
    if (modifiedCondition) where.push(modifiedCondition);

    if (eventType) {
        where.push('event_type = ?');
        params.push(eventType);
    }

    const days = ADMIN_RANGE_DAYS[range];
    if (days) {
        where.push('timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)');
        params.push(days);
    }

    if (search) {
        const pattern = `%${escapeLike(search)}%`;
        where.push(`(public_id = ? OR page_path LIKE ? OR page_title LIKE ? OR referrer_domain LIKE ?
            OR note LIKE ? OR event_type LIKE ? OR session_id LIKE ?)`);
        params.push(search, pattern, pattern, pattern, pattern, pattern, pattern);
    }

    return { clause: where.join(' AND '), params };
}

/** Shape one row for the API: camelCase, public ID, parsed JSON. */
function toApiRow(row, appId = row.app_id) {
    return {
        id: row.public_id,
        appId,
        timestamp: row.timestamp,
        maskedIp: row.masked_ip,
        country: row.country,
        deviceSize: row.devicesize,
        pagePath: row.page_path,
        pageTitle: row.page_title,
        referrer: row.referrer,
        referrerDomain: row.referrer_domain,
        sourceType: row.source_type,
        browser: row.browser,
        browserVersion: row.browser_version,
        os: row.os,
        osVersion: row.os_version,
        deviceType: row.device_type,
        sessionId: row.session_id,
        eventType: row.event_type,
        eventData: parseJson(row.event_data),
        isUnique: row.is_unique === 1 || row.is_unique === true,
        note: row.note,
        adminModifiedAt: row.admin_modified_at,
        deletedAt: row.deleted_at,
    };
}

class AdminRepository {
    /**
     * @param {{ pool: object, assertReady: () => void }} db a DatabaseManager
     */
    constructor(db) {
        this.db = db;
    }

    get pool() {
        this.db.assertReady();
        return this.db.pool;
    }

    /** Backstop for the route-level allowlist check. */
    table(appId) {
        if (!isValidAppId(appId)) {
            throw getError(ErrorType.INVALID_APP_ID, { appId });
        }
        return `\`${appId}\``;
    }

    /**
     * Row counts per app, for the app picker.
     * @param {string[]} appIds
     * @returns {Promise<Array<{appId: string, active: number, deleted: number, modified: number, available: boolean}>>}
     */
    async summarizeApps(appIds) {
        const summaries = [];
        for (const appId of appIds) {
            try {
                const [rows] = await this.pool.query(
                    `SELECT
                        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
                        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
                        SUM(CASE WHEN deleted_at IS NULL AND admin_modified_at IS NOT NULL THEN 1 ELSE 0 END) AS modified
                     FROM ${this.table(appId)}`
                );
                summaries.push({
                    appId,
                    active: Number(rows[0]?.active || 0),
                    deleted: Number(rows[0]?.deleted || 0),
                    modified: Number(rows[0]?.modified || 0),
                    available: true,
                });
            } catch {
                // A configured app whose table is missing still appears, so the
                // operator can see it is broken rather than silently absent.
                summaries.push({ appId, active: 0, deleted: 0, modified: 0, available: false });
            }
        }
        return summaries;
    }

    /**
     * Which of these apps have a table. Listing and analysing all apps at
     * once skips an app whose table is missing rather than failing outright.
     * @param {string[]} appIds
     * @returns {Promise<string[]>} in the order given
     */
    async existingTables(appIds) {
        if (appIds.length === 0) return [];
        const [rows] = await this.pool.query(
            `SELECT TABLE_NAME AS name FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
            [appIds]
        );
        const present = new Set(rows.map((row) => row.name));
        return appIds.filter((appId) => present.has(appId));
    }

    /**
     * One page of views from one app or several.
     *
     * Several apps are read with UNION ALL. Each branch is sorted and cut to
     * the rows the requested page could possibly need, so a deep page on a
     * large table never unions whole tables.
     *
     * @param {string|string[]} apps one app ID or several
     * @param {{ status: string, modified: string, search?: string, range?: string,
     *   sort: string, order: string, page: number, pageSize: number }} query already validated
     * @returns {Promise<{ views: object[], total: number }>}
     */
    async listViews(apps, query) {
        const appIds = Array.isArray(apps) ? apps : [apps];
        if (appIds.length === 0) return { views: [], total: 0 };

        const { page, pageSize, sort, order } = query;
        const { clause, params } = buildFilter(query);
        const column = ADMIN_SORT_COLUMNS[sort] || ADMIN_SORT_COLUMNS.timestamp;
        const direction = order === SORT_ORDER.ASC ? 'ASC' : 'DESC';
        const offset = (page - 1) * pageSize;

        let rows;
        if (appIds.length === 1) {
            [rows] = await this.pool.query(
                `SELECT ? AS app_id, ${ADMIN_VIEW_COLUMNS} FROM ${this.table(appIds[0])}
                 WHERE ${clause}
                 ORDER BY ${column} ${direction}, id DESC
                 LIMIT ? OFFSET ?`,
                [appIds[0], ...params, pageSize, offset]
            );
        } else {
            const branches = appIds.map((appId) =>
                `(SELECT ? AS app_id, ${ADMIN_VIEW_COLUMNS} FROM ${this.table(appId)}
                  WHERE ${clause}
                  ORDER BY ${column} ${direction}, public_id ${direction}
                  LIMIT ?)`);
            [rows] = await this.pool.query(
                `${branches.join(' UNION ALL ')}
                 ORDER BY ${column} ${direction}, public_id ${direction}
                 LIMIT ? OFFSET ?`,
                [...appIds.flatMap((appId) => [appId, ...params, offset + pageSize]), pageSize, offset]
            );
        }

        const counts = appIds.map((appId) => `(SELECT COUNT(*) FROM ${this.table(appId)} WHERE ${clause})`);
        const [count] = await this.pool.query(
            `SELECT ${counts.join(' + ')} AS count`,
            appIds.flatMap(() => params)
        );

        return { views: rows.map((row) => toApiRow(row)), total: Number(count[0]?.count || 0) };
    }

    /**
     * Aggregates over the same rows a listing with this query would show.
     *
     * @param {string[]} appIds
     * @param {{ status: string, modified: string, search?: string, range?: string }} query
     * @returns {Promise<object>} totals, trend, breakdowns, and per-country counts
     */
    async analyze(appIds, query) {
        const empty = {
            totals: { views: 0, uniqueViews: 0, visitors: 0, countries: 0, modified: 0, firstAt: null, lastAt: null },
            bucket: TREND_BUCKET.DAY,
            trend: [],
            breakdowns: Object.fromEntries(Object.keys(BREAKDOWN_COLUMNS).map((dim) => [dim, []])),
            countries: [],
        };
        if (appIds.length === 0) return empty;

        const { clause, params } = buildFilter(query);
        const branches = appIds.map((appId) =>
            `SELECT ? AS app_id, ${ANALYSIS_COLUMNS} FROM ${this.table(appId)} WHERE ${clause}`);
        const cte = `WITH v AS (${branches.join(' UNION ALL ')})`;
        const cteParams = appIds.flatMap((appId) => [appId, ...params]);

        const [totalRows] = await this.pool.query(
            `${cte} SELECT
                COUNT(*) AS views,
                COALESCE(SUM(is_unique), 0) AS unique_views,
                COUNT(DISTINCT visitor_hash) AS visitors,
                COUNT(DISTINCT country) AS countries,
                COALESCE(SUM(admin_modified_at IS NOT NULL), 0) AS modified,
                MIN(timestamp) AS first_at,
                MAX(timestamp) AS last_at
             FROM v`,
            cteParams
        );
        const totalsRow = totalRows[0] || {};
        const totals = {
            views: Number(totalsRow.views || 0),
            uniqueViews: Number(totalsRow.unique_views || 0),
            visitors: Number(totalsRow.visitors || 0),
            countries: Number(totalsRow.countries || 0),
            modified: Number(totalsRow.modified || 0),
            firstAt: totalsRow.first_at ?? null,
            lastAt: totalsRow.last_at ?? null,
        };
        if (totals.views === 0) return { ...empty, totals };

        const bucket = chooseBucket(totals.firstAt, totals.lastAt);
        const [trendRows] = await this.pool.query(
            `${cte} SELECT ${BUCKET_EXPRESSION[bucket]} AS period, COUNT(*) AS views,
                COALESCE(SUM(is_unique), 0) AS unique_views
             FROM v GROUP BY period ORDER BY period`,
            cteParams
        );

        const groups = Object.entries(BREAKDOWN_COLUMNS).map(([dim, column]) =>
            `SELECT '${dim}' AS dim, ${column} AS value, COUNT(*) AS views FROM v GROUP BY ${column}`);
        const [breakdownRows] = await this.pool.query(
            `${cte} SELECT dim, value, views FROM (
                SELECT dim, value, views,
                    ROW_NUMBER() OVER (PARTITION BY dim ORDER BY views DESC, value) AS rank_in_dim
                FROM (${groups.join(' UNION ALL ')}) AS g
             ) AS ranked
             WHERE rank_in_dim <= ?
             ORDER BY dim, views DESC, value`,
            [...cteParams, ANALYSIS_TOP_N]
        );
        const breakdowns = Object.fromEntries(Object.keys(BREAKDOWN_COLUMNS).map((dim) => [dim, []]));
        for (const row of breakdownRows) {
            breakdowns[row.dim]?.push({ value: row.value ?? null, views: Number(row.views) });
        }

        // Per-country counts, split by the leading event types so the map can
        // show where each type comes from; the rest are grouped as null.
        const types = breakdowns.eventType.map((entry) => entry.value).filter((value) => value !== null);
        const [countryRows] = await this.pool.query(
            `${cte} SELECT country,
                CASE WHEN event_type IN (?) THEN event_type ELSE NULL END AS event_type,
                COUNT(*) AS views
             FROM v WHERE country IS NOT NULL
             GROUP BY country, CASE WHEN event_type IN (?) THEN event_type ELSE NULL END
             ORDER BY country`,
            [...cteParams, types.length ? types : [''], types.length ? types : ['']]
        );

        return {
            totals,
            bucket,
            trend: trendRows.map((row) => ({
                period: String(row.period),
                views: Number(row.views),
                uniqueViews: Number(row.unique_views),
            })),
            breakdowns,
            countries: countryRows.map((row) => ({
                country: row.country,
                eventType: row.event_type ?? null,
                views: Number(row.views),
            })),
        };
    }

    /**
     * Which of `ids` exist in `appId` and are in the required state.
     * @returns {Promise<string[]>}
     */
    async matchIds(appId, ids, state) {
        if (ids.length === 0) return [];
        const [rows] = await this.pool.query(
            `SELECT public_id FROM ${this.table(appId)} WHERE public_id IN (?) AND ${state}`,
            [ids]
        );
        return rows.map((row) => row.public_id);
    }

    /**
     * Edit content fields and mark the rows as admin-modified. Trashed rows are
     * not editable; restore them first.
     *
     * @param {string} appId
     * @param {string[]} ids
     * @param {Record<string, unknown>} columnValues column -> new value
     * @returns {Promise<string[]>} IDs actually changed
     */
    async updateContent(appId, ids, columnValues) {
        const columns = Object.keys(columnValues);
        for (const column of columns) {
            if (!WRITABLE_COLUMNS.has(column)) {
                throw getError(ErrorType.FIELD_NOT_WRITABLE, { column });
            }
        }

        const matched = await this.matchIds(appId, ids, STATE.ACTIVE);
        if (matched.length === 0 || columns.length === 0) return [];

        const assignments = columns.map((column) => `\`${column}\` = ?`).join(', ');
        await this.pool.query(
            `UPDATE ${this.table(appId)} SET ${assignments}, admin_modified_at = NOW()
             WHERE public_id IN (?) AND ${STATE.ACTIVE}`,
            [...columns.map((column) => columnValues[column]), matched]
        );
        return matched;
    }

    /**
     * Set or clear the note. A note is an annotation, not a change to what was
     * observed, so it does not mark the row admin-modified.
     *
     * @param {string} appId
     * @param {string[]} ids
     * @param {string|null} note null clears it
     * @returns {Promise<string[]>}
     */
    async setNote(appId, ids, note) {
        const matched = await this.matchIds(appId, ids, STATE.ANY);
        if (matched.length === 0) return [];

        await this.pool.query(
            `UPDATE ${this.table(appId)} SET note = ? WHERE public_id IN (?)`,
            [note, matched]
        );
        return matched;
    }

    /** Move active rows to the trash. @returns {Promise<string[]>} */
    async softDelete(appId, ids) {
        const matched = await this.matchIds(appId, ids, STATE.ACTIVE);
        if (matched.length === 0) return [];

        await this.pool.query(
            `UPDATE ${this.table(appId)} SET deleted_at = NOW() WHERE public_id IN (?) AND ${STATE.ACTIVE}`,
            [matched]
        );
        return matched;
    }

    /** Bring trashed rows back. @returns {Promise<string[]>} */
    async restore(appId, ids) {
        const matched = await this.matchIds(appId, ids, STATE.DELETED);
        if (matched.length === 0) return [];

        await this.pool.query(
            `UPDATE ${this.table(appId)} SET deleted_at = NULL WHERE public_id IN (?) AND ${STATE.DELETED}`,
            [matched]
        );
        return matched;
    }

    /**
     * Permanently erase rows. Only rows already in the trash can be erased, so
     * erasure is always a deliberate second step after a soft delete.
     * @returns {Promise<string[]>}
     */
    async purge(appId, ids) {
        const matched = await this.matchIds(appId, ids, STATE.DELETED);
        if (matched.length === 0) return [];

        await this.pool.query(
            `DELETE FROM ${this.table(appId)} WHERE public_id IN (?) AND ${STATE.DELETED}`,
            [matched]
        );
        return matched;
    }

    /**
     * Erase trashed rows older than the retention period.
     * @param {string} appId
     * @param {number} days
     * @returns {Promise<number>} rows erased
     */
    async purgeExpired(appId, days) {
        const [result] = await this.pool.query(
            `DELETE FROM ${this.table(appId)}
             WHERE ${STATE.DELETED} AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [days]
        );
        return Number(result?.affectedRows || 0);
    }
}

module.exports = AdminRepository;
module.exports.ADMIN_VIEW_COLUMNS = ADMIN_VIEW_COLUMNS;
module.exports.WRITABLE_COLUMNS = WRITABLE_COLUMNS;
module.exports.escapeLike = escapeLike;
module.exports.toApiRow = toApiRow;
module.exports.buildFilter = buildFilter;
module.exports.chooseBucket = chooseBucket;
module.exports.BREAKDOWN_COLUMNS = BREAKDOWN_COLUMNS;
module.exports.BUCKET_EXPRESSION = BUCKET_EXPRESSION;
