const crypto = require('crypto');

const DatabaseManager = require('../db/DatabaseManager');
const PrivacyUtils = require('../utils/privacyUtils');
const { pageQuery } = require('../utils/visitorContext');
const { TEST_VISITOR_SECRET } = require('./jestSetup');
const { TEST_VISITOR_SALT } = require('./support/scriptedPool');

// Matches full IPv4 (x.x.x.x) that has NOT been masked to a .0 final octet
const RAW_IPV4_PATTERN = /^(?!.*\.\d{1,3}\.0$)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Matches full IPv6 that has NOT had its interface identifier zeroed
const RAW_IPV6_PATTERN = /^(?!.*:0:0:0:0$)([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}$/;

describe('Privacy Fail-Safe Verification', () => {
    let dbManager;
    let interceptedParams = [];
    let interceptedSql = [];

    const mockPool = {
        query: jest.fn(async (sql, params = []) => {
            interceptedSql.push(sql);
            interceptedParams.push(...params);
            if (/^\s*SELECT salt FROM `_visitor_salts`/.test(sql)) return [[{ salt: TEST_VISITOR_SALT }]];
            return [{ insertId: 1 }];
        }),
        execute: jest.fn(async (sql, params = []) => {
            interceptedSql.push(sql);
            interceptedParams.push(...params);
            return [{ insertId: 1 }];
        }),
        end: jest.fn()
    };

    beforeEach(() => {
        interceptedParams = [];
        interceptedSql = [];
        dbManager = new DatabaseManager({ mode: 'connect' });
        dbManager.pool = mockPool;
    });

    /**
     * Assert a value appears in NEITHER the bound parameters NOR the SQL text.
     *
     * Checking parameters alone is not enough: `appId` is interpolated straight
     * into the statement, so a regression that interpolated any other value
     * would leave the params array clean while still writing the raw value into
     * the query.
     */
    const expectAbsentEverywhere = (needle, label) => {
        const inParams = interceptedParams.some(p => typeof p === 'string' && p.includes(needle));
        const inSql = interceptedSql.some(sql => sql.includes(needle));

        if (inParams) throw new Error(`PRIVACY BREACH: ${label} "${needle}" found in bound parameters`);
        if (inSql) throw new Error(`PRIVACY BREACH: ${label} "${needle}" found in SQL text`);
    };

    test('Fail-Safe: registerEvent should NEVER include a raw IPv4 in SQL parameters', async () => {
        const rawIP = '123.123.123.123';

        await dbManager.registerEvent('test_app', {
            ip: rawIP,
            deviceSize: 'medium',
            userAgent: 'Mozilla/5.0',
            visitorSecret: TEST_VISITOR_SECRET
        });

        interceptedParams.forEach(param => {
            if (typeof param === 'string' && RAW_IPV4_PATTERN.test(param)) {
                throw new Error(`PRIVACY BREACH DETECTED: Raw IP address "${param}" was found in a database query!`);
            }
        });

        expectAbsentEverywhere(rawIP, 'raw IPv4');
        expect(interceptedParams).toContain('123.123.123.0');
    });

    test('Fail-Safe: registerEvent should NEVER include a raw IPv6 in SQL parameters', async () => {
        const rawIP = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';

        await dbManager.registerEvent('test_app', {
            ip: rawIP,
            deviceSize: 'medium',
            userAgent: 'Mozilla/5.0',
            visitorSecret: TEST_VISITOR_SECRET
        });

        interceptedParams.forEach(param => {
            if (typeof param === 'string' && param.includes(':') && RAW_IPV6_PATTERN.test(param)) {
                throw new Error(`PRIVACY BREACH DETECTED: Raw IPv6 address "${param}" was found in a database query!`);
            }
        });

        expectAbsentEverywhere(rawIP, 'raw IPv6');
        expect(interceptedParams).toContain('2001:db8:85a3:0:0:0:0:0');
    });

    test.each([['2606:4700::6810:84e5', '2606:4700:0:0:0:0:0:0'], ['::1', '0:0:0:0:0:0:0:0'], ['2001:db8::abcd:ef01', '2001:db8:0:0:0:0:0:0']])(
        'Fail-Safe: a compressed IPv6 address (%s) keeps nothing of its interface identifier', async (rawIP, masked) => {
            await dbManager.registerEvent('test_app', {
                ip: rawIP,
                deviceSize: 'medium',
                userAgent: 'Mozilla/5.0',
                visitorSecret: TEST_VISITOR_SECRET,
            });
            expectAbsentEverywhere(rawIP, 'raw IPv6');
            // Stored as its /64 alone: the old split at colons stored '2606:4700::6810:0:0:0:0', and '::1' whole.
            expect(interceptedParams).toContain(masked);
            expect(interceptedParams.filter((param) => typeof param === 'string' && /::/.test(param))).toEqual([]);
        });

    test('Fail-Safe: registerView wrapper should also protect raw IPs', async () => {
        const rawIP = '45.45.45.45';

        await dbManager.registerView('test_app', rawIP, 'US', 'small', 24, TEST_VISITOR_SECRET);

        interceptedParams.forEach(param => {
            if (typeof param === 'string' && RAW_IPV4_PATTERN.test(param)) {
                throw new Error(`PRIVACY BREACH DETECTED in registerView: "${param}" leaked!`);
            }
        });

        expectAbsentEverywhere(rawIP, 'raw IPv4');
        expect(interceptedParams).toContain('45.45.45.0');
    });

    test('Fail-Safe: the raw User-Agent must never be persisted', async () => {
        const rawUA = 'Mozilla/5.0 (VeryDistinctiveFingerprintString/9.9)';

        await dbManager.registerEvent('test_app', {
            ip: '10.0.0.7',
            deviceSize: 'medium',
            userAgent: rawUA,
            visitorSecret: TEST_VISITOR_SECRET
        });

        expectAbsentEverywhere(rawUA, 'raw User-Agent');
        expectAbsentEverywhere('VeryDistinctiveFingerprintString', 'User-Agent fragment');
    });

    test('Fail-Safe: the view register log carries no IP, hash, or User-Agent', async () => {
        // The log outlives a view's erasure by design, so it must hold nothing
        // that identifies a visitor, not even in masked or hashed form.
        const rawIP = '77.77.77.77';
        const rawUA = 'Mozilla/5.0 (LogProbe/1.0)';

        await dbManager.registerEvent('test_app', {
            ip: rawIP,
            deviceSize: 'medium',
            userAgent: rawUA,
            visitorSecret: TEST_VISITOR_SECRET,
        });

        const logIndex = interceptedSql.findIndex((sql) => sql.includes('`_view_log`'));
        expect(logIndex).toBeGreaterThan(-1);
        const logSql = interceptedSql[logIndex];
        const hash = PrivacyUtils.generateVisitorHash(rawIP, rawUA, TEST_VISITOR_SECRET, 24, Date.now(), TEST_VISITOR_SALT);

        for (const forbidden of [rawIP, '77.77.77.0', rawUA, hash]) {
            expect(logSql).not.toContain(forbidden);
        }
        expect(logSql).not.toMatch(/masked_ip|visitor_hash|user_agent/);
    });

    test.each([['script', 'edge'], ['edge', 'script']])(
        'Fail-Safe: merging a %s report into the %s view binds neither the raw IP nor the User-Agent', async (side) => {
            const rawIP = '88.88.88.88';
            const rawUA = 'Mozilla/5.0 (MergeProbe/1.0)';
            const usual = mockPool.query.getMockImplementation();
            mockPool.query.mockImplementation(async (sql, params = []) => {
                interceptedSql.push(sql);
                interceptedParams.push(...params);
                if (/^\s*SELECT salt FROM `_visitor_salts`/.test(sql)) return [[{ salt: TEST_VISITOR_SALT }]];
                if (/^\s*SELECT id, public_id, is_unique/.test(sql)) return [[{ id: 3, public_id: 'p', is_unique: 1, visitor_hash: 'e'.repeat(64) }]];
                return [{ affectedRows: 1, insertId: 1 }];
            });
            try {
                const result = await dbManager.registerEvent('test_app', {
                    ip: rawIP, deviceSize: 'small', userAgent: rawUA, pagePath: '/a', pageTitle: 'A',
                    visitorSecret: TEST_VISITOR_SECRET, collectedBy: side, mergeWindowSeconds: 120,
                });
                expect(result.merged).toBe(true);
            } finally {
                mockPool.query.mockImplementation(usual);
            }
            for (const [needle, label] of [[rawIP, 'raw IPv4'], [rawUA, 'raw User-Agent'], ['MergeProbe', 'User-Agent fragment']]) {
                expectAbsentEverywhere(needle, label);
            }
            // The masked address is how the merge recognises the visitor: what is stored, and only that.
            expect(interceptedSql.some((sql) => sql.includes('88.88.88.0'))).toBe(false);
        });

    test('Fail-Safe: of a page URL\'s query, only the parameters named as part of the page are ever stored', async () => {
        // An edge report's page is its path plus pageQuery(url, the names it
        // sent); everything else in the query (a token, an email) is dropped.
        const url = new URL('https://site.example/?token=SECRET-TOKEN&email=a%40b.c&post=hello');
        const pagePath = `${url.pathname}${pageQuery(url, ['post'])}`;
        expect(pagePath).toBe('/?post=hello');
        expect(pageQuery(url)).toBe('');

        await dbManager.registerEvent('test_app', {
            ip: '10.0.0.9', deviceSize: 'medium', userAgent: 'Mozilla/5.0', visitorSecret: TEST_VISITOR_SECRET, pagePath,
        });
        expect(interceptedParams).toContain('/?post=hello');
        for (const needle of ['SECRET-TOKEN', 'token=', 'a@b.c', 'a%40b.c']) expectAbsentEverywhere(needle, 'unnamed query parameter');
    });

    describe('Visitor hash irreversibility', () => {
        const ip = '198.51.100.42';
        const ua = 'Mozilla/5.0';
        const now = Date.UTC(2026, 0, 15, 12, 0, 0);

        test('is keyed, not a bare digest of public values', () => {
            const hash = PrivacyUtils.generateVisitorHash(ip, ua, TEST_VISITOR_SECRET, 24, now);

            // The pre-fix implementation was sha256(`ip|ua|YYYY-MM-DD`), which is
            // brute-forceable across the whole IPv4 space in about an hour.
            const date = new Date(now).toISOString().split('T')[0];
            const unkeyed = crypto.createHash('sha256').update(`${ip}|${ua}|${date}`).digest('hex');

            expect(hash).not.toBe(unkeyed);
        });

        test('changes when the server secret changes', () => {
            const a = PrivacyUtils.generateVisitorHash(ip, ua, TEST_VISITOR_SECRET, 24, now);
            const b = PrivacyUtils.generateVisitorHash(ip, ua, 'b'.repeat(64), 24, now);

            expect(a).not.toBe(b);
        });

        test('is stable within a rotation window', () => {
            const a = PrivacyUtils.generateVisitorHash(ip, ua, TEST_VISITOR_SECRET, 24, now);
            const b = PrivacyUtils.generateVisitorHash(ip, ua, TEST_VISITOR_SECRET, 24, now + 60_000);

            expect(a).toBe(b);
        });

        test('rotates across windows so records cannot be linked over time', () => {
            const a = PrivacyUtils.generateVisitorHash(ip, ua, TEST_VISITOR_SECRET, 24, now);
            const b = PrivacyUtils.generateVisitorHash(ip, ua, TEST_VISITOR_SECRET, 24, now + 25 * 3600 * 1000);

            expect(a).not.toBe(b);
        });

        test('refuses to hash at all without a secret', () => {
            expect(() => PrivacyUtils.generateVisitorHash(ip, ua, undefined))
                .toThrow(/secret/i);
            expect(() => PrivacyUtils.generateVisitorHash(ip, ua, ''))
                .toThrow(/secret/i);
        });
    });
});
