/**
 * The two service logs: the admin operation log and the view register log.
 *
 * Both are append-only from the application's point of view. Nothing here
 * updates or deletes an entry.
 */

const crypto = require('crypto');

const { ADMIN_LOG_TABLE, VIEW_LOG_TABLE } = require('../constants');
const { logWarning, WarningType } = require('../utils/errorUtils');

/**
 * Columns returned by an admin-log listing. `session_id` identifies which
 * admin session acted without revealing its token.
 */
const ADMIN_LOG_COLUMNS = [
    'id', 'created_at', 'action', 'session_id', 'masked_ip',
    'app_id', 'target_count', 'target_ids', 'fields',
].join(', ');

const VIEW_LOG_COLUMNS = [
    'id', 'created_at', 'app_id', 'source', 'view_id', 'event_type', 'is_unique',
].join(', ');

/** mysql2 returns JSON columns parsed; tolerate a string from other drivers. */
function parseJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

class LogRepository {
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

    /**
     * Record an admin operation. Never throws: an operation that succeeded must
     * not be reported as failed because its log line could not be written
     * (LOGGING.md §4). The failure is surfaced as a warning instead.
     *
     * `targetCount` defaults to the number of IDs; the automatic trash purge
     * passes a count with no IDs, since it erases by age rather than by ID.
     *
     * @param {{ action: string, sessionId?: string|null, maskedIp?: string|null,
     *   appId?: string|null, targetIds?: string[], targetCount?: number,
     *   fields?: string[] }} entry
     * @returns {Promise<boolean>} whether the entry was written
     */
    async writeAdminLog({
        action,
        sessionId = null,
        maskedIp = null,
        appId = null,
        targetIds = [],
        targetCount = targetIds.length,
        fields = [],
    }) {
        try {
            await this.pool.query(
                `INSERT INTO \`${ADMIN_LOG_TABLE}\`
                    (id, created_at, action, session_id, masked_ip, app_id, target_count, target_ids, fields)
                 VALUES (?, NOW(3), ?, ?, ?, ?, ?, ?, ?)`,
                [
                    crypto.randomUUID(),
                    action,
                    sessionId,
                    maskedIp,
                    appId,
                    targetCount,
                    targetIds.length ? JSON.stringify(targetIds) : null,
                    fields.length ? JSON.stringify(fields) : null,
                ]
            );
            return true;
        } catch (cause) {
            logWarning(WarningType.ADMIN_LOG_WRITE_FAILED, { action, cause: cause.message });
            return false;
        }
    }

    /**
     * Record one accepted view or event. Never throws, for the same reason as
     * writeAdminLog: the view itself was stored, so the visitor's request
     * succeeded.
     *
     * @param {{ appId: string, source: string, viewId: string, eventType: string,
     *   isUnique: boolean }} entry
     * @returns {Promise<boolean>}
     */
    async writeViewLog({ appId, source, viewId, eventType, isUnique }) {
        try {
            await this.pool.query(
                `INSERT INTO \`${VIEW_LOG_TABLE}\`
                    (id, created_at, app_id, source, view_id, event_type, is_unique)
                 VALUES (?, NOW(3), ?, ?, ?, ?, ?)`,
                [crypto.randomUUID(), appId, source, viewId, eventType, isUnique ? 1 : 0]
            );
            return true;
        } catch (cause) {
            logWarning(WarningType.VIEW_LOG_WRITE_FAILED, { appId, cause: cause.message });
            return false;
        }
    }

    /**
     * @param {{ page: number, pageSize: number, action?: string, appId?: string }} query
     * @returns {Promise<{ entries: object[], total: number }>}
     */
    async listAdminLog({ page, pageSize, action, appId }) {
        const where = [];
        const params = [];
        if (action) { where.push('action = ?'); params.push(action); }
        if (appId) { where.push('app_id = ?'); params.push(appId); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [rows] = await this.pool.query(
            `SELECT ${ADMIN_LOG_COLUMNS} FROM \`${ADMIN_LOG_TABLE}\` ${clause}
             ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
            [...params, pageSize, (page - 1) * pageSize]
        );
        const [count] = await this.pool.query(
            `SELECT COUNT(*) AS count FROM \`${ADMIN_LOG_TABLE}\` ${clause}`,
            params
        );

        return {
            entries: rows.map((row) => ({
                id: row.id,
                createdAt: row.created_at,
                action: row.action,
                sessionId: row.session_id,
                maskedIp: row.masked_ip,
                appId: row.app_id,
                targetCount: row.target_count,
                targetIds: parseJson(row.target_ids) || [],
                fields: parseJson(row.fields) || [],
            })),
            total: Number(count[0]?.count || 0),
        };
    }

    /**
     * @param {{ page: number, pageSize: number, appId?: string, source?: string }} query
     * @returns {Promise<{ entries: object[], total: number }>}
     */
    async listViewLog({ page, pageSize, appId, source }) {
        const where = [];
        const params = [];
        if (appId) { where.push('app_id = ?'); params.push(appId); }
        if (source) { where.push('source = ?'); params.push(source); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [rows] = await this.pool.query(
            `SELECT ${VIEW_LOG_COLUMNS} FROM \`${VIEW_LOG_TABLE}\` ${clause}
             ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
            [...params, pageSize, (page - 1) * pageSize]
        );
        const [count] = await this.pool.query(
            `SELECT COUNT(*) AS count FROM \`${VIEW_LOG_TABLE}\` ${clause}`,
            params
        );

        return {
            entries: rows.map((row) => ({
                id: row.id,
                createdAt: row.created_at,
                appId: row.app_id,
                source: row.source,
                viewId: row.view_id,
                eventType: row.event_type,
                isUnique: row.is_unique === 1 || row.is_unique === true,
            })),
            total: Number(count[0]?.count || 0),
        };
    }
}

module.exports = LogRepository;
module.exports.ADMIN_LOG_COLUMNS = ADMIN_LOG_COLUMNS;
module.exports.VIEW_LOG_COLUMNS = VIEW_LOG_COLUMNS;
module.exports.parseJson = parseJson;
