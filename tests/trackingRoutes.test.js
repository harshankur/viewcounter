/**
 * The tracking endpoints over HTTP: what a view stores, what engagement
 * updates, and how every request that is not stored is counted for the
 * tracking log. Uses the real router with a recording database stand-in.
 */

const express = require('express');
const request = require('supertest');

const { createAnalyticsRouter, trackingSourceFor } = require('../routes/analytics');
const { COLLECTED_BY, EDGE, PAYLOAD_LIMITS, PRIVACY, REJECTION_REASON, SOURCE_TYPE, TRACKING, VIEW_LOG_SOURCE } = require('../constants');
const logger = require('../utils/logger');

const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** The secret an edge Worker presents, when the build turns edge counting on. */
const EDGE_SECRET = 'e'.repeat(48);

function build({ perAppMax = 0, perAppMaxByApp, max, maxByApp, registerEvent, city = null, edge = false, bodyLimit = '1kb' } = {}) {
    const dbManager = {
        healthCheck: async () => ({ healthy: true }),
        registerEvent: jest.fn(registerEvent || (async () => ({ duplicate: false, insertId: 7, publicId: VIEW_ID, isUnique: true }))),
        addEngagement: jest.fn(async () => true),
        logs: { recordRejections: jest.fn(async () => true) },
    };
    const config = {
        allowed: {
            appId: ['blog', 'shop'],
            deviceSize: ['small', 'medium', 'large'],
            origins: { shop: ['https://shop.example.com', 'https://www.shop.example.com'] },
        },
        auth: { readKeyScopes: {}, adminApiKeys: [] },
        privacy: { visitorSecret: 'a'.repeat(PRIVACY.SECRET_BYTES * 2) },
        server: { uniqueVisitorWindowHours: 24, rateLimit: { windowMs: 60_000, perAppMax, perAppMaxByApp, max, maxByApp } },
        edge: edge ? { secret: EDGE_SECRET, enabled: true } : { secret: '', enabled: false },
    };
    const router = createAnalyticsRouter({ config, dbManager, geo: { city } });
    const app = express();
    app.use(express.json({ limit: bodyLimit }));
    app.use(router);
    app.use(router.bodyErrorHandler);
    /** Everything counted so far, as written to the tracking log. */
    const counted = async () => {
        await router.flushRejections();
        return dbManager.logs.recordRejections.mock.calls.flat(2);
    };
    return { app, dbManager, counted };
}

const stored = (dbManager) => dbManager.registerEvent.mock.calls.at(-1)[1];

describe('a body the parser refuses', () => {
    test.each([
        ['malformed JSON', '{"appId": "blog", '],
        ['an oversized body', JSON.stringify({ appId: 'blog', eventType: 'x', eventData: { big: 'y'.repeat(4096) } })],
    ])('%s to /event is answered 4xx and counted as an invalid request', async (_label, body) => {
        const { app, counted } = build();
        const res = await request(app).post('/event').set('Content-Type', 'application/json')
            .set('Origin', 'https://blog.example.com').send(body);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.body).toEqual({ message: 'Malformed or oversized request' });
        expect(await counted()).toEqual([expect.objectContaining({
            source: VIEW_LOG_SOURCE.EVENT, reason: REJECTION_REASON.INVALID_REQUEST, detail: 'body', hostname: 'blog.example.com', requests: 1,
        })]);
    });
});

