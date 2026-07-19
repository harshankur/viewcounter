const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const {
    DATABASE,
    INSECURE_DEFAULTS,
    NODE_ENV,
    PRIVACY,
    SCOPE_ALL,
    SERVER,
} = require('../constants');
const { filterValidAppIds } = require('../utils/appIdUtils');
const { getError, logWarning, ErrorType, WarningType } = require('../utils/errorUtils');
const { LogLevel } = require('../utils/logger');

const PROJECT_ROOT = path.join(__dirname, '..');
const DB_INFO_PATH = path.join(PROJECT_ROOT, 'dbInfo.json');
const ALLOWED_PATH = path.join(PROJECT_ROOT, 'allowed.json');

/** Values the code falls back to when nothing else supplies one. */
const DEFAULTS = {
    dbInfo: {
        mode: 'connect',
        host: '127.0.0.1',
        port: DATABASE.DEFAULT_PORT,
        database: 'viewcounterdb',
        user: INSECURE_DEFAULTS.DB_USER,
        password: INSECURE_DEFAULTS.DB_PASSWORD,
    },
    allowed: {
        appId: [INSECURE_DEFAULTS.APP_ID],
        deviceSize: ['small', 'medium', 'large'],
        origins: {},
    },
};

/** Parse a comma-separated env var into a trimmed, non-empty list. */
function parseList(raw) {
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

/** Parse an integer env var, falling back when absent or unparseable. */
function parseIntOr(raw, fallback) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read and parse a JSON config file.
 * @returns {object|null} null when absent or unparseable
 */
function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        logWarning(WarningType.CONFIG_FILE_UNREADABLE, { file: path.basename(filePath) });
        return null;
    }
}

/**
 * Resolve one field through the precedence chain, field by field.
 *
 * CONFIG.md §4: never a shallow spread of a nested object. The previous
 * implementation returned the parsed file verbatim, so a `dbInfo.json` missing
 * `host` produced `host: undefined` instead of falling back — and an
 * `allowed.json` missing `appId` produced `undefined`, which then threw on
 * `.join()` at startup.
 *
 * Precedence: config file > environment variable > code default.
 */
function resolveField(fileValue, envValue, defaultValue) {
    if (fileValue !== undefined && fileValue !== null && fileValue !== '') return fileValue;
    if (envValue !== undefined && envValue !== null && envValue !== '') return envValue;
    return defaultValue;
}

/**
 * Unified configuration loader.
 *
 * CONFIG.md §0: this is the only module in the project that reads
 * `process.env`. Everything else imports the resolved object.
 */
class Config {
    constructor(env = process.env) {
        this.env = env;
        this.server = this.loadServerConfig();
        this.dbInfo = this.loadDbInfo();
        this.allowed = this.loadAllowed();
        this.auth = this.loadAuthConfig();
        this.privacy = this.loadPrivacyConfig();
    }

    /**
     * Server, logging, and proxy settings.
     *
     * `nodeEnv` defaults to production. It previously defaulted to
     * development, which is also what the setup wizard wrote into `.env` — and
     * ten route handlers echo raw database error text to the caller when the
     * environment is development. A deploy that forgot to set NODE_ENV leaked
     * table names and SQL fragments to anonymous callers.
     */
    loadServerConfig() {
        const nodeEnv = this.env.NODE_ENV || NODE_ENV.PRODUCTION;

        return {
            port: parseIntOr(this.env.PORT, SERVER.DEFAULT_PORT),
            nodeEnv,
            isProduction: nodeEnv === NODE_ENV.PRODUCTION,
            isTest: nodeEnv === NODE_ENV.TEST,
            logLevel: this.env.LOG_LEVEL || (nodeEnv === NODE_ENV.TEST ? LogLevel.SILENT : LogLevel.INFO),
            trustProxy: this.resolveTrustProxy(),
            corsOrigins: parseList(this.env.CORS_ORIGINS),
            rateLimit: {
                windowMs: parseIntOr(this.env.RATE_LIMIT_WINDOW_MS, SERVER.DEFAULT_RATE_LIMIT_WINDOW_MS),
                max: parseIntOr(this.env.RATE_LIMIT_MAX, SERVER.DEFAULT_RATE_LIMIT_MAX),
                // Per-app ceiling on writes, so one tenant cannot exhaust the
                // budget the others depend on.
                perAppMax: parseIntOr(this.env.APP_RATE_LIMIT_MAX, SERVER.DEFAULT_APP_RATE_LIMIT_MAX),
            },
            uniqueVisitorWindowHours: parseIntOr(
                this.env.UNIQUE_VISITOR_WINDOW_HOURS,
                SERVER.DEFAULT_UNIQUE_VISITOR_WINDOW_HOURS,
            ),
        };
    }

