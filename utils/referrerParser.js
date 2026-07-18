const URL = require('url-parse');

const { FIELD_MAX_LENGTH, QUERY_LIMITS, SOURCE_TYPE } = require('../constants');
const { truncate } = require('./stringUtils');

/**
 * Parse referrer URLs to extract domain and source type
 */
class ReferrerParser {
    /**
     * Parse referrer URL
     * @param {string} referrer - Referrer URL from request headers
     * @returns {object} Parsed referrer data
     */
    static parse(referrer) {
        if (!referrer || referrer === '') {
            return {
                referrer: null,
                referrerDomain: null,
                sourceType: SOURCE_TYPE.DIRECT
            };
        }

        try {
            const url = new URL(referrer);
            const domain = url.hostname || null;
            const sourceType = this.getSourceType(domain, referrer);

            return {
                referrer: truncate(referrer, FIELD_MAX_LENGTH.REFERRER),
                referrerDomain: truncate(domain, FIELD_MAX_LENGTH.REFERRER_DOMAIN),
                sourceType
            };
        } catch (error) {
            return {
                referrer: truncate(referrer, FIELD_MAX_LENGTH.REFERRER),
                referrerDomain: null,
                sourceType: SOURCE_TYPE.UNKNOWN
            };
        }
    }

    /**
     * Determine source type based on referrer domain
     * @param {string} domain - Referrer domain
     * @param {string} fullUrl - Full referrer URL
     * @returns {string} Source type
     */
    static getSourceType(domain, fullUrl) {
        if (!domain) return SOURCE_TYPE.DIRECT;

        const lowerDomain = domain.toLowerCase();

        // Search engines
        if (this.isSearchEngine(lowerDomain)) return SOURCE_TYPE.SEARCH;

        // Social media
        if (this.isSocialMedia(lowerDomain)) return SOURCE_TYPE.SOCIAL;

        // Email clients
        if (this.isEmail(lowerDomain)) return SOURCE_TYPE.EMAIL;

        // Ads/campaigns (check for utm parameters)
        if (fullUrl.includes('utm_source') || fullUrl.includes('utm_medium')) {
            return SOURCE_TYPE.CAMPAIGN;
        }

        // Everything else is referral
        return SOURCE_TYPE.REFERRAL;
    }

    /**
     * Check if domain is a search engine
     */
    static isSearchEngine(domain) {
        const searchEngines = [
            'google', 'bing', 'yahoo', 'duckduckgo', 'baidu',
            'yandex', 'ask', 'aol', 'ecosia', 'qwant'
        ];
        return searchEngines.some(engine => domain.includes(engine));
    }

    /**
     * Check if domain is social media
     */
    static isSocialMedia(domain) {
        const socialMedia = [
            'facebook', 'twitter', 'x.com', 'instagram', 'linkedin',
            'reddit', 'pinterest', 'tiktok', 'youtube', 'snapchat',
            'whatsapp', 'telegram', 'discord', 'tumblr', 'vk.com',
            'weibo', 'line.me', 'mastodon'
        ];
        return socialMedia.some(social => domain.includes(social));
    }

    /**
     * Check if domain is email client
     */
    static isEmail(domain) {
        const emailClients = [
            'mail.google', 'outlook', 'yahoo.com/mail',
            'mail.yahoo', 'protonmail', 'mail.aol'
        ];
        return emailClients.some(email => domain.includes(email));
    }

    /**
     * Get top referrers summary
     * @param {Array} referrers - Array of referrer objects from DB
     * @returns {object} Summarized referrer stats
     */
    static summarizeReferrers(referrers) {
        const bySource = {};
        const byDomain = {};

        referrers.forEach(ref => {
            const sourceType = ref.sourceType || SOURCE_TYPE.UNKNOWN;
            bySource[sourceType] = (bySource[sourceType] || 0) + 1;

            if (ref.referrerDomain) {
                byDomain[ref.referrerDomain] = (byDomain[ref.referrerDomain] || 0) + 1;
            }
        });

        return {
            bySource: Object.entries(bySource)
                .map(([source, count]) => ({ source, count }))
                .sort((a, b) => b.count - a.count),
            byDomain: Object.entries(byDomain)
                .map(([domain, count]) => ({ domain, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, QUERY_LIMITS.LIST_LIMIT_DEFAULT)
        };
    }
}

module.exports = ReferrerParser;
