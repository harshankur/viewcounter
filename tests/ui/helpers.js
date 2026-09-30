/**
 * Shared steps for the Playwright UI suite.
 */

const { expect } = require('@playwright/test');
const { PASSWORD } = require('./server');

/** Each section's name on its tab, by its address after the #. */
const SECTION_NAME = {
    overview: 'Overview',
    views: 'Views',
    trash: 'Trash',
    'tracking-log': 'Tracking log',
    'admin-log': 'Admin log',
};

/** Reset the harness: fresh data, no sessions, fresh rate limits. */
async function resetServer(request) {
    const response = await request.post('/__test__/reset');
    expect(response.status()).toBe(204);
}

/**
 * A top-level section tab, scoped to the sections tab list so it never
 * matches an app tab such as "blog, 61 views".
 * @param {string} name the section's address (views, admin-log) or its name (Views, Admin log)
 */
function sectionTab(page, name) {
    return page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: SECTION_NAME[name] ?? name, exact: true });
}

/** The visible tab panel. */
function activePanel(page) {
    return page.locator('[role="tabpanel"]:not([hidden])');
}

/** Open the UI and sign in, landing on the given section once it has loaded. */
async function signIn(page, section = 'views') {
    await page.goto(`/admin/#${section}`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(sectionTab(page, section)).toHaveAttribute('aria-selected', 'true');
    if (section === 'overview') await expect(activePanel(page).locator('.stat-tile').first()).toBeVisible();
    else await expect(activePanel(page).locator('tbody tr').first()).toBeVisible();
}

/** Rows of the visible table. */
function rows(page) {
    return activePanel(page).locator('tbody tr[data-view-id]');
}

/** The row for one view ID. */
function row(page, id) {
    return activePanel(page).locator(`tbody tr[data-view-id="${id}"]`);
}

module.exports = { resetServer, signIn, sectionTab, activePanel, rows, row, PASSWORD };
