/**
 * Cookie header parsing.
 *
 * Small enough to own rather than pull in a dependency for, and strict about
 * what it accepts: a malformed pair is skipped, never thrown on, because the
 * header is attacker-controlled input.
 */

/** Bounds the work one request can cause here. */
const MAX_COOKIE_PAIRS = 64;

/**
 * Parse a `Cookie` request header into a name -> value map.
 *
 * The first occurrence of a name wins, matching how browsers order cookies
 * (most specific path first) and denying a later, attacker-planted duplicate.
 * Values that are not valid percent-encoding are kept verbatim.
 *
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
    const cookies = Object.create(null);
    if (typeof header !== 'string' || header.length === 0) return cookies;

    const pairs = header.split(';').slice(0, MAX_COOKIE_PAIRS);
    for (const pair of pairs) {
        const separator = pair.indexOf('=');
        if (separator <= 0) continue;

        const name = pair.slice(0, separator).trim();
        if (!name || name in cookies) continue;

        let value = pair.slice(separator + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            value = value.slice(1, -1);
        }
        try {
            cookies[name] = decodeURIComponent(value);
        } catch {
            cookies[name] = value;
        }
    }
    return cookies;
}

module.exports = { parseCookies, MAX_COOKIE_PAIRS };
