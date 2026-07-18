/**
 * Multi-tenant isolation.
 *
 * Before scoping, a valid read key read *every* app's analytics — the appId
 * allowlist only ever constrained which table was queried, never who was
 * entitled to query it. These tests are what keeps that from regressing.
 */

const request = require('supertest');

const { API_KEY_HEADER, PRIVACY, SCOPE_ALL } = require('../constants');
const {
    resolveScope,
    scopeAllows,
    appsInScope,
} = require('../middleware/auth');

jest.mock('mysql2/promise', () => require('./dbMock'));

const TENANT_A_KEY = 'a'.repeat(PRIVACY.MIN_API_KEY_LENGTH);
const TENANT_B_KEY = 'b'.repeat(PRIVACY.MIN_API_KEY_LENGTH);
const GLOBAL_KEY = 'g'.repeat(PRIVACY.MIN_API_KEY_LENGTH);
const ADMIN_KEY = 'A'.repeat(PRIVACY.MIN_ADMIN_KEY_LENGTH);

jest.mock('../config', () => {
    const { PRIVACY: P, SCOPE_ALL: ALL } = require('../constants');
    const a = 'a'.repeat(P.MIN_API_KEY_LENGTH);
    const b = 'b'.repeat(P.MIN_API_KEY_LENGTH);
    const g = 'g'.repeat(P.MIN_API_KEY_LENGTH);
    const admin = 'A'.repeat(P.MIN_ADMIN_KEY_LENGTH);

    return {
        dbInfo: { mode: 'connect', host: '127.0.0.1', port: 3306, database: 'test', user: 'u', password: 'p' },
        allowed: {
            appId: ['tenant_a', 'tenant_b'],
            deviceSize: ['small', 'medium', 'large'],
            origins: {},
        },
        server: {
            port: 3030,
            rateLimit: { windowMs: 60000, max: 100000, perAppMax: 0 },
            uniqueVisitorWindowHours: 24,
            nodeEnv: 'test',
            isTest: true,
            isProduction: false,
            logLevel: 'silent',
            trustProxy: false,
            corsOrigins: [],
        },
        auth: {
            readKeyScopes: {
                [a]: ['tenant_a'],
                [b]: ['tenant_b'],
                [g]: ALL,
            },
            adminApiKeys: [admin],
        },
        privacy: { visitorSecret: 'x'.repeat(P.SECRET_BYTES * 2) },
        validate() { return this; },
    };
});

const app = require('../index');
const config = require('../config');
const { initializeServer } = app;

const get = (path, key) => request(server).get(path).set(API_KEY_HEADER, key);

let server;

