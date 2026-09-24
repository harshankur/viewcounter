/**
 * Scheduled retention: expired trash, and old view-log entries.
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
 * Run both jobs now and then on an interval. A job whose retention is zero
 * (keep forever) is skipped; when both are, nothing is scheduled.
 *
 * `getAppIds` is called on every run, so apps provisioned at runtime are
 * covered without a restart. The timer is unref'd so it never keeps the
 * process alive on its own.
 *
 * @param {{ adminRepo: object, logRepo: object, getAppIds: () => string[],
 *   trashDays: number, viewLogDays: number, intervalMs?: number }} deps
 * @returns {() => void} stops the schedule
 */
function startRetention({ adminRepo, logRepo, getAppIds, trashDays, viewLogDays, intervalMs = ADMIN.RETENTION_INTERVAL_MS }) {
    if (!(trashDays > 0) && !(viewLogDays > 0)) return () => {};

    const run = async () => {
        await purgeExpiredTrash({ adminRepo, logRepo, appIds: getAppIds(), days: trashDays });
        await pruneViewLog({ logRepo, days: viewLogDays });
    };
    run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
}

module.exports = { purgeExpiredTrash, pruneViewLog, startRetention };
