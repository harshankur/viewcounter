/**
 * A small, hand-worked analysis scenario: rows, and exactly what the analysis
 * must make of them. The in-memory analysis is checked against it in Jest, and
 * the SQL on MySQL and MariaDB in tests/e2e/run.js, so both are held to the
 * same arithmetic.
 *
 * Three visitors, on one app:
 *   A  10:00 /a (20 s, 40 %), 10:05 /b (60 s, 80 %), 10:07 /b again,
 *      then 12:00 /c (5 s): the two-hour pause starts a second visit
 *   B  10:10 /a (3 s, 10 %) and nothing else: a bounce
 *   C  10:20 /b, a "buy" click at 10:25, 10:40 /a: 20 minutes apart, one visit
 *
 * Visits: A1 /a /b /b (7 min), A2 /c (5 s), B1 /a (3 s), C1 /b /a (20 min).
 */

const at = (time) => `2026-09-10T${time}Z`;

const ROWS = [
    { visitor: 'a', time: at('10:00:00'), page: '/a', engagedMs: 20000, scrollDepth: 40 },
    { visitor: 'a', time: at('10:05:00'), page: '/b', engagedMs: 60000, scrollDepth: 80 },
    { visitor: 'a', time: at('10:07:00'), page: '/b' },
    { visitor: 'a', time: at('12:00:00'), page: '/c', engagedMs: 5000 },
    { visitor: 'b', time: at('10:10:00'), page: '/a', engagedMs: 3000, scrollDepth: 10 },
    { visitor: 'c', time: at('10:20:00'), page: '/b' },
    { visitor: 'c', time: at('10:25:00'), page: '/b', eventType: 'click', eventData: { button: 'buy' } },
    { visitor: 'c', time: at('10:40:00'), page: '/a' },
];

const EXPECTED = {
    totals: {
        views: 8,
        pageviews: 7,
        visitors: 3,
        visits: 4,
        bounceRate: 0.5,
        // (420 000 + 5 000 + 3 000 + 1 200 000) / 4
        avgVisitMs: 407000,
        pagesPerVisit: 1.75,
        // (20 000 + 60 000 + 5 000 + 3 000) / 4
        avgEngagedMs: 22000,
        engagedViews: 4,
    },
    avgScroll: (40 + 80 + 10) / 3,
    entryPages: [
        { page: '/a', visits: 2, bounceRate: 0.5 },
        { page: '/b', visits: 1, bounceRate: 0 },
        { page: '/c', visits: 1, bounceRate: 1 },
    ],
    exitPages: [
        { page: '/a', visits: 2 },
        { page: '/b', visits: 1 },
        { page: '/c', visits: 1 },
    ],
    // /b to /b is a reload, not a step.
    transitions: [
        { from: '/a', to: '/b', steps: 1 },
        { from: '/b', to: '/a', steps: 1 },
    ],
    pages: [
        { page: '/a', views: 3, visitors: 3 },
        { page: '/b', views: 3, visitors: 2 },
        { page: '/c', views: 1, visitors: 1 },
    ],
    eventProperties: [{ eventType: 'click', key: 'button', value: 'buy', count: 1 }],
};

module.exports = { ROWS, EXPECTED };
