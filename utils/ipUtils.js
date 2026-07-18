/**
 * Client IP derivation and validation.
 *
 * Split out of middleware/validation.js because it is used by the route layer,
 * the privacy layer, and the middleware layer (CODE_STANDARDS.md §2).
 */

const net = require('net');

/**
 * Validate an IP address.
 *
 * Uses Node's built-in parser rather than a hand-written regex. The previous
 * IPv4 pattern (`^(\d{1,3}\.){3}\d{1,3}$`) had no octet range check, so
 * `999.999.999.999` validated and was stored as a masked "address" that never
 * existed. `net.isIP` range-checks properly and cannot backtrack.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    return net.isIP(ip) !== 0;
}

/**
 * Resolve the client's IP for a request.
 *
 * Deliberately reads ONLY `req.ip`, which Express derives according to the
 * app's `trust proxy` setting. The previous implementation read `x-real-ip`
 * and `x-forwarded-for` straight off the request, so any caller could name
 * their own address — forging geolocation, inflating unique-visitor counts,
 * and rotating the rate-limiter key to bypass it entirely.
 *
 * If a reverse proxy in front of this service sets only `X-Real-IP`, configure
 * it to also set `X-Forwarded-For`; that is the header Express understands.
 *
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
function getClientIp(req) {
    return req.ip;
}

/**
 * Normalize an IPv4-mapped IPv6 address to its IPv4 form.
 * Express reports `::ffff:1.2.3.4` on a dual-stack socket; geo lookup and
 * masking both want the plain IPv4.
 *
 * @param {string} ip
 * @returns {string}
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string') return ip;
    const mapped = ip.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
    return mapped && net.isIPv4(mapped[1]) ? mapped[1] : ip;
}

module.exports = {
    isValidIP,
    getClientIp,
    normalizeIp,
};
