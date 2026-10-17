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
 * their own address: forging geolocation, inflating unique-visitor counts,
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

/** The 16-bit groups of the IPv4-mapped prefix, ::ffff:0:0/96, before the IPv4 address. */
const MAPPED_PREFIX = ['0', '0', '0', '0', '0', 'ffff'];

/**
 * The eight 16-bit groups of an IPv6 address, as lowercase hexadecimal
 * without leading zeros, or null for anything that is not one. A zone
 * (`%en0`) is dropped; an IPv4 tail (`::ffff:1.2.3.4`) is the last two groups.
 *
 * @param {string} ip
 * @returns {string[]|null}
 */
function ipv6Groups(ip) {
    const text = String(ip).split('%')[0].toLowerCase();
    if (!net.isIPv6(text)) return null;
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
 * The IPv4 address an IPv4-mapped IPv6 address carries, from its groups,
 * however it was spelled; null for any other address.
 *
 * @param {string[]} groups from ipv6Groups
 * @returns {string|null} e.g. "1.2.3.4"
 */
function mappedIPv4(groups) {
    if (!Array.isArray(groups) || !MAPPED_PREFIX.every((group, index) => groups[index] === group)) return null;
    const [high, low] = groups.slice(6).map((group) => Number.parseInt(group, 16));
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Normalize an IPv4-mapped IPv6 address to its IPv4 form, however it is
 * spelled. Express reports `::ffff:1.2.3.4` on a dual-stack socket; geo
 * lookup, masking, and the visitor hash all want the plain IPv4, the same for
 * every spelling of one address.
 *
 * @param {string} ip
 * @returns {string}
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string' || !ip.includes(':')) return ip;
    return mappedIPv4(ipv6Groups(ip)) ?? ip;
}

module.exports = {
    isValidIP,
    getClientIp,
    normalizeIp,
    ipv6Groups,
    mappedIPv4,
};