describe('GET /registerView', () => {
    test('stores the site visited, the language, and the campaign tags, and returns the view ID', async () => {
        const { app, dbManager } = build();
        const res = await request(app)
            .get('/registerView')
            .query({
                appId: 'blog', deviceSize: 'large', page: '/post',
                utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'launch', utm_term: 't', utm_content: 'c',
            })
            .set('Origin', 'https://www.Blog.example.com')
            .set('Accept-Language', 'de-DE,de;q=0.9,en;q=0.8')
            .set('User-Agent', CHROME)
            .expect(200);

        expect(res.body).toEqual({ message: 'Success!', duplicate: false, recorded: true, id: VIEW_ID });
        expect(stored(dbManager)).toMatchObject({
            hostname: 'www.blog.example.com',
            language: 'de',
            utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'launch', utmTerm: 't', utmContent: 'c',
            sourceType: SOURCE_TYPE.CAMPAIGN,
        });
    });

    test('a tagged landing is a campaign even when the click came from a search engine', async () => {
        const { app, dbManager } = build();
        await request(app).get('/registerView')
            .query({ appId: 'blog', deviceSize: 'small', referrer: 'https://www.google.com/', utm_medium: 'cpc' })
            .set('User-Agent', CHROME).expect(200);
        expect(stored(dbManager)).toMatchObject({ referrerDomain: 'www.google.com', sourceType: SOURCE_TYPE.CAMPAIGN });
    });

    test('without tags the source still comes from the referrer', async () => {
        const { app, dbManager } = build();
        await request(app).get('/registerView')
            .query({ appId: 'blog', deviceSize: 'small', referrer: 'https://www.google.com/' })
            .set('User-Agent', CHROME).expect(200);
        expect(stored(dbManager)).toMatchObject({ sourceType: SOURCE_TYPE.SEARCH, utmSource: null, utmMedium: null });
    });

    test.each([
        ['another page of the same site', 'https://blog.example.com/earlier', SOURCE_TYPE.INTERNAL],
        ['the same site with www.', 'https://www.blog.example.com/earlier', SOURCE_TYPE.INTERNAL],
        ['a sibling site', 'https://shop.example.com/', SOURCE_TYPE.REFERRAL],
    ])('a referrer from %s is %s', async (_label, referrer, sourceType) => {
        const { app, dbManager } = build();
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'small', referrer })
            .set('Origin', 'https://blog.example.com').set('User-Agent', CHROME).expect(200);
        expect(stored(dbManager)).toMatchObject({ sourceType, referrer });
    });

    test('a repeat view also returns its ID, so its engagement can be reported', async () => {
        const { app } = build({ registerEvent: async () => ({ duplicate: true, publicId: VIEW_ID }) });
        const res = await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'small' })
            .set('User-Agent', CHROME).expect(200);
        expect(res.body).toMatchObject({ duplicate: true, recorded: true, id: VIEW_ID });
    });

    test('a bot is answered politely, never stored, and counted by name', async () => {
        const { app, dbManager, counted } = build();
        const res = await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' })
            .set('Origin', 'https://blog.example.com').set('User-Agent', GOOGLEBOT).expect(200);
        expect(res.body).toMatchObject({ recorded: false });
        expect(dbManager.registerEvent).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({
            source: VIEW_LOG_SOURCE.REGISTER_VIEW, reason: REJECTION_REASON.BOT, appId: 'blog',
            detail: 'Googlebot', hostname: 'blog.example.com', requests: 1,
        })]);
    });

    test('an unknown app is counted with the app ID that was sent', async () => {
        const { app, counted } = build();
        await request(app).get('/registerView').query({ appId: 'blgo', deviceSize: 'large' }).expect(422);
        expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.UNKNOWN_APP, appId: 'blgo' })]);
    });

    test('an invalid field is counted with its name', async () => {
        const { app, counted } = build();
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'huge' }).expect(422);
        expect(await counted()).toEqual([expect.objectContaining({
            reason: REJECTION_REASON.INVALID_REQUEST, appId: 'blog', detail: 'deviceSize',
        })]);
    });

    test('an over-long campaign tag is refused like any other field', async () => {
        const { app, counted } = build();
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large', utm_source: 'x'.repeat(101) }).expect(422);
        expect(await counted()).toEqual([expect.objectContaining({ detail: 'utm_source' })]);
    });

    test('a site that is not registered for the app is counted with its hostname', async () => {
        const { app, counted } = build();
        await request(app).get('/registerView').query({ appId: 'shop', deviceSize: 'large' })
            .set('Origin', 'https://evil.example.net').expect(403);
        expect(await counted()).toEqual([expect.objectContaining({
            reason: REJECTION_REASON.ORIGIN_NOT_ALLOWED, appId: 'shop', hostname: 'evil.example.net',
        })]);
    });

    test('engagement reports have a per-app budget of their own, so they never cost an app its views', async () => {
        const { app } = build({ perAppMax: 2 });
        const beat = () => request(app).post('/engage').set('User-Agent', CHROME).send({ appId: 'blog', id: VIEW_ID, ms: 1000, scroll: 10 });
        const view = () => request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME);
        await beat().expect(204);
        await beat().expect(204);
        await beat().expect(429);
        // The views' budget is untouched by the three reports...
        await view().expect(200);
        await view().expect(200);
        await view().expect(429);
        // ...and another app's is untouched by both.
        await request(app).post('/engage').set('User-Agent', CHROME).set('Origin', 'https://shop.example.com')
            .send({ appId: 'shop', id: VIEW_ID, ms: 1000, scroll: 10 }).expect(204);
    });

    test('an app with its own budget uses that one; zero lifts the ceiling for it alone', async () => {
        const { app } = build({ perAppMax: 1, perAppMaxByApp: { blog: 3, shop: 0 } });
        const view = (appId, origin) => {
            const call = request(app).get('/registerView').query({ appId, deviceSize: 'large' }).set('User-Agent', CHROME);
            return origin ? call.set('Origin', origin) : call;
        };
        for (let i = 0; i < 3; i += 1) await view('blog').expect(200);
        await view('blog').expect(429);
        for (let i = 0; i < 5; i += 1) await view('shop', 'https://shop.example.com').expect(200);
    });

    test('own budgets work with no general one set', async () => {
        const { app } = build({ perAppMax: 0, perAppMaxByApp: { blog: 1 } });
        const view = () => request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME);
        await view().expect(200);
        await view().expect(429);
    });

    test('the per-app budget running out is counted as rate limited', async () => {
        const { app, counted } = build({ perAppMax: 1 });
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(200);
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(429);
        expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.RATE_LIMITED, detail: 'app', appId: 'blog' })]);
    });

    test('a failure while storing is counted as a server error', async () => {
        const { app, counted } = build({ registerEvent: async () => { throw new TypeError('db down'); } });
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(500);
        expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.SERVER_ERROR })]);
    });

    test('stored views are not counted as rejections', async () => {
        const { app, counted } = build();
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(200);
        expect(await counted()).toEqual([]);
    });
});

describe('region and city', () => {
    const city = { lookup: jest.fn(() => ({ region: 'Bavaria', city: 'Munich' })) };

    test('come from the city database when one is configured, for views and events', async () => {
        const { app, dbManager } = build({ city });
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(200);
        expect(stored(dbManager)).toMatchObject({ region: 'Bavaria', city: 'Munich' });
        await request(app).post('/event').set('User-Agent', CHROME).send({ appId: 'blog', eventType: 'x' }).expect(200);
        expect(stored(dbManager)).toMatchObject({ region: 'Bavaria', city: 'Munich' });
        expect(city.lookup).toHaveBeenCalledWith('127.0.0.1');
    });

    test('are empty without one', async () => {
        const { app, dbManager } = build();
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(200);
        expect(stored(dbManager)).toMatchObject({ region: null, city: null });
    });
});

describe('POST /event', () => {
    test('stores the site and language, and returns the view ID alongside the deprecated insertId', async () => {
        const { app, dbManager } = build();
        const res = await request(app).post('/event')
            .set('Origin', 'https://blog.example.com').set('Accept-Language', 'fr').set('User-Agent', CHROME)
            .send({ appId: 'blog', eventType: 'download', eventData: { file: 'report.pdf' } })
            .expect(200);
        expect(res.body).toMatchObject({ recorded: true, id: VIEW_ID, insertId: 7 });
        expect(stored(dbManager)).toMatchObject({ hostname: 'blog.example.com', language: 'fr', eventType: 'download' });
    });

    test('a bot event is counted, not stored', async () => {
        const { app, dbManager, counted } = build();
        await request(app).post('/event').set('User-Agent', 'curl/8.4.0').send({ appId: 'blog', eventType: 'x' }).expect(200);
        expect(dbManager.registerEvent).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EVENT, reason: 'bot', detail: 'curl' })]);
    });
});

