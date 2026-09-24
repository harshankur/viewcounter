/**
 * Every-app listings and the insights analysis: the SQL the repository
 * issues, and the API routes over it.
 */

const express = require('express');
const request = require('supertest');

const AdminRepository = require('../db/AdminRepository');
const { ADMIN, ADMIN_ERROR_CODE, ANALYSIS_TOP_N, TREND_BUCKET } = require('../constants');
const { createAdminRouter } = require('../routes/admin');
const { createScriptedPool, dbWith } = require('./support/scriptedPool');
const { createMemoryRepos, makeView } = require('./support/memoryRepos');

const DAY = 24 * 60 * 60 * 1000;
const baseQuery = { status: 'active', modified: 'any', search: '', range: 'all', eventType: '', sort: 'timestamp', order: 'desc', page: 1, pageSize: 25 };

describe('buildFilter', () => {
    const { buildFilter } = AdminRepository;

    test.each([
        ['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365],
    ])('range %s keeps the last %d days, bound as a parameter', (range, days) => {
        const { clause, params } = buildFilter({ range });
        expect(clause).toContain('timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)');
        expect(params).toEqual([days]);
    });

    test.each([['all'], [undefined], ['bogus']])('range %s adds no time bound', (range) => {
        expect(buildFilter({ range }).clause).not.toContain('INTERVAL');
    });

    test('an event type is matched exactly and bound', () => {
        const { clause, params } = buildFilter({ eventType: "click' OR 1=1" });
        expect(clause).toContain('event_type = ?');
        expect(clause).not.toContain('OR 1=1');
        expect(params).toEqual(["click' OR 1=1"]);
    });

    test('filters combine in a fixed order: event type, range, then search', () => {
        const { params } = buildFilter({ eventType: 'click', range: '7d', search: 'x' });
        expect(params.slice(0, 3)).toEqual(['click', 7, 'x']);
    });
});

describe('chooseBucket', () => {
    const { chooseBucket } = AdminRepository;
    const start = new Date('2026-01-01T00:00:00Z');
    const after = (days) => new Date(start.getTime() + days * DAY);

    test.each([
        [0, TREND_BUCKET.DAY],
        [92, TREND_BUCKET.DAY],
        [93, TREND_BUCKET.WEEK],
        [731, TREND_BUCKET.WEEK],
        [732, TREND_BUCKET.MONTH],
    ])('a %d-day span is charted per %s', (days, bucket) => {
        expect(chooseBucket(start, after(days))).toBe(bucket);
    });

    test('no data is charted per day', () => {
        expect(chooseBucket(null, null)).toBe(TREND_BUCKET.DAY);
    });
});

describe('AdminRepository across apps', () => {
    test('one app is read without a UNION and tags rows with their app', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('COUNT(*)') ? [[{ count: 1 }]] : [[{ app_id: 'blog', public_id: 'x' }]]));
        const result = await new AdminRepository(dbWith(pool)).listViews(['blog'], baseQuery);
        expect(pool.queries[0].sql).not.toContain('UNION');
        expect(pool.queries[0].params[0]).toBe('blog');
        expect(result.views[0]).toMatchObject({ id: 'x', appId: 'blog' });
    });

    test('several apps are unioned, each branch cut to what the page can need', async () => {
        const pool = createScriptedPool((sql) => (sql.startsWith('SELECT (SELECT') ? [[{ count: 9 }]] : [[]]));
        const result = await new AdminRepository(dbWith(pool)).listViews(['blog', 'shop'], { ...baseQuery, page: 3, pageSize: 25, range: '7d' });
        const [select, count] = pool.queries;

        expect(select.sql.match(/UNION ALL/g)).toHaveLength(1);
        expect(select.sql).toContain('FROM `blog`');
        expect(select.sql).toContain('FROM `shop`');
        expect(select.sql).toMatch(/ORDER BY timestamp DESC, public_id DESC\s+LIMIT \?\)/);
        // Each branch: app id, the filter's range days, then offset + pageSize.
        expect(select.params).toEqual(['blog', 7, 75, 'shop', 7, 75, 25, 50]);

        expect(count.sql).toBe('SELECT (SELECT COUNT(*) FROM `blog` WHERE deleted_at IS NULL AND timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)) + (SELECT COUNT(*) FROM `shop` WHERE deleted_at IS NULL AND timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)) AS count');
        expect(count.params).toEqual([7, 7]);
        expect(result.total).toBe(9);
    });

    test('no apps means no query', async () => {
        const pool = createScriptedPool();
        const repo = new AdminRepository(dbWith(pool));
        expect(await repo.listViews([], baseQuery)).toEqual({ views: [], total: 0 });
        expect(await repo.existingTables([])).toEqual([]);
        expect(pool.queries).toHaveLength(0);
    });

    test('existingTables keeps the configured order and drops missing tables', async () => {
        const pool = createScriptedPool(() => [[{ name: 'shop' }, { name: 'blog' }]]);
        const tables = await new AdminRepository(dbWith(pool)).existingTables(['blog', 'ghost', 'shop']);
        expect(tables).toEqual(['blog', 'shop']);
        expect(pool.queries[0].sql).toContain('information_schema.TABLES');
        expect(pool.queries[0].params).toEqual([['blog', 'ghost', 'shop']]);
    });

    test('an unsafe app id never reaches a union', async () => {
        const pool = createScriptedPool();
        await expect(new AdminRepository(dbWith(pool)).listViews(['blog', 'x`y'], baseQuery))
            .rejects.toMatchObject({ code: 'INVALID_APP_ID' });
        expect(pool.queries).toHaveLength(0);
    });
});

