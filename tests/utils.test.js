const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../utils/logger');
const { truncate, jsonByteLength } = require('../utils/stringUtils');
const { isValidIP, getClientIp, normalizeIp } = require('../utils/ipUtils');
const PrivacyUtils = require('../utils/privacyUtils');
const ReferrerParser = require('../utils/referrerParser');
const UserAgentParser = require('../utils/userAgentParser');
const secretStore = require('../utils/secretStore');
const {
    getError,
    logWarning,
    ErrorType,
    WarningType,
    ERROR_MESSAGES,
    WARNING_MESSAGES,
} = require('../utils/errorUtils');
const { buildCorsOptions, requestOrigin, noStore } = require('../middleware/security');
const { PRIVACY, SOURCE_TYPE, DEVICE_TYPE } = require('../constants');

describe('stringUtils', () => {
    describe('truncate()', () => {
        test('returns null for absent values', () => {
            expect(truncate(undefined, 10)).toBeNull();
            expect(truncate(null, 10)).toBeNull();
            expect(truncate('', 10)).toBeNull();
        });

        test('leaves a short value untouched', () => {
            expect(truncate('abc', 10)).toBe('abc');
        });

        test('cuts a long value to exactly the maximum', () => {
            expect(truncate('abcdefghij', 4)).toBe('abcd');
        });

        test('coerces non-strings before measuring', () => {
            expect(truncate(1234567, 3)).toBe('123');
        });

        test('handles a value exactly at the limit', () => {
            expect(truncate('abcd', 4)).toBe('abcd');
        });
    });

    describe('jsonByteLength()', () => {
        test('is zero for absent values', () => {
            expect(jsonByteLength(undefined)).toBe(0);
            expect(jsonByteLength(null)).toBe(0);
        });

        test('measures serialized bytes, not character count', () => {
            // A 4-byte emoji is one JS "character" pair but four UTF-8 bytes.
            expect(jsonByteLength('😀')).toBeGreaterThan(4);
        });

        test('measures nested objects', () => {
            expect(jsonByteLength({ a: 'bb' })).toBe(JSON.stringify({ a: 'bb' }).length);
        });
    });
});

describe('ipUtils', () => {
    describe('isValidIP()', () => {
        test.each(['1.2.3.4', '255.255.255.255', '0.0.0.0'])('accepts IPv4 %s', (ip) => {
            expect(isValidIP(ip)).toBe(true);
        });

        test.each(['::1', '2001:db8::1', '::ffff:127.0.0.1'])('accepts IPv6 %s', (ip) => {
            expect(isValidIP(ip)).toBe(true);
        });

        test.each([
            '999.999.999.999',  // regression: the old regex had no range check
            '256.1.1.1',
            '1.2.3',
            '1.2.3.4.5',
            'not-an-ip',
            '',
        ])('rejects %s', (ip) => {
            expect(isValidIP(ip)).toBe(false);
        });

        test('rejects non-string input', () => {
            expect(isValidIP(null)).toBe(false);
            expect(isValidIP(undefined)).toBe(false);
            expect(isValidIP(12345)).toBe(false);
        });
    });

    describe('normalizeIp()', () => {
        test('unwraps an IPv4-mapped IPv6 address', () => {
            expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
        });

        test('leaves a plain IPv4 address alone', () => {
            expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
        });

        test('leaves a real IPv6 address alone', () => {
            expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
        });

        test('passes non-strings through unchanged', () => {
            expect(normalizeIp(undefined)).toBeUndefined();
        });
    });

    describe('getClientIp()', () => {
        test('reads req.ip and nothing else', () => {
            const req = {
                ip: '10.0.0.1',
                headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' },
            };
            expect(getClientIp(req)).toBe('10.0.0.1');
        });
    });
});