    /**
     * Resolve the Express `trust proxy` setting.
     *
     * Never returns bare `true`. Trusting every hop lets any caller set
     * `X-Forwarded-For` and be believed, which forges geolocation and rotates
     * the rate-limiter key at will. A hop count or an explicit CIDR list binds
     * the trust to the proxy actually in front of this service.
     *
     * @returns {number|string[]|false}
     */
    resolveTrustProxy() {
        const raw = this.env.TRUST_PROXY;
        if (raw === undefined || raw === '') return false;

        const hops = Number.parseInt(raw, 10);
        if (Number.isFinite(hops) && String(hops) === String(raw).trim()) return hops;

        if (raw === 'true' || raw === '*') {
            logWarning(WarningType.PROXY_TRUST_PERMISSIVE, { value: raw });
            // Downgraded to a single hop rather than honoured as-is.
            return 1;
        }

        return parseList(raw);
    }

    /** Database configuration: dbInfo.json > environment > defaults. */
    loadDbInfo() {
        const file = readJsonFile(DB_INFO_PATH) || {};
        const d = DEFAULTS.dbInfo;

        return {
            mode: resolveField(file.mode, this.env.DB_MODE, d.mode),
            host: resolveField(file.host, this.env.DB_HOST, d.host),
            port: parseIntOr(resolveField(file.port, this.env.DB_PORT, d.port), d.port),
            database: resolveField(file.database, this.env.DB_NAME, d.database),
            user: resolveField(file.user, this.env.DB_USER, d.user),
            // Password is the one field where empty is a legitimate explicit
            // value, so it is read directly rather than through resolveField.
            password: file.password ?? this.env.DB_PASSWORD ?? d.password,
        };
    }

    /**
     * Allowed app IDs, device sizes, and per-app origins.
     *
     * `origins` maps an appId to the site origins permitted to write to it.
     * An appId with no entry accepts writes from anywhere, preserving existing
     * behaviour for deployments that have not configured it yet.
     */
    loadAllowed() {
        const file = readJsonFile(ALLOWED_PATH) || {};
        const d = DEFAULTS.allowed;

        /** File list > env list > default, each resolved independently. */
        const resolveList = (fileValue, envValue, fallback) => {
            if (Array.isArray(fileValue) && fileValue.length) return fileValue;
            const fromEnv = parseList(envValue);
            return fromEnv.length ? fromEnv : fallback;
        };

        return {
            // Filtered because every entry becomes a table identifier; a typo
            // in allowed.json should not reach a CREATE TABLE.
            appId: filterValidAppIds(resolveList(file.appId, this.env.ALLOWED_APP_IDS, d.appId)),
            deviceSize: resolveList(file.deviceSize, this.env.ALLOWED_DEVICE_SIZES, d.deviceSize),
            origins: file.origins && typeof file.origins === 'object' ? file.origins : d.origins,
        };
    }

    /**
     * API credentials, resolved into a key -> scope map.
     *
     * Two sources, because they serve different deployments:
     *  - `READ_API_KEYS` (env): unscoped keys that can read every app. This is
     *    the single-operator case — all the apps are yours anyway.
     *  - `apiKeys` in allowed.json: `{ "<key>": ["blog"] }`, scoped to named
     *    apps. This is the multi-tenant case, where one customer's key must
     *    not read another customer's analytics. Use `"*"` for an unscoped key.
     *
     * Admin keys are a separate tier (SECURITY.md §3) and are never implied by
     * a read key, however broadly scoped.
     */
    loadAuthConfig() {
        const longEnough = (key) => key.length >= PRIVACY.MIN_API_KEY_LENGTH;

        /** @type {Record<string, string|string[]>} */
        const readKeyScopes = {};

        for (const key of parseList(this.env.READ_API_KEYS).filter(longEnough)) {
            readKeyScopes[key] = SCOPE_ALL;
        }

        const file = readJsonFile(ALLOWED_PATH) || {};
        if (file.apiKeys && typeof file.apiKeys === 'object') {
            for (const [key, scope] of Object.entries(file.apiKeys)) {
                if (!longEnough(key)) {
                    logWarning(WarningType.API_KEY_TOO_SHORT, { length: key.length });
                    continue;
                }
                if (scope === SCOPE_ALL) {
                    readKeyScopes[key] = SCOPE_ALL;
                } else if (Array.isArray(scope) && scope.length) {
                    readKeyScopes[key] = filterValidAppIds(scope);
                } else {
                    logWarning(WarningType.API_KEY_EMPTY_SCOPE, { scope: String(scope) });
                }
            }
        }

        const adminApiKeys = parseList(this.env.ADMIN_API_KEYS)
            .filter((key) => key.length >= PRIVACY.MIN_ADMIN_KEY_LENGTH);

        return { readKeyScopes, adminApiKeys };
    }