describe('AdminRepository.analyze', () => {
    function analysisPool({ first = '2026-09-01T00:00:00Z', last = '2026-09-20T00:00:00Z', views = 10 } = {}) {
        return createScriptedPool((sql) => {
            if (sql.includes('MIN(timestamp)')) {
                return [[{ views, unique_views: 7, visitors: 5, countries: 2, modified: 1, first_at: new Date(first), last_at: new Date(last) }]];
            }
            if (sql.includes('AS period')) return [[{ period: '2026-09-01', views: 4, unique_views: 3 }]];
            if (sql.includes('ROW_NUMBER()')) {
                return [[
                    { dim: 'eventType', value: 'pageview', views: 8 },
                    { dim: 'eventType', value: 'click', views: 2 },
                    { dim: 'browser', value: null, views: 10 },
                ]];
            }
            if (sql.includes('GROUP BY country')) return [[{ country: 'DE', event_type: 'click', views: 2 }, { country: 'DE', event_type: null, views: 1 }]];
            if (sql.includes('SELECT DISTINCT event_type')) return [[{ event_type: 'click' }, { event_type: 'download' }, { event_type: 'pageview' }]];
            return [[]];
        });
    }

    const isEventTypeList = ({ sql }) => sql.startsWith('SELECT DISTINCT event_type');

    test('reads one filtered set through a CTE over every app', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog', 'shop'], { status: 'active', range: '30d' });
        for (const { sql } of pool.queries.filter((query) => !isEventTypeList(query))) {
            expect(sql).toMatch(/^WITH v AS \(SELECT \? AS app_id, .* FROM `blog` WHERE .* UNION ALL SELECT \? AS app_id, .* FROM `shop` WHERE /s);
        }
        expect(pool.queries[0].params).toEqual(['blog', 30, 'shop', 30]);
    });

    test('shapes totals, trend, breakdowns, and countries for the API', async () => {
        const result = await new AdminRepository(dbWith(analysisPool())).analyze(['blog'], { status: 'active' });
        expect(result.totals).toMatchObject({ views: 10, uniqueViews: 7, visitors: 5, countries: 2, modified: 1 });
        expect(result.bucket).toBe(TREND_BUCKET.DAY);
        expect(result.trend).toEqual([{ period: '2026-09-01', views: 4, uniqueViews: 3 }]);
        expect(result.breakdowns.eventType).toEqual([{ value: 'pageview', views: 8 }, { value: 'click', views: 2 }]);
        expect(result.breakdowns.browser).toEqual([{ value: null, views: 10 }]);
        expect(result.breakdowns.app).toEqual([]);
        expect(result.countries).toEqual([
            { country: 'DE', eventType: 'click', views: 2 },
            { country: 'DE', eventType: null, views: 1 },
        ]);
        expect(result.eventTypes).toEqual(['click', 'download', 'pageview']);
    });

    test('lists every event type by status alone, beyond the top N and outside the other filters', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog', 'shop'], {
            status: 'active', range: '30d', eventType: 'click', search: 'cart', modified: 'modified',
        });
        const [query] = pool.queries.filter(isEventTypeList);
        expect(query.sql).toMatch(/FROM `blog` WHERE deleted_at IS NULL AND event_type IS NOT NULL UNION SELECT event_type FROM `shop`/);
        expect(query.sql).not.toMatch(/LIMIT|event_type = \?|LIKE|DATE_SUB|admin_modified_at/);
        expect(query.params).toEqual([]);
    });

    test('the trend bucket follows the span of the data', async () => {
        const pool = analysisPool({ first: '2025-01-01T00:00:00Z', last: '2026-09-01T00:00:00Z' });
        const result = await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        expect(result.bucket).toBe(TREND_BUCKET.WEEK);
        expect(pool.matching('AS period')[0].sql).toContain(AdminRepository.BUCKET_EXPRESSION[TREND_BUCKET.WEEK]);
    });

    test('breakdowns keep the top N per dimension with a window function', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const [query] = pool.matching('ROW_NUMBER()');
        expect(query.sql).toContain('PARTITION BY dim ORDER BY views DESC, value');
        expect(query.params.at(-1)).toBe(ANALYSIS_TOP_N);
        for (const dim of Object.keys(AdminRepository.BREAKDOWN_COLUMNS)) expect(query.sql).toContain(`'${dim}' AS dim`);
    });

    test('countries are split by the leading event types, bound twice', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const [query] = pool.matching('GROUP BY country');
        expect(query.params.slice(-2)).toEqual([['pageview', 'click'], ['pageview', 'click']]);
    });

    test('the visitor hash is only ever counted, never returned', async () => {
        const pool = analysisPool();
        const result = await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const selects = pool.queries.map(({ sql }) => sql.slice(sql.lastIndexOf(')') + 1));
        for (const outer of selects) expect(outer.replace(/COUNT\(DISTINCT visitor_hash\)/g, '')).not.toContain('visitor_hash');
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('visitor_hash');
        expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    });

    test('an empty filter set stops after the totals, still listing the event types to choose from', async () => {
        const pool = analysisPool({ views: 0 });
        const result = await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        expect(pool.queries).toHaveLength(2);
        expect(result.trend).toEqual([]);
        expect(result.countries).toEqual([]);
        expect(result.eventTypes).toEqual(['click', 'download', 'pageview']);
    });

    test('no apps means no query', async () => {
        const pool = createScriptedPool();
        const result = await new AdminRepository(dbWith(pool)).analyze([], {});
        expect(pool.queries).toHaveLength(0);
        expect(result.totals.views).toBe(0);
    });

    test('with no event types the country query still binds a placeholder list', async () => {
        const pool = createScriptedPool((sql) => {
            if (sql.includes('MIN(timestamp)')) return [[{ views: 1, first_at: new Date(), last_at: new Date() }]];
            return [[]];
        });
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        expect(pool.matching('GROUP BY country')[0].params.slice(-2)).toEqual([[''], ['']]);
    });
});

