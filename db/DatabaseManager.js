const crypto = require('crypto');
const mysql = require('mysql2/promise');

const {
    APP_REGISTRY_TABLE,
    DATABASE,
    EVENT_TYPE,
    FIELD_MAX_LENGTH,
    QUERY_LIMITS,
    SERVER,
    TOP_N_RESULTS,
    TREND_PERIOD,
} = require('../constants');
const PrivacyUtils = require('../utils/privacyUtils');
const logger = require('../utils/logger');
const { getError, logWarning, ErrorType, WarningType } = require('../utils/errorUtils');
const { truncate } = require('../utils/stringUtils');
const { isValidAppId } = require('../utils/appIdUtils');

/**
 * Columns returned for a session lookup.
 *
 * Deliberately explicit rather than `SELECT *`. The previous wildcard returned
 * `visitor_hash` — the pseudonymous visitor identifier itself — to any caller
 * of the sessions endpoint.
 */
const SESSION_COLUMNS = [
    'id',
    'country',
    'timestamp',
    'devicesize',
    'page_path',
    'page_title',
    'referrer_domain',
    'source_type',
    'browser',
    'os',
    'device_type',
    'event_type',
    'event_data',
].join(', ');

/**
 * Registry of dynamically provisioned apps.
 *
 * Without this, the set of tenants was whatever `allowed.json` said at boot, so
 * adding one meant editing config and restarting the process. The registry
 * makes tenants data rather than configuration.
 *
 * `id` is a generated UUID and is the row's identity; `app_id` is a uniqueness
 * *constraint*, not an identity (CODE_STANDARDS.md §8). The distinction matters
 * the first time an app is renamed, or deleted and a later one reuses the name —
 * with the natural key as the primary key, anything referencing the old row
 * would silently re-point at the new one.
 */
