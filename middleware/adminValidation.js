/**
 * Boundary validation for the admin API (CODE_STANDARDS.md §6).
 *
 * The admin is authenticated, but authenticated is not the same as trusted
 * input: a stolen session, a buggy client, or a crafted request all arrive
 * here. Every value is bounded, every enum-like value is checked against an
 * allowlist, and a batch can never exceed ADMIN.MAX_BATCH_IDS rows.
 */

const { body, param, query, validationResult } = require('express-validator');

const {
    ADMIN,
    ADMIN_ACTION,
    ADMIN_RANGE,
    ADMIN_ERROR_CODE,
    ADMIN_SORT_COLUMNS,
    EDITABLE_FIELDS,
    FIELD_MAX_LENGTH,
    HTTP_STATUS,
    MODIFIED_FILTER,
    PAYLOAD_LIMITS,
    SORT_ORDER,
    UUID_PATTERN,
    VIEW_LOG_SOURCE,
    VIEW_STATUS,
} = require('../constants');
const ReferrerParser = require('../utils/referrerParser');
const { jsonByteLength } = require('../utils/stringUtils');

const within = (values) => (value) => Object.values(values).includes(value);

/** appId path parameter: must be a currently allowed app. */
const adminAppIdParam = (allowed) =>
    param('appId')
        .custom((value) => allowed.appId.includes(value)).withMessage('Unknown appId');

/** Optional appId filter on a log listing. */
const adminAppIdFilter = (allowed) =>
    query('appId')
        .optional()
        .custom((value) => allowed.appId.includes(value)).withMessage('Unknown appId');

const pageQuery = () =>
    query('page')
        .optional()
        .isInt({ min: 1, max: ADMIN.PAGE_MAX }).withMessage(`page must be an integer between 1 and ${ADMIN.PAGE_MAX}`);

const pageSizeQuery = () =>
    query('pageSize')
        .optional()
        .custom((value) => ADMIN.PAGE_SIZES.includes(Number(value)))
        .withMessage(`pageSize must be one of: ${ADMIN.PAGE_SIZES.join(', ')}`);

/**
 * `ids`: a non-empty array of distinct UUIDs, at most MAX_BATCH_IDS long.
 * Checked as a whole before any element is inspected, so an enormous array is
 * rejected on its length rather than walked.
 */
const idsBody = () =>
    body('ids')
        .isArray({ min: 1, max: ADMIN.MAX_BATCH_IDS })
        .withMessage(`ids must be an array of 1 to ${ADMIN.MAX_BATCH_IDS} view IDs`)
        .bail()
        .custom((ids) => ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id)))
        .withMessage('every id must be a UUID')
        .bail()
        .custom((ids) => new Set(ids).size === ids.length)
        .withMessage('ids must not repeat');

const validateLogin = () => [
    body('password')
        .isString().withMessage('password is required')
        .isLength({ min: 1, max: ADMIN.MAX_PASSWORD_INPUT_LENGTH })
        .withMessage('password is required'),
];

/** Filters shared by a listing and its analysis, for one app or all. */
const filterQueries = () => [
    query('status').optional().custom(within(VIEW_STATUS)).withMessage('Invalid status'),
    query('modified').optional().custom(within(MODIFIED_FILTER)).withMessage('Invalid modified filter'),
    query('range').optional().custom(within(ADMIN_RANGE)).withMessage('Invalid range'),
    query('eventType')
        .optional()
        .isString().withMessage('eventType must be a string')
        .isLength({ max: FIELD_MAX_LENGTH.EVENT_TYPE })
        .withMessage(`eventType must be at most ${FIELD_MAX_LENGTH.EVENT_TYPE} characters`),
    query('search')
        .optional()
        .isString().withMessage('search must be a string')
        .isLength({ max: ADMIN.SEARCH_MAX_LENGTH })
        .withMessage(`search must be at most ${ADMIN.SEARCH_MAX_LENGTH} characters`),
];

/** A listing of one app (with `allowed`) or of every app (without). */
const validateViewListing = (allowed) => [
    ...(allowed ? [adminAppIdParam(allowed)] : []),
    ...filterQueries(),
    query('sort').optional().custom((value) => Object.hasOwn(ADMIN_SORT_COLUMNS, value)).withMessage('Invalid sort'),
    query('order').optional().custom(within(SORT_ORDER)).withMessage('Invalid order'),
    pageQuery(),
    pageSizeQuery(),
];

/** The analysis of one app (with `allowed`) or of every app (without). */
const validateAnalysis = (allowed) => [
    ...(allowed ? [adminAppIdParam(allowed)] : []),
    ...filterQueries(),
];


