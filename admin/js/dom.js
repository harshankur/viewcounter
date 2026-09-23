/**
 * DOM construction helpers.
 *
 * Every value that came from the database is untrusted: page titles, paths,
 * referrers, and event data are sent by anonymous visitors. This module is the
 * only way the UI builds elements, and it only ever sets text through
 * `textContent` and attributes through `setAttribute`. There is no path here,
 * or anywhere in the UI, that parses a string as HTML; ESLint forbids
 * innerHTML and its relatives under admin/.
 */

/**
 * Create an element.
 * @param {string} tag
 * @param {{ className?: string, text?: string, attrs?: Record<string, string|number|boolean|null|undefined>,
 *   on?: Record<string, EventListener>, dataset?: Record<string, string> }} [options]
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, { className, text, attrs = {}, on = {}, dataset = {} } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === false || value === null || value === undefined) continue;
        node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const [name, value] of Object.entries(dataset)) node.dataset[name] = value;
    for (const [event, handler] of Object.entries(on)) node.addEventListener(event, handler);
    append(node, children);
    return node;
}

/** Append children, turning strings into text nodes and skipping blanks. */
export function append(parent, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return parent;
}

/** Remove every child. */
export function clear(node) {
    while (node.firstChild) node.firstChild.remove();
    return node;
}

/** Replace a node's children in one step. */
export function replaceChildren(node, children) {
    clear(node);
    return append(node, children);
}

/** @returns {HTMLElement} */
export function byId(id) {
    return document.getElementById(id);
}

/** Every focusable element inside `root`, in tab order. */
export function focusableWithin(root) {
    const selector = [
        'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    return [...root.querySelectorAll(selector)].filter((node) => !node.hidden && node.offsetParent !== null);
}

/** Debounce a function by `ms`. */
export function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

let idCounter = 0;
/** A document-unique id for ARIA relationships. */
export function uniqueId(prefix) {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}
