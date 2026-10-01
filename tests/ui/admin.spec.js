/**
 * Admin UI, in a real browser.
 *
 * Covers the FRONTEND.md §11 contract (blocking modal via button, Escape, and
 * backdrop; toast dismissal; keyboard-only custom widgets; theme switching)
 * and every admin operation end to end through the UI.
 */

const { test, expect } = require('@playwright/test');
const { resetServer, signIn, sectionTab, activePanel, rows, row, PASSWORD } = require('./helpers');

const FIRST = '00000000-0000-4000-8000-000000000000';
const SECOND = '00000000-0000-4000-8000-000000000001';
const THIRD = '00000000-0000-4000-8000-000000000002';
const HOSTILE = '00000000-0000-4000-8000-00000000abcd';
const TRASHED = '00000000-0000-4000-8000-0000000000de';

/** The bar of actions that appears while views are selected. */
const batchBar = (page) => activePanel(page).getByRole('region', { name: 'Actions for selected views' });

test.beforeEach(async ({ request, page }) => {
    await resetServer(request);
    const problems = [];
    page.on('console', (message) => {
        // A 401 or 422 the test provoked on purpose is logged by the browser as
        // "Failed to load resource"; that is the API working, not a problem.
        // CSP violations and script errors are still caught.
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
            problems.push(message.text());
        }
    });
    page.on('pageerror', (error) => problems.push(error.message));
    page.problems = problems;
});

test.afterEach(async ({ page }) => {
    // A CSP violation or an uncaught error anywhere fails the test that caused it.
    expect(page.problems).toEqual([]);
});

test.describe('signing in', () => {
    test('a wrong password shows a translated error and stays on the login screen', async ({ page }) => {
        await page.goto('/admin/');
        await page.getByLabel('Password').fill('not the password');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('alert')).toHaveText('That password is not correct.');
        await expect(page.getByRole('tablist')).toBeHidden();
    });

    test('the right password opens every app\'s views together', async ({ page }) => {
        await signIn(page);
        await expect(sectionTab(page, 'views')).toHaveAttribute('aria-selected', 'true');
        await expect(activePanel(page).getByRole('tab', { name: /^All apps,/ })).toHaveAttribute('aria-selected', 'true');
        await expect(rows(page)).toHaveCount(50);
        await expect(activePanel(page).locator('.panel-summary')).toHaveText('64 views · 0 modified · 1 in trash');
    });

    test('the session survives a reload', async ({ page }) => {
        await signIn(page);
        await page.reload();
        await expect(rows(page).first()).toBeVisible();
        await expect(page.getByLabel('Password')).toBeHidden();
    });

    test('signing out returns to the login screen', async ({ page }) => {
        await signIn(page);
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('alert')).toHaveText('You have been signed out.');
        await page.reload();
        await expect(page.getByLabel('Password')).toBeVisible();
    });

    test('an expired session asks to sign in again over the page, not by leaving it', async ({ page, context }) => {
        await signIn(page);
        await context.clearCookies();
        await activePanel(page).getByRole('button', { name: /Page/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Signed out' });
        await expect(dialog).toContainText('Sign in again to carry on where you left off.');
        await expect(dialog.getByLabel('Password')).toBeFocused();
        await expect(page.locator('#app-screen')).toBeVisible();
    });
});

test.describe('untrusted content', () => {
    test('a hostile page title and path render as inert text', async ({ page }) => {
        await signIn(page);
        const hostile = row(page, HOSTILE);
        await expect(hostile).toContainText('<script>window.__xss=1</script>');
        await expect(hostile).toContainText('/<img src=x onerror="window.__xss=1">');
        await expect(hostile.locator('img, script')).toHaveCount(0);
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('the details dialog shows hostile content as text too', async ({ page }) => {
        await signIn(page);
        await row(page, HOSTILE).getByRole('button', { name: 'Show details' }).click();
        const dialog = page.getByRole('dialog', { name: 'View details' });
        await expect(dialog).toContainText('<script>window.__xss=1</script>');
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });
});

test.describe('blocking modal contract', () => {
    const openDeleteConfirm = async (page) => {
        await row(page, FIRST).getByRole('button', { name: 'Move to trash' }).click();
        const dialog = page.getByRole('alertdialog', { name: 'Move 1 view to the trash?' });
        await expect(dialog).toBeVisible();
        return dialog;
    };

    test('Escape cancels and nothing is deleted', async ({ page }) => {
        await signIn(page);
        await openDeleteConfirm(page);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('alertdialog')).toBeHidden();
        await expect(row(page, FIRST)).toBeVisible();
    });

    test('a backdrop click cancels and nothing is deleted', async ({ page }) => {
        await signIn(page);
        await openDeleteConfirm(page);
        await page.mouse.click(5, 5);
        await expect(page.getByRole('alertdialog')).toBeHidden();
        await expect(row(page, FIRST)).toBeVisible();
    });

    test('the Cancel button cancels', async ({ page }) => {
        await signIn(page);
        const dialog = await openDeleteConfirm(page);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await expect(row(page, FIRST)).toBeVisible();
    });

    test('focus is trapped inside the dialog and returns to the opener', async ({ page }) => {
        await signIn(page);
        const opener = row(page, FIRST).getByRole('button', { name: 'Move to trash' });
        const dialog = await openDeleteConfirm(page);
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press('Tab');
            expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        }
        await page.keyboard.press('Shift+Tab');
        expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(opener).toBeFocused();
    });
});

