/**
 * Coarse, identifier-free context about a view, read from what the request
 * already carries. Each value is reduced to the least that answers an
 * analytics question, so none of them narrows a visitor down on its own:
 *
 *   - language: the primary subtag of the first Accept-Language entry ("en",
 *     never "en-GB;q=0.9,de;q=0.8", whose full list is a fingerprinting signal);
 *   - hostname: which of the app's registered sites was visited;
 *   - UTM tags: the five campaign parameters, and only those. The rest of a
 *     landing URL's query string can carry emails, tokens, or IDs, so the
 *     tracker never sends it and the server never reads it, except the
 *     parameters a site names as part of its pages (pageQuery).
 */

const { URLSearchParams } = require('node:url');

const { FIELD_MAX_LENGTH } = require('../constants');

/** The query parameters a campaign link carries, in the order they are shown. */
const UTM_PARAMETERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

const LANGUAGE_SUBTAG = /^[a-z]{2,8}$/;

/**
 * @param {string|undefined} acceptLanguage the Accept-Language header
 * @returns {string|null} e.g. "en"
 */
function primaryLanguage(acceptLanguage) {
    if (typeof acceptLanguage !== 'string') return null;
    const first = acceptLanguage.split(',')[0].split(';')[0].trim();
    const subtag = first.split('-')[0].toLowerCase();
    return LANGUAGE_SUBTAG.test(subtag) && subtag.length <= FIELD_MAX_LENGTH.LANGUAGE ? subtag : null;
}

/**
 * @param {string|null|undefined} origin e.g. "https://www.example.com"
 * @returns {string|null} e.g. "www.example.com"
 */
function hostnameOf(origin) {
    if (typeof origin !== 'string' || origin === '') return null;
    try {
        const hostname = new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
        return hostname && hostname.length <= FIELD_MAX_LENGTH.HOSTNAME ? hostname : null;
    } catch {
        return null;
    }
}

/**
 * The UTM tags of a request, trimmed; absent or blank ones are null.
 * Validation has already bounded each to FIELD_MAX_LENGTH.UTM.
 *
 * @param {Record<string, unknown>} params the query string or body
 * @returns {{ utmSource: string|null, utmMedium: string|null, utmCampaign: string|null,
 *   utmTerm: string|null, utmContent: string|null }}
 */
function utmTags(params = {}) {
    const read = (name) => {
        const value = params[name];
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed.slice(0, FIELD_MAX_LENGTH.UTM);
    };
    return {
        utmSource: read('utm_source'),
        utmMedium: read('utm_medium'),
        utmCampaign: read('utm_campaign'),
        utmTerm: read('utm_term'),
        utmContent: read('utm_content'),
    };
}

/**
 * A URL, if it is an absolute http(s) one.
 * @param {unknown} value
 * @returns {URL|null}
 */
function httpUrl(value) {
    if (typeof value !== 'string' || value === '') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

/**
 * A page address reduced to its origin and path, as the tracker sends the
 * page before: its query and fragment can carry tokens or emails, and any
 * user name or password in it never leaves memory either. Anything that is
 * not an http(s) URL is dropped.
 *
 * @param {unknown} value e.g. a Referer header
 * @returns {string} e.g. "https://www.example.com/post", or '' for none
 */
function originAndPath(value) {
    const url = httpUrl(value);
    return url ? `${url.origin}${url.pathname}` : '';
}

/**
 * The campaign tags of a page URL's query, as utmTags reads them from a
 * request: the first value of each, trimmed and bounded.
 * @param {URL} url
 */
function urlUtmTags(url) {
    return utmTags(Object.fromEntries(UTM_PARAMETERS.map((name) => [name, url.searchParams.get(name)])));
}

/**
 * The query parameters that are part of a page, for a site whose pages differ
 * only in their query ("/?post=hello"): the named ones the URL has, in the
 * order they are named, each with its first value, and nothing else. The
 * tracker builds a page the same way, so both see one page alike.
 *
 * @param {URL} url
 * @param {string[]} [names] already validated
 * @returns {string} e.g. "?post=hello", or '' for none
 */
function pageQuery(url, names = []) {
    const kept = new URLSearchParams();
    for (const name of names) {
        const value = url.searchParams.get(name);
        if (value) kept.set(name, value);
    }
    const query = kept.toString();
    return query ? `?${query}` : '';
}

module.exports = { UTM_PARAMETERS, primaryLanguage, hostnameOf, utmTags, httpUrl, originAndPath, urlUtmTags, pageQuery };