describe('POST /engage', () => {
    const beacon = { appId: 'blog', id: VIEW_ID, ms: 42_000, scroll: 75 };

    test('accepts a sendBeacon text/plain body and records the engagement', async () => {
        const { app, dbManager } = build();
        await request(app).post('/engage').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME)
            .send(JSON.stringify(beacon)).expect(204);
        expect(dbManager.addEngagement).toHaveBeenCalledWith('blog', { viewId: VIEW_ID, engagedMs: 42_000, scrollDepth: 75 });
    });

    test('a report without a scroll depth is accepted and passes none on: the page did not scroll', async () => {
        const { app, dbManager } = build();
        const { scroll, ...timeOnly } = beacon; // eslint-disable-line no-unused-vars
        await request(app).post('/engage').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME)
            .send(JSON.stringify(timeOnly)).expect(204);
        await request(app).post('/engage').set('User-Agent', CHROME).send({ ...timeOnly, scroll: null }).expect(204);
        expect(dbManager.addEngagement).toHaveBeenCalledTimes(2);
        for (const [, engagement] of dbManager.addEngagement.mock.calls) {
            expect(engagement).toEqual({ viewId: VIEW_ID, engagedMs: 42_000, scrollDepth: null });
        }
    });

    test('accepts a JSON body too', async () => {
        const { app, dbManager } = build();
        await request(app).post('/engage').set('User-Agent', CHROME).send(beacon).expect(204);
        expect(dbManager.addEngagement).toHaveBeenCalledTimes(1);
    });

    test('engagement for a view that is gone, trashed, or too old is counted', async () => {
        const { app, dbManager, counted } = build();
        dbManager.addEngagement.mockResolvedValueOnce(false);
        await request(app).post('/engage').set('User-Agent', CHROME).send(beacon).expect(204);
        expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.ENGAGE, reason: REJECTION_REASON.UNKNOWN_VIEW })]);
    });

    test.each([
        ['a body that is not JSON', 'not json', 'appId'],
        ['a JSON array', '[1,2]', 'appId'],
        ['time beyond the limit', JSON.stringify({ ...beacon, ms: 7 * 60 * 60 * 1000 }), 'ms'],
        ['scroll beyond 100%', JSON.stringify({ ...beacon, scroll: 101 }), 'scroll'],
        ['an ID that is not a view ID', JSON.stringify({ ...beacon, id: '42' }), 'id'],
    ])('%s is refused and counted as invalid', async (_label, body, field) => {
        const { app, dbManager, counted } = build();
        await request(app).post('/engage').set('Content-Type', 'text/plain').send(body).expect(422);
        expect(dbManager.addEngagement).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.INVALID_REQUEST, detail: field })]);
    });

    test('an oversized body is refused before it is parsed', async () => {
        const { app, dbManager } = build();
        const res = await request(app).post('/engage').set('Content-Type', 'text/plain').send('x'.repeat(5000));
        expect(res.status).toBe(413);
        expect(dbManager.addEngagement).not.toHaveBeenCalled();
    });

    test('engagement is bound to the app’s registered sites like views are', async () => {
        const { app, dbManager } = build();
        await request(app).post('/engage').set('Origin', 'https://evil.example.net').send({ ...beacon, appId: 'shop' }).expect(403);
        expect(dbManager.addEngagement).not.toHaveBeenCalled();
    });

    test('a bot beacon is counted and ignored', async () => {
        const { app, dbManager, counted } = build();
        await request(app).post('/engage').set('User-Agent', GOOGLEBOT).send(beacon).expect(204);
        expect(dbManager.addEngagement).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({ reason: 'bot' })]);
    });
});

describe('what counts as a tracking request', () => {
    test.each([
        ['/registerView', VIEW_LOG_SOURCE.REGISTER_VIEW],
        ['/event', VIEW_LOG_SOURCE.EVENT],
        ['/engage', VIEW_LOG_SOURCE.ENGAGE],
        ['/edge/view', VIEW_LOG_SOURCE.EDGE],
        ['/Edge/View/', VIEW_LOG_SOURCE.EDGE],
        ['/edge', null],
        ['/stats/blog', null],
        ['/health', null],
        ['/toString', null],
    ])('%s is %s', (path, source) => {
        expect(trackingSourceFor(path)).toBe(source);
    });

    test('refused read requests are never counted', async () => {
        const { app, counted } = build();
        await request(app).get('/stats/blog').expect(503);
        expect(await counted()).toEqual([]);
    });
});

describe('GET /tracker.js', () => {
    test('is JavaScript other sites may load, cached for an hour', async () => {
        const { app } = build();
        const res = await request(app).get('/tracker.js').expect(200);
        expect(res.headers['content-type']).toMatch(/^application\/javascript/);
        expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(res.headers['cache-control']).toBe('public, max-age=3600');
        expect(res.text).toContain('document.currentScript');
        expect(res.headers.etag).toBeTruthy();
        await request(app).get('/tracker.js').set('If-None-Match', res.headers.etag).expect(304);
    });

    test('never reads or writes anything on the visitor’s device', async () => {
        const { app } = build();
        const { text } = await request(app).get('/tracker.js').expect(200);
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    });

    test('loading it is not a tracking request', async () => {
        const { app, counted } = build();
        await request(app).get('/tracker.js').expect(200);
        expect(await counted()).toEqual([]);
    });
});

