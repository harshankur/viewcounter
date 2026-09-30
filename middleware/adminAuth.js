/**
 * Admin UI authentication: password login, server-side sessions, CSRF, and a
 * fresh password for the actions that cannot be undone.
 *
 * The browser holds only an opaque random token in an HttpOnly cookie. Stores
 * are keyed by that token's SHA-256, so reading a store (the in-memory one
 * here, or the database table the server uses so a restart signs nobody out)
 * yields no usable session.
 *
 * CSRF is defeated three ways, each sufficient on its own in a modern browser:
 * the cookie is SameSite=Strict, every mutating request must echo a per-session
 * token in a header that a cross-site form cannot set, and a present Origin
 * header must match this server. The CSRF token is an HMAC of the session
 * token, so it is never stored and cannot be computed without the cookie.
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

/** @returns {string} a new session token, 256 random bits */
function newToken() {
    return crypto.randomBytes(ADMIN.SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * The CSRF token for a session: an HMAC of its token, so it is the same for
 * the life of the session, is never stored, and needs the cookie to compute.
 * @param {string} token
 * @returns {string}
 */
function sessionCsrfToken(token) {
    return crypto.createHmac('sha256', token).update('viewcounter-admin-csrf').digest('base64url');
}

/**
 * The in-memory session store: used by tests and by an embedding app that
 * passes no store of its own. A restart signs everyone out.
 *
 * Every store has the same async interface:
 *   create()               -> { token, session }
 *   get(token)             -> session or null; extends the idle window
 *   destroy(token)         -> whether a session was ended
 *   confirmPassword(token) -> records that the password was just entered
 * where a session is { id, passwordAgeMs }.
 *
 * @param {{ idleMs?: number, absoluteMs?: number, maxSessions?: number,
 *   now?: () => number }} [options]
 */
function createSessionStore({
    idleMs = ADMIN.SESSION_IDLE_TIMEOUT_MS,
    absoluteMs = ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
    maxSessions = ADMIN.MAX_SESSIONS,
    now = Date.now,
} = {}) {
    /** @type {Map<string, {id: string, createdAt: number, lastSeenAt: number, passwordAt: number}>} */
    const sessions = new Map();

    const view = (session, at) => ({ id: session.id, passwordAgeMs: at - session.passwordAt });

    return {
        idleMs,
        absoluteMs,

        async create() {
            const at = now();
            const token = newToken();
            const session = { id: crypto.randomUUID(), createdAt: at, lastSeenAt: at, passwordAt: at };

            // Bounded: the oldest session goes first. Map preserves insertion
            // order, so the first key is always the oldest.
            while (sessions.size >= maxSessions) {
                sessions.delete(sessions.keys().next().value);
            }
            sessions.set(hashToken(token), session);
            return { token, session: view(session, at) };
        },

        async get(token) {
            if (typeof token !== 'string' || token.length === 0) return null;
            const key = hashToken(token);
            const session = sessions.get(key);
            if (!session) return null;

            const at = now();
            if (at - session.lastSeenAt > idleMs || at - session.createdAt > absoluteMs) {
                sessions.delete(key);
                return null;
            }
            session.lastSeenAt = at;
            return view(session, at);
        },

        async destroy(token) {
            if (typeof token !== 'string' || token.length === 0) return false;
            return sessions.delete(hashToken(token));
        },

        async confirmPassword(token) {
            const session = typeof token === 'string' ? sessions.get(hashToken(token)) : null;
            if (session) session.passwordAt = now();
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
function cookieOptions(req, maxAge = ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS) {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        path: req.adminBasePath || ADMIN.PATH_PREFIX,
        maxAge,
    };
}

/** @returns {import('express').RequestHandler} */
function requireAdminSession(store) {
    return async (req, res, next) => {
        try {
            const token = readToken(req);
            const session = await store.get(token);
            if (!session) {
                return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: ADMIN_ERROR_CODE.UNAUTHENTICATED });
            }
            req.adminSession = session;
            req.adminToken = token;
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

/**
 * For actions that cannot be undone: the password must have been entered in
 * the last `windowMs`, at sign-in or through POST /reauth. Otherwise the UI is
 * told to ask for it and retry.
 * @returns {import('express').RequestHandler}
 */
function requireRecentPassword(windowMs = ADMIN.REAUTH_WINDOW_MS) {
    return (req, res, next) => {
        if (req.adminSession && req.adminSession.passwordAgeMs <= windowMs) return next();
        return res.status(HTTP_STATUS.FORBIDDEN).json({ code: ADMIN_ERROR_CODE.REAUTH_REQUIRED });
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
        const tokenOk = Boolean(session) && typeof req.adminToken === 'string'
            && safeEqual(presented, sessionCsrfToken(req.adminToken));

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
    requireRecentPassword,
    requireCsrf,
    sessionCsrfToken,
    newToken,
    verifyPassword,
    cookieOptions,
    expectedOrigin,
    originAllowed,
    readToken,
    hashToken,
    SAFE_METHODS,
};
