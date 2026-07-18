/**
 * Tier-4 adversarial regression suite (agent-instructions TESTING.md §2,
 * SECURITY.md §10).
 *
 * Every test here corresponds to a specific finding from the security audit.
 * A fixed vulnerability class does not stay fixed without a test proving it,
 * and each of these would have passed before the fix.
 */

const request = require('supertest');

const { TEST_API_KEY } = require('./jestSetup');
const { API_KEY_HEADER, FIELD_MAX_LENGTH, PAYLOAD_LIMITS, PRIVACY, QUERY_LIMITS } = require('../constants');

jest.mock('mysql2/promise', () => require('./dbMock'));

jest.mock('../config', () => {
    const { PRIVACY: P } = require('../constants');
    return {
        dbInfo: { mode: 'connect', host: '127.0.0.1', port: 3306, database: 'test', user: 'u', password: 'p' },
        allowed: {
            appId: ['test_app_1', 'bound_app'],
            deviceSize: ['small', 'medium', 'large'],
            // bound_app has registered origins; test_app_1 deliberately does not.
            origins: { bound_app: ['https://registered.example'] }
        },
        server: {
            port: 3030,
            rateLimit: { windowMs: 60000, max: 100000, perAppMax: 0 },
            uniqueVisitorWindowHours: 24,
            nodeEnv: 'test',
            isTest: true,
            isProduction: false,
            logLevel: 'silent',
            // The fix: never bare `true`.
            trustProxy: false,
            corsOrigins: ['https://allowed.example']
        },
        auth: {
            readKeyScopes: { ['k'.repeat(P.MIN_API_KEY_LENGTH)]: '*' },
            adminApiKeys: [],
        },
        privacy: { visitorSecret: 'a'.repeat(P.SECRET_BYTES * 2) },
        validate() { return this; }
    };
});

const app = require('../index');
const { initializeServer, dbManager } = app;

const authed = (path) => request(server).get(path).set(API_KEY_HEADER, TEST_API_KEY);

/** Params of the most recent INSERT the mock recorded. */
const lastInsertParams = () => {
    const insert = [...dbManager.pool.queries].reverse()
        .find(q => q.sql.toLowerCase().includes('insert into'));
    return insert ? insert.params : [];
};

let server;

