const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const geoip = require('geoip-country');

const {
    COLLECTED_BY,
    EDGE,
    EVENT_TYPE,
    HTTP_STATUS,
    QUERY_LIMITS,
    REJECTION_REASON,
    SOURCE_TYPE,
    TRACKING,
    TREND_PERIOD,
    VIEW_LOG_SOURCE,
} = require('../constants');
const UserAgentParser = require('../utils/userAgentParser');
const ReferrerParser = require('../utils/referrerParser');
const PrivacyUtils = require('../utils/privacyUtils');
const logger = require('../utils/logger');
const { getClientIp, isValidIP, normalizeIp } = require('../utils/ipUtils');
const { requireReadApiKey, requireAppScope, requireAdminApiKey, requireEdgeSecret, appsInScope } = require('../middleware/auth');
const { requireRegisteredOrigin, requestedAppId, requestOrigin, noStore } = require('../middleware/security');
const { createRejectionCounter } = require('../db/rejectionCounter');
const { hostnameOf, httpUrl, originAndPath, primaryLanguage, urlUtmTags, utmTags } = require('../utils/visitorContext');
const {
    validateAppRegistration,
    validateRegisterView,
    validateEdgeView,
    validateEvent,
    validateEngage,
    validateStatsRequest,
    validateTrendsRequest,
    validateListRequest,
    validateViewsRequest,
    validateSessionRequest,
    handleValidationErrors,
    handleTrackingValidation,
} = require('../middleware/validation');

/**
 * The tracker script sites include with <script src=".../tracker.js">, and
 * the consent prompt they include instead when the tracker should run only
 * once the visitor allows it (<script src=".../consent.js">), which loads the
 * tracker from here. Read once; they are part of the package, not
 * configuration.
 */
const TRACKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'tracker', 'tracker.js'), 'utf8');
const CONSENT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'tracker', 'consent.js'), 'utf8');
/** Cached briefly, so a fix reaches every site within the hour. */
const TRACKER_MAX_AGE_SECONDS = 60 * 60;

/** The tracking endpoints, by path, and the source the tracking log files them under. */
const TRACKING_PATHS = {
    '/registerView': VIEW_LOG_SOURCE.REGISTER_VIEW,
    '/event': VIEW_LOG_SOURCE.EVENT,
    '/engage': VIEW_LOG_SOURCE.ENGAGE,
    [EDGE.PATH]: VIEW_LOG_SOURCE.EDGE,
};

const TRACKING_PATHS_LOWER = Object.fromEntries(Object.entries(TRACKING_PATHS).map(([path, source]) => [path.toLowerCase(), source]));

/**
 * Matched as the router matches its routes: whatever the letter case, with or
 * without a trailing slash. `/Engage/` is served by the `/engage` route, so it
 * must be counted, limited, and answered as one too.
 *
 * @param {string} path a request path, relative to where the router is mounted
 * @returns {string|null} the tracking source, or null for any other endpoint
 */
function trackingSourceFor(path) {
    const key = String(path).toLowerCase().replace(/(.)\/$/, '$1');
    return Object.hasOwn(TRACKING_PATHS_LOWER, key) ? TRACKING_PATHS_LOWER[key] : null;
}

/**
 * sendBeacon posts text/plain, which needs no CORS preflight; a fetch may
 * send JSON. Either way the handler sees an object, or an empty one for a
 * body that is not JSON, which validation then refuses.
 * @type {import('express').RequestHandler}
 */
function parseBeaconBody(req, res, next) {
    if (typeof req.body === 'string') {
        try {
            const parsed = JSON.parse(req.body);
            req.body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            req.body = {};
        }
    } else if (!req.body || typeof req.body !== 'object') {
        req.body = {};
    }
    next();
}

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
 * Keyed on appId only, never on IP, so it is unaffected by how the client's
 * address is derived, and cannot be rotated away by a caller changing address.
 *
 * @param {{ perAppMax: number, windowMs: number }} rateLimitConfig
 * @returns {import('express').RequestHandler}
 */
