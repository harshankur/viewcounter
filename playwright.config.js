/**
 * Playwright: the admin UI in a real browser (TESTING.md, UI end-to-end tier).
 *
 * Runs against tests/ui/server.js, which serves the real admin router over
 * in-memory data. One worker: tests reset that shared server between them.
 */

const { defineConfig, devices } = require('@playwright/test');

const PORT = 4174;
const IN_CI = Boolean(process.env.CI);

module.exports = defineConfig({
    testDir: 'tests/ui',
    testMatch: '**/*.spec.js',
    fullyParallel: false,
    workers: 1,
    forbidOnly: IN_CI,
    retries: IN_CI ? 1 : 0,
    reporter: IN_CI ? [['list'], ['github']] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        // Fixed so rendered dates and numbers are identical on every machine.
        locale: 'en-US',
        timezoneId: 'UTC',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: `node tests/ui/server.js ${PORT}`,
        url: `http://127.0.0.1:${PORT}/admin/`,
        reuseExistingServer: !IN_CI,
        timeout: 30_000,
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
        { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: '**/layout.spec.js' },
    ],
});
