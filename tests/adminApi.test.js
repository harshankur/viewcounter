/**
 * Admin API, end to end over HTTP: the real router, session store, CSRF
 * checks, validation, and admin-log recording, with in-memory repositories.
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const {
    ADMIN,
    ADMIN_ACTION,
    ADMIN_ERROR_CODE,
    VIEW_LOG_SOURCE,
} = require('../constants');
const { createAdminRouter } = require('../routes/admin');
const { createSessionStore } = require('../middleware/adminAuth');
const { createMemoryRepos, makeView } = require('./support/memoryRepos');
const logger = require('../utils/logger');

const PASSWORD = 'correct horse battery staple';
const APP = 'blog';
const OTHER_APP = 'shop';

function buildConfig(overrides = {}) {
    return {
        allowed: { appId: [APP, OTHER_APP], deviceSize: ['small', 'medium', 'large'], origins: {} },
        server: { isProduction: false },
        admin: { enabled: true, password: PASSWORD, trashRetentionDays: 30, viewLogRetentionDays: 90 },
        ...overrides,
    };
}

function buildApp({ config = buildConfig(), repos, sessionStore } = {}) {
    const app = express();
    app.set('trust proxy', false);
    app.use(ADMIN.PATH_PREFIX, createAdminRouter({
        config,
        adminRepo: repos.adminRepo,
        logRepo: repos.logRepo,
        sessionStore,
    }));
    return app;
}

const API = `${ADMIN.PATH_PREFIX}${ADMIN.API_PATH}`;

/** Log in and return an agent carrying the cookie plus the CSRF token. */
async function login(app) {
    const agent = request.agent(app);
    const res = await agent.post(`${API}/login`).send({ password: PASSWORD }).expect(200);
    return { agent, csrf: res.body.csrfToken, res };
}

