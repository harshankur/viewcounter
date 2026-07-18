/**
 * Authentication and authorization for the analytics API.
 *
 * Two distinct steps, deliberately separate:
 *
 *   requireReadApiKey  — *authentication*: is this a key we issued?
 *   requireAppScope    — *authorization*: may THIS key read THIS app?
 *
 * The second step is what makes the service multi-tenant. Without it a valid
 * key read every tenant's analytics, because the appId allowlist only ever
 * constrained which table was queried, never who was entitled to query it.
 */

const crypto = require('crypto');

const { API_KEY_HEADER, HTTP_STATUS, SCOPE_ALL } = require('../constants');

/**
 * Constant-time string comparison (agent-instructions SECURITY.md §2).
 *
 * A plain `===` returns as soon as two bytes differ, so response timing leaks
 * how many leading characters were correct. The mismatched-length path still
 * performs an equal-cost dummy comparison so "wrong length" and "right length,
 * wrong value" are not distinguishable by timing either.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) {
        crypto.timingSafeEqual(ab, ab);
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Check a presented key against every configured key.
 *
 * Deliberately does not short-circuit on the first match: returning early
 * would make the response time depend on the key's position in the list.
 *
 * @param {string} presented
 * @param {string[]} configured
 * @returns {boolean}
 */
function matchesAnyKey(presented, configured) {
    let matched = false;
    for (const key of configured) {
        if (safeEqual(presented, key)) matched = true;
    }
    return matched;
}

/**
 * Resolve a presented key to its scope, without short-circuiting.
 *
 * @param {string} presented
 * @param {Record<string, string|string[]>} keyScopes  key -> '*' | [appId]
 * @returns {string|string[]|null} the scope, or null when no key matched
 */
function resolveScope(presented, keyScopes) {
    let scope = null;
    for (const [key, keyScope] of Object.entries(keyScopes)) {
        if (safeEqual(presented, key)) scope = keyScope;
    }
    return scope;
}

/**
 * Does a resolved scope permit this app?
 * @param {string|string[]} scope
 * @param {string} appId
 * @returns {boolean}
 */
function scopeAllows(scope, appId) {
    if (scope === SCOPE_ALL) return true;
    return Array.isArray(scope) && scope.includes(appId);
}

/**
 * Expand a scope into the concrete list of apps it can see.
 * @param {string|string[]} scope
 * @param {string[]} allApps
 * @returns {string[]}
 */
function appsInScope(scope, allApps) {
    if (scope === SCOPE_ALL) return [...allApps];
    if (!Array.isArray(scope)) return [];
    return allApps.filter((appId) => scope.includes(appId));
}

/**
 * Authenticate a read request and attach its scope as `req.auth`.
 *
 * Fails closed: with no keys configured the read API is unavailable rather
 * than unprotected, so a deployment that forgets to set them cannot silently
 * serve another party's analytics to the internet.
 *
 * @param {{ readKeyScopes: Record<string, string|string[]> }} authConfig
 * @returns {import('express').RequestHandler}
 */
function requireReadApiKey(authConfig) {
    const keyScopes = authConfig?.readKeyScopes || {};

    return (req, res, next) => {
        if (Object.keys(keyScopes).length === 0) {
            return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
                message: 'Read API is not configured on this server',
            });
        }

        const presented = req.get(API_KEY_HEADER);
        const scope = presented ? resolveScope(presented, keyScopes) : null;

        if (scope === null) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({
                message: 'Missing or invalid API key',
            });
        }

        req.auth = { scope };
        return next();
    };
}

/**
 * Authorize the requested `:appId` against the authenticated key's scope.
 *
 * Runs after requireReadApiKey. Returns 403 rather than 404 for an app that
 * exists but is out of scope, and the same 403 for one that does not exist, so
 * the response does not disclose which tenants are registered.
 *
 * @returns {import('express').RequestHandler}
 */
function requireAppScope() {
    return (req, res, next) => {
        const { appId } = req.params;
        if (!appId) return next();

        if (!req.auth || !scopeAllows(req.auth.scope, appId)) {
            return res.status(HTTP_STATUS.FORBIDDEN).json({
                message: 'This API key is not authorized for that appId',
            });
        }

        return next();
    };
}

/**
 * Require an admin credential.
 *
 * A separate tier from read keys (SECURITY.md §3): provisioning apps is a
 * different privilege from reading them, so leaking a tenant's read key must
 * not confer it, and revoking one tier must not force rotating the other.
 *
 * @param {{ adminApiKeys: string[] }} authConfig
 * @returns {import('express').RequestHandler}
 */
function requireAdminApiKey(authConfig) {
    const keys = Array.isArray(authConfig?.adminApiKeys) ? authConfig.adminApiKeys : [];

    return (req, res, next) => {
        if (keys.length === 0) {
            return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
                message: 'Admin API is not configured on this server',
            });
        }

        const presented = req.get(API_KEY_HEADER);
        if (!presented || !matchesAnyKey(presented, keys)) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({
                message: 'Missing or invalid admin key',
            });
        }

        return next();
    };
}

module.exports = {
    requireReadApiKey,
    requireAppScope,
    requireAdminApiKey,
    safeEqual,
    matchesAnyKey,
    resolveScope,
    scopeAllows,
    appsInScope,
};