describe('every-app and analysis routes', () => {
    const PASSWORD = 'analysis-test-password';
    const API = `${ADMIN.PATH_PREFIX}${ADMIN.API_PATH}`;
    const now = new Date('2026-09-20T12:00:00Z');

    function buildApp(views) {
        const repos = createMemoryRepos({ views, now: () => now });
        const app = express();
        app.use(ADMIN.PATH_PREFIX, createAdminRouter({
            config: {
                allowed: { appId: ['blog', 'shop', 'ghost'], deviceSize: ['small', 'medium', 'large'], origins: {} },
                server: { isProduction: false },
                admin: { enabled: true, password: PASSWORD, trashRetentionDays: 30 },
            },
            adminRepo: repos.adminRepo,
            logRepo: repos.logRepo,
        }));
        return app;
    }

    async function login(app) {
        const agent = request.agent(app);
        await agent.post(`${API}/login`).send({ password: PASSWORD }).expect(200);
        return agent;
    }

    const seed = () => ({
        blog: [
            makeView({ pagePath: '/a', timestamp: new Date(now.getTime() - DAY), country: 'DE' }),
            makeView({ pagePath: '/b', timestamp: new Date(now.getTime() - 40 * DAY), country: 'US', eventType: 'click' }),
        ],
        shop: [makeView({ pagePath: '/cart', timestamp: new Date(now.getTime() - 2 * DAY), country: 'DE' })],
    });

    test('GET /views lists every app together, skipping apps with no table', async () => {
        const agent = await login(buildApp(seed()));
        const res = await agent.get(`${API}/views`).expect(200);
        expect(res.body.apps).toEqual(['blog', 'shop']);
        expect(res.body.total).toBe(3);
        expect(res.body.views.map((v) => [v.appId, v.pagePath])).toEqual([['blog', '/a'], ['shop', '/cart'], ['blog', '/b']]);
    });

    test('the analysis offers every event type, beyond the top N and whatever the filters', async () => {
        const types = Array.from({ length: ANALYSIS_TOP_N + 2 }, (_, i) => `type_${String(i).padStart(2, '0')}`);
        const views = {
            blog: types.map((eventType, i) => makeView({ eventType, timestamp: new Date(now.getTime() - (i + 1) * 20 * DAY) })),
            shop: [makeView({ eventType: 'checkout', timestamp: new Date(now.getTime() - DAY) })],
        };
        const agent = await login(buildApp(views));
        const narrowed = await agent.get(`${API}/apps/blog/analytics`).query({ range: '7d', eventType: 'type_00' }).expect(200);
        expect(narrowed.body.totals.views).toBe(0);
        expect(narrowed.body.eventTypes).toEqual(types);
        const all = await agent.get(`${API}/analytics`).expect(200);
        expect(all.body.eventTypes).toEqual(['checkout', ...types]);
    });

    test('the range and event-type filters narrow the listing', async () => {
        const agent = await login(buildApp(seed()));
        expect((await agent.get(`${API}/views?range=30d`).expect(200)).body.total).toBe(2);
        expect((await agent.get(`${API}/views?eventType=click`).expect(200)).body.views.map((v) => v.pagePath)).toEqual(['/b']);
        expect((await agent.get(`${API}/apps/blog/views?range=7d`).expect(200)).body.total).toBe(1);
    });

    test('GET /analytics describes every app; GET /apps/:id/analytics one', async () => {
        const agent = await login(buildApp(seed()));
        const all = await agent.get(`${API}/analytics`).expect(200);
        expect(all.body.totals.views).toBe(3);
        expect(all.body.breakdowns.app).toEqual([{ value: 'blog', views: 2 }, { value: 'shop', views: 1 }]);
        expect(all.body.countries).toEqual(expect.arrayContaining([{ country: 'DE', eventType: 'pageview', views: 2 }]));

        const one = await agent.get(`${API}/apps/shop/analytics`).expect(200);
        expect(one.body).toMatchObject({ apps: ['shop'], totals: { views: 1, countries: 1 } });
    });

    test('the analysis honours the same filters as the listing', async () => {
        const agent = await login(buildApp(seed()));
        const res = await agent.get(`${API}/analytics?range=30d&eventType=pageview`).expect(200);
        expect(res.body.totals.views).toBe(2);
        expect(res.body).toMatchObject({ range: '30d', eventType: 'pageview' });
    });

    test('meta lists the date ranges', async () => {
        const agent = await login(buildApp(seed()));
        expect((await agent.get(`${API}/meta`).expect(200)).body.ranges).toEqual(['7d', '30d', '90d', '1y', 'all']);
    });

    test.each([
        ['/views?range=forever'],
        ['/views?eventType=' + 'e'.repeat(51)],
        ['/views?sort=visitor_hash'],
        ['/analytics?range=10y'],
        ['/analytics?status=everything'],
        ['/apps/nope/analytics'],
    ])('rejects %s', async (path) => {
        const agent = await login(buildApp(seed()));
        const res = await agent.get(`${API}${path}`).expect(422);
        expect(res.body.code).toBe(ADMIN_ERROR_CODE.VALIDATION_FAILED);
    });

    test.each([['/views'], ['/analytics'], ['/apps/blog/analytics']])('%s requires a session', async (path) => {
        await request(buildApp(seed())).get(`${API}${path}`).expect(401);
    });

    test.each([
        ['/views', 'listViews'],
        ['/analytics', 'analyze'],
        ['/apps/blog/analytics', 'analyze'],
    ])('%s reports a repository failure as a stable 500', async (path, operation) => {
        const repos = createMemoryRepos({ views: seed() });
        repos.adminRepo[operation] = async () => { throw new TypeError('secret detail'); };
        const app = express();
        app.use(ADMIN.PATH_PREFIX, createAdminRouter({
            config: {
                allowed: { appId: ['blog', 'shop'], deviceSize: ['small'], origins: {} },
                server: { isProduction: false },
                admin: { enabled: true, password: PASSWORD, trashRetentionDays: 30 },
            },
            adminRepo: repos.adminRepo,
            logRepo: repos.logRepo,
        }));
        const agent = await login(app);
        const res = await agent.get(`${API}${path}`).expect(500);
        expect(JSON.stringify(res.body)).not.toContain('secret detail');
    });
});
