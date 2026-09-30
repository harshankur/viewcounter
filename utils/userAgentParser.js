const UAParser = require('ua-parser-js');
const { isbot } = require('isbot');

/**
 * ua-parser-js 1.x is used because 2.x is licensed AGPL-3.0, which an MIT
 * package cannot pass on to the people who install it. 1.x names a few things
 * differently from the 2.x that recorded the data before 3.2, so its output is
 * mapped to the 2.x names: otherwise one browser would split into two rows of
 * every breakdown, depending on when a view was recorded.
 */
const OS_NAMES = { 'Mac OS': 'macOS', 'Chromium OS': 'Chrome OS' };
/** 2.x prefixes these with "Mobile " on phones (not on tablets). */
const MOBILE_PREFIXED_BROWSERS = new Set(['Chrome', 'Firefox']);

/**
 * Parse user agent string to extract browser, OS, and device information
 */
class UserAgentParser {
    /**
     * Parse user agent string
     * @param {string} userAgent - User agent string from request headers
     * @returns {object} Parsed user agent data
     */
    static parse(userAgent) {
        if (!userAgent) {
            return {
                browser: null,
                browserVersion: null,
                os: null,
                osVersion: null,
                deviceType: null
            };
        }

        const parser = new UAParser(userAgent);
        const result = parser.getResult();

        // 2.x also recognises a bare "iPad" token that 1.x needs more of the string for.
        const deviceType = result.device.type || (/\biPad\b/.test(userAgent) ? 'tablet' : undefined);
        const onPhone = deviceType === 'mobile';
        const browser = result.browser.name && onPhone && MOBILE_PREFIXED_BROWSERS.has(result.browser.name)
            ? `Mobile ${result.browser.name}`
            : result.browser.name;

        return {
            browser: browser || null,
            browserVersion: result.browser.version || null,
            os: OS_NAMES[result.os.name] || result.os.name || null,
            osVersion: result.os.version || null,
            deviceType: this.getDeviceType(deviceType)
        };
    }

    /**
     * Whether the user agent is a crawler, link previewer, headless browser, or
     * command-line client rather than a person. Such requests are counted in
     * the tracking log but never stored as views.
     * @param {string} userAgent
     * @returns {boolean}
     */
    static isBot(userAgent) {
        return Boolean(userAgent) && isbot(userAgent);
    }

    /**
     * Normalize device type
     * @param {string} type - Device type from ua-parser-js
     * @returns {string} Normalized device type
     */
    static getDeviceType(type) {
        if (!type) return 'desktop';

        const normalized = type.toLowerCase();

        if (normalized === 'mobile') return 'mobile';
        if (normalized === 'tablet') return 'tablet';
        if (normalized === 'wearable') return 'wearable';
        if (normalized === 'smarttv') return 'tv';
        if (normalized === 'console') return 'console';

        return 'desktop';
    }

    /**
     * Get a simple device size category (for backward compatibility)
     * @param {string} userAgent - User agent string
     * @returns {string} Device size: small, medium, or large
     */
    static getDeviceSize(userAgent) {
        const { deviceType } = this.parse(userAgent);

        if (deviceType === 'mobile' || deviceType === 'wearable') return 'small';
        if (deviceType === 'tablet') return 'medium';
        return 'large';
    }
}

module.exports = UserAgentParser;
