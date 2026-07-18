const { APP_NAME } = require('./constants');

module.exports = {
    testEnvironment: 'node',
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'index.js',
        'constants.js',
        'config/**/*.js',
        'db/**/*.js',
        'middleware/**/*.js',
        'routes/**/*.js',
        'utils/**/*.js',
        '!**/node_modules/**',
        '!**/scripts/**'
    ],
    testMatch: [
        '**/tests/**/*.test.js'
    ],
    setupFilesAfterEnv: ['<rootDir>/tests/jestSetup.js'],
    verbose: true,
    testTimeout: 10000,
    coverageReporters: ['text', 'lcov', 'clover', 'json-summary'],
    reporters: [
        'default',
        [
            'jest-html-reporter',
            {
                pageTitle: `${APP_NAME} - Test Report`,
                outputPath: 'test-report.html',
                includeFailureMsg: true,
                includeConsoleLog: true,
                sort: 'status'
            }
        ]
    ],
    // TESTING.md §3: the floor must sit above current coverage so a regression
    // breaks the build. A floor beneath actual coverage catches nothing.
    coverageThreshold: {
        global: {
            branches: 75,
            functions: 85,
            lines: 85,
            statements: 85
        }
    }
};
