/**
 * The consent prompt (tracker/consent.js) in a real browser: when it asks,
 * what each answer does, that the answer is kept and can be changed, and that
 * a withdrawal stops the tracker at once. The tracker's requests go to the
 * test server's origin, where they are intercepted and recorded.
 *
 * The prompt lives in a closed shadow root, which Playwright's locators do
 * not enter. Most tests open it for the test alone (attachShadow is asked
 * for "open" instead, and the mode the prompt asked for is recorded); the
 * keyboard and closed-root tests use the page as it really is.
 */

const { test, expect } = require('@playwright/test');
const { captureTracking, asVisitor } = require('./helpers');

test.skip(({ isMobile }) => isMobile, 'one browser profile is enough for the consent prompt');

const KEY = 'viewcounter-consent:blog';
const PRIVACY = 'https://example.com/privacy#blog';

/** Let the test see into the prompt's shadow root, recording the mode it asked for. */
async function openShadow(page) {
    await page.addInitScript(() => {
        const attach = window.Element.prototype.attachShadow;
        window.__shadowModes = [];
        window.Element.prototype.attachShadow = function attachShadow(init) {
            window.__shadowModes.push(init.mode);
            return attach.call(this, { ...init, mode: 'open' });
        };
    });
}

/** A visitor with the shadow root visible to the test, every tracker request recorded. */
async function visitor(page) {
    await asVisitor(page);
    await openShadow(page);
    return captureTracking(page);
}

/** Record every consent event the page fires. */
async function recordEvents(page) {
    await page.addInitScript(() => {
        window.__consentEvents = [];
        window.addEventListener('viewcounter:consent', (event) => window.__consentEvents.push(event.detail.status));
    });
}

const lab = (query = '') => `/consent-lab/start?privacy=${encodeURIComponent(PRIVACY)}${query ? `&${query}` : ''}`;
const prompt = (page) => page.getByRole('region', { name: 'Usage statistics' });
const status = (page) => page.evaluate(() => window.viewcounterConsent.status());
const stored = (page) => page.evaluate((key) => window.localStorage.getItem(key), KEY);
const trackerTags = (page) => page.locator('script[src$="/tracker.js"]');
/**
 * Whether the prompt is on screen, for a test that cannot see into its closed
 * root: what is in its corner of the window is then the prompt's host.
 */
const cardShown = (page) => page.evaluate(() => {
    const host = document.querySelector('viewcounter-consent');
    return Boolean(host) && document.elementFromPoint(window.innerWidth - 40, window.innerHeight - 40) === host;
});

test('on a host not in data-hosts it does nothing at all', async ({ page }) => {
    const sent = await visitor(page);
    await page.goto(lab('hosts=example.com,www.example.com'));
    await page.waitForTimeout(300);
    expect(await page.locator('viewcounter-consent').count()).toBe(0);
    expect(await page.evaluate(() => window.viewcounterConsent)).toBeUndefined();
    await page.click('#settings');
    await page.waitForTimeout(200);
    expect(await page.locator('viewcounter-consent').count()).toBe(0);
    expect(await trackerTags(page).count()).toBe(0);
    expect(sent).toEqual({ views: [], engagement: [], events: [] });
});

test('on a listed host, an unanswered visitor is asked, plainly, with both answers alike', async ({ page, baseURL }) => {
    const sent = await visitor(page);
    await page.goto(lab(`hosts=example.com,${new URL(baseURL).hostname}`));
    const region = prompt(page);
    await expect(region).toBeVisible();
    await expect(region).toContainText('May I count in more detail how this site is used?');
    await expect(region).toContainText('Without your consent I only count which pages are opened.');
    await expect(region).toContainText('No cookies, nothing personal, nothing shared.');
    const allow = region.getByRole('button', { name: 'Allow' });
    const deny = region.getByRole('button', { name: 'No thanks' });
    await expect(allow).toBeVisible();
    await expect(deny).toBeVisible();
    // Equal weight: the same size and the same look.
    const look = (button) => button.evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.backgroundColor, style.color, style.fontWeight, style.borderColor, Math.round(node.getBoundingClientRect().width)];
    });
    expect(await look(allow)).toEqual(await look(deny));
    const link = region.getByRole('link', { name: 'Privacy notice' });
    await expect(link).toHaveAttribute('href', PRIVACY);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener');

    expect(await status(page)).toBe('unset');
    expect(await page.evaluate(() => window.__shadowModes)).toEqual(['closed']);
    // Asking is not counting: nothing is loaded or sent until there is a yes.
    expect(await trackerTags(page).count()).toBe(0);
    expect(sent.views).toEqual([]);
});

