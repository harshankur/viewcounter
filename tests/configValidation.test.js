const fs = require('fs');

const { Config } = require('../config');
const { INSECURE_DEFAULTS, NODE_ENV, PRIVACY, SCOPE_ALL, SERVER } = require('../constants');

/**
 * Config precedence and fail-fast validation.
 *
 * TESTING.md §1 requires every configuration-precedence rule to be tested with
 * at least three assertions: which source wins when several are set, the
 * behaviour when only one is set, and the default when none are.
 */

const VALID_SECRET = 'a'.repeat(PRIVACY.SECRET_BYTES * 2);
const VALID_KEY = 'k'.repeat(PRIVACY.MIN_API_KEY_LENGTH);

/** Build a Config against a synthetic environment, with no files on disk. */
const buildConfig = (env = {}) => {
    const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
        return new Config({ VISITOR_SECRET: VALID_SECRET, ...env });
    } finally {
        spy.mockRestore();
    }
};

/** A production environment that should pass validation. */
const productionEnv = (overrides = {}) => ({
    NODE_ENV: NODE_ENV.PRODUCTION,
    DB_USER: 'analytics',
    DB_PASSWORD: 'a-real-password',
    DB_NAME: 'viewcounterdb',
    ALLOWED_APP_IDS: 'blog,portfolio',
    CORS_ORIGINS: 'https://site.example',
    READ_API_KEYS: VALID_KEY,
    VISITOR_SECRET: VALID_SECRET,
    ...overrides,
});

