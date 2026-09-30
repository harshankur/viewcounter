/**
 * Every-app listings and the insights analysis: the SQL the repository
 * issues, and the API routes over it.
 */

const express = require('express');
const request = require('supertest');

const AdminRepository = require('../db/AdminRepository');
const { ADMIN, ADMIN_ERROR_CODE, ANALYSIS, ANALYSIS_TOP_N, TREND_BUCKET } = require('../constants');
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
        [0, TREND_BUCKET.HOUR],
        [2, TREND_BUCKET.HOUR],
        [3, TREND_BUCKET.DAY],
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

describe('the previous period', () => {
    const { buildFilter } = AdminRepository;

    test.each([['24h', 1], ['7d', 7], ['30d', 30], ['1y', 365]])(
        '%s is compared with the %d days before it', (range, days) => {
            const { clause, params } = buildFilter({ range }, 'previous');
            expect(clause).toContain('timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY) AND timestamp < DATE_SUB(NOW(), INTERVAL ? DAY)');
            expect(params).toEqual([days * 2, days]);
        });

    test('all time has no period before it', () => {
        expect(buildFilter({ range: 'all' }, 'previous').clause).not.toContain('INTERVAL');
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
    const TOTALS = {
        views: 10, pageviews: 8, unique_views: 7, visitors: 5, countries: 2, modified: 1,
        avg_engaged_ms: 42000, avg_scroll: 61.5, engaged_views: 4,
    };
    function analysisPool({ first = '2026-09-01T00:00:00Z', last = '2026-09-20T00:00:00Z', views = 10 } = {}) {
        return createScriptedPool((sql) => {
            // Before the totals: the visits query also reads MIN(timestamp).
            if (sql.includes('AVG(pages) AS pages_per_visit')) return [[{ visits: 4, bounces: 1, avg_visit_ms: 90000, pages_per_visit: 2 }]];
            if (sql.includes('MIN(timestamp) AS first_at')) {
                return [[{ ...TOTALS, views, first_at: new Date(first), last_at: new Date(last) }]];
            }
            if (sql.includes('AS period')) return [[{ period: '2026-09-01', views: 4, unique_views: 3, visitors: 2 }]];
            if (sql.includes('PARTITION BY dim')) {
                return [[
                    { dim: 'eventType', value: 'pageview', views: 8, visitors: 5 },
                    { dim: 'eventType', value: 'click', views: 2, visitors: 1 },
                    { dim: 'city', value: 'Munich, DE', views: 3, visitors: 2 },
                ]];
            }
            if (sql.includes('AS avg_scroll\n') || sql.includes('GROUP BY app_id, page_path ORDER BY views DESC')) {
                return [[{ app_id: 'blog', page: '/a', views: 5, visitors: 3, avg_engaged_ms: '30000.0000', avg_scroll: '50.0000' }]];
            }
            if (sql.includes('PARTITION BY kind')) {
                return [[
                    { kind: 'entry', app_id: 'blog', page: '/a', visits: 3, bounces: 1 },
                    { kind: 'exit', app_id: 'blog', page: '/b', visits: 2, bounces: 0 },
                ]];
            }
            if (sql.includes('next_page AS to_page')) return [[{ app_id: 'blog', from_page: '/a', to_page: '/b', steps: 2 }]];
            if (sql.includes("'scroll' AS kind")) {
                return [[{ kind: 'scroll', bucket: 50, views: 3 }, { kind: 'time', bucket: 30, views: 4 }]];
            }
            if (sql.includes('/ 3600) AS hour')) return [[{ hour: 494016, views: 3 }]];
            if (sql.includes('GROUP BY country')) return [[{ country: 'DE', event_type: 'click', views: 2 }, { country: 'DE', event_type: null, views: 1 }]];
            if (sql.includes('event_data FROM v')) return [[{ event_type: 'download', event_data: { file: 'a.pdf' } }]];
            if (sql.includes('SELECT DISTINCT event_type')) return [[{ event_type: 'click' }, { event_type: 'download' }, { event_type: 'pageview' }]];
            return [[]];
        });
    }

    const isEventTypeList = ({ sql }) => sql.startsWith('SELECT DISTINCT event_type');

    test('reads one filtered set through a CTE over every app, in every statement', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog', 'shop'], { status: 'active', range: '30d' });
        const statements = pool.queries.filter((query) => !isEventTypeList(query));
        expect(statements.length).toBeGreaterThan(8);
        for (const { sql } of statements) {
            expect(sql).toMatch(/^WITH v AS \(SELECT \? AS app_id, .* FROM `blog` WHERE .* UNION ALL SELECT \? AS app_id, .* FROM `shop` WHERE /s);
        }
        expect(pool.queries[0].params).toEqual(['blog', 30, 'shop', 30]);
    });

    test('a bounded range also reads the period before it, for comparison', async () => {
        const pool = analysisPool();
        const result = await new AdminRepository(dbWith(pool)).analyze(['blog'], { status: 'active', range: '7d' });
        const previous = pool.queries.filter((q) => q.params.includes(14));
        expect(previous.map((q) => q.params)).toEqual([['blog', 14, 7], ['blog', 14, 7]]);
        expect(result.previous).toMatchObject({ views: 10, visits: 4 });
    });

    test('all time has no previous period', async () => {
        const result = await new AdminRepository(dbWith(analysisPool())).analyze(['blog'], { status: 'active', range: 'all' });
        expect(result.previous).toBeNull();
    });

    test('shapes every section for the API', async () => {
        const result = await new AdminRepository(dbWith(analysisPool())).analyze(['blog'], { status: 'active' });
        expect(result.totals).toMatchObject({
            views: 10, pageviews: 8, uniqueViews: 7, visitors: 5, countries: 2, modified: 1,
            visits: 4, bounceRate: 0.25, avgVisitMs: 90000, pagesPerVisit: 2,
            avgEngagedMs: 42000, avgScroll: 61.5, engagedViews: 4,
        });
        expect(result.bucket).toBe(TREND_BUCKET.DAY);
        expect(result.trend).toEqual([{ period: '2026-09-01', views: 4, uniqueViews: 3, visitors: 2 }]);
        expect(result.breakdowns.eventType).toEqual([{ value: 'pageview', views: 8, visitors: 5 }, { value: 'click', views: 2, visitors: 1 }]);
        expect(result.breakdowns.city).toEqual([{ value: 'Munich, DE', views: 3, visitors: 2 }]);
        expect(result.breakdowns.app).toEqual([]);
        expect(result.pages).toEqual([{ appId: 'blog', page: '/a', views: 5, visitors: 3, avgEngagedMs: 30000, avgScroll: 50 }]);
        expect(result.entryPages).toEqual([{ appId: 'blog', page: '/a', visits: 3, bounceRate: 1 / 3 }]);
        expect(result.exitPages).toEqual([{ appId: 'blog', page: '/b', visits: 2 }]);
        expect(result.transitions).toEqual([{ appId: 'blog', from: '/a', to: '/b', steps: 2 }]);
        expect(result.scrollDepth).toEqual([{ from: 50, views: 3 }]);
        expect(result.timeOnPage).toEqual([{ fromSeconds: 30, views: 4 }]);
        expect(result.hours).toEqual([{ hour: 494016, views: 3 }]);
        expect(result.countries).toEqual([
            { country: 'DE', eventType: 'click', views: 2 },
            { country: 'DE', eventType: null, views: 1 },
        ]);
        expect(result.eventProperties).toEqual([{ eventType: 'download', key: 'file', value: 'a.pdf', count: 1 }]);
        expect(result.eventTypes).toEqual(['click', 'download', 'pageview']);
    });

    test('visits are page views split where a visitor pauses longer than the gap', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const [visits] = pool.matching('AVG(pages) AS pages_per_visit');
        expect(visits.sql).toContain('LAG(timestamp) OVER (PARTITION BY app_id, visitor_hash ORDER BY timestamp, id)');
        expect(visits.sql).toContain(`> ${ANALYSIS.VISIT_GAP_SECONDS}`);
        expect(visits.sql).toContain("FROM v WHERE event_type = 'pageview'");
        expect(visits.sql).toContain('ROWS UNBOUNDED PRECEDING');
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

    test('breakdowns keep the top N per dimension, with visitors, in one window query', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const [query] = pool.matching('PARTITION BY dim');
        expect(query.sql).toContain('PARTITION BY dim ORDER BY views DESC, value');
        expect(query.sql).toContain('COUNT(DISTINCT visitor_hash) AS visitors FROM v GROUP BY value');
        expect(query.params.at(-1)).toBe(ANALYSIS_TOP_N);
        for (const dim of Object.keys(AdminRepository.BREAKDOWN_COLUMNS)) expect(query.sql).toContain(`'${dim}' AS dim`);
    });

    test('the heatmap reads at most the last year, from the last view on', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const [query] = pool.matching('/ 3600) AS hour');
        expect(query.sql).toContain(`INTERVAL ${ANALYSIS.HEATMAP_MAX_DAYS} DAY`);
        expect(query.params.at(-1)).toEqual(new Date('2026-09-20T00:00:00Z'));
    });

    test('countries are split by the leading event types, bound twice', async () => {
        const pool = analysisPool();
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const [query] = pool.matching('GROUP BY country');
        expect(query.params.slice(-2)).toEqual([['pageview', 'click'], ['pageview', 'click']]);
    });

    test('the visitor hash is only ever counted or grouped by, never returned', async () => {
        const pool = analysisPool();
        const result = await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('visitor_hash');
        expect(serialized).not.toMatch(/[0-9a-f]{64}/);
        for (const { sql } of pool.queries) {
            const outer = sql.slice(sql.lastIndexOf('SELECT'));
            expect(outer).not.toMatch(/SELECT[^;]*\bvisitor_hash\b(?!\))/);
        }
    });

    test('an empty filter set stops after the totals, still listing the event types to choose from', async () => {
        const pool = analysisPool({ views: 0 });
        const result = await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        // Totals and visits for the range, then the event types.
        expect(pool.queries).toHaveLength(3);
        expect(result.trend).toEqual([]);
        expect(result.countries).toEqual([]);
        expect(result.pages).toEqual([]);
        expect(result.eventTypes).toEqual(['click', 'download', 'pageview']);
    });

    test('no apps means no query', async () => {
        const pool = createScriptedPool();
        const result = await new AdminRepository(dbWith(pool)).analyze([], {});
        expect(pool.queries).toHaveLength(0);
        expect(result.totals).toBeNull();
        expect(result.breakdowns.page).toEqual([]);
    });

    test('with no event types the country query still binds a placeholder list', async () => {
        const pool = createScriptedPool((sql) => {
            if (sql.includes('MIN(timestamp) AS first_at')) return [[{ views: 1, first_at: new Date(), last_at: new Date() }]];
            return [[]];
        });
        await new AdminRepository(dbWith(pool)).analyze(['blog'], {});
        expect(pool.matching('GROUP BY country')[0].params.slice(-2)).toEqual([[''], ['']]);
    });
});

