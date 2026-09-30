/**
 * Unit tests for the admin building blocks: sessions, CSRF, cookies, field
 * validation, config, and message text.
 */

const {
    createSessionStore,
    requireAdminSession,
    requireRecentPassword,
    requireCsrf,
    sessionCsrfToken,
    verifyPassword,
    cookieOptions,
    expectedOrigin,
    hashToken,
} = require('../middleware/adminAuth');
const { createDbSessionStore } = require('../db/adminSessionStore');
const { createScriptedPool, dbWith } = require('./support/scriptedPool');
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
    test('creates opaque tokens and finds the session by them', async () => {
        const store = createSessionStore();
        const { token, session } = await store.create();
        expect(token.length).toBeGreaterThanOrEqual(ADMIN.SESSION_TOKEN_BYTES);
        expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(await store.get(token)).toEqual({ id: session.id, passwordAgeMs: expect.any(Number) });
        expect(store.size).toBe(1);
    });

    test('keys sessions by the token hash, never the token itself', () => {
        expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    test.each([undefined, '', 'unknown-token', 42])('does not find a session for %j', async (token) => {
        expect(await createSessionStore().get(token)).toBeNull();
    });

    test('expires after the idle timeout, and activity extends it', async () => {
        let clock = 0;
        const store = createSessionStore({ idleMs: 100, absoluteMs: 10_000, now: () => clock });
        const { token } = await store.create();
        clock = 90;
        expect(await store.get(token)).not.toBeNull();
        clock = 180;
        expect(await store.get(token)).not.toBeNull();
        clock = 281;
        expect(await store.get(token)).toBeNull();
        expect(store.size).toBe(0);
    });

    test('expires after the absolute timeout however active it is', async () => {
        let clock = 0;
        const store = createSessionStore({ idleMs: 100, absoluteMs: 250, now: () => clock });
        const { token } = await store.create();
        for (clock = 50; clock <= 250; clock += 50) expect(await store.get(token)).not.toBeNull();
        clock = 251;
        expect(await store.get(token)).toBeNull();
    });

    test('evicts the oldest session beyond the cap', async () => {
        const store = createSessionStore({ maxSessions: 2 });
        const first = await store.create();
        const second = await store.create();
        const third = await store.create();
        expect(store.size).toBe(2);
        expect(await store.get(first.token)).toBeNull();
        expect(await store.get(second.token)).not.toBeNull();
        expect(await store.get(third.token)).not.toBeNull();
    });

    test('destroy ends a session and reports whether one existed', async () => {
        const store = createSessionStore();
        const { token } = await store.create();
        expect(await store.destroy(token)).toBe(true);
        expect(await store.destroy(token)).toBe(false);
        expect(await store.destroy(undefined)).toBe(false);
        expect(await store.destroy('')).toBe(false);
    });

    test('the password age starts at sign-in and restarts when the password is confirmed', async () => {
        let clock = 1000;
        const store = createSessionStore({ now: () => clock });
        const { token } = await store.create();
        clock = 1000 + ADMIN.REAUTH_WINDOW_MS + 1;
        expect((await store.get(token)).passwordAgeMs).toBe(ADMIN.REAUTH_WINDOW_MS + 1);
        await store.confirmPassword(token);
        expect((await store.get(token)).passwordAgeMs).toBe(0);
    });

    test('the configured timeouts are exposed for the cookie lifetime', () => {
        expect(createSessionStore({ idleMs: 5, absoluteMs: 9 })).toMatchObject({ idleMs: 5, absoluteMs: 9 });
        expect(createSessionStore()).toMatchObject({
            idleMs: ADMIN.SESSION_IDLE_TIMEOUT_MS, absoluteMs: ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
        });
    });
});

