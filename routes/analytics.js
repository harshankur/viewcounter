const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const geoip = require('geoip-country');

const {
    EVENT_TYPE,
    HTTP_STATUS,
    QUERY_LIMITS,
    TREND_PERIOD,
} = require('../constants');
const UserAgentParser = require('../utils/userAgentParser');
const ReferrerParser = require('../utils/referrerParser');
const PrivacyUtils = require('../utils/privacyUtils');
const logger = require('../utils/logger');
const { getClientIp, isValidIP, normalizeIp } = require('../utils/ipUtils');
const { requireReadApiKey, requireAppScope, requireAdminApiKey, appsInScope } = require('../middleware/auth');
const { requireRegisteredOrigin, noStore } = require('../middleware/security');
const {
    validateAppRegistration,
    validateRegisterView,
    validateEvent,
    validateStatsRequest,
    validateTrendsRequest,
    validateListRequest,
    validateViewsRequest,
    validateSessionRequest,
    handleValidationErrors,
} = require('../middleware/validation');

/**
 * Analytics routes.
 *
 * Exported as a factory returning an Express Router so the same code can run
 * as a standalone server (index.js) or be mounted into an existing Express
 * application as middleware.
 *
 * Trust model:
 *  - WRITE endpoints (/registerView, /event) are public, because the whole
 *    point is that a browser on someone else's site can reach them. They are
 *    bounded by validation, rate limiting, and per-appId origin binding.
 *  - READ endpoints are authenticated. They return another party's analytics
 *    and must never have been open.
 */

/**
 * Read an integer query parameter.
 *
 * Validation has already rejected anything non-integer or out of range with a
 * 422, so this only ever coerces a known-good value or applies the default for
 * an absent one. Done here rather than with an express-validator `.toInt()`
 * sanitizer because Express 5 exposes `req.query` as a getter-only property,
 * so sanitizers cannot write the coerced value back.
 *
 * @param {import('express').Request} req
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function intQuery(req, name, fallback) {
    const raw = req.query[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Per-app write limiter.
 *
 * Sits alongside the per-IP limiter rather than replacing it. The per-IP limit
 * stops one abusive visitor; this stops one *tenant* consuming the budget every
 * other tenant on the instance depends on, which is the failure mode that
 * matters once the apps belong to different people.
 *
 * Keyed on appId only — never on IP — so it is unaffected by how the client's
 * address is derived, and cannot be rotated away by a caller changing address.
 *
 * @param {{ perAppMax: number, windowMs: number }} rateLimitConfig
 * @returns {import('express').RequestHandler}
 */
function buildPerAppLimiter({ perAppMax, windowMs }) {
    // Zero disables it, for single-tenant deployments where the per-IP limit
    // is the only bound that means anything.
    if (!perAppMax || perAppMax <= 0) return (req, res, next) => next();

    return rateLimit({
        windowMs,
        limit: perAppMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: { message: 'This app has exceeded its request budget, please try again later.' },
        // A request with no appId lands in one shared bucket rather than
        // falling back to the IP, which would reintroduce the address-rotation
        // bypass this limiter exists to be immune to.
        keyGenerator: (req) => String(req.query?.appId || req.body?.appId || '__unattributed__'),
        validate: { keyGeneratorIpFallback: false },
    });
}

/**
 * Attach a request id used for correlating a client-visible error with the
 * server-side log line that has the real detail.
 */
function withRequestId(req, res, next) {
    req.id = crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
}

/**
 * Build the correlation context for a log line.
 *
 * Logs the MASKED address, never the raw one. `logRequest` previously wrote
 * the unmasked IP on every view, event, and error — and on any normal
 * deployment stdout is persisted to disk, so the raw addresses the privacy
 * design goes to lengths to keep out of the database were being written beside
 * it anyway.
 */
function logContext(req) {
    const ip = getClientIp(req);
    return { ip: ip ? PrivacyUtils.maskIP(normalizeIp(ip)) : '-', requestId: req.id };
}

/**
 * Report a handler failure.
 *
 * The client gets a stable message plus the request id; the detail goes to the
 * server log only. Previously the raw database error text was returned to the
 * caller whenever NODE_ENV was not exactly "development" — which was the
 * default, and which the setup wizard wrote into .env.
 */
function handleRouteError(req, res, error, operation) {
    logger.error(`${operation} failed: ${error.message}`, logContext(req));
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        message: `Failed to ${operation}`,
        requestId: req.id,
    });
}

/**
 * @param {{ config: object, dbManager: object, isReady: () => boolean }} deps
 * @returns {import('express').Router}
 */
