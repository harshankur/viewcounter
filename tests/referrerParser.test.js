const ReferrerParser = require('../utils/referrerParser');

describe('ReferrerParser', () => {
    describe('parse()', () => {
        test('should parse Google search referrer', () => {
            const referrer = 'https://www.google.com/search?q=test';
            const result = ReferrerParser.parse(referrer);

            expect(result.referrerDomain).toBe('www.google.com');
            expect(result.sourceType).toBe('search');
        });

        test('should parse Twitter referrer', () => {
            const referrer = 'https://twitter.com/user/status/123';
            const result = ReferrerParser.parse(referrer);

            expect(result.referrerDomain).toBe('twitter.com');
            expect(result.sourceType).toBe('social');
        });

        test('keeps only the origin and path: a query or fragment can carry tokens and emails', () => {
            const result = ReferrerParser.parse('https://site.example/reset-password?token=SECRET&email=a%40b.c#step-2', 'site.example');
            expect(result.referrer).toBe('https://site.example/reset-password');
            expect(result.sourceType).toBe('internal');
            expect(JSON.stringify(result)).not.toMatch(/SECRET|a%40b|step-2/);
        });

        test('reads the source from the whole URL before stripping it', () => {
            const result = ReferrerParser.parse('https://example.com/page?utm_source=newsletter');
            expect(result.sourceType).toBe('campaign');
            expect(result.referrer).toBe('https://example.com/page');
        });

        test('strips an unparseable referrer too', () => {
            expect(ReferrerParser.withoutQuery('not a url?secret=1#x')).toBe('not a url');
        });

        test('should parse direct traffic (no referrer)', () => {
            const result = ReferrerParser.parse('');

            expect(result.referrer).toBeNull();
            expect(result.referrerDomain).toBeNull();
            expect(result.sourceType).toBe('direct');
        });

        test('should detect campaign traffic with UTM params', () => {
            const referrer = 'https://example.com/page?utm_source=newsletter&utm_medium=email';
            const result = ReferrerParser.parse(referrer);

            expect(result.sourceType).toBe('campaign');
        });

        test('should categorize other domains as referral', () => {
            const referrer = 'https://example.com/page';
            const result = ReferrerParser.parse(referrer);

            expect(result.referrerDomain).toBe('example.com');
            expect(result.sourceType).toBe('referral');
        });
    });

    describe('isSearchEngine()', () => {
        test('should detect Google', () => {
            expect(ReferrerParser.isSearchEngine('google.com')).toBe(true);
        });

        test('should detect Bing', () => {
            expect(ReferrerParser.isSearchEngine('bing.com')).toBe(true);
        });

        test('should not detect non-search engines', () => {
            expect(ReferrerParser.isSearchEngine('example.com')).toBe(false);
        });
    });

    describe('isSocialMedia()', () => {
        test('should detect Twitter', () => {
            expect(ReferrerParser.isSocialMedia('twitter.com')).toBe(true);
        });

        test('should detect Facebook', () => {
            expect(ReferrerParser.isSocialMedia('facebook.com')).toBe(true);
        });

        test('should not detect non-social sites', () => {
            expect(ReferrerParser.isSocialMedia('example.com')).toBe(false);
        });
    });
});