function buildPerAppLimiter(rateLimitConfig, onLimit = () => {}) {
    const { perAppMax, windowMs, perAppMaxByApp = {} } = rateLimitConfig || {};
    // An app's own figure wins over the general one; zero means no ceiling.
    const limitOf = (req) => (Object.hasOwn(perAppMaxByApp, appOf(req)) ? perAppMaxByApp[appOf(req)] : perAppMax) || 0;
    // Nothing set anywhere disables it, for single-tenant deployments where
    // the per-IP limit is the only bound that means anything.
    if (!(perAppMax > 0) && !Object.values(perAppMaxByApp).some((value) => value > 0)) return (req, res, next) => next();

    return rateLimit({
        windowMs,
        limit: limitOf,
        skip: (req) => limitOf(req) <= 0,
        standardHeaders: true,
        legacyHeaders: false,
        message: { message: 'This app has exceeded its request budget, please try again later.' },
        // A request with no appId lands in one shared bucket rather than
        // falling back to the IP, which would reintroduce the address-rotation
        // bypass this limiter exists to be immune to.
        keyGenerator: (req) => appOf(req) || '__unattributed__',
        validate: { keyGeneratorIpFallback: false },
        handler: (req, res, next, options) => {
            onLimit(req);
            res.status(options.statusCode).json(options.message);
        },
    });
}

/**
 * Which per-address budget a request draws on. Engagement reports and edge
 * reports each have their own, limited on their routes; everything else
 * shares the general one.
 */
const LIMITER = {
    GENERAL: 'general',
    ENGAGE: 'engage',
    EDGE: 'edge',
};

/**
 * The app a request is limited as: for a tracking request, the app its route
 * goes on to validate and store under; for anything else, none. A read or
 * admin call cannot name an app to borrow that app's figures.
 */
const appOf = (req) => (trackingSourceFor(req.path) ? requestedAppId(req) : '');

/**
 * A per-IP limiter: `max` requests per window from one address, or the app's
 * own figure (`maxByApp`) for tracking requests to an app that has one. Zero
 * means no limit, as the general figure or as an app's own.
 *
 * There are three of these, with separate budgets: one for engagement
 * reports, one for edge reports, and one for everything else. A page being
 * read reports its engagement every half minute. On one shared budget, a few
 * dozen readers behind one address (an office, a campus) would use it up with
 * those reports alone, and the page views of everyone at that address would
 * be refused. Apart, reports can only ever crowd out other reports.
 *
 * Edge reports (POST /edge/view) all come from the Worker's few addresses, so
 * their limiter counts the visitor's address each report names instead, which
 * has been checked by then. The limiter of everything else leaves them alone
 * only while that endpoint exists (`edgeEnabled`); with no EDGE_SECRET, a
 * request there is limited and answered like one to any path that does not
 * exist.
 *
 * An app with its own figure is counted on its own, per address: a site that
 * records far more per visitor than the others (every step inside a
 * single-page app, say) gets the room it needs without loosening the limit
 * for every other app, and without using up the address's budget for them.
 *
 * @param {{ max: number, windowMs: number, maxByApp?: Record<string, number> }} rateLimitConfig
 * @param {(req: import('express').Request) => void} [onLimit] called for a refused request
 * @param {{ engagement?: boolean, edge?: boolean, edgeEnabled?: boolean,
 *   clientIp?: (req: import('express').Request, res: import('express').Response) => string }} [options]
 *     `engagement` for the limiter of engagement reports, mounted on that
 *     route so it can know the app; `edge` for the limiter of edge reports,
 *     mounted on theirs, with `clientIp` giving the visitor's address; neither
 *     (the default) for the limiter of everything else, mounted app-wide
 * @returns {import('express').RequestHandler}
 */