function createAnalyticsRouter({ config, dbManager, isReady = () => true }) {
    const router = express.Router();
    // Authentication and authorization are separate steps: `requireKey` proves
    // the caller holds a key we issued, `requireScope` proves that key is
    // entitled to the specific appId in the path. Read routes need both.
    const requireKey = requireReadApiKey(config.auth);
    const requireScope = requireAppScope();
    const requireAdmin = requireAdminApiKey(config.auth);
    const requireOrigin = requireRegisteredOrigin(config.allowed);
    const limitPerApp = buildPerAppLimiter(config.server.rateLimit);

    router.use(withRequestId);

    /**
     * Health check. Public, and deliberately reveals nothing but liveness.
     */
    router.get('/health', noStore, async (req, res) => {
        const dbHealth = await dbManager.healthCheck();

        if (!isReady() || !dbHealth.healthy) {
            return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({ status: 'unhealthy' });
        }

        return res.json({ status: 'healthy', uptime: process.uptime() });
    });

    /**
     * Register a page view.
     */
    router.get('/registerView',
        limitPerApp,
        requireOrigin,
        validateRegisterView(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const { appId, deviceSize, page, title, referrer, sessionId } = req.query;
                const ip = normalizeIp(getClientIp(req));

                if (!isValidIP(ip)) {
                    logger.warn(`Rejected request with unparseable client IP`, logContext(req));
                    return res.status(HTTP_STATUS.BAD_REQUEST).json({ message: 'Invalid IP address format' });
                }

                const ipInfo = geoip.lookup(ip);
                const userAgent = req.get('user-agent') || '';
                const uaData = UserAgentParser.parse(userAgent);

                const referrerHeader = referrer || req.get('referer') || req.get('referrer');
                const referrerData = ReferrerParser.parse(referrerHeader);

                const result = await dbManager.registerEvent(appId, {
                    ip,
                    country: ipInfo?.country || null,
                    deviceSize,
                    pagePath: page,
                    pageTitle: title,
                    referrer: referrerData.referrer,
                    referrerDomain: referrerData.referrerDomain,
                    sourceType: referrerData.sourceType,
                    browser: uaData.browser,
                    browserVersion: uaData.browserVersion,
                    os: uaData.os,
                    osVersion: uaData.osVersion,
                    deviceType: uaData.deviceType,
                    sessionId,
                    eventType: EVENT_TYPE.PAGEVIEW,
                    userAgent,
                    visitorSecret: config.privacy.visitorSecret,
                    uniqueWindowHours: config.server.uniqueVisitorWindowHours,
                });

                logger.audit('registerView', { ...logContext(req), appId, duplicate: result.duplicate });

                if (result.duplicate) {
                    return res.status(HTTP_STATUS.OK).json({
                        message: 'View already registered recently',
                        duplicate: true,
                    });
                }

                return res.status(HTTP_STATUS.OK).json({ message: 'Success!', duplicate: false });
            } catch (error) {
                return handleRouteError(req, res, error, 'register view');
            }
        }
    );

    /**
     * Track a custom event.
     */
    router.post('/event',
        limitPerApp,
        requireOrigin,
        validateEvent(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const { appId, eventType, eventData, sessionId, page, title } = req.body;
                const ip = normalizeIp(getClientIp(req));

                if (!isValidIP(ip)) {
                    return res.status(HTTP_STATUS.BAD_REQUEST).json({ message: 'Invalid IP address format' });
                }

                const ipInfo = geoip.lookup(ip);
                const userAgent = req.get('user-agent') || '';
                const uaData = UserAgentParser.parse(userAgent);

                const result = await dbManager.registerEvent(appId, {
                    ip,
                    country: ipInfo?.country || null,
                    deviceSize: UserAgentParser.getDeviceSize(userAgent),
                    pagePath: page,
                    pageTitle: title,
                    browser: uaData.browser,
                    browserVersion: uaData.browserVersion,
                    os: uaData.os,
                    osVersion: uaData.osVersion,
                    deviceType: uaData.deviceType,
                    sessionId,
                    eventType,
                    eventData,
                    userAgent,
                    visitorSecret: config.privacy.visitorSecret,
                    // Custom events are never deduplicated.
                    uniqueWindowHours: 0,
                });

                logger.audit('trackEvent', { ...logContext(req), appId, eventType });

                return res.status(HTTP_STATUS.OK).json({
                    message: 'Event tracked successfully',
                    insertId: result.insertId,
                });
            } catch (error) {
                return handleRouteError(req, res, error, 'track event');
            }
        }
    );

    // ---- Read API. Everything below requires a valid key. -------------------

    router.use(noStore);

    router.get('/stats/:appId',
        requireKey,
        requireScope,
        validateStatsRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const stats = await dbManager.getStats(req.params.appId);
                return res.json({ appId: req.params.appId, stats });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch statistics');
            }
        }
    );

    router.get('/trends/:appId',
        requireKey,
        requireScope,
        validateTrendsRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const period = req.query.period || TREND_PERIOD.DAILY;
                const days = intQuery(req, 'days', QUERY_LIMITS.TREND_DAYS_DEFAULT);
                const trends = await dbManager.getTrends(req.params.appId, period, days);
                return res.json({ appId: req.params.appId, period, days, trends });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch trends');
            }
        }
    );

    router.get('/referrers/:appId',
        requireKey,
        requireScope,
        validateListRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const limit = intQuery(req, 'limit', QUERY_LIMITS.LIST_LIMIT_DEFAULT);
                const stats = await dbManager.getReferrerStats(req.params.appId, limit);
                return res.json({ appId: req.params.appId, ...stats });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch referrer statistics');
            }
        }
    );

    router.get('/browsers/:appId',
        requireKey,
        requireScope,
        validateStatsRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const stats = await dbManager.getBrowserStats(req.params.appId);
                return res.json({ appId: req.params.appId, ...stats });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch browser statistics');
            }
        }
    );

    router.get('/pages/:appId',
        requireKey,
        requireScope,
        validateListRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const limit = intQuery(req, 'limit', QUERY_LIMITS.LIST_LIMIT_DEFAULT);
                const pages = await dbManager.getPageStats(req.params.appId, limit);
                return res.json({ appId: req.params.appId, pages });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch page statistics');
            }
        }
    );

    router.get('/sessions/:appId/:sessionId',
        requireKey,
        requireScope,
        validateSessionRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const { appId, sessionId } = req.params;
                const events = await dbManager.getSessionDetails(appId, sessionId);
                return res.json({ appId, sessionId, events, count: events.length });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch session details');
            }
        }
    );

    router.get('/views/:appId',
        requireKey,
        requireScope,
        validateViewsRequest(config.allowed),
        handleValidationErrors,
        async (req, res) => {
            try {
                const limit = intQuery(req, 'limit', QUERY_LIMITS.VIEWS_LIMIT_DEFAULT);
                const offset = intQuery(req, 'offset', QUERY_LIMITS.OFFSET_DEFAULT);
                const result = await dbManager.getViews(req.params.appId, limit, offset);
                return res.json({ appId: req.params.appId, ...result });
            } catch (error) {
                return handleRouteError(req, res, error, 'fetch views');
            }
        }
    );

    /**
     * List apps visible to the presented key.
     *
     * Filtered by scope, not just authenticated: returning the full list to a
     * tenant-scoped key would disclose every other tenant's existence, which is
     * the same enumeration problem this endpoint had when it was public.
     */
    router.get('/apps', requireKey, (req, res) => {
        const apps = appsInScope(req.auth.scope, config.allowed.appId);
        res.json({ apps, count: apps.length });
    });

    /**
     * Provision a new app. Admin tier only.
     *
     * Creates the app's table and records it in the registry, then adds it to
     * the live allowlist so it accepts traffic immediately — no restart. The
     * appId becomes a table identifier, so it is validated against a strict
     * pattern before it reaches any DDL.
     */
    router.post('/apps',
        requireAdmin,
        validateAppRegistration(),
        handleValidationErrors,
        async (req, res) => {
            try {
                const { appId, origins = [] } = req.body;
                const result = await dbManager.registerApp(appId, origins);

                // Reassigning (not mutating) is fine: the validators read
                // `config.allowed.appId` per request via a custom validator.
                if (!config.allowed.appId.includes(appId)) {
                    config.allowed.appId = [...config.allowed.appId, appId];
                }
                if (origins.length) {
                    config.allowed.origins[appId] = origins;
                }

                logger.audit('registerApp', { ...logContext(req), appId, created: result.created });

                return res.status(HTTP_STATUS.OK).json({
                    appId,
                    created: result.created,
                    message: result.created ? 'App registered' : 'App already registered',
                });
            } catch (error) {
                return handleRouteError(req, res, error, 'register app');
            }
        }
    );

    return router;
}

module.exports = { createAnalyticsRouter, handleRouteError, logContext, withRequestId };
