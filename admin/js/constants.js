/**
 * Front-end constants for the admin UI (CODE_STANDARDS.md §0/§1).
 *
 * Limits that the server enforces (batch size, field lengths, page sizes) are
 * NOT duplicated here: the UI reads them from GET api/meta, so the two can
 * never disagree. What lives here is either UI-only or part of the wire
 * contract; the wire-contract values are checked against constants.js by
 * tests/adminUiContract.test.js.
 */

/** Human-facing product name. Mirrors APP_NAME in the server constants. */
export const APP_NAME = 'ViewCounter';

/** Storage-key namespace. Mirrors APP_SLUG in the server constants. */
export const APP_SLUG = 'viewcounter';

/** Relative to the page, so the UI works wherever the router is mounted. */
export const API_BASE = 'api';

/** Must match ADMIN.CSRF_HEADER on the server. */
export const CSRF_HEADER = 'x-csrf-token';

/** Mirrors ADMIN_ERROR_CODE on the server. */
export const ERROR_CODE = Object.freeze({
    UNAUTHENTICATED: 'UNAUTHENTICATED',
    INVALID_PASSWORD: 'INVALID_PASSWORD',
    TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
    RATE_LIMITED: 'RATE_LIMITED',
    CSRF_REJECTED: 'CSRF_REJECTED',
    REAUTH_REQUIRED: 'REAUTH_REQUIRED',
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    NOT_FOUND: 'NOT_FOUND',
    SERVER_ERROR: 'SERVER_ERROR',
    /** Client-side only: the request never got an answer. */
    NETWORK: 'NETWORK',
    /** Client-side only: the page itself failed (a bug), not the server. */
    UNEXPECTED: 'UNEXPECTED',
    /**
     * Client-side only: a gateway in front of the server (Cloudflare Access,
     * say) answered with a redirect to its own sign-in page.
     */
    ACCESS_EXPIRED: 'ACCESS_EXPIRED',
});

/** Using the UI extends the session at most this often (the server keeps it for days). */
export const SESSION_PING_INTERVAL_MS = 5 * 60 * 1000;

/** How often "Right now" on the Overview refreshes while it is on screen. */
export const REALTIME_REFRESH_MS = 15 * 1000;

/** How often the tracking log refreshes itself when auto-refresh is on. */
export const TRACKING_LOG_REFRESH_MS = 10 * 1000;

/** Where the product lives: shown in the header and footer. */
export const LINKS = Object.freeze({
    WEBSITE: 'https://viewcounter.harshankur.com',
    DOCS_ADMIN: 'https://viewcounter.harshankur.com/#admin',
    SOURCE: 'https://github.com/harshankur/viewcounter',
    CHANGELOG: 'https://github.com/harshankur/viewcounter/blob/master/CHANGELOG.md',
    NPM: 'https://www.npmjs.com/package/@harshankur/viewcounter',
    LICENSE: 'https://github.com/harshankur/viewcounter/blob/master/LICENSE',
});

/** The copyright notice in the footer, as the LICENSE file states it. */
export const COPYRIGHT = Object.freeze({
    YEAR: 2026,
    HOLDER: 'Harsh Ankur',
    HOLDER_URL: 'https://harshankur.com',
});

/** Mirrors VIEW_STATUS on the server. */
export const VIEW_STATUS = Object.freeze({
    ACTIVE: 'active',
    DELETED: 'deleted',
    ALL: 'all',
});

/** Mirrors MODIFIED_FILTER on the server. */
export const MODIFIED_FILTER = Object.freeze({
    ANY: 'any',
    MODIFIED: 'modified',
    UNMODIFIED: 'unmodified',
});

export const SORT_ORDER = Object.freeze({
    ASC: 'asc',
    DESC: 'desc',
});

/** The sections of the UI, in order. */
export const TAB = Object.freeze({
    OVERVIEW: 'overview',
    VIEWS: 'views',
    TRASH: 'trash',
    TRACKING_LOG: 'trackingLog',
    ADMIN_LOG: 'adminLog',
});

/** Each section's address after the #, so a section can be bookmarked. */
export const TAB_HASH = Object.freeze({
    [TAB.OVERVIEW]: 'overview',
    [TAB.VIEWS]: 'views',
    [TAB.TRASH]: 'trash',
    [TAB.TRACKING_LOG]: 'tracking-log',
    [TAB.ADMIN_LOG]: 'admin-log',
});

/** Addresses earlier versions used, still honoured. */
export const LEGACY_TAB_HASH = Object.freeze({
    viewLog: TAB.TRACKING_LOG,
    adminLog: TAB.ADMIN_LOG,
});

export const THEME = Object.freeze({
    LIGHT: 'light',
    DARK: 'dark',
    AUTO: 'auto',
});

export const STORAGE_KEY = Object.freeze({
    THEME: `${APP_SLUG}-admin-theme`,
    LAST_APP: `${APP_SLUG}-admin-last-app`,
    OVERVIEW_RANGE: `${APP_SLUG}-admin-overview-range`,
    OVERVIEW_METRIC: `${APP_SLUG}-admin-overview-metric`,
    OVERVIEW_CARDS: `${APP_SLUG}-admin-overview-cards`,
    /** Followed by a table's name: its chosen columns, their order, and widths. */
    TABLE_PREFIX: `${APP_SLUG}-admin-table-`,
});

