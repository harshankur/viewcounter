/**
 * Static contract checks on the admin UI source.
 *
 *  - i18n key parity (FRONTEND.md §8): every key the UI uses exists, every
 *    dynamic key family is complete for the server's enums, no value is empty,
 *    and every locale has exactly the base locale's key set.
 *  - FRONTEND.md §0/§3: no native popups or OS-drawn controls, by grep over
 *    the markup and script (ESLint covers the script as well).
 *  - The UI's copies of wire-contract constants match the server's.
 */

const fs = require('fs');
const path = require('path');

const {
    ADMIN,
    ADMIN_ACTION,
    ADMIN_ERROR_CODE,
    APP_NAME,
    APP_SLUG,
    EDITABLE_FIELDS,
    MODIFIED_FILTER,
    SORT_ORDER,
    SOURCE_TYPE,
    VIEW_LOG_SOURCE,
    VIEW_STATUS,
} = require('../constants');

const UI_DIR = path.join(__dirname, '..', 'admin');
const LOCALE_DIR = path.join(UI_DIR, 'locales');
const BASE_LOCALE = 'en';

function filesUnder(dir, extension) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full, extension);
        return entry.name.endsWith(extension) ? [full] : [];
    });
}

const scripts = filesUnder(path.join(UI_DIR, 'js'), '.js').map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
const markup = filesUnder(UI_DIR, '.html').map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
const locales = Object.fromEntries(fs.readdirSync(LOCALE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [path.basename(name, '.json'), JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, name), 'utf8'))]));
const base = locales[BASE_LOCALE];

/** Every leaf path in a locale bundle. */
function leafKeys(node, prefix = '') {
    return Object.entries(node).flatMap(([key, value]) => {
        const full = prefix ? `${prefix}.${key}` : key;
        return value && typeof value === 'object' ? leafKeys(value, full) : [full];
    });
}

function lookup(bundle, key) {
    return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), bundle);
}

/** A key resolves to a message: a string, or a plural object with `other`. */
function resolves(bundle, key) {
    const value = lookup(bundle, key);
    return typeof value === 'string' || (value && typeof value === 'object' && typeof value.other === 'string');
}

