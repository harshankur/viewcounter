#!/usr/bin/env node
/**
 * Server for the Playwright UI suite.
 *
 * Runs the real admin router (sessions, CSRF, validation, CSP, static UI)
 * over the in-memory repositories, seeded with deterministic data. The SQL
 * behind the repositories is covered separately (tests/adminRepository.test.js
 * and tests/e2e); this server exists to test the UI in a real browser.
 *
 * Usage: node tests/ui/server.js [port]
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const { ADMIN } = require('../../constants');
const logger = require('../../utils/logger');
const { createAdminRouter } = require('../../routes/admin');
const { createSessionStore } = require('../../middleware/adminAuth');
const { createMemoryRepos, makeView } = require('../support/memoryRepos');
const { demoData, APPS: DEMO_APPS } = require('./demoData');

const PORT = Number(process.argv[2] || process.env.UI_TEST_PORT || 4173);
const PASSWORD = 'playwright-admin-password';
/** `--demo` serves several thousand realistic fake views instead of the test fixture. */
const DEMO = process.argv.includes('--demo');

/** The test fixture's fixed clock, so timestamps and date ranges are stable between runs. */
const BASE = Date.UTC(2026, 8, 20, 9, 0, 0);
const MINUTE = 60 * 1000;

function seed() {
    const pages = [
        ['/', 'Home'],
        ['/blog/privacy-first-analytics', 'Privacy-first analytics without cookies'],
        ['/blog/self-hosting-on-a-mini-pc', 'Self-hosting on a mini PC'],
        ['/about', 'About'],
        ['/projects/viewcounter', 'ViewCounter'],
    ];
    const referrers = [
        [null, null, 'direct'],
        ['https://www.google.com/search?q=viewcounter', 'www.google.com', 'search'],
        ['https://news.ycombinator.com/item?id=1', 'news.ycombinator.com', 'referral'],
        ['https://twitter.com/someone/status/1', 'twitter.com', 'social'],
    ];
    const clients = [
        ['Chrome', 'macOS', 'desktop', 'large'],
        ['Safari', 'iOS', 'mobile', 'small'],
        ['Firefox', 'Linux', 'desktop', 'large'],
        ['Edge', 'Windows', 'desktop', 'medium'],
    ];
    const countries = ['DE', 'US', 'GB', 'IN', 'FR'];

    const blog = [];
    for (let i = 0; i < 60; i++) {
        const [pagePath, pageTitle] = pages[i % pages.length];
        const [referrer, referrerDomain, sourceType] = referrers[i % referrers.length];
        const [browser, os, deviceType, deviceSize] = clients[i % clients.length];
        blog.push(makeView({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            timestamp: new Date(BASE - i * 37 * MINUTE),
            pagePath,
            pageTitle,
            referrer,
            referrerDomain,
            sourceType,
            browser,
            os,
            deviceType,
            deviceSize,
            country: countries[i % countries.length],
            isUnique: i % 3 !== 0,
            sessionId: `s-${Math.floor(i / 3)}`,
        }));
    }

    // Hostile input, as an anonymous visitor could send it. The UI must show
    // it as inert text.
    blog.push(makeView({
        id: '00000000-0000-4000-8000-00000000abcd',
        timestamp: new Date(BASE + MINUTE),
        pagePath: '/<img src=x onerror="window.__xss=1">',
        pageTitle: '<script>window.__xss=1</script>',
        referrer: null,
        sourceType: 'direct',
    }));

    blog.push(makeView({
        id: '00000000-0000-4000-8000-0000000000de',
        timestamp: new Date(BASE - 2 * 24 * 60 * MINUTE),
        pagePath: '/old-post',
        pageTitle: 'An old post already in the trash',
        deletedAt: new Date(BASE - MINUTE),
    }));

    // Older rows, so the date-range filter has something to exclude, and one
    // custom event, so the event-type filter has something to select.
    const DAY = 24 * 60 * MINUTE;
    const shop = [
        makeView({ id: '00000000-0000-4000-8000-0000000005e0', pagePath: '/cart', pageTitle: 'Cart' }),
        makeView({
            id: '00000000-0000-4000-8000-0000000005e1',
            timestamp: new Date(BASE - 45 * DAY),
            pagePath: '/downloads',
            pageTitle: 'Downloads',
            eventType: 'download',
            country: 'JP',
        }),
        makeView({
            id: '00000000-0000-4000-8000-0000000005e2',
            timestamp: new Date(BASE - 200 * DAY),
            pagePath: '/archive',
            pageTitle: 'Archive',
        }),
    ];

    return { blog, shop };
}

/**
 * A view-register-log receipt for every seeded view, at the view's own time,
 * as the real server writes one per accepted request.
 */
