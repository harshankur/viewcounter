/**
 * Clamped text with its full value on hover (FRONTEND.md §14).
 *
 * Clamp and tooltip ship as one unit so they cannot drift apart: call sites
 * pass text and a line count, and the tooltip appears only when the rendered
 * box is actually truncated, re-measured whenever the box resizes.
 */

import { el } from './dom.js';
import { CLAMP_LINES } from './constants.js';

const observed = new WeakSet();
const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) updateTitle(entry.target);
});

function isTruncated(node) {
    return node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
}

function updateTitle(node) {
    if (isTruncated(node)) node.setAttribute('title', node.textContent);
    else node.removeAttribute('title');
}

/**
 * @param {string} text
 * @param {{ lines?: number, className?: string }} [options]
 * @returns {HTMLElement}
 */
export function clampText(text, { lines = CLAMP_LINES.SINGLE, className = '' } = {}) {
    const node = el('span', {
        className: `clamp clamp-${lines} ${className}`.trim(),
        text,
    });
    if (!observed.has(node)) {
        observed.add(node);
        resizeObserver.observe(node);
    }
    return node;
}