test('the prompt does not block the page: no backdrop, and the page stays usable', async ({ page }) => {
    await visitor(page);
    await page.goto(lab());
    await expect(prompt(page)).toBeVisible();
    await page.evaluate(() => {
        window.__clicks = 0;
        document.getElementById('page-button').addEventListener('click', () => { window.__clicks += 1; });
    });
    await page.click('#page-button');
    await page.fill('#page-input', 'still typing');
    await page.mouse.wheel(0, 800);
    expect(await page.evaluate(() => window.__clicks)).toBe(1);
    await expect(page.locator('#page-input')).toHaveValue('still typing');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    // It covers a corner, not the page.
    const box = await prompt(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box.width * box.height).toBeLessThan(viewport.width * viewport.height * 0.2);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
    // And the prompt did not take focus from the page by itself.
    await expect(page.locator('#page-input')).toBeFocused();
});

test('Allow loads the tracker with the site\'s options, and the tracker sends the view', async ({ page }) => {
    await recordEvents(page);
    const sent = await visitor(page);
    await page.goto(lab('spa=false&heartbeat=false'));
    await prompt(page).getByRole('button', { name: 'Allow' }).click();

    await expect.poll(() => sent.views.length).toBe(1);
    expect(sent.views[0].searchParams.get('appId')).toBe('blog');
    await expect(prompt(page)).toBeHidden();
    expect(await status(page)).toBe('granted');
    expect(await stored(page)).toBe('granted');
    expect(await page.evaluate(() => window.__consentEvents)).toEqual(['granted']);

    const tag = trackerTags(page);
    await expect(tag).toHaveCount(1);
    expect(await tag.evaluate((node) => ({ ...node.dataset }))).toEqual({ app: 'blog', spa: 'false', heartbeat: 'false' });
    // The site's options reached the tracker: with data-spa="false" a history change is no view.
    await page.evaluate(() => window.history.pushState({}, '', '/consent-lab/next'));
    await page.waitForTimeout(300);
    expect(sent.views).toHaveLength(1);
});

test('No thanks loads nothing and sends nothing, now or after a reload', async ({ page }) => {
    await recordEvents(page);
    const sent = await visitor(page);
    await page.goto(lab());
    await prompt(page).getByRole('button', { name: 'No thanks' }).click();
    await expect(prompt(page)).toBeHidden();
    expect(await status(page)).toBe('denied');
    expect(await stored(page)).toBe('denied');
    expect(await page.evaluate(() => window.__consentEvents)).toEqual(['denied']);

    await page.reload();
    await page.waitForTimeout(300);
    await expect(prompt(page)).toHaveCount(0);
    expect(await status(page)).toBe('denied');
    expect(await trackerTags(page).count()).toBe(0);
    expect(sent).toEqual({ views: [], engagement: [], events: [] });
    // Saying no costs nothing: the page works as before.
    await page.click('#page-button');
});

test('a yes is remembered: after a reload there is no prompt, and the view is sent', async ({ page }) => {
    const sent = await visitor(page);
    await page.goto(lab());
    await prompt(page).getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => sent.views.length).toBe(1);

    await page.reload();
    await expect.poll(() => sent.views.length).toBe(2);
    await expect(prompt(page)).toHaveCount(0);
    expect(await status(page)).toBe('granted');
});

