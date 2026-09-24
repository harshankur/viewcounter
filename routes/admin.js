/**
 * Admin UI and its JSON API.
 *
 * Mounted at ADMIN.PATH_PREFIX, and only when ADMIN_PASSWORD is configured:
 * with no password there is no route, so the surface does not exist rather
 * than existing behind a check that could be got wrong.
 *
 *   /admin/            the UI: static, build-free, no data of its own
 *   /admin/api/...     session-authenticated JSON API
 *
 * Trust model: the static shell is public because it contains nothing; every
 * API route except /session and /login requires a session, and every
 * state-changing route also requires the session's CSRF token. Every mutation
 * is recorded in the admin operation log.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
    ADMIN,
    ADMIN_ACTION,
    ADMIN_ERROR_CODE,
    ADMIN_RANGE,
    ADMIN_SORT_COLUMNS,
    EDITABLE_FIELDS,
    FIELD_MAX_LENGTH,
    HTTP_STATUS,
    MODIFIED_FILTER,
    SORT_ORDER,
    VIEW_LOG_SOURCE,
    VIEW_STATUS,
} = require('../constants');
const logger = require('../utils/logger');
const { ErrorType, getError, logWarning, WarningType } = require('../utils/errorUtils');
const { noStore } = require('../middleware/security');
const {
    createSessionStore,
    requireAdminSession,
    requireCsrf,
    verifyPassword,
    cookieOptions,
    originAllowed,
    readToken,
} = require('../middleware/adminAuth');
const {
    validateLogin,
    validateViewListing,
    validateAnalysis,
    validateEdit,
    validateNote,
    validateBatch,
    validateAdminLogListing,
    validateViewLogListing,
    handleAdminValidation,
} = require('../middleware/adminValidation');
const { logContext, withRequestId } = require('./analytics');

/** The UI's static files, shipped in the package. */
const ADMIN_UI_DIR = path.join(__dirname, '..', 'admin');

/**
 * Content Security Policy for the admin surface. Stricter than helmet's
 * default: no inline script or style anywhere, no third-party origin at all
 * (including fonts, which would disclose every admin's IP to the font host),
 * and no framing.
 */
const ADMIN_CSP = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
};

/** Read a validated integer query parameter, or its default. */
function intParam(req, name, fallback) {
    const parsed = Number.parseInt(req.query[name], 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/** The filters a listing and its analysis share, with defaults applied. */
function filterQuery(req) {
    return {
        status: req.query.status || VIEW_STATUS.ACTIVE,
        modified: req.query.modified || MODIFIED_FILTER.ANY,
        range: req.query.range || ADMIN_RANGE.ALL,
        search: req.query.search || '',
        eventType: req.query.eventType || '',
    };
}

/** Stable failure response; the detail stays in the server log. */
function adminError(req, res, error, operation) {
    logger.error(`admin ${operation} failed: ${error.message}`, logContext(req));
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        code: ADMIN_ERROR_CODE.SERVER_ERROR,
        requestId: req.id,
    });
}

/**
 * @param {{ config: object, adminRepo: object, logRepo: object,
 *   sessionStore?: object, isReady?: () => boolean, uiDir?: string }} deps
 * @returns {import('express').Router}
 */
