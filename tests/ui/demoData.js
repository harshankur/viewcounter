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
        hostname: 'blog.example.com',
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
        hostname: 'example.com',
        pages: [['/', 'Harsh Ankur'], ['/projects', 'Projects'], ['/contact', 'Contact']],
        events: [['pageview', 92], ['outbound', 8]],
    },
    officeparser: {
        weight: 20,
        hostname: 'officeparser.example.com',
        pages: [['/', 'officeparser'], ['/docs', 'officeparser docs'], ['/docs/api', 'API reference'], ['/playground', 'Playground']],
        events: [['pageview', 82], ['download', 12], ['outbound', 6]],
        spike: 34,
    },
    viewcounter: {
        weight: 8,
        hostname: 'viewcounter.example.com',
        pages: [['/', 'ViewCounter, privacy-first analytics'], ['/#quick-start', 'Quick start'], ['/#api-reference', 'API reference']],
        events: [['pageview', 95], ['outbound', 5]],
    },
    inscript: {
        weight: 7,
        hostname: 'inscript.example.com',
        pages: [['/', 'Inscript'], ['/editor', 'Inscript editor'], ['/docs', 'Inscript docs']],
        events: [['pageview', 90], ['signup', 4], ['click', 6]],
    },
    'inscript-editor': {
        weight: 7,
        hostname: 'editor.inscript.example.com',
        pages: [['/', 'Inscript Editor'], ['/new', 'New document'], ['/templates', 'Templates']],
        events: [['pageview', 85], ['save', 10], ['export', 5]],
    },
    balloonpop: {
        weight: 4,
        hostname: 'balloonpop.example.com',
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

/** A visitor's first language, by country; everyone else reads English. */
const LANGUAGES = {
    DE: 'de', AT: 'de', CH: 'de', FR: 'fr', ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', IT: 'it', NL: 'nl',
    BR: 'pt', PT: 'pt', JP: 'ja', KR: 'ko', PL: 'pl', SE: 'sv', TR: 'tr', UA: 'uk', CZ: 'cs', RO: 'ro', FI: 'fi',
    NO: 'nb', DK: 'da', ID: 'id', VN: 'vi', IN: 'en',
};

/** Places a city database would find, for the busiest countries; the rest stay unknown. */
const PLACES = {
    US: [['California', 'San Francisco'], ['New York', 'New York'], ['Washington', 'Seattle'], ['Texas', 'Austin']],
    DE: [['Bavaria', 'Munich'], ['Berlin', 'Berlin'], ['Hamburg', 'Hamburg'], ['Hesse', 'Frankfurt am Main']],
    IN: [['Karnataka', 'Bengaluru'], ['Maharashtra', 'Mumbai'], ['Delhi', 'New Delhi'], ['Telangana', 'Hyderabad']],
    GB: [['England', 'London'], ['England', 'Manchester'], ['Scotland', 'Edinburgh']],
    FR: [['Île-de-France', 'Paris'], ['Auvergne-Rhône-Alpes', 'Lyon']],
    NL: [['North Holland', 'Amsterdam']],
    CA: [['Ontario', 'Toronto'], ['British Columbia', 'Vancouver']],
};

/** Campaign tags, for the landings that carried them. */
const CAMPAIGNS = [
    [{ utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'october-issue', utmContent: 'header-link' }, 5],
    [{ utmSource: 'linkedin', utmMedium: 'social', utmCampaign: 'officeparser-launch' }, 3],
    [{ utmSource: 'hn', utmMedium: 'referral', utmCampaign: 'show-hn', utmTerm: 'document parser' }, 2],
];

const OUTBOUND_HOSTS = [['github.com', 6], ['www.npmjs.com', 3], ['www.linkedin.com', 2], ['news.ycombinator.com', 1]];

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

/** Event data a real site would send for each kind of event. */
function eventData(random, eventType, app) {
    if (eventType === 'pageview') return null;
    if (eventType === 'download') return { file: weighted(random, [['officeparser-5.2.0.tgz', 5], ['officeparser-guide.pdf', 2], ['sample.docx', 1]]) };
    if (eventType === 'outbound') return { host: weighted(random, OUTBOUND_HOSTS) };
    if (eventType === 'subscribe' || eventType === 'signup') return { plan: weighted(random, [['free', 4], ['pro', 1]]) };
    return { target: `${eventType}-button`, app: app.hostname.split('.')[0] };
}

/**
 * Generate the demo views, their tracking-log receipts, counted refusals and
 * bots, and some admin history. Views come in visits: a visitor lands, reads
 * one to four pages a few minutes apart, and each page after the first names
 * the one before as its (internal) referrer.
 * @param {Date} now the demo's "present"
 */
function demoData(now) {
    const random = prng(20260924);
    const end = now.getTime();
    const visitors = Array.from({ length: VISITOR_POOL }, () => {
        const country = weighted(random, COUNTRIES);
        const places = PLACES[country];
        const place = places && random() < 0.85 ? places[Math.floor(random() * places.length)] : [null, null];
        return {
            hash: hex(random, 64),
            country,
            region: place[0],
            city: place[1],
            language: LANGUAGES[country] ?? 'en',
            device: weighted(random, DEVICES),
        };
    });

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
    const newId = () => `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-${'89ab'[Math.floor(random() * 4)]}${hex(random, 3)}-${hex(random, 12)}`;

    function record(appId, fields) {
        const view = makeView({
            appId,
            id: newId(),
            maskedIp: `${Math.floor(random() * 223) + 1}.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}.0`,
            browserVersion: `${120 + Math.floor(random() * 22)}.0.${Math.floor(random() * 9000)}`,
            osVersion: `${10 + Math.floor(random() * 8)}.${Math.floor(random() * 6)}`,
            ...fields,
        });
        views[appId].push(view);
        viewLog.push({
            id: newId(),
            createdAt: view.timestamp,
            appId,
            source: view.eventType === 'pageview' ? 'registerView' : 'event',
            viewId: view.id,
            eventType: view.eventType,
            isUnique: view.isUnique,
            hostname: view.hostname,
        });
        return view;
    }

    /** One visit: its landing, pages read, and events along the way. */
    function visit(start, { appId, visitor, pages = 1 + Math.floor(random() ** 2 * 4) }) {
        const app = APPS[appId];
        const [browser, os] = weighted(random, visitor.device.clients);
        const landing = weighted(random, SOURCES);
        const campaign = landing.sourceType === 'campaign' || random() < 0.04 ? weighted(random, CAMPAIGNS) : {};
        let at = start;
        let previous = null;
        let count = 0;
        for (let step = 0; step < pages && at <= end; step++) {
            const [pagePath, pageTitle] = app.pages[Math.floor(random() ** 1.3 * app.pages.length)];
            const measured = random() < 0.8;
            const context = {
                visitorHash: visitor.hash,
                country: visitor.country,
                region: visitor.region,
                city: visitor.city,
                language: visitor.language,
                deviceSize: visitor.device.deviceSize,
                deviceType: visitor.device.deviceType,
                browser,
                os,
                hostname: app.hostname,
                sessionId: null,
            };
            record(appId, {
                ...context,
                timestamp: new Date(at),
                pagePath,
                pageTitle,
                ...(previous
                    ? { sourceType: 'internal', referrer: `https://${app.hostname}${previous}`, referrerDomain: app.hostname }
                    : { ...landing, ...campaign, ...(campaign.utmSource ? { sourceType: 'campaign' } : {}) }),
                eventType: 'pageview',
                isUnique: step === 0 && random() < 0.8,
                engagedMs: measured ? Math.round(2000 + random() ** 2.2 * 420000) : null,
                scrollDepth: measured ? Math.min(100, Math.round(15 + random() * 95)) : null,
            });
            count += 1;
            const eventType = weighted(random, app.events);
            if (eventType !== 'pageview') {
                record(appId, {
                    ...context,
                    timestamp: new Date(Math.min(end, at + Math.floor(random() * 90000))),
                    pagePath,
                    pageTitle,
                    sourceType: null,
                    referrer: null,
                    referrerDomain: null,
                    eventType,
                    eventData: eventData(random, eventType, app),
                    isUnique: false,
                });
                count += 1;
            }
            previous = pagePath;
            at += 20000 + Math.floor(random() * 6 * 60000);
        }
        return count;
    }

    for (let made = 0; made < TOTAL_VIEWS;) {
        const appId = weighted(random, appEntries);
        const app = APPS[appId];
        let dayIndex = weighted(random, dayWeights.map((weight, day) => [day, weight]));
        // officeparser's Hacker News launch: a burst on one day.
        if (app.spike && random() < 0.25) dayIndex = DAYS - app.spike;
        const hour = weighted(random, Array.from({ length: 24 }, (_, h) => [h, h >= 7 && h <= 22 ? 3 : 1]));
        const start = end - (DAYS - 1 - dayIndex) * DAY_MS - (23 - hour) * HOUR_MS - Math.floor(random() * HOUR_MS);
        if (start > end) continue;
        const visitor = visitors[Math.floor(random() ** 1.6 * visitors.length)];
        made += visit(start, { appId, visitor });
    }

    // Right now: a few people reading in the last half hour.
    for (let i = 0; i < 9; i++) {
        const appId = weighted(random, appEntries);
        visit(end - Math.floor(random() * 28 * 60000), { appId, visitor: visitors[Math.floor(random() * visitors.length)], pages: 1 + Math.floor(random() * 3) });
    }

    // What the tracking log counted without storing: bots and refusals.
    const MINUTE_MS = 60000;
    const rejections = [];
    for (let i = 0; i < 60; i++) {
        const minute = new Date(Math.floor((end - Math.floor(random() * 30 * HOUR_MS)) / MINUTE_MS) * MINUTE_MS);
        const appId = weighted(random, appEntries);
        const kind = weighted(random, [['bot', 6], ['origin_not_allowed', 2], ['invalid_request', 1], ['unknown_app', 1], ['rate_limited', 1]]);
        rejections.push({
            minute,
            source: weighted(random, [['registerView', 5], ['event', 1], ['engage', 1]]),
            reason: kind,
            appId: kind === 'unknown_app' ? 'old-blog' : appId,
            detail: {
                bot: weighted(random, [['Googlebot', 5], ['bingbot', 2], ['HeadlessChrome', 2], ['Slackbot-LinkExpanding', 1]]),
                invalid_request: weighted(random, [['deviceSize', 1], ['page', 1]]),
                origin_not_allowed: '',
                unknown_app: '',
                rate_limited: '',
            }[kind],
            hostname: kind === 'origin_not_allowed' ? 'staging.example.net' : APPS[appId].hostname,
            requests: 1 + Math.floor(random() * 4),
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
        rejections,
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
