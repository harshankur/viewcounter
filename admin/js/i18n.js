/**
 * Translation layer (FRONTEND.md §8).
 *
 * Every user-visible string is a key resolved here. One locale ships today;
 * adding another is a new file in locales/ with the same key set, which
 * tests/adminUiContract.test.js enforces.
 *
 * Keys are dotted paths into the locale JSON. `{name}` placeholders are
 * interpolated. When params include `count` and the key names an object with
 * plural categories (`one`, `other`, ...), the category is chosen with
 * Intl.PluralRules for the active locale.
 */

import { DEFAULT_LOCALE } from './constants.js';

let messages = {};
let locale = DEFAULT_LOCALE;
let pluralRules = new Intl.PluralRules(DEFAULT_LOCALE);

/** Load a locale bundle. Called once at startup. */
export async function loadLocale(code = DEFAULT_LOCALE) {
    const response = await fetch(`locales/${code}.json`, { credentials: 'same-origin' });
    messages = await response.json();
    locale = code;
    pluralRules = new Intl.PluralRules(code);
    document.documentElement.lang = code;
}

export function currentLocale() {
    return locale;
}

function lookup(key) {
    return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), messages);
}

/**
 * Resolve a key.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string} the translation, or the key itself if missing, so a gap
 *   is visible on screen rather than silently blank
 */
export function t(key, params = {}) {
    let entry = lookup(key);
    if (entry && typeof entry === 'object' && typeof params.count === 'number') {
        entry = entry[pluralRules.select(params.count)] ?? entry.other;
    }
    if (typeof entry !== 'string') return key;
    return entry.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * Resolve a key that may legitimately be absent, such as a device size or
 * source type defined in the server's config rather than in this bundle, and
 * fall back to the raw value instead of showing the key.
 * @param {string} key
 * @param {string} fallback
 */
export function tOr(key, fallback, params = {}) {
    const result = t(key, params);
    return result === key ? fallback : result;
}

/**
 * Translate static markup: `data-i18n` sets text, `data-i18n-attr` sets
 * attributes as `attr:key;attr:key`.
 * @param {ParentNode} root
 */
export function applyTranslations(root = document) {
    for (const node of root.querySelectorAll('[data-i18n]')) {
        node.textContent = t(node.dataset.i18n);
    }
    for (const node of root.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of node.dataset.i18nAttr.split(';')) {
            const [attr, key] = pair.split(':').map((part) => part.trim());
            if (attr && key) node.setAttribute(attr, t(key));
        }
    }
}