test('a link with data-viewcounter-consent opens the prompt again, with the answer given, to change it', async ({ page }) => {
    const sent = await visitor(page);
    await page.goto(lab());
    await prompt(page).getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => sent.views.length).toBe(1);

    await page.click('#settings');
    const region = prompt(page);
    await expect(region).toBeVisible();
    await expect(region).toContainText('Your current answer: allowed.');
    // Opened on request, so the keyboard lands in it; the link did not navigate.
    await expect(region.getByRole('button', { name: 'Allow' })).toBeFocused();
    expect(new URL(page.url()).hash).toBe('');

    await region.getByRole('button', { name: 'No thanks' }).click();
    expect(await status(page)).toBe('denied');
    // Focus goes back to where it was.
    await expect(page.locator('#settings')).toBeFocused();
    await page.evaluate(() => window.viewcounterConsent.open());
    await expect(prompt(page)).toContainText('Your current answer: no.');
});

test('a no after a yes stops every further request at once, without a reload', async ({ page }) => {
    await recordEvents(page);
    const sent = await visitor(page);
    await page.goto(lab());
    await prompt(page).getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => sent.views.length).toBe(1);
    await page.evaluate(() => window.viewcounter.track('before'));
    await expect.poll(() => sent.events.length).toBe(1);

    await page.evaluate(() => window.viewcounterConsent.deny());
    expect(await page.evaluate(() => window.__consentEvents)).toEqual(['granted', 'denied']);
    // A page change, a custom event, the page being hidden: none of it is sent.
    await page.evaluate(() => window.history.pushState({}, '', '/consent-lab/after'));
    await page.evaluate(() => window.viewcounter.track('after'));
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new window.Event('visibilitychange'));
    });
    await page.waitForTimeout(400);
    expect(sent.views).toHaveLength(1);
    expect(sent.events).toHaveLength(1);
    expect(sent.engagement).toEqual([]);

    // A yes again resumes, with the same tracker: it is not loaded twice. The
    // page changed while the answer was no; its view goes now.
    await page.evaluate(() => window.viewcounterConsent.grant());
    await expect.poll(() => sent.views.length).toBe(2);
    expect(sent.views[1].searchParams.get('page')).toBe('/consent-lab/after');
    await page.evaluate(() => window.history.pushState({}, '', '/consent-lab/again'));
    await expect.poll(() => sent.views.length).toBe(3);
    await expect(trackerTags(page)).toHaveCount(1);
});

test('a no that comes while the tracker is still loading holds its view back until the next yes', async ({ page }) => {
    const sent = await visitor(page);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/tracker.js', async (route) => {
        await held;
        await route.continue();
    });
    await page.goto(lab());
    await prompt(page).getByRole('button', { name: 'Allow' }).click();
    await page.evaluate(() => window.viewcounterConsent.deny());
    release();
    await expect.poll(() => page.evaluate(() => Boolean(window.viewcounter))).toBe(true);
    await page.waitForTimeout(300);
    expect(sent.views).toEqual([]);

    await page.evaluate(() => window.viewcounterConsent.grant());
    await expect.poll(() => sent.views.length).toBe(1);
    // Still the page's first view, saying how long the page had been open.
    expect(sent.views[0].searchParams.get('age')).toMatch(/^\d+$/);
});

test('an answer the site gives as the page loads leaves no prompt behind', async ({ page }) => {
    const sent = await visitor(page);
    await page.goto(lab('answer=grant'));
    await expect.poll(() => sent.views.length).toBe(1);
    await page.waitForTimeout(200);
    await expect(prompt(page)).toHaveCount(0);
    await page.goto(lab('answer=deny'));
    await page.waitForTimeout(300);
    await expect(prompt(page)).toHaveCount(0);
});