test.describe('delete, restore, erase', () => {
    test('delete moves a view to the trash and out of the statistics', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('button', { name: 'Move to trash' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();

        await expect(page.getByRole('status').filter({ hasText: 'Moved 1 view to the trash.' })).toBeVisible();
        await expect(row(page, FIRST)).toHaveCount(0);
        await expect(activePanel(page).locator('.panel-summary')).toHaveText('63 views · 0 modified · 2 in trash');

        await sectionTab(page, 'trash').click();
        await expect(row(page, FIRST)).toBeVisible();
        await expect(row(page, FIRST).locator('.badge')).toContainText(['In trash']);
    });

    test('the Show deleted switch lists trashed views inline', async ({ page }) => {
        await signIn(page);
        await expect(row(page, TRASHED)).toHaveCount(0);
        await activePanel(page).getByRole('switch', { name: 'Show deleted' }).check({ force: true });
        await activePanel(page).getByRole('button', { name: /Time/ }).click();
        await expect(row(page, TRASHED)).toBeVisible();
        await expect(row(page, TRASHED)).toHaveClass(/row-deleted/);
        await expect(row(page, TRASHED).getByRole('button', { name: 'Restore' })).toBeVisible();
        await expect(row(page, TRASHED).getByRole('button', { name: 'Edit fields' })).toHaveCount(0);
    });

    test('restore brings a view back', async ({ page }) => {
        await signIn(page, 'trash');
        await row(page, TRASHED).getByRole('button', { name: 'Restore' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Restored 1 view.' })).toBeVisible();
        await expect(activePanel(page).getByText('The trash is empty.')).toBeVisible();
    });

    test('erase is a separate, explicit, danger-styled step', async ({ page }) => {
        await signIn(page, 'trash');
        await row(page, TRASHED).getByRole('button', { name: 'Erase permanently' }).click();
        const dialog = page.getByRole('alertdialog', { name: 'Erase 1 view permanently?' });
        await expect(dialog).toContainText('It cannot be restored.');
        const confirm = dialog.getByRole('button', { name: 'Erase permanently' });
        await expect(confirm).toHaveClass(/btn-danger/);
        await confirm.click();
        await expect(page.getByRole('status').filter({ hasText: 'Erased 1 view permanently.' })).toBeVisible();
        await expect(row(page, TRASHED)).toHaveCount(0);
    });

    test('the trash explains the retention period', async ({ page }) => {
        await signIn(page, 'trash');
        await expect(activePanel(page).locator('.notice')).toContainText('erased permanently 30 days after being deleted');
    });

    test('the tracking log explains its retention period', async ({ page }) => {
        await signIn(page, 'tracking-log');
        await expect(activePanel(page).locator('.notice')).toHaveText(
            'Entries are removed automatically 90 days after they are recorded. Views are not affected.');
    });
});

test.describe('staying signed in', () => {
    test('when the session ends mid-use, signing in again over the page carries on where it was', async ({ page, request }) => {
        await signIn(page);
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('Cart');
        await expect(rows(page)).toHaveCount(1);

        await request.post('/__test__/end-sessions');
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('Carts');

        const dialog = page.getByRole('dialog', { name: 'Signed out' });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Password').fill('not the password');
        await dialog.getByRole('button', { name: 'Sign in' }).click();
        await expect(dialog.getByRole('alert')).toHaveText('That password is not correct.');

        await dialog.getByLabel('Password').fill(PASSWORD);
        await dialog.getByLabel('Password').press('Enter');
        await expect(dialog).toBeHidden();
        // The same tab, the same search, now answered.
        await expect(page.locator('#login-screen')).toBeHidden();
        await expect(activePanel(page).getByRole('searchbox', { name: 'Search views' })).toHaveValue('Carts');
        await expect(activePanel(page).locator('.table-message')).toBeVisible();
    });

    test('cancelling the sign-in dialog signs out properly', async ({ page, request }) => {
        await signIn(page);
        await request.post('/__test__/end-sessions');
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('Cart');
        const dialog = page.getByRole('dialog', { name: 'Signed out' });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.locator('#login-screen')).toBeVisible();
        await expect(page.locator('#login-error')).toHaveText('Your session has ended. Please sign in again.');
    });

    test('erasing permanently asks for the password again once it is not recent, then erases', async ({ page, request }) => {
        await signIn(page, 'trash');
        await request.post('/__test__/age-password');
        await row(page, TRASHED).getByRole('button', { name: 'Erase permanently' }).click();
        await page.getByRole('alertdialog', { name: 'Erase 1 view permanently?' }).getByRole('button', { name: 'Erase permanently' }).click();

        const confirm = page.getByRole('dialog', { name: 'Confirm it is you' });
        await expect(confirm).toBeVisible();
        await confirm.getByLabel('Password').fill(PASSWORD);
        await confirm.getByRole('button', { name: 'Confirm' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Erased 1 view permanently.' })).toBeVisible();
        await expect(row(page, TRASHED)).toHaveCount(0);
    });

    test('declining the password leaves the view in the trash', async ({ page, request }) => {
        await signIn(page, 'trash');
        await request.post('/__test__/age-password');
        await row(page, TRASHED).getByRole('button', { name: 'Erase permanently' }).click();
        await page.getByRole('alertdialog', { name: 'Erase 1 view permanently?' }).getByRole('button', { name: 'Erase permanently' }).click();
        await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByText('Enter your password again to continue.')).toBeVisible();
        await expect(row(page, TRASHED)).toHaveCount(1);
    });

    test('an access gateway redirecting to its own sign-in is named, not reported as a network failure', async ({ page }) => {
        await signIn(page);
        await page.route('**/admin/api/views**', (route) => route.fulfill({
            status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
        }));
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('x');
        await expect(page.getByText(/access gateway \(for example Cloudflare Access\) has ended/)).toBeVisible();
    });
});

test.describe('selection and batch operations', () => {
    test('checkboxes work from the keyboard and keep focus', async ({ page }) => {
        await signIn(page);
        const first = row(page, FIRST).getByRole('checkbox');
        await first.focus();
        await page.keyboard.press('Space');
        await expect(first).toBeFocused();
        await expect(first).toBeChecked();
        await page.keyboard.press('Tab');
        await expect(activePanel(page).locator('.batch-count')).toHaveText('1 view selected');
    });

    test('the page checkbox selects every row, and is indeterminate for some', async ({ page }) => {
        await signIn(page);
        const all = activePanel(page).getByRole('checkbox', { name: 'Select every view on this page' });
        await row(page, FIRST).getByRole('checkbox').check();
        expect(await all.evaluate((node) => node.indeterminate)).toBe(true);
        await all.check();
        await expect(activePanel(page).locator('.batch-count')).toHaveText('50 views selected');
        await batchBar(page).getByRole('button', { name: 'Clear selection' }).click();
        await expect(activePanel(page).getByRole('region', { name: 'Actions for selected views' })).toBeHidden();
    });

    test('a selection survives paging', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('checkbox').check();
        await activePanel(page).getByRole('button', { name: 'Next' }).click();
        await expect(activePanel(page).locator('.pager-summary')).toHaveText('Page 2 of 2 · 64 entries');
        await expect(activePanel(page).locator('.batch-count')).toHaveText('1 view selected');
    });

    test('batch edit changes only the ticked field and marks rows modified', async ({ page }) => {
        await signIn(page);
        for (const id of [FIRST, SECOND]) await row(page, id).getByRole('checkbox').check();
        await batchBar(page).getByRole('button', { name: 'Edit fields' }).click();

        const dialog = page.getByRole('dialog', { name: 'Edit 2 views' });
        await dialog.getByLabel('Page title', { exact: true }).fill('Renamed in bulk');
        await expect(dialog.getByRole('checkbox', { name: 'Change Page title' })).toBeChecked();
        await expect(dialog.getByRole('checkbox', { name: 'Change Page path' })).not.toBeChecked();
        await dialog.getByRole('button', { name: 'Save changes' }).click();

        await expect(page.getByRole('status').filter({ hasText: 'Edited 2 views.' })).toBeVisible();
        for (const id of [FIRST, SECOND]) {
            await expect(row(page, id)).toContainText('Renamed in bulk');
            await expect(row(page, id).locator('.badge')).toContainText(['Modified']);
        }
        await expect(row(page, THIRD)).not.toContainText('Renamed in bulk');
    });

    test('saving an edit with nothing ticked explains why and stays open', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('checkbox').check();
        await row(page, SECOND).getByRole('checkbox').check();
        await batchBar(page).getByRole('button', { name: 'Edit fields' }).click();
        const dialog = page.getByRole('dialog', { name: 'Edit 2 views' });
        await dialog.getByRole('button', { name: 'Save changes' }).click();
        await expect(dialog.getByRole('alert')).toHaveText('Choose at least one field to change.');
        await expect(dialog).toBeVisible();
    });

    test('invalid event data is caught before anything is sent', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('button', { name: 'Edit fields' }).click();
        const dialog = page.getByRole('dialog', { name: 'Edit view' });
        await dialog.getByLabel('Event data', { exact: true }).fill('{not json');
        await dialog.getByRole('button', { name: 'Save changes' }).click();
        await expect(dialog.getByRole('alert').first()).toHaveText('This is not valid JSON.');
        await expect(dialog).toBeVisible();
    });

    test('a single edit sends only the fields that changed', async ({ page }) => {
        await signIn(page);
        const requests = [];
        page.on('request', (request) => {
            if (request.method() === 'PATCH') requests.push(request.postDataJSON());
        });
        await row(page, FIRST).getByRole('button', { name: 'Edit fields' }).click();
        const dialog = page.getByRole('dialog', { name: 'Edit view' });
        await expect(dialog.getByLabel('Page path', { exact: true })).toHaveValue('/');
        await dialog.getByLabel('Referrer', { exact: true }).fill('https://www.google.com/search?q=x');
        await dialog.getByRole('button', { name: 'Save changes' }).click();
        await expect(row(page, FIRST)).toContainText('Search');
        expect(requests).toEqual([{ ids: [FIRST], changes: { referrer: 'https://www.google.com/search?q=x' } }]);
    });

    test('batch note sets a note without marking rows modified', async ({ page }) => {
        await signIn(page);
        for (const id of [FIRST, SECOND]) await row(page, id).getByRole('checkbox').check();
        await batchBar(page).getByRole('button', { name: 'Set note' }).click();
        const dialog = page.getByRole('dialog', { name: 'Note for 2 views' });
        await dialog.getByLabel('Note', { exact: true }).fill('Bot traffic from a crawler');
        await dialog.getByRole('button', { name: 'Save note' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Saved the note on 2 views.' })).toBeVisible();
        await expect(row(page, FIRST).locator('.badge')).toContainText(['Note']);
        await expect(row(page, FIRST).locator('.badge')).not.toContainText(['Modified']);
    });

    test('a note can be cleared', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('button', { name: 'Edit note' }).click();
        await page.getByRole('dialog').getByLabel('Note', { exact: true }).fill('temporary');
        await page.getByRole('dialog').getByRole('button', { name: 'Save note' }).click();
        await expect(row(page, FIRST).locator('.badge')).toContainText(['Note']);
        await row(page, FIRST).getByRole('button', { name: 'Edit note' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Clear note' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Cleared the note on 1 view.' })).toBeVisible();
        await expect(row(page, FIRST).locator('.badge')).toHaveCount(1);
    });
});

