/**
 * Admin UI authentication: password login, server-side sessions, and CSRF.
 *
 * Sessions live in memory. A restart signs every admin out, which is the safe
 * direction to fail in and costs one login. The browser holds only an opaque
 * random token in an HttpOnly cookie; the store is keyed by that token's
 * SHA-256, so a memory dump of the store does not yield usable cookies.
 *
 * CSRF is defeated three ways, each sufficient on its own in a modern browser:
 * the cookie is SameSite=Strict, every mutating request must echo a per-session
 * token in a header that a cross-site form cannot set, and a present Origin
 * header must match this server.
 */

const crypto = require('crypto');

const { ADMIN, ADMIN_ERROR_CODE, HTTP_STATUS } = require('../constants');
const { safeEqual } = require('./auth');
const { parseCookies } = require('../utils/cookieUtils');
const { WarningType, logWarning } = require('../utils/errorUtils');

/** Methods that never change state and so need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** @param {string} token @returns {string} */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * @param {{ idleMs?: number, absoluteMs?: number, maxSessions?: number,
 *   now?: () => number }} [options]
 */
function createSessionStore({
    idleMs = ADMIN.SESSION_IDLE_TIMEOUT_MS,
    absoluteMs = ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
    maxSessions = ADMIN.MAX_SESSIONS,
    now = Date.now,
} = {}) {
    /** @type {Map<string, {id: string, csrfToken: string, createdAt: number, lastSeenAt: number}>} */
    const sessions = new Map();

    function isExpired(session, at) {
        return at - session.lastSeenAt > idleMs || at - session.createdAt > absoluteMs;
    }

    return {
        /**
         * Start a session.
         * @returns {{ token: string, session: {id: string, csrfToken: string, createdAt: number, lastSeenAt: number} }}
         */
        create() {
            const at = now();
            const token = crypto.randomBytes(ADMIN.SESSION_TOKEN_BYTES).toString('base64url');
            const session = {
                id: crypto.randomUUID(),
                csrfToken: crypto.randomBytes(ADMIN.CSRF_TOKEN_BYTES).toString('base64url'),
                createdAt: at,
                lastSeenAt: at,
            };

            // Bounded: the oldest session goes first. Map preserves insertion
            // order, so the first key is always the oldest.
            while (sessions.size >= maxSessions) {
                sessions.delete(sessions.keys().next().value);
            }
            sessions.set(hashToken(token), session);
            return { token, session };
        },

        /**
         * Look up a live session and extend its idle window.
         * @param {string|undefined} token
         */
        get(token) {
            if (typeof token !== 'string' || token.length === 0) return null;
            const key = hashToken(token);
            const session = sessions.get(key);
            if (!session) return null;

            const at = now();
            if (isExpired(session, at)) {
                sessions.delete(key);
                return null;
            }
            session.lastSeenAt = at;
            return session;
        },

        /** @param {string|undefined} token */
        destroy(token) {
            if (typeof token !== 'string' || token.length === 0) return false;
            return sessions.delete(hashToken(token));
        },

        get size() {
            return sessions.size;
        },
    };
}

/** Read the session token from the request's cookies. */
function readToken(req) {
    return parseCookies(req.headers.cookie)[ADMIN.SESSION_COOKIE];
}

/**
 * Cookie attributes. `Secure` follows the connection: a deployment behind a
 * TLS-terminating proxy gets it through `trust proxy`, and plain-HTTP local
 * development still works. Scoped to wherever the admin router is mounted
 * (`req.adminBasePath`), so the cookie never travels to the public analytics
 * endpoints and still works when another app mounts the router elsewhere.
 */
function cookieOptions(req) {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        path: req.adminBasePath || ADMIN.PATH_PREFIX,
        maxAge: ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
    };
}

/** @returns {import('express').RequestHandler} */
function requireAdminSession(store) {
    return (req, res, next) => {
        const token = readToken(req);
        const session = store.get(token);
        if (!session) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: ADMIN_ERROR_CODE.UNAUTHENTICATED });
        }
        req.adminSession = session;
        req.adminToken = token;
        return next();
    };
}

/**
 * The origin this request was addressed to, as the browser would write it.
 * @param {import('express').Request} req
 */
function expectedOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

/**
 * Whether a browser-supplied Origin (absent for same-origin GETs and non-browser
 * clients) matches this server. A mismatch is logged with both values: behind a
 * misconfigured proxy every admin request is refused, and the log is the only
 * place that says why.
 * @param {import('express').Request} req
 */
function originAllowed(req) {
    const presented = req.get('origin');
    if (!presented) return true;
    const expected = expectedOrigin(req);
    if (presented === expected) return true;
    logWarning(WarningType.ADMIN_ORIGIN_REJECTED, { presented, expected });
    return false;
}

/**
 * Reject a state-changing request that does not carry this session's CSRF
 * token, or that a browser says came from another origin.
 * @returns {import('express').RequestHandler}
 */
function requireCsrf() {
    return (req, res, next) => {
        if (SAFE_METHODS.has(req.method)) return next();

        const presented = req.get(ADMIN.CSRF_HEADER) || '';
        const session = req.adminSession;

        const originOk = originAllowed(req);
        const tokenOk = Boolean(session) && safeEqual(presented, session.csrfToken);

        if (!originOk || !tokenOk) {
            return res.status(HTTP_STATUS.FORBIDDEN).json({ code: ADMIN_ERROR_CODE.CSRF_REJECTED });
        }
        return next();
    };
}

/**
 * Constant-time password check. An unset password never matches anything,
 * including an empty submission.
 */
function verifyPassword(presented, configured) {
    if (!configured) return false;
    return safeEqual(String(presented ?? ''), configured);
}

module.exports = {
    createSessionStore,
    requireAdminSession,
    requireCsrf,
    verifyPassword,
    cookieOptions,
    expectedOrigin,
    originAllowed,
    readToken,
    hashToken,
    SAFE_METHODS,
};