/** Geometry of the data tables, in CSS pixels. */
export const TABLE = Object.freeze({
    /** Narrower than this, a table is a list of cards. */
    CARDS_BELOW: 600,
    /** A card shows this many of the chosen columns; the rest are under "more". */
    CARD_FIELDS: 5,
    SELECT_WIDTH: 42,
    /** The column of "more" buttons, present only when some columns do not fit. */
    MORE_WIDTH: 40,
    /** Narrowest and widest a column can be made. */
    MIN_WIDTH: 72,
    MAX_WIDTH: 720,
    /** Arrow keys on a column edge move it this far; with Shift, further. */
    RESIZE_STEP: 16,
    RESIZE_STEP_LARGE: 64,
});

export const TOAST_DURATION_MS = 4000;

/** Wait after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 300;

export const DEFAULT_LOCALE = 'en';

/**
 * Every field a view row exposes, grouped for the details dialog. The group
 * key names its heading (details.groups.*).
 */
export const VIEW_DETAIL_GROUPS = Object.freeze([
    Object.freeze({ key: 'view', fields: Object.freeze(['id', 'timestamp', 'eventType', 'eventData', 'isUnique', 'sessionId']) }),
    Object.freeze({ key: 'page', fields: Object.freeze(['hostname', 'pagePath', 'pageTitle']) }),
    Object.freeze({ key: 'source', fields: Object.freeze([
        'sourceType', 'referrer', 'referrerDomain', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent',
    ]) }),
    Object.freeze({ key: 'visitor', fields: Object.freeze([
        'country', 'region', 'city', 'language', 'maskedIp', 'deviceSize', 'deviceType', 'browser', 'browserVersion', 'os', 'osVersion',
    ]) }),
    Object.freeze({ key: 'engagement', fields: Object.freeze(['engagedMs', 'scrollDepth']) }),
    Object.freeze({ key: 'admin', fields: Object.freeze(['note', 'adminModifiedAt', 'deletedAt']) }),
]);

/** Every field a view row exposes, in display order. */
export const VIEW_DETAIL_FIELDS = Object.freeze(VIEW_DETAIL_GROUPS.flatMap((group) => group.fields));

/** Editable fields rendered as free text, and those rendered otherwise. */
export const TEXT_FIELDS = Object.freeze(['pagePath', 'pageTitle', 'referrer', 'eventType']);
export const DEVICE_SIZE_FIELD = 'deviceSize';
export const EVENT_DATA_FIELD = 'eventData';

/** Rows of the event-data editor. */
export const EVENT_DATA_ROWS = 6;
export const NOTE_ROWS = 4;

/** Two-line clamp for page titles, one line for everything else. */
export const CLAMP_LINES = Object.freeze({ SINGLE: 1, DOUBLE: 2 });

/** Key names the keyboard handlers compare against. */
export const KEY = Object.freeze({
    ESCAPE: 'Escape',
    ENTER: 'Enter',
    SPACE: ' ',
    TAB: 'Tab',
    ARROW_UP: 'ArrowUp',
    ARROW_DOWN: 'ArrowDown',
    ARROW_LEFT: 'ArrowLeft',
    ARROW_RIGHT: 'ArrowRight',
    HOME: 'Home',
    END: 'End',
});

/** Sentinel app selection meaning every app. Not a valid app ID ('*' is refused). */
export const ALL_APPS = '*';

/** Mirrors ADMIN_RANGE on the server. */
export const RANGE = Object.freeze({
    DAY: '24h',
    WEEK: '7d',
    MONTH: '30d',
    QUARTER: '90d',
    YEAR: '1y',
    ALL: 'all',
});

/** Geometry and limits for the insights charts. */
export const CHART = Object.freeze({
    TREND: Object.freeze({
        WIDTH: 720,
        HEIGHT: 220,
        MARGIN: Object.freeze({ top: 12, right: 12, bottom: 28, left: 44 }),
    }),
    /** A stat tile's sparkline. */
    SPARK: Object.freeze({ WIDTH: 120, HEIGHT: 28, PAD: 3 }),
    /** "Right now": one column per minute. */
    MINUTES: Object.freeze({ WIDTH: 300, HEIGHT: 56, GAP: 2, SPAN: 30 }),
    /** Label every third hour across the heatmap. */
    HEATMAP_HOUR_LABEL_EVERY: 3,
    Y_TICKS: 4,
    TICK_GAP: 8,
    X_LABEL_GAP: 18,
    /** r >= 4, so a marker is at least 8px across. */
    DOT_RADIUS: 4,
    TOOLTIP_OFFSET: 12,
    /** Event types listed in a country's tooltip. */
    TOOLTIP_TYPES: 4,
    /** Sequential classes on the map; must match --map-1..5 in admin.css. */
    MAP_CLASSES: 5,
    COUNTRY_LIST_LIMIT: 10,
});

/** JSON indentation in the details and edit dialogs. */
export const JSON_INDENT = 2;
