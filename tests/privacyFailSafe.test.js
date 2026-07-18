const crypto = require('crypto');

const DatabaseManager = require('../db/DatabaseManager');
const PrivacyUtils = require('../utils/privacyUtils');
const { TEST_VISITOR_SECRET } = require('./jestSetup');

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
        expect(interceptedParams).toContain('2001:0db8:85a3:0000:0:0:0:0');
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
