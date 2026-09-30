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
 *     tracker never sends it and the server never reads it.
 */

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

module.exports = { UTM_PARAMETERS, primaryLanguage, hostnameOf, utmTags };
