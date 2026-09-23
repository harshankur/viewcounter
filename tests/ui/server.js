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

const express = require('express');
const helmet = require('helmet');

const { ADMIN } = require('../../constants');
const logger = require('../../utils/logger');
const { createAdminRouter } = require('../../routes/admin');
const { createMemoryRepos, makeView } = require('../support/memoryRepos');

const PORT = Number(process.argv[2] || process.env.UI_TEST_PORT || 4173);
const PASSWORD = 'playwright-admin-password';

/** A fixed clock, so timestamps in the UI are stable between runs. */
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

    const shop = [makeView({ id: '00000000-0000-4000-8000-0000000005e0', pagePath: '/cart', pageTitle: 'Cart' })];

    return { blog, shop };
}

/** A fresh admin router over freshly seeded data, with no sessions. */
function buildAdmin() {
    const repos = createMemoryRepos({ views: seed() });
    for (const view of repos.tables.get('blog').slice(0, 5)) {
        repos.logRepo.writeViewLog({ appId: 'blog', source: 'registerView', viewId: view.id, eventType: 'pageview', isUnique: view.isUnique });
    }

    const config = {
        allowed: { appId: ['blog', 'shop'], deviceSize: ['small', 'medium', 'large'], origins: {} },
        server: { isProduction: false },
        admin: { enabled: true, password: PASSWORD, trashRetentionDays: 30 },
    };
    return createAdminRouter({ config, adminRepo: repos.adminRepo, logRepo: repos.logRepo });
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

    app.use(ADMIN.PATH_PREFIX, (req, res, next) => admin(req, res, next));
    app.get('/', (req, res) => res.redirect(`${ADMIN.PATH_PREFIX}/`));

    return app.listen(port, '127.0.0.1');
}

if (require.main === module) start();

module.exports = { start, PASSWORD };
