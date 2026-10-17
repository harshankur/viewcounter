/**
 * The edge Worker (edge/src): which requests it counts, for which app, what
 * it reports, and that nothing it does can touch the visitor's response. Runs
 * under Node's own fetch API classes, with fetch and the Worker's ctx
 * injected; no Cloudflare tooling needed.
 *
 * The logic is in counting.cjs, which Jest loads as it is; index.js, the
 * Workers entry point, is an ES module only wiring it up, which Jest cannot
 * load without an experimental flag, so its wiring is checked as text.
 */

const fs = require('fs');
const path = require('path');

const EDGE_DIR = path.join(__dirname, '..', 'edge');
const worker = require('../edge/src/counting.cjs');
const { appFor, handle, optedOut, parseSites, payload, report, reportedReferrer, reportedUrl, shouldCount, REPORT_PATH, REPORT_TIMEOUT_MS } = worker;

const SECRET = 'e'.repeat(40);
const ENV = {
    VIEWCOUNTER_URL: 'https://views.example.com/',
    EDGE_SECRET: SECRET,
    SITES: JSON.stringify({
        'example.com': 'homepage',
        'docs.example.com': [{ prefix: '/blog/', app: 'docsblog' }, { prefix: '/', app: 'docs' }, { prefix: '/blog/archive/', app: 'archive' }],
    }),
};

/** A browser's request for a page, with any header overridden or removed (null). */
function pageRequest(url = 'https://example.com/post?utm_source=feed', headers = {}, method = 'GET') {
    const base = {
        'sec-fetch-dest': 'document',
        accept: 'text/html,application/xhtml+xml',
        referer: 'https://www.google.com/search?q=words',
        'cf-connecting-ip': '198.51.100.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36',
        'sec-ch-ua-mobile': '?0',
        'accept-language': 'de-DE,de;q=0.9',
        cookie: 'session=SECRET-COOKIE',
        authorization: 'Basic SECRET-AUTH',
    };
    const merged = { ...base, ...headers };
    return new Request(url, { method, headers: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)) });
}

const htmlResponse = (init = {}) => new Response('<!doctype html><title>Post</title>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init,
});

/** A fetch that answers the site's request with `site` and records the reports it is sent. */
function fakeFetch(site = htmlResponse(), reportAnswer = () => new Response(null, { status: 204 })) {
    const reports = [];
    const send = jest.fn(async (input, init) => {
        if (input instanceof Request) return site;
        reports.push({ url: input, init, body: JSON.parse(init.body) });
        return reportAnswer();
    });
    return { send, reports };
}

/** The Worker's ctx: collects what it hands to waitUntil. */
function fakeCtx() {
    const pending = [];
    return { pending, waitUntil: jest.fn((promise) => pending.push(promise)) };
}

describe('shouldCount', () => {
    test('a browser\'s GET for a page answered with HTML is a page view', () => {
        expect(shouldCount(pageRequest(), htmlResponse())).toBe(true);
    });

    test('without Sec-Fetch-Dest, an Accept asking for HTML stands in for it', () => {
        expect(shouldCount(pageRequest(undefined, { 'sec-fetch-dest': null }), htmlResponse())).toBe(true);
        expect(shouldCount(pageRequest(undefined, { 'sec-fetch-dest': null, accept: 'application/json' }), htmlResponse())).toBe(false);
        expect(shouldCount(pageRequest(undefined, { 'sec-fetch-dest': null, accept: null }), htmlResponse())).toBe(false);
    });

    test.each([
        ['an iframe', { 'sec-fetch-dest': 'iframe' }],
        ['a script', { 'sec-fetch-dest': 'script' }],
        ['an image', { 'sec-fetch-dest': 'image' }],
        ['a fetch() from the page', { 'sec-fetch-dest': 'empty', accept: '*/*' }],
        ['a prefetch', { 'sec-purpose': 'prefetch' }],
        ['a prerender', { 'sec-purpose': 'prefetch;prerender' }],
        ['a legacy prefetch', { purpose: 'prefetch' }],
    ])('%s is not', (_label, headers) => {
        expect(shouldCount(pageRequest(undefined, headers), htmlResponse())).toBe(false);
    });

    test.each([['HEAD'], ['POST']])('a %s is not', (method) => {
        expect(shouldCount(pageRequest(undefined, {}, method), htmlResponse())).toBe(false);
    });

    test.each([
        ['an error page', htmlResponse({ status: 404 })],
        ['a server error', htmlResponse({ status: 500 })],
        ['a redirect', new Response(null, { status: 301, headers: { location: '/new', 'content-type': 'text/html' } })],
        ['JSON', new Response('{}', { headers: { 'content-type': 'application/json' } })],
        ['XHTML served as something else', new Response('x', { headers: { 'content-type': 'application/xhtml+xml' } })],
        ['no content type', new Response('x')],
    ])('a page answered with %s is not', (_label, response) => {
        expect(shouldCount(pageRequest(), response)).toBe(false);
    });

    test('a page the browser revalidates (304 Not Modified, no content type) is a view all the same', () => {
        expect(shouldCount(pageRequest(), new Response(null, { status: 304 }))).toBe(true);
        // But not for anything that is not a page load.
        expect(shouldCount(pageRequest(undefined, { 'sec-fetch-dest': 'image' }), new Response(null, { status: 304 }))).toBe(false);
        expect(shouldCount(pageRequest(undefined, { 'sec-purpose': 'prefetch' }), new Response(null, { status: 304 }))).toBe(false);
    });

    test('the content type is read whatever its case and parameters', () => {
        expect(shouldCount(pageRequest(), new Response('x', { headers: { 'content-type': 'Text/HTML ; charset=UTF-8' } }))).toBe(true);
    });
});

