/**
 * The salt of each visitor-hash window.
 *
 * A visitor hash is keyed with the server secret and with a random salt that
 * exists only for the window it belongs to. Once the window is over the salt
 * is deleted, and from then on nobody, the operator included, can recompute a
 * hash of that window from a known address and browser: the records it left
 * can no longer be tied to anyone.
 *
 * The salt lives in the database so that a restart, or a second instance,
 * within the window keeps telling the same visitors apart. It is useless
 * without the server secret, which is never in the database.
 *
 * Deletion goes by the clock, not by traffic: a salt is removed a few minutes
 * after its window ended (the grace covers instances whose clocks differ),
 * by a timer and by every read, whether or not another view ever arrives.
 */

const crypto = require('crypto');

const { PRIVACY, VISITOR_SALTS_TABLE } = require('../constants');
const PrivacyUtils = require('../utils/privacyUtils');
const { getError, logWarning, ErrorType, WarningType } = require('../utils/errorUtils');

const TABLE = `\`${VISITOR_SALTS_TABLE}\``;
const SALT_PATTERN = new RegExp(`^[0-9a-f]{${PRIVACY.SECRET_BYTES * 2}}$`);
const MS_PER_HOUR = 60 * 60 * 1000;

/** When the window `windowId` of length `hours` is over, in epoch millis. */
const windowEnd = (hours, windowId) => (windowId + 1) * hours * MS_PER_HOUR;

/**
 * @param {() => { query: Function }} getPool the manager's pool, read on each use
 * @returns {{
 *   current: (rotationHours: number, now?: number) => Promise<string>,
 *   prune: (now?: number) => Promise<number>,
 *   start: (intervalMs?: number) => void,
 *   stop: () => void,
 * }}
 */
function createVisitorSaltStore(getPool) {
    /**
     * The salts in use, and the reads under way, by `hours:windowId`. The
     * service hashes page views and custom events over different window
     * lengths, so there is one entry per length in use: a handful at most.
     * @type {Map<string, { salt?: string, promise?: Promise<string>, end: number }>}
     */
    const windows = new Map();
    let timer = null;

    /** Forget, in memory too, every window that is over. */
    function forgetEnded(now) {
        for (const [key, entry] of windows) {
            if (entry.end + PRIVACY.SALT_GRACE_MS <= now) windows.delete(key);
        }
    }

    /**
     * Delete the salt of every window that ended more than the grace ago.
     * @param {number} [now] epoch millis
     * @returns {Promise<number>} salts deleted
     */
    async function prune(now = Date.now()) {
        forgetEnded(now);
        const [result] = await getPool().query(
            `DELETE FROM ${TABLE} WHERE (window_id + 1) * rotation_hours * ${MS_PER_HOUR} + ? <= ?`,
            [PRIVACY.SALT_GRACE_MS, now]);
        return (result && result.affectedRows) || 0;
    }

    async function read(hours, windowId, now) {
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
        // A new window is the moment the one before it ended.
        await prune(now);
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
            const known = windows.get(key);
            if (known) return known.salt || known.promise;

            const entry = { end: windowEnd(hours, windowId) };
            entry.promise = read(hours, windowId, now).then((salt) => {
                entry.salt = salt;
                return salt;
            }, (error) => {
                // Nothing is remembered of a failed read: the next view tries again.
                if (windows.get(key) === entry) windows.delete(key);
                throw error;
            });
            windows.set(key, entry);
            return entry.promise;
        },

        prune,

        /**
         * Prune now and then on an interval, so a salt goes when its window
         * ends even on a site nobody visits for days. The timer is unref'd:
         * it never keeps the process alive on its own.
         * @param {number} [intervalMs]
         */
        start(intervalMs = PRIVACY.SALT_PRUNE_INTERVAL_MS) {
            if (timer) return;
            const run = () => prune().catch((cause) => logWarning(WarningType.SALT_PRUNE_FAILED, { cause: cause.message }));
            run();
            timer = setInterval(run, intervalMs);
            timer.unref();
        },

        stop() {
            clearInterval(timer);
            timer = null;
        },
    };
}

module.exports = { createVisitorSaltStore };
