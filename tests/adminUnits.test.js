/**
 * Unit tests for the admin building blocks: sessions, CSRF, cookies, field
 * validation, config, and message text.
 */

const {
    createSessionStore,
    requireAdminSession,
    requireCsrf,
    verifyPassword,
    cookieOptions,
    expectedOrigin,
    hashToken,
} = require('../middleware/adminAuth');
const { parseCookies, MAX_COOKIE_PAIRS } = require('../utils/cookieUtils');
const { resolveChanges, checkField } = require('../middleware/adminValidation');
const { Config } = require('../config');
const { ErrorType, WarningType, ERROR_MESSAGES, WARNING_MESSAGES, getError } = require('../utils/errorUtils');
const { ADMIN, ADMIN_ERROR_CODE, FIELD_MAX_LENGTH, PAYLOAD_LIMITS } = require('../constants');
const logger = require('../utils/logger');

const DEVICE_SIZES = ['small', 'medium', 'large'];

/** Minimal Express-shaped response double. */
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function fakeReq({ method = 'GET', headers = {}, protocol = 'https', host = 'views.example', secure = true } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        method,
        protocol,
        secure,
        headers: lower,
        get(name) { return name.toLowerCase() === 'host' ? host : lower[name.toLowerCase()]; },
    };
}

describe('session store', () => {
    test('creates opaque tokens and finds the session by them', () => {
        const store = createSessionStore();
        const { token, session } = store.create();
        expect(token.length).toBeGreaterThanOrEqual(ADMIN.SESSION_TOKEN_BYTES);
        expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(session.csrfToken).not.toBe(token);
        expect(store.get(token)).toBe(session);
        expect(store.size).toBe(1);
    });

    test('keys sessions by the token hash, never the token itself', () => {
        expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    test.each([undefined, '', 'unknown-token', 42])('does not find a session for %j', (token) => {
        expect(createSessionStore().get(token)).toBeNull();
    });

    test('expires after the idle timeout, and activity extends it', () => {
        let clock = 0;
        const store = createSessionStore({ idleMs: 100, absoluteMs: 10_000, now: () => clock });
        const { token } = store.create();
        clock = 90;
        expect(store.get(token)).not.toBeNull();
        clock = 180;
        expect(store.get(token)).not.toBeNull();
        clock = 281;
        expect(store.get(token)).toBeNull();
        expect(store.size).toBe(0);
    });

    test('expires after the absolute timeout however active it is', () => {
        let clock = 0;
        const store = createSessionStore({ idleMs: 100, absoluteMs: 250, now: () => clock });
        const { token } = store.create();
        for (clock = 50; clock <= 250; clock += 50) expect(store.get(token)).not.toBeNull();
        clock = 251;
        expect(store.get(token)).toBeNull();
    });

    test('evicts the oldest session beyond the cap', () => {
        const store = createSessionStore({ maxSessions: 2 });
        const first = store.create();
        const second = store.create();
        const third = store.create();
        expect(store.size).toBe(2);
        expect(store.get(first.token)).toBeNull();
        expect(store.get(second.token)).not.toBeNull();
        expect(store.get(third.token)).not.toBeNull();
    });

    test('destroy ends a session and reports whether one existed', () => {
        const store = createSessionStore();
        const { token } = store.create();
        expect(store.destroy(token)).toBe(true);
        expect(store.destroy(token)).toBe(false);
        expect(store.destroy(undefined)).toBe(false);
        expect(store.destroy('')).toBe(false);
    });
});

describe('requireAdminSession', () => {
    test('attaches the session and token when the cookie is valid', () => {
        const store = createSessionStore();
        const { token, session } = store.create();
        const req = fakeReq({ headers: { cookie: `other=1; ${ADMIN.SESSION_COOKIE}=${token}` } });
        const next = jest.fn();
        requireAdminSession(store)(req, fakeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.adminSession).toBe(session);
        expect(req.adminToken).toBe(token);
    });

    test('answers 401 without a valid cookie', () => {
        const res = fakeRes();
        const next = jest.fn();
        requireAdminSession(createSessionStore())(fakeReq(), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ code: ADMIN_ERROR_CODE.UNAUTHENTICATED });
    });
});

describe('requireCsrf', () => {
    const session = { csrfToken: 'tok' };
    const run = (reqOptions, adminSession = session) => {
        const req = fakeReq(reqOptions);
        req.adminSession = adminSession;
        const res = fakeRes();
        const next = jest.fn();
        requireCsrf()(req, res, next);
        return { res, next };
    };

    test.each(['GET', 'HEAD', 'OPTIONS'])('%s needs no token', (method) => {
        expect(run({ method }).next).toHaveBeenCalled();
    });

    test('a matching token from the same origin passes', () => {
        const { next } = run({ method: 'POST', headers: { [ADMIN.CSRF_HEADER]: 'tok', origin: 'https://views.example' } });
        expect(next).toHaveBeenCalled();
    });

    test('a matching token with no Origin header passes', () => {
        expect(run({ method: 'DELETE', headers: { [ADMIN.CSRF_HEADER]: 'tok' } }).next).toHaveBeenCalled();
    });

    test.each([
        ['a missing token', {}],
        ['a wrong token', { [ADMIN.CSRF_HEADER]: 'nope' }],
        ['a foreign origin', { [ADMIN.CSRF_HEADER]: 'tok', origin: 'https://evil.example' }],
        ['a scheme downgrade', { [ADMIN.CSRF_HEADER]: 'tok', origin: 'http://views.example' }],
    ])('refuses %s', (_label, headers) => {
        const { res, next } = run({ method: 'POST', headers });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ code: ADMIN_ERROR_CODE.CSRF_REJECTED });
    });

    test('refuses when there is no session at all', () => {
        const { next } = run({ method: 'POST', headers: { [ADMIN.CSRF_HEADER]: 'tok' } }, null);
        expect(next).not.toHaveBeenCalled();
    });
});

