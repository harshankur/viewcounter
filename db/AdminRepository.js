/**
 * Data access for the admin UI: listing, editing, annotating, soft-deleting,
 * restoring, and permanently erasing views.
 *
 * Rows are addressed by `public_id` only. Every identifier interpolated into a
 * statement is either an app ID that has passed `isValidAppId` or a column name
 * taken from a fixed allowlist in constants.js, never caller text.
 */

const {
    ADMIN_SORT_COLUMNS,
    EDITABLE_FIELDS,
    MODIFIED_FILTER,
    SORT_ORDER,
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

/** Shape one row for the API: camelCase, public ID, parsed JSON. */
function toApiRow(row) {
    return {
        id: row.public_id,
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
     * One page of views.
     *
     * @param {string} appId
     * @param {{ status: string, modified: string, search?: string, sort: string,
     *   order: string, page: number, pageSize: number }} query already validated
     * @returns {Promise<{ views: object[], total: number }>}
     */
    async listViews(appId, { status, modified, search, sort, order, page, pageSize }) {
        const where = [STATUS_CONDITION[status] || STATE.ACTIVE];
        const params = [];

        const modifiedCondition = MODIFIED_CONDITION[modified];
        if (modifiedCondition) where.push(modifiedCondition);

        if (search) {
            const pattern = `%${escapeLike(search)}%`;
            where.push(`(public_id = ? OR page_path LIKE ? OR page_title LIKE ? OR referrer_domain LIKE ?
                OR note LIKE ? OR event_type LIKE ? OR session_id LIKE ?)`);
            params.push(search, pattern, pattern, pattern, pattern, pattern, pattern);
        }

        const column = ADMIN_SORT_COLUMNS[sort] || ADMIN_SORT_COLUMNS.timestamp;
        const direction = order === SORT_ORDER.ASC ? 'ASC' : 'DESC';
        const clause = where.join(' AND ');

        const [rows] = await this.pool.query(
            `SELECT ${ADMIN_VIEW_COLUMNS} FROM ${this.table(appId)}
             WHERE ${clause}
             ORDER BY ${column} ${direction}, id DESC
             LIMIT ? OFFSET ?`,
            [...params, pageSize, (page - 1) * pageSize]
        );
        const [count] = await this.pool.query(
            `SELECT COUNT(*) AS count FROM ${this.table(appId)} WHERE ${clause}`,
            params
        );

        return { views: rows.map(toApiRow), total: Number(count[0]?.count || 0) };
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