describe('database session store', () => {
    const row = (overrides = {}) => ({ id: 's1', age_s: 10, idle_s: 5, password_age_s: 10, ...overrides });
    const storeWith = (handler, options) => {
        const pool = createScriptedPool(handler);
        return { pool, store: createDbSessionStore(dbWith(pool), options) };
    };

    test('create clears expired sessions, stores only the token hash, and caps the table', async () => {
        const { pool, store } = storeWith(() => [{ affectedRows: 0 }], { idleMs: 3_600_000, absoluteMs: 86_400_000, maxSessions: 7 });
        const { token, session } = await store.create();
        const [purge, insert, cap] = pool.queries;
        expect(purge.sql).toContain('last_seen_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)');
        expect(purge.params).toEqual([3600, 86400]);
        expect(insert.params).toEqual([hashToken(token), session.id]);
        expect(JSON.stringify(pool.queries)).not.toContain(token);
        expect(cap.sql).toContain('ORDER BY last_seen_at DESC, created_at DESC LIMIT ?');
        expect(cap.params).toEqual([7]);
        expect(session.passwordAgeMs).toBe(0);
    });

    test('get reports the password age and touches last-seen at most once a minute', async () => {
        const fresh = storeWith(() => [[row({ idle_s: 5 })]]);
        expect(await fresh.store.get('t')).toEqual({ id: 's1', passwordAgeMs: 10_000 });
        expect(fresh.pool.matching('UPDATE')).toHaveLength(0);

        const idle = storeWith(() => [[row({ idle_s: 61 })]]);
        await idle.store.get('t');
        expect(idle.pool.matching('SET last_seen_at = NOW(3)')).toHaveLength(1);
    });

    test.each([
        ['idle too long', { idle_s: 11 }],
        ['too old', { age_s: 21 }],
    ])('a session %s is deleted and not returned', async (_label, overrides) => {
        const { pool, store } = storeWith((sql) => (sql.startsWith('SELECT') ? [[row(overrides)]] : [{ affectedRows: 1 }]),
            { idleMs: 10_000, absoluteMs: 20_000 });
        expect(await store.get('t')).toBeNull();
        expect(pool.matching('DELETE FROM `_admin_sessions` WHERE token_hash = ?')[0].params).toEqual([hashToken('t')]);
    });

    test('an unknown or absent token finds nothing, and an absent one asks nothing', async () => {
        const { pool, store } = storeWith(() => [[]]);
        expect(await store.get('nope')).toBeNull();
        expect(await store.get(undefined)).toBeNull();
        expect(pool.queries).toHaveLength(1);
    });

    test('confirmPassword and destroy address the session by its hash', async () => {
        const { pool, store } = storeWith(() => [{ affectedRows: 1 }]);
        await store.confirmPassword('t');
        expect(await store.destroy('t')).toBe(true);
        expect(pool.queries.map((q) => q.params)).toEqual([[hashToken('t')], [hashToken('t')]]);
        expect(pool.queries[0].sql).toContain('SET password_at = NOW(3)');
    });
});

describe('requireAdminSession', () => {
    test('attaches the session and token when the cookie is valid', async () => {
        const store = createSessionStore();
        const { token, session } = await store.create();
        const req = fakeReq({ headers: { cookie: `other=1; ${ADMIN.SESSION_COOKIE}=${token}` } });
        const next = jest.fn();
        await requireAdminSession(store)(req, fakeRes(), next);
        expect(next).toHaveBeenCalledWith();
        expect(req.adminSession.id).toBe(session.id);
        expect(req.adminToken).toBe(token);
    });

    test('answers 401 without a valid cookie', async () => {
        const res = fakeRes();
        const next = jest.fn();
        await requireAdminSession(createSessionStore())(fakeReq(), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ code: ADMIN_ERROR_CODE.UNAUTHENTICATED });
    });

    test('a store that cannot be read is an error, not a sign-out', async () => {
        const next = jest.fn();
        const failing = { get: async () => { throw new TypeError('db down'); } };
        await requireAdminSession(failing)(fakeReq({ headers: { cookie: `${ADMIN.SESSION_COOKIE}=x` } }), fakeRes(), next);
        expect(next).toHaveBeenCalledWith(expect.any(TypeError));
    });
});

describe('requireRecentPassword', () => {
    const run = (passwordAgeMs) => {
        const req = fakeReq({ method: 'POST' });
        req.adminSession = { id: 's', passwordAgeMs };
        const res = fakeRes();
        const next = jest.fn();
        requireRecentPassword()(req, res, next);
        return { res, next };
    };

    test('passes when the password was entered within the window', () => {
        expect(run(ADMIN.REAUTH_WINDOW_MS).next).toHaveBeenCalled();
    });

    test('asks for the password again once the window has passed', () => {
        const { res, next } = run(ADMIN.REAUTH_WINDOW_MS + 1);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ code: ADMIN_ERROR_CODE.REAUTH_REQUIRED });
    });
});