describe('verifyPassword and cookie helpers', () => {
    test.each([
        ['the right password', 'p'.repeat(16), true],
        ['a wrong password', 'q'.repeat(16), false],
        ['a prefix', 'p'.repeat(15), false],
        ['nothing', undefined, false],
    ])('%s', (_label, presented, expected) => {
        expect(verifyPassword(presented, 'p'.repeat(16))).toBe(expected);
    });

    test('an unset password never matches, not even an empty submission', () => {
        expect(verifyPassword('', '')).toBe(false);
        expect(verifyPassword('anything', undefined)).toBe(false);
    });

    test('cookie options are HttpOnly, SameSite=Strict, path-scoped, and follow the transport', () => {
        expect(cookieOptions({ secure: true })).toEqual({
            httpOnly: true, sameSite: 'strict', secure: true, path: ADMIN.PATH_PREFIX, maxAge: ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
        });
        expect(cookieOptions({ secure: false }).secure).toBe(false);
        expect(cookieOptions({ secure: true, adminBasePath: '/dashboard' }).path).toBe('/dashboard');
    });

    test('expectedOrigin is scheme plus host', () => {
        expect(expectedOrigin(fakeReq({ protocol: 'http', host: 'localhost:3333' }))).toBe('http://localhost:3333');
    });
});

describe('parseCookies', () => {
    test.each([
        [undefined, {}],
        ['', {}],
        ['a=1', { a: '1' }],
        ['a=1; b=two', { a: '1', b: 'two' }],
        ['a="quoted"', { a: 'quoted' }],
        ['a=%20space', { a: ' space' }],
        ['a=%E0%A4%A', { a: '%E0%A4%A' }],
        ['=novalue; b=2', { b: '2' }],
        ['noequals; b=2', { b: '2' }],
        ['a=first; a=second', { a: 'first' }],
        ['a=x=y', { a: 'x=y' }],
    ])('parses %j', (header, expected) => {
        expect({ ...parseCookies(header) }).toEqual(expected);
    });

    test('ignores pairs beyond the cap', () => {
        const header = Array.from({ length: MAX_COOKIE_PAIRS + 5 }, (_, i) => `c${i}=${i}`).join('; ');
        const cookies = parseCookies(header);
        expect(Object.keys(cookies)).toHaveLength(MAX_COOKIE_PAIRS);
    });

    test('a __proto__ cookie cannot pollute the result', () => {
        const cookies = parseCookies('__proto__=x; a=1');
        expect(Object.getPrototypeOf(cookies)).toBeNull();
        expect(({}).x).toBeUndefined();
    });
});

