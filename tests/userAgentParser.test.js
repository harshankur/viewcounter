const UserAgentParser = require('../utils/userAgentParser');

describe('UserAgentParser', () => {
    describe('parse()', () => {
        test('should parse Chrome on Windows', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
            const result = UserAgentParser.parse(ua);

            expect(result.browser).toBe('Chrome');
            expect(result.os).toBe('Windows');
            expect(result.deviceType).toBe('desktop');
        });

        test('should parse Safari on iOS', () => {
            const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
            const result = UserAgentParser.parse(ua);

            expect(result.browser).toBe('Mobile Safari');
            expect(result.os).toBe('iOS');
            expect(result.deviceType).toBe('mobile');
        });

        test('should parse Firefox on Linux', () => {
            const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
            const result = UserAgentParser.parse(ua);

            expect(result.browser).toBe('Firefox');
            expect(result.os).toBe('Linux');
            expect(result.deviceType).toBe('desktop');
        });

        test('should handle null user agent', () => {
            const result = UserAgentParser.parse(null);

            expect(result.browser).toBeNull();
            expect(result.os).toBeNull();
            expect(result.deviceType).toBeNull();
        });
    });

    describe('getDeviceSize()', () => {
        test('should return small for mobile', () => {
            const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)';
            expect(UserAgentParser.getDeviceSize(ua)).toBe('small');
        });

        test('should return medium for tablet', () => {
            const ua = 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X)';
            expect(UserAgentParser.getDeviceSize(ua)).toBe('medium');
        });

        test('should return large for desktop', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
            expect(UserAgentParser.getDeviceSize(ua)).toBe('large');
        });
    });

    // Views recorded before 3.2 were parsed by ua-parser-js 2.x; the names must
    // not change, or one browser would split into two rows of every breakdown.
    describe('keeps the names views were recorded with before 3.2', () => {
        test.each([
            ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
                { browser: 'Safari', os: 'macOS', deviceType: 'desktop' }],
            ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                { browser: 'Chrome', os: 'Chrome OS', deviceType: 'desktop' }],
            ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
                { browser: 'Mobile Chrome', os: 'Android', deviceType: 'mobile' }],
            ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
                { browser: 'Mobile Chrome', os: 'iOS', deviceType: 'mobile' }],
            ['Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
                { browser: 'Mobile Firefox', os: 'Android', deviceType: 'mobile' }],
            // On tablets 2.x keeps the plain name.
            ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                { browser: 'Chrome', os: 'Android', deviceType: 'tablet' }],
        ])('%s', (ua, expected) => {
            expect(UserAgentParser.parse(ua)).toMatchObject(expected);
        });
    });

    describe('isBot()', () => {
        test.each([
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.60 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
            'curl/8.4.0',
        ])('flags %s', (ua) => {
            expect(UserAgentParser.isBot(ua)).toBe(true);
        });

        test.each([
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        ])('passes %s', (ua) => {
            expect(UserAgentParser.isBot(ua)).toBe(false);
        });

        test('an absent user agent is not called a bot here; validation decides about it', () => {
            expect(UserAgentParser.isBot('')).toBe(false);
            expect(UserAgentParser.isBot(undefined)).toBe(false);
        });
    });
});
