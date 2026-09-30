/**
 * Counts tracking requests that were not stored (bots and rejections) and
 * writes the counts to the tracking log in batches.
 *
 * A rejected request must cost less than an accepted one, or the tracking log
 * would turn every flood the rate limiter turns away into database writes. So
 * nothing is written per request: counts accumulate in memory, keyed by
 * minute, endpoint, reason, app, detail, and hostname, and one upsert every
 * TRACKING.REJECTION_FLUSH_MS adds them to what is stored.
 *
 * The key space is bounded as well. App IDs, details, and hostnames can be
 * made up by whoever sends the request, so once TRACKING.REJECTION_MAX_KEYS
 * keys are pending, a new key keeps only its minute, endpoint, and reason.
 * The count stays exact; the made-up values are dropped.
 */

const { TRACKING } = require('../constants');

/** The shape an app ID must have to be kept; anything else is counted as blank. */
const APP_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** Details are our own short labels (a field name, a bot's name), but are bounded anyway. */
const DETAIL_MAX = 64;

const cleanAppId = (value) => (typeof value === 'string' && APP_ID_SHAPE.test(value) ? value : '');
const cleanDetail = (value) => (typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '').slice(0, DETAIL_MAX) : '');
const cleanHostname = (value) => (typeof value === 'string' ? value : '');

/**
 * @param {{ write: (rows: object[]) => Promise<unknown>, now?: () => number,
 *   flushMs?: number, maxKeys?: number }} options
 */
function createRejectionCounter({
    write,
    now = Date.now,
    flushMs = TRACKING.REJECTION_FLUSH_MS,
    maxKeys = TRACKING.REJECTION_MAX_KEYS,
}) {
    const pending = new Map();
    let timer = null;

    function schedule() {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            flush();
        }, flushMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    /**
     * Count one request.
     * @param {{ source: string, reason: string, appId?: string, detail?: string, hostname?: string }} rejection
     */
    function count({ source, reason, appId, detail, hostname }) {
        const minute = Math.floor(now() / TRACKING.REJECTION_BUCKET_MS) * TRACKING.REJECTION_BUCKET_MS;
        let entry = { source, reason, appId: cleanAppId(appId), detail: cleanDetail(detail), hostname: cleanHostname(hostname) };
        let key = [minute, entry.source, entry.reason, entry.appId, entry.detail, entry.hostname].join('\u0000');
        if (!pending.has(key) && pending.size >= maxKeys) {
            entry = { source, reason, appId: '', detail: '', hostname: '' };
            key = [minute, source, reason, '', '', ''].join('\u0000');
        }

        const row = pending.get(key) || { minute: new Date(minute), ...entry, requests: 0 };
        row.requests += 1;
        pending.set(key, row);
        schedule();
    }

    /** Write everything pending now; also used on shutdown. */
    async function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (pending.size === 0) return;
        const rows = [...pending.values()];
        pending.clear();
        await write(rows);
    }

    return {
        count,
        flush,
        get pendingKeys() {
            return pending.size;
        },
    };
}

module.exports = { createRejectionCounter };
