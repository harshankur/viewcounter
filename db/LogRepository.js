/**
 * The two service logs: the admin operation log and the view register log.
 *
 * Both are append-only from the application's point of view. Nothing here
 * updates or deletes an entry.
 */

const crypto = require('crypto');

const {
    ADMIN,
    ADMIN_LOG_TABLE,
    REJECTION_REASON,
    TRACKING_OUTCOME,
    TRACKING_REJECTIONS_TABLE,
    VIEW_LOG_TABLE,
} = require('../constants');
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
    'id', 'created_at', 'app_id', 'source', 'view_id', 'event_type', 'is_unique', 'hostname',
].join(', ');

/**
 * The tracking log is two streams read as one: accepted views, one row each
 * in the view log, and requests that were not stored, counted per minute.
 * Both branches select the same columns so they can be merged and paged
 * together, newest first.
 */
const ACCEPTED_BRANCH = `
    SELECT created_at AS at, id AS entry_id, app_id, source,
        IF(is_unique = 1, '${TRACKING_OUTCOME.RECORDED}', '${TRACKING_OUTCOME.REPEAT}') AS outcome,
        CAST(NULL AS CHAR) AS reason, CAST(NULL AS CHAR) AS detail, hostname,
        view_id, event_type, 1 AS requests
    FROM \`${VIEW_LOG_TABLE}\``;
