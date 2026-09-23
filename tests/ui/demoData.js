/**
 * Realistic, deterministic demo data for looking at the admin UI:
 * `node tests/ui/server.js 4173 --demo`.
 *
 * Seeded pseudo-random generation, so every start shows the same numbers
 * relative to the moment the server started. Nothing here is real traffic.
 */

const { makeView } = require('../support/memoryRepos');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAYS = 180;
const TOTAL_VIEWS = 4200;
const VISITOR_POOL = 1600;

/** mulberry32: a tiny seeded PRNG, so the demo is identical on every start. */
function prng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Pick from [[value, weight], ...]. */
function weighted(random, entries) {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = random() * total;
    for (const [value, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
    }
    return entries[entries.length - 1][0];
}

const APPS = {
    blog: {
        weight: 34,
        pages: [
            ['/', 'Harsh Ankur, blog'],
            ['/posts/privacy-first-analytics', 'Privacy-first analytics without cookies'],
            ['/posts/self-hosting-on-a-mini-pc', 'Self-hosting on a mini PC'],
            ['/posts/cloudflare-tunnels', 'Exposing home services with Cloudflare Tunnel'],
            ['/posts/gdpr-for-developers', 'GDPR for developers, in plain words'],
            ['/posts/writing-a-parser', 'Writing a document parser in Node'],
            ['/about', 'About'],
        ],
        events: [['pageview', 94], ['click', 4], ['subscribe', 2]],
    },
    homepage: {
        weight: 20,
        pages: [['/', 'Harsh Ankur'], ['/projects', 'Projects'], ['/contact', 'Contact']],
        events: [['pageview', 92], ['click', 8]],
    },
    officeparser: {
        weight: 20,
        pages: [['/', 'officeparser'], ['/docs', 'officeparser docs'], ['/docs/api', 'API reference'], ['/playground', 'Playground']],
        events: [['pageview', 82], ['download', 12], ['click', 6]],
        spike: 34,
    },
    viewcounter: {
        weight: 8,
        pages: [['/', 'ViewCounter, privacy-first analytics'], ['/#quick-start', 'Quick start'], ['/#api-reference', 'API reference']],
        events: [['pageview', 95], ['click', 5]],
    },
    inscript: {
        weight: 7,
        pages: [['/', 'Inscript'], ['/editor', 'Inscript editor'], ['/docs', 'Inscript docs']],
        events: [['pageview', 90], ['signup', 4], ['click', 6]],
    },
    'inscript-editor': {
        weight: 7,
        pages: [['/', 'Inscript Editor'], ['/new', 'New document'], ['/templates', 'Templates']],
        events: [['pageview', 85], ['save', 10], ['export', 5]],
    },
    balloonpop: {
        weight: 4,
        pages: [['/', 'Balloon Pop'], ['/leaderboard', 'Leaderboard']],
        events: [['pageview', 70], ['play', 25], ['share', 5]],
    },
};

const COUNTRIES = [
    ['US', 22], ['DE', 14], ['IN', 12], ['GB', 8], ['FR', 5], ['CA', 4], ['NL', 4], ['BR', 4],
    ['JP', 3], ['ES', 3], ['IT', 3], ['SE', 2], ['PL', 2], ['AU', 2], ['CH', 2], ['AT', 2],
    ['KR', 1.5], ['MX', 1.2], ['TR', 1], ['ID', 1], ['NG', 0.8], ['ZA', 0.8], ['AR', 0.7],
    ['PT', 0.7], ['FI', 0.6], ['NO', 0.6], ['DK', 0.6], ['IE', 0.6], ['CZ', 0.5], ['RO', 0.5],
    ['UA', 0.5], ['VN', 0.5], ['PH', 0.4], ['EG', 0.4], ['NZ', 0.4], ['CO', 0.4], ['CL', 0.3],
    ['SG', 0.8], ['HK', 0.4], ['MT', 0.2], ['LU', 0.2], ['BH', 0.1],
];

const SOURCES = [
    [{ sourceType: 'direct', referrer: null, referrerDomain: null }, 34],
    [{ sourceType: 'search', referrer: 'https://www.google.com/search?q=x', referrerDomain: 'www.google.com' }, 24],
    [{ sourceType: 'search', referrer: 'https://duckduckgo.com/', referrerDomain: 'duckduckgo.com' }, 4],
    [{ sourceType: 'search', referrer: 'https://www.bing.com/search?q=x', referrerDomain: 'www.bing.com' }, 3],
    [{ sourceType: 'referral', referrer: 'https://news.ycombinator.com/item?id=1', referrerDomain: 'news.ycombinator.com' }, 8],
    [{ sourceType: 'referral', referrer: 'https://github.com/harshankur', referrerDomain: 'github.com' }, 7],
    [{ sourceType: 'referral', referrer: 'https://dev.to/', referrerDomain: 'dev.to' }, 2],
    [{ sourceType: 'social', referrer: 'https://www.reddit.com/r/selfhosted/', referrerDomain: 'www.reddit.com' }, 6],
    [{ sourceType: 'social', referrer: 'https://www.linkedin.com/feed/', referrerDomain: 'www.linkedin.com' }, 5],
    [{ sourceType: 'social', referrer: 'https://twitter.com/someone', referrerDomain: 'twitter.com' }, 4],
    [{ sourceType: 'email', referrer: 'https://mail.google.com/', referrerDomain: 'mail.google.com' }, 2],
    [{ sourceType: 'campaign', referrer: 'https://example.com/?utm_source=newsletter', referrerDomain: 'example.com' }, 1],
];

const DEVICES = [
    [{ deviceType: 'desktop', deviceSize: 'large', clients: [[['Chrome', 'Windows'], 26], [['Chrome', 'macOS'], 14], [['Safari', 'macOS'], 10], [['Firefox', 'Linux'], 8], [['Firefox', 'Windows'], 5], [['Edge', 'Windows'], 8], [['Chrome', 'Linux'], 6]] }, 56],
    [{ deviceType: 'mobile', deviceSize: 'small', clients: [[['Safari', 'iOS'], 45], [['Chrome', 'Android'], 48], [['Samsung Internet', 'Android'], 7]] }, 36],
    [{ deviceType: 'tablet', deviceSize: 'medium', clients: [[['Safari', 'iPadOS'], 70], [['Chrome', 'Android'], 30]] }, 8],
];

const NOTES = [
    'Bot traffic from a crawler, kept for reference',
    'Our own visit while testing the tracking snippet',
    'Load test from the staging server',
    'Came from the Hacker News launch thread',
    'Duplicate caused by a redirect loop, fixed since',
];

const hex = (random, length) => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('');

/**
 * Generate the demo views, their view-log receipts, and some admin history.
 * @param {Date} now the demo's "present"
 */
function demoData(now) {
    const random = prng(20260924);
    const end = now.getTime();
    const visitors = Array.from({ length: VISITOR_POOL }, () => ({
        hash: hex(random, 64),
        country: weighted(random, COUNTRIES),
        device: weighted(random, DEVICES),
    }));

    // Gentle growth over the period, busier on weekdays, plus launch spikes.
    const dayWeights = Array.from({ length: DAYS }, (_, index) => {
        const date = new Date(end - (DAYS - 1 - index) * DAY_MS);
        const weekday = date.getUTCDay();
        const growth = 0.55 + (index / DAYS) * 0.9;
        const weekly = weekday === 0 || weekday === 6 ? 0.7 : 1.1;
        return growth * weekly;
    });

    const views = Object.fromEntries(Object.keys(APPS).map((appId) => [appId, []]));
    const appEntries = Object.entries(APPS).map(([appId, app]) => [appId, app.weight]);
    const viewLog = [];

    for (let index = 0; index < TOTAL_VIEWS; index++) {
        const appId = weighted(random, appEntries);
        const app = APPS[appId];
        let dayIndex = weighted(random, dayWeights.map((weight, day) => [day, weight]));
        // officeparser's Hacker News launch: a burst on one day.
        if (app.spike && random() < 0.25) dayIndex = DAYS - app.spike;
        const hour = weighted(random, Array.from({ length: 24 }, (_, h) => [h, h >= 7 && h <= 22 ? 3 : 1]));
        const timestamp = new Date(end - (DAYS - 1 - dayIndex) * DAY_MS - (23 - hour) * HOUR_MS - Math.floor(random() * HOUR_MS));
        if (timestamp.getTime() > end) continue;

        const visitor = visitors[Math.floor(random() ** 1.6 * visitors.length)];
        const [browser, os] = weighted(random, visitor.device.clients);
        const [pagePath, pageTitle] = app.pages[Math.floor(random() ** 1.3 * app.pages.length)];
        const source = weighted(random, SOURCES);
        const eventType = weighted(random, app.events);
        const view = makeView({
            appId,
            id: `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-${'89ab'[Math.floor(random() * 4)]}${hex(random, 3)}-${hex(random, 12)}`,
            timestamp,
            maskedIp: `${Math.floor(random() * 223) + 1}.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}.0`,
            country: visitor.country,
            deviceSize: visitor.device.deviceSize,
            deviceType: visitor.device.deviceType,
            pagePath,
            pageTitle,
            ...source,
            browser,
            browserVersion: `${120 + Math.floor(random() * 22)}.0`,
            os,
            osVersion: String(10 + Math.floor(random() * 8)),
            sessionId: `s-${visitor.hash.slice(0, 10)}-${Math.floor(timestamp.getTime() / (6 * HOUR_MS))}`,
            eventType,
            eventData: eventType === 'pageview' ? null : { target: eventType === 'download' ? 'officeparser.tgz' : `${eventType}-button` },
            isUnique: random() < 0.72,
            visitorHash: visitor.hash,
        });
        views[appId].push(view);
        viewLog.push({
            id: `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-8${hex(random, 3)}-${hex(random, 12)}`,
            createdAt: timestamp,
            appId,
            source: eventType === 'pageview' ? 'registerView' : 'event',
            viewId: view.id,
            eventType,
            isUnique: view.isUnique,
        });
    }

    // Some admin history: notes, edits, and trashed views.
    const all = Object.values(views).flat();
    const adminLog = [];
    const session = hex(random, 8);
    const pick = () => all[Math.floor(random() * all.length)];
    for (let i = 0; i < 18; i++) {
        const view = pick();
        view.note = NOTES[i % NOTES.length];
    }
    for (let i = 0; i < 22; i++) {
        const view = pick();
        view.pageTitle = `${view.pageTitle} (corrected)`;
        view.adminModifiedAt = new Date(end - Math.floor(random() * 20) * DAY_MS);
        adminLog.push({ action: 'views_edited', appId: view.appId, targetIds: [view.id], fields: ['pageTitle'], createdAt: view.adminModifiedAt });
    }
    for (let i = 0; i < 26; i++) {
        const view = pick();
        view.deletedAt = new Date(end - Math.floor(random() * 25) * DAY_MS);
        adminLog.push({ action: 'views_deleted', appId: view.appId, targetIds: [view.id], fields: [], createdAt: view.deletedAt });
    }
    adminLog.push({ action: 'login_succeeded', appId: null, targetIds: [], fields: [], createdAt: new Date(end - 21 * DAY_MS) });
    adminLog.push({ action: 'login_failed', appId: null, targetIds: [], fields: [], createdAt: new Date(end - 21 * DAY_MS - 60000) });

    return {
        views,
        viewLog: viewLog.sort((a, b) => b.createdAt - a.createdAt),
        adminLog: adminLog
            .map((entry, index) => ({
                id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                sessionId: `${session}-0000-4000-8000-000000000000`,
                maskedIp: '203.0.113.0',
                targetCount: entry.targetIds.length,
                ...entry,
            }))
            .sort((a, b) => b.createdAt - a.createdAt),
    };
}

module.exports = { demoData, APPS };
