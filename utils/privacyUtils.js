const crypto = require('crypto');
const net = require('net');

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

    /**
     * Keep the first 64 bits (the network) and zero the rest, in one written
     * form whatever form the address came in: compressed (`::`), with leading
     * zeros, in capitals, with an IPv4 tail. Splitting the text at its colons
     * instead kept part of the interface identifier of any address whose
     * network had a `::` in it (and all of `::1`), and wrote one network in
     * several ways, so two addresses of one /64 could look like two.
     * Anything that is not an IPv6 address is passed through as it is.
     * @param {string} ip
     * @returns {string}
     */
    static maskIPv6(ip) {
        const groups = this.ipv6Groups(ip);
        return groups ? `${groups.slice(0, 4).join(':')}:0:0:0:0` : ip;
    }

    /**
     * The eight 16-bit groups of an IPv6 address, as lowercase hexadecimal
     * without leading zeros, or null for anything that is not one.
     * @param {string} ip
     * @returns {string[]|null}
     */
    static ipv6Groups(ip) {
        const text = String(ip).split('%')[0].toLowerCase();
        if (!net.isIPv6(text)) return null;
        // An IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is the last two groups.
        const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
        const hex = tail
            ? `${text.slice(0, tail.index)}${((Number(tail[1]) << 8) | Number(tail[2])).toString(16)}:${((Number(tail[3]) << 8) | Number(tail[4])).toString(16)}`
            : text;
        const [head, rest] = hex.includes('::') ? hex.split('::') : [hex, null];
        const before = head ? head.split(':') : [];
        const after = rest ? rest.split(':') : [];
        const groups = rest === null ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
        return groups.map((group) => Number.parseInt(group, 16).toString(16));
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
        return Math.floor(now / (this.rotationHours(rotationHours) * MS_PER_HOUR));
    }

    /**
     * The length of a rotation window, in hours: the unique-visitor window,
     * and never less than MIN_ROTATION_HOURS.
     * @param {number} rotationHours
     * @returns {number}
     */
    static rotationHours(rotationHours) {
        return Math.max(Number(rotationHours) || 0, MIN_ROTATION_HOURS);
    }

    /**
     * Generate the transient visitor identifier.
     *
     * This is a keyed HMAC, not a bare digest. Every non-secret input is
     * public or guessable (the date is known, user agents come from a small
     * population, and IPv4 is only 2^32), so an unkeyed SHA-256 of them is
     * reversible by exhaustive search in about an hour on one CPU core. The
     * server secret is what makes that search infeasible; the window id is
     * what stops hashes being linkable over time.
     *
     * @param {string} ip Raw IP address
     * @param {string} userAgent Raw User-Agent string
     * @param {string} secret Server secret from utils/secretStore.js
     * @param {number} [rotationHours] Window length, defaults to the unique-visitor window
     * @param {number} [now] epoch millis, injectable for tests
     * @param {string} [salt] The window's own salt (db/visitorSalt.js), which
     *     is deleted when the window ends. With it, a hash cannot be recomputed
     *     afterwards even by whoever holds the secret. Without it, the window
     *     id alone separates the windows, and the secret holder still can.
     * @returns {string} HMAC-SHA-256 hex digest
     * @throws {Error} ErrorType.SECRET_UNAVAILABLE when no secret is supplied
     */
    static generateVisitorHash(
        ip,
        userAgent,
        secret,
        rotationHours = SERVER.DEFAULT_UNIQUE_VISITOR_WINDOW_HOURS,
        now = Date.now(),
        salt = '',
    ) {
        if (!secret) {
            // Failing closed is deliberate: silently hashing without the key
            // would produce reversible identifiers that look indistinguishable
            // from safe ones.
            throw getError(ErrorType.SECRET_UNAVAILABLE);
        }

        const windowId = this.currentWindowId(rotationHours, now);
        // The unsalted form is kept byte for byte, for callers that use this helper on its own.
        const input = salt ? `${salt}|${ip}|${userAgent}|${windowId}` : `${ip}|${userAgent}|${windowId}`;

        return crypto.createHmac('sha256', secret).update(input).digest('hex');
    }
}

module.exports = PrivacyUtils;