function createAdminRouter({
    config,
    adminRepo,
    logRepo,
    sessionStore = createSessionStore(),
    isReady = () => true,
    uiDir = ADMIN_UI_DIR,
}) {
    // The standalone server checks this when it loads its config; an app
    // embedding the router gets the same floor, not a weaker admin surface.
    const password = config?.admin?.password;
    if (typeof password !== 'string' || password.length < ADMIN.MIN_PASSWORD_LENGTH) {
        throw getError(ErrorType.CONFIG_INVALID_VALUE, {
            field: 'admin.password',
            reason: `must be at least ${ADMIN.MIN_PASSWORD_LENGTH} characters`,
        });
    }

    const router = express.Router();

    router.use(withRequestId);
    // Where this router is mounted ('/admin' in the server, anything when
    // another app embeds it): the session cookie is scoped to it.
    router.use((req, res, next) => {
        req.adminBasePath = req.baseUrl || '/';
        next();
    });
    router.use(helmet.contentSecurityPolicy({ useDefaults: false, directives: ADMIN_CSP }));
    router.use((req, res, next) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');
        res.set('Referrer-Policy', 'no-referrer');
        next();
    });
    router.use(rateLimit({
        windowMs: ADMIN.RATE_LIMIT_WINDOW_MS,
        limit: ADMIN.RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({ code: ADMIN_ERROR_CODE.RATE_LIMITED }),
    }));

    router.use(ADMIN.API_PATH, createAdminApi({ config, adminRepo, logRepo, sessionStore, isReady }));

    // Relative asset URLs in the UI only resolve under a trailing slash.
    router.get('/', (req, res, next) => {
        const [pathname, search = ''] = req.originalUrl.split('?');
        if (pathname.endsWith('/')) return next();
        return res.redirect(`${pathname}/${search ? `?${search}` : ''}`);
    });
    router.use(express.static(uiDir, { index: 'index.html', dotfiles: 'ignore', redirect: false }));

    return router;
}

/**
 * The JSON API behind the UI.
 */