beforeAll(async () => {
    await initializeServer();
    // See the note in security.test.js: one listener per suite, not one per
    // request, so ephemeral port reuse cannot misroute an assertion.
    server = app.listen(0);
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

describe('Cross-tenant read isolation', () => {
    const readPaths = (appId) => [
        `/stats/${appId}`,
        `/trends/${appId}`,
        `/referrers/${appId}`,
        `/browsers/${appId}`,
        `/pages/${appId}`,
        `/views/${appId}`,
        `/sessions/${appId}/some_session`,
    ];

    test.each(readPaths('tenant_b'))(
        "tenant A's key is refused on %s",
        async (path) => {
            await get(path, TENANT_A_KEY).expect(403);
        },
    );

    test.each(readPaths('tenant_a'))(
        "tenant A's key is accepted on its own %s",
        async (path) => {
            await get(path, TENANT_A_KEY).expect(200);
        },
    );

    test.each(readPaths('tenant_b'))(
        'an unscoped key reaches %s',
        async (path) => {
            await get(path, GLOBAL_KEY).expect(200);
        },
    );

    test('a cross-tenant refusal leaks no data', async () => {
        const response = await get('/stats/tenant_b', TENANT_A_KEY).expect(403);

        expect(JSON.stringify(response.body)).not.toContain('totalViews');
        expect(response.body.message).toMatch(/not authorized/i);
    });

    test('an out-of-scope app and a nonexistent app are indistinguishable', async () => {
        // Both 403, so the response cannot be used to enumerate which tenants
        // exist on the instance.
        const outOfScope = await get('/stats/tenant_b', TENANT_A_KEY);
        const nonexistent = await get('/stats/tenant_zzz', TENANT_A_KEY);

        expect(outOfScope.status).toBe(403);
        expect(nonexistent.status).toBe(403);
    });
});

describe('GET /apps is filtered by scope', () => {
    test('a scoped key sees only its own apps', async () => {
        const response = await get('/apps', TENANT_A_KEY).expect(200);

        expect(response.body.apps).toEqual(['tenant_a']);
        expect(response.body.count).toBe(1);
    });

    test('another tenant sees only theirs', async () => {
        const response = await get('/apps', TENANT_B_KEY).expect(200);
        expect(response.body.apps).toEqual(['tenant_b']);
    });

    test('an unscoped key sees every app', async () => {
        const response = await get('/apps', GLOBAL_KEY).expect(200);
        expect(response.body.apps).toEqual(expect.arrayContaining(['tenant_a', 'tenant_b']));
    });

    test('the listing never discloses another tenant', async () => {
        const response = await get('/apps', TENANT_A_KEY).expect(200);
        expect(JSON.stringify(response.body)).not.toContain('tenant_b');
    });
});

describe('Admin tier is separate from the read tier', () => {
    test('a read key, however broadly scoped, cannot provision', async () => {
        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, GLOBAL_KEY)
            .send({ appId: 'newapp' })
            .expect(401);
    });

    test('an admin key cannot be used to read analytics', async () => {
        await get('/stats/tenant_a', ADMIN_KEY).expect(401);
    });

    test('an unauthenticated caller cannot provision', async () => {
        await request(server).post('/apps').send({ appId: 'newapp' }).expect(401);
    });
});

describe('Runtime tenant provisioning', () => {
    test('a newly registered app accepts traffic without a restart', async () => {
        // Not in the allowlist yet.
        await request(server)
            .get('/registerView?appId=fresh_tenant&deviceSize=large')
            .expect(422);

        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'fresh_tenant', origins: ['https://fresh.example'] })
            .expect(200);

        // The validator reads the allowlist per request, so this now passes.
        await request(server)
            .get('/registerView?appId=fresh_tenant&deviceSize=large')
            .set('origin', 'https://fresh.example')
            .expect(200);
    });

    test('registration binds the origins it was given', async () => {
        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'bound_tenant', origins: ['https://bound.example'] })
            .expect(200);

        await request(server)
            .get('/registerView?appId=bound_tenant&deviceSize=large')
            .set('origin', 'https://attacker.example')
            .expect(403);
    });

    test('re-registering is idempotent, not an error', async () => {
        await request(server).post('/apps').set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'repeat_tenant' }).expect(200);

        const second = await request(server).post('/apps').set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'repeat_tenant' }).expect(200);

        expect(second.body.created).toBe(false);
    });

    test.each([
        '_apps',
        '_migrations',
        'bad id',
        'drop`table',
        'a;b',
        '',
        'x'.repeat(65),
    ])('refuses to provision the unsafe appId %j', async (appId) => {
        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId })
            .expect(422);
    });

    test('a provisioned appId never reaches DDL unvalidated', async () => {
        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'ddl_probe' })
            .expect(200);

        const ddl = app.dbManager.pool.queries
            .filter((q) => q.sql.toUpperCase().includes('CREATE TABLE'))
            .map((q) => q.sql)
            .join('\n');

        expect(ddl).toContain('`ddl_probe`');
        expect(ddl).not.toMatch(/DROP\s+TABLE/i);
    });

    test('rejects a non-URL origin', async () => {
        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'origin_probe', origins: ['not-a-url'] })
            .expect(422);
    });
});

describe('scope helpers', () => {
    describe('resolveScope()', () => {
        const scopes = { [TENANT_A_KEY]: ['tenant_a'], [GLOBAL_KEY]: SCOPE_ALL };

        test('returns the scope for a known key', () => {
            expect(resolveScope(TENANT_A_KEY, scopes)).toEqual(['tenant_a']);
            expect(resolveScope(GLOBAL_KEY, scopes)).toBe(SCOPE_ALL);
        });

        test('returns null for an unknown key', () => {
            expect(resolveScope('nope', scopes)).toBeNull();
        });

        test('returns null against an empty map', () => {
            expect(resolveScope(TENANT_A_KEY, {})).toBeNull();
        });
    });

    describe('scopeAllows()', () => {
        test('a wildcard permits anything', () => {
            expect(scopeAllows(SCOPE_ALL, 'anything')).toBe(true);
        });

        test('a list permits only its members', () => {
            expect(scopeAllows(['a'], 'a')).toBe(true);
            expect(scopeAllows(['a'], 'b')).toBe(false);
        });

        test('a malformed scope permits nothing', () => {
            expect(scopeAllows(undefined, 'a')).toBe(false);
            expect(scopeAllows('other', 'a')).toBe(false);
        });
    });

    describe('appsInScope()', () => {
        const all = ['a', 'b', 'c'];

        test('a wildcard yields everything', () => {
            expect(appsInScope(SCOPE_ALL, all)).toEqual(all);
        });

        test('a list intersects with what exists', () => {
            expect(appsInScope(['a', 'zzz'], all)).toEqual(['a']);
        });

        test('a malformed scope yields nothing', () => {
            expect(appsInScope(null, all)).toEqual([]);
        });
    });
});

describe('config is left consistent after provisioning', () => {
    // Self-contained: provisions its own app rather than asserting on state
    // left behind by earlier describes, which made one failure cascade.
    test('the live allowlist gains a newly provisioned app', async () => {
        await request(server)
            .post('/apps')
            .set(API_KEY_HEADER, ADMIN_KEY)
            .send({ appId: 'consistency_tenant' })
            .expect(200);

        expect(config.allowed.appId).toContain('consistency_tenant');
    });
});