test.describe('searching and filtering', () => {
    test('search narrows the list', async ({ page }) => {
        await signIn(page);
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('mini PC');
        await expect(rows(page)).toHaveCount(12);
        await expect(activePanel(page).locator('.pager-summary')).toHaveText('Page 1 of 1 · 12 entries');
    });

    test('a search with no hits says so', async ({ page }) => {
        await signIn(page);
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('nothing matches this');
        await expect(activePanel(page).getByText('No views match.')).toBeVisible();
    });

    test('the modified filter shows only admin-edited views', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('button', { name: 'Edit fields' }).click();
        await page.getByRole('dialog').getByLabel('Page title', { exact: true }).fill('Changed');
        await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
        await expect(row(page, FIRST).locator('.badge')).toContainText(['Modified']);

        await activePanel(page).getByRole('button', { name: 'Modified', exact: true }).click();
        await expect(rows(page)).toHaveCount(1);
        await activePanel(page).getByRole('button', { name: 'Original' }).click();
        await expect(rows(page)).toHaveCount(50);
        await expect(row(page, FIRST)).toHaveCount(0);
    });

    test('a header sorts and exposes the order to assistive technology', async ({ page }) => {
        await signIn(page);
        const header = activePanel(page).locator('th.col-page');
        await expect(header).toHaveAttribute('aria-sort', 'none');
        await header.getByRole('button').click();
        await expect(header).toHaveAttribute('aria-sort', 'descending');
        await expect(header.getByRole('button')).toBeFocused();
        await header.getByRole('button').click();
        await expect(header).toHaveAttribute('aria-sort', 'ascending');
        await expect(rows(page).first()).toContainText('/');
    });
});

