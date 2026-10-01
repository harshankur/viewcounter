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

for (const tab of ['overview', 'views', 'trash', 'tracking-log', 'admin-log']) {
    test(`the ${tab} tab never scrolls sideways`, async ({ page }) => {
        await signIn(page, tab);
        expect(await sidewaysOverflow(page)).toEqual([]);
    });
}

/**
 * Every width between the phone and desktop projects, where a table has the
 * least room: it reflows by moving the columns that do not fit under each row
 * (or turning into cards), never by squeezing the page column away, clipping
 * a header or a timestamp, or scrolling sideways.
 */
const SWEEP_WIDTHS = [1920, 1600, 1440, 1366, 1280, 1180, 1100, 1024, 961, 900, 800, 768, 721];
/** The page column is what a view is about, so it keeps a readable width. */
const PAGE_COLUMN_MIN_PX = 200;

function tableFit(page) {
    return page.evaluate(() => {
        const table = document.querySelector('[role="tabpanel"]:not([hidden]) table');
        const shown = (node) => getComputedStyle(node).display !== 'none';
        const clipped = (node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
        const cards = !shown(table.querySelector('thead'));
        const pageHeader = table.querySelector('thead th.col-page');
        return {
            cards,
            pageWidth: !cards && pageHeader && shown(pageHeader) ? pageHeader.getBoundingClientRect().width : null,
            clippedHeaders: cards ? [] : [...table.querySelectorAll('thead th')]
                .filter((th) => shown(th) && th.scrollWidth > th.clientWidth + 1)
                .map((th) => th.className),
            clippedTimes: [...table.querySelectorAll('tbody td.col-time .clamp')].filter(clipped).length,
            clippedBadges: [...table.querySelectorAll('tbody .badges')].filter(clipped).length,
        };
    });
}

test.describe('at every width between phone and desktop', () => {
    test.skip(({ isMobile }) => isMobile, 'the desktop project sweeps the widths');

    const appTab = (page, name) => activePanel(page).getByRole('tab', { name: new RegExp(`^${name},`) });
    const panels = [
        ['all apps', (page) => signIn(page)],
        ['one app', async (page) => {
            await signIn(page);
            await appTab(page, 'blog').click();
            await expect(appTab(page, 'blog')).toHaveAttribute('aria-selected', 'true');
            await expect(activePanel(page).locator('table')).not.toHaveAttribute('aria-busy', 'true');
        }],
        ['trash', (page) => signIn(page, 'trash')],
        ['admin log', (page) => signIn(page, 'admin-log')],
        ['tracking log', (page) => signIn(page, 'tracking-log')],
    ];

    for (const [label, open] of panels) {
        test(`the ${label} table reflows without clipping or scrolling sideways`, async ({ page }) => {
            await open(page);
            const failures = [];
            for (const width of SWEEP_WIDTHS) {
                await page.setViewportSize({ width, height: 900 });
                await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
                const overflow = await sidewaysOverflow(page);
                const fit = await tableFit(page);
                if (overflow.length) failures.push(`${width}px scrolls sideways: ${overflow.join(', ')}`);
                if (fit.pageWidth !== null && fit.pageWidth < PAGE_COLUMN_MIN_PX) failures.push(`${width}px page column is ${Math.round(fit.pageWidth)}px`);
                if (fit.clippedHeaders.length) failures.push(`${width}px clipped headers: ${fit.clippedHeaders.join(', ')}`);
                if (fit.clippedTimes) failures.push(`${width}px ${fit.clippedTimes} timestamps truncated`);
                if (fit.clippedBadges) failures.push(`${width}px ${fit.clippedBadges} badge groups clipped`);
            }
            expect(failures).toEqual([]);
        });
    }
});

test.describe('the Overview at every width between phone and desktop', () => {
    test.skip(({ isMobile }) => isMobile, 'the desktop project sweeps the widths');

    test('reflows its tiles, charts, and cards without scrolling sideways', async ({ page }) => {
        await signIn(page, 'overview');
        const failures = [];
        for (const width of SWEEP_WIDTHS) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
            const overflow = await sidewaysOverflow(page);
            if (overflow.length) failures.push(`${width}px scrolls sideways: ${overflow.join(', ')}`);
            // Tiles sit in even rows: never a lone tile, or seven and two.
            const perRow = await page.evaluate(() => {
                const tops = [...document.querySelectorAll('.overview-tiles .stat-tile')].map((node) => Math.round(node.getBoundingClientRect().top));
                return [...new Set(tops)].map((top) => tops.filter((value) => value === top).length);
            });
            if (!['9', '5,4', '3,3,3'].includes(perRow.join(','))) failures.push(`${width}px tiles per row: ${perRow.join(', ')}`);
        }
        expect(failures).toEqual([]);
    });
});

test('the Overview on a phone keeps two tiles a row and every card one column wide', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the phone project checks the phone layout');
    await signIn(page, 'overview');
    expect(await sidewaysOverflow(page)).toEqual([]);
    const columns = await page.evaluate(() => {
        const tops = [...document.querySelectorAll('.overview-tiles .stat-tile')].map((node) => Math.round(node.getBoundingClientRect().top));
        const lefts = new Set([...document.querySelectorAll('.overview-grid > .chart-card')].map((node) => Math.round(node.getBoundingClientRect().left)));
        return { firstRow: tops.filter((top) => top === tops[0]).length, cardColumns: lefts.size };
    });
    expect(columns).toEqual({ firstRow: 2, cardColumns: 1 });
});

test('on a phone each row is a card of the first chosen columns, labelled, with the rest under it', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the phone project checks the phone layout');
    await signIn(page);
    const table = activePanel(page).locator('table');
    await expect(table).toHaveClass(/cards/);
    const first = rows(page).first();
    await expect(first.locator('td[data-label]')).toHaveCount(5);
    expect(await first.locator('td[data-label]').evaluateAll((cells) => cells.map((cell) => cell.dataset.label)))
        .toEqual(['Time', 'App', 'Page', 'Source', 'Status']);
    await first.getByRole('button', { name: 'Show 6 more fields' }).click();
    await expect(activePanel(page).locator('tr.row-more dt')).toHaveText(['Event', 'Location', 'Device', 'Client', 'Engagement', 'Campaign']);
    expect(await sidewaysOverflow(page)).toEqual([]);

    // The chooser is a dialog that fits the phone, and reorders by buttons.
    await activePanel(page).getByRole('button', { name: 'Columns' }).click();
    const dialog = page.getByRole('dialog', { name: 'Columns' });
    await dialog.getByRole('button', { name: 'Move Event up' }).click();
    await dialog.getByRole('button', { name: 'Move Event up' }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    expect(await rows(page).first().locator('td[data-label]').evaluateAll((cells) => cells.map((cell) => cell.dataset.label)))
        .toEqual(['Time', 'App', 'Page', 'Event', 'Source']);
    expect(await sidewaysOverflow(page)).toEqual([]);
});

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
