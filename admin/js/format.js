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

/** A number with at most `digits` decimals: 1.75 pages per visit reads 1.8. */
export function formatDecimal(value, digits = 1) {
    return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: digits }).format(Number(value) || 0);
}

function unit(value, name) {
    return new Intl.NumberFormat(currentLocale(), { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
}

/**
 * A duration, to the second below an hour: 45s, 3m 20s, 1h 5m. Empty
 * (never measured) shows the placeholder rather than a misleading 0s.
 * @param {number|null} ms
 */
export function formatDuration(ms) {
    if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return t('common.none');
    const seconds = Math.round(Number(ms) / 1000);
    if (seconds < 60) return unit(seconds, 'second');
    if (seconds < 3600) {
        const rest = seconds % 60;
        return rest ? `${unit(Math.floor(seconds / 60), 'minute')} ${unit(rest, 'second')}` : unit(seconds / 60, 'minute');
    }
    const minutes = Math.floor((seconds % 3600) / 60);
    const hours = Math.floor(seconds / 3600);
    return minutes ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
}

/**
 * When a trend bucket starts. Day, week, and month buckets are named by their
 * date (YYYY-MM-DD) and read as calendar dates at UTC midnight; hour buckets
 * ("YYYY-MM-DD HH:00") are instants in the server's clock, which is UTC.
 * @param {string} period
 * @param {'hour'|'day'|'week'|'month'} bucket
 * @returns {Date}
 */
export function periodStart(period, bucket) {
    return bucket === 'hour'
        ? new Date(`${String(period).replace(' ', 'T')}:00Z`)
        : new Date(`${period}T00:00:00Z`);
}

/**
 * A trend bucket label. Calendar buckets are formatted in UTC so a day never
 * shifts across time zones; an hour is an instant, shown in local time.
 * @param {string} period
 * @param {'hour'|'day'|'week'|'month'} bucket
 * @param {{ long?: boolean }} [options] long adds the date to an hour, the year
 *   to a day, and "week of" to a week
 */
export function formatPeriod(period, bucket, { long = false } = {}) {
    const date = periodStart(period, bucket);
    if (Number.isNaN(date.getTime())) return period;
    const locale = currentLocale();
    if (bucket === 'hour') {
        return new Intl.DateTimeFormat(locale, {
            ...(long ? { day: 'numeric', month: 'short' } : {}), hour: 'numeric', minute: '2-digit',
        }).format(date);
    }
    if (bucket === 'month') {
        return new Intl.DateTimeFormat(locale, { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
    }
    const day = new Intl.DateTimeFormat(locale, {
        day: 'numeric', month: 'short', ...(long ? { year: 'numeric' } : {}), timeZone: 'UTC',
    }).format(date);
    return bucket === 'week' && long ? t('charts.weekOf', { date: day }) : day;
}

/** A value for display, with a translated placeholder for empty. */
export function orNone(value) {
    return value === null || value === undefined || value === '' ? t('common.none') : String(value);
}
