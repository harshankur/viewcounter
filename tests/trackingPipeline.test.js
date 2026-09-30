/**
 * The pieces of the tracking pipeline that stand on their own: reading the
 * coarse visitor context from a request, and counting what was not stored.
 */

const { primaryLanguage, hostnameOf, utmTags, UTM_PARAMETERS } = require('../utils/visitorContext');
const { createRejectionCounter } = require('../db/rejectionCounter');
const { TRACKING } = require('../constants');

describe('primaryLanguage', () => {
    test.each([
        ['en-GB,en;q=0.9,de;q=0.8', 'en'],
        ['de', 'de'],
        ['PT-br', 'pt'],
        ['fil-PH', 'fil'],
        ['zh-Hant-TW,zh;q=0.9', 'zh'],
        [' fr-CA ; q=1 , en', 'fr'],
    ])('%j reads as %j', (header, expected) => {
        expect(primaryLanguage(header)).toBe(expected);
    });

    test.each([undefined, '', '*', 'x', '12', 'e1', 'toolongsubtag', 'en_US'])(
        '%j gives nothing rather than a guess', (header) => {
            expect(primaryLanguage(header)).toBeNull();
        });
});

describe('hostnameOf', () => {
    test.each([
        ['https://www.Example.com', 'www.example.com'],
        ['https://blog.example.com:8443', 'blog.example.com'],
        ['http://localhost:3000', 'localhost'],
        ['https://example.com.', 'example.com'],
    ])('%j is %j', (origin, expected) => {
        expect(hostnameOf(origin)).toBe(expected);
    });

    test.each([null, undefined, '', 'not a url', 'null'])('%j has no hostname', (origin) => {
        expect(hostnameOf(origin)).toBeNull();
    });
});

describe('utmTags', () => {
    test('reads the five campaign tags, trimmed', () => {
        expect(utmTags({
            utm_source: ' newsletter ', utm_medium: 'email', utm_campaign: 'launch', utm_term: 'analytics', utm_content: 'hero',
        })).toEqual({
            utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'launch', utmTerm: 'analytics', utmContent: 'hero',
        });
    });

    test('ignores everything else in the query, and blank or non-string tags', () => {
        expect(utmTags({ email: 'a@b.c', token: 'secret', utm_source: '', utm_medium: ['x'], utm_campaign: '   ' }))
            .toEqual({ utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null });
    });

    test('names exactly the five standard parameters', () => {
        expect(UTM_PARAMETERS).toEqual(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);
    });
});

describe('createRejectionCounter', () => {
    const MINUTE = TRACKING.REJECTION_BUCKET_MS;
    let written;
    let clock;
    const counter = (options = {}) => createRejectionCounter({
        write: async (rows) => { written.push(...rows); },
        now: () => clock,
        ...options,
    });

    beforeEach(() => {
        jest.useFakeTimers();
        written = [];
        clock = Date.parse('2026-09-30T10:15:20Z');
    });
    afterEach(() => jest.useRealTimers());

    test('counts per minute and key, and writes nothing per request', async () => {
        const c = counter();
        c.count({ source: 'registerView', reason: 'bot', detail: 'Googlebot' });
        c.count({ source: 'registerView', reason: 'bot', detail: 'Googlebot' });
        c.count({ source: 'registerView', reason: 'bot', detail: 'bingbot' });
        expect(written).toEqual([]);

        await c.flush();
        expect(written).toEqual([
            expect.objectContaining({ minute: new Date('2026-09-30T10:15:00Z'), detail: 'Googlebot', requests: 2 }),
            expect.objectContaining({ minute: new Date('2026-09-30T10:15:00Z'), detail: 'bingbot', requests: 1 }),
        ]);
    });

    test('a new minute starts a new count', async () => {
        const c = counter();
        c.count({ source: 'event', reason: 'rate_limited', detail: 'ip' });
        clock += MINUTE;
        c.count({ source: 'event', reason: 'rate_limited', detail: 'ip' });
        await c.flush();
        expect(written.map((row) => [row.minute.toISOString(), row.requests])).toEqual([
            ['2026-09-30T10:15:00.000Z', 1],
            ['2026-09-30T10:16:00.000Z', 1],
        ]);
    });

    test('writes on its own after the flush interval', async () => {
        const c = counter();
        c.count({ source: 'event', reason: 'bot' });
        await jest.advanceTimersByTimeAsync(TRACKING.REJECTION_FLUSH_MS - 1);
        expect(written).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(1);
        expect(written).toHaveLength(1);
        expect(c.pendingKeys).toBe(0);
    });

    test('keeps only well-formed app IDs and printable, bounded details', async () => {
        const c = counter();
        c.count({ source: 'registerView', reason: 'unknown_app', appId: 'blgo' });
        c.count({ source: 'registerView', reason: 'unknown_app', appId: "x'; DROP TABLE y" });
        c.count({ source: 'registerView', reason: 'invalid_request', detail: `page\u0000\n${'z'.repeat(200)}` });
        await c.flush();
        expect(written.map((row) => row.appId)).toEqual(['blgo', '', '']);
        expect(written[2].detail).toBe(`page${'z'.repeat(60)}`);
    });

    test('once the key cap is reached, new keys keep only their reason, and the count stays exact', async () => {
        const c = counter({ maxKeys: 2 });
        c.count({ source: 'registerView', reason: 'unknown_app', appId: 'a1' });
        c.count({ source: 'registerView', reason: 'unknown_app', appId: 'a2' });
        for (let i = 3; i <= 50; i++) c.count({ source: 'registerView', reason: 'unknown_app', appId: `a${i}`, hostname: `h${i}.example` });
        expect(c.pendingKeys).toBe(3);
        await c.flush();
        expect(written.reduce((sum, row) => sum + row.requests, 0)).toBe(50);
        expect(written.at(-1)).toMatchObject({ appId: '', hostname: '', detail: '', requests: 48 });
    });

    test('flushing with nothing pending writes nothing', async () => {
        const write = jest.fn();
        await createRejectionCounter({ write }).flush();
        expect(write).not.toHaveBeenCalled();
    });
});
