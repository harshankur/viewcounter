/**
 * The tracker script in a real browser: what it sends, and what it never does.
 * Its requests go to the test server's origin, where they are intercepted and
 * recorded instead of stored.
 */

const { test, expect } = require('@playwright/test');
const { TRACKED_VIEW_ID, captureTracking, asVisitor } = require('./helpers');

const VIEW_ID = TRACKED_VIEW_ID;

test.skip(({ isMobile }) => isMobile, 'one browser profile is enough for the tracker');

/** Record every tracker request; answer page views with a view ID. */
const capture = captureTracking;

const hide = (page) => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
});

test('a page view carries the app, page, title, size, and only the campaign tags of the URL', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?utm_source=newsletter&utm_medium=email&utm_campaign=launch&email=a%40b.c&token=secret');
    await expect.poll(() => sent.views.length).toBe(1);

    const params = Object.fromEntries(sent.views[0].searchParams);
    expect(params).toEqual({
        appId: 'blog', deviceSize: 'large', page: '/tracker-lab/start', title: 'Tracker lab', referrer: '',
        utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'launch',
        // How long the page had been open, in whole seconds.
        age: expect.stringMatching(/^\d+$/),
    });
    expect(sent.views[0].href).not.toMatch(/secret|a%40b|email=a/);
});

test('the page before is sent as its origin and path, never its query or fragment', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start', { referer: 'https://elsewhere.example/reset-password?token=SECRET&email=a%40b.c#step' });
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('referrer')).toBe('https://elsewhere.example/reset-password');
    expect(sent.views[0].href).not.toMatch(/SECRET|a%2540b|step/);
});

test('when the page is hidden, it reports how long it was visible and how far it was scrolled', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await expect.poll(() => sent.views.length).toBe(1);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(200);
    await hide(page);

    await expect.poll(() => sent.engagement.length).toBe(1);
    const [{ body, type }] = sent.engagement;
    expect(type).toContain('text/plain');
    expect(body).toMatchObject({ appId: 'blog', id: VIEW_ID, scroll: 100 });
    expect(body.ms).toBeGreaterThanOrEqual(250);
});

test('while the page is being read, it reports every half minute, so the server knows the visitor is still there', async ({ page }) => {
    await page.clock.install();
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await expect.poll(() => sent.views.length).toBe(1);

    await page.clock.runFor(31_000);
    await expect.poll(() => sent.engagement.length).toBe(1);
    expect(sent.engagement[0].body).toMatchObject({ appId: 'blog', id: VIEW_ID });
    expect(sent.engagement[0].body.ms).toBeGreaterThanOrEqual(29_000);

    await page.clock.runFor(30_000);
    await expect.poll(() => sent.engagement.length).toBe(2);
    expect(sent.engagement[1].body.ms).toBeGreaterThanOrEqual(59_000);
});

test('a hidden page sends no heartbeat, and neither does one left untouched for half an hour', async ({ page }) => {
    await page.clock.install();
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await expect.poll(() => sent.views.length).toBe(1);

    // Untouched: it reports for half an hour, then stops.
    await page.clock.runFor(29 * 60_000);
    await expect.poll(() => sent.engagement.length).toBeGreaterThan(50);
    await page.clock.runFor(2 * 60_000);
    await page.waitForTimeout(200);
    const whenIdle = sent.engagement.length;
    await page.clock.runFor(5 * 60_000);
    await page.waitForTimeout(200);
    expect(sent.engagement).toHaveLength(whenIdle);

    // Any input brings it back.
    await page.mouse.move(40, 40);
    await page.clock.runFor(31_000);
    await expect.poll(() => sent.engagement.length).toBe(whenIdle + 1);

    // Hidden: one report as it hides, then nothing.
    await hide(page);
    await expect.poll(() => sent.engagement.length).toBe(whenIdle + 2);
    await page.clock.runFor(5 * 60_000);
    await page.waitForTimeout(200);
    expect(sent.engagement).toHaveLength(whenIdle + 2);
});