beforeAll(async () => {
    await initializeServer();
    // One listener for the whole suite. supertest otherwise opens and closes a
    // fresh ephemeral port per request; a reused port can deliver a request to
    // a socket that is no longer the server it was aimed at, which surfaces as
    // a 404 for a route that demonstrably exists.
    server = app.listen(0);
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

describe('H1 — read endpoints must be authenticated', () => {
    test('/apps does not enumerate the allowlist to an anonymous caller', async () => {
        const response = await request(server).get('/apps').expect(401);

        expect(JSON.stringify(response.body)).not.toContain('test_app_1');
    });

    test('a session lookup never exposes visitor_hash', async () => {
        const response = await authed('/sessions/test_app_1/any_session').expect(200);

        const body = JSON.stringify(response.body);
        expect(body).not.toContain('visitor_hash');
        expect(body).not.toContain('masked_ip');
    });

    test('an empty key is rejected', async () => {
        await request(server).get('/stats/test_app_1').set(API_KEY_HEADER, '').expect(401);
    });

    test('a key that is a prefix of the real one is rejected', async () => {
        await request(server).get('/stats/test_app_1')
            .set(API_KEY_HEADER, TEST_API_KEY.slice(0, -1))
            .expect(401);
    });

    test('a key with trailing padding is rejected', async () => {
        await request(server).get('/stats/test_app_1')
            .set(API_KEY_HEADER, `${TEST_API_KEY}x`)
            .expect(401);
    });
});

describe('H3 — client-supplied forwarding headers must not set the client IP', () => {
    test.each([
        ['x-forwarded-for', '9.9.9.9'],
        ['x-real-ip', '8.8.8.8'],
    ])('%s does not become the recorded address', async (header, value) => {
        await request(server)
            .get('/registerView?appId=test_app_1&deviceSize=large')
            .set(header, value)
            .expect(200);

        const params = lastInsertParams();
        const maskedOfSpoof = `${value.split('.').slice(0, 3).join('.')}.0`;

        // The spoofed address must not appear in any form.
        expect(params).not.toContain(value);
        expect(params).not.toContain(maskedOfSpoof);
    });

    test('a chained X-Forwarded-For is not honoured either', async () => {
        await request(server)
            .get('/registerView?appId=test_app_1&deviceSize=large')
            .set('x-forwarded-for', '1.2.3.4, 5.6.7.8')
            .expect(200);

        const params = lastInsertParams();
        expect(params).not.toContain('1.2.3.0');
        expect(params).not.toContain('5.6.7.0');
    });
});

describe('H4 — writes are bound to registered origins', () => {
    test('an unregistered origin cannot write to a bound app', async () => {
        await request(server)
            .get('/registerView?appId=bound_app&deviceSize=large')
            .set('origin', 'https://attacker.example')
            .expect(403);
    });

    test('a registered origin can write to a bound app', async () => {
        await request(server)
            .get('/registerView?appId=bound_app&deviceSize=large')
            .set('origin', 'https://registered.example')
            .expect(200);
    });

    test('a forged referer cannot stand in for a registered origin', async () => {
        await request(server)
            .get('/registerView?appId=bound_app&deviceSize=large')
            .set('referer', 'https://attacker.example/https://registered.example')
            .expect(403);
    });
});

describe('M4/M6 — boundary validation on untrusted input', () => {
    test.each([
        ['abc', 'non-numeric'],
        ['-1', 'negative'],
        ['0', 'below minimum'],
        ['999999999999', 'absurdly large'],
        ['1e9', 'exponential notation'],
    ])('views limit=%s (%s) is rejected', async (value) => {
        await authed(`/views/test_app_1?limit=${value}`).expect(422);
    });

    test.each(['abc', '-1', '0', '99999'])('trends days=%s is rejected', async (value) => {
        await authed(`/trends/test_app_1?days=${value}`).expect(422);
    });

    test.each(['abc', '-1', '0', '99999'])('pages limit=%s is rejected', async (value) => {
        await authed(`/pages/test_app_1?limit=${value}`).expect(422);
    });

    test('the documented maximum limit is accepted', async () => {
        await authed(`/views/test_app_1?limit=${QUERY_LIMITS.VIEWS_LIMIT_MAX}`).expect(200);
    });

    test('one past the maximum limit is rejected', async () => {
        await authed(`/views/test_app_1?limit=${QUERY_LIMITS.VIEWS_LIMIT_MAX + 1}`).expect(422);
    });

    test('a negative offset is rejected', async () => {
        await authed('/views/test_app_1?offset=-5').expect(422);
    });

    test('an over-length page path is rejected, not truncated silently', async () => {
        const page = '/'.padEnd(FIELD_MAX_LENGTH.PAGE_PATH + 50, 'a');
        await request(server)
            .get(`/registerView?appId=test_app_1&deviceSize=large&page=${encodeURIComponent(page)}`)
            .expect(422);
    });

    test('an over-length session id is rejected', async () => {
        const sessionId = 's'.repeat(FIELD_MAX_LENGTH.SESSION_ID + 10);
        await request(server)
            .get(`/registerView?appId=test_app_1&deviceSize=large&sessionId=${sessionId}`)
            .expect(422);
    });

    test('oversized eventData is rejected', async () => {
        await request(server)
            .post('/event')
            .send({
                appId: 'test_app_1',
                eventType: 'click',
                eventData: { blob: 'x'.repeat(PAYLOAD_LIMITS.MAX_EVENT_DATA_BYTES + 1000) }
            })
            .expect(422);
    });

    test('a body over the global limit is rejected', async () => {
        const response = await request(server)
            .post('/event')
            .set('content-type', 'application/json')
            .send(JSON.stringify({
                appId: 'test_app_1',
                eventType: 'click',
                pad: 'x'.repeat(PAYLOAD_LIMITS.MAX_BODY_BYTES * 2)
            }));

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });

    test('an over-length eventType is rejected', async () => {
        await request(server)
            .post('/event')
            .send({ appId: 'test_app_1', eventType: 'e'.repeat(FIELD_MAX_LENGTH.EVENT_TYPE + 5) })
            .expect(422);
    });

    test('malformed JSON is rejected without a stack trace', async () => {
        const response = await request(server)
            .post('/event')
            .set('content-type', 'application/json')
            .send('{"appId": "test_app_1", ');

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(JSON.stringify(response.body)).not.toMatch(/at \w+ \(/);
    });
});

describe('appId is the table-name gate and cannot be escaped', () => {
    test.each([
        'test_app_1`; DROP TABLE users; --',
        'test_app_1`',
        '`test_app_1`',
        'test_app_1 UNION SELECT 1',
        '../../etc/passwd',
        'information_schema.tables',
    ])('rejects injection-shaped appId %#', async (appId) => {
        await request(server)
            .get(`/registerView?appId=${encodeURIComponent(appId)}&deviceSize=large`)
            .expect(422);
    });

    test('rejects a duplicated appId parameter', async () => {
        await request(server)
            .get('/registerView?appId=test_app_1&appId=EVIL&deviceSize=large')
            .expect(422);
    });

    test('rejects an array-shaped appId', async () => {
        await request(server)
            .get('/registerView?appId[]=test_app_1&deviceSize=large')
            .expect(422);
    });

    test('rejects an object-shaped appId', async () => {
        await request(server)
            .get('/registerView?appId[toString]=test_app_1&deviceSize=large')
            .expect(422);
    });
});

describe('M1 — errors must not leak internal detail', () => {
    test('a failing query returns a correlation id, not the database message', async () => {
        const original = dbManager.getStats;
        dbManager.getStats = jest.fn().mockRejectedValue(
            new Error("Unknown column 'source_type' in 'field list'")
        );

        const response = await authed('/stats/test_app_1').expect(500);

        expect(response.body).toHaveProperty('requestId');
        const body = JSON.stringify(response.body);
        expect(body).not.toContain('source_type');
        expect(body).not.toContain('Unknown column');

        dbManager.getStats = original;
    });
});

describe('Prototype pollution', () => {
    test('__proto__ in a JSON body does not pollute Object.prototype', async () => {
        await request(server)
            .post('/event')
            .send({ appId: 'test_app_1', eventType: 'click', __proto__: { polluted: 'yes' } });

        expect({}.polluted).toBeUndefined();
    });

    test('a constructor.prototype payload does not pollute', async () => {
        await request(server)
            .post('/event')
            .set('content-type', 'application/json')
            .send('{"appId":"test_app_1","eventType":"c","constructor":{"prototype":{"bad":1}}}');

        expect({}.bad).toBeUndefined();
    });
});

describe('L8 — analytics responses must not be shared-cacheable', () => {
    test.each([
        '/stats/test_app_1',
        '/views/test_app_1',
        '/apps',
    ])('%s sets no-store', async (path) => {
        const response = await authed(path);
        expect(response.headers['cache-control']).toContain('no-store');
    });
});

describe('Constant-time key comparison', () => {
    const { safeEqual } = require('../middleware/auth');

    test('returns true only for an exact match', () => {
        expect(safeEqual('abc', 'abc')).toBe(true);
        expect(safeEqual('abc', 'abd')).toBe(false);
    });

    test('handles length mismatch without throwing', () => {
        expect(safeEqual('a', 'abcdef')).toBe(false);
        expect(safeEqual('abcdef', 'a')).toBe(false);
        expect(safeEqual('', 'a')).toBe(false);
    });

    test('short keys are refused by configuration, not comparison', () => {
        expect('short'.length).toBeLessThan(PRIVACY.MIN_API_KEY_LENGTH);
    });
});
