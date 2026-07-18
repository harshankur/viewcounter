const request = require('supertest');
const TestDatabase = require('./setup');
const { TEST_API_KEY } = require('./jestSetup');
const { API_KEY_HEADER } = require('../constants');

// Mock mysql2/promise BEFORE importing anything else
jest.mock('mysql2/promise', () => require('./dbMock'));

// Mock the config module
jest.mock('../config', () => {
    const { PRIVACY } = require('../constants');
    return {
        dbInfo: {
            mode: 'connect',
            host: '127.0.0.1',
            port: 3306,
            database: 'viewcounterdb_test',
            user: 'root',
            password: ''
        },
        allowed: {
            appId: ['test_app_1', 'test_app_2'],
            deviceSize: ['small', 'medium', 'large'],
            origins: {}
        },
        server: {
            port: 3030,
            // Deliberately high: a limit low enough to trip partway through the
            // suite makes every later assertion depend on how many requests
            // preceded it. Limiter behaviour is asserted via its headers below.
            rateLimit: { windowMs: 60000, max: 1000000, perAppMax: 0 },
            uniqueVisitorWindowHours: 24,
            nodeEnv: 'test',
            isTest: true,
            isProduction: false,
            logLevel: 'silent',
            trustProxy: false,
            corsOrigins: ['https://allowed.example']
        },
        auth: {
            // Unscoped key: this suite exercises the endpoints, not tenancy.
            readKeyScopes: { ['k'.repeat(PRIVACY.MIN_API_KEY_LENGTH)]: '*' },
            adminApiKeys: [],
        },
        privacy: { visitorSecret: 'a'.repeat(PRIVACY.SECRET_BYTES * 2) },
        validate() { return this; }
    };
});

// Import after mocking config and mysql2
const app = require('../index');
const { initializeServer } = app;

/** Read endpoints require a key; this is the authenticated request helper. */
let server;
const authed = (path) => request(server).get(path).set(API_KEY_HEADER, TEST_API_KEY);

