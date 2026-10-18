/**
 * Edge counting through the whole service, as index.js wires it: the
 * app-wide address limit leaves edge reports to their own route, which
 * counts each visitor's address rather than the Worker's, and a report is
 * stored through the real DatabaseManager with nothing of the raw request in
 * the database.
 */

const request = require('supertest');

const { COLLECTED_BY, EDGE } = require('../constants');

jest.mock('mysql2/promise', () => require('./dbMock'));

jest.mock('../config', () => {
    const { EDGE: E, PRIVACY: P } = require('../constants');
    return {
        dbInfo: { mode: 'connect', host: '127.0.0.1', port: 3306, database: 'test', user: 'u', password: 'p' },
        allowed: {
            appId: ['site'],
            deviceSize: ['small', 'medium', 'large'],
            origins: { site: ['https://site.example'] },
        },
        server: {
            port: 3030,
            // Two requests a minute from one address, for everything.
            rateLimit: { windowMs: 60000, max: 2, perAppMax: 0 },
            uniqueVisitorWindowHours: 24,
            nodeEnv: 'test',
            isTest: true,
            isProduction: false,
            logLevel: 'silent',
            trustProxy: false,
            corsOrigins: ['https://site.example'],
        },
        auth: { readKeyScopes: {}, adminApiKeys: [] },
        privacy: { visitorSecret: 'a'.repeat(P.SECRET_BYTES * 2) },
        admin: { enabled: false, password: '', trashRetentionDays: 0 },
        edge: { secret: 'w'.repeat(E.MIN_SECRET_LENGTH), enabled: true },
        validate() { return this; },
    };
});

const app = require('../index');
const { listenOnLoopback } = require('./support/loopback');
const { initializeServer, dbManager } = app;

const SECRET = 'w'.repeat(EDGE.MIN_SECRET_LENGTH);
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 EdgeProbe/1.0';

let server;

beforeAll(async () => {
    await initializeServer();
    server = await listenOnLoopback(app);
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

const report = (ip, url = 'https://site.example/post?utm_source=feed&token=SECRET-TOKEN') => request(server)
    .post(EDGE.PATH)
    .set('Authorization', `Bearer ${SECRET}`)
    .send({ appId: 'site', url, referrer: 'https://news.example/item?id=PRIVATE', ip, userAgent: CHROME, mobile: '?0', acceptLanguage: 'en-GB' });

/** Every statement the mock database saw since `from`. */
const statementsSince = (from) => dbManager.pool.queries.slice(from);

test('reports for many visitors, all from the Worker\'s one address, are not limited as that address', async () => {
    for (let i = 1; i <= 4; i += 1) await report(`198.51.100.${i}`).expect(204);
});

test('one visitor\'s reports are limited by that visitor\'s address', async () => {
    await report('203.0.113.9').expect(204);
    await report('203.0.113.9').expect(204);
    await report('203.0.113.9').expect(429);
});

test('a stored edge view holds the masked address and its side, never the raw request', async () => {
    const from = dbManager.pool.queries.length;
    await report('192.0.2.77').expect(204);
    const statements = statementsSince(from);
    const insert = statements.find((q) => /^\s*INSERT INTO `site`/.test(q.sql));
    expect(insert).toBeDefined();
    expect(insert.params).toContain('192.0.2.0');
    expect(insert.params.at(-1)).toBe(COLLECTED_BY.EDGE);
    expect(insert.params).toContain('/post');
    expect(insert.params).toContain('https://news.example/item');
    const everything = JSON.stringify(statements);
    for (const raw of ['192.0.2.77', 'EdgeProbe', 'SECRET-TOKEN', 'PRIVATE', SECRET]) expect(everything).not.toContain(raw);
    // The view log files it under the edge.
    const log = statements.find((q) => q.sql.includes('INSERT INTO `_view_log`'));
    expect(log.params).toContain('edge');
});

test('of the query, only the parameters the report names as part of the page are kept', async () => {
    const from = dbManager.pool.queries.length;
    await report('192.0.2.88', 'https://site.example/?token=SECRET-TOKEN&post=hello%20world&utm_source=feed')
        .send({ pageQuery: ['post'] }).expect(204);
    const statements = statementsSince(from);
    const insert = statements.find((q) => /^\s*INSERT INTO `site`/.test(q.sql));
    expect(insert.params).toContain('/?post=hello+world');
    expect(insert.params).toContain('feed');
    expect(JSON.stringify(statements)).not.toContain('SECRET-TOKEN');
});

test.each([
    ['a campaign tag', ['utm_source']],
    ['a name with other characters', ['post name']],
    ['not a list', 'post'],
    ['more than ten names', Array.from({ length: 11 }, (_, i) => `p${i}`)],
])('a report naming %s as a page parameter is refused', async (_, pageQuery) => {
    await report('192.0.2.99').send({ pageQuery }).expect(422);
});

test('a burst of unreadable bodies without the secret is refused unread, then limited by the sender\'s address', async () => {
    const malformed = () => request(server).post(EDGE.PATH).set('Content-Type', 'application/json').send('{"appId": ');
    const oversized = () => request(server).post(EDGE.PATH).set('Content-Type', 'application/json')
        .send(JSON.stringify({ appId: 'site', padding: 'x'.repeat(20 * 1024) }));
    // Never parsed: the secret is missing, so the answer is 401, not a parse error.
    await malformed().expect(401);
    await oversized().expect(401);
    // The address's budget for requests without the secret (two a minute here) is gone.
    await malformed().expect(429);
    await oversized().expect(429);
});

test('with the secret, an unreadable body is refused as one', async () => {
    const res = await request(server).post(EDGE.PATH).set('Authorization', `Bearer ${SECRET}`)
        .set('Content-Type', 'application/json').send('{"appId": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Malformed or oversized request' });
    const big = await request(server).post(EDGE.PATH).set('Authorization', `Bearer ${SECRET}`)
        .set('Content-Type', 'application/json').send(JSON.stringify({ appId: 'site', padding: 'x'.repeat(20 * 1024) }));
    expect(big.status).toBe(413);
    // A body that is not JSON is no report.
    await request(server).post(EDGE.PATH).set('Authorization', `Bearer ${SECRET}`).set('Content-Type', 'text/plain')
        .send('appId=site').expect(422);
});

test('everything else is still limited app-wide by the caller\'s own address', async () => {
    // The reports above did not use up this address's budget...
    await request(server).get('/health').expect(200);
    await request(server).get('/health').expect(200);
    // ...which still applies to everything that is not an edge report.
    await request(server).get('/health').expect(429);
});