describe('answers to other sites\' pages', () => {
    const POLICY = 'cross-origin-resource-policy';
    /** The router as the service mounts it: behind helmet, which says same-origin by default. */
    function served(options) {
        const { allowFromOtherSites } = require('../routes/analytics');
        const built = build(options);
        const app = express();
        app.use(require('helmet')());
        app.use(allowFromOtherSites);
        app.use(built.app);
        return { ...built, app };
    }

    test('the engagement beacon is answered cross-origin, so the sending page logs no blocked response', async () => {
        const { app } = served();
        const answer = await request(app).post('/engage').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME)
            .send(JSON.stringify({ appId: 'blog', id: VIEW_ID, ms: 1000 })).expect(204);
        expect(answer.headers[POLICY]).toBe('cross-origin');
    });

    test('so are views and events, and every refusal of a tracking request', async () => {
        const { app } = served({ max: 1 });
        const view = await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(200);
        const invalid = await request(app).post('/event').set('User-Agent', CHROME).send({ appId: 'nope' }).expect(422);
        const tooLarge = await request(app).post('/engage').set('Content-Type', 'text/plain').set('User-Agent', CHROME).send('x'.repeat(4096));
        const limited = await request(app).post('/engage').set('User-Agent', CHROME).send({ appId: 'blog', id: VIEW_ID, ms: 1 });
        const limitedAgain = await request(app).post('/engage').set('User-Agent', CHROME).send({ appId: 'blog', id: VIEW_ID, ms: 1 }).expect(429);
        for (const answer of [view, invalid, tooLarge, limited, limitedAgain]) expect(answer.headers[POLICY]).toBe('cross-origin');
    });

    test('the router sets it by itself, so an embedding application needs nothing for answers the router gives', async () => {
        const built = build();
        const app = express();
        app.use(require('helmet')());
        app.use('/analytics', built.app);
        const answer = await request(app).post('/analytics/engage').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME)
            .send(JSON.stringify({ appId: 'blog', id: VIEW_ID, ms: 1000 })).expect(204);
        expect(answer.headers[POLICY]).toBe('cross-origin');
        expect((await request(app).get('/analytics/health')).headers[POLICY]).toBe('same-origin');
    });

    test('a path the router serves under another spelling is answered the same: /Engage/, /REGISTERVIEW', async () => {
        const { app, counted } = served();
        const beacon = await request(app).post('/Engage/').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME)
            .send(JSON.stringify({ appId: 'blog', id: VIEW_ID, ms: 1000 })).expect(204);
        const view = await request(app).get('/REGISTERVIEW').query({ appId: 'nope', deviceSize: 'large' }).set('User-Agent', CHROME).expect(422);
        expect(beacon.headers[POLICY]).toBe('cross-origin');
        expect(view.headers[POLICY]).toBe('cross-origin');
        // And it is counted as the endpoint it is.
        expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.REGISTER_VIEW })]);
    });

    test('an embedding application can open its own refusals too, by naming where the router is mounted', async () => {
        const { allowTrackingFromOtherSites } = require('../routes/analytics');
        const app = express();
        app.use(require('helmet')());
        app.use(allowTrackingFromOtherSites('/analytics/'));
        // The host's own limiter, ahead of the router, refusing everything.
        app.use((req, res) => res.status(429).json({ message: 'slow down' }));
        const policy = async (method, path) => (await request(app)[method](path)).headers[POLICY];
        expect(await policy('post', '/analytics/engage')).toBe('cross-origin');
        expect(await policy('get', '/Analytics/registerView')).toBe('cross-origin');
        expect(await policy('get', '/analytics/stats/blog')).toBe('same-origin');
        // The host's own routes of the same name, outside the mount, are not touched.
        expect(await policy('post', '/engage')).toBe('same-origin');
        expect(await policy('post', '/analyticsx/engage')).toBe('same-origin');
    });

    test('nothing else is opened up: the health check and the read API stay same-origin', async () => {
        const { app } = served();
        for (const path of ['/health', '/stats/blog', '/apps']) {
            expect((await request(app).get(path)).headers[POLICY]).toBe('same-origin');
        }
    });
});

describe('a request is limited and checked as the app it is stored under', () => {
    const event = (app, { query, body, origin }) => {
        const call = request(app).post('/event').query(query || {}).set('User-Agent', CHROME).send({ eventType: 'click', ...body });
        return origin ? call.set('Origin', origin) : call;
    };

    test('a POST that names another app in its query is still limited as the app in its body', async () => {
        // blog has one request; shop has no ceiling at all.
        const { app, dbManager } = build({ perAppMax: 1, perAppMaxByApp: { shop: 0 } });
        await event(app, { query: { appId: 'shop' }, body: { appId: 'blog' } }).expect(200);
        await event(app, { query: { appId: 'shop' }, body: { appId: 'blog' } }).expect(429);
        expect(dbManager.registerEvent).toHaveBeenCalledTimes(1);
        expect(dbManager.registerEvent.mock.calls[0][0]).toBe('blog');
    });

    test('nor can it borrow another app\'s room per address', async () => {
        const { app } = build({ max: 1, maxByApp: { shop: 50 } });
        const report = () => request(app).post('/engage').query({ appId: 'shop' }).set('User-Agent', CHROME)
            .send({ appId: 'blog', id: VIEW_ID, ms: 1000, scroll: 10 });
        await report().expect(204);
        await report().expect(429);
    });

    test('the origin check reads the body too: an app bound to its sites cannot be written to by naming a free app in the query', async () => {
        const { app, dbManager, counted } = build();
        await event(app, { query: { appId: 'blog' }, body: { appId: 'shop' }, origin: 'https://evil.example.net' }).expect(403);
        expect(dbManager.registerEvent).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.ORIGIN_NOT_ALLOWED, appId: 'shop' })]);
        await event(app, { query: { appId: 'blog' }, body: { appId: 'shop' }, origin: 'https://shop.example.com' }).expect(200);
    });

    test('a GET is the app in its query, whatever a body says', async () => {
        const { app } = build({ perAppMax: 1, perAppMaxByApp: { shop: 0 } });
        const view = () => request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).send({ appId: 'shop' });
        await view().expect(200);
        await view().expect(429);
    });
});

describe('the per-address limit on the real /engage route', () => {
    const beacon = { appId: 'blog', id: VIEW_ID, ms: 1000, scroll: 10 };

    test('a refused report is counted in the tracking log as rate limited by address', async () => {
        const { app, counted } = build({ max: 1 });
        const report = () => request(app).post('/engage').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME).send(JSON.stringify(beacon));
        await report().expect(204);
        await report().expect(429);
        expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.ENGAGE, reason: REJECTION_REASON.RATE_LIMITED, detail: 'ip' })]);
    });

    test('a sendBeacon body names its app, so the app\'s own figure applies', async () => {
        const { app } = build({ max: 1, maxByApp: { blog: 3 } });
        const report = () => request(app).post('/engage').set('Content-Type', 'text/plain;charset=UTF-8').set('User-Agent', CHROME).send(JSON.stringify(beacon));
        for (let i = 0; i < 3; i += 1) await report().expect(204);
        await report().expect(429);
    });

    test('a body too large to read still counts against the address, and is refused for that once the budget is gone', async () => {
        const { app } = build({ max: 2 });
        const huge = () => request(app).post('/engage').set('Content-Type', 'text/plain').set('User-Agent', CHROME).send('x'.repeat(4096));
        await huge().expect(413);
        await huge().expect(413);
        await huge().expect(429);
    });
});

