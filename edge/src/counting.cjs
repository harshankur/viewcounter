/**
 * viewcounter edge Worker: counts page views without anything running in the
 * visitor's browser. This file holds the logic, in CommonJS so that the
 * repository's Jest can test it as it is; index.js is the Workers entry
 * point, and wrangler's bundler pulls this file in.
 *
 * Deployed in front of a site (Cloudflare Workers routes), it passes every
 * request through to the site unchanged. For each HTML page it served, it then
 * reports the page view to viewcounter's POST /edge/view, server to server,
 * after the visitor already has the page. The report carries only what the
 * request for the page carried, and less: its URL as an origin, a path, the
 * query parameters the site's pages are told apart by, and the campaign
 * tags; its Referer as an origin and a path; the visitor's address, user
 * agent, Sec-CH-UA-Mobile, and Accept-Language. Nothing is read
 * from or stored on the visitor's device, and no cookie or other header is
 * forwarded. viewcounter keeps a masked address and coarse details.
 *
 * Configuration (wrangler.jsonc, and the dashboard for the secret):
 *   VIEWCOUNTER_URL  where viewcounter runs, e.g. https://views.example.com
 *   SITES            JSON: hostname -> appId, or hostname -> [{ "prefix": "/blog/",
 *                    "app": "blog" }, { "prefix": "/", "app": "site" }], where the
 *                    longest matching path prefix wins. A site whose pages differ
 *                    only in their query (/?post=hello) names those parameters:
 *                    hostname -> { "app": "blog", "query": ["post"] }, and a
 *                    prefix rule takes "query" too (as the tracker's data-query)
 *   EDGE_SECRET      the server's EDGE_SECRET, set with `wrangler secret put EDGE_SECRET`
 *   RESPECT_DNT      "true": report nothing for a browser that sends Do Not Track
 *                    or Global Privacy Control (as the tracker's data-respect-dnt)
 *   CAMPAIGNS        "false": leave the URL's campaign tags out (as the
 *                    tracker's data-campaigns)
 *
 * A report that fails, for any reason, is dropped: it never delays or changes
 * what the visitor gets.
 */

/** viewcounter's endpoint for edge reports. */
const REPORT_PATH = '/edge/view';
/** A report that takes longer than this is abandoned. */
const REPORT_TIMEOUT_MS = 5000;

const HTML = 'text/html';
/** The answer to a browser revalidating a page it already holds: a page view all the same. */
const NOT_MODIFIED = 304;
/** The campaign tags of a page URL, reported with the site's page parameters (SITES "query") and nothing else of its query. */
const UTM_PARAMETERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
/** A Do Not Track or Global Privacy Control header that says no. */
const OPTED_OUT = '1';
const DOCUMENT = 'document';
/** A path naming a file that is not an HTML page, such as /report.pdf or /logo.png. */
const FILE_NOT_PAGE = /\.(?!html?$)[a-z0-9]{1,5}$/i;
/** Sec-Fetch-Mode of a navigation: what a page load is, and an iframe's or a fetch's is not. */
const NAVIGATE = 'navigate';
/** Speculative loads the browser may never show: not a view until they are. */
const SPECULATIVE = /prefetch|prerender/i;

/**
 * Whether a request and the site's response to it are a page view: a GET for
 * a top-level page, not a prefetch or prerender, answered with an HTML page.
 *
 * A top-level page is Sec-Fetch-Dest: document, with Sec-Fetch-Mode: navigate
 * where the browser sends the mode; a browser too old to send either is
 * trusted when its Accept asks for HTML. Answered with HTML means a 2xx with
 * Content-Type: text/html, or 304 Not Modified, the answer to a returning
 * visitor's browser revalidating a page it holds, which carries no content
 * type. Without a type, only the request says it was a page: a 304 counts
 * on Sec-Fetch-Dest: document alone, never on the Accept fallback, and not
 * for a path that names another kind of file (a PDF or an image opened in a
 * tab is a document too).
 *
 * @param {Request} request
 * @param {Response} response
 * @returns {boolean}
 */
