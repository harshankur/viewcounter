/**
 * Scheduled retention: old views, expired trash, and old view-log entries.
 *
 * Views (GDPR Art. 5(1)(e), and the period a privacy notice names): a view
 * older than VIEW_RETENTION_DAYS goes to the trash and is erased with it; with
 * the trash kept forever it is erased at once.
 *
 * Trash (GDPR Art. 5(1)(e), storage limitation): a soft-deleted view is kept
 * for TRASH_RETENTION_DAYS so a mistaken delete can be undone, then erased for
 * good.
 *
 * View log: the register of accepted views gains a row per view. It holds no
 * personal data, but unbounded it grows as large as every app table together,
 * so entries older than VIEW_LOG_RETENTION_DAYS are removed.
 *
 * Every run that removes anything leaves an entry in the admin operation log,
 * attributed to the system rather than a session, so nothing is removed
 * silently. The admin log itself is never pruned.
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
 * Retire views older than `days` in every app once: to the trash, or erased
 * when the trash is kept forever. Logged as a count per app, never as IDs.
 *
 * @param {{ adminRepo: object, logRepo: object, appIds: string[], days: number, trashDays: number }} deps
 * @returns {Promise<Record<string, number>>} rows retired per app
 */
async function expireViews({ adminRepo, logRepo, appIds, days, trashDays }) {
    const retired = {};
    if (!(days > 0)) return retired;

    for (const appId of appIds) {
        try {
            const count = await adminRepo.expireOlderThan(appId, days, trashDays > 0 ? trashDays : 0);
            retired[appId] = count;
            if (count > 0) {
                await logRepo.writeAdminLog({ action: ADMIN_ACTION.VIEWS_EXPIRED, appId, targetCount: count });
            }
        } catch (cause) {
            logWarning(WarningType.VIEW_EXPIRY_FAILED, { appId, cause: cause.message });
        }
    }
    return retired;
}

/**
 * Remove view-log entries older than `days` once. A failure is reported and
 * the next run tries again.
 *
 * @param {{ logRepo: object, days: number }} deps
 * @returns {Promise<number>} entries removed
 */
async function pruneViewLog({ logRepo, days }) {
    if (!(days > 0)) return 0;
    try {
        const count = await logRepo.pruneViewLog(days);
        if (count > 0) {
            await logRepo.writeAdminLog({ action: ADMIN_ACTION.VIEW_LOG_PRUNED, targetCount: count });
        }
        return count;
    } catch (cause) {
        logWarning(WarningType.VIEW_LOG_PRUNE_FAILED, { cause: cause.message });
        return 0;
    }
}

/**
 * Run the jobs now and then on an interval: old views first, so the trash run
 * that follows sees them. A job whose retention is zero (keep forever) is
 * skipped; when all are, nothing is scheduled.
 *
 * `getAppIds` is called on every run, so apps provisioned at runtime are
 * covered without a restart. The timer is unref'd so it never keeps the
 * process alive on its own.
 *
 * @param {{ adminRepo: object, logRepo: object, getAppIds: () => string[],
 *   trashDays: number, viewLogDays: number, viewDays?: number, intervalMs?: number }} deps
 * @returns {() => void} stops the schedule
 */
function startRetention({ adminRepo, logRepo, getAppIds, trashDays, viewLogDays, viewDays = 0, intervalMs = ADMIN.RETENTION_INTERVAL_MS }) {
    if (!(trashDays > 0) && !(viewLogDays > 0) && !(viewDays > 0)) return () => {};

    const run = async () => {
        await expireViews({ adminRepo, logRepo, appIds: getAppIds(), days: viewDays, trashDays });
        await purgeExpiredTrash({ adminRepo, logRepo, appIds: getAppIds(), days: trashDays });
        await pruneViewLog({ logRepo, days: viewLogDays });
    };
    run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
}

module.exports = { expireViews, purgeExpiredTrash, pruneViewLog, startRetention };