describe('Admin API', () => {
    let repos;
    let app;
    let views;

    beforeEach(() => {
        views = [
            makeView({ pagePath: '/a', pageTitle: 'Alpha', timestamp: new Date('2026-09-01T10:00:00Z') }),
            makeView({ pagePath: '/b', pageTitle: 'Beta', timestamp: new Date('2026-09-02T10:00:00Z') }),
            makeView({ pagePath: '/c', pageTitle: 'Gamma', timestamp: new Date('2026-09-03T10:00:00Z') }),
        ];
        repos = createMemoryRepos({ views: { [APP]: views, [OTHER_APP]: [makeView()] } });
        app = buildApp({ repos });
    });

    describe('static UI', () => {
        test('redirects the bare mount path to a trailing slash', async () => {
            const res = await request(app).get(ADMIN.PATH_PREFIX).expect(302);
            expect(res.headers.location).toBe(`${ADMIN.PATH_PREFIX}/`);
        });

        test('keeps the query string when redirecting', async () => {
            const res = await request(app).get(`${ADMIN.PATH_PREFIX}?tab=trash`).expect(302);
            expect(res.headers.location).toBe(`${ADMIN.PATH_PREFIX}/?tab=trash`);
        });

        test('serves the UI shell with a strict CSP and noindex', async () => {
            const res = await request(app).get(`${ADMIN.PATH_PREFIX}/`).expect(200);
            expect(res.headers['content-type']).toContain('text/html');
            const csp = res.headers['content-security-policy'];
            expect(csp).toContain("script-src 'self'");
            expect(csp).toContain("style-src 'self'");
            expect(csp).toContain("frame-ancestors 'none'");
            expect(csp).not.toContain('unsafe-inline');
            expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
            expect(res.headers['referrer-policy']).toBe('no-referrer');
        });

        test('does not serve dotfiles', async () => {
            await request(app).get(`${ADMIN.PATH_PREFIX}/.env`).expect(404);
        });
    });

    describe('authentication', () => {
        test('reports no session before login', async () => {
            const res = await request(app).get(`${API}/session`).expect(200);
            expect(res.body).toEqual({ authenticated: false });
        });

        test('a wrong password is refused and logged', async () => {
            const res = await request(app).post(`${API}/login`).send({ password: 'nope' }).expect(401);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.INVALID_PASSWORD);
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.LOGIN_FAILED);
            expect(repos.adminLog[0].sessionId).toBeNull();
        });

        test('a missing password is a validation failure', async () => {
            const res = await request(app).post(`${API}/login`).send({}).expect(422);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.VALIDATION_FAILED);
        });

        test('an over-long password is refused before comparison', async () => {
            await request(app).post(`${API}/login`)
                .send({ password: 'x'.repeat(ADMIN.MAX_PASSWORD_INPUT_LENGTH + 1) })
                .expect(422);
        });

        test('a cross-origin login is refused', async () => {
            const res = await request(app).post(`${API}/login`)
                .set('Origin', 'https://attacker.example')
                .send({ password: PASSWORD })
                .expect(403);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.CSRF_REJECTED);
        });

        test('a refused origin is logged with the origin the server expected', async () => {
            const lines = [];
            logger.configure({ level: logger.LogLevel.DEBUG, writer: (line) => lines.push(line) });
            try {
                await request(app).post(`${API}/login`)
                    .set('Host', 'views.example.com')
                    .set('Origin', 'https://views.example.com')
                    .send({ password: PASSWORD })
                    .expect(403);
            } finally {
                logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} });
            }
            // Plain HTTP reached the server while the browser was on HTTPS: the
            // TLS-terminating-proxy case, spelled out in the log.
            const warning = lines.find((line) => line.includes('ADMIN_ORIGIN_REJECTED'));
            expect(warning).toContain("'https://views.example.com'");
            expect(warning).toContain("expected 'http://views.example.com'");
            expect(warning).toContain('TRUST_PROXY');
        });

        test('only wrong passwords count toward the login limit', async () => {
            for (let i = 0; i < ADMIN.LOGIN_RATE_LIMIT_MAX + 2; i++) {
                await request(app).post(`${API}/login`)
                    .set('Origin', 'https://attacker.example')
                    .send({ password: 'wrong' })
                    .expect(403);
                await request(app).post(`${API}/login`).send({}).expect(422);
            }
            await login(app);
        });

        test('the correct password starts a session with a hardened cookie', async () => {
            const { res, csrf } = await login(app);
            const cookie = res.headers['set-cookie'][0];
            expect(cookie).toContain(`${ADMIN.SESSION_COOKIE}=`);
            expect(cookie).toContain('HttpOnly');
            expect(cookie).toContain('SameSite=Strict');
            expect(cookie).toContain(`Path=${ADMIN.PATH_PREFIX}`);
            expect(csrf).toEqual(expect.any(String));
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.LOGIN_SUCCEEDED);
            expect(repos.adminLog[0].sessionId).toEqual(expect.any(String));
        });

        test('the cookie is not Secure over plain HTTP, so local development works', async () => {
            const { res } = await login(app);
            expect(res.headers['set-cookie'][0]).not.toContain('Secure');
        });

        test('the cookie is Secure when the request arrived over HTTPS', async () => {
            const secureApp = express();
            secureApp.set('trust proxy', 1);
            secureApp.use(ADMIN.PATH_PREFIX, createAdminRouter({
                config: buildConfig(), adminRepo: repos.adminRepo, logRepo: repos.logRepo,
            }));
            const res = await request(secureApp).post(`${API}/login`)
                .set('X-Forwarded-Proto', 'https')
                .send({ password: PASSWORD })
                .expect(200);
            expect(res.headers['set-cookie'][0]).toContain('Secure');
        });

        test('a logged-in session reports itself with its CSRF token', async () => {
            const { agent, csrf } = await login(app);
            const res = await agent.get(`${API}/session`).expect(200);
            expect(res.body).toEqual({ authenticated: true, csrfToken: csrf });
        });

        test('logging in again replaces the previous session', async () => {
            const sessionStore = createSessionStore();
            const appWithStore = buildApp({ repos, sessionStore });
            const { agent } = await login(appWithStore);
            await agent.post(`${API}/login`).send({ password: PASSWORD }).expect(200);
            expect(sessionStore.size).toBe(1);
        });

        test('logout ends the session, clears the cookie, and is logged', async () => {
            const { agent, csrf } = await login(app);
            const res = await agent.post(`${API}/logout`).set(ADMIN.CSRF_HEADER, csrf).expect(204);
            expect(res.headers['set-cookie'][0]).toMatch(new RegExp(`${ADMIN.SESSION_COOKIE}=;`));
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.LOGOUT);

            const after = await agent.get(`${API}/session`).expect(200);
            expect(after.body.authenticated).toBe(false);
            await agent.get(`${API}/apps`).expect(401);
        });

        test('the router refuses a password shorter than the standalone server accepts', () => {
            for (const password of [undefined, '', 'x'.repeat(ADMIN.MIN_PASSWORD_LENGTH - 1)]) {
                expect(() => createAdminRouter({
                    config: buildConfig({ admin: { enabled: true, password, trashRetentionDays: 30 } }),
                    adminRepo: repos.adminRepo,
                    logRepo: repos.logRepo,
                })).toThrow(`Invalid configuration for 'admin.password': must be at least ${ADMIN.MIN_PASSWORD_LENGTH} characters`);
            }
        });

        test('the session cookie follows the mount path when another app embeds the router', async () => {
            const host = express();
            host.set('trust proxy', false);
            host.use('/dashboard', createAdminRouter({ config: buildConfig(), adminRepo: repos.adminRepo, logRepo: repos.logRepo }));
            const agent = request.agent(host);
            const res = await agent.post('/dashboard/api/login').send({ password: PASSWORD }).expect(200);
            expect(res.headers['set-cookie'][0]).toContain('Path=/dashboard;');
            // The agent's jar honours cookie paths, so this proves the browser would send it.
            await agent.get('/dashboard/api/apps').expect(200);
        });

        test('failed logins are rate limited', async () => {
            for (let i = 0; i < ADMIN.LOGIN_RATE_LIMIT_MAX; i++) {
                await request(app).post(`${API}/login`).send({ password: 'wrong' }).expect(401);
            }
            const res = await request(app).post(`${API}/login`).send({ password: PASSWORD }).expect(429);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.TOO_MANY_ATTEMPTS);
        });

        test('an expired session is refused', async () => {
            let clock = 0;
            const sessionStore = createSessionStore({ now: () => clock });
            const appWithStore = buildApp({ repos, sessionStore });
            const { agent } = await login(appWithStore);
            clock += ADMIN.SESSION_IDLE_TIMEOUT_MS + 1;
            await agent.get(`${API}/apps`).expect(401);
        });

        test.each([
            ['get', '/meta'],
            ['get', '/apps'],
            ['get', `/apps/${APP}/views`],
            ['patch', `/apps/${APP}/views`],
            ['put', `/apps/${APP}/views/note`],
            ['post', `/apps/${APP}/views/delete`],
            ['post', `/apps/${APP}/views/restore`],
            ['post', `/apps/${APP}/views/purge`],
            ['get', '/logs/admin'],
            ['get', '/logs/views'],
            ['post', '/logout'],
        ])('%s %s requires a session', async (method, path) => {
            const res = await request(app)[method](`${API}${path}`).send({}).expect(401);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.UNAUTHENTICATED);
        });
    });

    describe('CSRF', () => {
        test('a mutation without the CSRF header is refused', async () => {
            const { agent } = await login(app);
            const res = await agent.post(`${API}/apps/${APP}/views/delete`).send({ ids: [views[0].id] }).expect(403);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.CSRF_REJECTED);
            expect(views[0].deletedAt).toBeNull();
        });

        test('a mutation with a wrong CSRF token is refused', async () => {
            const { agent } = await login(app);
            await agent.post(`${API}/apps/${APP}/views/delete`)
                .set(ADMIN.CSRF_HEADER, 'forged')
                .send({ ids: [views[0].id] })
                .expect(403);
        });

        test('a mutation from another origin is refused even with the token', async () => {
            const { agent, csrf } = await login(app);
            await agent.post(`${API}/apps/${APP}/views/delete`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .set('Origin', 'https://attacker.example')
                .send({ ids: [views[0].id] })
                .expect(403);
        });
    });

    describe('reference data', () => {
        test('meta describes limits and allowlists for the UI', async () => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/meta`).expect(200);
            expect(res.body).toMatchObject({
                deviceSizes: ['small', 'medium', 'large'],
                maxBatchIds: ADMIN.MAX_BATCH_IDS,
                pageSizes: ADMIN.PAGE_SIZES,
                trashRetentionDays: 30,
                viewLogRetentionDays: 90,
            });
            expect(res.body.editableFields).not.toContain('maskedIp');
            expect(res.body.actions).toContain(ADMIN_ACTION.VIEWS_PURGED);
            expect(res.body.sources).toEqual(Object.values(VIEW_LOG_SOURCE));
        });

        test('apps lists every configured app with counts', async () => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/apps`).expect(200);
            expect(res.body.apps).toEqual([
                { appId: APP, active: 3, deleted: 0, modified: 0, available: true },
                { appId: OTHER_APP, active: 1, deleted: 0, modified: 0, available: true },
            ]);
        });

        test('responses are never cacheable', async () => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/apps`).expect(200);
            expect(res.headers['cache-control']).toContain('no-store');
        });

        test('an unknown API route is a JSON 404', async () => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/nope`).expect(404);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.NOT_FOUND);
        });

        test('a malformed JSON body gets the admin error shape', async () => {
            const { agent, csrf } = await login(app);
            const res = await agent.post(`${API}/apps/${APP}/views/delete`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .set('Content-Type', 'application/json')
                .send('{not json')
                .expect(400);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.VALIDATION_FAILED);
        });

        test('the API answers 503 until the server is ready', async () => {
            const notReady = express();
            notReady.use(ADMIN.PATH_PREFIX, createAdminRouter({
                config: buildConfig(), adminRepo: repos.adminRepo, logRepo: repos.logRepo, isReady: () => false,
            }));
            await request(notReady).get(`${API}/session`).expect(503);
        });
    });

    describe('listing views', () => {
        test('defaults to active rows, newest first', async () => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/apps/${APP}/views`).expect(200);
            expect(res.body.total).toBe(3);
            expect(res.body.views.map((v) => v.pagePath)).toEqual(['/c', '/b', '/a']);
            expect(res.body).toMatchObject({ status: 'active', modified: 'any', sort: 'timestamp', order: 'desc', page: 1 });
        });

        test('sorts, searches, and paginates', async () => {
            const { agent } = await login(app);
            const sorted = await agent.get(`${API}/apps/${APP}/views?sort=page&order=asc&pageSize=25`).expect(200);
            expect(sorted.body.views.map((v) => v.pagePath)).toEqual(['/a', '/b', '/c']);

            const searched = await agent.get(`${API}/apps/${APP}/views?search=gam`).expect(200);
            expect(searched.body.views.map((v) => v.pageTitle)).toEqual(['Gamma']);
        });

        test('never returns the internal row number or the visitor hash', async () => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/apps/${APP}/views`).expect(200);
            for (const view of res.body.views) {
                expect(view).not.toHaveProperty('visitorHash');
                expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
            }
        });

        test.each([
            ['status=everything'],
            ['modified=sometimes'],
            ['sort=visitor_hash'],
            ['order=sideways'],
            ['page=0'],
            ['pageSize=7'],
            [`search=${'x'.repeat(ADMIN.SEARCH_MAX_LENGTH + 1)}`],
        ])('rejects an invalid listing parameter: %s', async (query) => {
            const { agent } = await login(app);
            const res = await agent.get(`${API}/apps/${APP}/views?${query}`).expect(422);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.VALIDATION_FAILED);
        });

        test('rejects an app that is not configured', async () => {
            const { agent } = await login(app);
            await agent.get(`${API}/apps/not_an_app/views`).expect(422);
        });
    });

    describe('editing', () => {
        test('edits content fields, marks rows modified, and logs field names only', async () => {
            const { agent, csrf } = await login(app);
            const res = await agent.patch(`${API}/apps/${APP}/views`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id, views[1].id], changes: { pageTitle: 'Renamed', deviceSize: 'small' } })
                .expect(200);

            expect(res.body.affected).toBe(2);
            expect(views[0].pageTitle).toBe('Renamed');
            expect(views[1].deviceSize).toBe('small');
            expect(views[0].adminModifiedAt).toBeInstanceOf(Date);
            expect(views[2].adminModifiedAt).toBeNull();

            const entry = repos.adminLog[0];
            expect(entry).toMatchObject({
                action: ADMIN_ACTION.VIEWS_EDITED,
                appId: APP,
                targetIds: [views[0].id, views[1].id],
                fields: ['pageTitle', 'deviceSize'],
            });
            expect(JSON.stringify(entry)).not.toContain('Renamed');
        });

        test('a referrer edit re-derives its domain and source', async () => {
            const { agent, csrf } = await login(app);
            await agent.patch(`${API}/apps/${APP}/views`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id], changes: { referrer: 'https://www.google.com/search?q=x' } })
                .expect(200);
            expect(views[0]).toMatchObject({ referrerDomain: 'www.google.com', sourceType: 'search' });
        });

        test.each([
            [{ maskedIp: '1.2.3.4' }],
            [{ visitorHash: 'abc' }],
            [{ timestamp: '2020-01-01' }],
            [{ country: 'US' }],
            [{ browser: 'Lynx' }],
            [{ referrerDomain: 'evil.example' }],
            [{ sourceType: 'search' }],
            [{ deviceSize: 'gigantic' }],
            [{ eventType: '' }],
            [{ pageTitle: 42 }],
            [{ pageTitle: 'x'.repeat(1000) }],
            [{}],
            [null],
        ])('refuses an edit that is not a valid content change: %j', async (changes) => {
            const { agent, csrf } = await login(app);
            const res = await agent.patch(`${API}/apps/${APP}/views`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id], changes })
                .expect(422);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.VALIDATION_FAILED);
            expect(views[0].adminModifiedAt).toBeNull();
        });

        test('a trashed row is not editable', async () => {
            views[0].deletedAt = new Date();
            const { agent, csrf } = await login(app);
            const res = await agent.patch(`${API}/apps/${APP}/views`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id], changes: { pageTitle: 'x' } })
                .expect(200);
            expect(res.body.affected).toBe(0);
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.LOGIN_SUCCEEDED);
        });
    });

    describe('batch ids', () => {
        test.each([
            ['an empty list', []],
            ['a non-UUID', ['1']],
            ['a repeated id', ['0b8c3c1e-3b1c-4f2c-9d4e-1a2b3c4d5e6f', '0b8c3c1e-3b1c-4f2c-9d4e-1a2b3c4d5e6f']],
            ['too many ids', Array.from({ length: ADMIN.MAX_BATCH_IDS + 1 }, () => crypto.randomUUID())],
            ['not an array', 'all'],
        ])('refuses %s', async (_label, ids) => {
            const { agent, csrf } = await login(app);
            await agent.post(`${API}/apps/${APP}/views/delete`).set(ADMIN.CSRF_HEADER, csrf).send({ ids }).expect(422);
        });

        test('ids from another app are not touched', async () => {
            const { agent, csrf } = await login(app);
            const res = await agent.post(`${API}/apps/${OTHER_APP}/views/delete`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id] })
                .expect(200);
            expect(res.body.affected).toBe(0);
            expect(views[0].deletedAt).toBeNull();
        });
    });

    describe('notes', () => {
        test('sets a note on several rows without marking them modified', async () => {
            const { agent, csrf } = await login(app);
            await agent.put(`${API}/apps/${APP}/views/note`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id, views[1].id], note: 'bot traffic' })
                .expect(200);
            expect(views[0].note).toBe('bot traffic');
            expect(views[0].adminModifiedAt).toBeNull();
            expect(repos.adminLog[0]).toMatchObject({ action: ADMIN_ACTION.NOTE_SET, targetIds: [views[0].id, views[1].id] });
            expect(JSON.stringify(repos.adminLog[0])).not.toContain('bot traffic');
        });

        test.each([[null], [''], ['   ']])('clears the note when given %j', async (note) => {
            views[0].note = 'old';
            const { agent, csrf } = await login(app);
            await agent.put(`${API}/apps/${APP}/views/note`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id], note })
                .expect(200);
            expect(views[0].note).toBeNull();
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.NOTE_CLEARED);
        });

        test('refuses an over-long note', async () => {
            const { agent, csrf } = await login(app);
            await agent.put(`${API}/apps/${APP}/views/note`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id], note: 'n'.repeat(1001) })
                .expect(422);
        });

        test('refuses a non-string note', async () => {
            const { agent, csrf } = await login(app);
            await agent.put(`${API}/apps/${APP}/views/note`)
                .set(ADMIN.CSRF_HEADER, csrf)
                .send({ ids: [views[0].id], note: 5 })
                .expect(422);
        });
    });

    describe('delete, restore, purge', () => {
        const post = (agent, csrf, action, ids) =>
            agent.post(`${API}/apps/${APP}/views/${action}`).set(ADMIN.CSRF_HEADER, csrf).send({ ids });

        test('delete is soft: the row moves to the trash', async () => {
            const { agent, csrf } = await login(app);
            const res = await post(agent, csrf, 'delete', [views[0].id]).expect(200);
            expect(res.body).toEqual({ affected: 1, ids: [views[0].id] });
            expect(views[0].deletedAt).toBeInstanceOf(Date);

            const active = await agent.get(`${API}/apps/${APP}/views`).expect(200);
            expect(active.body.total).toBe(2);
            const trash = await agent.get(`${API}/apps/${APP}/views?status=deleted`).expect(200);
            expect(trash.body.views.map((v) => v.id)).toEqual([views[0].id]);
            const all = await agent.get(`${API}/apps/${APP}/views?status=all`).expect(200);
            expect(all.body.total).toBe(3);
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.VIEWS_DELETED);
        });

        test('restore brings a row back', async () => {
            views[0].deletedAt = new Date();
            const { agent, csrf } = await login(app);
            await post(agent, csrf, 'restore', [views[0].id]).expect(200);
            expect(views[0].deletedAt).toBeNull();
            expect(repos.adminLog[0].action).toBe(ADMIN_ACTION.VIEWS_RESTORED);
        });

        test('purge erases only rows already in the trash', async () => {
            views[0].deletedAt = new Date();
            const { agent, csrf } = await login(app);
            const res = await post(agent, csrf, 'purge', [views[0].id, views[1].id]).expect(200);
            expect(res.body).toEqual({ affected: 1, ids: [views[0].id] });
            expect(repos.tables.get(APP).map((v) => v.id)).toEqual([views[1].id, views[2].id]);
            expect(repos.adminLog[0]).toMatchObject({ action: ADMIN_ACTION.VIEWS_PURGED, targetIds: [views[0].id] });
        });

        test('an operation that changes nothing is not logged', async () => {
            const { agent, csrf } = await login(app);
            const before = repos.adminLog.length;
            await post(agent, csrf, 'restore', [views[0].id]).expect(200);
            expect(repos.adminLog.length).toBe(before);
        });
    });

    describe('logs', () => {
        test('the admin log lists newest first and filters by action and app', async () => {
            const { agent, csrf } = await login(app);
            await agent.post(`${API}/apps/${APP}/views/delete`).set(ADMIN.CSRF_HEADER, csrf).send({ ids: [views[0].id] });

            const all = await agent.get(`${API}/logs/admin`).expect(200);
            expect(all.body.entries.map((e) => e.action)).toEqual([ADMIN_ACTION.VIEWS_DELETED, ADMIN_ACTION.LOGIN_SUCCEEDED]);

            const filtered = await agent.get(`${API}/logs/admin?action=${ADMIN_ACTION.VIEWS_DELETED}&appId=${APP}`).expect(200);
            expect(filtered.body.total).toBe(1);
        });

        test('the view log lists entries and filters by source', async () => {
            await repos.logRepo.writeViewLog({ appId: APP, source: VIEW_LOG_SOURCE.REGISTER_VIEW, viewId: views[0].id, eventType: 'pageview', isUnique: true });
            await repos.logRepo.writeViewLog({ appId: APP, source: VIEW_LOG_SOURCE.EVENT, viewId: views[1].id, eventType: 'click', isUnique: true });
            const { agent } = await login(app);

            const all = await agent.get(`${API}/logs/views`).expect(200);
            expect(all.body.total).toBe(2);
            const events = await agent.get(`${API}/logs/views?source=${VIEW_LOG_SOURCE.EVENT}`).expect(200);
            expect(events.body.entries.map((e) => e.eventType)).toEqual(['click']);
        });

        test.each([
            ['/logs/admin?action=hacked'],
            ['/logs/admin?appId=nope'],
            ['/logs/views?source=carrier-pigeon'],
            ['/logs/views?pageSize=1000'],
        ])('rejects an invalid log filter: %s', async (path) => {
            const { agent } = await login(app);
            await agent.get(`${API}${path}`).expect(422);
        });
    });

    describe('failures', () => {
        test('a repository failure becomes a stable 500 without detail', async () => {
            repos.adminRepo.summarizeApps = async () => { throw new TypeError('secret table detail'); };
            const { agent } = await login(app);
            const res = await agent.get(`${API}/apps`).expect(500);
            expect(res.body.code).toBe(ADMIN_ERROR_CODE.SERVER_ERROR);
            expect(JSON.stringify(res.body)).not.toContain('secret table detail');
        });

        test.each([
            ['patch', `/apps/${APP}/views`, 'updateContent', { changes: { pageTitle: 'x' } }],
            ['put', `/apps/${APP}/views/note`, 'setNote', { note: 'x' }],
            ['post', `/apps/${APP}/views/delete`, 'softDelete', {}],
            ['get', `/apps/${APP}/views`, 'listViews', null],
        ])('%s %s reports a repository failure as 500', async (method, path, operation, extra) => {
            repos.adminRepo[operation] = async () => { throw new TypeError('boom'); };
            const { agent, csrf } = await login(app);
            let req = agent[method](`${API}${path}`).set(ADMIN.CSRF_HEADER, csrf);
            if (extra) req = req.send({ ids: [views[0].id], ...extra });
            await req.expect(500);
        });

        test.each([['listAdminLog', '/logs/admin'], ['listViewLog', '/logs/views']])(
            '%s failure is a 500', async (operation, path) => {
                repos.logRepo[operation] = async () => { throw new TypeError('boom'); };
                const { agent } = await login(app);
                await agent.get(`${API}${path}`).expect(500);
            });

        test('a login that fails internally is a 500', async () => {
            repos.logRepo.writeAdminLog = async () => { throw new TypeError('boom'); };
            await request(app).post(`${API}/login`).send({ password: PASSWORD }).expect(500);
        });

        test('a logout that fails internally is a 500', async () => {
            const { agent, csrf } = await login(app);
            repos.logRepo.writeAdminLog = async () => { throw new TypeError('boom'); };
            await agent.post(`${API}/logout`).set(ADMIN.CSRF_HEADER, csrf).expect(500);
        });
    });
});
