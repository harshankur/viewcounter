/**
 * App ID validation.
 *
 * An app ID becomes a MySQL table name. Identifiers cannot be bound as query
 * parameters, so they are interpolated — which is safe only because the value
 * is checked here first. App IDs used to come exclusively from local config;
 * the admin API now accepts them over HTTP, so this is a live injection
 * boundary, not a formatting preference.
 */

const { APP_ID_PATTERN, RESERVED_TABLE_PREFIX } = require('../constants');

/**
 * @param {unknown} appId
 * @returns {boolean} true when safe to use as a table identifier
 */
function isValidAppId(appId) {
    if (typeof appId !== 'string') return false;
    // Reserved for the service's own tables (`_migrations`, `_apps`); allowing
    // one would let a caller collide with or shadow internal state.
    if (appId.startsWith(RESERVED_TABLE_PREFIX)) return false;
    return APP_ID_PATTERN.test(appId);
}

/**
 * Filter a list down to app IDs safe to use.
 * Applied to config-sourced lists too: a typo in `allowed.json` should not be
 * able to produce a malformed CREATE TABLE.
 *
 * @param {unknown[]} appIds
 * @returns {string[]}
 */
function filterValidAppIds(appIds) {
    if (!Array.isArray(appIds)) return [];
    return appIds.filter(isValidAppId);
}

module.exports = { isValidAppId, filterValidAppIds };