function createAdminApi({ config, adminRepo, logRepo, sessionStore, isReady }) {
    const api = express.Router();
    const allowed = config.allowed;

    api.use(express.json({ limit: ADMIN.MAX_BODY_BYTES }));
    api.use(noStore);
    api.use((req, res, next) => {
        if (isReady()) return next();
        return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({ code: ADMIN_ERROR_CODE.SERVER_ERROR });
    });

    const requireSession = requireAdminSession(sessionStore);
    const csrf = requireCsrf();
    const authed = [requireSession, csrf];

    /** Everything an admin log entry needs from the request. */
    const actor = (req) => ({
        sessionId: req.adminSession?.id ?? null,
        maskedIp: logContext(req).ip,
    });

    const record = async (req, action, fields = {}) => {
        logger.audit(`admin:${action}`, { ...logContext(req), actor: req.adminSession?.id, appId: fields.appId });
        await logRepo.writeAdminLog({ action, ...actor(req), ...fields });
    };

    // ---- Session ----------------------------------------------------------

    api.get('/session', (req, res) => {
        const session = sessionStore.get(readToken(req));
        if (!session) return res.json({ authenticated: false });
        return res.json({ authenticated: true, csrfToken: session.csrfToken });
    });

    const loginLimiter = rateLimit({
        windowMs: ADMIN.LOGIN_RATE_LIMIT_WINDOW_MS,
        limit: ADMIN.LOGIN_RATE_LIMIT_MAX,
        // Only a wrong password is a guess. A refused origin or a malformed
        // body never reaches the password check, so it must not lock the
        // admin out (a misconfigured proxy would otherwise do exactly that).
        skipSuccessfulRequests: true,
        requestWasSuccessful: (req, res) => res.statusCode !== HTTP_STATUS.UNAUTHORIZED,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({ code: ADMIN_ERROR_CODE.TOO_MANY_ATTEMPTS }),
    });

    api.post('/login', loginLimiter, validateLogin(), handleAdminValidation, async (req, res) => {
        try {
            if (!originAllowed(req)) {
                return res.status(HTTP_STATUS.FORBIDDEN).json({ code: ADMIN_ERROR_CODE.CSRF_REJECTED });
            }

            if (!verifyPassword(req.body.password, config.admin.password)) {
                await record(req, ADMIN_ACTION.LOGIN_FAILED);
                return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: ADMIN_ERROR_CODE.INVALID_PASSWORD });
            }

            if (!req.secure && config.server?.isProduction) {
                logWarning(WarningType.ADMIN_INSECURE_TRANSPORT);
            }

            // A fresh token on every login; any previous session in this
            // browser is ended rather than left valid alongside the new one.
            sessionStore.destroy(readToken(req));
            const { token, session } = sessionStore.create();
            res.cookie(ADMIN.SESSION_COOKIE, token, cookieOptions(req));

            req.adminSession = session;
            await record(req, ADMIN_ACTION.LOGIN_SUCCEEDED);
            return res.json({ authenticated: true, csrfToken: session.csrfToken });
        } catch (error) {
            return adminError(req, res, error, 'login');
        }
    });

    api.post('/logout', authed, async (req, res) => {
        try {
            await record(req, ADMIN_ACTION.LOGOUT);
            sessionStore.destroy(req.adminToken);
            res.clearCookie(ADMIN.SESSION_COOKIE, { ...cookieOptions(req), maxAge: undefined });
            return res.status(HTTP_STATUS.NO_CONTENT).end();
        } catch (error) {
            return adminError(req, res, error, 'logout');
        }
    });

    // ---- Reference data ---------------------------------------------------

    api.get('/meta', requireSession, (req, res) => {
        res.json({
            deviceSizes: allowed.deviceSize,
            editableFields: Object.keys(EDITABLE_FIELDS),
            sortFields: Object.keys(ADMIN_SORT_COLUMNS),
            statuses: Object.values(VIEW_STATUS),
            ranges: Object.values(ADMIN_RANGE),
            modifiedFilters: Object.values(MODIFIED_FILTER),
            actions: Object.values(ADMIN_ACTION),
            sources: Object.values(VIEW_LOG_SOURCE),
            maxBatchIds: ADMIN.MAX_BATCH_IDS,
            pageSizes: ADMIN.PAGE_SIZES,
            pageSizeDefault: ADMIN.PAGE_SIZE_DEFAULT,
            searchMaxLength: ADMIN.SEARCH_MAX_LENGTH,
            trashRetentionDays: config.admin.trashRetentionDays,
            maxLength: {
                note: FIELD_MAX_LENGTH.NOTE,
                pagePath: FIELD_MAX_LENGTH.PAGE_PATH,
                pageTitle: FIELD_MAX_LENGTH.PAGE_TITLE,
                referrer: FIELD_MAX_LENGTH.REFERRER,
                eventType: FIELD_MAX_LENGTH.EVENT_TYPE,
            },
        });
    });

    api.get('/apps', requireSession, async (req, res) => {
        try {
            const apps = await adminRepo.summarizeApps(allowed.appId);
            return res.json({ apps });
        } catch (error) {
            return adminError(req, res, error, 'list apps');
        }
    });

    // ---- Views ------------------------------------------------------------

    const listingQuery = (req) => ({
        ...filterQuery(req),
        sort: req.query.sort || 'timestamp',
        order: req.query.order || SORT_ORDER.DESC,
        page: intParam(req, 'page', 1),
        pageSize: intParam(req, 'pageSize', ADMIN.PAGE_SIZE_DEFAULT),
    });

    api.get('/apps/:appId/views', requireSession, validateViewListing(allowed), handleAdminValidation,
        async (req, res) => {
            try {
                const query = listingQuery(req);
                const result = await adminRepo.listViews([req.params.appId], query);
                return res.json({ appId: req.params.appId, ...query, ...result });
            } catch (error) {
                return adminError(req, res, error, 'list views');
            }
        });

    /** Every app at once. An app whose table is missing is left out, not fatal. */
    api.get('/views', requireSession, validateViewListing(), handleAdminValidation, async (req, res) => {
        try {
            const query = listingQuery(req);
            const apps = await adminRepo.existingTables(allowed.appId);
            const result = await adminRepo.listViews(apps, query);
            return res.json({ apps, ...query, ...result });
        } catch (error) {
            return adminError(req, res, error, 'list all views');
        }
    });

    api.get('/apps/:appId/analytics', requireSession, validateAnalysis(allowed), handleAdminValidation,
        async (req, res) => {
            try {
                const query = filterQuery(req);
                const result = await adminRepo.analyze([req.params.appId], query);
                return res.json({ apps: [req.params.appId], ...query, ...result });
            } catch (error) {
                return adminError(req, res, error, 'analyse views');
            }
        });

    api.get('/analytics', requireSession, validateAnalysis(), handleAdminValidation, async (req, res) => {
        try {
            const query = filterQuery(req);
            const apps = await adminRepo.existingTables(allowed.appId);
            const result = await adminRepo.analyze(apps, query);
            return res.json({ apps, ...query, ...result });
        } catch (error) {
            return adminError(req, res, error, 'analyse all views');
        }
    });

    api.patch('/apps/:appId/views', authed, validateEdit(allowed), handleAdminValidation, async (req, res) => {
        try {
            const { appId } = req.params;
            const { columns, fields } = req.resolvedChanges;
            const changed = await adminRepo.updateContent(appId, req.body.ids, columns);
            if (changed.length) await record(req, ADMIN_ACTION.VIEWS_EDITED, { appId, targetIds: changed, fields });
            return res.json({ affected: changed.length, ids: changed });
        } catch (error) {
            return adminError(req, res, error, 'edit views');
        }
    });

    api.put('/apps/:appId/views/note', authed, validateNote(allowed), handleAdminValidation, async (req, res) => {
        try {
            const { appId } = req.params;
            const note = req.body.note && req.body.note.trim() ? req.body.note : null;
            const changed = await adminRepo.setNote(appId, req.body.ids, note);
            const action = note ? ADMIN_ACTION.NOTE_SET : ADMIN_ACTION.NOTE_CLEARED;
            if (changed.length) await record(req, action, { appId, targetIds: changed });
            return res.json({ affected: changed.length, ids: changed });
        } catch (error) {
            return adminError(req, res, error, 'set note');
        }
    });

    /** delete / restore / purge share one shape: IDs in, changed IDs out. */
    const batchRoute = (suffix, operation, action) => {
        api.post(`/apps/:appId/views/${suffix}`, authed, validateBatch(allowed), handleAdminValidation,
            async (req, res) => {
                try {
                    const { appId } = req.params;
                    const changed = await adminRepo[operation](appId, req.body.ids);
                    if (changed.length) await record(req, action, { appId, targetIds: changed });
                    return res.json({ affected: changed.length, ids: changed });
                } catch (error) {
                    return adminError(req, res, error, operation);
                }
            });
    };

    batchRoute('delete', 'softDelete', ADMIN_ACTION.VIEWS_DELETED);
    batchRoute('restore', 'restore', ADMIN_ACTION.VIEWS_RESTORED);
    batchRoute('purge', 'purge', ADMIN_ACTION.VIEWS_PURGED);

    // ---- Logs -------------------------------------------------------------

    api.get('/logs/admin', requireSession, validateAdminLogListing(allowed), handleAdminValidation,
        async (req, res) => {
            try {
                const result = await logRepo.listAdminLog({
                    page: intParam(req, 'page', 1),
                    pageSize: intParam(req, 'pageSize', ADMIN.PAGE_SIZE_DEFAULT),
                    action: req.query.action,
                    appId: req.query.appId,
                });
                return res.json(result);
            } catch (error) {
                return adminError(req, res, error, 'list admin log');
            }
        });

    api.get('/logs/views', requireSession, validateViewLogListing(allowed), handleAdminValidation,
        async (req, res) => {
            try {
                const result = await logRepo.listViewLog({
                    page: intParam(req, 'page', 1),
                    pageSize: intParam(req, 'pageSize', ADMIN.PAGE_SIZE_DEFAULT),
                    appId: req.query.appId,
                    source: req.query.source,
                });
                return res.json(result);
            } catch (error) {
                return adminError(req, res, error, 'list view log');
            }
        });

    api.use((req, res) => res.status(HTTP_STATUS.NOT_FOUND).json({ code: ADMIN_ERROR_CODE.NOT_FOUND }));

    // Malformed or oversized JSON bodies, in the admin error shape.
    // eslint-disable-next-line no-unused-vars
    api.use((err, req, res, next) => {
        logger.warn(`admin request rejected: ${err.message}`, logContext(req));
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: ADMIN_ERROR_CODE.VALIDATION_FAILED });
    });

    return api;
}

module.exports = { createAdminRouter, ADMIN_UI_DIR, ADMIN_CSP };