function shouldCount(request, response) {
    if (request.method !== 'GET') return false;

    const dest = request.headers.get('sec-fetch-dest');
    const mode = request.headers.get('sec-fetch-mode');
    if (mode !== null && mode.toLowerCase() !== NAVIGATE) return false;
    const isDocument = dest !== null && dest.toLowerCase() === DOCUMENT;
    const topLevel = dest === null
        ? (request.headers.get('accept') || '').toLowerCase().includes(HTML)
        : isDocument;
    if (!topLevel) return false;

    const purpose = `${request.headers.get('sec-purpose') || ''} ${request.headers.get('purpose') || ''}`;
    if (SPECULATIVE.test(purpose)) return false;

    if (response.status === NOT_MODIFIED) return isDocument && !FILE_NOT_PAGE.test(new URL(request.url).pathname);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return response.ok && type === HTML;
}

/**
 * Whether the visitor asked not to be counted and the site honours it
 * (RESPECT_DNT): Do Not Track or Global Privacy Control set to 1.
 *
 * @param {Request} request
 * @param {{ RESPECT_DNT?: string }} env
 * @returns {boolean}
 */
function optedOut(request, env) {
    if (String(env.RESPECT_DNT) !== 'true') return false;
    return request.headers.get('dnt') === OPTED_OUT || request.headers.get('sec-gpc') === OPTED_OUT;
}

/**
 * A page URL as it is reported: its origin, its path, the query parameters
 * the site names as part of its pages (sorted by name, as viewcounter keeps
 * them), and its campaign tags (unless
 * CAMPAIGNS is "false"). The rest of a query string can carry tokens or
 * emails, and the fragment never reaches a server at all.
 *
 * @param {URL} url
 * @param {{ CAMPAIGNS?: string }} env
 * @param {string[]} [pageQuery] the site's page parameters, e.g. ["post"]
 * @returns {string}
 */