describe('parseSites and appFor', () => {
    const sites = parseSites(ENV.SITES);
    const app = (url) => appFor(sites, new URL(url));

    test('a hostname maps to its app', () => {
        expect(app('https://example.com/anything')).toBe('homepage');
        expect(app('https://EXAMPLE.com/')).toBe('homepage');
    });

    test('a hostname split by path: the longest matching prefix wins, in any order', () => {
        expect(app('https://docs.example.com/')).toBe('docs');
        expect(app('https://docs.example.com/guide')).toBe('docs');
        expect(app('https://docs.example.com/blog/post')).toBe('docsblog');
        expect(app('https://docs.example.com/blog/archive/2020')).toBe('archive');
        // A prefix is a prefix: "/blog" is not under "/blog/".
        expect(app('https://docs.example.com/blog')).toBe('docs');
    });

    test('a hostname that is not listed, or a www. form not listed, has no app', () => {
        expect(app('https://other.example/')).toBeNull();
        expect(app('https://www.example.com/')).toBeNull();
    });

    test('a path no prefix matches has no app', () => {
        expect(appFor({ 'a.example': [{ prefix: '/only/', app: 'only' }] }, new URL('https://a.example/else'))).toBeNull();
    });

    test('malformed rules are skipped, not trusted', () => {
        const odd = { 'a.example': [null, { prefix: 1, app: 'x' }, { prefix: '/', app: '' }, { prefix: '/', app: 'good' }], 'b.example': '' };
        expect(appFor(odd, new URL('https://a.example/'))).toBe('good');
        expect(appFor(odd, new URL('https://b.example/'))).toBeNull();
        expect(appFor({ 'c.example': 42 }, new URL('https://c.example/'))).toBeNull();
    });

    test('SITES that is not JSON, or not an object, maps nothing', () => {
        expect(parseSites('{not json')).toEqual({});
        expect(parseSites('["a"]')).toEqual({});
        expect(parseSites('null')).toEqual({});
        expect(parseSites(undefined)).toEqual({});
    });

    test('SITES given as an object (a wrangler var may be one) is used as it is', () => {
        const object = { 'a.example': 'a' };
        expect(parseSites(object)).toBe(object);
    });

    test('the same SITES string is parsed once', () => {
        expect(parseSites(ENV.SITES)).toBe(sites);
    });

    test('a hostname named like an object property is not a site', () => {
        expect(appFor(parseSites('{}'), new URL('https://constructor/'))).toBeNull();
    });
});