const APP_REGISTRY_DDL = `
    CREATE TABLE IF NOT EXISTS \`${APP_REGISTRY_TABLE}\` (
        \`id\` CHAR(36) PRIMARY KEY,
        \`app_id\` VARCHAR(64) NOT NULL UNIQUE,
        \`origins\` JSON DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * DDL for one app's event table.
 *
 * `appId` is interpolated because MySQL cannot bind an identifier as a
 * parameter. Every caller must have passed it through `isValidAppId` first —
 * the assertion below is the backstop, not the primary gate.
 *
 * @param {string} appId
 * @returns {string}
 */
function appTableDDL(appId) {
    if (!isValidAppId(appId)) {
        throw getError(ErrorType.INVALID_APP_ID, { appId });
    }

    return `
        CREATE TABLE IF NOT EXISTS \`${appId}\` (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`masked_ip\` VARCHAR(${FIELD_MAX_LENGTH.MASKED_IP}) NOT NULL,
            \`visitor_hash\` VARCHAR(${FIELD_MAX_LENGTH.VISITOR_HASH}) NOT NULL,
            \`country\` VARCHAR(${FIELD_MAX_LENGTH.COUNTRY}) DEFAULT NULL,
            \`timestamp\` DATETIME NOT NULL,
            \`devicesize\` VARCHAR(${FIELD_MAX_LENGTH.DEVICE_SIZE}) NOT NULL,
            \`page_path\` VARCHAR(${FIELD_MAX_LENGTH.PAGE_PATH}) DEFAULT NULL,
            \`page_title\` VARCHAR(${FIELD_MAX_LENGTH.PAGE_TITLE}) DEFAULT NULL,
            \`referrer\` VARCHAR(${FIELD_MAX_LENGTH.REFERRER}) DEFAULT NULL,
            \`referrer_domain\` VARCHAR(${FIELD_MAX_LENGTH.REFERRER_DOMAIN}) DEFAULT NULL,
            \`source_type\` VARCHAR(${FIELD_MAX_LENGTH.SOURCE_TYPE}) DEFAULT NULL,
            \`browser\` VARCHAR(${FIELD_MAX_LENGTH.BROWSER}) DEFAULT NULL,
            \`browser_version\` VARCHAR(${FIELD_MAX_LENGTH.BROWSER_VERSION}) DEFAULT NULL,
            \`os\` VARCHAR(${FIELD_MAX_LENGTH.OS}) DEFAULT NULL,
            \`os_version\` VARCHAR(${FIELD_MAX_LENGTH.OS_VERSION}) DEFAULT NULL,
            \`device_type\` VARCHAR(${FIELD_MAX_LENGTH.DEVICE_TYPE}) DEFAULT NULL,
            \`session_id\` VARCHAR(${FIELD_MAX_LENGTH.SESSION_ID}) DEFAULT NULL,
            \`event_type\` VARCHAR(${FIELD_MAX_LENGTH.EVENT_TYPE}) DEFAULT '${EVENT_TYPE.PAGEVIEW}',
            \`event_data\` JSON DEFAULT NULL,
            \`is_unique\` TINYINT(1) DEFAULT 1,
            INDEX \`idx_timestamp\` (\`timestamp\`),
            INDEX \`idx_visitor_timestamp\` (\`visitor_hash\`, \`timestamp\`),
            INDEX \`idx_masked_ip\` (\`masked_ip\`),
            INDEX \`idx_country\` (\`country\`),
            INDEX \`idx_devicesize\` (\`devicesize\`),
            INDEX \`idx_page_path\` (\`page_path\`(255)),
            INDEX \`idx_referrer_domain\` (\`referrer_domain\`),
            INDEX \`idx_source_type\` (\`source_type\`),
            INDEX \`idx_browser\` (\`browser\`),
            INDEX \`idx_os\` (\`os\`),
            INDEX \`idx_device_type\` (\`device_type\`),
            INDEX \`idx_session_id\` (\`session_id\`),
            INDEX \`idx_event_type\` (\`event_type\`),
            INDEX \`idx_is_unique\` (\`is_unique\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
}

/**
 * Apply a server-side statement timeout to a newly opened pool connection.
 *
 * `mysql2/promise`'s pool emits the RAW callback-style connection on its
 * `connection` event, not the promise-wrapped one. Its `query()` returns a
 * `Query`, and mysql2 deliberately makes `.then()`/`.catch()` on a `Query`
 * throw — so treating it as a promise crashes the process on the very first
 * database connection. The callback form is the correct API for that object.
 *
 * Failure is swallowed on purpose: MariaDB and MySQL < 5.7.8 have no
 * MAX_EXECUTION_TIME, and the pool's own limits still bound concurrency there.
 *
 * @param {object} connection raw or promise-wrapped mysql2 connection
 */
function setStatementTimeout(connection) {
    const sql = 'SET SESSION MAX_EXECUTION_TIME = ?';
    const params = [DATABASE.QUERY_TIMEOUT_MS];

    try {
        // A raw connection exposes .promise(); a promise-wrapped one does not.
        if (typeof connection.promise === 'function') {
            connection.query(sql, params, () => {
                // Callback form: the error is delivered here, never thrown, and
                // never left as an unhandled 'error' event on the Query.
            });
            return;
        }

        const result = connection.query(sql, params);
        if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
        // An engine that rejects the statement outright must not stop startup.
    }
}

/**
 * Database Manager
 * Handles both 'connect' mode (use existing DB) and 'create' mode (auto-create DB and tables)
 */
class DatabaseManager {
    constructor(config) {
        this.config = config;
        this.pool = null;
        this.mode = config.mode || 'connect';
    }

    /** @throws {Error} when a query is attempted before initialize() */
    assertReady() {
        if (!this.pool) {
            throw getError(ErrorType.DATABASE_NOT_INITIALIZED);
        }
    }

    /**
     * Initialize database connection and optionally create schema
     */
    async initialize(allowedAppIds = []) {
        try {
            if (this.mode === 'create') {
                await this.createDatabaseAndTables(allowedAppIds);
            }

            this.pool = mysql.createPool({
                host: this.config.host,
                port: this.config.port,
                user: this.config.user,
                password: this.config.password,
                database: this.config.database,
                waitForConnections: true,
                connectionLimit: DATABASE.CONNECTION_LIMIT,
                // Finite, so a saturated pool rejects rather than queueing
                // unboundedly. With an unbounded queue a burst of expensive
                // aggregates stalls every later request, including /health.
                queueLimit: DATABASE.QUEUE_LIMIT,
                connectTimeout: DATABASE.CONNECT_TIMEOUT_MS,
                enableKeepAlive: true,
                keepAliveInitialDelay: 0,
            });

            // Server-side statement timeout. Bounds the cost of any single
            // read so one caller cannot pin a connection indefinitely.
            if (typeof this.pool.on === 'function') {
                this.pool.on('connection', (connection) => {
                    setStatementTimeout(connection);
                });
            }

            await this.pool.query('SELECT 1');
            logger.info(`Database connected (mode: ${this.mode})`);

            return true;
        } catch (cause) {
            throw getError(ErrorType.DATABASE_CONNECTION_FAILED, {
                host: this.config.host,
                port: this.config.port,
                database: this.config.database,
                cause: cause.message,
            });
        }
    }

    /**
     * Create database and tables (create mode only)
     */
    async createDatabaseAndTables(allowedAppIds) {
        logger.info('Creating database and tables...');

        const connection = await mysql.createConnection({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            password: this.config.password,
        });

        try {
            await connection.query(
                `CREATE DATABASE IF NOT EXISTS \`${this.config.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            logger.info(`Database '${this.config.database}' ready`);

            await connection.query(`USE \`${this.config.database}\``);

            await connection.query(`
                CREATE TABLE IF NOT EXISTS \`_migrations\` (
                    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                    \`version\` VARCHAR(50) NOT NULL UNIQUE,
                    \`applied_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX \`idx_version\` (\`version\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            await connection.query(APP_REGISTRY_DDL);

            for (const appId of allowedAppIds) {
                await connection.query(appTableDDL(appId));
                logger.info(`Table '${appId}' ready`);
            }

            await connection.query(
                `INSERT IGNORE INTO \`_migrations\` (\`version\`) VALUES (?)`,
                [DATABASE.SCHEMA_VERSION]
            );

        } finally {
            await connection.end();
        }
    }

    // ---- Tenant registry ---------------------------------------------------

    /**
     * Ensure the registry table exists.
     * Idempotent, and safe in `connect` mode: the registry is the service's own
     * bookkeeping, not part of the operator's pre-existing schema.
     */
    async ensureRegistry() {
        this.assertReady();
        await this.pool.query(APP_REGISTRY_DDL);
    }

    /**
     * App IDs registered in the database.
     * @returns {Promise<string[]>}
     */
    async listRegisteredApps() {
        this.assertReady();
        await this.ensureRegistry();

        const [rows] = await this.pool.query(
            `SELECT app_id FROM \`${APP_REGISTRY_TABLE}\` ORDER BY app_id ASC`
        );
        // Filtered on the way out as well as in: a row written by an older
        // build, or by hand, must not become a table identifier unchecked.
        return rows.map((row) => row.app_id).filter(isValidAppId);
    }

    /**
     * Provision a new app: validate, create its table, record it.
     *
     * Idempotent — re-registering an existing app is a no-op rather than an
     * error, so a retried provisioning call cannot fail halfway.
     *
     * @param {string} appId
     * @param {string[]} [origins] site origins permitted to write to it
     * @returns {Promise<{appId: string, created: boolean}>}
     * @throws {Error} ErrorType.INVALID_APP_ID for an unsafe identifier
     */
    async registerApp(appId, origins = []) {
        this.assertReady();

        // The gate. Everything downstream interpolates this into DDL/DML.
        if (!isValidAppId(appId)) {
            throw getError(ErrorType.INVALID_APP_ID, { appId });
        }

        await this.ensureRegistry();

        const [existing] = await this.pool.query(
            `SELECT app_id FROM \`${APP_REGISTRY_TABLE}\` WHERE app_id = ? LIMIT 1`,
            [appId]
        );

        // The table is (re)created regardless, so an app registered before its
        // table existed still converges to a working state.
        await this.pool.query(appTableDDL(appId));

        if (existing.length > 0) {
            logWarning(WarningType.APP_ALREADY_REGISTERED, { appId });
            return { appId, created: false };
        }

        await this.pool.query(
            `INSERT INTO \`${APP_REGISTRY_TABLE}\` (id, app_id, origins) VALUES (?, ?, ?)`,
            [crypto.randomUUID(), appId, origins.length ? JSON.stringify(origins) : null]
        );

        logger.info(`Registered app '${appId}'`);
        return { appId, created: true };
    }

    /**
     * Per-app origin allowlists recorded in the registry.
     * @returns {Promise<Record<string, string[]>>}
     */
    async loadRegisteredOrigins() {
        this.assertReady();
        await this.ensureRegistry();

        const [rows] = await this.pool.query(
            `SELECT app_id, origins FROM \`${APP_REGISTRY_TABLE}\` WHERE origins IS NOT NULL`
        );

        const map = {};
        for (const row of rows) {
            // mysql2 returns a JSON column already parsed; tolerate a string
            // for drivers or mocks that do not.
            const value = typeof row.origins === 'string' ? JSON.parse(row.origins) : row.origins;
            if (Array.isArray(value) && value.length) map[row.app_id] = value;
        }
        return map;
    }

    /**
     * Register a view/event with all tracking data.
     *
     * Every value is bound as a parameter. `appId` is the sole interpolated
     * identifier and is only ever reached after the caller has checked it
     * against the configured allowlist.
     */
    async registerEvent(appId, data) {
        this.assertReady();

        const {
            ip,
            country,
            deviceSize,
            pagePath,
            pageTitle,
            referrer,
            referrerDomain,
            sourceType,
            browser,
            browserVersion,
            os,
            osVersion,
            deviceType,
            sessionId,
            eventType = EVENT_TYPE.PAGEVIEW,
            eventData,
            uniqueWindowHours = SERVER.DEFAULT_UNIQUE_VISITOR_WINDOW_HOURS,
            userAgent = '',
            visitorSecret,
        } = data;

        // Privacy boundary. Neither the raw IP nor the raw User-Agent is bound
        // into any statement below; only the masked address and the keyed,
        // rotating hash derived from them.
        const hashedVisitor = PrivacyUtils.generateVisitorHash(
            ip,
            userAgent,
            visitorSecret,
            uniqueWindowHours,
        );
        const maskedIp = PrivacyUtils.maskIP(ip);

        let isUnique = 1;
        if (uniqueWindowHours > 0 && eventType === EVENT_TYPE.PAGEVIEW) {
            const [existing] = await this.pool.query(
                `SELECT id FROM \`${appId}\`
                 WHERE visitor_hash = ? AND event_type = ? AND timestamp > DATE_SUB(NOW(), INTERVAL ? HOUR)
                 LIMIT 1`,
                [hashedVisitor, EVENT_TYPE.PAGEVIEW, uniqueWindowHours]
            );

            if (existing.length > 0) {
                isUnique = 0;
            }
        }

        const [result] = await this.pool.query(
            `INSERT INTO \`${appId}\` (
                masked_ip, visitor_hash, country, timestamp, devicesize,
                page_path, page_title,
                referrer, referrer_domain, source_type,
                browser, browser_version, os, os_version, device_type,
                session_id, event_type, event_data, is_unique
            ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                truncate(maskedIp, FIELD_MAX_LENGTH.MASKED_IP),
                hashedVisitor,
                truncate(country, FIELD_MAX_LENGTH.COUNTRY),
                truncate(deviceSize, FIELD_MAX_LENGTH.DEVICE_SIZE),
                truncate(pagePath, FIELD_MAX_LENGTH.PAGE_PATH),
                truncate(pageTitle, FIELD_MAX_LENGTH.PAGE_TITLE),
                truncate(referrer, FIELD_MAX_LENGTH.REFERRER),
                truncate(referrerDomain, FIELD_MAX_LENGTH.REFERRER_DOMAIN),
                truncate(sourceType, FIELD_MAX_LENGTH.SOURCE_TYPE),
                truncate(browser, FIELD_MAX_LENGTH.BROWSER),
                truncate(browserVersion, FIELD_MAX_LENGTH.BROWSER_VERSION),
                truncate(os, FIELD_MAX_LENGTH.OS),
                truncate(osVersion, FIELD_MAX_LENGTH.OS_VERSION),
                truncate(deviceType, FIELD_MAX_LENGTH.DEVICE_TYPE),
                truncate(sessionId, FIELD_MAX_LENGTH.SESSION_ID),
                truncate(eventType, FIELD_MAX_LENGTH.EVENT_TYPE),
                eventData ? JSON.stringify(eventData) : null,
                isUnique,
            ]
        );

        return {
            duplicate: isUnique === 0,
            insertId: result.insertId,
            isUnique: isUnique === 1,
        };
    }

    /**
     * Register a view (backward compatible wrapper)
     */
    async registerView(appId, ip, country, deviceSize, uniqueWindowHours, visitorSecret) {
        return this.registerEvent(appId, {
            ip,
            country,
            deviceSize,
            uniqueWindowHours,
            visitorSecret,
        });
    }

    /**
     * Get statistics for an app
     */
    async getStats(appId) {
        this.assertReady();

        const [totalStats] = await this.pool.query(
            `SELECT
                COUNT(*) as total_views,
                SUM(CASE WHEN is_unique = 1 THEN 1 ELSE 0 END) as unique_views,
                COUNT(DISTINCT visitor_hash) as unique_visitors
             FROM \`${appId}\``
        );

        const stats = totalStats[0];

        const [byCountry] = await this.pool.query(
            `SELECT country, COUNT(*) as count FROM \`${appId}\`
             WHERE country IS NOT NULL
             GROUP BY country
             ORDER BY count DESC
             LIMIT ?`,
            [TOP_N_RESULTS]
        );

        const [byDevice] = await this.pool.query(
            `SELECT devicesize, COUNT(*) as count FROM \`${appId}\`
             GROUP BY devicesize
             ORDER BY count DESC`
        );

        const [recent] = await this.pool.query(
            `SELECT COUNT(*) as count FROM \`${appId}\`
             WHERE timestamp > DATE_SUB(NOW(), INTERVAL ? HOUR)`,
            [SERVER.DEFAULT_UNIQUE_VISITOR_WINDOW_HOURS]
        );

        return {
            totalViews: stats.total_views,
            uniqueViews: stats.unique_views,
            uniqueVisitors: stats.unique_visitors,
            last24Hours: recent[0].count,
            byCountry,
            byDevice,
        };
    }

    /**
     * Get recent views with pagination
     */
    async getViews(appId, limit = QUERY_LIMITS.VIEWS_LIMIT_DEFAULT, offset = QUERY_LIMITS.OFFSET_DEFAULT) {
        this.assertReady();

        const [views] = await this.pool.query(
            `SELECT masked_ip, country, timestamp, devicesize
             FROM \`${appId}\`
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [limit, offset]
        );

        const [total] = await this.pool.query(
            `SELECT COUNT(*) as count FROM \`${appId}\``
        );

        return {
            views,
            total: total[0].count,
            limit,
            offset,
        };
    }

    /**
     * Get time-based trends.
     *
     * `groupBy` is chosen from three hard-coded literals, never built from
     * caller input, so the interpolation below cannot carry user data.
     */
    async getTrends(appId, period = TREND_PERIOD.DAILY, days = QUERY_LIMITS.TREND_DAYS_DEFAULT) {
        this.assertReady();

        let groupBy;
        if (period === TREND_PERIOD.HOURLY) {
            groupBy = 'DATE_FORMAT(timestamp, "%Y-%m-%d %H:00:00")';
        } else if (period === TREND_PERIOD.WEEKLY) {
            groupBy = 'DATE_FORMAT(timestamp, "%Y-%u")';
        } else {
            groupBy = 'DATE(timestamp)';
        }

        const [trends] = await this.pool.query(
            `SELECT ${groupBy} as period, COUNT(*) as count
             FROM \`${appId}\`
             WHERE timestamp > DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY period
             ORDER BY period ASC`,
            [days]
        );

        return trends;
    }

    /**
     * Get referrer statistics
     */
    async getReferrerStats(appId, limit = QUERY_LIMITS.LIST_LIMIT_DEFAULT) {
        this.assertReady();

        const [bySource] = await this.pool.query(
            `SELECT source_type, COUNT(*) as count
             FROM \`${appId}\`
             WHERE source_type IS NOT NULL
             GROUP BY source_type
             ORDER BY count DESC`
        );

        const [byDomain] = await this.pool.query(
            `SELECT referrer_domain, COUNT(*) as count
             FROM \`${appId}\`
             WHERE referrer_domain IS NOT NULL
             GROUP BY referrer_domain
             ORDER BY count DESC
             LIMIT ?`,
            [limit]
        );

        return { bySource, byDomain };
    }

    /**
     * Get browser/OS statistics
     */
    async getBrowserStats(appId) {
        this.assertReady();

        const [byBrowser] = await this.pool.query(
            `SELECT browser, COUNT(*) as count
             FROM \`${appId}\`
             WHERE browser IS NOT NULL
             GROUP BY browser
             ORDER BY count DESC
             LIMIT ?`,
            [TOP_N_RESULTS]
        );

        const [byOS] = await this.pool.query(
            `SELECT os, COUNT(*) as count
             FROM \`${appId}\`
             WHERE os IS NOT NULL
             GROUP BY os
             ORDER BY count DESC
             LIMIT ?`,
            [TOP_N_RESULTS]
        );

        const [byDeviceType] = await this.pool.query(
            `SELECT device_type, COUNT(*) as count
             FROM \`${appId}\`
             WHERE device_type IS NOT NULL
             GROUP BY device_type
             ORDER BY count DESC`
        );

        return { byBrowser, byOS, byDeviceType };
    }

    /**
     * Get page statistics
     */
    async getPageStats(appId, limit = QUERY_LIMITS.LIST_LIMIT_DEFAULT) {
        this.assertReady();

        const [pages] = await this.pool.query(
            `SELECT page_path, page_title, COUNT(*) as views
             FROM \`${appId}\`
             WHERE page_path IS NOT NULL
             GROUP BY page_path, page_title
             ORDER BY views DESC
             LIMIT ?`,
            [limit]
        );

        return pages;
    }

    /**
     * Get session details.
     * Returns an explicit column list; `visitor_hash` is never exposed.
     */
    async getSessionDetails(appId, sessionId) {
        this.assertReady();

        const [events] = await this.pool.query(
            `SELECT ${SESSION_COLUMNS}
             FROM \`${appId}\`
             WHERE session_id = ?
             ORDER BY timestamp ASC`,
            [sessionId]
        );

        return events;
    }

    /**
     * Health check
     */
    async healthCheck() {
        if (!this.pool) {
            return { healthy: false, error: 'Pool not initialized' };
        }

        try {
            await this.pool.query('SELECT 1');
            return { healthy: true };
        } catch (cause) {
            return { healthy: false, error: cause.message };
        }
    }

    /**
     * Gracefully close all connections
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            logger.info('Database connections closed');
        }
    }
}

module.exports = DatabaseManager;
module.exports.SESSION_COLUMNS = SESSION_COLUMNS;
module.exports.appTableDDL = appTableDDL;
module.exports.APP_REGISTRY_DDL = APP_REGISTRY_DDL;
