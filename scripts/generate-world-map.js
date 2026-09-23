#!/usr/bin/env node
/**
 * Generate admin/assets/world-map.json: projected SVG paths for every country,
 * keyed by ISO 3166-1 alpha-2 code (the code geoip-country reports), for the
 * admin UI's map.
 *
 * Generated once and committed, so the admin UI draws the map with no runtime
 * dependency and no third-party request. Re-run after updating world-atlas:
 *
 *   node scripts/generate-world-map.js
 *
 * Source: Natural Earth (public domain), via the world-atlas package (ISC).
 * Shapes come from the 1:110m set. Countries too small to appear at that scale
 * (Singapore, Malta, Bahrain, ...) are placed as points at the centroid of
 * their 1:50m shape, so views from them still land on the map.
 */

const fs = require('fs');
const path = require('path');
const { feature } = require('topojson-client');
const countries = require('i18n-iso-countries');

const OUTPUT = path.join(__dirname, '..', 'admin', 'assets', 'world-map.json');
const WIDTH = 960;
const HEIGHT = 470;
const PADDING = 4;
/** Decimal places kept in path coordinates: enough at this size, far smaller output. */
const PATH_DIGITS = 1;
/** Excluded: no visitor is there, and it would take a fifth of the height. */
const EXCLUDED = new Set(['AQ']);

/** Natural Earth features that carry no ISO numeric id. */
const CODE_BY_NAME = {
    Kosovo: 'XK',
};

function codeOf(entry) {
    if (entry.id !== undefined) {
        const code = countries.numericToAlpha2(entry.id);
        if (code) return code;
    }
    return CODE_BY_NAME[entry.properties?.name] || null;
}

function load(resolution) {
    const topology = require(`world-atlas/countries-${resolution}.json`);
    return feature(topology, topology.objects.countries).features;
}

async function main() {
    const { geoNaturalEarth1, geoPath, geoCentroid } = await import('d3-geo');

    const coarse = load('110m').filter((entry) => !EXCLUDED.has(codeOf(entry)));
    const fine = load('50m').filter((entry) => !EXCLUDED.has(codeOf(entry)));

    const projection = geoNaturalEarth1().fitExtent(
        [[PADDING, PADDING], [WIDTH - PADDING, HEIGHT - PADDING]],
        { type: 'FeatureCollection', features: coarse },
    );
    const draw = geoPath(projection).digits(PATH_DIGITS);

    const shapes = new Map();
    for (const entry of coarse) {
        const code = codeOf(entry);
        if (!code) continue;
        // A country split across features (rare) keeps every part.
        shapes.set(code, (shapes.get(code) || '') + draw(entry));
    }

    const points = [];
    for (const entry of fine) {
        const code = codeOf(entry);
        if (!code || shapes.has(code) || points.some((point) => point.code === code)) continue;
        const [x, y] = projection(geoCentroid(entry));
        points.push({ code, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }

    const output = {
        source: 'Natural Earth 1:110m (points from 1:50m), via world-atlas. Public domain.',
        width: WIDTH,
        height: HEIGHT,
        shapes: [...shapes.entries()].sort().map(([code, d]) => ({ code, d })),
        points: points.sort((a, b) => a.code.localeCompare(b.code)),
    };

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
    console.log(`Wrote ${OUTPUT}: ${output.shapes.length} shapes, ${output.points.length} points, `
        + `${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} kB`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