describe('payload', () => {
    test('is what the request carried, reduced to what is kept, and no cookie or other header', () => {
        const body = payload(pageRequest('https://example.com/post?utm_source=feed&token=T&email=a%40b.c'), 'homepage');
        expect(body).toEqual({
            appId: 'homepage',
            // The path and the campaign tags: the rest of the query never leaves the edge.
            url: 'https://example.com/post?utm_source=feed',
            // The page before as its origin and path, as the tracker sends it.
            referrer: 'https://www.google.com/search',
            ip: '198.51.100.7',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36',
            mobile: '?0',
            acceptLanguage: 'de-DE,de;q=0.9',
        });
        expect(JSON.stringify(body)).not.toMatch(/SECRET-COOKIE|SECRET-AUTH|token|a%40b|words/);
    });

    test('a header the browser did not send is empty or left out', () => {
        const body = payload(pageRequest(undefined, { referer: null, 'user-agent': null, 'sec-ch-ua-mobile': null, 'accept-language': null }), 'homepage');
        expect(body.referrer).toBe('');
        expect(body.userAgent).toBe('');
        expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('mobile');
        expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('acceptLanguage');
    });
});

describe('reportedUrl and reportedReferrer', () => {
    test('a URL keeps its origin, path, and the five campaign tags, the first of each, in their order', () => {
        const url = new URL('https://example.com/a/b?x=1&utm_campaign=launch&utm_source=feed&utm_source=other&utm_term=');
        expect(reportedUrl(url, {})).toBe('https://example.com/a/b?utm_source=feed&utm_campaign=launch&utm_term=');
        expect(reportedUrl(new URL('https://example.com/?q=search'), {})).toBe('https://example.com/');
    });

    test('CAMPAIGNS="false" leaves the tags out too', () => {
        expect(reportedUrl(new URL('https://example.com/p?utm_source=feed'), { CAMPAIGNS: 'false' })).toBe('https://example.com/p');
    });

    test.each([
        ['https://user:pass@www.google.com/search?q=words#frag', 'https://www.google.com/search'],
        ['', ''],
        [null, ''],
        ['android-app://com.example/', ''],
        ['not a url', ''],
    ])('the referrer %p is reported as %p', (referer, expected) => {
        expect(reportedReferrer(referer)).toBe(expected);
    });
});

describe('optedOut', () => {
    test('with RESPECT_DNT, Do Not Track or Global Privacy Control means no report', () => {
        const env = { RESPECT_DNT: 'true' };
        expect(optedOut(pageRequest(undefined, { dnt: '1' }), env)).toBe(true);
        expect(optedOut(pageRequest(undefined, { 'sec-gpc': '1' }), env)).toBe(true);
        expect(optedOut(pageRequest(undefined, { dnt: '0' }), env)).toBe(false);
        expect(optedOut(pageRequest(), env)).toBe(false);
    });

    test('without it, as the tracker without data-respect-dnt, they change nothing', () => {
        expect(optedOut(pageRequest(undefined, { dnt: '1', 'sec-gpc': '1' }), {})).toBe(false);
    });

    test('handle reports nothing for an opted-out visitor and still serves the page', async () => {
        const site = htmlResponse();
        const { send, reports } = fakeFetch(site);
        const ctx = fakeCtx();
        expect(await handle(pageRequest(undefined, { 'sec-gpc': '1' }), { ...ENV, RESPECT_DNT: 'true' }, ctx, send)).toBe(site);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
        expect(reports).toEqual([]);
    });
});