describe('buildPerIpLimiter', () => {
    const { buildPerIpLimiter } = require('../routes/analytics');

    /** The two limiters as the service mounts them: one app-wide, one on POST /engage after its body is read. */
    function appWith(max, maxByApp) {
        const limited = [];
        const config = { windowMs: 60_000, max, maxByApp };
        const app = express();
        app.use(express.json());
        app.use(buildPerIpLimiter(config, (req) => limited.push(req.path)));
        app.post('/engage', buildPerIpLimiter(config, (req) => limited.push(req.path), { engagement: true }));
        app.all(/.*/, (req, res) => res.status(200).json({ ok: true }));
        return { app, limited };
    }
    const view = (app, appId) => request(app).get('/registerView').query({ appId });
    const beat = (app, appId) => request(app).post('/engage').send({ appId });

    test('engagement reports and everything else each get the full budget', async () => {
        const { app, limited } = appWith(2);
        await beat(app, 'blog').expect(200);
        await beat(app, 'blog').expect(200);
        await beat(app, 'blog').expect(429);
        // Readers' heartbeats used theirs up; a page view from the same address still counts.
        await view(app, 'blog').expect(200);
        await request(app).get('/stats/blog').expect(200);
        await view(app, 'blog').expect(429);
        // And the other way round: nothing else can use up the reports' budget.
        expect(limited).toEqual(['/engage', '/registerView']);
    });

    test('a refused request gets the standard answer and headers', async () => {
        const { app } = appWith(1);
        await view(app, 'blog').expect(200);
        const refused = await view(app, 'blog').expect(429);
        expect(refused.body).toEqual({ message: 'Too many requests, please try again later.' });
        expect(refused.headers['ratelimit-limit'] || refused.headers.ratelimit).toBeDefined();
    });

    test('an app with its own figure gets that much room per address, for views and for reports', async () => {
        const { app } = appWith(1, { homepage: 3 });
        for (let i = 0; i < 3; i += 1) await view(app, 'homepage').expect(200);
        await view(app, 'homepage').expect(429);
        for (let i = 0; i < 3; i += 1) await beat(app, 'homepage').expect(200);
        await beat(app, 'homepage').expect(429);
    });

    test('its traffic is counted apart: it neither uses up the address\'s budget for other apps nor borrows from it', async () => {
        const { app } = appWith(1, { homepage: 3 });
        for (let i = 0; i < 3; i += 1) await view(app, 'homepage').expect(200);
        // Three homepage views later, the address still has its one request for the blog...
        await view(app, 'blog').expect(200);
        await view(app, 'blog').expect(429);
        // ...and the blog's refusals do not touch the homepage's own count, which is simply full.
        await view(app, 'homepage').expect(429);
    });

    test('an own figure can be lower than the general one, and an unknown app gets the general one', async () => {
        const { app } = appWith(2, { quiet: 1 });
        await view(app, 'quiet').expect(200);
        await view(app, 'quiet').expect(429);
        await view(app, 'constructor').expect(200);
        await view(app, 'constructor').expect(200);
        await view(app, 'constructor').expect(429);
    });

    test('only a tracking request is limited as an app: a read or admin call cannot name one to borrow its room', async () => {
        const { app } = appWith(1, { homepage: 50 });
        await request(app).get('/stats/blog').query({ appId: 'homepage' }).expect(200);
        await request(app).get('/apps').query({ appId: 'homepage' }).expect(429);
        await request(app).post('/apps').send({ appId: 'homepage' }).expect(429);
        await request(app).get('/tracker.js').query({ appId: 'homepage' }).expect(429);
    });

    test('anything on /engage that is not a report is limited with everything else', async () => {
        const { app } = appWith(1);
        await request(app).get('/engage').expect(200);
        await request(app).put('/engage').send({ appId: 'blog' }).expect(429);
        // The reports' own budget is untouched by those.
        await beat(app, 'blog').expect(200);
    });

    test('zero means no limit: as the general figure, with apps\' own figures still applied', async () => {
        const { app } = appWith(0, { homepage: 2 });
        for (let i = 0; i < 5; i += 1) await view(app, 'blog').expect(200);
        await view(app, 'homepage').expect(200);
        await view(app, 'homepage').expect(200);
        await view(app, 'homepage').expect(429);
    });

    test('zero means no limit: as one app\'s own figure, with the general one still applied to the rest', async () => {
        const { app } = appWith(1, { homepage: 0 });
        for (let i = 0; i < 5; i += 1) await view(app, 'homepage').expect(200);
        for (let i = 0; i < 5; i += 1) await beat(app, 'homepage').expect(200);
        await view(app, 'blog').expect(200);
        await view(app, 'blog').expect(429);
    });

    test('no figure anywhere means no per-address limit at all', async () => {
        const { app } = appWith(0);
        for (let i = 0; i < 5; i += 1) await view(app, 'blog').expect(200);
    });

    /** The general limiter as index.js mounts it, with or without edge counting on. */
    function appWithEdge(edgeEnabled) {
        const app = express();
        app.use(express.json());
        app.use(buildPerIpLimiter({ windowMs: 60_000, max: 1 }, () => {}, { edgeEnabled }));
        app.all(/.*/, (req, res) => res.status(200).json({ ok: true }));
        return app;
    }
    const edgeReport = (app) => request(app).post('/edge/view').send({ appId: 'blog', ip: '198.51.100.1' });

    test('with edge counting on, edge reports are left to their route\'s limiter, by the visitor\'s address', async () => {
        const app = appWithEdge(true);
        for (let i = 0; i < 3; i += 1) await edgeReport(app).expect(200);
        // And they do not use up the Worker address's budget for anything else.
        await view(app, 'blog').expect(200);
        await view(app, 'blog').expect(429);
    });

    test('without it, /edge/view is limited like any path that does not exist', async () => {
        const app = appWithEdge(false);
        await edgeReport(app).expect(200);
        await edgeReport(app).expect(429);
    });

    test('anything on /edge/view that is not a report is limited with everything else', async () => {
        const app = appWithEdge(true);
        await request(app).get('/edge/view').expect(200);
        await request(app).get('/edge/view').expect(429);
    });
});

