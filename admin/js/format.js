/**
 * Locale-aware formatting (FRONTEND.md §8: dates and numbers are localized
 * too, not only strings).
 */

import { currentLocale, t } from './i18n.js';

/** Intl time styles: with seconds, and without. */
const TIME_STYLE = Object.freeze({ FULL: 'medium', SHORT: 'short' });

function formatWith(value, timeStyle) {
    if (value === null || value === undefined || value === '') return t('common.none');
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle }).format(date);
}

/** Date and time to the second: logs and the details dialog. */
export function formatDateTime(value) {
    return formatWith(value, TIME_STYLE.FULL);
}

/** Without seconds, so a timestamp fits a views-table cell. */
export function formatDateTimeShort(value) {
    return formatWith(value, TIME_STYLE.SHORT);
}

/** @param {number} value */
export function formatNumber(value) {
    return new Intl.NumberFormat(currentLocale()).format(Number(value) || 0);
}

/** A value for display, with a translated placeholder for empty. */
export function orNone(value) {
    return value === null || value === undefined || value === '' ? t('common.none') : String(value);
}
