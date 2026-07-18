/**
 * Global constants.
 *
 * Per agent-instructions CODE_STANDARDS.md §0/§1: any literal carrying meaning
 * that is used by more than one module lives here, once. A value typed inline
 * at two call sites is a value that will eventually disagree with itself.
 */

/** Human-facing product name. Never derived from the repo or package name. */
const APP_NAME = 'ViewCounter';

/** Machine-safe identifier, for storage keys, headers, and log prefixes. */
const APP_SLUG = 'viewcounter';

const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
};

/**
 * Maximum accepted length per field, mirroring the column widths in
 * db/schema.sql. Validation rejects anything longer at the boundary so a
 * request can never reach MySQL and fail with a 1406 (strict mode) or be
 * silently truncated (non-strict mode).
 */
const FIELD_MAX_LENGTH = {
    MASKED_IP: 45,
    VISITOR_HASH: 64,
    COUNTRY: 2,
    DEVICE_SIZE: 20,
    PAGE_PATH: 500,
    PAGE_TITLE: 200,
    REFERRER: 500,
    REFERRER_DOMAIN: 200,
    SOURCE_TYPE: 20,
    BROWSER: 50,
    BROWSER_VERSION: 20,
    OS: 50,
    OS_VERSION: 20,
    DEVICE_TYPE: 20,
    SESSION_ID: 64,
    EVENT_TYPE: 50,
};

/** Bounds for user-supplied pagination and range parameters. */
const QUERY_LIMITS = {
    VIEWS_LIMIT_MIN: 1,
    VIEWS_LIMIT_MAX: 100,
    VIEWS_LIMIT_DEFAULT: 50,
    OFFSET_MIN: 0,
    OFFSET_MAX: 1_000_000,
    OFFSET_DEFAULT: 0,
    LIST_LIMIT_MIN: 1,
    LIST_LIMIT_MAX: 100,
    LIST_LIMIT_DEFAULT: 20,
    TREND_DAYS_MIN: 1,
    TREND_DAYS_MAX: 365,
    TREND_DAYS_DEFAULT: 30,
};

/** Rows returned by the fixed "top N" aggregates. */
const TOP_N_RESULTS = 10;

/** Payload ceilings. Checked before any deep inspection (CODE_STANDARDS §6). */
const PAYLOAD_LIMITS = {
    /** Total JSON body. Well below body-parser's 100kb default. */
    MAX_BODY_BYTES: 16 * 1024,
    /** Serialized `eventData` blob accepted on POST /event. */
    MAX_EVENT_DATA_BYTES: 4 * 1024,
};

const DATABASE = {
    CONNECTION_LIMIT: 10,
    /** Finite, so a saturated pool sheds load instead of queueing forever. */
    QUEUE_LIMIT: 50,
    /** Per-statement ceiling; stops one expensive aggregate pinning a worker. */
    QUERY_TIMEOUT_MS: 5_000,
    CONNECT_TIMEOUT_MS: 10_000,
    DEFAULT_PORT: 3306,
    SCHEMA_VERSION: 'enhanced_schema_v3',
};

const SERVER = {
    DEFAULT_PORT: 3030,
    DEFAULT_RATE_LIMIT_WINDOW_MS: 60_000,
    DEFAULT_RATE_LIMIT_MAX: 100,
    /**
     * Per-app ceiling on the write endpoints, so one tenant's traffic cannot
     * consume the shared budget every other tenant depends on. Sits above the
     * per-IP limit, which stays as the single-abuser backstop.
     */
    DEFAULT_APP_RATE_LIMIT_MAX: 1_000,
    DEFAULT_UNIQUE_VISITOR_WINDOW_HOURS: 24,
    /** Grace period for in-flight requests before the process exits. */
    SHUTDOWN_TIMEOUT_MS: 10_000,
};