describe('privacyUtils.maskIP()', () => {
    test('zeroes the final IPv4 octet', () => {
        expect(PrivacyUtils.maskIP('192.168.1.55')).toBe('192.168.1.0');
    });

    test('zeroes the IPv6 interface identifier', () => {
        expect(PrivacyUtils.maskIP('2001:db8:85a3:1:2:3:4:5')).toBe('2001:db8:85a3:1:0:0:0:0');
    });

    test('handles IPv4-mapped IPv6', () => {
        expect(PrivacyUtils.maskIP('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.0');
    });

    test('returns a placeholder for an absent address', () => {
        expect(PrivacyUtils.maskIP('')).toBe('0.0.0.0');
        expect(PrivacyUtils.maskIP(null)).toBe('0.0.0.0');
    });

    test('passes through a malformed IPv4 unchanged', () => {
        expect(PrivacyUtils.maskIP('1.2.3')).toBe('1.2.3');
    });

    test('passes through a short IPv6 unchanged', () => {
        expect(PrivacyUtils.maskIP('a:b')).toBe('a:b');
    });
});

describe('privacyUtils.currentWindowId()', () => {
    test('is stable inside a window and advances between windows', () => {
        const base = Date.UTC(2026, 0, 1);
        expect(PrivacyUtils.currentWindowId(24, base)).toBe(PrivacyUtils.currentWindowId(24, base + 1000));
        expect(PrivacyUtils.currentWindowId(24, base + 25 * 3600e3))
            .toBeGreaterThan(PrivacyUtils.currentWindowId(24, base));
    });

    test('never rotates slower than the one-hour floor, even at zero', () => {
        const base = Date.UTC(2026, 0, 1);
        // uniqueWindowHours is 0 for custom events; the hash must still rotate.
        expect(PrivacyUtils.currentWindowId(0, base + 2 * 3600e3))
            .toBeGreaterThan(PrivacyUtils.currentWindowId(0, base));
    });
});

describe('errorUtils', () => {
    test('every ErrorType has a message entry', () => {
        for (const type of Object.values(ErrorType)) {
            expect(ERROR_MESSAGES[type]).toBeDefined();
        }
    });

    test('every WarningType has a message entry', () => {
        for (const type of Object.values(WarningType)) {
            expect(WARNING_MESSAGES[type]).toBeDefined();
        }
    });

    test('every error message resolves to a non-empty string', () => {
        for (const type of Object.values(ErrorType)) {
            const err = getError(type, { field: 'f', path: '/p', host: 'h', port: 1, database: 'd', operation: 'o', reason: 'r' });
            expect(typeof err.message).toBe('string');
            expect(err.message.length).toBeGreaterThan(0);
        }
    });

    test('every warning message resolves without throwing', () => {
        for (const type of Object.values(WarningType)) {
            expect(() => logWarning(type, { file: 'f', field: 'x', source: 's', value: 'v', path: '/p', max: 1 }))
                .not.toThrow();
        }
    });

    test('getError returns rather than throws, and tags the code', () => {
        const err = getError(ErrorType.DATABASE_NOT_INITIALIZED);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe(ErrorType.DATABASE_NOT_INITIALIZED);
    });

    test('getError attaches details for the caller', () => {
        const err = getError(ErrorType.CONFIG_MISSING_REQUIRED, { field: 'DB_HOST' });
        expect(err.details).toEqual({ field: 'DB_HOST' });
        expect(err.message).toContain('DB_HOST');
    });

    test('an unknown type still produces a usable error', () => {
        const err = getError('NOT_A_REAL_TYPE');
        expect(err.message).toContain('NOT_A_REAL_TYPE');
    });

    test('an AbortError is passed through with its identity intact', () => {
        const abort = new Error('cancelled');
        abort.name = 'AbortError';

        const result = getError(ErrorType.DATABASE_QUERY_FAILED, abort);

        expect(result).toBe(abort);
        expect(result.name).toBe('AbortError');
    });
});

describe('logger', () => {
    let lines;

    beforeEach(() => {
        lines = [];
        logger.configure({ level: logger.LogLevel.DEBUG, writer: (l) => lines.push(l) });
    });

    afterEach(() => {
        logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} });
    });

    test('emits at or above the threshold', () => {
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        expect(lines).toHaveLength(4);
    });

    test('suppresses below the threshold', () => {
        logger.configure({ level: logger.LogLevel.WARN });
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('[WARN]');
    });

    test('isEnabled reflects the threshold', () => {
        logger.configure({ level: logger.LogLevel.ERROR });
        expect(logger.isEnabled(logger.LogLevel.DEBUG)).toBe(false);
        expect(logger.isEnabled(logger.LogLevel.ERROR)).toBe(true);
    });

    test('renders context in fixed positions, with placeholders when absent', () => {
        logger.info('hello', { ip: '1.2.3.0', requestId: 'req-1' });
        expect(lines[0]).toContain('[1.2.3.0] [req-1] hello');

        logger.info('bare');
        expect(lines[1]).toContain('[-] [-] bare');
    });

    test('audit bypasses the level threshold entirely', () => {
        logger.configure({ level: logger.LogLevel.SILENT });
        logger.audit('registerView', { appId: 'blog' });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('action=registerView');
        expect(lines[0]).toContain('actor=blog');
    });

    test('an unknown level is ignored rather than accepted', () => {
        logger.configure({ level: 'not-a-level' });
        logger.debug('still debug threshold');
        expect(lines).toHaveLength(1);
    });

    test('a failing sink degrades logging instead of throwing', () => {
        logger.configure({
            level: logger.LogLevel.INFO,
            writer: () => { throw new Error('disk full'); },
        });
        expect(() => logger.info('anything')).not.toThrow();
    });

    describe('redact()', () => {
        test('replaces sensitive values with a presence marker', () => {
            const safe = logger.redact({ password: 'hunter2', token: '', host: 'db.internal' });

            expect(safe.password).toBe('[SET]');
            expect(safe.token).toBe('[NOT SET]');
            expect(safe.host).toBe('db.internal');
        });

        test('matches sensitive keys case-insensitively', () => {
            expect(logger.redact({ Password: 'x' }).Password).toBe('[SET]');
            expect(logger.redact({ APIKEY: 'x' }).APIKEY).toBe('[SET]');
        });

        test('handles an empty record', () => {
            expect(logger.redact()).toEqual({});
        });
    });
});

