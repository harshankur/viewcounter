/**
 * Structured logger.
 *
 * Per agent-instructions LOGGING.md this is the ONLY module in the project
 * permitted to write to the console. Application code calls debug/info/warn/
 * error/audit; utils/errorUtils.js routes error and warning reporting here so
 * there is exactly one sink, not two.
 */

const { APP_SLUG } = require('../constants');

/** LOGGING.md §1. */
const LogLevel = {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    /** Emits nothing except the audit channel. Used by the test suite. */
    SILENT: 'silent',
};

const LOG_LEVEL_PRIORITY = {
    [LogLevel.DEBUG]: 10,
    [LogLevel.INFO]: 20,
    [LogLevel.WARN]: 30,
    [LogLevel.ERROR]: 40,
    [LogLevel.SILENT]: Number.MAX_SAFE_INTEGER,
};

/** Sensitive keys redacted from any diagnostic dump (LOGGING.md §5). */
const REDACTED_KEYS = new Set(['password', 'secret', 'apikey', 'apikeys', 'token', 'authorization']);

const REDACTED_PLACEHOLDER = '[SET]';
const ABSENT_PLACEHOLDER = '[NOT SET]';

let threshold = LogLevel.INFO;

/**
 * The single underlying write. Swappable so tests can capture output without
 * monkey-patching the console.
 */
let sink = (line) => process.stdout.write(`${line}\n`);

/**
 * Configure the logger. Called once from the server bootstrap after config is
 * resolved, so this module never reads process.env itself (CONFIG.md §0).
 * @param {{ level?: string, writer?: (line: string) => void }} options
 */
function configure({ level, writer } = {}) {
    if (level && Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, level)) {
        threshold = level;
    }
    if (typeof writer === 'function') {
        sink = writer;
    }
}

/** @returns {boolean} whether a message at this level would be emitted. */
function isEnabled(level) {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[threshold];
}

/**
 * Render the correlation context as fixed-position bracket fields so the
 * stream stays greppable (LOGGING.md §2). Absent fields render as `-` rather
 * than being omitted, so column positions never shift.
 */
function formatContext(context = {}) {
    const ip = context.ip || '-';
    const requestId = context.requestId || '-';
    return `[${ip}] [${requestId}]`;
}

/**
 * LOGGING.md §4: a failing sink degrades logging, it never takes down the
 * request that triggered it.
 */
function write(level, message, context) {
    try {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] [${level.toUpperCase()}] ${formatContext(context)} ${message}`;
        sink(line);
    } catch {
        // Intentionally swallowed. There is nowhere left to report to.
    }
}

function log(level, message, context) {
    if (!isEnabled(level)) return;
    write(level, message, context);
}

const debug = (message, context) => log(LogLevel.DEBUG, message, context);
const info = (message, context) => log(LogLevel.INFO, message, context);
const warn = (message, context) => log(LogLevel.WARN, message, context);
const error = (message, context) => log(LogLevel.ERROR, message, context);

/**
 * Audit channel for state-mutating actions (LOGGING.md §3).
 *
 * Deliberately bypasses the level threshold: turning operational verbosity
 * down must never silently discard the record of who changed what. Tagged
 * distinctly so it can be split to its own destination downstream.
 */
function audit(action, context = {}) {
    const actor = context.actor || context.appId || 'anonymous';
    write(`audit:${APP_SLUG}`, `action=${action} actor=${actor}`, context);
}

/**
 * Redact sensitive values for diagnostics output (LOGGING.md §5).
 * Allowlist semantics: anything whose key matches a sensitive name is replaced
 * with a presence marker, never its value.
 */
function redact(record = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(record)) {
        if (REDACTED_KEYS.has(key.toLowerCase())) {
            safe[key] = value ? REDACTED_PLACEHOLDER : ABSENT_PLACEHOLDER;
        } else {
            safe[key] = value;
        }
    }
    return safe;
}

module.exports = {
    LogLevel,
    LOG_LEVEL_PRIORITY,
    configure,
    isEnabled,
    debug,
    info,
    warn,
    error,
    audit,
    redact,
};
