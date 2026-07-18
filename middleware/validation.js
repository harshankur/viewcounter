const { body, query, param, validationResult } = require('express-validator');

const {
    FIELD_MAX_LENGTH,
    HTTP_STATUS,
    PAYLOAD_LIMITS,
    QUERY_LIMITS,
    TREND_PERIODS,
} = require('../constants');
const { jsonByteLength } = require('../utils/stringUtils');
const { isValidAppId } = require('../utils/appIdUtils');

/** Bounds the origin list an admin can attach to one app. */
const MAX_ORIGINS_PER_APP = 20;

/**
 * Request validation.
 *
 * Every externally-supplied value is bounded here, at the boundary
 * (CODE_STANDARDS.md §6): an allowlist for enum-like fields, an explicit
 * length for anything destined for a fixed-width column, and an integer range
 * for anything that reaches a SQL LIMIT / INTERVAL. Values that fail are
 * rejected with 422 rather than being clamped, so a caller sending nonsense
 * finds out rather than silently getting different data than they asked for.
 */

/**
 * appId must be one of the currently allowed apps. This is the table-name gate.
 *
 * Uses `.custom()` reading `allowedValues.appId` per request rather than
 * `.isIn(array)`, which captures the array at chain-build time. Apps can now be
 * registered at runtime through the admin API, and a validator holding a stale
 * snapshot would reject a tenant that exists.
 */
const appIdParam = (allowedValues) =>
    param('appId')
        .notEmpty().withMessage('appId is required')
        .custom((value) => allowedValues.appId.includes(value)).withMessage('Invalid appId');

const appIdQuery = (allowedValues) =>
    query('appId')
        .notEmpty().withMessage('appId is required')
        .custom((value) => allowedValues.appId.includes(value)).withMessage('Invalid appId');

/** Optional free-text query parameter, bounded to its column width. */
const boundedQuery = (name, max) =>
    query(name)
        .optional()
        .isString().withMessage(`${name} must be a string`)
        .isLength({ max }).withMessage(`${name} must be at most ${max} characters`);

const boundedBody = (name, max) =>
    body(name)
        .optional()
        .isString().withMessage(`${name} must be a string`)
        .isLength({ max }).withMessage(`${name} must be at most ${max} characters`);

/**
 * Bounded integer query parameter. Rejects NaN, negatives, and huge values.
 *
 * Deliberately no `.toInt()` sanitizer: under Express 5 `req.query` is a
 * getter-only property, so a sanitizer appears to work but never writes the
 * coerced value back — the handler would still receive a string and bind it
 * into `LIMIT ?`, which MySQL rejects. Handlers coerce explicitly instead,
 * after this validator has established the value is a valid integer in range.
 */
const boundedInt = (name, min, max) =>
    query(name)
        .optional()
        .isInt({ min, max }).withMessage(`${name} must be an integer between ${min} and ${max}`);

/**
 * Validate registerView request
 */
const validateRegisterView = (allowedValues) => [
    appIdQuery(allowedValues),

    query('deviceSize')
        .notEmpty().withMessage('deviceSize is required')
        .isIn(allowedValues.deviceSize).withMessage('Invalid deviceSize'),

    boundedQuery('page', FIELD_MAX_LENGTH.PAGE_PATH),
    boundedQuery('title', FIELD_MAX_LENGTH.PAGE_TITLE),
    boundedQuery('referrer', FIELD_MAX_LENGTH.REFERRER),
    boundedQuery('sessionId', FIELD_MAX_LENGTH.SESSION_ID),
];

/**
 * Validate custom event request.
 *
 * This endpoint previously hand-rolled three checks and never went through
 * express-validator at all, so `eventData` was arbitrary unbounded JSON
 * persisted verbatim and no field had a length limit.
 */
