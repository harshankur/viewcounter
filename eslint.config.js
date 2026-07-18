/**
 * ESLint flat config.
 *
 * The error-handling block is merged from agent-instructions
 * templates/eslint/error-handling.rules.json.template. It makes
 * CODE_STANDARDS.md §3 automatically enforced rather than a review-checklist
 * item: direct console access and string-literal Errors become build failures
 * everywhere except the modules that legitimately own them.
 */

const js = require('@eslint/js');

/** Modules allowed to bypass the error-handling rules, and why. */
const ERROR_HANDLING_EXEMPT = [
    // The one module permitted to construct Errors from the message table.
    'utils/errorUtils.js',
    // The single console sink every other module routes through.
    'utils/logger.js',
    // Standalone tooling outside the service; prints to a human operator.
    'scripts/**',
];

module.exports = [
    js.configs.recommended,

    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                URL: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
            },
        },
        rules: {
            // --- CODE_STANDARDS.md §9: error-handling enforcement -----------
            'no-console': 'error',
            'no-restricted-syntax': [
                'error',
                {
                    selector: "NewExpression[callee.name='Error'][arguments.0.type='Literal'], NewExpression[callee.name='Error'][arguments.0.type='TemplateLiteral']",
                    message: 'Do not instantiate Error with a direct string literal or template literal. Use an ErrorType enum and the ERROR_MESSAGES lookup table in errorUtils instead.',
                },
            ],

            // --- General correctness ---------------------------------------
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'smart'],
            'no-return-await': 'error',
            'no-throw-literal': 'error',
        },
    },

    {
        files: ERROR_HANDLING_EXEMPT,
        rules: {
            'no-console': 'off',
            'no-restricted-syntax': 'off',
        },
    },

    {
        // The E2E runner is a standalone Node script, not a Jest test.
        files: ['tests/e2e/**'],
        languageOptions: {
            globals: { fetch: 'readonly', setTimeout: 'readonly' },
        },
        rules: { 'no-console': 'off' },
    },

    {
        files: ['tests/**'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                jest: 'readonly',
                beforeAll: 'readonly',
                beforeEach: 'readonly',
                afterAll: 'readonly',
                afterEach: 'readonly',
            },
        },
        rules: {
            // Tests legitimately construct throwaway Errors and print detail.
            'no-console': 'off',
            'no-restricted-syntax': 'off',
        },
    },

    {
        ignores: ['node_modules/**', 'coverage/**', 'docs/**', '.ignore/**'],
    },
];