describe('edit validation', () => {
    test.each([
        ['pagePath', '/x', '/x'],
        ['pagePath', '', null],
        ['pagePath', null, null],
        ['pageTitle', 'T', 'T'],
        ['referrer', null, null],
        ['deviceSize', 'small', 'small'],
        ['eventType', 'click', 'click'],
        ['eventData', null, null],
        ['eventData', { a: 1 }, '{"a":1}'],
        ['eventData', [1, 2], '[1,2]'],
    ])('accepts %s = %j', (field, value, stored) => {
        expect(checkField(field, value, DEVICE_SIZES)).toEqual({ ok: true, value: stored });
    });

    test.each([
        ['pagePath', 5, 'pagePath must be a string or null'],
        ['pagePath', 'x'.repeat(FIELD_MAX_LENGTH.PAGE_PATH + 1), `pagePath must be at most ${FIELD_MAX_LENGTH.PAGE_PATH} characters`],
        ['pageTitle', 'x'.repeat(FIELD_MAX_LENGTH.PAGE_TITLE + 1), `pageTitle must be at most ${FIELD_MAX_LENGTH.PAGE_TITLE} characters`],
        ['referrer', 'x'.repeat(FIELD_MAX_LENGTH.REFERRER + 1), `referrer must be at most ${FIELD_MAX_LENGTH.REFERRER} characters`],
        ['deviceSize', 'huge', 'deviceSize must be one of: small, medium, large'],
        ['deviceSize', null, 'deviceSize must be one of: small, medium, large'],
        ['eventType', '  ', 'eventType must be a non-empty string'],
        ['eventType', 7, 'eventType must be a non-empty string'],
        ['eventType', 'e'.repeat(FIELD_MAX_LENGTH.EVENT_TYPE + 1), `eventType must be at most ${FIELD_MAX_LENGTH.EVENT_TYPE} characters`],
        ['eventData', 'text', 'eventData must be an object, an array, or null'],
        ['eventData', { big: 'x'.repeat(PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES) }, `eventData must serialize to at most ${PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES} bytes`],
        ['country', 'US', 'country is not an editable field'],
    ])('refuses %s = %j with its exact message', (field, value, message) => {
        expect(checkField(field, value, DEVICE_SIZES)).toEqual({ ok: false, error: message });
    });

    test.each([
        [null, 'changes must be an object'],
        [[], 'changes must be an object'],
        ['str', 'changes must be an object'],
        [{}, 'changes must name at least one field'],
        [{ maskedIp: 'x' }, 'maskedIp is not an editable field'],
        [{ __proto__: null, constructor: 'x' }, 'constructor is not an editable field'],
        [{ pageTitle: 5 }, 'pageTitle must be a string or null'],
    ])('resolveChanges refuses %j', (changes, error) => {
        expect(resolveChanges(changes, DEVICE_SIZES)).toEqual({ ok: false, error });
    });

    test('resolveChanges maps fields to columns', () => {
        expect(resolveChanges({ pagePath: '/p', deviceSize: 'medium' }, DEVICE_SIZES)).toEqual({
            ok: true, columns: { page_path: '/p', devicesize: 'medium' }, fields: ['pagePath', 'deviceSize'],
        });
    });

    test('a referrer change re-derives domain and source type', () => {
        expect(resolveChanges({ referrer: 'https://twitter.com/abc' }, DEVICE_SIZES).columns).toEqual({
            referrer: 'https://twitter.com/abc', referrer_domain: 'twitter.com', source_type: 'social',
        });
    });

    test('clearing the referrer makes the view direct', () => {
        expect(resolveChanges({ referrer: null }, DEVICE_SIZES).columns).toEqual({
            referrer: null, referrer_domain: null, source_type: 'direct',
        });
    });
});

