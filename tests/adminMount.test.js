/**
 * How index.js mounts the admin surface when ADMIN_PASSWORD is configured.
 * The disabled case (no route at all) is asserted in security.test.js.
 */

const request = require('supertest');

jest.mock('mysql2/promise', () => require('./dbMock'));

jest.mock('../config', () => {
    const { PRIVACY } = require('../constants');
    return {
        dbInfo: { mode: 'connect', host: '127.0.0.1', port: 3306, database: 'd', user: 'u', password: 'p' },
        allowed: { appId: ['test_app_1'], deviceSize: ['small', 'medium', 'large'], origins: {} },
        server: {
            port: 3030,
            rateLimit: { windowMs: 60000, max: 1000000, perAppMax: 0 },
            uniqueVisitorWindowHours: 24,
            nodeEnv: 'test',
            isTest: true,
            isProduction: false,
            logLevel: 'silent',
            trustProxy: false,
            corsOrigins: ['https://tracked.example'],
        },
        auth: { readKeyScopes: {}, adminApiKeys: [] },
        privacy: { visitorSecret: 'a'.repeat(PRIVACY.SECRET_BYTES * 2) },
        admin: { enabled: true, password: 'mount-test-password-123', trashRetentionDays: 0 },
        validate() { return this; },
    };
});

const app = require('../index');
const { ADMIN } = require('../constants');

const API = `${ADMIN.PATH_PREFIX}${ADMIN.API_PATH}`;

describe('admin surface mounted by index.js', () => {
    let server;

    beforeAll(async () => {
        await app.initializeServer();
        server = app.listen(0);
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    test('the admin API answers once a password is configured', async () => {
        const res = await request(server).get(`${API}/session`).expect(200);
        expect(res.body).toEqual({ authenticated: false });
    });

    test('logging in works through the real app', async () => {
        const res = await request(server).post(`${API}/login`)
            .send({ password: 'mount-test-password-123' })
            .expect(200);
        expect(res.body.authenticated).toBe(true);
    });

    test('admin responses never carry the tracked sites\' CORS headers', async () => {
        const res = await request(server).get(`${API}/session`)
            .set('Origin', 'https://tracked.example')
            .expect(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('the public API is unaffected and still sends CORS to tracked sites', async () => {
        const res = await request(server).get('/health').set('Origin', 'https://tracked.example');
        expect(res.headers['access-control-allow-origin']).toBe('https://tracked.example');
    });

    test('createAdminRouter is exported for embedders', () => {
        expect(typeof app.createAdminRouter).toBe('function');
    });
});