/** Literal keys passed to t()/tOr(), and static prefixes of template keys. */
function keysInScripts() {
    const literal = new Set();
    const prefixes = new Set();
    for (const { text } of scripts) {
        for (const match of text.matchAll(/\bt(?:Or)?\(\s*'([\w.]+)'/g)) literal.add(match[1]);
        for (const match of text.matchAll(/\bt(?:Or)?\(\s*`([\w.]+)\.\$\{/g)) prefixes.add(match[1]);
        for (const match of text.matchAll(/(?:successKey|['"])(toasts\.\w+)['"]/g)) literal.add(match[1]);
        for (const match of text.matchAll(/showLogin\(\s*'([\w.]+)'/g)) literal.add(match[1]);
        for (const match of text.matchAll(/emptyKey:\s*'([\w.]+)'/g)) literal.add(match[1]);
        for (const match of text.matchAll(/batchButton\(\s*'([\w.]+)'/g)) literal.add(match[1]);
        for (const match of text.matchAll(/actionButton\([^,]+,\s*'([\w.]+)'/g)) literal.add(match[1]);
        for (const match of text.matchAll(/badge\(\s*'([\w.]+)'/g)) literal.add(match[1]);
    }
    return { literal, prefixes };
}

function keysInMarkup() {
    const keys = new Set();
    for (const { text } of markup) {
        for (const match of text.matchAll(/data-i18n="([\w.]+)"/g)) keys.add(match[1]);
        for (const match of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
            for (const pair of match[1].split(';')) keys.add(pair.split(':')[1].trim());
        }
    }
    return keys;
}

describe('admin UI translations', () => {
    const { literal, prefixes } = keysInScripts();
    const markupKeys = keysInMarkup();

    test('the scan found the keys it should (it is not silently matching nothing)', () => {
        expect(literal.size).toBeGreaterThan(50);
        expect(markupKeys.size).toBeGreaterThan(10);
        expect(prefixes.has('fields')).toBe(true);
    });

    test('every literal key used in script exists in the base locale', () => {
        const missing = [...literal].filter((key) => !resolves(base, key));
        expect(missing).toEqual([]);
    });

    test('every key used in markup exists in the base locale', () => {
        const missing = [...markupKeys].filter((key) => !resolves(base, key));
        expect(missing).toEqual([]);
    });

    test('every dynamic key family used in script exists', () => {
        const missing = [...prefixes].filter((prefix) => typeof lookup(base, prefix) !== 'object');
        expect(missing).toEqual([]);
    });

    test.each([
        ['errors', [...Object.values(ADMIN_ERROR_CODE), 'NETWORK']],
        ['actions', Object.values(ADMIN_ACTION)],
        ['logSources', Object.values(VIEW_LOG_SOURCE)],
        ['sources', Object.values(SOURCE_TYPE)],
        ['modifiedFilter', Object.values(MODIFIED_FILTER)],
        ['fields', Object.keys(EDITABLE_FIELDS)],
        ['tabs', ['views', 'trash', 'adminLog', 'viewLog']],
        ['deviceSizes', ['small', 'medium', 'large']],
        ['columns', ['timestamp', 'app', 'page', 'source', 'device', 'country', 'client', 'event', 'status', 'actions']],
        ['ranges', ['7d', '30d', '90d', '1y', 'all']],
        ['insights.breakdown', ['source', 'deviceSize', 'browser', 'os', 'eventType', 'app']],
    ])('the %s family covers every value the server can send', (family, values) => {
        const missing = values.filter((value) => !resolves(base, `${family}.${value}`));
        expect(missing).toEqual([]);
    });

    test('every success toast has the partial variant the UI derives from it', () => {
        const toasts = [...literal].filter((key) => key.startsWith('toasts.'));
        expect(toasts.length).toBeGreaterThan(4);
        expect(toasts.filter((key) => !resolves(base, `${key}Partial`))).toEqual([]);
    });

    test('every field in the details dialog has a label', () => {
        const constants = scripts.find(({ file }) => file.endsWith('constants.js')).text;
        const list = constants.match(/VIEW_DETAIL_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
        const fields = [...list.matchAll(/'(\w+)'/g)].map((match) => match[1]);
        expect(fields.length).toBeGreaterThan(15);
        expect(fields.filter((field) => !resolves(base, `fields.${field}`))).toEqual([]);
    });

    test('no value in any locale is empty', () => {
        for (const [code, bundle] of Object.entries(locales)) {
            const empty = leafKeys(bundle).filter((key) => String(lookup(bundle, key)).trim() === '');
            expect({ code, empty }).toEqual({ code, empty: [] });
        }
    });

    test('every locale has exactly the base locale key set', () => {
        const expected = leafKeys(base).sort();
        for (const [code, bundle] of Object.entries(locales)) {
            expect({ code, keys: leafKeys(bundle).sort() }).toEqual({ code, keys: expected });
        }
    });

    test('no user-visible string is hard-coded into markup text', () => {
        for (const { file, text } of markup) {
            const body = text.slice(text.indexOf('<body'));
            const withoutTags = body
                .replace(/<svg[\s\S]*?<\/svg>/g, '')
                .replace(/<script[\s\S]*?<\/script>/g, '')
                .replace(/<[^>]+>/g, '\n');
            const words = withoutTags.split('\n').map((line) => line.trim())
                .filter((line) => /[A-Za-z]{2,}/.test(line));
            expect({ file: path.basename(file), words }).toEqual({ file: path.basename(file), words: [] });
        }
    });
});

describe('admin UI uses no native popups or OS-drawn controls', () => {
    const forbidden = [
        ['a native select', /<select\b/i],
        ['a native date or time picker', /<input[^>]+type=["']?(date|datetime-local|time|month|week)\b/i],
        ['a native colour picker', /<input[^>]+type=["']?color\b/i],
        ['window.open', /\bwindow\.open\s*\(/],
        ['alert()', /(^|[^.\w])alert\s*\(/],
        ['confirm()', /(^|[^.\w])confirm\s*\(/],
        ['prompt()', /(^|[^.\w])prompt\s*\(/],
        ['HTML parsing', /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|createContextualFragment/],
    ];

    for (const [label, pattern] of forbidden) {
        test(`no ${label}`, () => {
            const hits = [...scripts, ...markup].filter(({ text }) => pattern.test(text)).map(({ file }) => path.basename(file));
            expect(hits).toEqual([]);
        });
    }
});

describe('admin UI wire constants match the server', () => {
    const constants = scripts.find(({ file }) => file.endsWith('constants.js')).text;
    const stringConst = (name) => constants.match(new RegExp(`export const ${name} = '([^']+)'`))[1];
    const frozenValues = (name) => {
        const body = constants.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`))[1];
        return [...body.matchAll(/:\s*'([^']+)'/g)].map((match) => match[1]).sort();
    };

    test('CSRF header', () => expect(stringConst('CSRF_HEADER')).toBe(ADMIN.CSRF_HEADER));
    test('app identity', () => {
        expect(stringConst('APP_NAME')).toBe(APP_NAME);
        expect(stringConst('APP_SLUG')).toBe(APP_SLUG);
    });
    test('error codes are a superset of the server codes', () => {
        expect(frozenValues('ERROR_CODE')).toEqual(expect.arrayContaining(Object.values(ADMIN_ERROR_CODE)));
    });
    test.each([
        ['VIEW_STATUS', VIEW_STATUS],
        ['MODIFIED_FILTER', MODIFIED_FILTER],
        ['SORT_ORDER', SORT_ORDER],
    ])('%s matches', (name, serverEnum) => {
        expect(frozenValues(name)).toEqual(Object.values(serverEnum).sort());
    });
});
