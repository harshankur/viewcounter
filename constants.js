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
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
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
    /** Free-text admin annotation on a single view. */
    NOTE: 1000,
    /** CHAR(36): the canonical textual form of a UUID. */
    UUID: 36,
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
    SCHEMA_VERSION: 'admin_schema_v4',
    /** Rows given a public_id per statement when backfilling an old table. */
    BACKFILL_BATCH_SIZE: 500,
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

/**
 * Admin UI and API.
 *
 * The admin tier is a separate credential from both read keys and
 * ADMIN_API_KEYS (SECURITY.md §3): it can read, edit, and delete every app's
 * data, which neither of the other tiers may do.
 */
const ADMIN = {
    /** Where the UI and its API are mounted. */
    PATH_PREFIX: '/admin',
    /** Relative to PATH_PREFIX. */
    API_PATH: '/api',
    SESSION_COOKIE: 'vc_admin_session',
    CSRF_HEADER: 'x-csrf-token',
    /** Long enough that the login rate limit makes guessing hopeless. */
    MIN_PASSWORD_LENGTH: 16,
    /** Longest submitted password even looked at; bounds the comparison cost. */
    MAX_PASSWORD_INPUT_LENGTH: 1024,
    SESSION_TOKEN_BYTES: 32,
    CSRF_TOKEN_BYTES: 32,
    /** Signed out after this long without a request. */
    SESSION_IDLE_TIMEOUT_MS: 30 * 60 * 1000,
    /** Signed out after this long regardless of activity. */
    SESSION_ABSOLUTE_TIMEOUT_MS: 12 * 60 * 60 * 1000,
    /** Oldest sessions are evicted beyond this, bounding memory. */
    MAX_SESSIONS: 50,
    LOGIN_RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
    /** Failed attempts per IP per window. Successful logins do not count. */
    LOGIN_RATE_LIMIT_MAX: 5,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    /** Requests per IP per window across the whole admin surface. */
    RATE_LIMIT_MAX: 600,
    /** Upper bound on the rows one batch operation may touch. */
    MAX_BATCH_IDS: 500,
    /**
     * JSON body ceiling for the admin API. A full batch of MAX_BATCH_IDS
     * UUIDs is about 20 kB on its own, above the public endpoints' limit.
     */
    MAX_BODY_BYTES: 64 * 1024,
    PAGE_SIZES: [25, 50, 100],
    PAGE_SIZE_DEFAULT: 50,
    PAGE_MAX: 100_000,
    SEARCH_MAX_LENGTH: 200,
    DEFAULT_TRASH_RETENTION_DAYS: 30,
    MAX_TRASH_RETENTION_DAYS: 3650,
    /** How often expired trash is checked for. */
    TRASH_PURGE_INTERVAL_MS: 60 * 60 * 1000,
};

/**
 * Date ranges an admin listing and its analysis can be limited to, mapped to
 * a number of days. `all` has no lower bound. Only these values reach SQL.
 */
const ADMIN_RANGE = {
    WEEK: '7d',
    MONTH: '30d',
    QUARTER: '90d',
    YEAR: '1y',
    ALL: 'all',
};

const ADMIN_RANGE_DAYS = {
    [ADMIN_RANGE.WEEK]: 7,
    [ADMIN_RANGE.MONTH]: 30,
    [ADMIN_RANGE.QUARTER]: 90,
    [ADMIN_RANGE.YEAR]: 365,
    [ADMIN_RANGE.ALL]: null,
};

/**
 * Time-series bucket for the admin analysis, chosen from the span of the data
 * actually in the filtered set, so a chart never has thousands of points.
 */
const TREND_BUCKET = {
    DAY: 'day',
    WEEK: 'week',
    MONTH: 'month',
};

/** Largest span, in days, charted per day and per week. */
const TREND_BUCKET_MAX_DAYS = {
    [TREND_BUCKET.DAY]: 92,
    [TREND_BUCKET.WEEK]: 731,
};

/** Rows per breakdown returned by the admin analysis; the rest is "other". */
const ANALYSIS_TOP_N = 8;