test('a heartbeat goes out even when nothing has grown, and stops once the view is a day old', async ({ page }) => {
    await page.clock.install();
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await expect.poll(() => sent.views.length).toBe(1);

    // Hidden time adds nothing to the total, so the next report carries the same numbers: it still goes.
    await page.clock.runFor(31_000);
    await expect.poll(() => sent.engagement.length).toBe(1);
    await hide(page);
    await expect.poll(() => sent.engagement.length).toBe(2);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        // Shown again, but frozen at the same total by pinning the clock the tracker reads.
        const frozen = window.performance.now();
        window.performance.now = () => frozen;
    });
    await page.mouse.move(30, 30);
    await page.clock.runFor(31_000);
    await expect.poll(() => sent.engagement.length).toBe(3);
    expect(sent.engagement[2].body.ms).toBe(sent.engagement[1].body.ms);

    // A day on, the server would refuse it, so it is not sent.
    await page.clock.fastForward(25 * 60 * 60_000);
    await page.waitForTimeout(200);
    const dayOld = sent.engagement.length;
    await page.mouse.move(60, 60);
    await page.clock.runFor(2 * 60_000);
    await page.waitForTimeout(200);
    expect(sent.engagement).toHaveLength(dayOld);
});

test('a page left before the server answered still reports its time, once the answer arrives', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    const FIRST = '22222222-2222-4222-8222-222222222222';
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    await page.route('**/registerView?**', async (route) => {
        calls += 1;
        if (calls === 1) {
            await held;
            await route.fulfill({ json: { recorded: true, id: FIRST } });
        } else {
            await route.fulfill({ json: { recorded: true, id: VIEW_ID } });
        }
    });
    await page.goto('/tracker-lab/start');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.history.pushState({}, '', '/tracker-lab/next'));
    await page.waitForTimeout(200);
    expect(sent.engagement).toHaveLength(0);

    release();
    await expect.poll(() => sent.engagement.length).toBe(1);
    expect(sent.engagement[0].body.id).toBe(FIRST);
    expect(sent.engagement[0].body.ms).toBeGreaterThanOrEqual(250);
    // It stopped counting when it was left, not when the answer came.
    expect(sent.engagement[0].body.ms).toBeLessThan(450);
});

test('data-heartbeat="false" reports only when the page is hidden or left', async ({ page }) => {
    await page.clock.install();
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?heartbeat=false');
    await expect.poll(() => sent.views.length).toBe(1);
    await page.clock.runFor(5 * 60_000);
    await page.waitForTimeout(200);
    expect(sent.engagement).toHaveLength(0);
    await hide(page);
    await expect.poll(() => sent.engagement.length).toBe(1);
});

test('a page that fits its window reports its time but no scroll depth, until it grows and is scrolled', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?short=1');
    await expect.poll(() => sent.views.length).toBe(1);
    await page.waitForTimeout(300);

    await hide(page);
    await expect.poll(() => sent.engagement.length).toBe(1);
    expect(sent.engagement[0].body).toMatchObject({ appId: 'blog', id: VIEW_ID });
    expect(sent.engagement[0].body.ms).toBeGreaterThanOrEqual(250);
    // Nothing to scroll: saying "all of it" would be a made-up number.
    expect(sent.engagement[0].body).not.toHaveProperty('scroll');

    // The page grows (content arrives) and the reader scrolls half of it.
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new window.Event('visibilitychange'));
        const more = document.createElement('div');
        more.style.height = '6000px';
        document.body.append(more);
        window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) / 2);
    });
    await page.waitForTimeout(200);
    await hide(page);
    await expect.poll(() => sent.engagement.length).toBe(2);
    expect(sent.engagement[1].body.scroll).toBeGreaterThan(40);
    expect(sent.engagement[1].body.scroll).toBeLessThan(70);
});

test('a short page reached from the bottom of a long one does not inherit its scroll depth', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    const SECOND = '33333333-3333-4333-8333-333333333333';
    let calls = 0;
    await page.route('**/registerView?**', async (route) => {
        calls += 1;
        await route.fulfill({ json: { recorded: true, id: calls === 1 ? VIEW_ID : SECOND } });
    });
    await page.goto('/tracker-lab/start');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);

    // As a single-page app does it: the address changes first, the new (short) page is drawn after.
    await page.evaluate(() => {
        window.history.pushState({}, '', '/tracker-lab/about');
        for (const tall of document.querySelectorAll('div')) tall.remove();
        window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    await hide(page);

    await expect.poll(() => sent.engagement.length).toBe(2);
    const [left, about] = sent.engagement.map((report) => report.body);
    // The long page was read to the end, and says so as it is left.
    expect(left).toMatchObject({ id: VIEW_ID, scroll: 100 });
    // The short page fits the window: time, and no depth.
    expect(about.id).toBe(SECOND);
    expect(about).not.toHaveProperty('scroll');
});

test('data-campaigns="false" sends none of the landing URL\'s campaign tags', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?campaigns=false&utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=t&utm_content=c');
    await expect.poll(() => sent.views.length).toBe(1);
    expect(Object.fromEntries(sent.views[0].searchParams)).toEqual({
        appId: 'blog', deviceSize: 'large', page: '/tracker-lab/start', title: 'Tracker lab', referrer: '', age: expect.stringMatching(/^\d+$/),
    });
    expect(sent.views[0].href).not.toMatch(/utm_|newsletter/);
});