describe('API Endpoints - Integration Tests', () => {
    let testDb;

    beforeAll(async () => {
        testDb = new TestDatabase();
        await testDb.setup();
        await initializeServer();
        // See the note in security.test.js: one listener per suite, not one per
        // request, so ephemeral port reuse cannot misroute an assertion.
        server = app.listen(0);
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
        await testDb.teardown();
    });

    describe('GET /health', () => {
        test('should return healthy status', async () => {
            const response = await request(server).get('/health').expect(200);

            expect(response.body.status).toBe('healthy');
        });

        test('should not disclose database or configuration detail', async () => {
            const response = await request(server).get('/health').expect(200);

            expect(response.body).not.toHaveProperty('database');
            expect(response.body).not.toHaveProperty('mode');
        });
    });

    describe('GET /registerView', () => {
        test('should register a basic view', async () => {
            const response = await request(server)
                .get('/registerView?appId=test_app_1&deviceSize=large')
                .expect(200);

            expect(response.body.message).toBe('Success!');
            expect(response.body.duplicate).toBe(false);
        });

        test('should register view with page tracking', async () => {
            const response = await request(server)
                .get('/registerView?appId=test_app_1&deviceSize=medium&page=/blog&title=My%20Blog')
                .expect(200);

            expect(response.body).toHaveProperty('duplicate');
        });

        test('should register view with referrer', async () => {
            const response = await request(server)
                .get('/registerView?appId=test_app_1&deviceSize=small&referrer=https://google.com/search')
                .expect(200);

            expect(response.body).toHaveProperty('duplicate');
        });

        test('should reject an unknown appId', async () => {
            await request(server)
                .get('/registerView?appId=not_a_real_app&deviceSize=large')
                .expect(422);
        });

        test('should reject an invalid deviceSize', async () => {
            await request(server)
                .get('/registerView?appId=test_app_1&deviceSize=enormous')
                .expect(422);
        });
    });

    describe('POST /event', () => {
        test('should track custom event', async () => {
            const response = await request(server)
                .post('/event')
                .send({
                    appId: 'test_app_1',
                    eventType: 'button_click',
                    eventData: { button: 'subscribe' },
                    sessionId: 'sess_1'
                })
                .expect(200);

            expect(response.body.message).toBe('Event tracked successfully');
        });

        test('should reject a missing eventType', async () => {
            await request(server)
                .post('/event')
                .send({ appId: 'test_app_1' })
                .expect(422);
        });

        test('should reject an unknown appId', async () => {
            await request(server)
                .post('/event')
                .send({ appId: 'nope', eventType: 'click' })
                .expect(422);
        });
    });

    describe('Read API authentication', () => {
        const readPaths = [
            '/stats/test_app_1',
            '/trends/test_app_1',
            '/referrers/test_app_1',
            '/browsers/test_app_1',
            '/pages/test_app_1',
            '/views/test_app_1',
            '/sessions/test_app_1/sess_1',
            '/apps'
        ];

        test.each(readPaths)('%s rejects an unauthenticated request', async (path) => {
            await request(server).get(path).expect(401);
        });

        test.each(readPaths)('%s rejects a wrong key', async (path) => {
            await request(server).get(path).set(API_KEY_HEADER, 'wrong-key').expect(401);
        });
    });

    describe('GET /stats/:appId', () => {
        test('should return statistics', async () => {
            const response = await authed('/stats/test_app_1').expect(200);

            expect(response.body.appId).toBe('test_app_1');
            expect(response.body.stats).toHaveProperty('totalViews');
            expect(response.body.stats).toHaveProperty('uniqueVisitors');
        });

        test('should reject invalid appId', async () => {
            await authed('/stats/invalid_app').expect(422);
        });
    });

    describe('GET /trends/:appId', () => {
        test('should return daily trends', async () => {
            const response = await authed('/trends/test_app_1?period=daily&days=7').expect(200);

            expect(response.body.period).toBe('daily');
            expect(Array.isArray(response.body.trends)).toBe(true);
        });

        test('should return hourly trends', async () => {
            const response = await authed('/trends/test_app_1?period=hourly').expect(200);
            expect(response.body.period).toBe('hourly');
        });

        test('should reject invalid period', async () => {
            await authed('/trends/test_app_1?period=yearly').expect(422);
        });
    });

    describe('GET /referrers/:appId', () => {
        test('should return referrer statistics', async () => {
            const response = await authed('/referrers/test_app_1').expect(200);

            expect(response.body).toHaveProperty('bySource');
            expect(response.body).toHaveProperty('byDomain');
        });

        test('should respect limit parameter', async () => {
            await authed('/referrers/test_app_1?limit=5').expect(200);
        });
    });

    describe('GET /browsers/:appId', () => {
        test('should return browser statistics', async () => {
            const response = await authed('/browsers/test_app_1').expect(200);

            expect(response.body).toHaveProperty('byBrowser');
            expect(response.body).toHaveProperty('byOS');
        });
    });

    describe('GET /pages/:appId', () => {
        test('should return page statistics', async () => {
            const response = await authed('/pages/test_app_1').expect(200);
            expect(Array.isArray(response.body.pages)).toBe(true);
        });

        test('should respect limit parameter', async () => {
            await authed('/pages/test_app_1?limit=5').expect(200);
        });
    });

    describe('GET /sessions/:appId/:sessionId', () => {
        test('should return session details', async () => {
            const response = await authed('/sessions/test_app_1/sess_1').expect(200);

            expect(response.body.sessionId).toBe('sess_1');
            expect(Array.isArray(response.body.events)).toBe(true);
        });
    });

    describe('GET /views/:appId', () => {
        test('should return recent views', async () => {
            const response = await authed('/views/test_app_1').expect(200);

            expect(Array.isArray(response.body.views)).toBe(true);
            expect(response.body).toHaveProperty('total');
        });

        test('should support pagination', async () => {
            const response = await authed('/views/test_app_1?limit=5&offset=10').expect(200);

            expect(response.body.limit).toBe(5);
            expect(response.body.offset).toBe(10);
        });
    });

    describe('GET /apps', () => {
        test('should list all apps when authenticated', async () => {
            const response = await authed('/apps').expect(200);

            expect(response.body.apps).toContain('test_app_1');
            expect(response.body.count).toBe(2);
        });
    });

    describe('Removed debug surface', () => {
        test('GET /ip no longer exists', async () => {
            await request(server).get('/ip').expect(404);
        });
    });

    describe('Response headers', () => {
        test('read endpoints are marked uncacheable', async () => {
            const response = await authed('/stats/test_app_1').expect(200);

            expect(response.headers['cache-control']).toContain('no-store');
        });

        test('a request id is returned for correlation', async () => {
            const response = await request(server).get('/health').expect(200);

            expect(response.headers['x-request-id']).toBeDefined();
        });

        test('the server does not advertise its framework', async () => {
            const response = await request(server).get('/health');

            expect(response.headers['x-powered-by']).toBeUndefined();
        });
    });

    describe('Rate Limiting', () => {
        test('should expose standard rate limit headers', async () => {
            const response = await request(server)
                .get('/registerView?appId=test_app_1&deviceSize=large');

            expect(response.headers['ratelimit-limit']).toBeDefined();
        });
    });
});