describe('secretStore', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-secret-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('generates a secret of the expected entropy on first run', () => {
        const secret = secretStore.loadOrCreate(path.join(dir, '.visitor-secret'));

        expect(secret).toMatch(secretStore.SECRET_PATTERN);
        expect(secret).toHaveLength(PRIVACY.SECRET_BYTES * 2);
    });

    test('persists the secret with owner-only permissions', () => {
        const file = path.join(dir, '.visitor-secret');
        secretStore.loadOrCreate(file);

        // World-readable would make the secret as exposed as the hashes it
        // protects.
        expect(fs.statSync(file).mode & 0o777).toBe(PRIVACY.SECRET_FILE_MODE);
    });

    test('returns the same secret on subsequent runs', () => {
        const file = path.join(dir, '.visitor-secret');
        expect(secretStore.loadOrCreate(file)).toBe(secretStore.loadOrCreate(file));
    });

    test('replaces a malformed secret rather than using it', () => {
        const file = path.join(dir, '.visitor-secret');
        fs.writeFileSync(file, 'too-short');

        const secret = secretStore.loadOrCreate(file);
        expect(secret).toMatch(secretStore.SECRET_PATTERN);
    });

    test('creates missing parent directories', () => {
        const file = path.join(dir, 'nested', 'deeper', '.visitor-secret');
        expect(secretStore.loadOrCreate(file)).toMatch(secretStore.SECRET_PATTERN);
    });

    test('reports a typed error when the path is unwritable', () => {
        // A path whose parent is a file, not a directory.
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'x');

        expect(() => secretStore.loadOrCreate(path.join(blocker, 'secret')))
            .toThrow(/visitor-hash secret/i);
    });
});