const REJECTED_BRANCH = `
    SELECT minute AS at, CONCAT_WS('|', minute, source, reason, app_id, detail, hostname) AS entry_id,
        NULLIF(app_id, '') AS app_id, source,
        IF(reason = '${REJECTION_REASON.BOT}', '${TRACKING_OUTCOME.BOT}', '${TRACKING_OUTCOME.REJECTED}') AS outcome,
        reason, NULLIF(detail, '') AS detail, NULLIF(hostname, '') AS hostname,
        CAST(NULL AS CHAR) AS view_id, CAST(NULL AS CHAR) AS event_type, requests
    FROM \`${TRACKING_REJECTIONS_TABLE}\``;

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
    async writeViewLog({ appId, source, viewId, eventType, isUnique, hostname = null }) {
        try {
            await this.pool.query(
                `INSERT INTO \`${VIEW_LOG_TABLE}\`
                    (id, created_at, app_id, source, view_id, event_type, is_unique, hostname)
                 VALUES (?, NOW(3), ?, ?, ?, ?, ?, ?)`,
                [crypto.randomUUID(), appId, source, viewId, eventType, isUnique ? 1 : 0, hostname]
            );
            return true;
        } catch (cause) {
            logWarning(WarningType.VIEW_LOG_WRITE_FAILED, { appId, cause: cause.message });
            return false;
        }
    }

    /**
     * Remove view-log entries older than `days`, a batch at a time so no single
     * statement holds its locks for long. Ordered by the indexed `created_at`,
     * so each batch reads only what it deletes.
     *
     * @param {number} days
     * @returns {Promise<number>} entries removed
     */
    async pruneViewLog(days) {
        const prune = async (table, column) => {
            let total = 0;
            for (;;) {
                const [result] = await this.pool.query(
                    `DELETE FROM \`${table}\` WHERE \`${column}\` < DATE_SUB(NOW(3), INTERVAL ? DAY)
                     ORDER BY \`${column}\` LIMIT ?`,
                    [days, ADMIN.VIEW_LOG_PRUNE_BATCH_SIZE]
                );
                const removed = Number(result?.affectedRows || 0);
                total += removed;
                if (removed < ADMIN.VIEW_LOG_PRUNE_BATCH_SIZE) return total;
            }
        };
        return await prune(VIEW_LOG_TABLE, 'created_at') + await prune(TRACKING_REJECTIONS_TABLE, 'minute');
    }

    /**
     * Add counted rejections, merging into any count already stored for the
     * same minute and key. Never throws: losing a count must not fail the
     * request that produced it, or the flush that carries many.
     *
     * @param {{ minute: Date, source: string, reason: string, appId?: string,
     *   detail?: string, hostname?: string, requests: number }[]} rows
     * @returns {Promise<boolean>}
     */
    async recordRejections(rows) {
        if (rows.length === 0) return true;
        try {
            await this.pool.query(
                `INSERT INTO \`${TRACKING_REJECTIONS_TABLE}\`
                    (minute, source, reason, app_id, detail, hostname, requests)
                 VALUES ${rows.map(() => '(FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?)').join(', ')}
                 ON DUPLICATE KEY UPDATE requests = requests + VALUES(requests)`,
                // The minute as seconds since the epoch, placed in the database's
                // own time zone like every NOW() it is compared with, whatever
                // zone this process runs in.
                rows.flatMap((row) => [
                    Math.floor(new Date(row.minute).getTime() / 1000), row.source, row.reason,
                    row.appId || '', row.detail || '', row.hostname || '', row.requests,
                ])
            );
            return true;
        } catch (cause) {
            logWarning(WarningType.TRACKING_LOG_WRITE_FAILED, { cause: cause.message });
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
     * The tracking log: every tracking request and what became of it, newest
     * first. Accepted views are listed one by one; bots and rejections as one
     * entry per minute and key, with how many requests it stands for.
     *
     * @param {{ page: number, pageSize: number, appId?: string, source?: string, outcome?: string }} query
     * @returns {Promise<{ entries: object[], total: number }>}
     */
    async listTrackingLog({ page, pageSize, appId, source, outcome }) {
        const accepted = { where: [], params: [] };
        const rejected = { where: [], params: [] };
        for (const branch of [accepted, rejected]) {
            if (appId) { branch.where.push('app_id = ?'); branch.params.push(appId); }
            if (source) { branch.where.push('source = ?'); branch.params.push(source); }
        }
        if (outcome === TRACKING_OUTCOME.RECORDED) accepted.where.push('is_unique = 1');
        if (outcome === TRACKING_OUTCOME.REPEAT) accepted.where.push('is_unique = 0');
        if (outcome === TRACKING_OUTCOME.BOT) { rejected.where.push('reason = ?'); rejected.params.push(REJECTION_REASON.BOT); }
        if (outcome === TRACKING_OUTCOME.REJECTED) { rejected.where.push('reason <> ?'); rejected.params.push(REJECTION_REASON.BOT); }

        const wantAccepted = !outcome || outcome === TRACKING_OUTCOME.RECORDED || outcome === TRACKING_OUTCOME.REPEAT;
        const wantRejected = !outcome || outcome === TRACKING_OUTCOME.BOT || outcome === TRACKING_OUTCOME.REJECTED;
        const clause = (branch) => (branch.where.length ? ` WHERE ${branch.where.join(' AND ')}` : '');

        // Each table gives at most the rows the page could need, in the same
        // order as the whole, so a page never sorts either table in full; the
        // view log reads its created_at index backwards to do it.
        const offset = (page - 1) * pageSize;
        const ORDER = 'ORDER BY at DESC, entry_id DESC';
        const branches = [];
        const params = [];
        for (const [want, branch, sql] of [[wantAccepted, accepted, ACCEPTED_BRANCH], [wantRejected, rejected, REJECTED_BRANCH]]) {
            if (!want) continue;
            branches.push(`(${sql}${clause(branch)} ${ORDER} LIMIT ?)`);
            params.push(...branch.params, offset + pageSize);
        }

        const [rows] = await this.pool.query(
            `SELECT * FROM (${branches.join(' UNION ALL ')}) AS entries
             ${ORDER} LIMIT ? OFFSET ?`,
            [...params, pageSize, offset]
        );

        let total = 0;
        if (wantAccepted) {
            const [count] = await this.pool.query(
                `SELECT COUNT(*) AS count FROM \`${VIEW_LOG_TABLE}\`${clause(accepted)}`, accepted.params);
            total += Number(count[0]?.count || 0);
        }
        if (wantRejected) {
            const [count] = await this.pool.query(
                `SELECT COUNT(*) AS count FROM \`${TRACKING_REJECTIONS_TABLE}\`${clause(rejected)}`, rejected.params);
            total += Number(count[0]?.count || 0);
        }

        return {
            entries: rows.map((row) => ({
                id: row.entry_id,
                at: row.at,
                appId: row.app_id ?? null,
                source: row.source,
                outcome: row.outcome,
                reason: row.reason ?? null,
                detail: row.detail ?? null,
                hostname: row.hostname ?? null,
                viewId: row.view_id ?? null,
                eventType: row.event_type ?? null,
                requests: Number(row.requests),
            })),
            total,
        };
    }

    /**
     * How the last `hours` of tracking requests turned out: requests per
     * outcome, and per reason for the ones not stored.
     *
     * @param {{ hours: number, appId?: string }} query
     * @returns {Promise<{ hours: number, outcomes: Record<string, number>, reasons: Record<string, number> }>}
     */
    async trackingSummary({ hours, appId }) {
        const appClause = appId ? ' AND app_id = ?' : '';
        const appParams = appId ? [appId] : [];
        const [acceptedRows] = await this.pool.query(
            `SELECT COALESCE(SUM(is_unique = 1), 0) AS recorded, COALESCE(SUM(is_unique = 0), 0) AS repeats
             FROM \`${VIEW_LOG_TABLE}\` WHERE created_at >= DATE_SUB(NOW(3), INTERVAL ? HOUR)${appClause}`,
            [hours, ...appParams]
        );
        const [reasonRows] = await this.pool.query(
            `SELECT reason, SUM(requests) AS requests FROM \`${TRACKING_REJECTIONS_TABLE}\`
             WHERE minute >= DATE_SUB(NOW(), INTERVAL ? HOUR)${appClause}
             GROUP BY reason ORDER BY reason`,
            [hours, ...appParams]
        );

        const reasons = Object.fromEntries(reasonRows.map((row) => [row.reason, Number(row.requests)]));
        const bots = reasons[REJECTION_REASON.BOT] || 0;
        const rejectedTotal = Object.values(reasons).reduce((sum, value) => sum + value, 0) - bots;
        return {
            hours,
            outcomes: {
                [TRACKING_OUTCOME.RECORDED]: Number(acceptedRows[0]?.recorded || 0),
                [TRACKING_OUTCOME.REPEAT]: Number(acceptedRows[0]?.repeats || 0),
                [TRACKING_OUTCOME.BOT]: bots,
                [TRACKING_OUTCOME.REJECTED]: rejectedTotal,
            },
            reasons,
        };
    }
}

module.exports = LogRepository;
module.exports.ADMIN_LOG_COLUMNS = ADMIN_LOG_COLUMNS;
module.exports.VIEW_LOG_COLUMNS = VIEW_LOG_COLUMNS;
module.exports.parseJson = parseJson;