describe('POST /edge/view', () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    /** What the Worker sends for one page request. */
    const report = (overrides = {}) => ({
        appId: 'shop',
        url: 'https://shop.example.com/cart?utm_source=newsletter&utm_medium=email&token=SECRET&email=a%40b.c#step-2',
        referrer: 'https://www.google.com/search?q=private+words#frag',
        ip: '198.51.100.7',
        userAgent: CHROME,
        mobile: '?0',
        acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8',
        ...overrides,
    });
    const send = (app, body = report(), secret = EDGE_SECRET) => {
        const call = request(app).post('/edge/view').set('User-Agent', 'Cloudflare-Workers');
        return (secret === null ? call : call.set('Authorization', `Bearer ${secret}`)).send(body);
    };

    test('stores a view from what the page request carried, and nothing more', async () => {
        const { app, dbManager, counted } = build({ edge: true });
        const res = await send(app).expect(204);
        expect(res.text).toBe('');
        expect(dbManager.registerEvent).toHaveBeenCalledTimes(1);
        const [appId, data] = dbManager.registerEvent.mock.calls[0];
        expect(appId).toBe('shop');
        expect(data).toMatchObject({
            ip: '198.51.100.7',
            userAgent: CHROME,
            // The path alone: neither the query nor the fragment.
            pagePath: '/cart',
            pageTitle: null,
            // The page before as its origin and path, as the tracker sends it.
            referrer: 'https://www.google.com/search',
            referrerDomain: 'www.google.com',
            // Tagged, so a campaign, whatever the referrer.
            sourceType: SOURCE_TYPE.CAMPAIGN,
            utmSource: 'newsletter', utmMedium: 'email', utmCampaign: null, utmTerm: null, utmContent: null,
            hostname: 'shop.example.com',
            language: 'de',
            deviceSize: 'large',
            browser: 'Chrome',
            deviceType: 'desktop',
            sessionId: null,
            eventType: 'pageview',
            source: VIEW_LOG_SOURCE.EDGE,
            collectedBy: COLLECTED_BY.EDGE,
            mergeWindowSeconds: TRACKING.MERGE_WINDOW_SECONDS,
        });
        expect(JSON.stringify(data)).not.toMatch(/SECRET|a%40b|a@b|step-2|private|frag/);
        expect(await counted()).toEqual([]);
    });

    test.each([
        ['a phone that says so in its client hint', { mobile: '?1', userAgent: CHROME }, 'small'],
        ['a phone known by its user agent', { mobile: null, userAgent: IPHONE }, 'small'],
        ['a desktop browser without the hint', { mobile: undefined }, 'large'],
    ])('the device size comes from %s', async (_label, overrides, size) => {
        const { app, dbManager } = build({ edge: true });
        await send(app, report(overrides)).expect(204);
        expect(stored(dbManager).deviceSize).toBe(size);
    });

    test('a direct visit and a visit from the same site are told apart as for the tracker', async () => {
        const { app, dbManager } = build({ edge: true });
        await send(app, report({ url: 'https://shop.example.com/', referrer: '' })).expect(204);
        expect(stored(dbManager)).toMatchObject({ referrer: null, sourceType: SOURCE_TYPE.DIRECT, pagePath: '/' });
        await send(app, report({ url: 'https://www.shop.example.com/a', referrer: 'https://shop.example.com/b?x=1' })).expect(204);
        expect(stored(dbManager)).toMatchObject({ referrer: 'https://shop.example.com/b', sourceType: SOURCE_TYPE.INTERNAL });
        // Anything but an http(s) page before is no referrer at all.
        await send(app, report({ url: 'https://shop.example.com/c', referrer: 'android-app://com.example/' })).expect(204);
        expect(stored(dbManager)).toMatchObject({ referrer: null, sourceType: SOURCE_TYPE.DIRECT });
    });

    test('an address the Worker gives in IPv4-mapped form is stored as IPv4', async () => {
        const { app, dbManager } = build({ edge: true });
        await send(app, report({ ip: '::ffff:198.51.100.7' })).expect(204);
        expect(stored(dbManager).ip).toBe('198.51.100.7');
    });

    test('needs no Origin and no CORS: it is server to server', async () => {
        const { app } = build({ edge: true });
        const res = await send(app).expect(204);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    describe('the secret', () => {
        test.each([
            ['no Authorization header', null, undefined],
            ['a wrong secret', 'x'.repeat(48), undefined],
            ['a secret one character short', EDGE_SECRET.slice(1), undefined],
            ['another scheme', null, `Basic ${EDGE_SECRET}`],
            ['an empty bearer token', null, 'Bearer '],
        ])('%s is refused with 401, counted, and logged without the header', async (_label, secret, header) => {
            const lines = [];
            logger.configure({ level: logger.LogLevel.DEBUG, writer: (line) => lines.push(line) });
            try {
                const { app, dbManager, counted } = build({ edge: true });
                const call = request(app).post('/edge/view');
                if (header !== undefined) call.set('Authorization', header);
                else if (secret !== null) call.set('Authorization', `Bearer ${secret}`);
                const res = await call.send(report()).expect(401);
                expect(res.body).toEqual({ message: 'Missing or invalid edge secret' });
                expect(dbManager.registerEvent).not.toHaveBeenCalled();
                // Counted, but under no app or site: the body that names them was not authenticated.
                expect(await counted()).toEqual([expect.objectContaining({
                    source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.UNAUTHORIZED, appId: '', hostname: '', requests: 1,
                })]);
                expect(lines.join('\n')).toContain('Rejected an edge report without the right EDGE_SECRET');
                expect(lines.join('\n')).not.toContain('eeeeeeee');
                expect(lines.join('\n')).not.toContain('xxxxxxxx');
            } finally {
                logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} });
            }
        });

        test('the scheme is matched whatever its case', async () => {
            const { app } = build({ edge: true });
            await request(app).post('/edge/view').set('Authorization', `bearer ${EDGE_SECRET}`).send(report()).expect(204);
        });

        test('requests without the secret are limited by their own address; the Worker\'s reports never are', async () => {
            const { app, counted } = build({ edge: true, max: 1 });
            await send(app, report(), 'x'.repeat(48)).expect(401);
            await send(app, report(), 'x'.repeat(48)).expect(429);
            await send(app, report(), null).expect(429);
            // The same address, with the secret, for many visitors.
            for (let i = 1; i <= 3; i += 1) await send(app, report({ ip: `198.51.100.${i}` })).expect(204);
            expect(await counted()).toEqual(expect.arrayContaining([expect.objectContaining({
                source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.RATE_LIMITED, detail: 'ip', appId: '', hostname: '',
            })]));
        });

        test('an unauthenticated report does not spend the app\'s budget', async () => {
            const { app } = build({ edge: true, perAppMax: 1 });
            await send(app, report(), 'x'.repeat(48)).expect(401);
            await send(app, report(), 'x'.repeat(48)).expect(401);
            await send(app).expect(204);
            await send(app, report({ ip: '198.51.100.99' })).expect(429);
        });
    });

    describe('validation', () => {
        test('an unknown app is counted with the app ID sent', async () => {
            const { app, dbManager, counted } = build({ edge: true });
            await send(app, report({ appId: 'shpo' })).expect(422);
            expect(dbManager.registerEvent).not.toHaveBeenCalled();
            expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.UNKNOWN_APP, appId: 'shpo' })]);
        });

        test.each([
            ['a relative URL', { url: '/cart' }, 'url'],
            ['a URL that is not http(s)', { url: 'ftp://shop.example.com/cart' }, 'url'],
            ['a URL that does not parse', { url: 'https://' }, 'url'],
            ['no URL', { url: undefined }, 'url'],
            ['an over-long URL', { url: `https://shop.example.com/${'a'.repeat(2048)}` }, 'url'],
            ['no address', { ip: undefined }, 'ip'],
            ['an over-long address', { ip: '1'.repeat(46) }, 'ip'],
            ['an address that is not a string', { ip: 198 }, 'ip'],
            ['an over-long user agent', { userAgent: 'u'.repeat(1025) }, 'userAgent'],
            ['an over-long referrer', { referrer: `https://a.example/${'r'.repeat(2048)}` }, 'referrer'],
            ['an over-long language list', { acceptLanguage: 'l'.repeat(513) }, 'acceptLanguage'],
            ['a client hint that is not a string', { mobile: true }, 'mobile'],
        ])('%s is refused and counted as invalid', async (_label, overrides, field) => {
            const { app, dbManager, counted } = build({ edge: true, bodyLimit: PAYLOAD_LIMITS.MAX_BODY_BYTES });
            await send(app, report(overrides)).expect(422);
            expect(dbManager.registerEvent).not.toHaveBeenCalled();
            expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.INVALID_REQUEST, detail: field })]);
        });

        test('a page on a site not registered for the app is refused with 403 and counted with its hostname', async () => {
            const { app, dbManager, counted } = build({ edge: true });
            const res = await send(app, report({ url: 'https://evil.example.net/cart' })).expect(403);
            expect(res.body).toEqual({ message: 'The page is not on a site registered for this appId' });
            expect(dbManager.registerEvent).not.toHaveBeenCalled();
            expect(await counted()).toEqual([expect.objectContaining({
                source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.ORIGIN_NOT_ALLOWED, appId: 'shop', hostname: 'evil.example.net',
            })]);
        });

        test('so is a page on another scheme or port of a registered site', async () => {
            const { app } = build({ edge: true });
            await send(app, report({ url: 'http://shop.example.com/cart' })).expect(403);
            await send(app, report({ url: 'https://shop.example.com:8443/cart' })).expect(403);
        });

        test('an app with no sites registered takes no edge reports: there is nothing to check the page against', async () => {
            const { app, counted } = build({ edge: true });
            await send(app, report({ appId: 'blog', url: 'https://blog.example.com/' })).expect(403);
            expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.ORIGIN_NOT_ALLOWED, appId: 'blog' })]);
        });

        test.each([['999.1.1.1'], ['not-an-ip'], ['198.51.100.7, 10.0.0.1']])('the address %s is refused as unreadable', async (ip) => {
            const { app, dbManager, counted } = build({ edge: true });
            const res = await send(app, report({ ip })).expect(400);
            expect(res.body).toEqual({ message: 'Invalid IP address format' });
            expect(dbManager.registerEvent).not.toHaveBeenCalled();
            expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.INVALID_IP })]);
        });

        test('a report with every field at its longest fits the service\'s body limit', async () => {
            const { app } = build({ edge: true, bodyLimit: PAYLOAD_LIMITS.MAX_BODY_BYTES });
            const longest = report({
                url: `https://shop.example.com/${'a'.repeat(EDGE.MAX_URL_LENGTH - 'https://shop.example.com/'.length)}`,
                referrer: `https://r.example/${'r'.repeat(EDGE.MAX_REFERRER_LENGTH - 'https://r.example/'.length)}`,
                userAgent: `${CHROME} ${'u'.repeat(EDGE.MAX_USER_AGENT_LENGTH - CHROME.length - 1)}`,
                acceptLanguage: 'de'.padEnd(EDGE.MAX_ACCEPT_LANGUAGE_LENGTH, ','),
                ip: '0000:0000:0000:0000:0000:ffff:198.051.100.007'.slice(0, EDGE.MAX_IP_LENGTH),
            });
            expect(Buffer.byteLength(JSON.stringify(longest))).toBeLessThan(PAYLOAD_LIMITS.MAX_BODY_BYTES);
            // Accepted as far as the body and its fields go; the address is the one refusal left.
            await send(app, longest).expect(400);
            await send(app, { ...longest, ip: '2001:db8::1' }).expect(204);
        });

        test('absent optional fields are fine, as null or left out', async () => {
            const { app, dbManager } = build({ edge: true });
            await send(app, { appId: 'shop', url: 'https://shop.example.com/', ip: '198.51.100.7', referrer: null, userAgent: null, mobile: null, acceptLanguage: null }).expect(204);
            await send(app, { appId: 'shop', url: 'https://shop.example.com/', ip: '198.51.100.7', userAgent: CHROME }).expect(204);
            expect(stored(dbManager)).toMatchObject({ language: null, referrer: null, sourceType: SOURCE_TYPE.DIRECT });
        });
    });

    test('a bot is answered 204, never stored, and counted by name', async () => {
        const { app, dbManager, counted } = build({ edge: true });
        await send(app, report({ userAgent: GOOGLEBOT })).expect(204);
        expect(dbManager.registerEvent).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({
            source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.BOT, detail: 'Googlebot', appId: 'shop', hostname: 'shop.example.com',
        })]);
    });

    test.each([[null], [''], [undefined]])('a page requested with no user agent (%p) is a script, not a visitor: counted as a bot', async (userAgent) => {
        const { app, dbManager, counted } = build({ edge: true });
        await send(app, report({ userAgent })).expect(204);
        expect(dbManager.registerEvent).not.toHaveBeenCalled();
        expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.BOT, detail: 'no user agent' })]);
    });

    test('neither a bot nor a visitor over the address limit spends the app\'s budget', async () => {
        const { app } = build({ edge: true, perAppMax: 1, max: 1 });
        await send(app, report({ userAgent: GOOGLEBOT })).expect(204);
        await send(app, report({ ip: '203.0.113.1' })).expect(204);
        // The app's one request is gone now; before it, a crawler and the limit took nothing.
        await send(app, report({ ip: '203.0.113.2' })).expect(429);
        const { app: other } = build({ edge: true, perAppMax: 2, max: 1 });
        await send(other, report({ ip: '203.0.113.1' })).expect(204);
        await send(other, report({ ip: '203.0.113.1' })).expect(429);
        // Refused for the visitor's address, so the app's second request is still there.
        await send(other, report({ ip: '203.0.113.2' })).expect(204);
    });

    describe('limits', () => {
        test('the address limit counts the visitor each report names, not the Worker sending them all', async () => {
            const { app, counted } = build({ edge: true, max: 1 });
            await send(app, report({ ip: '198.51.100.1' })).expect(204);
            await send(app, report({ ip: '198.51.100.2' })).expect(204);
            await send(app, report({ ip: '198.51.100.3' })).expect(204);
            await send(app, report({ ip: '198.51.100.1' })).expect(429);
            expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.RATE_LIMITED, detail: 'ip' })]);
        });

        test('one visitor\'s IPv6 /56 is one address, however the last bits vary', async () => {
            const { app } = build({ edge: true, max: 1 });
            await send(app, report({ ip: '2001:db8:1:100::1' })).expect(204);
            await send(app, report({ ip: '2001:db8:1:1ff::2' })).expect(429);
            await send(app, report({ ip: '2001:db8:2::1' })).expect(204);
        });

        test('an app\'s own per-address figure applies', async () => {
            const { app } = build({ edge: true, max: 1, maxByApp: { shop: 3 } });
            for (let i = 0; i < 3; i += 1) await send(app).expect(204);
            await send(app).expect(429);
        });

        test('the app\'s budget is spent as by any view', async () => {
            const { app, counted } = build({ edge: true, perAppMax: 1 });
            await send(app).expect(204);
            await send(app, report({ ip: '198.51.100.99' })).expect(429);
            expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.RATE_LIMITED, detail: 'app' })]);
        });
    });

    test('a failure while storing is counted as a server error', async () => {
        const { app, counted } = build({ edge: true, registerEvent: async () => { throw new TypeError('db down'); } });
        await send(app).expect(500);
        expect(await counted()).toEqual([expect.objectContaining({ source: VIEW_LOG_SOURCE.EDGE, reason: REJECTION_REASON.SERVER_ERROR })]);
    });

    describe('without EDGE_SECRET', () => {
        test('the endpoint does not exist: 404, nothing stored, nothing counted', async () => {
            const { app, dbManager, counted } = build();
            await send(app).expect(404);
            await send(app, report(), null).expect(404);
            expect(dbManager.registerEvent).not.toHaveBeenCalled();
            expect(await counted()).toEqual([]);
        });

        test('nor is a malformed body to it counted', async () => {
            const { app, counted } = build();
            await request(app).post('/edge/view').set('Content-Type', 'application/json').send('{"appId": ').expect(400);
            expect(await counted()).toEqual([]);
        });

        test('and views from the tracker look for nothing to merge with', async () => {
            const { app, dbManager } = build();
            await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large', page: '/', age: 5 }).set('User-Agent', CHROME).expect(200);
            expect(stored(dbManager)).toMatchObject({ collectedBy: COLLECTED_BY.SCRIPT, mergeWindowSeconds: 0 });
        });
    });
});

