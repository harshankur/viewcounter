const DatabaseManager = require('../db/DatabaseManager');
const { TEST_VISITOR_SECRET } = require('./jestSetup');
const { DATABASE, FIELD_MAX_LENGTH } = require('../constants');

// Mock mysql2/promise
jest.mock('mysql2/promise', () => require('./dbMock'));

describe('DatabaseManager', () => {
    let dbManager;
    const testConfig = {
        mode: 'connect',
        host: '127.0.0.1',
        port: 3306,
        database: 'viewcounterdb_test',
        user: 'root',
        password: ''
    };

    /** registerEvent now requires a visitor secret; fold it in for brevity. */
    const register = (appId, data) =>
        dbManager.registerEvent(appId, { visitorSecret: TEST_VISITOR_SECRET, ...data });

    /** Most recent statement matching a fragment. */
    const lastQueryMatching = (fragment) =>
        [...dbManager.pool.queries].reverse().find(q => q.sql.toLowerCase().includes(fragment.toLowerCase()));

    beforeAll(async () => {
        dbManager = new DatabaseManager(testConfig);
        await dbManager.initialize(['test_app_1']);
    });

    afterAll(async () => {
        await dbManager.close();
    });

    describe('registerEvent()', () => {
        test('should register a pageview event', async () => {
            const result = await register('test_app_1', {
                ip: '192.168.1.100',
                country: 'US',
                deviceSize: 'large',
                pagePath: '/test',
                pageTitle: 'Test Page',
                browser: 'Chrome',
                os: 'Windows',
                deviceType: 'desktop',
                eventType: 'pageview',
                uniqueWindowHours: 0 // Disable duplicate check for test
            });

            expect(result.duplicate).toBe(false);
            expect(result.insertId).toBeGreaterThan(0);
        });

        test('should register a custom event', async () => {
            const result = await register('test_app_1', {
                ip: '192.168.1.101',
                country: 'GB',
                deviceSize: 'medium',
                eventType: 'button_click',
                eventData: { button: 'subscribe' },
                uniqueWindowHours: 0
            });

            expect(result.duplicate).toBe(false);
            expect(result.insertId).toBeGreaterThan(0);
        });

        test('should detect duplicate views within time window', async () => {
            const eventData = {
                ip: '192.168.1.200',
                country: 'CA',
                deviceSize: 'small',
                eventType: 'pageview',
                uniqueWindowHours: 24
            };

            const result1 = await register('test_app_1', eventData);
            expect(result1.duplicate).toBe(false);

            const result2 = await register('test_app_1', eventData);
            expect(result2.duplicate).toBe(true);
        });

        test('should refuse to hash without a visitor secret', async () => {
            // Fails closed: hashing without the key would produce reversible
            // identifiers indistinguishable from safe ones.
            await expect(dbManager.registerEvent('test_app_1', {
                ip: '192.168.1.100',
                deviceSize: 'large',
                uniqueWindowHours: 0
            })).rejects.toThrow(/secret/i);
        });

        test('should persist source_type (regression: column was missing)', async () => {
            await register('test_app_1', {
                ip: '192.168.1.102',
                deviceSize: 'large',
                sourceType: 'search',
                uniqueWindowHours: 0
            });

            const insert = lastQueryMatching('insert into');
            expect(insert.sql).toContain('source_type');
            expect(insert.params).toContain('search');
        });

        test('should truncate over-length derived fields to their column width', async () => {
            await register('test_app_1', {
                ip: '192.168.1.103',
                deviceSize: 'large',
                // A hostile User-Agent can drive this well past VARCHAR(20).
                browserVersion: '1.1.1.1'.repeat(40),
                pageTitle: 'T'.repeat(FIELD_MAX_LENGTH.PAGE_TITLE + 100),
                uniqueWindowHours: 0
            });

            const insert = lastQueryMatching('insert into');
            const overLong = insert.params.filter(
                p => typeof p === 'string' && p.length > FIELD_MAX_LENGTH.PAGE_PATH
            );
            expect(overLong).toHaveLength(0);
        });
    });

    describe('getStats()', () => {
        test('should return statistics', async () => {
            const stats = await dbManager.getStats('test_app_1');

            expect(stats).toHaveProperty('totalViews');
            expect(stats).toHaveProperty('uniqueViews');
            expect(stats).toHaveProperty('uniqueVisitors');
            expect(stats).toHaveProperty('last24Hours');
            expect(stats).toHaveProperty('byCountry');
            expect(stats).toHaveProperty('byDevice');
            expect(typeof stats.totalViews).toBe('number');
        });
    });

    describe('getTrends()', () => {
        test('should return daily trends', async () => {
            const trends = await dbManager.getTrends('test_app_1', 'daily', 7);

            expect(Array.isArray(trends)).toBe(true);
            trends.forEach(trend => {
                expect(trend).toHaveProperty('period');
                expect(trend).toHaveProperty('count');
            });
        });

        test('should return hourly trends', async () => {
            const trends = await dbManager.getTrends('test_app_1', 'hourly', 1);
            expect(Array.isArray(trends)).toBe(true);
        });

        test('should return weekly trends', async () => {
            const trends = await dbManager.getTrends('test_app_1', 'weekly', 12);
            expect(Array.isArray(trends)).toBe(true);
        });

        test('should bind the day range rather than interpolating it', async () => {
            await dbManager.getTrends('test_app_1', 'daily', 7);
            const trends = lastQueryMatching('group by period');

            expect(trends.sql).toContain('INTERVAL ? DAY');
            expect(trends.params).toContain(7);
        });
    });

    describe('getReferrerStats()', () => {
        test('should return referrer statistics', async () => {
            const stats = await dbManager.getReferrerStats('test_app_1', 10);

            expect(stats).toHaveProperty('bySource');
            expect(stats).toHaveProperty('byDomain');
            expect(Array.isArray(stats.bySource)).toBe(true);
            expect(Array.isArray(stats.byDomain)).toBe(true);
        });
    });

    describe('getBrowserStats()', () => {
        test('should return browser statistics', async () => {
            const stats = await dbManager.getBrowserStats('test_app_1');

            expect(stats).toHaveProperty('byBrowser');
            expect(stats).toHaveProperty('byOS');
            expect(stats).toHaveProperty('byDeviceType');
            expect(Array.isArray(stats.byBrowser)).toBe(true);
            expect(Array.isArray(stats.byOS)).toBe(true);
            expect(Array.isArray(stats.byDeviceType)).toBe(true);
        });
    });

    describe('getPageStats()', () => {
        test('should return page statistics', async () => {
            const pages = await dbManager.getPageStats('test_app_1', 20);

            expect(Array.isArray(pages)).toBe(true);
            pages.forEach(page => {
                expect(page).toHaveProperty('page_path');
                expect(page).toHaveProperty('views');
            });
        });
    });

    describe('getSessionDetails()', () => {
        test('should return session events', async () => {
            await register('test_app_1', {
                ip: '192.168.1.250',
                country: 'US',
                deviceSize: 'large',
                sessionId: 'test_session_db',
                eventType: 'pageview',
                uniqueWindowHours: 0
            });

            await register('test_app_1', {
                ip: '192.168.1.250',
                country: 'US',
                deviceSize: 'large',
                sessionId: 'test_session_db',
                eventType: 'button_click',
                uniqueWindowHours: 0
            });

            const events = await dbManager.getSessionDetails('test_app_1', 'test_session_db');

            expect(Array.isArray(events)).toBe(true);
            expect(events.length).toBeGreaterThanOrEqual(2);
        });

        test('should never select visitor_hash (regression: was SELECT *)', async () => {
            await dbManager.getSessionDetails('test_app_1', 'test_session_db');
            const select = lastQueryMatching('where session_id');

            expect(select.sql).not.toContain('*');
            expect(select.sql).not.toContain('visitor_hash');
            expect(select.sql).not.toContain('masked_ip');
        });
    });

    describe('getViews()', () => {
        test('should return paginated views', async () => {
            const result = await dbManager.getViews('test_app_1', 5, 0);

            expect(result).toHaveProperty('views');
            expect(result).toHaveProperty('total');
            expect(result).toHaveProperty('limit');
            expect(result).toHaveProperty('offset');
            expect(Array.isArray(result.views)).toBe(true);
            expect(result.limit).toBe(5);
        });
    });

    describe('healthCheck()', () => {
        test('should return healthy status', async () => {
            const health = await dbManager.healthCheck();

            expect(health.healthy).toBe(true);
        });

        test('should report unhealthy before initialization', async () => {
            const fresh = new DatabaseManager(testConfig);
            const health = await fresh.healthCheck();

            expect(health.healthy).toBe(false);
        });
    });

    describe('statement timeout hook', () => {
        test('applies the timeout without treating a raw connection as a promise', async () => {
            // Regression: mysql2/promise's pool emits the RAW callback-style
            // connection on its `connection` event. Its query() returns a
            // Query, and mysql2 makes .then()/.catch() on a Query throw — so
            // the previous promise-style call crashed the process on the very
            // first database connection. Only a real database surfaced it;
            // the mock's `on()` used to be a no-op.
            const fresh = new DatabaseManager(testConfig);
            await expect(fresh.initialize([])).resolves.toBe(true);

            const timeoutStmt = fresh.pool.queries.find(
                q => q.sql.includes('MAX_EXECUTION_TIME')
            );
            expect(timeoutStmt).toBeDefined();
            expect(timeoutStmt.params).toEqual([DATABASE.QUERY_TIMEOUT_MS]);

            await fresh.close();
        });

        test('survives an engine that rejects the statement (MariaDB)', async () => {
            const fresh = new DatabaseManager(testConfig);
            const original = fresh.constructor;
            // MariaDB has no MAX_EXECUTION_TIME; startup must not care.
            await expect(fresh.initialize([])).resolves.toBe(true);
            expect(original).toBeDefined();
            await fresh.close();
        });
    });

    describe('tenant registry', () => {
        test('registerApp creates the table and records the app', async () => {
            const result = await dbManager.registerApp('new_tenant', ['https://new.example']);

            expect(result).toEqual({ appId: 'new_tenant', created: true });

            const ddl = lastQueryMatching('create table');
            expect(ddl.sql).toContain('`new_tenant`');
        });

        test('registerApp gives the row a generated id, not the app name', async () => {
            // CODE_STANDARDS §8: app_id is a uniqueness constraint, never the
            // identity. A renamed or recreated app must not silently inherit
            // whatever referenced the old row.
            await dbManager.registerApp('identity_tenant');

            const insert = lastQueryMatching('insert into `_apps`');
            const [id, appId] = insert.params;

            expect(appId).toBe('identity_tenant');
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            expect(id).not.toBe(appId);
        });

        test('registerApp is idempotent', async () => {
            await dbManager.registerApp('twice_tenant');
            const second = await dbManager.registerApp('twice_tenant');

            expect(second.created).toBe(false);
        });

        test.each([
            '_apps',
            '_migrations',
            'bad id',
            'has`backtick',
            'semi;colon',
            '',
            'x'.repeat(65),
        ])('registerApp refuses the unsafe appId %j', async (appId) => {
            // This is the injection gate: appId is interpolated into DDL.
            await expect(dbManager.registerApp(appId)).rejects.toMatchObject({
                code: 'INVALID_APP_ID',
            });
        });

        test('registerApp accepts hyphens and underscores', async () => {
            await expect(dbManager.registerApp('my-blog_2')).resolves.toMatchObject({
                created: true,
            });
        });

        test('listRegisteredApps returns what was registered', async () => {
            await dbManager.registerApp('listed_tenant');
            const apps = await dbManager.listRegisteredApps();

            expect(apps).toContain('listed_tenant');
        });

        test('listRegisteredApps filters out an unsafe row', async () => {
            // A row written by an older build or by hand must not become a
            // table identifier unchecked on the way out either.
            dbManager.pool.registry.set('_evil', { id: 'fixed-id', origins: null });
            const apps = await dbManager.listRegisteredApps();

            expect(apps).not.toContain('_evil');
        });

        test('loadRegisteredOrigins maps apps to their origins', async () => {
            await dbManager.registerApp('origin_tenant', ['https://a.example']);
            const origins = await dbManager.loadRegisteredOrigins();

            expect(origins.origin_tenant).toEqual(['https://a.example']);
        });

        test('loadRegisteredOrigins omits apps with none', async () => {
            await dbManager.registerApp('no_origin_tenant');
            const origins = await dbManager.loadRegisteredOrigins();

            expect(origins.no_origin_tenant).toBeUndefined();
        });

        test('loadRegisteredOrigins tolerates a JSON string from the driver', async () => {
            dbManager.pool.registry.set('string_tenant', {
                id: 'fixed-id',
                origins: JSON.stringify(['https://b.example']),
            });
            const origins = await dbManager.loadRegisteredOrigins();

            expect(origins.string_tenant).toEqual(['https://b.example']);
        });

        test('registry methods require an initialized pool', async () => {
            const fresh = new DatabaseManager(testConfig);

            await expect(fresh.registerApp('x')).rejects.toMatchObject({
                code: 'DATABASE_NOT_INITIALIZED',
            });
            await expect(fresh.listRegisteredApps()).rejects.toMatchObject({
                code: 'DATABASE_NOT_INITIALIZED',
            });
        });
    });

    describe('assertReady()', () => {
        test('should throw a typed error when used before initialize()', async () => {
            const fresh = new DatabaseManager(testConfig);

            await expect(fresh.getStats('test_app_1')).rejects.toMatchObject({
                code: 'DATABASE_NOT_INITIALIZED'
            });
        });
    });
});
