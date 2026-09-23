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
    await expect(page.getByRole('tab', { name: /views/ })).toBeVisible();
    await expect(activePanel(page).locator('tbody tr').first()).toBeVisible();
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

module.exports = { resetServer, signIn, activePanel, rows, row, PASSWORD };