test('a single-page app navigation is a new page view, referred by the page it left', async ({ page, baseURL }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await expect.poll(() => sent.views.length).toBe(1);
    await page.waitForTimeout(100);
    await page.evaluate(() => window.history.pushState({}, '', '/tracker-lab/next'));

    await expect.poll(() => sent.views.length).toBe(2);
    expect(Object.fromEntries(sent.views[1].searchParams)).toMatchObject({
        page: '/tracker-lab/next', referrer: `${new URL(baseURL).origin}/tracker-lab/start`,
    });
    // Only a page's first view says how long it had been open: a navigation is no page load.
    expect(sent.views[1].searchParams.has('age')).toBe(false);
    // The page it left reported its engagement first.
    await expect.poll(() => sent.engagement.length).toBe(1);

    await page.evaluate(() => window.history.replaceState({}, '', '/tracker-lab/next'));
    await page.waitForTimeout(200);
    expect(sent.views).toHaveLength(2);
});

test('a fragment listed in data-hash is its own page, and any other fragment is not', async ({ page, baseURL }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto(`/tracker-lab/start?hash=${encodeURIComponent('#spec/,#guide/')}#spec/config`);
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('page')).toBe('/tracker-lab/start#spec/config');

    await page.waitForTimeout(100);
    await page.evaluate(() => { window.location.hash = '#guide/install'; });
    await expect.poll(() => sent.views.length).toBe(2);
    expect(Object.fromEntries(sent.views[1].searchParams)).toMatchObject({
        // The page it came from is a referrer like any other: an origin and a path, no fragment.
        page: '/tracker-lab/start#guide/install', referrer: `${new URL(baseURL).origin}/tracker-lab/start`,
    });
    // The page it left reported its engagement first.
    await expect.poll(() => sent.engagement.length).toBe(1);

    // A plain anchor is the same page: leaving a route for one is a view of the bare path, once.
    await page.evaluate(() => { window.location.hash = '#features'; });
    await expect.poll(() => sent.views.length).toBe(3);
    expect(sent.views[2].searchParams.get('page')).toBe('/tracker-lab/start');
    await page.evaluate(() => { window.location.hash = '#pricing'; });
    await page.waitForTimeout(200);
    expect(sent.views).toHaveLength(3);
});

test('without data-hash, a fragment is never part of the page', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start#spec/config');
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('page')).toBe('/tracker-lab/start');
    await page.evaluate(() => { window.location.hash = '#spec/other'; });
    await page.waitForTimeout(200);
    expect(sent.views).toHaveLength(1);
});

test('a query parameter named in data-query is part of the page, and nothing else of the query is', async ({ page, baseURL }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?token=secret&query=post&post=hello%20world&utm_source=feed');
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('page')).toBe('/tracker-lab/start?post=hello+world');
    expect(sent.views[0].searchParams.get('utm_source')).toBe('feed');
    expect(sent.views[0].href).not.toMatch(/secret/);

    // A single-page app that only changes the named parameter shows another page.
    await page.waitForTimeout(100);
    await page.evaluate(() => window.history.replaceState({}, '', '/tracker-lab/start?query=post&post=second'));
    await expect.poll(() => sent.views.length).toBe(2);
    expect(Object.fromEntries(sent.views[1].searchParams)).toMatchObject({
        // The page it came from is a referrer like any other: an origin and a path, no query.
        page: '/tracker-lab/start?post=second', referrer: `${new URL(baseURL).origin}/tracker-lab/start`,
    });
    await expect.poll(() => sent.engagement.length).toBe(1);

    // Any other parameter changing is the same page.
    await page.evaluate(() => window.history.replaceState({}, '', '/tracker-lab/start?query=post&post=second&tab=2'));
    await page.waitForTimeout(200);
    expect(sent.views).toHaveLength(2);
});

test('several page parameters are sent sorted by name, as the server keeps an edge report\'s', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto(`/tracker-lab/start?query=${encodeURIComponent('post,lang')}&post=a&lang=de`);
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('page')).toBe('/tracker-lab/start?lang=de&post=a');
});

test('without data-query, the query is never part of the page', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?post=hello');
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('page')).toBe('/tracker-lab/start');
    await page.evaluate(() => window.history.replaceState({}, '', '/tracker-lab/start?post=other'));
    await page.waitForTimeout(200);
    expect(sent.views).toHaveLength(1);
});

