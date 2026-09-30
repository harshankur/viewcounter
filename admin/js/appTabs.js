/**
 * The app tabs: one per app, led by one for every app together. Overview,
 * Views, and Trash each show a strip, and all three follow the same choice:
 * switching in one switches the others.
 *
 * ARIA tabs pattern with automatic activation: arrow keys, Home and End move
 * and select.
 */

import { el, replaceChildren } from './dom.js';
import { formatNumber } from './format.js';
import { t } from './i18n.js';
import { ALL_APPS, KEY } from './constants.js';

/**
 * Every app, led by one entry for all of them together.
 * @param {object[]} apps as GET api/apps lists them
 */
export function appEntries(apps) {
    const sum = (key) => apps.reduce((total, app) => total + app[key], 0);
    return [
        {
            appId: ALL_APPS,
            label: t('appTabs.all'),
            active: sum('active'),
            deleted: sum('deleted'),
            modified: sum('modified'),
            available: true,
        },
        ...apps.map((app) => ({ ...app, label: app.appId })),
    ];
}

/**
 * @param {{ context: { apps: () => object[], appId: () => string, setAppId: (id: string) => void },
 *   controls: string, trash?: boolean }} options controls is the id of the region the tabs switch
 * @returns {{ element: HTMLElement, render: () => void }}
 */
export function createAppTabs({ context, controls, trash = false }) {
    const element = el('div', {
        className: 'app-tabs',
        attrs: { role: 'tablist', 'aria-label': t('appTabs.label') },
    });
    let focusOnRender = false;

    function select(appId, { focus = false } = {}) {
        focusOnRender = focus;
        if (appId === context.appId()) {
            render();
            return;
        }
        context.setAppId(appId);
    }

    function render() {
        const current = context.appId();
        replaceChildren(element, appEntries(context.apps()).map((app) => {
            const selected = app.appId === current;
            const count = trash ? app.deleted : app.active;
            const countText = t(trash ? 'appTabs.deletedCount' : 'appTabs.activeCount', { count });
            return el('button', {
                className: `app-tab${selected ? ' active' : ''}${app.available ? '' : ' unavailable'}`,
                attrs: {
                    type: 'button',
                    role: 'tab',
                    'aria-selected': String(selected),
                    'aria-controls': controls,
                    'aria-label': t('appTabs.tabName', { app: app.label, count: countText }),
                    tabindex: selected ? '0' : '-1',
                    title: app.available ? null : t('appTabs.unavailable', { app: app.appId }),
                },
                dataset: { appId: app.appId },
                on: { click: () => select(app.appId) },
            }, [
                el('span', { className: 'app-tab-name', text: app.label }),
                el('span', { className: 'app-tab-count', text: formatNumber(count), attrs: { 'aria-hidden': 'true' } }),
            ]);
        }));
        if (focusOnRender) {
            element.querySelector('[aria-selected="true"]')?.focus();
            focusOnRender = false;
        }
    }

    element.addEventListener('keydown', (event) => {
        const ids = appEntries(context.apps()).map((app) => app.appId);
        const index = Math.max(0, ids.indexOf(context.appId()));
        const moves = {
            [KEY.ARROW_RIGHT]: (index + 1) % ids.length,
            [KEY.ARROW_LEFT]: (index - 1 + ids.length) % ids.length,
            [KEY.HOME]: 0,
            [KEY.END]: ids.length - 1,
        };
        if (!(event.key in moves)) return;
        event.preventDefault();
        select(ids[moves[event.key]], { focus: true });
    });

    return { element, render };
}