describe('requireCsrf', () => {
    const TOKEN = 'session-token';
    const CSRF = sessionCsrfToken(TOKEN);
    const run = (reqOptions, adminSession = { id: 's' }) => {
        const req = fakeReq(reqOptions);
        req.adminSession = adminSession;
        req.adminToken = TOKEN;
        const res = fakeRes();
        const next = jest.fn();
        requireCsrf()(req, res, next);
        return { res, next };
    };

    test('the CSRF token is derived from the session token: stable, distinct, and not the token', () => {
        expect(sessionCsrfToken(TOKEN)).toBe(CSRF);
        expect(sessionCsrfToken('other-token')).not.toBe(CSRF);
        expect(CSRF).not.toContain(TOKEN);
    });

    test.each(['GET', 'HEAD', 'OPTIONS'])('%s needs no token', (method) => {
        expect(run({ method }).next).toHaveBeenCalled();
    });

    test('a matching token from the same origin passes', () => {
        const { next } = run({ method: 'POST', headers: { [ADMIN.CSRF_HEADER]: CSRF, origin: 'https://views.example' } });
        expect(next).toHaveBeenCalled();
    });

    test('a matching token with no Origin header passes', () => {
        expect(run({ method: 'DELETE', headers: { [ADMIN.CSRF_HEADER]: CSRF } }).next).toHaveBeenCalled();
    });

    test.each([
        ['a missing token', {}],
        ['a wrong token', { [ADMIN.CSRF_HEADER]: 'nope' }],
        ['another session\'s token', { [ADMIN.CSRF_HEADER]: sessionCsrfToken('other-token') }],
        ['a foreign origin', { [ADMIN.CSRF_HEADER]: CSRF, origin: 'https://evil.example' }],
        ['a scheme downgrade', { [ADMIN.CSRF_HEADER]: CSRF, origin: 'http://views.example' }],
    ])('refuses %s', (_label, headers) => {
        const { res, next } = run({ method: 'POST', headers });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ code: ADMIN_ERROR_CODE.CSRF_REJECTED });
    });

    test('refuses when there is no session at all', () => {
        const { next } = run({ method: 'POST', headers: { [ADMIN.CSRF_HEADER]: CSRF } }, null);
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
        expect(cookieOptions({ secure: true }, 3_600_000).maxAge).toBe(3_600_000);
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
            .toEqual({
                password: PASSWORD,
                enabled: true,
                trashRetentionDays: ADMIN.DEFAULT_TRASH_RETENTION_DAYS,
                viewLogRetentionDays: ADMIN.DEFAULT_VIEW_LOG_RETENTION_DAYS,
                sessionIdleMs: ADMIN.SESSION_IDLE_TIMEOUT_MS,
                sessionMaxAgeMs: ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS,
            });
    });

    test('session timeouts default to 7 days unused and 30 days in all', () => {
        expect(ADMIN.SESSION_IDLE_TIMEOUT_MS).toBe(7 * 24 * 60 * 60 * 1000);
        expect(ADMIN.SESSION_ABSOLUTE_TIMEOUT_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });

    test.each([
        ['30m', '12h', 30 * 60 * 1000, 12 * 60 * 60 * 1000],
        ['2d', '90d', 2 * 86_400_000, 90 * 86_400_000],
        [' 1H ', '1d', 3_600_000, 86_400_000],
    ])('ADMIN_SESSION_IDLE_TIMEOUT=%j and ADMIN_SESSION_MAX_AGE=%j are read', (idle, max, idleMs, maxMs) => {
        const admin = new Config({ NODE_ENV: 'test', ADMIN_SESSION_IDLE_TIMEOUT: idle, ADMIN_SESSION_MAX_AGE: max }).admin;
        expect(admin).toMatchObject({ sessionIdleMs: idleMs, sessionMaxAgeMs: maxMs });
    });

    test.each([
        ['ADMIN_SESSION_IDLE_TIMEOUT', '30 min'],
        ['ADMIN_SESSION_IDLE_TIMEOUT', '1.5h'],
        ['ADMIN_SESSION_IDLE_TIMEOUT', '1m'],
        ['ADMIN_SESSION_IDLE_TIMEOUT', '91d'],
        ['ADMIN_SESSION_MAX_AGE', '30'],
        ['ADMIN_SESSION_MAX_AGE', '59m'],
        ['ADMIN_SESSION_MAX_AGE', '366d'],
    ])('%s=%j stops startup instead of falling back', (field, value) => {
        expect(() => new Config({ NODE_ENV: 'test', [field]: value })).toThrow(`Invalid configuration for '${field}'`);
    });

    test('an idle timeout longer than the maximum age stops startup', () => {
        expect(() => new Config({ NODE_ENV: 'test', ADMIN_SESSION_IDLE_TIMEOUT: '10d', ADMIN_SESSION_MAX_AGE: '7d' }))
            .toThrow("Invalid configuration for 'ADMIN_SESSION_IDLE_TIMEOUT': must not be longer than ADMIN_SESSION_MAX_AGE (7d)");
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

    test.each([
        ['7', 7],
        ['0', 0],
        [String(ADMIN.MAX_VIEW_LOG_RETENTION_DAYS), ADMIN.MAX_VIEW_LOG_RETENTION_DAYS],
        [undefined, ADMIN.DEFAULT_VIEW_LOG_RETENTION_DAYS],
        ['', ADMIN.DEFAULT_VIEW_LOG_RETENTION_DAYS],
        ['abc', ADMIN.DEFAULT_VIEW_LOG_RETENTION_DAYS],
        ['-1', ADMIN.DEFAULT_VIEW_LOG_RETENTION_DAYS],
        [String(ADMIN.MAX_VIEW_LOG_RETENTION_DAYS + 1), ADMIN.DEFAULT_VIEW_LOG_RETENTION_DAYS],
    ])('VIEW_LOG_RETENTION_DAYS=%j resolves to %j', (raw, expected) => {
        expect(new Config({ NODE_ENV: 'test', VIEW_LOG_RETENTION_DAYS: raw }).admin.viewLogRetentionDays).toBe(expected);
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
        [WarningType.VIEW_LOG_PRUNE_FAILED, { cause: 'c' }, 'Automatic view log pruning failed: c'],
    ])('%s reads exactly', (type, info, message) => {
        const entry = WARNING_MESSAGES[type];
        expect(typeof entry === 'function' ? entry(info) : entry).toBe(message);
    });
});