/** Which rows an admin listing returns. */
const VIEW_STATUS = {
    ACTIVE: 'active',
    DELETED: 'deleted',
    ALL: 'all',
};

/** Filter on whether an admin has edited a row's content. */
const MODIFIED_FILTER = {
    ANY: 'any',
    MODIFIED: 'modified',
    UNMODIFIED: 'unmodified',
};

const SORT_ORDER = {
    ASC: 'asc',
    DESC: 'desc',
};

/**
 * Columns an admin listing may be sorted by, mapped from the API name to the
 * column. Sorting interpolates the column, so only these values can reach SQL.
 */
const ADMIN_SORT_COLUMNS = {
    timestamp: 'timestamp',
    page: 'page_path',
    country: 'country',
    deviceSize: 'devicesize',
    eventType: 'event_type',
    source: 'source_type',
    browser: 'browser',
    modifiedAt: 'admin_modified_at',
    deletedAt: 'deleted_at',
};

/**
 * Content fields an admin may edit, mapped from the API name to the column.
 *
 * Deliberately excludes everything that records who or when: the masked IP,
 * visitor hash, timestamp, country, and every User-Agent-derived field. An
 * edit can correct what was viewed, never fabricate who viewed it or when.
 * `referrerDomain` and `sourceType` are not editable directly; they are
 * re-derived whenever `referrer` changes, so they can never disagree with it.
 */
const EDITABLE_FIELDS = {
    pagePath: 'page_path',
    pageTitle: 'page_title',
    referrer: 'referrer',
    deviceSize: 'devicesize',
    eventType: 'event_type',
    eventData: 'event_data',
};

/** Every entry in the admin operation log is one of these. */
const ADMIN_ACTION = {
    LOGIN_SUCCEEDED: 'login_succeeded',
    LOGIN_FAILED: 'login_failed',
    LOGOUT: 'logout',
    VIEWS_EDITED: 'views_edited',
    NOTE_SET: 'note_set',
    NOTE_CLEARED: 'note_cleared',
    VIEWS_DELETED: 'views_deleted',
    VIEWS_RESTORED: 'views_restored',
    VIEWS_PURGED: 'views_purged',
    TRASH_AUTO_PURGED: 'trash_auto_purged',
};

/**
 * Machine-readable error codes returned by the admin API. The UI maps each one
 * to a translated message, so no server-side English reaches the screen.
 */
const ADMIN_ERROR_CODE = {
    UNAUTHENTICATED: 'UNAUTHENTICATED',
    INVALID_PASSWORD: 'INVALID_PASSWORD',
    TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
    RATE_LIMITED: 'RATE_LIMITED',
    CSRF_REJECTED: 'CSRF_REJECTED',
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    NOT_FOUND: 'NOT_FOUND',
    SERVER_ERROR: 'SERVER_ERROR',
};

/** Which write endpoint a view-register-log entry came through. */
const VIEW_LOG_SOURCE = {
    REGISTER_VIEW: 'registerView',
    EVENT: 'event',
};

/** Service-owned tables. All carry the reserved `_` prefix. */
const ADMIN_LOG_TABLE = '_admin_log';
const VIEW_LOG_TABLE = '_view_log';

/** Canonical UUID text form, any version. Admin row IDs are validated with it. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Reserved prefix for the service's own tables (`_migrations`, `_apps`, logs). */
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
    ADMIN,
    VIEW_STATUS,
    ADMIN_RANGE,
    ADMIN_RANGE_DAYS,
    TREND_BUCKET,
    TREND_BUCKET_MAX_DAYS,
    ANALYSIS_TOP_N,
    MODIFIED_FILTER,
    SORT_ORDER,
    ADMIN_SORT_COLUMNS,
    EDITABLE_FIELDS,
    ADMIN_ACTION,
    ADMIN_ERROR_CODE,
    VIEW_LOG_SOURCE,
    ADMIN_LOG_TABLE,
    VIEW_LOG_TABLE,
    UUID_PATTERN,
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
