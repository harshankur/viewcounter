/**
 * Layout invariants, at desktop and phone sizes (FRONTEND.md §12, §14):
 * nothing scrolls sideways, and like items share one height.
 */

const { test, expect } = require('@playwright/test');
const { resetServer, signIn, activePanel, rows } = require('./helpers');

test.beforeEach(async ({ request }) => {
    await resetServer(request);
});

/** Elements wider than their box, which would show a horizontal scrollbar. */
function sidewaysOverflow(page) {
    return page.evaluate(() => {
        const offenders = [];
        const root = document.scrollingElement;
        if (root.scrollWidth > root.clientWidth) offenders.push(`document (${root.scrollWidth} > ${root.clientWidth})`);
        for (const node of document.querySelectorAll('main *')) {
            const style = getComputedStyle(node);
            const scrolls = ['auto', 'scroll'].includes(style.overflowX);
            if (scrolls && node.scrollWidth > node.clientWidth) offenders.push(node.className || node.tagName);
        }
        return offenders;
    });
}

for (const tab of ['views', 'trash', 'adminLog', 'viewLog']) {
    test(`the ${tab} tab never scrolls sideways`, async ({ page }) => {
        await signIn(page, tab);
        expect(await sidewaysOverflow(page)).toEqual([]);
    });
}

test('the login screen never scrolls sideways', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.getByLabel('Password')).toBeVisible();
    expect(await sidewaysOverflow(page)).toEqual([]);
});

test('every row of the views table has the same height', async ({ page }) => {
    await signIn(page);
    // Includes the row with a long hostile path and rows with several badges.
    const heights = await rows(page).evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getBoundingClientRect().height))]);
    expect(heights).toHaveLength(1);
});

test('the edit dialog fits the screen without sideways scrolling', async ({ page }) => {
    await signIn(page);
    await rows(page).first().getByRole('button', { name: 'Edit fields' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit view' });
    await expect(dialog).toBeVisible();
    const fits = await dialog.evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth);
    expect(fits).toBe(true);
    expect(await sidewaysOverflow(page)).toEqual([]);
});

test('clamped text reveals its full value on hover only when truncated', async ({ page }) => {
    await signIn(page);
    const clamps = activePanel(page).locator('tbody .clamp');
    const report = await clamps.evaluateAll((nodes) => nodes.map((node) => ({
        truncated: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
        title: node.getAttribute('title'),
        text: node.textContent,
    })));
    for (const entry of report) {
        if (entry.truncated) expect(entry.title).toBe(entry.text);
        else expect(entry.title).toBeNull();
    }
});