/**
 * Validate one field of an edit and return the column value to store.
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function checkField(field, value, deviceSizes) {
    const optionalText = (max) => {
        if (value === null || value === '') return { ok: true, value: null };
        if (typeof value !== 'string') return { ok: false, error: `${field} must be a string or null` };
        if (value.length > max) return { ok: false, error: `${field} must be at most ${max} characters` };
        return { ok: true, value };
    };

    switch (field) {
        case 'pagePath':
            return optionalText(FIELD_MAX_LENGTH.PAGE_PATH);
        case 'pageTitle':
            return optionalText(FIELD_MAX_LENGTH.PAGE_TITLE);
        case 'referrer':
            return optionalText(FIELD_MAX_LENGTH.REFERRER);
        case 'deviceSize':
            return deviceSizes.includes(value)
                ? { ok: true, value }
                : { ok: false, error: `deviceSize must be one of: ${deviceSizes.join(', ')}` };
        case 'eventType':
            if (typeof value !== 'string' || value.trim().length === 0) {
                return { ok: false, error: 'eventType must be a non-empty string' };
            }
            if (value.length > FIELD_MAX_LENGTH.EVENT_TYPE) {
                return { ok: false, error: `eventType must be at most ${FIELD_MAX_LENGTH.EVENT_TYPE} characters` };
            }
            return { ok: true, value };
        case 'eventData':
            if (value === null) return { ok: true, value: null };
            if (typeof value !== 'object') return { ok: false, error: 'eventData must be an object, an array, or null' };
            if (jsonByteLength(value) > PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES) {
                return { ok: false, error: `eventData must serialize to at most ${PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES} bytes` };
            }
            return { ok: true, value: JSON.stringify(value) };
        default:
            return { ok: false, error: `${field} is not an editable field` };
    }
}

/**
 * Turn an edit's `changes` object into column values.
 *
 * Only EDITABLE_FIELDS may appear. A change to `referrer` also re-derives
 * `referrer_domain` and `source_type` with the same parser the write path
 * uses, so the three can never disagree.
 *
 * @param {unknown} changes
 * @param {string[]} deviceSizes
 * @returns {{ ok: true, columns: Record<string, unknown>, fields: string[] } | { ok: false, error: string }}
 */
function resolveChanges(changes, deviceSizes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        return { ok: false, error: 'changes must be an object' };
    }
    const fields = Object.keys(changes);
    if (fields.length === 0) return { ok: false, error: 'changes must name at least one field' };

    const columns = {};
    for (const field of fields) {
        if (!Object.hasOwn(EDITABLE_FIELDS, field)) {
            return { ok: false, error: `${field} is not an editable field` };
        }
        const result = checkField(field, changes[field], deviceSizes);
        if (!result.ok) return result;
        columns[EDITABLE_FIELDS[field]] = result.value;
    }

    if (Object.hasOwn(changes, 'referrer')) {
        const parsed = ReferrerParser.parse(columns.referrer);
        columns.referrer = parsed.referrer;
        columns.referrer_domain = parsed.referrerDomain;
        columns.source_type = parsed.sourceType;
    }

    return { ok: true, columns, fields };
}

const validateEdit = (allowed) => [
    adminAppIdParam(allowed),
    idsBody(),
    body('changes')
        .custom((changes, { req }) => {
            const result = resolveChanges(changes, allowed.deviceSize);
            req.resolvedChanges = result;
            return result.ok;
        })
        .withMessage((value, { req }) => req.resolvedChanges?.error),
];

const validateNote = (allowed) => [
    adminAppIdParam(allowed),
    idsBody(),
    body('note')
        .custom((note) => note === null || typeof note === 'string').withMessage('note must be a string or null')
        .bail()
        .custom((note) => note === null || note.length <= FIELD_MAX_LENGTH.NOTE)
        .withMessage(`note must be at most ${FIELD_MAX_LENGTH.NOTE} characters`),
];

const validateBatch = (allowed) => [adminAppIdParam(allowed), idsBody()];

const validateAdminLogListing = (allowed) => [
    pageQuery(),
    pageSizeQuery(),
    adminAppIdFilter(allowed),
    query('action').optional().custom(within(ADMIN_ACTION)).withMessage('Invalid action'),
];

const validateViewLogListing = (allowed) => [
    pageQuery(),
    pageSizeQuery(),
    adminAppIdFilter(allowed),
    query('source').optional().custom(within(VIEW_LOG_SOURCE)).withMessage('Invalid source'),
];

/** Admin-shaped validation failure: a stable code plus per-field detail. */
function handleAdminValidation(req, res, next) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    return res.status(HTTP_STATUS.UNPROCESSABLE_ENTITY).json({
        code: ADMIN_ERROR_CODE.VALIDATION_FAILED,
        errors: errors.array().map((error) => ({ field: error.path, message: error.msg })),
    });
}

module.exports = {
    validateLogin,
    validateViewListing,
    validateAnalysis,
    validateEdit,
    validateNote,
    validateBatch,
    validateAdminLogListing,
    validateViewLogListing,
    handleAdminValidation,
    resolveChanges,
    checkField,
};