const validateEvent = (allowedValues) => [
    body('appId')
        .notEmpty().withMessage('appId is required')
        .custom((value) => allowedValues.appId.includes(value)).withMessage('Invalid appId'),

    body('eventType')
        .notEmpty().withMessage('eventType is required')
        .isString().withMessage('eventType must be a string')
        .isLength({ max: FIELD_MAX_LENGTH.EVENT_TYPE })
        .withMessage(`eventType must be at most ${FIELD_MAX_LENGTH.EVENT_TYPE} characters`),

    boundedBody('page', FIELD_MAX_LENGTH.PAGE_PATH),
    boundedBody('title', FIELD_MAX_LENGTH.PAGE_TITLE),
    boundedBody('sessionId', FIELD_MAX_LENGTH.SESSION_ID),

    // Size is checked before anything inspects the value's shape.
    body('eventData')
        .optional()
        .custom((value) => jsonByteLength(value) <= PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES)
        .withMessage(`eventData must serialize to at most ${PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES} bytes`),
];

/**
 * Validate stats request
 */
const validateStatsRequest = (allowedValues) => [appIdParam(allowedValues)];

/**
 * Validate trends request
 */
const validateTrendsRequest = (allowedValues) => [
    appIdParam(allowedValues),

    query('period')
        .optional()
        .isIn(TREND_PERIODS).withMessage(`period must be one of: ${TREND_PERIODS.join(', ')}`),

    boundedInt('days', QUERY_LIMITS.TREND_DAYS_MIN, QUERY_LIMITS.TREND_DAYS_MAX),
];

/**
 * Validate a request taking a plain `limit` (referrers, pages)
 */
const validateListRequest = (allowedValues) => [
    appIdParam(allowedValues),
    boundedInt('limit', QUERY_LIMITS.LIST_LIMIT_MIN, QUERY_LIMITS.LIST_LIMIT_MAX),
];

/**
 * Validate views request
 */
const validateViewsRequest = (allowedValues) => [
    appIdParam(allowedValues),
    boundedInt('limit', QUERY_LIMITS.VIEWS_LIMIT_MIN, QUERY_LIMITS.VIEWS_LIMIT_MAX),
    boundedInt('offset', QUERY_LIMITS.OFFSET_MIN, QUERY_LIMITS.OFFSET_MAX),
];

/**
 * Validate session lookup
 */
const validateSessionRequest = (allowedValues) => [
    appIdParam(allowedValues),

    param('sessionId')
        .notEmpty().withMessage('sessionId is required')
        .isLength({ max: FIELD_MAX_LENGTH.SESSION_ID })
        .withMessage(`sessionId must be at most ${FIELD_MAX_LENGTH.SESSION_ID} characters`),
];

/**
 * Validate an app-provisioning request.
 *
 * `appId` here becomes a table identifier, so it is checked against the strict
 * pattern rather than an allowlist — there is no allowlist yet, that is the
 * point of the call.
 */
const validateAppRegistration = () => [
    body('appId')
        .notEmpty().withMessage('appId is required')
        .custom(isValidAppId)
        .withMessage('appId must be 1-64 characters of letters, digits, underscore, or hyphen, and must not start with an underscore'),

    body('origins')
        .optional()
        .isArray({ max: MAX_ORIGINS_PER_APP })
        .withMessage(`origins must be an array of at most ${MAX_ORIGINS_PER_APP} entries`),

    body('origins.*')
        .optional()
        .isURL({ require_protocol: true, require_tld: false })
        .withMessage('each origin must be an absolute URL, e.g. https://example.com'),
];

/**
 * Handle validation errors
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.UNPROCESSABLE_ENTITY).json({
            message: 'Validation failed',
            errors: errors.array(),
        });
    }
    return next();
};

module.exports = {
    validateAppRegistration,
    validateRegisterView,
    validateEvent,
    validateStatsRequest,
    validateTrendsRequest,
    validateListRequest,
    validateViewsRequest,
    validateSessionRequest,
    handleValidationErrors,
};
