/**
 * Light / dark / system theme (FRONTEND.md §6).
 *
 * All colours are tokens on :root; the theme is a class on <html>, so
 * switching it re-themes everything without per-component branching. The
 * choice is a per-viewer convenience kept in localStorage, which may be
 * unavailable (private mode, blocked storage); the UI works without it.
 */

import { STORAGE_KEY, THEME } from './constants.js';

const CLASS = {
    [THEME.LIGHT]: 'theme-light',
    [THEME.DARK]: 'theme-dark',
};

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let current = THEME.AUTO;
const buttons = new Map();

function readStored() {
    try {
        const value = localStorage.getItem(STORAGE_KEY.THEME);
        return Object.values(THEME).includes(value) ? value : THEME.AUTO;
    } catch {
        return THEME.AUTO;
    }
}

function store(value) {
    try {
        localStorage.setItem(STORAGE_KEY.THEME, value);
    } catch {
        // Storage blocked: the theme still applies for this page view.
    }
}

function resolved() {
    if (current !== THEME.AUTO) return current;
    return darkQuery.matches ? THEME.DARK : THEME.LIGHT;
}

function apply() {
    const root = document.documentElement;
    root.classList.remove(...Object.values(CLASS));
    root.classList.add(CLASS[resolved()]);
    for (const [value, button] of buttons) {
        const active = value === current;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    }
}

export function setTheme(value) {
    current = Object.values(THEME).includes(value) ? value : THEME.AUTO;
    store(current);
    apply();
}

/**
 * Wire the switcher buttons and apply the stored theme.
 * @param {Record<string, HTMLButtonElement>} themeButtons keyed by THEME value
 */
export function initTheme(themeButtons) {
    for (const [value, button] of Object.entries(themeButtons)) {
        buttons.set(value, button);
        button.addEventListener('click', () => setTheme(value));
    }
    current = readStored();
    darkQuery.addEventListener('change', apply);
    apply();
}
