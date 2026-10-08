/**
 * The salt of the current visitor-hash window.
 *
 * A visitor hash is keyed with the server secret and with a random salt that
 * exists only for the window it belongs to. When the window ends the salt is
 * deleted, and from then on nobody, the operator included, can recompute a
 * hash of that window from a known address and browser: the records it left
 * can no longer be tied to anyone.
 *
 * The salt lives in the database so that a restart, or a second instance,
 * within the window keeps telling the same visitors apart. It is useless
 * without the server secret, which is never in the database.
 */

const crypto = require('crypto');

const { PRIVACY, VISITOR_SALTS_TABLE } = require('../constants');
const PrivacyUtils = require('../utils/privacyUtils');
const { getError, ErrorType } = require('../utils/errorUtils');

const TABLE = `\`${VISITOR_SALTS_TABLE}\``;
const SALT_PATTERN = new RegExp(`^[0-9a-f]{${PRIVACY.SECRET_BYTES * 2}}$`);

/**
 * @param {() => { query: Function }} getPool the manager's pool, read on each use
 * @returns {{ current: (rotationHours: number, now?: number) => Promise<string> }}
 */
function createVisitorSaltStore(getPool) {
    /** The window last read, and the read still under way for it. */
    let cached = { key: null, salt: null };
    let pending = { key: null, promise: null };

    async function read(hours, windowId) {
        const pool = getPool();
        // Whoever gets there first decides the window's salt; everyone reads that one.
        await pool.query(
            `INSERT IGNORE INTO ${TABLE} (rotation_hours, window_id, salt, created_at) VALUES (?, ?, ?, NOW())`,
            [hours, windowId, crypto.randomBytes(PRIVACY.SECRET_BYTES).toString('hex')]);
        const [rows] = await pool.query(
            `SELECT salt FROM ${TABLE} WHERE rotation_hours = ? AND window_id = ?`, [hours, windowId]);
        const salt = Array.isArray(rows) && rows[0] ? rows[0].salt : null;
        // Failing closed is deliberate: a hash made without the salt would
        // stay recomputable for ever while looking like the others.
        if (typeof salt !== 'string' || !SALT_PATTERN.test(salt)) throw getError(ErrorType.SECRET_UNAVAILABLE);
        // Every earlier window is over. This is the deletion that matters.
        // A row of another window length (a second service on this database,
        // or the setting just changed) goes once its own window has run out.
        await pool.query(
            `DELETE FROM ${TABLE}
             WHERE (rotation_hours = ? AND window_id <> ?)
                OR (rotation_hours <> ? AND created_at < DATE_SUB(NOW(), INTERVAL rotation_hours HOUR))`,
            [hours, windowId, hours]);
        return salt;
    }

    return {
        /**
         * @param {number} rotationHours the unique-visitor window
         * @param {number} [now] epoch millis; pass the same value to the hash
         * @returns {Promise<string>} hex salt of the window `now` falls in
         */
        async current(rotationHours, now = Date.now()) {
            const hours = PrivacyUtils.rotationHours(rotationHours);
            const windowId = PrivacyUtils.currentWindowId(hours, now);
            const key = `${hours}:${windowId}`;
            if (cached.key === key) return cached.salt;
            if (pending.key !== key) {
                const promise = read(hours, windowId).then((salt) => {
                    cached = { key, salt };
                    return salt;
                }).finally(() => {
                    if (pending.promise === promise) pending = { key: null, promise: null };
                });
                pending = { key, promise };
            }
            return pending.promise;
        },
    };
}

module.exports = { createVisitorSaltStore };