function buildPerIpLimiter(rateLimitConfig, onLimit = () => {}, { engagement = false, edge = false, edgeEnabled = false, clientIp = null } = {}) {
    const { max = 0, windowMs, maxByApp = {} } = rateLimitConfig || {};
    const ownFigure = (req) => (Object.hasOwn(maxByApp, appOf(req)) ? maxByApp[appOf(req)] : null);
    const pass = (req, res, next) => next();
    const shared = {
        windowMs,
        message: { message: 'Too many requests, please try again later.' },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            onLimit(req);
            res.status(options.statusCode).json(options.message);
        },
    };
    const addressOf = (req, res) => ipKeyGenerator(clientIp ? clientIp(req, res) : req.ip);

    // The general budget keeps the library's own key (the address) and, with
    // it, the library's checks for a misconfigured proxy. Only edge reports,
    // whose address is the one they name, need a key of their own.
    const general = max > 0
        ? rateLimit({ ...shared, limit: max, ...(clientIp ? { keyGenerator: addressOf } : {}) })
        : pass;
    // Apps with a figure of their own: one counter per address and app.
    const own = Object.values(maxByApp).some((value) => value > 0)
        ? rateLimit({
            ...shared,
            limit: (req) => ownFigure(req),
            keyGenerator: (req, res) => `${addressOf(req, res)}|${appOf(req)}`,
        })
        : pass;

    const mine = engagement ? LIMITER.ENGAGE : (edge ? LIMITER.EDGE : LIMITER.GENERAL);
    /** The budget a request draws on: reports' own, on their routes, are POSTs only. */
    const kindOf = (req) => {
        if (req.method !== 'POST') return LIMITER.GENERAL;
        const source = trackingSourceFor(req.path);
        if (source === VIEW_LOG_SOURCE.ENGAGE) return LIMITER.ENGAGE;
        if (source === VIEW_LOG_SOURCE.EDGE && (edge || edgeEnabled)) return LIMITER.EDGE;
        return LIMITER.GENERAL;
    };

    return (req, res, next) => {
        if (kindOf(req) !== mine) return next();
        const figure = ownFigure(req);
        if (figure === null) return general(req, res, next);
        return figure > 0 ? own(req, res, next) : next();
    };
}

/**
 * The tracking endpoints are called from other sites' pages, so their answers
 * opt out of the same-origin resource policy helmet applies to everything
 * else, as the tracker script itself does.
 *
 * It matters for the engagement beacon. `navigator.sendBeacon` is a "no-cors"
 * request, the one kind a browser checks this header on: with `same-origin`
 * the report was still delivered and stored, but every one of them left an
 * ERR_BLOCKED_BY_RESPONSE.NotSameOrigin line in the console of the site that
 * sent it. Only the header changes: what a page may read of an answer is still
 * decided by CORS.
 *
 * @param {string} [mountPath] where the router is mounted in the host
 *     application ('/analytics', say), for a copy placed ahead of the router;
 *     omit it at the root or inside the router
 * @returns {import('express').RequestHandler}
 */
function allowTrackingFromOtherSites(mountPath = '') {
    const prefix = mountPath.replace(/\/+$/, '').toLowerCase();
    return (req, res, next) => {
        const path = req.path.toLowerCase().startsWith(`${prefix}/`) ? req.path.slice(prefix.length) : null;
        if (path !== null && trackingSourceFor(path)) res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
    };
}

/** The same at the root: what the router and the standalone service use. */
const allowFromOtherSites = allowTrackingFromOtherSites();

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
 * the unmasked IP on every view, event, and error, and on any normal
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
 * caller whenever NODE_ENV was not exactly "development", which was the
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
 * @param {{ config: object, dbManager: object, isReady: () => boolean,
 *   geo?: { city: { lookup: (ip: string) => { region: string|null, city: string|null } }|null } }} deps
 *   `geo.city` is read on every view, so it can be opened after the router is built
 * @returns {import('express').Router}
 */