test.describe('app tabs', () => {
    const appTab = (page, name) => activePanel(page).getByRole('tab', { name: new RegExp(`^${name},`) });

    test('each app is a tab with its live view count', async ({ page }) => {
        await signIn(page);
        const tablist = activePanel(page).getByRole('tablist', { name: 'Apps' });
        await expect(tablist.getByRole('tab')).toHaveCount(3);
        await expect(appTab(page, 'All apps')).toHaveAccessibleName('All apps, 64 views');
        await expect(appTab(page, 'All apps')).toHaveAttribute('aria-selected', 'true');
        await expect(appTab(page, 'blog')).toHaveAccessibleName('blog, 61 views');
        await expect(appTab(page, 'shop')).toHaveAccessibleName('shop, 3 views');
        await expect(appTab(page, 'shop')).toHaveAttribute('aria-selected', 'false');
    });

    test('one click opens another app', async ({ page }) => {
        await signIn(page);
        await appTab(page, 'shop').click();
        await expect(appTab(page, 'shop')).toHaveAttribute('aria-selected', 'true');
        await expect(rows(page)).toHaveCount(3);
        await expect(rows(page).first()).toContainText('/cart');
    });

    test('arrow keys, Home, and End switch apps and keep focus', async ({ page }) => {
        await signIn(page);
        await appTab(page, 'All apps').focus();
        await page.keyboard.press('ArrowRight');
        await expect(appTab(page, 'blog')).toBeFocused();
        await expect(appTab(page, 'blog')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('ArrowRight');
        await expect(appTab(page, 'shop')).toBeFocused();
        await expect(rows(page).first()).toContainText('/cart');

        await page.keyboard.press('ArrowRight');
        await expect(appTab(page, 'All apps')).toBeFocused();
        await page.keyboard.press('End');
        await expect(appTab(page, 'shop')).toBeFocused();
        await page.keyboard.press('Home');
        await expect(appTab(page, 'All apps')).toBeFocused();
        await expect(rows(page)).toHaveCount(50);
    });

    test('only the selected app tab is in the tab order', async ({ page }) => {
        await signIn(page);
        await expect(appTab(page, 'All apps')).toHaveAttribute('tabindex', '0');
        await expect(appTab(page, 'blog')).toHaveAttribute('tabindex', '-1');
        await expect(appTab(page, 'shop')).toHaveAttribute('tabindex', '-1');
    });

    test('the trash shows trashed counts and follows the same app', async ({ page }) => {
        await signIn(page);
        await appTab(page, 'shop').click();
        await sectionTab(page, 'trash').click();
        await expect(appTab(page, 'shop')).toHaveAttribute('aria-selected', 'true');
        await expect(appTab(page, 'blog')).toHaveAccessibleName('blog, 1 in trash');
        await expect(activePanel(page).getByText('The trash is empty.')).toBeVisible();
    });

    test('the chosen app is remembered across reloads', async ({ page }) => {
        await signIn(page);
        await appTab(page, 'shop').click();
        await expect(rows(page).first()).toContainText('/cart');
        await page.reload();
        await expect(appTab(page, 'shop')).toHaveAttribute('aria-selected', 'true');
    });
});

test.describe('custom listbox (never a native select)', () => {
    const pageSize = (page) => activePanel(page).getByRole('button', { name: 'Rows per page' });

    test('works by keyboard alone', async ({ page }) => {
        await signIn(page);
        const button = pageSize(page);
        await button.focus();
        await page.keyboard.press('ArrowDown');
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        const listbox = activePanel(page).getByRole('listbox', { name: 'Rows per page' });
        await expect(listbox.getByRole('option', { name: '50 per page' })).toHaveAttribute('aria-selected', 'true');

        await page.keyboard.press('ArrowDown');
        await expect(listbox).toHaveAttribute('aria-activedescendant', /-2$/);
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        await expect(button).toBeFocused();
        await expect(button).toContainText('100 per page');
        await expect(rows(page)).toHaveCount(64);
    });

    test('Escape closes the listbox without changing the value', async ({ page }) => {
        await signIn(page);
        const button = pageSize(page);
        await button.click();
        await page.keyboard.press('Home');
        await page.keyboard.press('Escape');
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        await expect(button).toContainText('50 per page');
    });

    test('a click outside closes it', async ({ page }) => {
        await signIn(page);
        const button = pageSize(page);
        await button.click();
        await page.locator('.panel-summary').first().click();
        await expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    test('the page size picker changes how many rows are shown', async ({ page }) => {
        await signIn(page);
        await activePanel(page).getByRole('button', { name: 'Rows per page' }).click();
        await activePanel(page).getByRole('option', { name: '25 per page' }).click();
        await expect(rows(page)).toHaveCount(25);
    });

    test('there is no native select or date input anywhere', async ({ page }) => {
        await signIn(page);
        await expect(page.locator('select, input[type="date"], input[type="datetime-local"], input[type="time"], input[type="color"]')).toHaveCount(0);
    });
});

test.describe('logs', () => {
    test('the admin log records the sign-in and each operation, without content', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('button', { name: 'Edit fields' }).click();
        await page.getByRole('dialog').getByLabel('Page title', { exact: true }).fill('Secret new title');
        await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
        await expect(row(page, FIRST)).toContainText('Secret new title');

        await sectionTab(page, 'admin-log').click();
        const log = activePanel(page);
        await expect(log.locator('tbody tr')).toHaveCount(2);
        await expect(log.locator('tbody tr').first()).toContainText('Edited');
        await expect(log.locator('tbody tr').first()).toContainText('Page title');
        await expect(log).not.toContainText('Secret new title');
        await expect(log.locator('tbody tr').nth(1)).toContainText('Signed in');
    });

    test('the admin log filters by action', async ({ page }) => {
        await signIn(page, 'admin-log');
        await activePanel(page).getByRole('button', { name: 'Filter by action' }).click();
        await activePanel(page).getByRole('option', { name: 'Failed sign-in' }).click();
        await expect(activePanel(page).getByText('No admin operations recorded yet.')).toBeVisible();
    });

    test('a failed sign-in is recorded', async ({ page }) => {
        await page.goto('/admin/');
        await page.getByLabel('Password').fill('wrong');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await page.getByLabel('Password').fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await sectionTab(page, 'admin-log').click();
        await expect(activePanel(page).locator('tbody tr').nth(1)).toContainText('Failed sign-in');
    });

    test('the tracking log has an entry for every recorded view, at its own time', async ({ page }) => {
        await signIn(page, 'tracking-log');
        await expect(activePanel(page).locator('tbody tr')).toHaveCount(50);
        await expect(activePanel(page).locator('.pager-summary')).toHaveText('Page 1 of 2 · 65 entries');
        await expect(activePanel(page).locator('tbody tr').first()).toContainText('Page view');
        await expect(activePanel(page).locator('tbody tr').first()).toContainText('Recorded');
        await expect(activePanel(page).locator('tbody tr').last()).toContainText('Sep 19, 2026');
    });

    test('tabs move with the arrow keys and are deep-linkable', async ({ page }) => {
        await signIn(page);
        await sectionTab(page, 'views').focus();
        await page.keyboard.press('ArrowRight');
        await expect(sectionTab(page, 'trash')).toBeFocused();
        await expect(page).toHaveURL(/#trash$/);
        await page.reload();
        await expect(sectionTab(page, 'trash')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('End');
        await page.keyboard.press('Home');
        await expect(page).toHaveURL(/#trash$/);
        await sectionTab(page, 'trash').focus();
        await page.keyboard.press('End');
        await expect(sectionTab(page, 'admin-log')).toBeFocused();
        await page.keyboard.press('Home');
        await expect(sectionTab(page, 'overview')).toBeFocused();
    });

    test('addresses from earlier versions still open their section', async ({ page }) => {
        await signIn(page, 'overview');
        await page.goto('/admin/#viewLog');
        await expect(sectionTab(page, 'tracking-log')).toHaveAttribute('aria-selected', 'true');
        await page.goto('/admin/#adminLog');
        await expect(sectionTab(page, 'admin-log')).toHaveAttribute('aria-selected', 'true');
    });
});

test.describe('theme and notices', () => {
    test('the theme switcher applies and remembers the choice', async ({ page }) => {
        await signIn(page);
        const light = page.getByRole('button', { name: 'Light mode' });
        await light.click();
        await expect(page.locator('html')).toHaveClass(/theme-light/);
        await expect(light).toHaveAttribute('aria-pressed', 'true');
        await page.reload();
        await expect(page.locator('html')).toHaveClass(/theme-light/);
        await page.getByRole('button', { name: 'Dark mode' }).click();
        await expect(page.locator('html')).toHaveClass(/theme-dark/);
    });

    test('a toast can be dismissed', async ({ page }) => {
        await signIn(page, 'trash');
        await row(page, TRASHED).getByRole('button', { name: 'Restore' }).click();
        const toast = page.getByRole('status').filter({ hasText: 'Restored 1 view.' });
        await expect(toast).toBeVisible();
        await toast.getByRole('button', { name: 'Dismiss' }).click();
        await expect(toast).toBeHidden();
    });
});

test.describe('every app together, and the table\'s filters', () => {
    const appTab = (page, name) => activePanel(page).getByRole('tab', { name: new RegExp(`^${name},`) });
    const pagerSummary = (page) => activePanel(page).locator('.pager-summary');

    test('the table names each row\'s app', async ({ page }) => {
        await signIn(page);
        await expect(activePanel(page).getByRole('button', { name: /Time/ })).toBeVisible();
        await expect(activePanel(page).locator('th.col-app')).toHaveText('App');
        await expect(row(page, FIRST).locator('.col-app')).toHaveText('blog');
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('Cart');
        await expect(rows(page).first().locator('.col-app')).toHaveText('shop');
    });

    test('the date range narrows the table', async ({ page }) => {
        await signIn(page);
        // The fixture has one view 45 days old and one 200 days old.
        await activePanel(page).getByRole('button', { name: '1 year' }).click();
        await expect(pagerSummary(page)).toHaveText('Page 1 of 2 · 64 entries');
        await activePanel(page).getByRole('button', { name: '90 days' }).click();
        await expect(pagerSummary(page)).toHaveText('Page 1 of 2 · 63 entries');
        await activePanel(page).getByRole('button', { name: '30 days' }).click();
        await expect(pagerSummary(page)).toHaveText('Page 1 of 2 · 62 entries');
        await expect(activePanel(page).getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('the event-type filter offers every type the apps hold', async ({ page }) => {
        await signIn(page);
        await activePanel(page).getByRole('button', { name: 'Event type' }).click();
        await activePanel(page).getByRole('option', { name: 'Download' }).click();
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText('/downloads');
        await expect(rows(page).first().locator('.col-event .cell-primary')).toHaveText('Download');
    });

    test('a batch can span apps', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('checkbox').check();
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('Cart');
        await expect(rows(page)).toHaveCount(1);
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('');
        // A changed search clears the selection, so select both on one page.
        await row(page, FIRST).getByRole('checkbox').check();
        await activePanel(page).getByRole('button', { name: 'Rows per page' }).click();
        await activePanel(page).getByRole('option', { name: '100 per page' }).click();
        await row(page, '00000000-0000-4000-8000-0000000005e0').getByRole('checkbox').check();
        await expect(activePanel(page).locator('.batch-count')).toHaveText('2 views selected');

        await batchBar(page).getByRole('button', { name: 'Move to trash' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Moved 2 views to the trash.' })).toBeVisible();
        await expect(activePanel(page).locator('.panel-summary')).toHaveText('62 views · 0 modified · 3 in trash');
        await expect(appTab(page, 'shop')).toHaveAccessibleName('shop, 2 views');
    });

    test('a batch that fails for one app still applies, and shows, the others', async ({ page }) => {
        const CART = '00000000-0000-4000-8000-0000000005e0';
        await signIn(page);
        await activePanel(page).getByRole('button', { name: 'Rows per page' }).click();
        await activePanel(page).getByRole('option', { name: '100 per page' }).click();
        await row(page, FIRST).getByRole('checkbox').check();
        await row(page, CART).getByRole('checkbox').check();
        await expect(activePanel(page).locator('.batch-count')).toHaveText('2 views selected');

        // blog's request succeeds; shop's fails on the server.
        await page.route('**/api/apps/shop/views/delete', (route) => route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'SERVER_ERROR' }),
        }));
        await batchBar(page).getByRole('button', { name: 'Move to trash' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();

        await expect(page.getByRole('status').filter({ hasText: 'Moved 1 view to the trash.' })).toBeVisible();
        await expect(page.getByText('Something went wrong on the server. Please try again.')).toBeVisible();
        // The blog view really moved, so the table says so; the shop view is
        // untouched and still selected, ready to retry.
        await expect(activePanel(page).locator('.panel-summary')).toHaveText('63 views · 0 modified · 2 in trash');
        await expect(row(page, FIRST)).toHaveCount(0);
        await expect(activePanel(page).locator('.batch-count')).toHaveText('1 view selected');
        await expect(row(page, CART).getByRole('checkbox')).toBeChecked();
    });

    test('a trashed view leaves the Overview\'s numbers at once', async ({ page }) => {
        await signIn(page, 'overview');
        const views = activePanel(page).locator('.stat-tile[data-metric="views"] .stat-value');
        await expect(views).toHaveText('62');
        await sectionTab(page, 'views').click();
        await row(page, FIRST).getByRole('button', { name: 'Move to trash' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Moved 1 view to the trash.' })).toBeVisible();
        await sectionTab(page, 'overview').click();
        await expect(views).toHaveText('61');
    });
});

test.describe('the Overview', () => {
    const appTab = (page, name) => activePanel(page).getByRole('tab', { name: new RegExp(`^${name},`) });
    const tile = (page, metric) => activePanel(page).locator(`.stat-tile[data-metric="${metric}"]`);
    const card = (page, id) => activePanel(page).locator(`.chart-card[data-card="${id}"]`);
    const chip = (page, text) => activePanel(page).locator('.chip', { hasText: text });

    test('opens first, for every app, over the last 30 days', async ({ page }) => {
        await page.goto('/admin/');
        await page.getByLabel('Password').fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(sectionTab(page, 'overview')).toHaveAttribute('aria-selected', 'true');
        await expect(page).toHaveURL(/#overview$/);
        await expect(activePanel(page).getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
        await expect(activePanel(page).getByRole('tab', { name: /^All apps,/ })).toHaveAttribute('aria-selected', 'true');
        await expect(activePanel(page).getByRole('button', { name: '30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
        // 61 blog views in the last day and a half, and the shop's cart 19 days ago.
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('62');
        await expect(tile(page, 'visitors').locator('.stat-value')).toHaveText('22');
    });

    test('the headline numbers follow the app and the period, against the period before', async ({ page }) => {
        await signIn(page, 'overview');
        await activePanel(page).getByRole('button', { name: 'All time', exact: true }).click();
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('64');
        await expect(tile(page, 'views').locator('.stat-delta')).toHaveText('All time');

        await activePanel(page).getByRole('button', { name: '7 days', exact: true }).click();
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('61');
        // Nothing in the 7 days before, so every view is new.
        await expect(tile(page, 'views').locator('.stat-delta')).toContainText('New');
        await expect(tile(page, 'views').locator('.stat-delta')).toContainText('vs the 7 days before');

        await appTab(page, 'shop').click();
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('0');
    });

    test('a headline number is charted over time, readable by keyboard and as a table', async ({ page }) => {
        await signIn(page, 'overview');
        await expect(tile(page, 'visitors')).toHaveAttribute('aria-pressed', 'true');
        await tile(page, 'pageviews').click();
        await expect(tile(page, 'pageviews')).toHaveAttribute('aria-pressed', 'true');
        await expect(tile(page, 'visitors')).toHaveAttribute('aria-pressed', 'false');
        const trend = activePanel(page).locator('.trend-card');
        await expect(trend.getByRole('heading')).toHaveText('Page views over time');

        await trend.locator('.trend-svg').focus();
        await page.keyboard.press('End');
        await expect(trend.locator('.chart-tooltip')).toBeVisible();
        await expect(trend.locator('.chart-tooltip')).toContainText('Page views');

        await trend.getByRole('button', { name: 'Table' }).click();
        const table = trend.locator('table');
        await expect(table.getByRole('columnheader', { name: 'Bounce rate' })).toBeVisible();
        await expect(table.getByRole('columnheader', { name: 'Time on page' })).toBeVisible();
        // A day per row across all 30, newest first.
        await expect(table.locator('tbody tr')).toHaveCount(31);
    });

    test('right now shows who is on the sites', async ({ page }) => {
        await signIn(page, 'overview');
        const live = activePanel(page).locator('.live-card');
        await expect(live.locator('.live-count')).toHaveText('2');
        await expect(live).toContainText('visitors in the last 5 minutes');
        await expect(live.locator('.minute-bar')).toHaveCount(30);
        await expect(live.getByRole('rowheader').first()).toBeVisible();
    });

    test('a breakdown row narrows everything to it, and its chip takes it off', async ({ page }) => {
        await signIn(page, 'overview');
        const sources = card(page, 'sources');
        await sources.getByRole('button', { name: 'Show only Channel: Search' }).click();
        await expect(chip(page, 'Channel: Search')).toBeVisible();
        // Every fourth blog view came from a search engine.
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('15');
        await expect(sources.getByRole('button', { name: 'Show only Channel: Search' })).toHaveCount(0);

        await chip(page, 'Channel: Search').click();
        await expect(chip(page, 'Channel: Search')).toHaveCount(0);
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('62');
    });

    test('"Show these views" opens exactly those rows in Views', async ({ page }) => {
        await signIn(page, 'overview');
        await card(page, 'sources').getByRole('button', { name: 'Show only Channel: Search' }).click();
        await expect(chip(page, 'Channel: Search')).toBeVisible();
        await activePanel(page).getByRole('button', { name: 'Show these views' }).click();

        await expect(sectionTab(page, 'views')).toHaveAttribute('aria-selected', 'true');
        await expect(chip(page, 'Channel: Search')).toBeVisible();
        await expect(activePanel(page).getByRole('button', { name: '30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(activePanel(page).locator('.pager-summary')).toHaveText('Page 1 of 1 · 15 entries');
        await chip(page, 'Channel: Search').click();
        await expect(activePanel(page).locator('.pager-summary')).toHaveText('Page 1 of 2 · 62 entries');
    });

    test('acquisition counts page views; a custom event is no channel', async ({ page }) => {
        await signIn(page, 'overview');
        await activePanel(page).getByRole('button', { name: 'All time', exact: true }).click();
        const sources = card(page, 'sources');
        await expect(sources.getByRole('columnheader', { name: 'Page views' })).toBeVisible();
        await expect(sources).not.toContainText('Unknown');
    });

    test('the map colours countries, lists them in order, and filters by one', async ({ page }) => {
        await signIn(page, 'overview');
        await activePanel(page).getByRole('button', { name: 'All time', exact: true }).click();
        const locations = card(page, 'locations');
        await expect(locations.locator('.map-svg path.country').first()).toBeAttached();
        expect(await locations.locator('.map-svg path.country').count()).toBeGreaterThan(150);
        await expect(locations.locator('.map-svg path[data-code="DE"]')).toHaveClass(/map-5/);
        await expect(locations.locator('.map-svg path[data-code="AU"]')).toHaveClass(/map-0/);
        const first = locations.locator('.country-row').first();
        await expect(first).toContainText('Germany');
        await expect(first).toContainText('15');

        await first.focus();
        await expect(locations.locator('.chart-tooltip')).toBeVisible();
        await expect(locations.locator('.chart-tooltip')).toContainText('Germany');
        await expect(locations.locator('.map-svg path[data-code="DE"]')).toHaveClass(/active/);

        await first.click();
        await expect(chip(page, 'Country: Germany')).toBeVisible();
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('15');
    });

    test('regions and cities say what they need when the server has no city database', async ({ page }) => {
        await signIn(page, 'overview');
        const locations = card(page, 'locations');
        await locations.getByRole('button', { name: 'Cities' }).click();
        await expect(locations).toContainText('Regions and cities need a city database on the server (GEOIP_CITY_DB).');
        await expect(locations).toContainText('This product includes GeoLite2 data created by MaxMind');
    });

    test('the event-type filter narrows the Overview', async ({ page }) => {
        await signIn(page, 'overview');
        await activePanel(page).getByRole('button', { name: 'All time', exact: true }).click();
        await activePanel(page).getByRole('button', { name: 'Event type', exact: true }).click();
        await activePanel(page).getByRole('option', { name: 'Download' }).click();
        await expect(tile(page, 'views').locator('.stat-value')).toHaveText('1');
        const countries = card(page, 'locations').getByRole('list', { name: 'Countries by views' });
        await expect(countries.locator('.country-row')).toHaveCount(1);
        await expect(countries.locator('.country-row').first()).toContainText('Japan');
    });

    test('apps are a breakdown only while every app is shown', async ({ page }) => {
        await signIn(page, 'overview');
        const apps = card(page, 'apps');
        await expect(apps).toContainText('blog');
        await expect(apps).toContainText('61');
        await apps.getByRole('button', { name: 'Show only App: shop' }).click();
        await expect(appTab(page, 'shop')).toHaveAttribute('aria-selected', 'true');
        await expect(apps).toHaveCount(0);
    });

    test('the weekday-by-hour heatmap reads out by keyboard and has a table view', async ({ page }) => {
        await signIn(page, 'overview');
        const when = card(page, 'when');
        await when.locator('.heatmap').focus();
        await page.keyboard.press('ArrowRight');
        await expect(when.locator('.chart-tooltip')).toBeVisible();
        await expect(when.locator('.chart-tooltip')).toContainText('Views');
        await when.getByRole('button', { name: 'Table' }).click();
        await expect(when.locator('table tbody tr')).toHaveCount(24);
        await expect(when.locator('table thead th')).toHaveCount(8);
    });

    test('every card can be read, and each explains an empty view', async ({ page }) => {
        await signIn(page, 'overview');
        for (const id of ['sources', 'pages', 'locations', 'devices', 'browsers', 'systems', 'campaigns', 'events', 'engagement', 'when', 'flow', 'apps']) {
            await expect(card(page, id)).toBeVisible();
        }
        await expect(card(page, 'campaigns')).toContainText('Not tagged');
        await expect(card(page, 'engagement')).toContainText('No time or scrolling measured yet.');
        await card(page, 'pages').getByRole('button', { name: 'Entry' }).click();
        await expect(card(page, 'pages').getByRole('columnheader', { name: 'Bounce' })).toBeVisible();
    });

    test('the period, the chart\'s metric, and each card\'s view are remembered', async ({ page }) => {
        await signIn(page, 'overview');
        await activePanel(page).getByRole('button', { name: '7 days', exact: true }).click();
        await tile(page, 'bounceRate').click();
        await card(page, 'sources').getByRole('button', { name: 'Referrers' }).click();
        await page.reload();
        await expect(activePanel(page).getByRole('button', { name: '7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(tile(page, 'bounceRate')).toHaveAttribute('aria-pressed', 'true');
        await expect(card(page, 'sources').getByRole('button', { name: 'Referrers' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('how each number is counted is one click away', async ({ page }) => {
        await signIn(page, 'overview');
        await activePanel(page).getByText('How these numbers are counted').click();
        await expect(activePanel(page).locator('.metric-help dl')).toContainText('The share of visits that saw only one page.');
    });
});

test.describe('the Tracking log', () => {
    test('says how it differs from Views, and what each outcome means', async ({ page }) => {
        await signIn(page, 'tracking-log');
        const panel = activePanel(page);
        await expect(panel.getByRole('heading', { name: 'Tracking log', level: 2 })).toBeVisible();
        await expect(panel.locator('.panel-intro')).toContainText('Views lists only what was recorded');
        await panel.getByText('What each outcome means').click();
        await expect(panel.locator('.outcome-legend')).toContainText('Never stored; counted here by name, per minute.');
    });

    test('sums up the last day, and filters by outcome', async ({ page }) => {
        await signIn(page, 'tracking-log');
        const panel = activePanel(page);
        await expect(panel.locator('.tracking-summary .stat-tile')).toHaveCount(4);
        await expect(panel.locator('.tracking-summary')).toContainText('Refused');
        await expect(panel.getByText('Nothing refused in the last day.')).toBeVisible();
        await panel.getByRole('button', { name: 'Filter by outcome' }).click();
        await panel.getByRole('option', { name: 'Repeat visit' }).click();
        await expect(panel.locator('tbody tr').first()).toContainText('Repeat visit');
        const outcomes = await panel.locator('tbody .col-outcome').allTextContents();
        expect(new Set(outcomes)).toEqual(new Set(['Repeat visit']));
    });

    test('an entry opens its view in the Views table', async ({ page }) => {
        await signIn(page, 'tracking-log');
        const first = activePanel(page).locator('tbody tr').first();
        await first.getByRole('button', { name: /^Show view / }).click();
        await expect(sectionTab(page, 'views')).toHaveAttribute('aria-selected', 'true');
        await expect(rows(page)).toHaveCount(1);
        const id = await rows(page).first().getAttribute('data-view-id');
        await expect(activePanel(page).getByRole('searchbox', { name: 'Search views' })).toHaveValue(id);
    });
});

test.describe('choosing, ordering, and sizing columns', () => {
    const shown = (page) => activePanel(page).locator('thead th[data-column]').evaluateAll((cells) => cells.map((th) => th.dataset.column));
    const chooser = (page) => page.getByRole('dialog', { name: 'Columns' });
    const openChooser = async (page) => {
        await activePanel(page).getByRole('button', { name: 'Columns' }).click();
        await expect(chooser(page)).toBeVisible();
    };
    const headerWidth = (page, column) => activePanel(page).locator(`thead th[data-column="${column}"]`)
        .evaluate((th) => Math.round(th.getBoundingClientRect().width));

    test('a wider window shows more of the chosen columns; a narrower one keeps the rest under each row', async ({ page }) => {
        await signIn(page);
        const atDesktop = await shown(page);
        expect(atDesktop.slice(0, 5)).toEqual(['time', 'app', 'page', 'source', 'status']);

        await page.setViewportSize({ width: 1920, height: 900 });
        await expect.poll(() => shown(page)).toEqual(
            ['time', 'app', 'page', 'source', 'status', 'event', 'country', 'device', 'client', 'engagement', 'campaign']);
        // Everything chosen fits, so there is nothing to expand.
        await expect(activePanel(page).locator('.more-toggle')).toHaveCount(0);

        await page.setViewportSize({ width: 1000, height: 900 });
        await expect.poll(() => shown(page)).toEqual(['time', 'app', 'page', 'source']);
        const first = row(page, FIRST);
        await first.getByRole('button', { name: 'Show 7 more fields' }).click();
        const more = activePanel(page).locator('tr.row-more').first();
        await expect(more.locator('dt')).toHaveText(['Status', 'Event', 'Location', 'Device', 'Client', 'Engagement', 'Campaign']);
        await expect(more.locator('dd.col-country')).toContainText('Germany');
        await first.getByRole('button', { name: 'Hide 7 more fields' }).click();
        await expect(activePanel(page).locator('tr.row-more')).toHaveCount(0);
    });

    test('the Columns dialog shows, hides, and reorders columns, and the choice is remembered', async ({ page }) => {
        await signIn(page);
        await openChooser(page);
        await chooser(page).getByRole('checkbox', { name: 'Source' }).uncheck();
        await chooser(page).getByRole('checkbox', { name: 'Language' }).check();
        // Language moves up past Referrer, Site, Title, and Campaign, by keyboard.
        const up = chooser(page).getByRole('button', { name: 'Move Language up' });
        await up.focus();
        for (let i = 0; i < 12; i++) await page.keyboard.press('Enter');
        await expect(up).toBeFocused();
        await chooser(page).getByRole('button', { name: 'Apply' }).click();

        expect((await shown(page)).slice(0, 4)).toEqual(['time', 'app', 'language', 'page']);
        expect(await shown(page)).not.toContain('source');
        await expect(row(page, FIRST).locator('.col-language')).toHaveText('Unknown');

        await page.reload();
        await expect(rows(page).first()).toBeVisible();
        expect((await shown(page)).slice(0, 4)).toEqual(['time', 'app', 'language', 'page']);

        await openChooser(page);
        await chooser(page).getByRole('button', { name: 'Reset to default' }).click();
        await expect(chooser(page).getByRole('checkbox', { name: 'Source' })).toBeChecked();
        await chooser(page).getByRole('button', { name: 'Apply' }).click();
        expect((await shown(page)).slice(0, 4)).toEqual(['time', 'app', 'page', 'source']);
    });

    test('cancelling the dialog changes nothing, and at least one column must stay', async ({ page }) => {
        await signIn(page);
        const before = await shown(page);
        await openChooser(page);
        await chooser(page).getByRole('checkbox', { name: 'Page' }).uncheck();
        await chooser(page).getByRole('button', { name: 'Cancel' }).click();
        expect(await shown(page)).toEqual(before);

        await openChooser(page);
        for (const box of await chooser(page).getByRole('checkbox').all()) await box.uncheck();
        await chooser(page).getByRole('button', { name: 'Apply' }).click();
        await expect(chooser(page).getByRole('alert')).toHaveText('Choose at least one column.');
        await expect(chooser(page)).toBeVisible();
    });

    test('a column the app tab makes pointless steps aside, and comes back', async ({ page }) => {
        await signIn(page);
        expect(await shown(page)).toContain('app');
        await activePanel(page).getByRole('tab', { name: /^blog,/ }).click();
        await expect.poll(() => shown(page)).not.toContain('app');
        await openChooser(page);
        await expect(chooser(page).locator('.column-choice[data-column="app"]')).toContainText('shown under All apps');
    });

    test('a column edge resizes by keyboard and by dragging, and resets on Enter', async ({ page }) => {
        await signIn(page);
        const handle = activePanel(page).getByRole('separator', { name: 'Width of the Source column' });
        const start = await headerWidth(page, 'source');
        await handle.focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => headerWidth(page, 'source')).toBe(start + 16);
        await expect(activePanel(page).getByRole('separator', { name: 'Width of the Source column' })).toBeFocused();
        await page.keyboard.press('Shift+ArrowLeft');
        await expect.poll(() => headerWidth(page, 'source')).toBe(start + 16 - 64);

        const box = await activePanel(page).getByRole('separator', { name: 'Width of the Source column' }).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        await expect.poll(() => headerWidth(page, 'source')).toBe(start + 16 - 64 + 60);

        // Remembered across a reload, then back to its default.
        await page.reload();
        await expect(rows(page).first()).toBeVisible();
        expect(await headerWidth(page, 'source')).toBe(start + 16 - 64 + 60);
        await activePanel(page).getByRole('separator', { name: 'Width of the Source column' }).focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => headerWidth(page, 'source')).toBe(start);
    });

    test('a column made wider pushes the last one under the rows rather than off the screen', async ({ page }) => {
        await signIn(page);
        const before = await shown(page);
        const handle = activePanel(page).getByRole('separator', { name: 'Width of the Time column' });
        await handle.focus();
        for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
        await expect.poll(async () => (await shown(page)).length).toBeLessThan(before.length);
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth);
        expect(overflow).toBe(false);
    });

    test('a chosen column sorts the table when the server can sort by it', async ({ page }) => {
        await signIn(page);
        await openChooser(page);
        await chooser(page).getByRole('checkbox', { name: 'Site' }).check();
        const up = chooser(page).getByRole('button', { name: 'Move Site up' });
        await up.focus();
        for (let i = 0; i < 12; i++) await page.keyboard.press('Enter');
        await chooser(page).getByRole('button', { name: 'Apply' }).click();
        const site = activePanel(page).locator('thead th[data-column="site"]');
        await site.getByRole('button', { name: /Site/ }).click();
        await expect(site).toHaveAttribute('aria-sort', 'descending');
        await expect(site.getByRole('button', { name: /Site/ })).toBeFocused();
    });

    test('the logs choose their columns too, each on its own', async ({ page }) => {
        await signIn(page, 'tracking-log');
        expect(await shown(page)).toEqual(['time', 'app', 'source', 'outcome', 'detail', 'view']);
        await openChooser(page);
        await chooser(page).getByRole('checkbox', { name: 'View' }).uncheck();
        await chooser(page).getByRole('checkbox', { name: 'Requests' }).check();
        await chooser(page).getByRole('button', { name: 'Apply' }).click();
        expect(await shown(page)).toEqual(['time', 'app', 'source', 'outcome', 'detail', 'requests']);

        await sectionTab(page, 'admin-log').click();
        await expect(activePanel(page).locator('tbody tr').first()).toBeVisible();
        expect(await shown(page)).toEqual(['time', 'action', 'app', 'rows', 'fields', 'session', 'ip']);
    });

    test('the selection survives the table refitting', async ({ page }) => {
        await signIn(page);
        await row(page, FIRST).getByRole('checkbox').check();
        await page.setViewportSize({ width: 1000, height: 900 });
        await expect.poll(() => shown(page)).toEqual(['time', 'app', 'page', 'source']);
        await expect(row(page, FIRST).getByRole('checkbox')).toBeChecked();
        await expect(activePanel(page).locator('.batch-count')).toHaveText('1 view selected');
    });
});

test.describe('header and footer', () => {
    test('link to the website, and say which version is running', async ({ page }) => {
        const { version } = require('../../package.json');
        await signIn(page);
        const website = page.getByRole('link', { name: 'Website' }).first();
        await expect(website).toHaveAttribute('href', 'https://viewcounter.harshankur.com');
        await expect(website).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(page.locator('#app-version')).toHaveText(`v${version}`);
        const footer = page.locator('#app-footer');
        await expect(footer).toContainText(`Version ${version}`);
        await expect(footer.getByRole('link', { name: 'Admin guide' })).toHaveAttribute('href', 'https://viewcounter.harshankur.com/#admin');
        await expect(footer.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', 'https://github.com/harshankur/viewcounter');
        await expect(footer.getByRole('link', { name: 'npm package' })).toHaveAttribute('href', 'https://www.npmjs.com/package/@harshankur/viewcounter');
        await expect(footer).toContainText('This product includes GeoLite2 data created by MaxMind');
    });

    test('the footer carries the copyright notice, with its holder linked', async ({ page }) => {
        await signIn(page);
        const footer = page.locator('#app-footer');
        await expect(footer.locator('.footer-copyright')).toHaveText('ViewCounter © 2026 Harsh Ankur');
        await expect(footer.getByRole('link', { name: 'Harsh Ankur' })).toHaveAttribute('href', 'https://harshankur.com');
    });

    test('a failure in the page itself is named as one, not blamed on the server', async ({ page }) => {
        await signIn(page);
        await page.route('**/admin/api/views**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('x');
        await expect(page.getByText('Something went wrong in this page. Reload it and try again.')).toBeVisible();
        // The browser reports the exception with its stack, where a developer looks.
        expect(page.problems.length).toBeGreaterThan(0);
        page.problems.length = 0;
    });
});
