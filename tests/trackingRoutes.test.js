/**
 * The tracking endpoints over HTTP: what a view stores, what engagement
 * updates, and how every request that is not stored is counted for the
 * tracking log. Uses the real router with a recording database stand-in.
 */

const express = require('express');
const request = require('supertest');

const { createAnalyticsRouter, trackingSourceFor } = require('../routes/analytics');
const { PRIVACY, REJECTION_REASON, SOURCE_TYPE, VIEW_LOG_SOURCE } = require('../constants');

const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function build({ perAppMax = 0, registerEvent, city = null } = {}) {
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
            origins: { shop: ['https://shop.example.com'] },
        },
        auth: { readKeyScopes: {}, adminApiKeys: [] },
        privacy: { visitorSecret: 'a'.repeat(PRIVACY.SECRET_BYTES * 2) },
        server: { uniqueVisitorWindowHours: 24, rateLimit: { windowMs: 60_000, perAppMax } },
    };
    const router = createAnalyticsRouter({ config, dbManager, geo: { city } });
    const app = express();
    app.use(express.json());
    app.use(router);
    /** Everything counted so far, as written to the tracking log. */
    const counted = async () => {
        await router.flushRejections();
        return dbManager.logs.recordRejections.mock.calls.flat(2);
    };
    return { app, dbManager, counted };
}

const stored = (dbManager) => dbManager.registerEvent.mock.calls.at(-1)[1];

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
