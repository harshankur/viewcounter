/**
 * Dialogs for one or many views: details, edit, and note.
 */

import { el, uniqueId } from './dom.js';
import { openModal, VARIANT } from './modal.js';
import { createListbox } from './listbox.js';
import { formatDateTime, orNone } from './format.js';
import { t, tOr } from './i18n.js';
import {
    DEVICE_SIZE_FIELD,
    EVENT_DATA_FIELD,
    EVENT_DATA_ROWS,
    JSON_INDENT,
    NOTE_ROWS,
    TEXT_FIELDS,
    VIEW_DETAIL_FIELDS,
} from './constants.js';

const DATE_FIELDS = new Set(['timestamp', 'adminModifiedAt', 'deletedAt']);

/** Render one field of a view for reading. */
function displayValue(field, value) {
    if (DATE_FIELDS.has(field)) return formatDateTime(value);
    if (field === 'isUnique') return value ? t('common.yes') : t('common.no');
    if (field === 'sourceType' && value) return tOr(`sources.${value}`, value);
    if (field === EVENT_DATA_FIELD) return value === null || value === undefined ? t('common.none') : JSON.stringify(value, null, JSON_INDENT);
    return orNone(value);
}

/** Read-only view of every field. */
export function openDetails(view) {
    const list = el('dl', { className: 'detail-list' });
    for (const field of VIEW_DETAIL_FIELDS) {
        const value = displayValue(field, view[field]);
        const valueNode = field === EVENT_DATA_FIELD
            ? el('pre', { className: 'detail-json', text: value })
            : el('span', { className: 'detail-value', text: value });
        list.append(el('dt', { text: t(`fields.${field}`) }), el('dd', {}, [valueNode]));
    }
    openModal({
        title: t('details.title'),
        body: list,
        actions: [{ label: t('common.close'), variant: VARIANT.SECONDARY }],
        wide: true,
    });
}

/**
 * Edit content fields of one or many views.
 *
 * With one view the fields start from its values and a field is included as
 * soon as it is changed. With several, fields start empty and the admin ticks
 * the ones to overwrite, so a batch never touches a field by accident.
 *
 * @param {{ views: object[], meta: object, onSubmit: (changes: object) => Promise<boolean> }} options
 */
export function openEditor({ views, meta, onSubmit }) {
    const single = views.length === 1 ? views[0] : null;
    const rows = [];
    const controls = new Map();

    for (const field of meta.editableFields) {
        const inputId = uniqueId(`edit-${field}`);
        const include = el('input', {
            className: 'field-include',
            attrs: { type: 'checkbox', 'aria-label': t('edit.include', { field: t(`fields.${field}`) }) },
        });
        const markIncluded = () => { include.checked = true; };

        let control;
        let read;
        if (field === DEVICE_SIZE_FIELD) {
            const listbox = createListbox({
                label: t(`fields.${field}`),
                options: meta.deviceSizes.map((size) => ({ value: size, label: tOr(`deviceSizes.${size}`, size) })),
                value: single?.deviceSize ?? meta.deviceSizes[0],
                onChange: markIncluded,
            });
            control = listbox.element;
            read = () => ({ ok: true, value: listbox.getValue() });
        } else if (field === EVENT_DATA_FIELD) {
            const initial = single?.eventData === null || single?.eventData === undefined
                ? '' : JSON.stringify(single.eventData, null, JSON_INDENT);
            const textarea = el('textarea', {
                className: 'input mono',
                text: initial,
                attrs: { id: inputId, rows: EVENT_DATA_ROWS, spellcheck: 'false' },
                on: { input: markIncluded },
            });
            control = textarea;
            read = () => {
                const text = textarea.value.trim();
                if (text === '') return { ok: true, value: null };
                try {
                    return { ok: true, value: JSON.parse(text) };
                } catch {
                    return { ok: false, error: t('edit.invalidJson') };
                }
            };
        } else if (TEXT_FIELDS.includes(field)) {
            const input = el('input', {
                className: 'input',
                attrs: {
                    id: inputId,
                    type: 'text',
                    maxlength: meta.maxLength[field],
                    value: single ? (single[field] ?? '') : '',
                    spellcheck: 'false',
                },
                on: { input: markIncluded },
            });
            control = input;
            read = () => ({ ok: true, value: input.value === '' ? null : input.value });
        } else {
            continue;
        }

        const error = el('p', { className: 'field-error', attrs: { role: 'alert' } });
        error.hidden = true;
        controls.set(field, { include, read, error });
        rows.push(el('div', { className: 'edit-row' }, [
            include,
            el('label', { className: 'edit-label', text: t(`fields.${field}`), attrs: { for: inputId } }),
            el('div', { className: 'edit-control' }, [control, error]),
        ]));
    }

    const formError = el('p', { className: 'field-error', attrs: { role: 'alert' } });
    formError.hidden = true;

    const body = [
        el('p', { className: 'modal-message', text: single ? t('edit.introSingle') : t('edit.introBatch', { count: views.length }) }),
        el('p', { className: 'notice', text: t('edit.lockedNotice') }),
        el('div', { className: 'edit-grid' }, rows),
        formError,
    ];

    openModal({
        title: single ? t('edit.titleSingle') : t('edit.titleBatch', { count: views.length }),
        body,
        wide: true,
        actions: [
            { label: t('common.cancel'), variant: VARIANT.SECONDARY },
            {
                label: t('edit.save'),
                variant: VARIANT.PRIMARY,
                onClick: async () => {
                    const changes = {};
                    let valid = true;
                    for (const [field, { include, read, error }] of controls) {
                        error.hidden = true;
                        if (!include.checked) continue;
                        const result = read();
                        if (!result.ok) {
                            error.textContent = result.error;
                            error.hidden = false;
                            valid = false;
                        } else {
                            changes[field] = result.value;
                        }
                    }
                    formError.hidden = true;
                    if (!valid) return false;
                    if (Object.keys(changes).length === 0) {
                        formError.textContent = t('edit.nothingSelected');
                        formError.hidden = false;
                        return false;
                    }
                    return onSubmit(changes);
                },
            },
        ],
    });
}

/**
 * Set or clear the note on one or many views.
 * @param {{ views: object[], meta: object, onSubmit: (note: string|null) => Promise<boolean> }} options
 */
export function openNoteEditor({ views, meta, onSubmit }) {
    const single = views.length === 1 ? views[0] : null;
    const inputId = uniqueId('note');
    const textarea = el('textarea', {
        className: 'input',
        text: single?.note ?? '',
        attrs: { id: inputId, rows: NOTE_ROWS, maxlength: meta.maxLength.note },
    });

    openModal({
        title: single ? t('note.titleSingle') : t('note.titleBatch', { count: views.length }),
        body: [
            el('p', { className: 'modal-message', text: t('note.intro') }),
            el('label', { className: 'sr-only', text: t('fields.note'), attrs: { for: inputId } }),
            textarea,
        ],
        initialFocus: textarea,
        actions: [
            { label: t('common.cancel'), variant: VARIANT.SECONDARY },
            { label: t('note.clear'), variant: VARIANT.SECONDARY, onClick: () => onSubmit(null) },
            {
                label: t('note.save'),
                variant: VARIANT.PRIMARY,
                onClick: () => onSubmit(textarea.value.trim() === '' ? null : textarea.value),
            },
        ],
    });
}
