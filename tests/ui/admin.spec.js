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

    test('an expired session sends the admin back to the login screen', async ({ page, context }) => {
        await signIn(page);
        await context.clearCookies();
        await activePanel(page).getByRole('button', { name: /Page/ }).click();
        await expect(page.getByRole('alert')).toHaveText('Your session has ended. Please sign in again.');
        await expect(page.getByLabel('Password')).toBeFocused();
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
        await signIn(page, 'adminLog');
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

    test('the view log has a receipt for every recorded view, at its own time', async ({ page }) => {
        await signIn(page, 'viewLog');
        await expect(activePanel(page).locator('tbody tr')).toHaveCount(50);
        await expect(activePanel(page).locator('.pager-summary')).toHaveText('Page 1 of 2 · 65 entries');
        await expect(activePanel(page).locator('tbody tr').first()).toContainText('Page view');
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

test.describe('every app together, filters, and insights', () => {
    const appTab = (page, name) => activePanel(page).getByRole('tab', { name: new RegExp(`^${name},`) });
    const tile = (page, label) => activePanel(page).locator('.stat-tile')
        .filter({ has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) })
        .locator('.stat-value');
    const pagerSummary = (page) => activePanel(page).locator('.pager-summary');

    test('the table names each row\'s app', async ({ page }) => {
        await signIn(page);
        await expect(activePanel(page).getByRole('button', { name: /Time/ })).toBeVisible();
        await expect(activePanel(page).locator('th.col-app')).toHaveText('App');
        await expect(row(page, FIRST).locator('.col-app')).toHaveText('blog');
        await activePanel(page).getByRole('searchbox', { name: 'Search views' }).fill('Cart');
        await expect(rows(page).first().locator('.col-app')).toHaveText('shop');
    });

    test('the headline numbers describe exactly the table\'s rows', async ({ page }) => {
        await signIn(page);
        await expect(tile(page, 'Views')).toHaveText('64');
        await expect(tile(page, 'Countries')).toHaveText('6');
        await appTab(page, 'shop').click();
        await expect(tile(page, 'Views')).toHaveText('3');
        await expect(activePanel(page).locator('.insights-caption')).toHaveText('shop, filtered like the table below');
    });

    test('the date range narrows the table and the insights together', async ({ page }) => {
        await signIn(page);
        // The fixture has one view 45 days old and one 200 days old.
        await activePanel(page).getByRole('button', { name: '1 year' }).click();
        await expect(pagerSummary(page)).toHaveText('Page 1 of 2 · 64 entries');
        await activePanel(page).getByRole('button', { name: '90 days' }).click();
        await expect(pagerSummary(page)).toHaveText('Page 1 of 2 · 63 entries');
        await expect(tile(page, 'Views')).toHaveText('63');
        await activePanel(page).getByRole('button', { name: '30 days' }).click();
        await expect(pagerSummary(page)).toHaveText('Page 1 of 2 · 62 entries');
        await expect(activePanel(page).getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('the event-type filter shows where one type of view comes from', async ({ page }) => {
        await signIn(page);
        await expect(tile(page, 'Views')).toHaveText('64');
        await activePanel(page).getByRole('button', { name: 'Event type' }).click();
        await activePanel(page).getByRole('option', { name: 'download' }).click();
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText('/downloads');
        await expect(tile(page, 'Views')).toHaveText('1');
        const countries = activePanel(page).getByRole('list', { name: 'Countries by views' });
        await expect(countries.locator('.country-row')).toHaveCount(1);
        await expect(countries.locator('.country-row').first()).toContainText('Japan');
    });

    test('the map colours countries and lists them in order', async ({ page }) => {
        await signIn(page);
        await expect(activePanel(page).locator('.map-svg path.country').first()).toBeAttached();
        expect(await activePanel(page).locator('.map-svg path.country').count()).toBeGreaterThan(150);
        await expect(activePanel(page).locator('.map-svg path[data-code="DE"]')).toHaveClass(/map-5/);
        await expect(activePanel(page).locator('.map-svg path[data-code="AU"]')).toHaveClass(/map-0/);
        const first = activePanel(page).locator('.country-row').first();
        await expect(first).toContainText('Germany');
        await expect(first).toContainText('15');
    });

    test('a country in the list shows its tooltip on keyboard focus', async ({ page }) => {
        await signIn(page);
        await activePanel(page).locator('.country-row').first().focus();
        const tooltip = activePanel(page).locator('.chart-map .chart-tooltip');
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText('Germany');
        await expect(tooltip).toContainText('15');
        await expect(activePanel(page).locator('.map-svg path[data-code="DE"]')).toHaveClass(/active/);
    });

    test('the trend reads out by keyboard and has a table view', async ({ page }) => {
        await signIn(page);
        const chart = activePanel(page).locator('.trend-svg');
        await chart.focus();
        await page.keyboard.press('End');
        const tooltip = activePanel(page).locator('.chart-trend .chart-tooltip');
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText('Views');

        await activePanel(page).getByRole('button', { name: 'Show as table' }).click();
        const table = activePanel(page).locator('.chart-trend table');
        await expect(table.locator('tbody tr').first()).toBeVisible();
        await expect(activePanel(page).getByRole('button', { name: 'Show as chart' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('breakdowns include apps only when every app is shown', async ({ page }) => {
        await signIn(page);
        const apps = activePanel(page).locator('.chart-card').filter({ has: page.getByRole('heading', { name: 'Apps', exact: true }) });
        await expect(apps).toContainText('blog');
        await expect(apps).toContainText('61');
        await appTab(page, 'blog').click();
        await expect(activePanel(page).locator('.insights-caption')).toHaveText('blog, filtered like the table below');
        await expect(apps).toHaveCount(0);
    });

    test('the insights can be collapsed, and stay collapsed', async ({ page }) => {
        await signIn(page);
        const toggle = activePanel(page).getByRole('button', { name: 'insights' });
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(activePanel(page).locator('.insights-body')).toBeHidden();
        await page.reload();
        await expect(activePanel(page).getByRole('button', { name: 'insights' })).toHaveAttribute('aria-expanded', 'false');
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
});
