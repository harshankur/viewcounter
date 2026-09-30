/**
 * Admin sessions in the database, so a restart or deploy signs nobody out.
 *
 * Same interface as the in-memory store in middleware/adminAuth.js. The table
 * holds each token's SHA-256, never the token. Ages are computed by the
 * database's clock, the same clock that wrote the timestamps, and a session's
 * last-seen time is written at most once a minute however busy the admin is.
 */

const crypto = require('crypto');

const { ADMIN, ADMIN_SESSIONS_TABLE } = require('../constants');
const { hashToken, newToken } = require('../middleware/adminAuth');

const TABLE = `\`${ADMIN_SESSIONS_TABLE}\``;
const seconds = (ms) => Math.floor(ms / 1000);

/**
 * @param {{ pool: object }} db a DatabaseManager; its pool exists once initialized
 * @param {{ idleMs?: number, absoluteMs?: number, maxSessions?: number }} [options]
 */
function createDbSessionStore(db, {
    idleMs = ADMIN.SESSION_IDLE_TIMEOUT_MS,
    absoluteMs = ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
    maxSessions = ADMIN.MAX_SESSIONS,
} = {}) {
    const query = (sql, params) => db.pool.query(sql, params);

    return {
        idleMs,
        absoluteMs,

        async create() {
            // Expired sessions go first, so the table never outgrows the
            // sessions that could still be used.
            await query(
                `DELETE FROM ${TABLE}
                 WHERE last_seen_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)
                    OR created_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
                [seconds(idleMs), seconds(absoluteMs)]
            );
            const token = newToken();
            const id = crypto.randomUUID();
            await query(
                `INSERT INTO ${TABLE} (token_hash, id, created_at, last_seen_at, password_at)
                 VALUES (?, ?, NOW(3), NOW(3), NOW(3))`,
                [hashToken(token), id]
            );
            // Bounded like the in-memory store: beyond the limit, the least
            // recently used sessions end. The derived table lets MySQL read
            // the table it is deleting from.
            await query(
                `DELETE FROM ${TABLE} WHERE token_hash NOT IN (
                    SELECT token_hash FROM (
                        SELECT token_hash FROM ${TABLE} ORDER BY last_seen_at DESC, created_at DESC LIMIT ?
                    ) AS newest
                 )`,
                [maxSessions]
            );
            return { token, session: { id, passwordAgeMs: 0 } };
        },

        async get(token) {
            if (typeof token !== 'string' || token.length === 0) return null;
            const key = hashToken(token);
            const [rows] = await query(
                `SELECT id,
                    TIMESTAMPDIFF(SECOND, created_at, NOW(3)) AS age_s,
                    TIMESTAMPDIFF(SECOND, last_seen_at, NOW(3)) AS idle_s,
                    TIMESTAMPDIFF(SECOND, password_at, NOW(3)) AS password_age_s
                 FROM ${TABLE} WHERE token_hash = ?`,
                [key]
            );
            const row = rows[0];
            if (!row) return null;

            const idle = Number(row.idle_s) * 1000;
            if (idle > idleMs || Number(row.age_s) * 1000 > absoluteMs) {
                await query(`DELETE FROM ${TABLE} WHERE token_hash = ?`, [key]);
                return null;
            }
            if (idle >= ADMIN.SESSION_TOUCH_INTERVAL_MS) {
                await query(`UPDATE ${TABLE} SET last_seen_at = NOW(3) WHERE token_hash = ?`, [key]);
            }
            return { id: row.id, passwordAgeMs: Number(row.password_age_s) * 1000 };
        },

        async destroy(token) {
            if (typeof token !== 'string' || token.length === 0) return false;
            const [result] = await query(`DELETE FROM ${TABLE} WHERE token_hash = ?`, [hashToken(token)]);
            return result.affectedRows > 0;
        },

        async confirmPassword(token) {
            if (typeof token !== 'string' || token.length === 0) return;
            await query(
                `UPDATE ${TABLE} SET password_at = NOW(3), last_seen_at = NOW(3) WHERE token_hash = ?`,
                [hashToken(token)]
            );
        },
    };
}

module.exports = { createDbSessionStore };