test('a tracker the page loads itself is not loaded a second time, and waits for the answer too', async ({ page }) => {
    const sent = await visitor(page);
    await page.goto(lab('tracker=after'));
    await expect(prompt(page)).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent.views).toEqual([]);
    await prompt(page).getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => sent.views.length).toBe(1);
    await page.waitForTimeout(300);
    expect(sent.views).toHaveLength(1);
    await expect(trackerTags(page)).toHaveCount(1);
});

test.describe('language', () => {
    test('data-lang="de" asks in German', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('lang=de'));
        const region = page.getByRole('region', { name: 'Nutzungsstatistik' });
        await expect(region).toContainText('Darf ich genauer zählen, wie diese Seite genutzt wird?');
        await expect(region).toContainText('Ohne Ihre Einwilligung zähle ich nur, welche Seiten aufgerufen werden.');
        await expect(region).toContainText('Keine Cookies, nichts Persönliches, keine Weitergabe.');
        await expect(region.getByRole('button', { name: 'Erlauben' })).toBeVisible();
        await expect(region.getByRole('button', { name: 'Nein danke' })).toBeVisible();
        await expect(region.getByRole('link', { name: 'Datenschutzerklärung' })).toHaveAttribute('href', PRIVACY);
    });

    test('without data-lang, a page whose <html lang> starts with "de" is asked in German', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('htmlLang=de-DE'));
        await expect(page.getByRole('region', { name: 'Nutzungsstatistik' })).toBeVisible();
    });

    test('any other page in English, and data-lang wins over <html lang>', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('htmlLang=fr'));
        await expect(prompt(page)).toBeVisible();
        await page.goto(lab('htmlLang=de&lang=en'));
        await expect(prompt(page)).toBeVisible();
    });

    test('data-edge="false" does not claim that pages are counted without consent', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('edge=false'));
        await expect(prompt(page)).toContainText('Without your consent nothing is counted.');
        await expect(prompt(page)).not.toContainText('I only count');
    });
});

test.describe('the keyboard, on the page as it really is', () => {
    test('the prompt is in a closed shadow root: the page cannot reach into it', async ({ page }) => {
        await asVisitor(page);
        await page.goto(lab());
        await expect.poll(() => cardShown(page)).toBe(true);
        expect(await page.locator('viewcounter-consent').evaluate((host) => host.shadowRoot)).toBeNull();
    });

    test('Tab reaches Allow, No thanks, and the privacy notice, and Enter answers', async ({ page }) => {
        const sent = await captureTracking(page);
        await asVisitor(page);
        await page.goto(lab());
        // Inside a closed root only its host is visible to the page; the
        // browser's accessibility tree still says which control has focus.
        const cdp = await page.context().newCDPSession(page);
        const focused = async () => {
            const { nodes } = await cdp.send('Accessibility.getFullAXTree');
            const node = nodes.find((candidate) => candidate.role?.value !== 'RootWebArea'
                && (candidate.properties || []).some((property) => property.name === 'focused' && property.value.value));
            return node ? `${node.role.value}: ${node.name.value}` : null;
        };
        await page.locator('#settings').focus();
        // Out of the page's last link, into the prompt, which comes after it.
        await page.keyboard.press('Tab');
        expect(await focused()).toBe('button: Allow');
        await page.keyboard.press('Tab');
        expect(await focused()).toBe('button: No thanks');
        await page.keyboard.press('Tab');
        expect(await focused()).toBe('link: Privacy notice');
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Shift+Tab');
        expect(await focused()).toBe('button: Allow');
        await page.keyboard.press('Enter');
        await expect.poll(() => sent.views.length).toBe(1);
        expect(await page.evaluate(() => window.viewcounterConsent.status())).toBe('granted');
        expect(await cardShown(page)).toBe(false);
    });

    test('Escape puts the prompt away for this page without an answer', async ({ page }) => {
        const sent = await captureTracking(page);
        await asVisitor(page);
        await page.goto(lab());
        await page.locator('#settings').focus();
        await page.keyboard.press('Tab');
        expect(await cardShown(page)).toBe(true);
        await page.keyboard.press('Escape');
        await expect.poll(() => cardShown(page)).toBe(false);
        expect(await page.evaluate(() => window.viewcounterConsent.status())).toBe('unset');
        expect(await page.evaluate((key) => window.localStorage.getItem(key), KEY)).toBeNull();
        // Asked again on the next page.
        await page.reload();
        await expect.poll(() => cardShown(page)).toBe(true);
        expect(sent.views).toEqual([]);
    });

    test('Escape typed into the page\'s own field is the page\'s', async ({ page }) => {
        await asVisitor(page);
        await page.goto(lab());
        await page.locator('#page-input').focus();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        expect(await cardShown(page)).toBe(true);
    });

    test('opened from the settings link, Escape returns focus to the link', async ({ page }) => {
        await asVisitor(page);
        await page.goto(lab());
        await page.locator('#settings').focus();
        await page.keyboard.press('Enter');
        // The first button has focus, inside the host.
        expect(await page.evaluate(() => document.activeElement.localName)).toBe('viewcounter-consent');
        await page.keyboard.press('Escape');
        await expect(page.locator('#settings')).toBeFocused();
        expect(await cardShown(page)).toBe(false);
        expect(await page.evaluate(() => window.viewcounterConsent.status())).toBe('unset');
    });
});

