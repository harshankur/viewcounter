/**
 * Centralized error and warning handling.
 *
 * Per agent-instructions CODE_STANDARDS.md §3, application code never calls
 * `new Error("...")` or `console.warn/error` directly. Every failure is
 * identified by an enum member, its message text lives in exactly one table
 * here, and callers branch on `err.code` rather than parsing message strings.
 *
 * `getError` builds and reports but deliberately does NOT throw — the `throw`
 * stays visible at the call site and under the caller's control.
 */

const logger = require('./logger');

/** Fatal conditions. Every thrown error in this project is one of these. */
const ErrorType = {
    DATABASE_NOT_INITIALIZED: 'DATABASE_NOT_INITIALIZED',
    DATABASE_CONNECTION_FAILED: 'DATABASE_CONNECTION_FAILED',
    DATABASE_QUERY_FAILED: 'DATABASE_QUERY_FAILED',
    CONFIG_INSECURE_DEFAULT: 'CONFIG_INSECURE_DEFAULT',
    CONFIG_MISSING_REQUIRED: 'CONFIG_MISSING_REQUIRED',
    CONFIG_INVALID_VALUE: 'CONFIG_INVALID_VALUE',
    INVALID_APP_ID: 'INVALID_APP_ID',
    SECRET_PERSIST_FAILED: 'SECRET_PERSIST_FAILED',
    SECRET_UNAVAILABLE: 'SECRET_UNAVAILABLE',
};

/** Non-fatal conditions worth surfacing but not worth stopping for. */
const WarningType = {
    CONFIG_FILE_UNREADABLE: 'CONFIG_FILE_UNREADABLE',
    CONFIG_FIELD_MISSING: 'CONFIG_FIELD_MISSING',
    PROXY_TRUST_PERMISSIVE: 'PROXY_TRUST_PERMISSIVE',
    SECRET_GENERATED: 'SECRET_GENERATED',
    READ_API_UNPROTECTED: 'READ_API_UNPROTECTED',
    API_KEY_TOO_SHORT: 'API_KEY_TOO_SHORT',
    API_KEY_EMPTY_SCOPE: 'API_KEY_EMPTY_SCOPE',
    APP_ALREADY_REGISTERED: 'APP_ALREADY_REGISTERED',
    FIELD_TRUNCATED: 'FIELD_TRUNCATED',
};

/**
 * Message text, in exactly one place. A plain string for a fixed message, a
 * function where dynamic detail has to be interpolated.
 * @type {Record<string, string | ((info: any) => string)>}
 */
const ERROR_MESSAGES = {
    [ErrorType.DATABASE_NOT_INITIALIZED]: 'Database not initialized',
    [ErrorType.DATABASE_CONNECTION_FAILED]: (info) =>
        `Failed to connect to database '${info?.database}' at ${info?.host}:${info?.port}`,
    [ErrorType.DATABASE_QUERY_FAILED]: (info) => `Database query failed: ${info?.operation}`,
    [ErrorType.CONFIG_INSECURE_DEFAULT]: (info) =>
        `Refusing to start: ${info?.field} is still at its insecure default. ` +
        'Set it explicitly via dbInfo.json, allowed.json, or the environment.',
    [ErrorType.CONFIG_MISSING_REQUIRED]: (info) =>
        `Refusing to start: required configuration '${info?.field}' is missing or empty.`,
    [ErrorType.CONFIG_INVALID_VALUE]: (info) =>
        `Invalid configuration for '${info?.field}': ${info?.reason}`,
    [ErrorType.INVALID_APP_ID]: (info) =>
        `Invalid appId '${info?.appId}'. Must be 1-64 characters of letters, digits, ` +
        'underscore, or hyphen, and must not start with an underscore.',
    [ErrorType.SECRET_PERSIST_FAILED]: (info) =>
        `Could not persist the visitor-hash secret to ${info?.path}. ` +
        'Without a stable secret, visitor hashes are not reversible-resistant across restarts.',
    [ErrorType.SECRET_UNAVAILABLE]: 'Visitor-hash secret has not been initialized',
};

