/**
 * Shared steps for the Playwright UI suite.
 */

const { expect } = require('@playwright/test');
const { PASSWORD } = require('./server');

/** Reset the harness: fresh data, no sessions, fresh rate limits. */
async function resetServer(request) {
    const response = await request.post('/__test__/reset');
    expect(response.status()).toBe(204);
}

/** Open the UI and sign in, landing on the given tab. */
async function signIn(page, tab = 'views') {
    await page.goto(`/admin/#${tab}`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(sectionTab(page, 'views')).toBeVisible();
    await expect(activePanel(page).locator('tbody tr').first()).toBeVisible();
}

/**
 * A top-level section tab (views, trash, admin-log, view-log), scoped to the
 * sections tab list so it never matches an app tab such as "blog, 61 views".
 */
function sectionTab(page, name) {
    return page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name, exact: true });
}

/** The visible tab panel. */
function activePanel(page) {
    return page.locator('[role="tabpanel"]:not([hidden])');
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
