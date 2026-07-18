/**
 * Mock Database Driver for tests
 * Mimics mysql2/promise behavior with hardcoded test data
 */
class MockPool {
    constructor(config) {
        this.config = config;
        this.duplicates = {};
        /** Every statement issued, so tests can assert on the SQL itself. */
        this.queries = [];
        /** Rows of the `_apps` registry: appId -> { id, origins }. */
        this.registry = new Map();
    }

    /**
     * Pool lifecycle hook.
     *
     * Invokes the handler with a connection shaped like the one mysql2's
     * promise pool really emits: the RAW callback-style connection, which
     * exposes .promise() and whose query() takes a callback rather than
     * returning a thenable. The previous no-op let a crash-on-first-connect
     * bug through the entire unit suite.
     */
    on(event, handler) {
        if (event === 'connection' && typeof handler === 'function') {
            handler({
                promise: () => ({ query: async () => [[]] }),
                query: (sql, params, cb) => {
                    this.queries.push({ sql, params });
                    if (typeof cb === 'function') cb(null, []);
                    // Deliberately returns a non-thenable, like a real Query.
                    return { sql };
                },
            });
        }
        return this;
    }

    async query(sql, params = []) {
        this.queries.push({ sql, params });

        // Match specific queries and return hardcoded data
        const sqlLower = sql.toLowerCase();

        // Health check / Connection test
        if (sqlLower.includes('select 1')) {
            return [[{ 1: 1 }]];
        }

        // ---- `_apps` tenant registry ---------------------------------------
        // Modelled with real state rather than canned rows, so idempotent
        // re-registration and the allowlist merge behave as they do in MySQL.
        if (sqlLower.includes('`_apps`')) {
            if (sqlLower.includes('create table')) return [[]];

            if (sqlLower.includes('insert into')) {
                const [id, appId, origins] = params;
                this.registry.set(appId, { id, origins });
                return [{ insertId: this.registry.size }];
            }

            if (sqlLower.includes('where app_id = ?')) {
                const appId = params[0];
                return [this.registry.has(appId) ? [{ app_id: appId }] : []];
            }

            if (sqlLower.includes('where origins is not null')) {
                return [[...this.registry.entries()]
                    .filter(([, row]) => row && row.origins)
                    .map(([app_id, row]) => ({ app_id, origins: row.origins }))];
            }

            if (sqlLower.includes('select app_id')) {
                return [[...this.registry.keys()].sort().map(app_id => ({ app_id }))];
            }

            return [[]];
        }

        // Stats: Unified Total/Unique/Visitors query
        if (sqlLower.includes('count(*) as total_views')) {
            return [[{
                total_views: 150,
                unique_views: 100,
                unique_visitors: 45
            }]];
        }

        // Stats: Total views (old/other queries)
        if (sqlLower.includes('count(*) as total')) {
            return [[{ total: 150 }]];
        }

        // Stats: Unique visitors (old/other queries)
        if (sqlLower.includes('count(distinct visitor_hash)') || sqlLower.includes('count(distinct ip)')) {
            return [[{ unique_visitors: 45 }]];
        }

        // Stats: Recent (24h)
        if (sqlLower.includes('interval 24 hour')) {
            return [[{ count: 12 }]];
        }

        // Stats: By country
        if (sqlLower.includes('group by country')) {
            return [[
                { country: 'US', count: 80 },
                { country: 'GB', count: 40 },
                { country: 'CA', count: 30 }
            ]];
        }

        // Stats: By device
        if (sqlLower.includes('group by devicesize')) {
            return [[
                { devicesize: 'large', count: 90 },
                { devicesize: 'medium', count: 40 },
                { devicesize: 'small', count: 20 }
            ]];
        }

        // Trends
        if (sqlLower.includes('group by period')) {
            return [[
                { period: '2026-01-01', count: 10 },
                { period: '2026-01-02', count: 15 }
            ]];
        }

        // Referrers: By source
        if (sqlLower.includes('group by source_type')) {
            return [[
                { source_type: 'search', count: 70 },
                { source_type: 'social', count: 50 },
                { source_type: 'direct', count: 30 }
            ]];
        }

        // Referrers: By domain
        if (sqlLower.includes('group by referrer_domain')) {
            return [[
                { referrer_domain: 'google.com', count: 50 },
                { referrer_domain: 'twitter.com', count: 30 }
            ]];
        }

        // Browsers
        if (sqlLower.includes('group by browser')) {
            return [[{ browser: 'Chrome', count: 100 }, { browser: 'Safari', count: 50 }]];
        }

        // OS
        if (sqlLower.includes('group by os')) {
            return [[{ os: 'Windows', count: 80 }, { os: 'Mac OS', count: 70 }]];
        }

        // Device Type
        if (sqlLower.includes('group by device_type')) {
            return [[{ device_type: 'desktop', count: 120 }, { device_type: 'mobile', count: 30 }]];
        }

        // Pages
        if (sqlLower.includes('group by page_path')) {
            return [[
                { page_path: '/home', page_title: 'Home', views: 100 },
                { page_path: '/blog', page_title: 'Blog', views: 50 }
            ]];
        }

        // Session detail. Mirrors DatabaseManager.SESSION_COLUMNS exactly:
        // neither visitor_hash nor masked_ip is selected by the real query, so
        // the mock must not invent them either. Returning columns production
        // does not return is how a test double starts certifying behaviour the
        // server never had.
        if (sqlLower.includes('where session_id')) {
            const event = {
                id: 1,
                country: 'US',
                timestamp: new Date(),
                devicesize: 'large',
                page_path: '/test',
                page_title: 'Test',
                referrer_domain: 'google.com',
                source_type: 'search',
                browser: 'Chrome',
                os: 'Mac OS',
                device_type: 'desktop',
                event_type: 'pageview',
                event_data: null
            };
            return [[event, { ...event, id: 2, event_type: 'click', event_data: { button: 'test' } }]];
        }

        // Recent views listing
        if (sqlLower.includes('from `') && sqlLower.includes('order by timestamp')) {
            return [[
                { masked_ip: '192.168.1.0', country: 'US', timestamp: new Date(), devicesize: 'large' },
                { masked_ip: '192.168.2.0', country: 'GB', timestamp: new Date(), devicesize: 'small' }
            ]];
        }

        // Duplicate check
        if (sqlLower.includes('select id from') && sqlLower.includes('limit 1')) {
            // Logic: if visitor_hash is specifically handled, simulate results
            const hash = params[0];

            // For unit tests, we use a specific hash usually
            if (this.duplicates && this.duplicates[hash]) return [[{ id: 1 }]];

            this.duplicates = this.duplicates || {};
            this.duplicates[hash] = true;
            return [[]]; // First time is always unique
        }

        // Count queries
        if (sqlLower.includes('select count(*) as count')) {
            return [[{ count: 150 }]];
        }

        // Insert
        if (sqlLower.includes('insert into')) {
            return [{ insertId: Math.floor(Math.random() * 1000) + 1 }];
        }

        return [[]];
    }

    async end() {
        return Promise.resolve();
    }
}

module.exports = {
    createPool: (config) => new MockPool(config),
    createConnection: async () => ({
        query: async () => [[{ 1: 1 }]],
        execute: async () => [[{ 1: 1 }]],
        end: async () => { },
        use: async () => { }
    })
};
