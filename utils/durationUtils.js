/**
 * Human-readable durations for configuration: "30m", "12h", "7d".
 *
 * Deliberately small: whole numbers of minutes, hours, or days, nothing else,
 * so a value like "30 min" or "1.5h" is refused rather than read as something
 * the operator did not mean. For a session timeout that difference matters.
 */

const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const DURATION = /^(\d{1,6})([mhd])$/;

/**
 * @param {string} raw e.g. "7d"
 * @returns {number|null} milliseconds, or null when the value is not a duration
 */
function parseDuration(raw) {
    const match = DURATION.exec(String(raw ?? '').trim().toLowerCase());
    return match ? Number(match[1]) * UNIT_MS[match[2]] : null;
}

/**
 * The largest whole unit that expresses `ms` exactly: 604800000 -> "7d".
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    for (const unit of ['d', 'h', 'm']) {
        if (ms % UNIT_MS[unit] === 0) return `${ms / UNIT_MS[unit]}${unit}`;
    }
    return `${ms}ms`;
}

module.exports = { parseDuration, formatDuration };
