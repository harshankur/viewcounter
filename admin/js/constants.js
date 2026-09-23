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
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    NOT_FOUND: 'NOT_FOUND',
    SERVER_ERROR: 'SERVER_ERROR',
    /** Client-side only: the request never got an answer. */
    NETWORK: 'NETWORK',
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

/** The sections of the UI. */
export const TAB = Object.freeze({
    VIEWS: 'views',
    TRASH: 'trash',
    ADMIN_LOG: 'adminLog',
    VIEW_LOG: 'viewLog',
});

export const THEME = Object.freeze({
    LIGHT: 'light',
    DARK: 'dark',
    AUTO: 'auto',
});

export const STORAGE_KEY = Object.freeze({
    THEME: `${APP_SLUG}-admin-theme`,
    LAST_APP: `${APP_SLUG}-admin-last-app`,
});

export const TOAST_DURATION_MS = 4000;

/** Wait after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 300;

export const DEFAULT_LOCALE = 'en';

/** Every field a view row exposes, in display order for the details dialog. */
export const VIEW_DETAIL_FIELDS = Object.freeze([
    'id', 'timestamp', 'pagePath', 'pageTitle', 'referrer', 'referrerDomain', 'sourceType',
    'deviceSize', 'deviceType', 'country', 'maskedIp', 'browser', 'browserVersion', 'os',
    'osVersion', 'sessionId', 'eventType', 'eventData', 'isUnique', 'note', 'adminModifiedAt',
    'deletedAt',
]);

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

/** JSON indentation in the details and edit dialogs. */
export const JSON_INDENT = 2;
