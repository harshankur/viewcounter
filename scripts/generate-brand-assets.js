#!/usr/bin/env node
/**
 * Generates every ViewCounter brand asset from one source of truth.
 *
 * The wordmark is a terminal chevron followed by "VC" set in JetBrains Mono
 * ExtraBold. The letters are stored below as outlined vector paths rather than
 * as SVG <text>, because <text> depends on the webfont actually being available:
 * if Google Fonts is blocked, slow, or the asset is rendered outside a browser
 * (favicon, apple-touch icon, OG image), the mark silently falls back to a
 * serif face and the logo is wrong. Outlines render identically everywhere.
 *
 * The outlines were traced from the real font at 1000px and simplified; the
 * metrics below match JetBrains Mono exactly (advance 0.600em, cap height
 * 0.730em), so the mark is geometrically identical to the typeset original.
 *
 * Usage: node scripts/generate-brand-assets.js
 * PNG output additionally requires `rsvg-convert` (brew install librsvg).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DOCS_DIR = path.join(__dirname, '..', 'docs');

// --- Brand -------------------------------------------------------------------

const COLOR = {
    ink: '#0a0f0c',      // tile background
    mark: '#3ddc84',     // --primary from docs/index.html
    edge: '#3ddc84',     // tile border, drawn at reduced opacity
};

// --- Glyph outlines, em units, origin = advance-cell left edge on the baseline.
//     y is negative above the baseline (font convention; flipped for SVG below).
const GLYPHS = {
    V: [[0.025,-0.73],[0.179,-0.73],[0.18,-0.728],[0.281,-0.267],[0.304,-0.148],[0.306,-0.149],[0.328,-0.282],[0.423,-0.728],[0.424,-0.73],[0.574,-0.73],[0.395,-0.001],[0.206,-0.001]],
    C: [[0.287,-0.74],[0.336,-0.739],[0.391,-0.729],[0.419,-0.719],[0.443,-0.707],[0.471,-0.688],[0.5,-0.66],[0.522,-0.628],[0.539,-0.586],[0.547,-0.536],[0.547,-0.521],[0.398,-0.521],[0.397,-0.54],[0.393,-0.557],[0.379,-0.582],[0.366,-0.594],[0.35,-0.603],[0.316,-0.611],[0.283,-0.61],[0.257,-0.603],[0.235,-0.589],[0.225,-0.578],[0.216,-0.562],[0.209,-0.532],[0.209,-0.199],[0.217,-0.167],[0.231,-0.146],[0.247,-0.133],[0.276,-0.122],[0.316,-0.12],[0.335,-0.123],[0.35,-0.128],[0.367,-0.138],[0.384,-0.156],[0.395,-0.181],[0.398,-0.21],[0.547,-0.21],[0.543,-0.163],[0.529,-0.118],[0.509,-0.083],[0.478,-0.049],[0.448,-0.027],[0.406,-0.007],[0.365,0.004],[0.321,0.009],[0.263,0.007],[0.217,-0.002],[0.17,-0.021],[0.135,-0.044],[0.111,-0.067],[0.098,-0.083],[0.077,-0.12],[0.065,-0.158],[0.06,-0.195],[0.06,-0.537],[0.064,-0.569],[0.076,-0.609],[0.09,-0.636],[0.108,-0.661],[0.135,-0.687],[0.161,-0.705],[0.191,-0.72],[0.217,-0.729],[0.248,-0.736]],
};

const ADVANCE_EM = 0.6;    // JetBrains Mono advance width
const SIZE       = 22;     // nominal "font-size" in user units
const BASELINE   = 24;
const TEXT_X     = 24;     // left edge of the V advance cell
const CHEVRON    = { points: '3,6 15,16 3,26', width: 5 };

const round = n => +n.toFixed(2);

/** Outline path for a glyph placed in its advance cell. */
function glyphPath(char, cellX) {
    const points = GLYPHS[char].map(([x, y]) => [round(cellX + x * SIZE), round(BASELINE + y * SIZE)]);
    return 'M' + points.map(p => p.join(' ')).join('L') + 'Z';
}

const VC_PATH = glyphPath('V', TEXT_X) + glyphPath('C', TEXT_X + ADVANCE_EM * SIZE);

/** Ink bounds of chevron + VC, so square tiles can centre the mark exactly. */
function inkBounds() {
    const half = CHEVRON.width / 2;   // round caps overhang by half the stroke
    const xs = [3 - half, 15 + half];
    const ys = [6 - half, 26 + half];
    for (const [char, cell] of [['V', TEXT_X], ['C', TEXT_X + ADVANCE_EM * SIZE]]) {
        for (const [x, y] of GLYPHS[char]) {
            xs.push(cell + x * SIZE);
            ys.push(BASELINE + y * SIZE);
        }
    }
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

const chevron = color =>
    `<polyline points="${CHEVRON.points}" fill="none" stroke="${color}" stroke-width="${CHEVRON.width}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Horizontal brand mark, tightly cropped, inherits colour via currentColor. */
function buildLogo() {
    const b = inkBounds();
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(b.x0)} ${round(b.y0)} ${round(b.width)} ${round(b.height)}" role="img" aria-label="ViewCounter">
  <title>ViewCounter</title>
  ${chevron('currentColor')}
  <path d="${VC_PATH}" fill="currentColor"/>
</svg>
`;
}

