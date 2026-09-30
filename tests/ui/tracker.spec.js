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