function reportedUrl(url, env, pageQuery = []) {
    const kept = new URLSearchParams();
    for (const name of pageQuery) {
        const value = url.searchParams.get(name);
        if (value) kept.set(name, value);
    }
    kept.sort();
    if (String(env.CAMPAIGNS) !== 'false') {
        for (const name of UTM_PARAMETERS) {
            const value = url.searchParams.get(name);
            if (value !== null) kept.set(name, value);
        }
    }
    const query = kept.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/**
 * The page before, as it is reported: its origin and path, as the tracker
 * sends it, or '' for none or anything but an http(s) page.
 *
 * @param {string|null} referer the Referer header
 * @returns {string}
 */
function reportedReferrer(referer) {
    try {
        const url = new URL(referer || '');
        return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : '';
    } catch {
        return '';
    }
}

/** Parsed SITES, by the raw value they came from, so each isolate parses it once. */
const parsedSites = new Map();

/**
 * SITES as an object, from the JSON string it is configured as (or an object,
 * as a wrangler var may also be). Anything unreadable maps no site, so nothing
 * is counted rather than everything breaking.
 *
 * @param {string|object|undefined} raw
 * @returns {Record<string, string|object>}
 */
function parseSites(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    if (!parsedSites.has(raw)) {
        let sites = {};
        try {
            const value = JSON.parse(raw);
            if (value && typeof value === 'object' && !Array.isArray(value)) sites = value;
        } catch {
            // Unreadable: no site is counted.
        }
        parsedSites.set(raw, sites);
    }
    return parsedSites.get(raw);
}

/** A query parameter a site may name as part of its pages; never a campaign tag, which is kept apart. */
const PAGE_QUERY_NAME = /^(?!utm_)[A-Za-z0-9_.-]{1,64}$/;
/** As many page parameters as viewcounter accepts in one report. */
const MAX_PAGE_QUERY = 10;

/**
 * A site's page parameters as configured: the valid names, in their order.
 * Anything else in the list is ignored rather than sent and refused.
 *
 * @param {unknown} query
 * @returns {string[]}
 */
function pageQueryOf(query) {
    if (!Array.isArray(query)) return [];
    return [...new Set(query.filter((name) => typeof name === 'string' && PAGE_QUERY_NAME.test(name)))].slice(0, MAX_PAGE_QUERY);
}

/**
 * The site a page belongs to: its hostname's app and page parameters, or, for
 * a hostname split by path, those of the longest prefix the path starts with.
 *
 * @param {Record<string, string|{ app: string, query?: string[] }|{ prefix: string, app: string, query?: string[] }[]>} sites
 * @param {URL} url
 * @returns {{ app: string, query: string[] }|null}
 */
function siteFor(sites, url) {
    const host = url.hostname.toLowerCase();
    const entry = Object.hasOwn(sites, host) ? sites[host] : undefined;
    if (typeof entry === 'string') return entry ? { app: entry, query: [] } : null;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return typeof entry.app === 'string' && entry.app ? { app: entry.app, query: pageQueryOf(entry.query) } : null;
    }
    if (!Array.isArray(entry)) return null;

    let best = null;
    for (const rule of entry) {
        if (!rule || typeof rule.prefix !== 'string' || typeof rule.app !== 'string' || !rule.app) continue;
        if (!url.pathname.startsWith(rule.prefix)) continue;
        if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
    return best ? { app: best.app, query: pageQueryOf(best.query) } : null;
}

/**
 * The app a page belongs to (see siteFor).
 *
 * @param {Record<string, string|object>} sites
 * @param {URL} url
 * @returns {string|null}
 */
function appFor(sites, url) {
    const site = siteFor(sites, url);
    return site ? site.app : null;
}

/**
 * What viewcounter is told about one page view: what the request carried,
 * reduced to what is kept, and nothing else.
 *
 * @param {Request} request
 * @param {string} appId
 * @param {{ CAMPAIGNS?: string }} [env]
 * @param {string[]} [pageQuery] the site's page parameters, e.g. ["post"]
 * @returns {{ appId: string, url: string, referrer: string, ip: string|null, userAgent: string,
 *   mobile?: string, acceptLanguage?: string, pageQuery?: string[] }}
 */
function payload(request, appId, env = {}, pageQuery = []) {
    const header = (name) => request.headers.get(name);
    return {
        appId,
        url: reportedUrl(new URL(request.url), env, pageQuery),
        // Which of the URL's parameters viewcounter keeps as part of the page; left out for none.
        pageQuery: pageQuery.length ? pageQuery : undefined,
        referrer: reportedReferrer(header('referer')),
        ip: header('cf-connecting-ip'),
        userAgent: header('user-agent') || '',
        // Left out when the browser sent none.
        mobile: header('sec-ch-ua-mobile') ?? undefined,
        acceptLanguage: header('accept-language') ?? undefined,
    };
}

/**
 * Report one page view to viewcounter. Never throws: a report that fails or
 * times out is dropped.
 *
 * @param {Request} request the visitor's request for the page
 * @param {string} appId
 * @param {{ VIEWCOUNTER_URL?: string, EDGE_SECRET?: string }} env
 * @param {typeof fetch} [send] fetch, injectable for tests
 * @param {string[]} [pageQuery] the site's page parameters, e.g. ["post"]
 * @returns {Promise<void>}
 */
async function report(request, appId, env, send = fetch, pageQuery = []) {
    try {
        const body = payload(request, appId, env, pageQuery);
        // Without the visitor's address (a local `wrangler dev`, say) there is no view to count.
        if (!body.ip || !env.VIEWCOUNTER_URL || !env.EDGE_SECRET) return;
        const response = await send(`${String(env.VIEWCOUNTER_URL).replace(/\/+$/, '')}${REPORT_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${env.EDGE_SECRET}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
        });
        // Nothing to read in the answer; let its connection go.
        await response.body?.cancel();
    } catch {
        // Dropped: the visitor already has the page.
    }
}

/**
 * Serve a request: pass it to the site, and, when the answer is a page view of
 * a configured site, report it once the visitor has it.
 *
 * @param {Request} request
 * @param {{ VIEWCOUNTER_URL?: string, SITES?: string, EDGE_SECRET?: string }} env
 * @param {{ waitUntil: (promise: Promise<unknown>) => void }} ctx
 * @param {typeof fetch} [send] fetch, injectable for tests
 * @returns {Promise<Response>} the site's response, unchanged
 */
async function handle(request, env, ctx, send = fetch) {
    const response = await send(request);
    try {
        if (shouldCount(request, response) && !optedOut(request, env)) {
            const site = siteFor(parseSites(env.SITES), new URL(request.url));
            if (site) ctx.waitUntil(report(request, site.app, env, send, site.query));
        }
    } catch {
        // Counting must never cost the visitor their page.
    }
    return response;
}

module.exports = {
    REPORT_PATH, REPORT_TIMEOUT_MS, shouldCount, optedOut, reportedUrl, reportedReferrer, parseSites, siteFor, appFor, payload, report, handle,
};