test('without storage (it throws), the visitor is asked on every page and the answer holds for the page', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
    });
    const sent = await visitor(page);
    await page.goto(lab());
    await prompt(page).getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => sent.views.length).toBe(1);
    expect(await status(page)).toBe('granted');

    await page.reload();
    await expect(prompt(page)).toBeVisible();
    expect(await status(page)).toBe('unset');
    expect(sent.views).toHaveLength(1);
});

test('data-ui="none" never asks by itself; the site asks through the API', async ({ page }) => {
    const sent = await visitor(page);
    await page.goto(lab('ui=none'));
    await page.waitForTimeout(300);
    await expect(prompt(page)).toHaveCount(0);
    await page.evaluate(() => window.viewcounterConsent.grant());
    await expect.poll(() => sent.views.length).toBe(1);
    // The built-in prompt still opens when asked for.
    await page.evaluate(() => window.viewcounterConsent.open());
    await expect(prompt(page)).toBeVisible();
});

test('without data-privacy-url, or with one that is not http(s), there is no link', async ({ page }) => {
    await visitor(page);
    await page.goto('/consent-lab/start');
    await expect(prompt(page)).toBeVisible();
    await expect(prompt(page).getByRole('link')).toHaveCount(0);
    await page.goto('/consent-lab/start?privacy=javascript:alert(1)');
    await expect(prompt(page)).toBeVisible();
    await expect(prompt(page).getByRole('link')).toHaveCount(0);
});

test('an answer in another tab of the site is this tab\'s too', async ({ page, context }) => {
    const sent = await visitor(page);
    await page.goto(lab());
    await expect(prompt(page)).toBeVisible();

    const other = await context.newPage();
    await visitor(other);
    await other.goto(lab());
    await prompt(other).getByRole('button', { name: 'Allow' }).click();

    await expect(prompt(page)).toBeHidden();
    await expect.poll(() => sent.views.length).toBe(1);
    expect(await status(page)).toBe('granted');
    await other.close();
});

