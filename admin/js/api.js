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

let csrfToken = null;
const unauthenticatedListeners = new Set();

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
export async function request(method, path, { body, query } = {}) {
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
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, ERROR_CODE.NETWORK);
    }

    if (response.status === HTTP_NO_CONTENT) return null;

    let payload = {};
    try {
        payload = await response.json();
    } catch {
        payload = {};
    }

    if (!response.ok) {
        const code = payload.code || ERROR_CODE.SERVER_ERROR;
        if (response.status === HTTP_UNAUTHORIZED && code === ERROR_CODE.UNAUTHENTICATED) {
            for (const listener of unauthenticatedListeners) listener();
        }
        throw new ApiError(response.status, code, payload);
    }
    return payload;
}

export const api = {
    session: () => request('GET', 'session'),
    login: (password) => request('POST', 'login', { body: { password } }),
    logout: () => request('POST', 'logout'),
    meta: () => request('GET', 'meta'),
    apps: () => request('GET', 'apps'),
    views: (appId, query) => request('GET', `apps/${encodeURIComponent(appId)}/views`, { query }),
    edit: (appId, ids, changes) => request('PATCH', `apps/${encodeURIComponent(appId)}/views`, { body: { ids, changes } }),
    note: (appId, ids, note) => request('PUT', `apps/${encodeURIComponent(appId)}/views/note`, { body: { ids, note } }),
    remove: (appId, ids) => request('POST', `apps/${encodeURIComponent(appId)}/views/delete`, { body: { ids } }),
    restore: (appId, ids) => request('POST', `apps/${encodeURIComponent(appId)}/views/restore`, { body: { ids } }),
    purge: (appId, ids) => request('POST', `apps/${encodeURIComponent(appId)}/views/purge`, { body: { ids } }),
    adminLog: (query) => request('GET', 'logs/admin', { query }),
    viewLog: (query) => request('GET', 'logs/views', { query }),
};