/**
 * Square icon tile.
 * @param {number} pad      padding around the mark, in tile units
 * @param {number} radius   corner radius; 0 = full bleed (iOS applies its own mask)
 */
function buildTile({ pad, radius }) {
    const TILE = 64;
    const b = inkBounds();
    const scale = Math.min((TILE - pad * 2) / b.width, (TILE - pad * 2) / b.height);
    const tx = round((TILE - b.width * scale) / 2 - b.x0 * scale);
    const ty = round((TILE - b.height * scale) / 2 - b.y0 * scale);

    const border = radius > 0
        ? `\n  <rect x="0.75" y="0.75" width="${TILE - 1.5}" height="${TILE - 1.5}" rx="${radius - 0.75}" fill="none" stroke="${COLOR.edge}" stroke-opacity="0.35" stroke-width="1.5"/>`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" role="img" aria-label="ViewCounter">
  <title>ViewCounter</title>
  <rect width="${TILE}" height="${TILE}" rx="${radius}" fill="${COLOR.ink}"/>${border}
  <g transform="translate(${tx} ${ty}) scale(${round(scale)})">
    ${chevron(COLOR.mark)}
    <path d="${VC_PATH}" fill="${COLOR.mark}"/>
  </g>
</svg>
`;
}

// --- Emit --------------------------------------------------------------------
// Filenames are fixed by agent-instructions FRONTEND.md §10 — every project
// ships the same names so an icon is always findable without reading the HTML.

const APP_NAME = 'ViewCounter';
const ICO_SIZES = [16, 32, 48];   // resolutions packed into favicon.ico

const logoSvg = buildLogo();
const faviconSvg = buildTile({ pad: 3.5, radius: 14 });
// Full bleed: iOS already rounds apple-touch icons, so a pre-rounded tile
// would render with a visible double corner.
const appleTouchSvg = buildTile({ pad: 5, radius: 0 });

const write = (file, contents) => {
    fs.writeFileSync(path.join(DOCS_DIR, file), contents);
    console.log(`wrote docs/${file}`);
};

write('logo.svg', logoSvg);
write('favicon.svg', faviconSvg);
write('site.webmanifest', JSON.stringify({
    name: APP_NAME,
    short_name: APP_NAME,
    // Relative so the manifest resolves both at the custom domain root and
    // under a project-pages path fallback; the site is served from
    // viewcounter.harshankur.com (docs/CNAME).
    icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: COLOR.ink,
    background_color: COLOR.ink,
    display: 'standalone',
}, null, 2) + '\n');

const rasters = [
    { svg: appleTouchSvg, file: 'apple-touch-icon.png', size: 180 },
    { svg: faviconSvg, file: 'icon-192.png', size: 192 },
    { svg: faviconSvg, file: 'icon-512.png', size: 512 },
];

const has = (cmd, args) => {
    try {
        execFileSync(cmd, args, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

if (!has('rsvg-convert', ['--version'])) {
    console.warn('\nrsvg-convert not found — skipped PNG/ICO output. Install with: brew install librsvg');
    return;
}

const render = (svg, size, outPath) =>
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outPath], { input: svg });

for (const { svg, file, size } of rasters) {
    render(svg, size, path.join(DOCS_DIR, file));
    console.log(`wrote docs/${file} (${size}px)`);
}

// favicon.ico is multi-resolution, which rsvg-convert cannot produce; Pillow
// packs the sizes from a single high-res render.
if (!has('python3', ['-c', 'import PIL'])) {
    console.warn('favicon.ico skipped — needs Pillow (pip install pillow)');
} else {
    const tmpPng = path.join(os.tmpdir(), 'viewcounter-icon-src.png');
    render(faviconSvg, Math.max(...ICO_SIZES) * 4, tmpPng);
    execFileSync('python3', [
        '-c',
        'import sys;from PIL import Image;' +
        'Image.open(sys.argv[1]).save(sys.argv[2], sizes=[(int(s),int(s)) for s in sys.argv[3].split(",")])',
        tmpPng,
        path.join(DOCS_DIR, 'favicon.ico'),
        ICO_SIZES.join(','),
    ]);
    fs.unlinkSync(tmpPng);
    console.log(`wrote docs/favicon.ico (${ICO_SIZES.join('/')}px)`);
}