const PRIVACY = {
    /** Bytes of CSPRNG entropy in the persisted visitor-hash secret. */
    SECRET_BYTES: 32,
    /** Owner-only. The secret is what makes visitor hashes irreversible. */
    SECRET_FILE_MODE: 0o600,
    SECRET_FILENAME: '.visitor-secret',
    /** Rejects a key short enough to be guessable. */
    MIN_API_KEY_LENGTH: 32,
    /**
     * Admin keys are a separate tier from read keys (SECURITY.md §3): leaking a
     * tenant's read key must never grant the ability to provision new apps, and
     * revoking one tier must not force rotation of the other.
     */
    MIN_ADMIN_KEY_LENGTH: 32,
};

/** Recognised event types. `pageview` is the only one the server itself emits. */
const EVENT_TYPE = {
    PAGEVIEW: 'pageview',
};

/** Valid `period` values for the trends endpoint. */
const TREND_PERIOD = {
    HOURLY: 'hourly',
    DAILY: 'daily',
    WEEKLY: 'weekly',
};

const TREND_PERIODS = Object.values(TREND_PERIOD);

/** Traffic classification assigned by utils/referrerParser.js. */
const SOURCE_TYPE = {
    DIRECT: 'direct',
    SEARCH: 'search',
    SOCIAL: 'social',
    EMAIL: 'email',
    CAMPAIGN: 'campaign',
    REFERRAL: 'referral',
    UNKNOWN: 'unknown',
};

const DEVICE_TYPE = {
    MOBILE: 'mobile',
    TABLET: 'tablet',
    WEARABLE: 'wearable',
    TV: 'tv',
    CONSOLE: 'console',
    DESKTOP: 'desktop',
};

const NODE_ENV = {
    DEVELOPMENT: 'development',
    TEST: 'test',
    PRODUCTION: 'production',
};

/** Header carrying the read-API credential. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Scope value granting a key access to every app.
 * Anything else is an explicit list of app IDs.
 */
const SCOPE_ALL = '*';

/**
 * An app ID becomes a MySQL table name, interpolated into DDL and DML because
 * identifiers cannot be bound as parameters. Until now app IDs only ever came
 * from trusted local config; they can now arrive over HTTP from the admin API,
 * so the character set is restricted to what is unambiguously safe as an
 * identifier. This is the gate — not a nicety.
 *
 * Letters, digits, underscore, and hyphen only. A backtick is the sole
 * character that can terminate a quoted identifier, and none of these can;
 * hyphens are permitted because `my-blog` is a normal name and excluding them
 * would break existing deployments for no security benefit.
 */
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Reserved prefix for the service's own tables (`_migrations`, `_apps`). */
const RESERVED_TABLE_PREFIX = '_';

/** Internal registry of dynamically provisioned apps. */
const APP_REGISTRY_TABLE = '_apps';

/**
 * Owner-only. `dbInfo.json`, `allowed.json`, and `.env` all carry database
 * credentials; the setup wizard used to write them world-readable.
 */
const CONFIG_FILE_MODE = 0o600;

/**
 * Credential values that must never be accepted in a non-development
 * environment. A missing config file used to silently produce exactly these.
 */
const INSECURE_DEFAULTS = {
    DB_USER: 'root',
    DB_PASSWORD: '',
    APP_ID: 'example_app',
};

module.exports = {
    APP_NAME,
    APP_SLUG,
    HTTP_STATUS,
    FIELD_MAX_LENGTH,
    QUERY_LIMITS,
    TOP_N_RESULTS,
    PAYLOAD_LIMITS,
    DATABASE,
    SERVER,
    PRIVACY,
    EVENT_TYPE,
    TREND_PERIOD,
    TREND_PERIODS,
    SOURCE_TYPE,
    DEVICE_TYPE,
    NODE_ENV,
    API_KEY_HEADER,
    SCOPE_ALL,
    APP_ID_PATTERN,
    RESERVED_TABLE_PREFIX,
    APP_REGISTRY_TABLE,
    CONFIG_FILE_MODE,
    INSECURE_DEFAULTS,
};