    /**
     * Visitor-hash secret.
     *
     * Env var wins so a container can inject it; otherwise it is generated and
     * persisted on first run. Tests get an ephemeral in-memory secret so the
     * suite never writes to disk.
     */
    loadPrivacyConfig() {
        const secretPath = this.env.VISITOR_SECRET_PATH
            || path.join(PROJECT_ROOT, PRIVACY.SECRET_FILENAME);

        if (this.env.VISITOR_SECRET) {
            return { secretPath, visitorSecret: this.env.VISITOR_SECRET };
        }

        if (this.server.isTest) {
            return {
                secretPath,
                visitorSecret: crypto.randomBytes(PRIVACY.SECRET_BYTES).toString('hex'),
            };
        }

        // Resolved lazily, on first read rather than at construction.
        //
        // This module is imported by index.js, and index.js is the package
        // entry point — so an application that only wants to mount
        // createAnalyticsRouter would otherwise generate and persist a secret
        // purely as a side effect of `require('@harshankur/viewcounter')`, writing it into
        // node_modules where the next `npm ci` wipes it. Embedders supply their
        // own secret to the router, so for them this never resolves at all.
        // The standalone server forces it during validate(), keeping its
        // fail-fast behaviour.
        let cached = null;
        return {
            secretPath,
            get visitorSecret() {
                if (cached === null) {
                    const secretStore = require('../utils/secretStore');
                    cached = secretStore.loadOrCreate(secretPath);
                }
                return cached;
            },
        };
    }

    /**
     * Fail-fast startup validation (CONFIG.md §3, SECURITY.md §1).
     *
     * Refuses to boot a production deployment that is still sitting on the
     * built-in defaults. Previously a completely unconfigured deploy started
     * silently as root@127.0.0.1 with an empty password against appId
     * `example_app`, and looked healthy while doing it.
     *
     * @throws {Error} on the first disqualifying condition
     */
    validate() {
        // Force the lazy visitor secret to resolve now, so a server that cannot
        // persist it fails at startup rather than on its first request.
        void this.privacy.visitorSecret;

        if (!this.server.isProduction) {
            this.warnAboutDevelopmentDefaults();
            return this;
        }

        if (this.dbInfo.user === INSECURE_DEFAULTS.DB_USER
            && this.dbInfo.password === INSECURE_DEFAULTS.DB_PASSWORD) {
            throw getError(ErrorType.CONFIG_INSECURE_DEFAULT, { field: 'dbInfo.user/password' });
        }

        if (!this.dbInfo.database) {
            throw getError(ErrorType.CONFIG_MISSING_REQUIRED, { field: 'dbInfo.database' });
        }

        if (this.allowed.appId.length === 1 && this.allowed.appId[0] === INSECURE_DEFAULTS.APP_ID) {
            throw getError(ErrorType.CONFIG_INSECURE_DEFAULT, { field: 'allowed.appId' });
        }

        if (this.server.corsOrigins.length === 0) {
            throw getError(ErrorType.CONFIG_MISSING_REQUIRED, { field: 'CORS_ORIGINS' });
        }

        if (Object.keys(this.auth.readKeyScopes).length === 0) {
            // Not fatal: a deployment may legitimately want writes only.
            logWarning(WarningType.READ_API_UNPROTECTED);
        }

        return this;
    }

    /** Surface the same problems as warnings outside production. */
    warnAboutDevelopmentDefaults() {
        if (Object.keys(this.auth.readKeyScopes).length === 0) {
            logWarning(WarningType.READ_API_UNPROTECTED);
        }
    }

    /**
     * Config-file presence, for the setup wizard.
     */
    static hasConfigFiles() {
        return {
            hasDbInfo: fs.existsSync(DB_INFO_PATH),
            hasAllowed: fs.existsSync(ALLOWED_PATH),
            hasEither: fs.existsSync(DB_INFO_PATH) || fs.existsSync(ALLOWED_PATH),
        };
    }
}

module.exports = new Config();
module.exports.Config = Config;
module.exports.DEFAULTS = DEFAULTS;