describe('admin config', () => {
    let lines;
    beforeEach(() => {
        lines = [];
        logger.configure({ level: logger.LogLevel.DEBUG, writer: (line) => lines.push(line) });
    });
    afterEach(() => logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} }));

    const PASSWORD = 'p'.repeat(ADMIN.MIN_PASSWORD_LENGTH);

    test('ADMIN_PASSWORD set and long enough enables the UI', () => {
        expect(new Config({ NODE_ENV: 'test', ADMIN_PASSWORD: PASSWORD }).admin)
            .toEqual({ password: PASSWORD, enabled: true, trashRetentionDays: ADMIN.DEFAULT_TRASH_RETENTION_DAYS });
    });

    test('ADMIN_PASSWORD unset leaves the UI disabled', () => {
        expect(new Config({ NODE_ENV: 'test' }).admin.enabled).toBe(false);
    });

    test('a too-short ADMIN_PASSWORD never enables the UI', () => {
        expect(new Config({ NODE_ENV: 'test', ADMIN_PASSWORD: 'short' }).admin)
            .toMatchObject({ password: 'short', enabled: false });
    });

    test.each([
        ['7', 7],
        ['0', 0],
        [String(ADMIN.MAX_TRASH_RETENTION_DAYS), ADMIN.MAX_TRASH_RETENTION_DAYS],
        [undefined, ADMIN.DEFAULT_TRASH_RETENTION_DAYS],
        ['', ADMIN.DEFAULT_TRASH_RETENTION_DAYS],
        ['abc', ADMIN.DEFAULT_TRASH_RETENTION_DAYS],
        ['-1', ADMIN.DEFAULT_TRASH_RETENTION_DAYS],
        [String(ADMIN.MAX_TRASH_RETENTION_DAYS + 1), ADMIN.DEFAULT_TRASH_RETENTION_DAYS],
    ])('TRASH_RETENTION_DAYS=%j resolves to %j', (raw, expected) => {
        expect(new Config({ NODE_ENV: 'test', TRASH_RETENTION_DAYS: raw }).admin.trashRetentionDays).toBe(expected);
    });

    test('production refuses to boot on a too-short password, with the exact message', () => {
        const config = new Config({
            NODE_ENV: 'production', ADMIN_PASSWORD: 'short', VISITOR_SECRET: 'v'.repeat(64),
            DB_USER: 'u', DB_PASSWORD: 'p', ALLOWED_APP_IDS: 'blog', CORS_ORIGINS: 'https://a.example',
        });
        expect(() => config.validate()).toThrow(
            `Invalid configuration for 'ADMIN_PASSWORD': must be at least ${ADMIN.MIN_PASSWORD_LENGTH} characters`
        );
    });

    test('outside production a too-short password only warns that the UI is disabled', () => {
        const config = new Config({ NODE_ENV: 'development', ADMIN_PASSWORD: 'short', VISITOR_SECRET: 'v'.repeat(64) });
        expect(() => config.validate()).not.toThrow();
        expect(lines.join('\n')).toContain(WARNING_MESSAGES[WarningType.ADMIN_UI_DISABLED]);
    });

    test('an unset password warns that the UI is disabled', () => {
        new Config({ NODE_ENV: 'development', VISITOR_SECRET: 'v'.repeat(64) }).validate();
        expect(lines.join('\n')).toContain('ADMIN_PASSWORD is not set; the admin UI and its API are disabled.');
    });

    test('reusing an API key as the admin password warns', () => {
        const key = 'k'.repeat(40);
        new Config({ NODE_ENV: 'development', VISITOR_SECRET: 'v'.repeat(64), ADMIN_PASSWORD: key, READ_API_KEYS: key }).validate();
        expect(lines.join('\n')).toContain(WARNING_MESSAGES[WarningType.ADMIN_PASSWORD_REUSED]);
    });

    test('an independent password raises no admin warning', () => {
        new Config({ NODE_ENV: 'development', VISITOR_SECRET: 'v'.repeat(64), ADMIN_PASSWORD: PASSWORD, ADMIN_API_KEYS: 'a'.repeat(40) }).validate();
        const text = lines.join('\n');
        expect(text).not.toContain('ADMIN_PASSWORD');
    });
});

describe('admin message text', () => {
    test.each([
        [ErrorType.MIGRATION_FAILED, { table: 't', cause: 'c' }, "Schema migration failed for table 't': c"],
        [ErrorType.FIELD_NOT_WRITABLE, { column: 'masked_ip' }, "Refusing to write column 'masked_ip': it is not an admin-editable field."],
    ])('%s reads exactly', (type, info, message) => {
        expect(getError(type, info).message).toBe(message);
        expect(ERROR_MESSAGES[type]).toBeDefined();
    });

    test.each([
        [WarningType.ADMIN_UI_DISABLED, {}, 'ADMIN_PASSWORD is not set; the admin UI and its API are disabled.'],
        [WarningType.ADMIN_PASSWORD_REUSED, {}, 'ADMIN_PASSWORD is identical to a configured API key. Use an independent secret so leaking one credential tier never unlocks another.'],
        [WarningType.ADMIN_INSECURE_TRANSPORT, {}, 'An admin login arrived over plain HTTP. The session cookie is not marked Secure on such a request; serve the admin UI over HTTPS.'],
        [WarningType.ADMIN_ORIGIN_REJECTED, { presented: 'https://a', expected: 'http://a' }, "Refused an admin request from origin 'https://a'; this server expected 'http://a'. Behind a TLS-terminating proxy, set TRUST_PROXY and have the proxy pass X-Forwarded-Proto and the original Host."],
        [WarningType.MIGRATION_TABLE_MISSING, { table: 'x' }, "Table 'x' does not exist; skipping its schema migration."],
        [WarningType.VIEW_LOG_WRITE_FAILED, { appId: 'a', cause: 'c' }, "Could not write the view register log entry for 'a': c"],
        [WarningType.ADMIN_LOG_WRITE_FAILED, { action: 'x', cause: 'c' }, "Could not write the admin operation log entry 'x': c"],
        [WarningType.TRASH_PURGE_FAILED, { appId: 'a', cause: 'c' }, "Automatic trash purge failed for 'a': c"],
    ])('%s reads exactly', (type, info, message) => {
        const entry = WARNING_MESSAGES[type];
        expect(typeof entry === 'function' ? entry(info) : entry).toBe(message);
    });
});
