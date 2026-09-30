/**
 * The UI's icons: small line drawings on a 24-unit grid, built as SVG
 * elements (never parsed from markup), stroked in the text colour around
 * them. An icon is always decoration: the control it sits in carries the
 * accessible name.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Each icon is a list of [tag, attributes]. Paths are open line drawings;
 * `fill: true` marks the few shapes that are solid.
 */
const ICONS = {
    overview: [
        ['rect', { x: 3, y: 3, width: 7, height: 9, rx: 1.5 }],
        ['rect', { x: 14, y: 3, width: 7, height: 5, rx: 1.5 }],
        ['rect', { x: 14, y: 12, width: 7, height: 9, rx: 1.5 }],
        ['rect', { x: 3, y: 16, width: 7, height: 5, rx: 1.5 }],
    ],
    views: [
        ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
        ['path', { d: 'M3 9.5h18M3 15h18M9 9.5V20' }],
    ],
    trash: [
        ['path', { d: 'M4 7h16M10 11v6M14 11v6M9 7V4.5h6V7M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }],
    ],
    trackingLog: [
        ['path', { d: 'M3 12h4l3-7 4 14 3-7h4' }],
    ],
    adminLog: [
        ['path', { d: 'M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z' }],
        ['path', { d: 'M9 12l2 2 4-4' }],
    ],
    sun: [
        ['circle', { cx: 12, cy: 12, r: 4 }],
        ['path', { d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4' }],
    ],
    moon: [
        ['path', { d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z' }],
    ],
    auto: [
        ['circle', { cx: 12, cy: 12, r: 8.5 }],
        ['path', { d: 'M12 3.5a8.5 8.5 0 0 1 0 17z', fill: true }],
    ],
    signOut: [
        ['path', { d: 'M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 16.5l4.5-4.5L15 7.5M19.5 12H9' }],
    ],
    external: [
        ['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4' }],
    ],
    globe: [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['path', { d: 'M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }],
    ],
    book: [
        ['path', { d: 'M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5zM5 20.5A2.5 2.5 0 0 0 7.5 21H19v-3' }],
    ],
    code: [
        ['path', { d: 'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5' }],
    ],
    package: [
        ['path', { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9' }],
    ],
    info: [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['path', { d: 'M12 11v5.5M12 7.6v.1' }],
    ],
    edit: [
        ['path', { d: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4' }],
    ],
    note: [
        ['path', { d: 'M5 4h14v10.5L14.5 19H5zM14 19v-4.5h5M8.5 8.5h7M8.5 12h4' }],
    ],
    restore: [
        ['path', { d: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4.5H8' }],
    ],
    purge: [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['path', { d: 'M9 9l6 6M15 9l-6 6' }],
    ],
    chevronDown: [
        ['path', { d: 'M6 9l6 6 6-6' }],
    ],
    arrowUp: [
        ['path', { d: 'M12 19V5M6 11l6-6 6 6' }],
    ],
    arrowDown: [
        ['path', { d: 'M12 5v14M6 13l6 6 6-6' }],
    ],
    sort: [
        ['path', { d: 'M8 5v14M4.5 8.5L8 5l3.5 3.5M16 19V5M12.5 15.5L16 19l3.5-3.5' }],
    ],
    table: [
        ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
        ['path', { d: 'M3 9.5h18M3 14.8h18M10 9.5V20' }],
    ],
    chart: [
        ['path', { d: 'M4 4v16h16M7.5 15l4-4.5 3 3L20 7' }],
    ],
    refresh: [
        ['path', { d: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5' }],
    ],
    close: [
        ['path', { d: 'M6 6l12 12M18 6L6 18' }],
    ],
    filter: [
        ['path', { d: 'M4 5h16l-6.2 7.2V18l-3.6 2v-7.8z' }],
    ],
    arrowRight: [
        ['path', { d: 'M5 12h14M13 6l6 6-6 6' }],
    ],
    pause: [
        ['path', { d: 'M9 5.5v13M15 5.5v13' }],
    ],
    play: [
        ['path', { d: 'M7.5 5.5l11 6.5-11 6.5z', fill: true }],
    ],
    clock: [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['path', { d: 'M12 7v5l3 2' }],
    ],
};

/** Every icon name, for tests and for callers that pick one by key. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Build an icon.
 * @param {string} name a key of ICONS
 * @param {{ className?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { className = '' } = {}) {
    const shapes = ICONS[name];
    if (!shapes) throw new Error(`Unknown icon: ${name}`);
    const root = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
        class: `icon icon-${name} ${className}`.trim(),
        viewBox: '0 0 24 24',
        width: '16',
        height: '16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        focusable: 'false',
    };
    for (const [key, value] of Object.entries(attrs)) root.setAttribute(key, value);
    for (const [tag, shapeAttrs] of shapes) {
        const shape = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(shapeAttrs)) {
            if (key === 'fill') shape.setAttribute('fill', 'currentColor');
            else shape.setAttribute(key, String(value));
        }
        root.append(shape);
    }
    return root;
}