describe('Config precedence', () => {
    test('environment variable wins over the code default', () => {
        expect(buildConfig({ DB_HOST: 'env-host' }).dbInfo.host).toBe('env-host');
    });

    test('the code default applies when nothing is set', () => {
        expect(buildConfig().dbInfo.host).toBe('127.0.0.1');
        expect(buildConfig().dbInfo.port).toBe(3306);
    });

    test('an unparseable numeric env falls back rather than yielding NaN', () => {
        expect(buildConfig({ DB_PORT: 'not-a-number' }).dbInfo.port).toBe(3306);
        expect(buildConfig({ PORT: '' }).server.port).toBe(SERVER.DEFAULT_PORT);
    });

    test('an empty env value does not shadow the default', () => {
        expect(buildConfig({ DB_HOST: '' }).dbInfo.host).toBe('127.0.0.1');
    });

    test('a config file field wins over both env and default', () => {
        const existsSpy = jest.spyOn(fs, 'existsSync')
            .mockImplementation((p) => String(p).endsWith('dbInfo.json'));
        const readSpy = jest.spyOn(fs, 'readFileSync')
            .mockReturnValue(JSON.stringify({ host: 'file-host' }));

        try {
            const config = new Config({ DB_HOST: 'env-host', VISITOR_SECRET: VALID_SECRET });
            expect(config.dbInfo.host).toBe('file-host');
        } finally {
            existsSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    test('a partial config file falls back field by field, not to undefined', () => {
        // Regression: the loader used to return the parsed file verbatim, so a
        // file missing `host` produced `host: undefined` with no fallback.
        const existsSpy = jest.spyOn(fs, 'existsSync')
            .mockImplementation((p) => String(p).endsWith('dbInfo.json'));
        const readSpy = jest.spyOn(fs, 'readFileSync')
            .mockReturnValue(JSON.stringify({ user: 'only-user' }));

        try {
            const config = new Config({ DB_HOST: 'env-host', VISITOR_SECRET: VALID_SECRET });

            expect(config.dbInfo.user).toBe('only-user');
            expect(config.dbInfo.host).toBe('env-host');
            expect(config.dbInfo.database).toBe('viewcounterdb');
            expect(config.dbInfo.port).toBe(3306);
        } finally {
            existsSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    test('an allowed.json missing appId falls back instead of yielding undefined', () => {
        const existsSpy = jest.spyOn(fs, 'existsSync')
            .mockImplementation((p) => String(p).endsWith('allowed.json'));
        const readSpy = jest.spyOn(fs, 'readFileSync')
            .mockReturnValue(JSON.stringify({ deviceSize: ['small'] }));

        try {
            const config = new Config({ VISITOR_SECRET: VALID_SECRET });

            // Previously this was undefined and threw on .join() at startup.
            expect(Array.isArray(config.allowed.appId)).toBe(true);
            expect(config.allowed.deviceSize).toEqual(['small']);
        } finally {
            existsSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    test('an unparseable config file degrades to env and defaults', () => {
        const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('{ not valid json');

        try {
            const config = new Config({ DB_HOST: 'env-host', VISITOR_SECRET: VALID_SECRET });
            expect(config.dbInfo.host).toBe('env-host');
        } finally {
            existsSpy.mockRestore();
            readSpy.mockRestore();
        }
    });
});

describe('nodeEnv default', () => {
    test('defaults to production, not development', () => {
        // The old default was development, which is exactly the mode that
        // echoes raw database errors to anonymous callers.
        const config = buildConfig();
        expect(config.server.nodeEnv).toBe(NODE_ENV.PRODUCTION);
        expect(config.server.isProduction).toBe(true);
    });

    test('honours an explicit NODE_ENV', () => {
        expect(buildConfig({ NODE_ENV: NODE_ENV.TEST }).server.isTest).toBe(true);
    });
});

describe('resolveTrustProxy()', () => {
    test('defaults to no trust at all', () => {
        expect(buildConfig().server.trustProxy).toBe(false);
    });

    test('accepts a hop count', () => {
        expect(buildConfig({ TRUST_PROXY: '1' }).server.trustProxy).toBe(1);
        expect(buildConfig({ TRUST_PROXY: '2' }).server.trustProxy).toBe(2);
    });

    test('accepts an explicit CIDR list', () => {
        expect(buildConfig({ TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).server.trustProxy)
            .toEqual(['10.0.0.0/8', '172.16.0.0/12']);
    });

    test.each(['true', '*'])('downgrades the permissive value %s to a single hop', (value) => {
        // Bare `true` trusts every hop, which lets any caller forge their IP.
        expect(buildConfig({ TRUST_PROXY: value }).server.trustProxy).toBe(1);
    });
});

describe('loadAuthConfig()', () => {
    test('an env key is unscoped, reading every app', () => {
        expect(buildConfig({ READ_API_KEYS: VALID_KEY }).auth.readKeyScopes)
            .toEqual({ [VALID_KEY]: SCOPE_ALL });
    });

    test('accepts several keys so one can be revoked independently', () => {
        const other = 'z'.repeat(PRIVACY.MIN_API_KEY_LENGTH);
        expect(Object.keys(buildConfig({ READ_API_KEYS: `${VALID_KEY},${other}` }).auth.readKeyScopes))
            .toHaveLength(2);
    });

    test('discards a key short enough to be guessable', () => {
        expect(buildConfig({ READ_API_KEYS: 'short' }).auth.readKeyScopes).toEqual({});
    });

    test('is empty when unset', () => {
        expect(buildConfig().auth.readKeyScopes).toEqual({});
    });

    test('admin keys are a separate tier, never implied by a read key', () => {
        const config = buildConfig({ READ_API_KEYS: VALID_KEY });

        expect(config.auth.adminApiKeys).toEqual([]);
        expect(config.auth.readKeyScopes[VALID_KEY]).toBe(SCOPE_ALL);
    });

    test('admin keys load from their own variable', () => {
        const adminKey = 'A'.repeat(PRIVACY.MIN_ADMIN_KEY_LENGTH);
        const config = buildConfig({ ADMIN_API_KEYS: adminKey });

        expect(config.auth.adminApiKeys).toEqual([adminKey]);
        // and grant no read access on their own
        expect(config.auth.readKeyScopes).toEqual({});
    });

    describe('scoped keys from allowed.json', () => {
        const withAllowedFile = (contents, env = {}) => {
            const existsSpy = jest.spyOn(fs, 'existsSync')
                .mockImplementation((p) => String(p).endsWith('allowed.json'));
            const readSpy = jest.spyOn(fs, 'readFileSync')
                .mockReturnValue(JSON.stringify(contents));
            try {
                return new Config({ VISITOR_SECRET: VALID_SECRET, ...env });
            } finally {
                existsSpy.mockRestore();
                readSpy.mockRestore();
            }
        };

        test('a key scoped to named apps records exactly those apps', () => {
            const config = withAllowedFile({
                appId: ['blog', 'shop'],
                apiKeys: { [VALID_KEY]: ['blog'] },
            });

            expect(config.auth.readKeyScopes[VALID_KEY]).toEqual(['blog']);
        });

        test('a key scoped to "*" is unscoped', () => {
            const config = withAllowedFile({ apiKeys: { [VALID_KEY]: '*' } });
            expect(config.auth.readKeyScopes[VALID_KEY]).toBe(SCOPE_ALL);
        });

        test('an unsafe appId in a scope is filtered out', () => {
            const config = withAllowedFile({
                apiKeys: { [VALID_KEY]: ['blog', '_apps', 'bad id', 'x`drop'] },
            });

            expect(config.auth.readKeyScopes[VALID_KEY]).toEqual(['blog']);
        });

        test('a short key is ignored rather than silently trusted', () => {
            const config = withAllowedFile({ apiKeys: { short: ['blog'] } });
            expect(config.auth.readKeyScopes).toEqual({});
        });

        test('an empty scope is ignored', () => {
            const config = withAllowedFile({ apiKeys: { [VALID_KEY]: [] } });
            expect(config.auth.readKeyScopes[VALID_KEY]).toBeUndefined();
        });

        test('env keys and file keys coexist', () => {
            const other = 'z'.repeat(PRIVACY.MIN_API_KEY_LENGTH);
            const config = withAllowedFile(
                { appId: ['blog'], apiKeys: { [other]: ['blog'] } },
                { READ_API_KEYS: VALID_KEY },
            );

            expect(config.auth.readKeyScopes[VALID_KEY]).toBe(SCOPE_ALL);
            expect(config.auth.readKeyScopes[other]).toEqual(['blog']);
        });
    });
});

describe('Fail-fast validation', () => {
    test('a fully configured production deployment validates', () => {
        expect(() => buildConfig(productionEnv()).validate()).not.toThrow();
    });

    test('refuses to start on the default root/empty-password credentials', () => {
        // Previously an unconfigured deploy started silently as root with an
        // empty password and looked healthy doing it.
        expect(() => buildConfig(productionEnv({
            DB_USER: INSECURE_DEFAULTS.DB_USER,
            DB_PASSWORD: INSECURE_DEFAULTS.DB_PASSWORD,
        })).validate()).toThrow(/insecure default/i);
    });

    test('refuses to start on the placeholder appId', () => {
        expect(() => buildConfig(productionEnv({ ALLOWED_APP_IDS: '' })).validate())
            .toThrow(/insecure default/i);
    });

    test('accepts app IDs supplied via the environment', () => {
        expect(buildConfig({ ALLOWED_APP_IDS: 'blog, portfolio' }).allowed.appId)
            .toEqual(['blog', 'portfolio']);
    });

    test('a config file list still wins over the environment', () => {
        const existsSpy = jest.spyOn(fs, 'existsSync')
            .mockImplementation((p) => String(p).endsWith('allowed.json'));
        const readSpy = jest.spyOn(fs, 'readFileSync')
            .mockReturnValue(JSON.stringify({ appId: ['from_file'] }));

        try {
            const config = new Config({ ALLOWED_APP_IDS: 'from_env', VISITOR_SECRET: VALID_SECRET });
            expect(config.allowed.appId).toEqual(['from_file']);
        } finally {
            existsSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    test('refuses to start with no CORS allowlist', () => {
        expect(() => buildConfig(productionEnv({ CORS_ORIGINS: '' })).validate())
            .toThrow(/CORS_ORIGINS/);
    });

    test('refuses to start with no database name', () => {
        const config = buildConfig(productionEnv());
        config.dbInfo.database = '';

        expect(() => config.validate()).toThrow(/database/i);
    });

    test('missing read keys is a warning, not a failure', () => {
        expect(() => buildConfig(productionEnv({ READ_API_KEYS: '' })).validate()).not.toThrow();
    });

    test('outside production the same defaults only warn', () => {
        expect(() => buildConfig({
            NODE_ENV: NODE_ENV.DEVELOPMENT,
            VISITOR_SECRET: VALID_SECRET,
        }).validate()).not.toThrow();
    });

    test('validate() returns the config for chaining', () => {
        const config = buildConfig(productionEnv());
        expect(config.validate()).toBe(config);
    });
});

describe('loadPrivacyConfig()', () => {
    test('an injected secret wins over disk', () => {
        expect(buildConfig({ VISITOR_SECRET: VALID_SECRET }).privacy.visitorSecret).toBe(VALID_SECRET);
    });

    test('test environments get an ephemeral secret without touching disk', () => {
        const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        try {
            const config = new Config({ NODE_ENV: NODE_ENV.TEST });

            expect(config.privacy.visitorSecret).toHaveLength(PRIVACY.SECRET_BYTES * 2);
        } finally {
            spy.mockRestore();
        }
    });

    test('the secret path is configurable', () => {
        expect(buildConfig({ VISITOR_SECRET_PATH: '/custom/path' }).privacy.secretPath)
            .toBe('/custom/path');
    });
});

describe('hasConfigFiles()', () => {
    test('reports which config files are present', () => {
        const spy = jest.spyOn(fs, 'existsSync')
            .mockImplementation((p) => String(p).endsWith('dbInfo.json'));
        try {
            const status = Config.hasConfigFiles();
            expect(status.hasDbInfo).toBe(true);
            expect(status.hasAllowed).toBe(false);
            expect(status.hasEither).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});
