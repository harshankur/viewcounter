/**
 * Automatic erasure of expired trash (GDPR Art. 5(1)(e), storage limitation).
 *
 * A soft-deleted view is kept for TRASH_RETENTION_DAYS so a mistaken delete can
 * be undone, then erased for good. Every run that erases anything leaves an
 * entry in the admin operation log, attributed to the system rather than a
 * session, so an erasure is never silent.
 */

const { ADMIN, ADMIN_ACTION } = require('../constants');
const { logWarning, WarningType } = require('../utils/errorUtils');

/**
 * Erase expired trash in every app once.
 *
 * One app failing does not stop the others; the failure is reported and the
 * next run tries again.
 *
 * @param {{ adminRepo: object, logRepo: object, appIds: string[], days: number }} deps
 * @returns {Promise<Record<string, number>>} rows erased per app
 */
async function purgeExpiredTrash({ adminRepo, logRepo, appIds, days }) {
    const erased = {};
    if (!(days > 0)) return erased;

    for (const appId of appIds) {
        try {
            const count = await adminRepo.purgeExpired(appId, days);
            erased[appId] = count;
            if (count > 0) {
                await logRepo.writeAdminLog({
                    action: ADMIN_ACTION.TRASH_AUTO_PURGED,
                    appId,
                    targetCount: count,
                });
            }
        } catch (cause) {
            logWarning(WarningType.TRASH_PURGE_FAILED, { appId, cause: cause.message });
        }
    }
    return erased;
}

/**
 * Run the purge now and then on an interval.
 *
 * `getAppIds` is called on every run, so apps provisioned at runtime are
 * covered without a restart. The timer is unref'd so it never keeps the
 * process alive on its own.
 *
 * @param {{ adminRepo: object, logRepo: object, getAppIds: () => string[],
 *   days: number, intervalMs?: number }} deps
 * @returns {() => void} stops the schedule
 */
function startTrashRetention({ adminRepo, logRepo, getAppIds, days, intervalMs = ADMIN.TRASH_PURGE_INTERVAL_MS }) {
    if (!(days > 0)) return () => {};

    const run = () => purgeExpiredTrash({ adminRepo, logRepo, appIds: getAppIds(), days });
    run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
}

module.exports = { purgeExpiredTrash, startTrashRetention };
