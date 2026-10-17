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
 * request for the page carried: its URL, its Referer, the visitor's address,
 * user agent, Sec-CH-UA-Mobile, and Accept-Language. Nothing is read from or
 * stored on the visitor's device, and no cookie or other header is forwarded.
 * viewcounter keeps only the path and campaign tags of the URL, the page
 * before as an origin and a path, a masked address, and coarse details.
 *
 * Configuration (wrangler.jsonc, and the dashboard for the secret):
 *   VIEWCOUNTER_URL  where viewcounter runs, e.g. https://views.example.com
 *   SITES            JSON: hostname -> appId, or hostname -> [{ "prefix": "/blog/",
 *                    "app": "blog" }, { "prefix": "/", "app": "site" }], where the
 *                    longest matching path prefix wins
 *   EDGE_SECRET      the server's EDGE_SECRET, set with `wrangler secret put EDGE_SECRET`
 *
 * A report that fails, for any reason, is dropped: it never delays or changes
 * what the visitor gets.
 */

/** viewcounter's endpoint for edge reports. */
const REPORT_PATH = '/edge/view';
/** A report that takes longer than this is abandoned. */
const REPORT_TIMEOUT_MS = 5000;

const HTML = 'text/html';
const DOCUMENT = 'document';
/** Speculative loads the browser may never show: not a view until they are. */
const SPECULATIVE = /prefetch|prerender/i;

/**
 * Whether a request and the site's response to it are a page view: a GET for
 * a top-level page (Sec-Fetch-Dest: document, or, from a browser too old to
 * send that, an Accept that asks for HTML), not a prefetch or prerender, and
 * answered with an HTML page.
 *
 * @param {Request} request
 * @param {Response} response
 * @returns {boolean}
 */
function shouldCount(request, response) {
    if (request.method !== 'GET') return false;

    const dest = request.headers.get('sec-fetch-dest');
    const topLevel = dest === null
        ? (request.headers.get('accept') || '').toLowerCase().includes(HTML)
        : dest.toLowerCase() === DOCUMENT;
    if (!topLevel) return false;

    const purpose = `${request.headers.get('sec-purpose') || ''} ${request.headers.get('purpose') || ''}`;
    if (SPECULATIVE.test(purpose)) return false;

    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return response.ok && type === HTML;
}

/** Parsed SITES, by the raw value they came from, so each isolate parses it once. */
const parsedSites = new Map();

/**
 * SITES as an object, from the JSON string it is configured as (or an object,
 * as a wrangler var may also be). Anything unreadable maps no site, so nothing
 * is counted rather than everything breaking.
 *
 * @param {string|object|undefined} raw
 * @returns {Record<string, string|{ prefix: string, app: string }[]>}
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

/**
 * The app a page belongs to: its hostname's app, or, for a hostname split by
 * path, the app of the longest prefix the path starts with.
 *
 * @param {Record<string, string|{ prefix: string, app: string }[]>} sites
 * @param {URL} url
 * @returns {string|null}
 */
function appFor(sites, url) {
    const host = url.hostname.toLowerCase();
    const entry = Object.hasOwn(sites, host) ? sites[host] : undefined;
    if (typeof entry === 'string') return entry || null;
    if (!Array.isArray(entry)) return null;

    let best = null;
    for (const rule of entry) {
        if (!rule || typeof rule.prefix !== 'string' || typeof rule.app !== 'string' || !rule.app) continue;
        if (!url.pathname.startsWith(rule.prefix)) continue;
        if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
    return best ? best.app : null;
}

/**
 * What viewcounter is told about one page view: what the request carried, and
 * nothing else.
 *
 * @param {Request} request
 * @param {string} appId
 * @returns {{ appId: string, url: string, referrer: string, ip: string|null, userAgent: string,
 *   mobile?: string, acceptLanguage?: string }}
 */
function payload(request, appId) {
    const header = (name) => request.headers.get(name);
    return {
        appId,
        url: request.url,
        referrer: header('referer') || '',
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
 * @returns {Promise<void>}
 */
async function report(request, appId, env, send = fetch) {
    try {
        const body = payload(request, appId);
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
        if (shouldCount(request, response)) {
            const appId = appFor(parseSites(env.SITES), new URL(request.url));
            if (appId) ctx.waitUntil(report(request, appId, env, send));
        }
    } catch {
        // Counting must never cost the visitor their page.
    }
    return response;
}

module.exports = { REPORT_PATH, REPORT_TIMEOUT_MS, shouldCount, parseSites, appFor, payload, report, handle };
