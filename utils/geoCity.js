/**
 * Optional region and city for a view, from a city database the operator
 * provides (GEOIP_CITY_DB, an .mmdb file).
 *
 * Off unless configured. The IP is looked up and discarded exactly as for the
 * country: only the region and city names are kept, never the address or any
 * coordinates. Both common free databases are understood, and each carries a
 * licence that asks for a credit, which the admin UI shows:
 *   - DB-IP IP to City Lite (CC BY 4.0), https://db-ip.com/db/lite.php
 *   - MaxMind GeoLite2 City, https://dev.maxmind.com/geoip/geolite2-free-geolocation-data
 *
 * The file is re-read when it is replaced, so a monthly update needs no restart.
 */

const maxmind = require('maxmind');

const { FIELD_MAX_LENGTH } = require('../constants');

/**
 * The country of every view comes from geoip-country, which bundles MaxMind's
 * GeoLite2 Country data; its licence asks for this credit.
 */
const COUNTRY_ATTRIBUTION = Object.freeze({
    text: 'This product includes GeoLite2 data created by MaxMind',
    url: 'https://www.maxmind.com',
});

/** The credit each database's licence asks for, by its metadata type. */
const ATTRIBUTIONS = [
    { match: /dbip|db-ip/i, text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' },
    { match: /geolite2|geoip2/i, text: 'This product includes GeoLite2 data created by MaxMind', url: 'https://www.maxmind.com' },
];

const englishName = (record) => {
    const name = record?.names?.en;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, FIELD_MAX_LENGTH.CITY) : null;
};

/**
 * @param {{ get: (ip: string) => object|null, metadata?: { databaseType?: string } }} reader an opened .mmdb reader
 * @returns {{ lookup: (ip: string) => ({ region: string|null, city: string|null }), attribution: object|null, databaseType: string }}
 */
function createCityLookup(reader) {
    const databaseType = String(reader.metadata?.databaseType || 'unknown');
    const credit = ATTRIBUTIONS.find((candidate) => candidate.match.test(databaseType));

    return {
        databaseType,
        attribution: credit ? { text: credit.text, url: credit.url } : { text: `Location data: ${databaseType}`, url: null },

        lookup(ip) {
            let record = null;
            try {
                record = reader.get(ip);
            } catch {
                return { region: null, city: null };
            }
            return {
                region: englishName(record?.subdivisions?.[0]),
                city: englishName(record?.city),
            };
        },
    };
}

/**
 * Open the configured city database, or return null when none is configured.
 * @param {string|undefined} file
 * @returns {Promise<ReturnType<typeof createCityLookup>|null>}
 */
async function openCityLookup(file) {
    if (!file) return null;
    const reader = await maxmind.open(file, { watchForUpdates: true, watchForUpdatesNonPersistent: true });
    return createCityLookup(reader);
}

/**
 * Every credit the location data in use asks for, each once.
 * @param {{ attribution: object }|null} cityLookup
 * @returns {{ text: string, url: string|null }[]}
 */
function attributions(cityLookup) {
    const all = [COUNTRY_ATTRIBUTION, ...(cityLookup ? [cityLookup.attribution] : [])];
    return all.filter((credit, index) => all.findIndex((other) => other.text === credit.text) === index);
}

module.exports = { createCityLookup, openCityLookup, attributions, ATTRIBUTIONS, COUNTRY_ATTRIBUTION };