function createAnalyticsRouter({ config, dbManager, isReady = () => true, geo = { city: null } }) {
    const router = express.Router();
    // Authentication and authorization are separate steps: `requireKey` proves
    // the caller holds a key we issued, `requireScope` proves that key is
    // entitled to the specific appId in the path. Read routes need both.
    const requireKey = requireReadApiKey(config.auth);
    const requireScope = requireAppScope();
    const requireAdmin = requireAdminApiKey(config.auth);

    // Edge counting exists only with an EDGE_SECRET (config.edge).
    const edgeEnabled = Boolean(config.edge?.enabled);

    // Tracking requests that are not stored are counted for the tracking log,
    // so an operator can see why a site's views are not arriving.
    const rejections = createRejectionCounter({
        write: (rows) => (dbManager.logs?.recordRejections ? dbManager.logs.recordRejections(rows) : Promise.resolve(true)),
    });
    const reject = (req, reason, { appId, detail } = {}) => {
        const source = trackingSourceFor(req.path);
        // Without edge counting, /edge/view is a path like any other that does not exist.
        if (!source || (source === VIEW_LOG_SOURCE.EDGE && !edgeEnabled)) return;
        rejections.count({
            source,
            reason,
            appId: appId ?? req.query?.appId ?? req.body?.appId,
            detail,
            // An edge report comes from a Worker, not the site's page: the
            // site is the one in the URL it reports.
            hostname: source === VIEW_LOG_SOURCE.EDGE
                ? hostnameOf(httpUrl(req.body?.url)?.origin)
                : hostnameOf(requestOrigin(req)),
        });
    };

    const requireOrigin = requireRegisteredOrigin(config.allowed, {
        onReject: (req, appId) => reject(req, REJECTION_REASON.ORIGIN_NOT_ALLOWED, { appId }),
    });
    const limitPerApp = buildPerAppLimiter(config.server?.rateLimit,
        (req) => reject(req, REJECTION_REASON.RATE_LIMITED, { detail: 'app' }));
    // Engagement reports draw on a per-app budget of their own, for the reason
    // buildPerIpLimiters gives: an app with many readers must not have its
    // views refused because of the reports those readers' pages send.
    const limitEngagePerApp = buildPerAppLimiter(config.server?.rateLimit,
        (req) => reject(req, REJECTION_REASON.RATE_LIMITED, { detail: 'app' }));
    // Per address too. This one sits on the route, not app-wide with the
    // other, so it runs after the beacon's body is read and knows the app.
    const readBeacon = express.text({ type: () => true, limit: TRACKING.ENGAGE_BODY_BYTES });
    const limitEngagePerIp = buildPerIpLimiter(config.server?.rateLimit,
        (req) => reject(req, REJECTION_REASON.RATE_LIMITED, { detail: 'ip' }), { engagement: true });
    const trackingValidation = handleTrackingValidation(reject);

    const requireEdge = requireEdgeSecret(config.edge, {
        onReject: (req) => {
            reject(req, REJECTION_REASON.UNAUTHORIZED);
            // Never the header itself: a near miss of the secret is still most of it.
            logger.warn('Rejected an edge report without the right EDGE_SECRET', logContext(req));
        },
    });
    // An edge report's address is the visitor's, named in its body and
    // checked by requireVisitorIp before this runs.
    const limitEdgePerVisitor = buildPerIpLimiter(config.server?.rateLimit,
        (req) => reject(req, REJECTION_REASON.RATE_LIMITED, { detail: 'ip' }),
        { edge: true, clientIp: (req, res) => res.locals.visitorIp });

    /**
     * The page an edge report names must be on one of its app's registered
     * sites, as a browser's view must come from one. It is checked even
     * though the Worker holds the secret: a site mapped to the wrong app in
     * the Worker's SITES would otherwise file its views under that app.
     * Unlike the browser check, an app with no sites registered accepts no
     * edge reports at all, since there is nothing to check the URL against.
     * Read per request: apps registered at runtime add their sites.
     * @type {import('express').RequestHandler}
     */
    const requireEdgeSite = (req, res, next) => {
        const { appId, url } = req.body;
        const registered = Object.hasOwn(config.allowed.origins || {}, appId) ? config.allowed.origins[appId] : undefined;
        if (Array.isArray(registered) && registered.includes(httpUrl(url).origin)) return next();
        reject(req, REJECTION_REASON.ORIGIN_NOT_ALLOWED, { appId });
        return res.status(HTTP_STATUS.FORBIDDEN).json({ message: 'The page is not on a site registered for this appId' });
    };

    /**
     * The visitor's address an edge report names, normalized, for the limit
     * and the handler. One that does not parse is refused as a browser view
     * from an unparseable address is.
     * @type {import('express').RequestHandler}
     */
    const requireVisitorIp = (req, res, next) => {
        const ip = normalizeIp(req.body.ip);
        if (isValidIP(ip)) {
            res.locals.visitorIp = ip;
            return next();
        }
        reject(req, REJECTION_REASON.INVALID_IP);
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ message: 'Invalid IP address format' });
    };

    /**
     * Views from these are counted in the tracking log and never stored. An
     * edge report passes the user agent it reports: its own is the Worker's.
     */
    const refuseBot = (req, userAgent = req.get('user-agent') || '') => {
        if (!UserAgentParser.isBot(userAgent)) return false;
        reject(req, REJECTION_REASON.BOT, { detail: UserAgentParser.botName(userAgent) });
        return true;
    };

    router.use(withRequestId);
    router.use(allowFromOtherSites);

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
     * The tracker script. Loaded by other sites, so it opts out of the
     * same-origin resource policy helmet applies to everything else.
     */
    router.get('/tracker.js', (req, res) => {
        res.set('Cache-Control', `public, max-age=${TRACKER_MAX_AGE_SECONDS}`);
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.type('application/javascript').send(TRACKER_SOURCE);
    });

    /**
     * The consent prompt, which loads the tracker above only once the visitor
     * allows it. Served exactly like the tracker.
     */
    router.get('/consent.js', (req, res) => {
        res.set('Cache-Control', `public, max-age=${TRACKER_MAX_AGE_SECONDS}`);
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.type('application/javascript').send(CONSENT_SOURCE);
    });

    /**
     * Register a page view.
     */
    router.get('/registerView',
        limitPerApp,
        requireOrigin,
        validateRegisterView(config.allowed),
        trackingValidation,
        async (req, res) => {
            try {
                const { appId, deviceSize, page, title, referrer, sessionId } = req.query;
                const pageAge = intQuery(req, 'age', 0);
                if (refuseBot(req)) {
                    return res.json({ message: 'Automated clients are not counted', recorded: false, duplicate: false });
                }

                const ip = normalizeIp(getClientIp(req));
                if (!isValidIP(ip)) {
                    reject(req, REJECTION_REASON.INVALID_IP);
                    logger.warn(`Rejected request with unparseable client IP`, logContext(req));
                    return res.status(HTTP_STATUS.BAD_REQUEST).json({ message: 'Invalid IP address format' });
                }

                const ipInfo = geoip.lookup(ip);
                const place = geo.city ? geo.city.lookup(ip) : { region: null, city: null };
                const userAgent = req.get('user-agent') || '';
                const uaData = UserAgentParser.parse(userAgent);

                // The `referrer` parameter is the only source of the visitor's
                // referrer; absent or empty means a direct visit. The Referer
                // header is deliberately not a fallback: on every browser
                // integration (a fetch or an <img> beacon) it names the tracked
                // page itself, not where the visitor came from, so reading it
                // recorded every direct visit as a referral from the site's own
                // domain. A server relaying views passes the real referrer here.
                const hostname = hostnameOf(requestOrigin(req));
                const referrerData = ReferrerParser.parse(referrer, hostname);
                const utm = utmTags(req.query);

                const result = await dbManager.registerEvent(appId, {
                    ip,
                    country: ipInfo?.country || null,
                    deviceSize,
                    pagePath: page,
                    pageTitle: title,
                    referrer: referrerData.referrer,
                    referrerDomain: referrerData.referrerDomain,
                    // A tagged link is a campaign, whichever site it was clicked on.
                    sourceType: utm.utmSource || utm.utmMedium ? SOURCE_TYPE.CAMPAIGN : referrerData.sourceType,
                    hostname,
                    language: primaryLanguage(req.get('accept-language')),
                    ...utm,
                    region: place.region,
                    city: place.city,
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
                    source: VIEW_LOG_SOURCE.REGISTER_VIEW,
                    collectedBy: COLLECTED_BY.SCRIPT,
                    // With edge counting on, the Worker has usually recorded
                    // this page load already; the view completes that one.
                    // The window runs from when the page was loaded.
                    mergeWindowSeconds: edgeEnabled ? TRACKING.MERGE_WINDOW_SECONDS + pageAge : 0,
                });

                logger.audit('registerView', { ...logContext(req), appId, duplicate: result.duplicate, merged: result.merged === true });

                // `id` lets the page report engagement for this view later.
                if (result.duplicate) {
                    return res.status(HTTP_STATUS.OK).json({
                        message: 'View already registered recently',
                        duplicate: true,
                        recorded: true,
                        id: result.publicId,
                    });
                }

                return res.status(HTTP_STATUS.OK).json({
                    message: 'Success!', duplicate: false, recorded: true, id: result.publicId,
                });
            } catch (error) {
                reject(req, REJECTION_REASON.SERVER_ERROR);
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
        trackingValidation,
        async (req, res) => {
            try {
                const { appId, eventType, eventData, sessionId, page, title } = req.body;
                if (refuseBot(req)) {
                    return res.json({ message: 'Automated clients are not counted', recorded: false });
                }

                const ip = normalizeIp(getClientIp(req));
                if (!isValidIP(ip)) {
                    reject(req, REJECTION_REASON.INVALID_IP);
                    return res.status(HTTP_STATUS.BAD_REQUEST).json({ message: 'Invalid IP address format' });
                }

                const ipInfo = geoip.lookup(ip);
                const place = geo.city ? geo.city.lookup(ip) : { region: null, city: null };
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
                    hostname: hostnameOf(requestOrigin(req)),
                    language: primaryLanguage(req.get('accept-language')),
                    region: place.region,
                    city: place.city,
                    userAgent,
                    visitorSecret: config.privacy.visitorSecret,
                    // Custom events are never deduplicated.
                    uniqueWindowHours: 0,
                    source: VIEW_LOG_SOURCE.EVENT,
                });

                logger.audit('trackEvent', { ...logContext(req), appId, eventType });

                return res.status(HTTP_STATUS.OK).json({
                    message: 'Event tracked successfully',
                    recorded: true,
                    id: result.publicId,
                    // Deprecated: the internal row number. Kept for 3.x clients; use `id`.
                    insertId: result.insertId,
                });
            } catch (error) {
                reject(req, REJECTION_REASON.SERVER_ERROR);
                return handleRouteError(req, res, error, 'track event');
            }
        }
    );

    /**
     * Engagement for a recorded view: how long its page was visible and how
     * far it was scrolled, sent by the tracker when the page is hidden or left.
     */
    router.post('/engage',
        // A body that cannot be read (too large, say) still counts against
        // the address before it is refused: the app is unknown, so by the
        // general figure.
        (req, res, next) => readBeacon(req, res, (error) => (error ? limitEngagePerIp(req, res, () => next(error)) : next())),
        parseBeaconBody,
        limitEngagePerIp,
        limitEngagePerApp,
        requireOrigin,
        validateEngage(config.allowed),
        trackingValidation,
        async (req, res) => {
            try {
                if (refuseBot(req)) return res.status(HTTP_STATUS.NO_CONTENT).end();

                const { appId, id, ms, scroll } = req.body;
                const updated = await dbManager.addEngagement(appId, {
                    viewId: id,
                    engagedMs: Number(ms),
                    scrollDepth: scroll === undefined || scroll === null ? null : Number(scroll),
                });
                if (!updated) reject(req, REJECTION_REASON.UNKNOWN_VIEW);
                return res.status(HTTP_STATUS.NO_CONTENT).end();
            } catch (error) {
                reject(req, REJECTION_REASON.SERVER_ERROR);
                return handleRouteError(req, res, error, 'record engagement');
            }
        }
    );

    /**
     * A page view seen at the edge: a Worker in front of the site reports
     * each HTML page it serves, server to server, with only what the request
     * for the page carried. Nothing is read from or stored on the visitor's
     * device, and the page sends nothing itself. There is no Origin to check
     * and no CORS: the secret authenticates the Worker, and the reported
     * page's site is checked against the app's. The address limit counts the
     * visitor's address, not the Worker's; the app's budget is spent as for
     * any view.
     *
     * Answers 204 whether the view was stored, merged into the tracker's
     * view of the same page load, or refused as a bot: the Worker has nothing
     * to do with the difference.
     */
    if (edgeEnabled) {
        router.post(EDGE.PATH,
            requireEdge,
            limitPerApp,
            validateEdgeView(config.allowed),
            trackingValidation,
            requireEdgeSite,
            requireVisitorIp,
            limitEdgePerVisitor,
            async (req, res) => {
                try {
                    const { appId, url, referrer, userAgent, mobile, acceptLanguage } = req.body;
                    const agent = typeof userAgent === 'string' ? userAgent : '';
                    if (refuseBot(req, agent)) return res.status(HTTP_STATUS.NO_CONTENT).end();

                    const ip = res.locals.visitorIp;
                    const page = httpUrl(url);
                    const hostname = hostnameOf(page.origin);
                    const ipInfo = geoip.lookup(ip);
                    const place = geo.city ? geo.city.lookup(ip) : { region: null, city: null };
                    const uaData = UserAgentParser.parse(agent);
                    // The Referer header is the page before, in full: kept as
                    // its origin and path, as the tracker sends it.
                    const referrerData = ReferrerParser.parse(originAndPath(referrer), hostname);
                    const utm = urlUtmTags(page);

                    const result = await dbManager.registerEvent(appId, {
                        ip,
                        country: ipInfo?.country || null,
                        // No window to measure: the phone hint, or the device the user agent names.
                        deviceSize: UserAgentParser.getDeviceSize(agent, mobile),
                        // The path alone: the query and fragment never leave the request.
                        pagePath: page.pathname,
                        // The title is in the page, which the edge never reads.
                        pageTitle: null,
                        referrer: referrerData.referrer,
                        referrerDomain: referrerData.referrerDomain,
                        sourceType: utm.utmSource || utm.utmMedium ? SOURCE_TYPE.CAMPAIGN : referrerData.sourceType,
                        hostname,
                        language: primaryLanguage(acceptLanguage),
                        ...utm,
                        region: place.region,
                        city: place.city,
                        browser: uaData.browser,
                        browserVersion: uaData.browserVersion,
                        os: uaData.os,
                        osVersion: uaData.osVersion,
                        deviceType: uaData.deviceType,
                        sessionId: null,
                        eventType: EVENT_TYPE.PAGEVIEW,
                        userAgent: agent,
                        visitorSecret: config.privacy.visitorSecret,
                        uniqueWindowHours: config.server.uniqueVisitorWindowHours,
                        source: VIEW_LOG_SOURCE.EDGE,
                        collectedBy: COLLECTED_BY.EDGE,
                        // Rarely, the tracker's view of this page load came first.
                        mergeWindowSeconds: TRACKING.MERGE_WINDOW_SECONDS,
                    });

                    logger.audit('edgeView', { ...logContext(req), appId, duplicate: result.duplicate, merged: result.merged === true });
                    return res.status(HTTP_STATUS.NO_CONTENT).end();
                } catch (error) {
                    reject(req, REJECTION_REASON.SERVER_ERROR);
                    return handleRouteError(req, res, error, 'register edge view');
                }
            }
        );
    }

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
     * the live allowlist so it accepts traffic immediately, with no restart. The
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

    /** For the host app's own limiter, which runs before this router, and for shutdown. */
    router.countRejection = reject;
    router.flushRejections = () => rejections.flush();

    /**
     * For the app that mounts this router, after its body parser: a body that
     * is malformed JSON or over the size limit never reaches the router, so it
     * is counted here, as an invalid request to the endpoint it was sent to.
     * @type {import('express').ErrorRequestHandler}
     */
    // eslint-disable-next-line no-unused-vars
    router.bodyErrorHandler = (err, req, res, next) => {
        const status = err.status || err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
        logger.warn(`Request rejected: ${err.message}`, { requestId: req.id });
        reject(req, REJECTION_REASON.INVALID_REQUEST, { detail: 'body' });
        res.status(status === HTTP_STATUS.INTERNAL_SERVER_ERROR ? HTTP_STATUS.BAD_REQUEST : status)
            .json({ message: 'Malformed or oversized request' });
    };

    return router;
}

module.exports = { createAnalyticsRouter, allowFromOtherSites, allowTrackingFromOtherSites, buildPerIpLimiter, handleRouteError, logContext, withRequestId, trackingSourceFor };
