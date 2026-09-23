/**
 * A select replacement (FRONTEND.md §0, §7): a button that opens a listbox the
 * page renders itself, so it can be styled and behaves identically on every
 * machine.
 *
 * ARIA listbox pattern: the button has aria-haspopup/aria-expanded; the
 * options carry role=option and aria-selected; the active option is announced
 * through aria-activedescendant. Keyboard: ArrowUp/ArrowDown move, Home/End
 * jump, Enter/Space commit, Escape and Tab close.
 */

import { el, clear, uniqueId } from './dom.js';
import { KEY } from './constants.js';

/**
 * @param {{ label: string, options: Array<{value: string, label: string}>, value?: string,
 *   onChange?: (value: string) => void, className?: string }} config
 * @returns {{ element: HTMLElement, getValue: () => string, setValue: (value: string) => void,
 *   setOptions: (options: Array<{value: string, label: string}>, value?: string) => void }}
 */
export function createListbox({ label, options, value, onChange = () => {}, className = '' }) {
    const listId = uniqueId('listbox');
    let items = options;
    let selected = value ?? options[0]?.value;
    let activeIndex = -1;

    const valueText = el('span', { className: 'listbox-value' });
    const button = el('button', {
        className: 'listbox-button',
        attrs: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label },
    }, [valueText, el('span', { className: 'listbox-caret', text: '▾', attrs: { 'aria-hidden': 'true' } })]);

    const list = el('ul', {
        className: 'listbox-popup',
        attrs: { role: 'listbox', id: listId, tabindex: '-1', 'aria-label': label },
    });
    list.hidden = true;
    button.setAttribute('aria-controls', listId);

    const wrapper = el('div', { className: `listbox ${className}`.trim() }, [button, list]);

    const labelOf = (v) => items.find((item) => item.value === v)?.label ?? '';

    function render() {
        valueText.textContent = labelOf(selected);
        clear(list);
        items.forEach((item, index) => {
            const isSelected = item.value === selected;
            list.append(el('li', {
                className: `listbox-option${index === activeIndex ? ' active' : ''}`,
                text: item.label,
                attrs: { role: 'option', id: `${listId}-${index}`, 'aria-selected': String(isSelected) },
                on: {
                    mousedown: (event) => event.preventDefault(),
                    click: () => commit(index),
                },
            }));
        });
        if (activeIndex >= 0) list.setAttribute('aria-activedescendant', `${listId}-${activeIndex}`);
        else list.removeAttribute('aria-activedescendant');
    }

    function isOpen() {
        return !list.hidden;
    }

    function open() {
        if (isOpen()) return;
        activeIndex = Math.max(0, items.findIndex((item) => item.value === selected));
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        render();
        list.focus();
        list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
        document.addEventListener('mousedown', onOutside, true);
    }

    function close({ refocus = true } = {}) {
        if (!isOpen()) return;
        list.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
        document.removeEventListener('mousedown', onOutside, true);
        if (refocus) button.focus();
    }

    function commit(index) {
        const item = items[index];
        if (!item) return;
        const changed = item.value !== selected;
        selected = item.value;
        close();
        render();
        if (changed) onChange(selected);
    }

    function move(index) {
        activeIndex = Math.min(Math.max(index, 0), items.length - 1);
        render();
        list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }

    function onOutside(event) {
        if (!wrapper.contains(event.target)) close({ refocus: false });
    }

    button.addEventListener('click', () => (isOpen() ? close() : open()));
    button.addEventListener('keydown', (event) => {
        if (event.key === KEY.ARROW_DOWN || event.key === KEY.ARROW_UP) {
            event.preventDefault();
            open();
        }
    });

    list.addEventListener('keydown', (event) => {
        switch (event.key) {
            case KEY.ARROW_DOWN: event.preventDefault(); move(activeIndex + 1); break;
            case KEY.ARROW_UP: event.preventDefault(); move(activeIndex - 1); break;
            case KEY.HOME: event.preventDefault(); move(0); break;
            case KEY.END: event.preventDefault(); move(items.length - 1); break;
            case KEY.ENTER:
            case KEY.SPACE: event.preventDefault(); commit(activeIndex); break;
            case KEY.ESCAPE: event.preventDefault(); event.stopPropagation(); close(); break;
            case KEY.TAB: close({ refocus: false }); break;
            default: break;
        }
    });

    render();

    return {
        element: wrapper,
        getValue: () => selected,
        setValue(next) {
            selected = next;
            render();
        },
        setOptions(nextOptions, nextValue) {
            items = nextOptions;
            selected = nextValue ?? (items.some((item) => item.value === selected) ? selected : items[0]?.value);
            render();
        },
    };
}
