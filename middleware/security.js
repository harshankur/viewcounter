/**
 * Transport-level security middleware: CORS, origin binding, cache policy.
 */

const { HTTP_STATUS } = require('../constants');

/**
 * Build CORS options from an explicit allowlist.
 *
 * agent-instructions SECURITY.md §9: `cors()` with no options is never the
 * default. The wildcard mattered more here than the usual "no credentials, so
 * it's harmless" reasoning suggests, because the read endpoints served real
 * data — `*` made them script-readable from any origin, not merely reachable.
 *
 * @param {string[]} allowedOrigins
 * @returns {import('cors').CorsOptions}
 */
function buildCorsOptions(allowedOrigins) {
    const allowlist = new Set(allowedOrigins);

    return {
        origin(origin, callback) {
            // No Origin header: a same-origin request, a server-side caller, or
            // curl. There is no browser to protect in that case.
            if (!origin) return callback(null, true);
            return callback(null, allowlist.has(origin));
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'x-api-key'],
        credentials: false,
        maxAge: 600,
    };
}

/**
 * Extract the requesting origin, falling back to the referrer's origin.
 * @returns {string|null}
 */
function requestOrigin(req) {
    const origin = req.get('origin');
    if (origin) return origin;

    const referer = req.get('referer') || req.get('referrer');
    if (!referer) return null;

    try {
        return new URL(referer).origin;
    } catch {
        return null;
    }
}

/**
 * Bind writes for an appId to the site origins registered for it.
 *
 * Without this, any page anywhere could embed
 * `<img src="…/registerView?appId=victim&deviceSize=large">` and inject
 * traffic into someone else's analytics. Being a GET, no CORS preflight is
 * involved, so the browser's same-origin policy never came into it.
 *
 * Enforced only for appIds that declare an `origins` list in allowed.json; an
 * appId with no list keeps accepting writes from anywhere, so adding this
 * cannot silently break a running deployment. Startup validation warns about
 * every appId still in that state.
 *
 * @param {{ origins: Record<string, string[]> }} allowed
 * @returns {import('express').RequestHandler}
 */
function requireRegisteredOrigin(allowed) {
    const origins = allowed?.origins || {};

    return (req, res, next) => {
        const appId = req.query.appId || req.body?.appId;
        const registered = origins[appId];

        if (!Array.isArray(registered) || registered.length === 0) {
            return next();
        }

        const origin = requestOrigin(req);
        if (origin && registered.includes(origin)) {
            return next();
        }

        return res.status(HTTP_STATUS.FORBIDDEN).json({
            message: 'Request origin is not registered for this appId',
        });
    };
}

/**
 * Mark a response as uncacheable.
 *
 * Analytics responses are per-caller and must never be served from a shared
 * proxy cache to a different caller. Neither express nor helmet sets this.
 *
 * @type {import('express').RequestHandler}
 */
function noStore(req, res, next) {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
}

module.exports = {
    buildCorsOptions,
    requireRegisteredOrigin,
    requestOrigin,
    noStore,
};