function receiptsFor(views) {
    return Object.entries(views)
        .flatMap(([appId, rows]) => rows.map((view) => ({
            id: `${view.id.slice(0, 24)}${'f'.repeat(12)}`,
            createdAt: view.timestamp,
            appId,
            source: view.eventType === 'pageview' ? 'registerView' : 'event',
            viewId: view.id,
            eventType: view.eventType,
            isUnique: view.isUnique,
        })))
        .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The session clock runs ahead of real time by this much, so a test can make
 * the password "old" without waiting. Reset with everything else.
 */
let sessionClockOffset = 0;
/** The seeded data and config the current admin router serves. */
let current = null;

/** An admin router over the current data, with a new, empty session store. */
function routerWithNewSessions() {
    const sessionStore = createSessionStore({ now: () => Date.now() + sessionClockOffset });
    return createAdminRouter({
        config: current.config, adminRepo: current.repos.adminRepo, logRepo: current.repos.logRepo, sessionStore, geo: current.geo,
    });
}

/** A fresh admin router over freshly seeded data, with no sessions. */
function buildAdmin() {
    sessionClockOffset = 0;
    const now = DEMO ? new Date(Math.floor(Date.now() / MINUTE) * MINUTE) : new Date(BASE);
    const data = DEMO ? demoData(now) : { views: seed() };
    const repos = createMemoryRepos({ views: data.views, now: () => now });
    repos.viewLog.push(...(data.viewLog || receiptsFor(data.views)));
    repos.adminLog.push(...(data.adminLog || []));
    if (data.rejections) repos.logRepo.recordRejections(data.rejections);

    const config = {
        allowed: {
            appId: DEMO ? Object.keys(DEMO_APPS) : ['blog', 'shop'],
            deviceSize: ['small', 'medium', 'large'],
            origins: {},
        },
        server: { isProduction: false },
        admin: { enabled: true, password: PASSWORD, trashRetentionDays: 30, viewLogRetentionDays: 90 },
    };
    // The demo shows regions and cities as a city database would provide them.
    const geo = DEMO ? { city: { attribution: { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' } } } : undefined;
    current = { repos, config, geo };
    return routerWithNewSessions();
}

function start(port = PORT) {
    logger.configure({ level: logger.LogLevel.SILENT });
    let admin = buildAdmin();

    const app = express();
    app.use(helmet());

    // Test-only: every Playwright test starts from the same data and with no
    // session. This route exists in this harness alone, never in the product.
    app.post('/__test__/reset', (req, res) => {
        // Rebuilt on the next tick, outside the request: a rate limiter
        // created inside a handler is a misuse express-rate-limit rejects.
        // The reply waits for the rebuild, so the next test sees fresh state.
        setImmediate(() => {
            admin = buildAdmin();
            res.status(204).end();
        });
    });

    // Test-only: end every session, as a server restart without persistent
    // sessions, or an idle timeout, would; the data stays as it is.
    app.post('/__test__/end-sessions', (req, res) => {
        setImmediate(() => {
            admin = routerWithNewSessions();
            res.status(204).end();
        });
    });

    // Test-only: make the password entered at sign-in older than the window
    // in which a permanent erasure may proceed without asking again.
    app.post('/__test__/age-password', (req, res) => {
        sessionClockOffset += ADMIN.REAUTH_WINDOW_MS + 60 * 1000;
        res.status(204).end();
    });

    // Test-only: a page that loads the real tracker, for tests/ui/tracker.spec.js.
    // The tracker posts to its own origin, where the tests intercept it.
    app.get('/tracker.js', (req, res) => {
        res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, '..', '..', 'tracker', 'tracker.js'), 'utf8'));
    });
    app.get(/^\/tracker-lab\//, (req, res) => {
        const attribute = (name) => {
            const value = typeof req.query[name] === 'string' ? req.query[name].replace(/[^a-z0-9.,:-]/gi, '') : '';
            return value ? ` data-${name}="${value}"` : '';
        };
        res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tracker lab</title></head>
<body>
  <a id="outbound" href="https://elsewhere.example/private/path?token=secret">elsewhere</a>
  <a id="download" href="/files/report%20final.pdf">report</a>
  <a id="internal" href="/tracker-lab/other">internal</a>
  <div style="height: 4000px"></div>
  <script src="/tracker.js" data-app="blog"${attribute('hosts')}${attribute('spa')}${attribute('outbound')}${attribute('downloads')}></script>
</body></html>`);
    });

    app.use(ADMIN.PATH_PREFIX, (req, res, next) => admin(req, res, next));
    app.get('/', (req, res) => res.redirect(`${ADMIN.PATH_PREFIX}/`));

    return app.listen(port, '127.0.0.1');
}

if (require.main === module) start();

module.exports = { start, PASSWORD };