test.describe('look', () => {
    const background = (page) => prompt(page).evaluate((node) => getComputedStyle(node).backgroundColor);

    test('it follows the visitor\'s light or dark preference', async ({ page }) => {
        await visitor(page);
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(lab());
        const light = await background(page);
        await page.emulateMedia({ colorScheme: 'dark' });
        const dark = await background(page);
        expect(light).toBe('rgb(255, 255, 255)');
        expect(dark).not.toBe(light);
    });

    test('custom properties on the host element restyle it; the page\'s other CSS does not', async ({ page }) => {
        await visitor(page);
        await page.goto(lab());
        await page.addStyleTag({ content: `
            viewcounter-consent { --viewcounter-consent-background: rgb(1, 2, 3); --viewcounter-consent-color: rgb(250, 251, 252); }
            button, p, div { background: red !important; color: lime !important; font-size: 40px !important; }
        ` });
        expect(await background(page)).toBe('rgb(1, 2, 3)');
        const text = await prompt(page).evaluate((node) => getComputedStyle(node).color);
        expect(text).toBe('rgb(250, 251, 252)');
        const button = await prompt(page).getByRole('button', { name: 'Allow' }).evaluate((node) => getComputedStyle(node).fontSize);
        expect(button).toBe('14px');
    });
});

test.describe('data-consent-key', () => {
    test('apps that share a key share one answer: a site whose blog is another app asks once', async ({ page }) => {
        const sent = await visitor(page);
        await page.goto(lab('key=officeparser'));
        await prompt(page).getByRole('button', { name: 'Allow' }).click();
        await expect.poll(() => sent.views.length).toBe(1);
        expect(await page.evaluate(() => window.localStorage.getItem('viewcounter-consent:officeparser'))).toBe('granted');
        expect(await stored(page)).toBeNull();

        await page.goto(lab('app=officeparserblog&key=officeparser'));
        await expect.poll(() => sent.views.length).toBe(2);
        await expect(prompt(page)).toHaveCount(0);
        // Each app's views are still its own.
        expect(sent.views[1].searchParams.get('appId')).toBe('officeparserblog');
    });

    test('without a key, each app asks for its own answer', async ({ page }) => {
        await visitor(page);
        await page.goto(lab());
        await prompt(page).getByRole('button', { name: 'Allow' }).click();
        await page.goto(lab('app=officeparserblog'));
        await expect(prompt(page)).toBeVisible();
    });

    test('a key that is not a plain name is ignored for the app ID', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('key=a.b:c'));
        await prompt(page).getByRole('button', { name: 'No thanks' }).click();
        expect(await stored(page)).toBe('denied');
    });
});

test.describe('screen readers', () => {
    const announcement = (page) => page.getByRole('status');

    test('a prompt that appears by itself is announced once, politely, without taking focus', async ({ page }) => {
        await visitor(page);
        await page.goto(lab());
        await expect(announcement(page)).toHaveText('A question about usage statistics is waiting at the end of the page.');
        await expect(announcement(page)).toHaveAttribute('aria-live', 'polite');
        // The card itself is not live: it would be read out on every change.
        expect(await prompt(page).getAttribute('aria-live')).toBeNull();
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        // Answered, the announcement is gone with the card.
        await prompt(page).getByRole('button', { name: 'No thanks' }).click();
        await expect(announcement(page)).toHaveText('');
    });

    test('in German on a German page', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('lang=de'));
        await expect(announcement(page)).toHaveText('Am Ende der Seite wartet eine Frage zur Nutzungsstatistik.');
    });

    test('opened on request, focus says where the reader is, and nothing is announced', async ({ page }) => {
        await visitor(page);
        await page.goto(lab('ui=none'));
        await page.click('#settings');
        await expect(prompt(page).getByRole('button', { name: 'Allow' })).toBeFocused();
        await page.waitForTimeout(300);
        await expect(announcement(page)).toHaveText('');
    });
});

test('a prerendered page asks only once it is shown', async ({ page }) => {
    await page.addInitScript(() => {
        window.__prerendering = true;
        Object.defineProperty(document, 'prerendering', { configurable: true, get: () => window.__prerendering });
    });
    await visitor(page);
    await page.goto(lab());
    await page.waitForTimeout(400);
    await expect(prompt(page)).toHaveCount(0);
    await page.evaluate(() => {
        window.__prerendering = false;
        document.dispatchEvent(new window.Event('prerenderingchange'));
    });
    await expect(prompt(page)).toBeVisible();
});