describe('a page load the edge and the tracker both report', () => {
    const EDGE_VIEW = '33333333-3333-4333-8333-333333333333';

    test('the tracker\'s view merges into the edge\'s, within the window from when the page was loaded', async () => {
        const { app, dbManager } = build({ edge: true, registerEvent: async () => ({ duplicate: false, publicId: EDGE_VIEW, isUnique: true, merged: true }) });
        const res = await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'medium', page: '/post', title: 'Post', age: 300 })
            .set('User-Agent', CHROME).expect(200);
        // The answer has the shape every tracker version reads, with the edge view's ID.
        expect(res.body).toEqual({ message: 'Success!', duplicate: false, recorded: true, id: EDGE_VIEW });
        expect(stored(dbManager)).toMatchObject({
            collectedBy: COLLECTED_BY.SCRIPT, mergeWindowSeconds: TRACKING.MERGE_WINDOW_SECONDS + 300, pageTitle: 'Post', deviceSize: 'medium',
        });

        // So the page's engagement reports attach to the merged view.
        await request(app).post('/engage').set('User-Agent', CHROME).send({ appId: 'blog', id: res.body.id, ms: 5000, scroll: 30 }).expect(204);
        expect(dbManager.addEngagement).toHaveBeenCalledWith('blog', { viewId: EDGE_VIEW, engagedMs: 5000, scrollDepth: 30 });
    });

    test('a tracker that sends no age gets the plain window', async () => {
        const { app, dbManager } = build({ edge: true });
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large', page: '/' }).set('User-Agent', CHROME).expect(200);
        expect(stored(dbManager).mergeWindowSeconds).toBe(TRACKING.MERGE_WINDOW_SECONDS);
    });

    test.each([['-1'], ['86401'], ['1.5'], ['soon']])('an age of %s is refused', async (age) => {
        const { app, counted } = build({ edge: true });
        await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large', age }).set('User-Agent', CHROME).expect(422);
        expect(await counted()).toEqual([expect.objectContaining({ reason: REJECTION_REASON.INVALID_REQUEST, detail: 'age' })]);
    });

    test('a merged repeat view is answered as a repeat', async () => {
        const { app } = build({ edge: true, registerEvent: async () => ({ duplicate: true, publicId: EDGE_VIEW, isUnique: false, merged: true }) });
        const res = await request(app).get('/registerView').query({ appId: 'blog', deviceSize: 'large' }).set('User-Agent', CHROME).expect(200);
        expect(res.body).toEqual({ message: 'View already registered recently', duplicate: true, recorded: true, id: EDGE_VIEW });
    });

    test('custom events never merge', async () => {
        const { app, dbManager } = build({ edge: true });
        await request(app).post('/event').set('User-Agent', CHROME).send({ appId: 'blog', eventType: 'pageview' }).expect(200);
        expect(stored(dbManager).mergeWindowSeconds).toBeUndefined();
    });
});

describe('GET /consent.js', () => {
    test('is JavaScript other sites may load, cached for an hour, like the tracker', async () => {
        const { app } = build();
        const res = await request(app).get('/consent.js').expect(200);
        expect(res.headers['content-type']).toMatch(/^application\/javascript/);
        expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(res.headers['cache-control']).toBe('public, max-age=3600');
        expect(res.text).toContain('window.viewcounterConsent');
        await request(app).get('/consent.js').set('If-None-Match', res.headers.etag).expect(304);
    });

    test('keeps only the answer on the device: no cookie, no session storage, no IndexedDB', async () => {
        const { app } = build();
        const { text } = await request(app).get('/consent.js').expect(200);
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/document\.cookie|sessionStorage|indexedDB/);
        // localStorage, under the one per-app key.
        expect(code.match(/localStorage\.\w+\(/g)).toEqual(['localStorage.getItem(', 'localStorage.setItem(']);
        expect(code).toContain('`viewcounter-consent:${app}`');
    });

    test('loading it is not a tracking request', async () => {
        const { app, counted } = build();
        await request(app).get('/consent.js').expect(200);
        expect(await counted()).toEqual([]);
    });
});
