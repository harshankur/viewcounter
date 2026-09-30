/**
 * Client for the admin API.
 *
 * Holds the session's CSRF token and sends it on every state-changing request.
 * Failures become an ApiError carrying the server's stable `code`, which the
 * UI translates; no server-side message text is ever shown.
 */

import { API_BASE, CSRF_HEADER, ERROR_CODE } from './constants.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** These establish a session; failing them is an answer, not something to recover from. */
const SESSION_PATHS = new Set(['session', 'login']);

let csrfToken = null;
const unauthenticatedListeners = new Set();

/**
 * How a failed request recovers instead of failing, set by main.js:
 *   reauthenticate()  a sign-in dialog over the page; true once signed in again
 *   confirmPassword() the password for an action that cannot be undone; true once confirmed
 */
const recovery = { reauthenticate: null, confirmPassword: null };
/** Several requests can find the session gone at once; they share one dialog. */
let pendingSignIn = null;

export function setRecovery(handlers) {
    Object.assign(recovery, handlers);
}

function signInAgain() {
    pendingSignIn ??= recovery.reauthenticate().finally(() => { pendingSignIn = null; });
    return pendingSignIn;
}

export class ApiError {
    /** @param {number} status @param {string} code @param {object} [body] */
    constructor(status, code, body = {}) {
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

/** Called whenever the server says the session is gone. */
export function onUnauthenticated(listener) {
    unauthenticatedListeners.add(listener);
}

export function setCsrfToken(token) {
    csrfToken = token;
}

/**
 * @param {string} method
 * @param {string} path relative to the API base, no leading slash
 * @param {{ body?: object, query?: Record<string, string|number|undefined> }} [options]
 */
export async function request(method, path, { body, query } = {}, { retried = false } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
        if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const url = `${API_BASE}/${path}${params.size ? `?${params}` : ''}`;

    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!SAFE_METHODS.has(method) && csrfToken) headers[CSRF_HEADER] = csrfToken;

    let response;
    try {
        response = await fetch(url, {
            method,
            headers,
            credentials: 'same-origin',
            // The API never redirects. A gateway in front of it (Cloudflare
            // Access, say) does, to its own sign-in page, when its session ends.
            redirect: 'manual',
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, ERROR_CODE.NETWORK);
    }
    if (response.type === 'opaqueredirect') throw new ApiError(0, ERROR_CODE.ACCESS_EXPIRED);

    if (response.status === HTTP_NO_CONTENT) return null;

    let payload = {};
    try {
        payload = await response.json();
    } catch {
        payload = {};
    }

    if (!response.ok) {
        const code = payload.code || ERROR_CODE.SERVER_ERROR;
        const retry = () => request(method, path, { body, query }, { retried: true });

        if (response.status === HTTP_UNAUTHORIZED && code === ERROR_CODE.UNAUTHENTICATED) {
            // Sign in again over the page, then carry on with this request.
            if (!retried && !SESSION_PATHS.has(path) && recovery.reauthenticate && await signInAgain()) return retry();
            for (const listener of unauthenticatedListeners) listener();
        }
        if (response.status === HTTP_FORBIDDEN && code === ERROR_CODE.REAUTH_REQUIRED
            && !retried && recovery.confirmPassword && await recovery.confirmPassword()) {
            return retry();
        }
        throw new ApiError(response.status, code, payload);
    }
    return payload;
}

export const api = {
    session: () => request('GET', 'session'),
    login: (password) => request('POST', 'login', { body: { password } }),
    reauth: (password) => request('POST', 'reauth', { body: { password } }),
    logout: () => request('POST', 'logout'),
    meta: () => request('GET', 'meta'),
    apps: () => request('GET', 'apps'),
    views: (appId, query) => request('GET', `apps/${encodeURIComponent(appId)}/views`, { query }),
    allViews: (query) => request('GET', 'views', { query }),
    analytics: (appId, query) => request('GET', `apps/${encodeURIComponent(appId)}/analytics`, { query }),
    analyticsAll: (query) => request('GET', 'analytics', { query }),
    edit: (appId, ids, changes) => request('PATCH', `apps/${encodeURIComponent(appId)}/views`, { body: { ids, changes } }),
    note: (appId, ids, note) => request('PUT', `apps/${encodeURIComponent(appId)}/views/note`, { body: { ids, note } }),
    remove: (appId, ids) => request('POST', `apps/${encodeURIComponent(appId)}/views/delete`, { body: { ids } }),
    restore: (appId, ids) => request('POST', `apps/${encodeURIComponent(appId)}/views/restore`, { body: { ids } }),
    purge: (appId, ids) => request('POST', `apps/${encodeURIComponent(appId)}/views/purge`, { body: { ids } }),
    adminLog: (query) => request('GET', 'logs/admin', { query }),
    trackingLog: (query) => request('GET', 'logs/tracking', { query }),
    trackingSummary: (query) => request('GET', 'logs/tracking/summary', { query }),
};
