/**
 * String helpers shared by the persistence and parsing layers.
 */

/**
 * Truncate a value to a maximum length before it reaches a fixed-width column.
 *
 * Defence in depth behind boundary validation: validation rejects over-length
 * input at the edge, but derived values (a browser version parsed out of a
 * hostile User-Agent, for example) are produced internally and never pass
 * through a validator. Under MySQL strict mode an over-long value is error
 * 1406 and a 500; under non-strict mode it is a silent truncation.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null} null for absent input, so callers can bind it directly
 */
function truncate(value, max) {
    if (value === undefined || value === null || value === '') return null;
    const str = String(value);
    return str.length > max ? str.slice(0, max) : str;
}

/**
 * Byte length of a value once serialized as JSON.
 * Used to bound `eventData` before it is persisted.
 *
 * @param {unknown} value
 * @returns {number}
 */
function jsonByteLength(value) {
    if (value === undefined || value === null) return 0;
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

module.exports = { truncate, jsonByteLength };
