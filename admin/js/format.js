/**
 * Locale-aware formatting (FRONTEND.md §8: dates and numbers are localized
 * too, not only strings).
 */

import { currentLocale, t } from './i18n.js';

/** Intl time styles: with seconds, and without. */
const TIME_STYLE = Object.freeze({ FULL: 'medium', SHORT: 'short' });

function formatParts(value, options) {
    if (value === null || value === undefined || value === '') return t('common.none');
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(currentLocale(), options).format(date);
}

function formatWith(value, timeStyle) {
    return formatParts(value, { dateStyle: 'medium', timeStyle });
}

/** Date and time to the second: logs and the details dialog. */
export function formatDateTime(value) {
    return formatWith(value, TIME_STYLE.FULL);
}

/** The date alone: the first line of a table's time cell. */
export function formatDate(value) {
    return formatParts(value, { dateStyle: 'medium' });
}

/**
 * The time of day alone: the second line of a table's time cell. Logs keep the
 * seconds, since they order events that can be moments apart.
 */
export function formatTime(value, { seconds = false } = {}) {
    return formatParts(value, { timeStyle: seconds ? TIME_STYLE.FULL : TIME_STYLE.SHORT });
}

/** @param {number} value */
export function formatNumber(value) {
    return new Intl.NumberFormat(currentLocale()).format(Number(value) || 0);
}

/** 1,284 stays exact; 12,900 becomes 12.9K. */
export function formatCompact(value) {
    return new Intl.NumberFormat(currentLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

/** A ratio (0..1) as a percentage. */
export function formatPercent(ratio) {
    return new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(Number(ratio) || 0);
}

/**
 * A trend bucket label. Buckets are named by the date they start on
 * (YYYY-MM-DD, from the server) and read as calendar dates, not instants, so
 * they are formatted in UTC to avoid shifting a day across time zones.
 * @param {string} period
 * @param {'day'|'week'|'month'} bucket
 * @param {{ long?: boolean }} [options] long adds the year, and "week of"
 */
export function formatPeriod(period, bucket, { long = false } = {}) {
    const date = new Date(`${period}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return period;
    const locale = currentLocale();
    if (bucket === 'month') {
        return new Intl.DateTimeFormat(locale, { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
    }
    const day = new Intl.DateTimeFormat(locale, {
        day: 'numeric', month: 'short', ...(long ? { year: 'numeric' } : {}), timeZone: 'UTC',
    }).format(date);
    return bucket === 'week' && long ? t('insights.weekOf', { date: day }) : day;
}

/** A value for display, with a translated placeholder for empty. */
export function orNone(value) {
    return value === null || value === undefined || value === '' ? t('common.none') : String(value);
}