test('a link to another site records only its hostname', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await page.click('#outbound');
    await expect.poll(() => sent.events.length).toBe(1);
    expect(sent.events[0]).toMatchObject({ appId: 'blog', eventType: 'outbound', eventData: { host: 'elsewhere.example' } });
    expect(JSON.stringify(sent.events[0])).not.toMatch(/secret|private/);
});

test('a download records only the file name', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await page.click('#download');
    await expect.poll(() => sent.events.length).toBe(1);
    expect(sent.events[0]).toMatchObject({ eventType: 'download', eventData: { file: 'report final.pdf' } });
});

test('custom events go through window.viewcounter.track', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await page.evaluate(() => window.viewcounter.track('signup', { plan: 'pro' }));
    await expect.poll(() => sent.events.length).toBe(1);
    expect(sent.events[0]).toMatchObject({ eventType: 'signup', eventData: { plan: 'pro' }, page: '/tracker-lab/start' });
});

test('nothing is stored on the visitor’s device', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?utm_source=x');
    await expect.poll(() => sent.views.length).toBe(1);
    await page.evaluate(() => window.history.pushState({}, '', '/tracker-lab/next'));
    await hide(page);
    const stored = await page.evaluate(() => ({ cookie: document.cookie, local: window.localStorage.length, session: window.sessionStorage.length }));
    expect(stored).toEqual({ cookie: '', local: 0, session: 0 });
    expect((await page.context().cookies()).length).toBe(0);
});

test('on a hostname not listed in data-hosts, it sends nothing', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?hosts=example.com,www.example.com');
    await page.click('#outbound');
    await page.waitForTimeout(300);
    expect(sent).toEqual({ views: [], engagement: [], events: [] });
});

test('on a listed hostname, it tracks', async ({ page, baseURL }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto(`/tracker-lab/start?hosts=example.com,${new URL(baseURL).hostname}`);
    await expect.poll(() => sent.views.length).toBe(1);
});

test('an automated browser sends nothing', async ({ page }) => {
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await page.waitForTimeout(300);
    expect(sent.views).toHaveLength(0);
});

test('data-outbound and data-downloads switch those events off', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?outbound=false&downloads=false');
    await page.click('#download');
    await page.goto('/tracker-lab/start?outbound=false&downloads=false');
    await page.click('#outbound');
    await page.waitForTimeout(300);
    expect(sent.events).toEqual([]);
});

test.describe('with a consent prompt on the page', () => {
    /** A stand-in for consent.js's API, answering `answer` (or throwing, for 'throws'). */
    const withConsent = (page, answer) => page.addInitScript((value) => {
        window.viewcounterConsent = { status: () => { if (value === 'throws') throw new Error('broken'); return value; } };
    }, answer);

    for (const answer of ['denied', 'unset', 'throws']) {
        test(`it sends nothing while the answer is ${answer}`, async ({ page }) => {
            await asVisitor(page);
            await withConsent(page, answer);
            const sent = await capture(page);
            await page.goto('/tracker-lab/start');
            await page.waitForTimeout(300);
            await page.evaluate(() => window.viewcounter.track('signup'));
            await page.click('#outbound');
            await page.waitForTimeout(300);
            expect(sent).toEqual({ views: [], engagement: [], events: [] });
        });
    }

    test('it sends as ever once the answer is yes', async ({ page }) => {
        await asVisitor(page);
        await withConsent(page, 'granted');
        const sent = await capture(page);
        await page.goto('/tracker-lab/start');
        await expect.poll(() => sent.views.length).toBe(1);
    });
});

test('a prerendered page sends its view only once it is shown, its age counted from then', async ({ page }) => {
    await asVisitor(page);
    await page.addInitScript(() => {
        window.__prerendering = true;
        window.__activationStart = 0;
        Object.defineProperty(document, 'prerendering', { configurable: true, get: () => window.__prerendering });
        const entries = window.performance.getEntriesByType.bind(window.performance);
        window.performance.getEntriesByType = (type) => (type === 'navigation'
            ? [{ ...entries('navigation')[0]?.toJSON(), activationStart: window.__activationStart }]
            : entries(type));
    });
    const sent = await capture(page);
    await page.goto('/tracker-lab/start');
    await page.waitForTimeout(2500);
    expect(sent.views).toEqual([]);

    // Shown, two and a half seconds after it loaded.
    await page.evaluate(() => {
        window.__prerendering = false;
        window.__activationStart = window.performance.now();
        document.dispatchEvent(new window.Event('prerenderingchange'));
    });
    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('age')).toBe('0');
    await page.waitForTimeout(200);
    expect(sent.views).toHaveLength(1);
});