/** @type {Record<string, string | ((info: any) => string)>} */
const WARNING_MESSAGES = {
    [WarningType.CONFIG_FILE_UNREADABLE]: (info) =>
        `Could not parse ${info?.file}; falling back to environment variables and defaults.`,
    [WarningType.CONFIG_FIELD_MISSING]: (info) =>
        `Config field '${info?.field}' absent from ${info?.file}; using ${info?.source}.`,
    [WarningType.PROXY_TRUST_PERMISSIVE]: (info) =>
        `TRUST_PROXY is set to '${info?.value}'. Client-supplied forwarding headers will be ` +
        'trusted, which lets a caller forge their own IP and bypass rate limiting. ' +
        'Set it to the number of proxy hops or an explicit CIDR list.',
    [WarningType.SECRET_GENERATED]: (info) =>
        `Generated a new visitor-hash secret at ${info?.path}. Existing visitor hashes ` +
        'are now unlinkable from new ones, which is the intended privacy behaviour.',
    [WarningType.READ_API_UNPROTECTED]: 'No read API keys configured; analytics read endpoints are disabled.',
    [WarningType.API_KEY_TOO_SHORT]: (info) =>
        `Ignoring an API key of length ${info?.length}; keys must be at least 32 characters.`,
    [WarningType.API_KEY_EMPTY_SCOPE]: (info) =>
        `Ignoring an API key with an unusable scope (${info?.scope}). Use "*" or a non-empty array of app IDs.`,
    [WarningType.APP_ALREADY_REGISTERED]: (info) =>
        `App '${info?.appId}' is already registered; leaving it as-is.`,
    [WarningType.FIELD_TRUNCATED]: (info) =>
        `Field '${info?.field}' exceeded ${info?.max} characters and was truncated before storage.`,
};

/**
 * Resolve a message from its table, whether it is a literal or a builder.
 * @returns {string}
 */
function resolveMessage(table, type, info) {
    const entry = table[type];
    if (entry === undefined) return `Unknown issue: ${type}`;
    return typeof entry === 'function' ? entry(info) : entry;
}

/**
 * The one place an issue is reported. Routes through the logger so the project
 * has a single console sink rather than two competing ones.
 * @param {{type: 'error'|'warning', code: string, message: string, details?: unknown}} issue
 */
function report(issue) {
    const context = issue.details && typeof issue.details === 'object' ? issue.details : {};
    const line = `${issue.code}: ${issue.message}`;
    if (issue.type === 'error') {
        logger.error(line, context);
    } else {
        logger.warn(line, context);
    }
}

/**
 * Build, report, and return an Error. The caller throws it.
 *
 * Cancellation carve-out (CODE_STANDARDS.md §3): an AbortError carries an
 * identity the runtime depends on, so it is passed straight back rather than
 * being wrapped and stripped of its `name`.
 *
 * @param {string} type - an ErrorType member
 * @param {object} [info] - interpolation detail, also attached as `details`
 * @returns {Error}
 */
function getError(type, info) {
    if (info instanceof Error && info.name === 'AbortError') return info;

    const message = resolveMessage(ERROR_MESSAGES, type, info);
    const issue = { type: 'error', code: type, message, details: info };
    report(issue);

    const err = new Error(message);
    err.code = type;
    err.details = info;
    return err;
}

/**
 * Report a non-fatal issue. Never throws, returns nothing.
 * @param {string} type - a WarningType member
 * @param {object} [info]
 */
function logWarning(type, info) {
    const message = resolveMessage(WARNING_MESSAGES, type, info);
    report({ type: 'warning', code: type, message, details: info });
}

module.exports = {
    ErrorType,
    WarningType,
    ERROR_MESSAGES,
    WARNING_MESSAGES,
    getError,
    logWarning,
};
