const crypto = require('crypto');

const { SERVER } = require('../constants');
const { getError, ErrorType } = require('./errorUtils');

/** Rotation never runs slower than this, even if dedup is disabled. */
const MIN_ROTATION_HOURS = 1;

const MS_PER_HOUR = 60 * 60 * 1000;

class PrivacyUtils {
    /**
     * Masks the IP address to be non-identifiable.
     * IPv4: Masks the last octet (e.g. 1.2.3.4 -> 1.2.3.0)
     * IPv6: Masks the last 64 bits (interface identifier)
     * @param {string} ip The raw IP address
     * @returns {string} The masked IP
     */
    static maskIP(ip) {
        if (!ip) return '0.0.0.0';

        // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1)
        if (ip.startsWith('::ffff:')) {
            const ipv4 = ip.split(':').pop();
            return `::ffff:${this.maskIPv4(ipv4)}`;
        }

        if (ip.includes(':')) {
            return this.maskIPv6(ip);
        }

        return this.maskIPv4(ip);
    }

    static maskIPv4(ip) {
        const parts = ip.split('.');
        if (parts.length === 4) {
            return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
        }
        return ip;
    }

    static maskIPv6(ip) {
        const parts = ip.split(':');
        // Mask the last 4 groups (64 bits)
        if (parts.length >= 4) {
            return parts.slice(0, 4).join(':') + ':0:0:0:0';
        }
        return ip;
    }

    /**
     * Identifier for the current rotation window.
     *
     * Including this in the hash input means a visitor's hash changes on every
     * window boundary, so two records from different windows cannot be linked
     * back to the same person even by whoever holds the secret.
     *
     * @param {number} rotationHours
     * @param {number} [now] epoch millis, injectable for tests
     * @returns {number}
     */
    static currentWindowId(rotationHours, now = Date.now()) {
        const hours = Math.max(Number(rotationHours) || 0, MIN_ROTATION_HOURS);
        return Math.floor(now / (hours * MS_PER_HOUR));
    }

    /**
     * Generate the transient visitor identifier.
     *
     * This is a keyed HMAC, not a bare digest. Every non-secret input is
     * public or guessable — the date is known, user agents come from a small
     * population, and IPv4 is only 2^32 — so an unkeyed SHA-256 of them is
     * reversible by exhaustive search in about an hour on one CPU core. The
     * server secret is what makes that search infeasible; the window id is
     * what stops hashes being linkable over time.
     *
     * @param {string} ip Raw IP address
     * @param {string} userAgent Raw User-Agent string
     * @param {string} secret Server secret from utils/secretStore.js
     * @param {number} [rotationHours] Window length, defaults to the unique-visitor window
     * @param {number} [now] epoch millis, injectable for tests
     * @returns {string} HMAC-SHA-256 hex digest
     * @throws {Error} ErrorType.SECRET_UNAVAILABLE when no secret is supplied
     */
    static generateVisitorHash(
        ip,
        userAgent,
        secret,
        rotationHours = SERVER.DEFAULT_UNIQUE_VISITOR_WINDOW_HOURS,
        now = Date.now(),
    ) {
        if (!secret) {
            // Failing closed is deliberate: silently hashing without the key
            // would produce reversible identifiers that look indistinguishable
            // from safe ones.
            throw getError(ErrorType.SECRET_UNAVAILABLE);
        }

        const windowId = this.currentWindowId(rotationHours, now);
        const input = `${ip}|${userAgent}|${windowId}`;

        return crypto.createHmac('sha256', secret).update(input).digest('hex');
    }
}

module.exports = PrivacyUtils;
