/**
 * The tracker script in a real browser: what it sends, and what it never does.
 * Its requests go to the test server's origin, where they are intercepted and
 * recorded instead of stored.
 */

const { test, expect } = require('@playwright/test');

const VIEW_ID = '11111111-1111-4111-8111-111111111111';

test.skip(({ isMobile }) => isMobile, 'one browser profile is enough for the tracker');

/** Record every tracker request; answer page views with a view ID. */
async function capture(page) {
    const sent = { views: [], engagement: [], events: [] };
    await page.route('**/registerView?**', async (route) => {
        sent.views.push(new URL(route.request().url()));
        await route.fulfill({ json: { message: 'Success!', duplicate: false, recorded: true, id: VIEW_ID } });
    });
    await page.route('**/engage', async (route) => {
        sent.engagement.push({ body: JSON.parse(route.request().postData()), type: route.request().headers()['content-type'] });
        await route.fulfill({ status: 204 });
    });
    await page.route('**/event', async (route) => {
        sent.events.push(JSON.parse(route.request().postData()));
        await route.fulfill({ json: { recorded: true } });
    });
    await page.route('https://elsewhere.example/**', (route) => route.fulfill({ body: 'elsewhere' }));
    await page.route('**/files/**', (route) => route.fulfill({ body: 'pdf' }));
    return sent;
}

/** A real visitor, not an automated browser (which the tracker skips). */
async function asVisitor(page) {
    await page.addInitScript(() => Object.defineProperty(window.Navigator.prototype, 'webdriver', { get: () => false }));
}

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

test('data-campaigns="false" sends none of the landing URL\'s campaign tags', async ({ page }) => {
    await asVisitor(page);
    const sent = await capture(page);
    await page.goto('/tracker-lab/start?campaigns=false&utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=t&utm_content=c');
    await expect.poll(() => sent.views.length).toBe(1);
    expect(Object.fromEntries(sent.views[0].searchParams)).toEqual({
        appId: 'blog', deviceSize: 'large', page: '/tracker-lab/start', title: 'Tracker lab', referrer: '',
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