describe('security middleware', () => {
    describe('buildCorsOptions()', () => {
        const invoke = (allowlist, origin) => new Promise((resolve) => {
            buildCorsOptions(allowlist).origin(origin, (_err, allowed) => resolve(allowed));
        });

        test('allows a listed origin', async () => {
            await expect(invoke(['https://a.example'], 'https://a.example')).resolves.toBe(true);
        });

        test('denies an unlisted origin', async () => {
            await expect(invoke(['https://a.example'], 'https://evil.example')).resolves.toBe(false);
        });

        test('allows a request with no Origin header (curl, server-side)', async () => {
            await expect(invoke(['https://a.example'], undefined)).resolves.toBe(true);
        });

        test('denies everything when the allowlist is empty', async () => {
            await expect(invoke([], 'https://a.example')).resolves.toBe(false);
        });

        test('does not permit credentials', () => {
            expect(buildCorsOptions([]).credentials).toBe(false);
        });
    });

    describe('requestOrigin()', () => {
        const req = (headers) => ({ get: (h) => headers[h.toLowerCase()] });

        test('prefers the Origin header', () => {
            expect(requestOrigin(req({ origin: 'https://a.example' }))).toBe('https://a.example');
        });

        test('falls back to the referrer origin', () => {
            expect(requestOrigin(req({ referer: 'https://b.example/page?x=1' }))).toBe('https://b.example');
        });

        test('returns null with neither header', () => {
            expect(requestOrigin(req({}))).toBeNull();
        });

        test('returns null for an unparseable referrer', () => {
            expect(requestOrigin(req({ referer: 'not a url' }))).toBeNull();
        });
    });

    describe('noStore()', () => {
        test('sets an uncacheable directive and continues', () => {
            const res = { set: jest.fn() };
            const next = jest.fn();

            noStore({}, res, next);

            expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
            expect(next).toHaveBeenCalled();
        });
    });
});

describe('referrerParser.summarizeReferrers()', () => {
    test('groups by source and domain, sorted by count', () => {
        const summary = ReferrerParser.summarizeReferrers([
            { sourceType: 'search', referrerDomain: 'google.com' },
            { sourceType: 'search', referrerDomain: 'google.com' },
            { sourceType: 'social', referrerDomain: 'x.com' },
        ]);

        expect(summary.bySource[0]).toEqual({ source: 'search', count: 2 });
        expect(summary.byDomain[0]).toEqual({ domain: 'google.com', count: 2 });
    });

    test('labels an absent source type as unknown', () => {
        const summary = ReferrerParser.summarizeReferrers([{ referrerDomain: 'a.com' }]);
        expect(summary.bySource[0].source).toBe(SOURCE_TYPE.UNKNOWN);
    });

    test('handles an empty list', () => {
        expect(ReferrerParser.summarizeReferrers([])).toEqual({ bySource: [], byDomain: [] });
    });
});

describe('referrerParser.isEmail()', () => {
    test.each(['mail.google.com', 'outlook.com', 'protonmail.com'])('detects %s', (domain) => {
        expect(ReferrerParser.isEmail(domain)).toBe(true);
    });

    test('does not flag an unrelated domain', () => {
        expect(ReferrerParser.isEmail('example.com')).toBe(false);
    });
});

describe('userAgentParser.getDeviceType()', () => {
    test.each([
        ['mobile', DEVICE_TYPE.MOBILE],
        ['tablet', DEVICE_TYPE.TABLET],
        ['wearable', DEVICE_TYPE.WEARABLE],
        ['smarttv', DEVICE_TYPE.TV],
        ['console', DEVICE_TYPE.CONSOLE],
    ])('maps %s to %s', (input, expected) => {
        expect(UserAgentParser.getDeviceType(input)).toBe(expected);
    });

    test('defaults to desktop for an absent or unknown type', () => {
        expect(UserAgentParser.getDeviceType(undefined)).toBe(DEVICE_TYPE.DESKTOP);
        expect(UserAgentParser.getDeviceType('embedded')).toBe(DEVICE_TYPE.DESKTOP);
    });

    test('is case-insensitive', () => {
        expect(UserAgentParser.getDeviceType('MOBILE')).toBe(DEVICE_TYPE.MOBILE);
    });
});

describe('userAgentParser.getDeviceSize()', () => {
    test('maps device types to size buckets', () => {
        const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
        const desktopUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

        expect(UserAgentParser.getDeviceSize(mobileUA)).toBe('small');
        expect(UserAgentParser.getDeviceSize(desktopUA)).toBe('large');
    });
});

describe('userAgentParser.parse()', () => {
    test('returns all-null for an absent user agent', () => {
        expect(UserAgentParser.parse('')).toEqual({
            browser: null,
            browserVersion: null,
            os: null,
            osVersion: null,
            deviceType: null,
        });
    });
});