describe('report', () => {
    test('posts the payload to /edge/view with the secret, and a time limit', async () => {
        const { send, reports } = fakeFetch();
        await report(pageRequest(), 'homepage', ENV, send);
        expect(reports).toHaveLength(1);
        const [{ url, init, body }] = reports;
        expect(url).toBe(`https://views.example.com${REPORT_PATH}`);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${SECRET}` });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(body).toMatchObject({ appId: 'homepage', ip: '198.51.100.7' });
        expect(REPORT_TIMEOUT_MS).toBe(5000);
    });

    test.each([
        ['a network failure', async () => { throw new TypeError('fetch failed'); }],
        ['a timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }],
        ['a refusal', async () => new Response('{"message":"Missing or invalid edge secret"}', { status: 401 })],
        ['a server error', async () => new Response('oops', { status: 500 })],
    ])('%s is swallowed', async (_label, answer) => {
        const send = jest.fn(answer);
        await expect(report(pageRequest(), 'homepage', ENV, send)).resolves.toBeUndefined();
    });

    test.each([
        ['without the visitor\'s address', pageRequest(undefined, { 'cf-connecting-ip': null }), ENV],
        ['without VIEWCOUNTER_URL', pageRequest(), { ...ENV, VIEWCOUNTER_URL: '' }],
        ['without EDGE_SECRET', pageRequest(), { ...ENV, EDGE_SECRET: undefined }],
    ])('nothing is sent %s', async (_label, request, env) => {
        const send = jest.fn();
        await report(request, 'homepage', env, send);
        expect(send).not.toHaveBeenCalled();
    });
});

describe('handle', () => {
    test('returns the site\'s response itself, and reports the view after it, through waitUntil', async () => {
        const site = htmlResponse();
        const { send, reports } = fakeFetch(site);
        const ctx = fakeCtx();
        const request = pageRequest();

        const response = await handle(request, ENV, ctx, send);
        expect(response).toBe(site);
        expect(send.mock.calls[0][0]).toBe(request);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
        await Promise.all(ctx.pending);
        expect(reports).toEqual([expect.objectContaining({ body: expect.objectContaining({ appId: 'homepage', url: 'https://example.com/post?utm_source=feed' }) })]);
    });

    test('a hostname split by path reports the app of the page', async () => {
        const { send, reports } = fakeFetch();
        const ctx = fakeCtx();
        await handle(pageRequest('https://docs.example.com/blog/hello'), ENV, ctx, send);
        await Promise.all(ctx.pending);
        expect(reports[0].body.appId).toBe('docsblog');
    });

    test.each([
        ['an asset', pageRequest('https://example.com/app.js', { 'sec-fetch-dest': 'script' }), htmlResponse()],
        ['a page of a site not in SITES', pageRequest('https://unlisted.example/'), htmlResponse()],
        ['a missing page', pageRequest(), htmlResponse({ status: 404 })],
    ])('%s is passed through and not reported', async (_label, request, site) => {
        const { send, reports } = fakeFetch(site);
        const ctx = fakeCtx();
        expect(await handle(request, ENV, ctx, send)).toBe(site);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
        expect(reports).toEqual([]);
    });

    test('a report that fails leaves the visitor\'s response as it was', async () => {
        const site = htmlResponse();
        const ctx = fakeCtx();
        const send = jest.fn(async (input) => {
            if (input instanceof Request) return site;
            throw new TypeError('viewcounter is down');
        });
        expect(await handle(pageRequest(), ENV, ctx, send)).toBe(site);
        await expect(Promise.all(ctx.pending)).resolves.toBeDefined();
    });

    test('unreadable SITES never costs the visitor the page', async () => {
        const site = htmlResponse();
        const { send } = fakeFetch(site);
        const ctx = fakeCtx();
        expect(await handle(pageRequest(), { ...ENV, SITES: '{oops' }, ctx, send)).toBe(site);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
    });

    test('an error from the site\'s own fetch is the site\'s, not swallowed', async () => {
        const send = jest.fn(async () => { throw new TypeError('origin unreachable'); });
        await expect(handle(pageRequest(), ENV, fakeCtx(), send)).rejects.toThrow('origin unreachable');
    });

    test('the entry point hands every request to it, as a Workers module handler', () => {
        const entry = fs.readFileSync(path.join(EDGE_DIR, 'src', 'index.js'), 'utf8');
        expect(entry).toContain("import counting from './counting.cjs';");
        expect(entry).toMatch(/export default \{\s*(\/\*\*[\s\S]*?\*\/\s*)?fetch: \(request, env, ctx\) => counting\.handle\(request, env, ctx\),\s*\};/);
    });
});

describe('wrangler.jsonc', () => {
    const config = JSON.parse(fs.readFileSync(path.join(EDGE_DIR, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

    test('deploys src/index.js, sends no metrics, and is reachable only on its routes', () => {
        expect(config).toMatchObject({
            name: 'viewcounter-edge', main: 'src/index.js', compatibility_date: '2026-10-01',
            send_metrics: false, workers_dev: false, preview_urls: false,
        });
        expect(config.vars).not.toHaveProperty('EDGE_SECRET');
    });

    test('every route\'s hostname has an app in SITES, and SITES nothing without a route', () => {
        const sites = parseSites(config.vars.SITES);
        const routed = config.routes.map((route) => route.pattern.replace(/\/\*$/, ''));
        expect(routed.sort()).toEqual(Object.keys(sites).sort());
        for (const route of config.routes) expect(route.pattern.endsWith(route.zone_name + '/*')).toBe(true);
        expect(appFor(sites, new URL('https://officeparser.harshankur.com/blog/post'))).toBe('officeparserblog');
        expect(appFor(sites, new URL('https://officeparser.harshankur.com/'))).toBe('officeparser');
    });
});