describe('AdminRepository.realtime', () => {
    test('reads the last half hour of live views, with visitors from the last few minutes', async () => {
        const pool = createScriptedPool((sql) => {
            if (sql.includes('now_minute')) return [[{ visitors: 3, now_minute: 29000000 }]];
            if (sql.includes('/ 60) AS minute')) return [[{ minute: 28999999, views: 4 }]];
            return [[{ app_id: 'blog', page: '/', visitors: 2 }]];
        });
        const result = await new AdminRepository(dbWith(pool)).realtime(['blog', 'shop']);
        expect(result).toEqual({
            visitors: 3, nowMinute: 29000000,
            minutes: [{ minute: 28999999, views: 4 }],
            pages: [{ appId: 'blog', page: '/', visitors: 2 }],
        });
        for (const { sql } of pool.queries) {
            expect(sql).toContain(`deleted_at IS NULL AND timestamp >= DATE_SUB(NOW(), INTERVAL ${ANALYSIS.REALTIME_CHART_MINUTES} MINUTE)`);
            expect(sql).toContain('UNION ALL');
        }
        expect(pool.queries[0].sql).toContain(`INTERVAL ${ANALYSIS.REALTIME_VISITOR_MINUTES} MINUTE`);
    });

    test('no apps means no query', async () => {
        const pool = createScriptedPool();
        expect(await new AdminRepository(dbWith(pool)).realtime([])).toEqual({ visitors: 0, nowMinute: null, minutes: [], pages: [] });
        expect(pool.queries).toHaveLength(0);
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
        expect(all.body.breakdowns.app).toEqual([{ value: 'blog', views: 2, visitors: 2 }, { value: 'shop', views: 1, visitors: 1 }]);
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
        expect((await agent.get(`${API}/meta`).expect(200)).body.ranges).toEqual(['24h', '7d', '30d', '90d', '1y', 'all']);
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

describe('the worked scenario, through the in-memory analysis', () => {
    const { ROWS, EXPECTED } = require('./support/analysisScenario');
    const { memoryAnalysis } = require('./support/memoryAnalysis');

    const rows = ROWS.map((row, i) => makeView({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        appId: 'blog',
        visitorHash: row.visitor.repeat(64),
        timestamp: new Date(row.time),
        pagePath: row.page,
        eventType: row.eventType || 'pageview',
        eventData: row.eventData || null,
        engagedMs: row.engagedMs ?? null,
        scrollDepth: row.scrollDepth ?? null,
    }));
    const result = memoryAnalysis(rows, null);
    const strip = (entries) => entries.map(({ appId, ...rest }) => rest); // eslint-disable-line no-unused-vars

    test('visits, bounces, durations, and engagement', () => {
        expect(result.totals).toMatchObject(EXPECTED.totals);
        expect(result.totals.avgScroll).toBeCloseTo(EXPECTED.avgScroll, 6);
    });

    test('entry and exit pages', () => {
        expect(strip(result.entryPages)).toEqual(EXPECTED.entryPages);
        expect(strip(result.exitPages)).toEqual(EXPECTED.exitPages);
    });

    test('page flow, without reloads', () => {
        expect(strip(result.transitions)).toEqual(EXPECTED.transitions);
    });

    test('pages with their visitors', () => {
        expect(strip(result.pages).map(({ page, views, visitors }) => ({ page, views, visitors }))).toEqual(EXPECTED.pages);
    });

    test('custom event properties', () => {
        expect(result.eventProperties).toEqual(EXPECTED.eventProperties);
    });
});
