/**
 * Admin UI entry point: session check, login, tabs, and wiring.
 */

import { api, ApiError, onUnauthenticated, setCsrfToken } from './api.js';
import { byId, el, replaceChildren } from './dom.js';
import { applyTranslations, loadLocale, t } from './i18n.js';
import { createAdminLogPanel, createViewLogPanel } from './logs.js';
import { closeModal } from './modal.js';
import { initTheme } from './theme.js';
import { showToast, TOAST_TYPE } from './toast.js';
import { createViewsPanel, PANEL_MODE } from './views.js';
import { ERROR_CODE, KEY, STORAGE_KEY, TAB, THEME } from './constants.js';

const TAB_ORDER = [TAB.VIEWS, TAB.TRASH, TAB.ADMIN_LOG, TAB.VIEW_LOG];

const shell = {
    meta: null,
    apps: [],
    appId: null,
    panels: new Map(),
    activeTab: TAB.VIEWS,
    tabButtons: new Map(),
};

/** Translate any failure into a message and show it. */
function reportError(error) {
    const code = error instanceof ApiError ? error.code : ERROR_CODE.SERVER_ERROR;
    if (code === ERROR_CODE.UNAUTHENTICATED) return;
    showToast(t(`errors.${code}`), TOAST_TYPE.ERROR);
}

function readLastApp() {
    try {
        return localStorage.getItem(STORAGE_KEY.LAST_APP);
    } catch {
        return null;
    }
}

function rememberApp(appId) {
    try {
        localStorage.setItem(STORAGE_KEY.LAST_APP, appId);
    } catch {
        // Storage blocked: the choice simply is not remembered.
    }
}

// ---- Login ------------------------------------------------------------------

function showLogin(messageKey) {
    closeModal();
    byId('app-screen').hidden = true;
    byId('logout-btn').hidden = true;
    byId('login-screen').hidden = false;
    const error = byId('login-error');
    error.hidden = !messageKey;
    error.textContent = messageKey ? t(messageKey) : '';
    const input = byId('login-password');
    input.value = '';
    input.focus();
}

function wireLogin() {
    const form = byId('login-form');
    const submit = byId('login-submit');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const password = byId('login-password').value;
        if (!password) return;
        submit.disabled = true;
        try {
            const session = await api.login(password);
            setCsrfToken(session.csrfToken);
            await enterApp();
        } catch (error) {
            const code = error instanceof ApiError ? error.code : ERROR_CODE.SERVER_ERROR;
            showLogin(`errors.${code}`);
        } finally {
            submit.disabled = false;
        }
    });
}

// ---- App shell --------------------------------------------------------------

async function refreshApps() {
    const { apps } = await api.apps();
    shell.apps = apps;
    for (const panel of shell.panels.values()) panel.syncApps?.();
}

function setAppId(appId) {
    shell.appId = appId;
    rememberApp(appId);
    for (const tab of [TAB.VIEWS, TAB.TRASH]) {
        const panel = shell.panels.get(tab);
        panel.syncApps();
        panel.reload();
    }
}

function selectTab(tab, { focus = false } = {}) {
    shell.activeTab = TAB_ORDER.includes(tab) ? tab : TAB.VIEWS;
    for (const [key, button] of shell.tabButtons) {
        const active = key === shell.activeTab;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        button.classList.toggle('active', active);
        if (active && focus) button.focus();
    }
    for (const [key, panel] of shell.panels) panel.element.hidden = key !== shell.activeTab;

    const panel = shell.panels.get(shell.activeTab);
    if (shell.activeTab === TAB.ADMIN_LOG || shell.activeTab === TAB.VIEW_LOG) panel.load();
    else panel.refresh();

    if (window.location.hash !== `#${shell.activeTab}`) {
        history.replaceState(null, '', `#${shell.activeTab}`);
    }
}

function buildTabs() {
    const tablist = byId('tabs');
    const buttons = TAB_ORDER.map((tab) => {
        const button = el('button', {
            className: 'tab',
            attrs: { type: 'button', role: 'tab', id: `tab-${tab}`, 'aria-controls': `panel-${tab}` },
            on: { click: () => selectTab(tab) },
        }, [
            el('span', { className: 'prompt-char', text: '❯', attrs: { 'aria-hidden': 'true' } }),
            el('span', { text: t(`tabs.${tab}`) }),
        ]);
        shell.tabButtons.set(tab, button);
        return button;
    });

    // Arrow keys move between tabs (ARIA tabs pattern).
    tablist.addEventListener('keydown', (event) => {
        const index = TAB_ORDER.indexOf(shell.activeTab);
        if (event.key === KEY.ARROW_RIGHT) selectTab(TAB_ORDER[(index + 1) % TAB_ORDER.length], { focus: true });
        if (event.key === KEY.ARROW_LEFT) selectTab(TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length], { focus: true });
    });
    replaceChildren(tablist, buttons);
}

function buildPanels() {
    const context = {
        apps: () => shell.apps,
        appId: () => shell.appId,
        setAppId,
        refreshApps,
        reportError,
    };
    const appIds = () => shell.apps.map((app) => app.appId);

    shell.panels.set(TAB.VIEWS, createViewsPanel({ mode: PANEL_MODE.VIEWS, meta: shell.meta, context }));
    shell.panels.set(TAB.TRASH, createViewsPanel({ mode: PANEL_MODE.TRASH, meta: shell.meta, context }));
    shell.panels.set(TAB.ADMIN_LOG, createAdminLogPanel({ meta: shell.meta, appIds, reportError }));
    shell.panels.set(TAB.VIEW_LOG, createViewLogPanel({ meta: shell.meta, appIds, reportError }));

    const container = byId('panels');
    replaceChildren(container, TAB_ORDER.map((tab) => {
        const panel = shell.panels.get(tab);
        panel.element.id = `panel-${tab}`;
        panel.element.setAttribute('role', 'tabpanel');
        panel.element.setAttribute('aria-labelledby', `tab-${tab}`);
        return panel.element;
    }));
}

async function enterApp() {
    shell.meta = await api.meta();
    const { apps } = await api.apps();
    shell.apps = apps;
    const remembered = readLastApp();
    shell.appId = apps.some((app) => app.appId === remembered) ? remembered : apps[0]?.appId ?? null;

    buildTabs();
    buildPanels();
    for (const tab of [TAB.VIEWS, TAB.TRASH]) shell.panels.get(tab).syncApps();

    byId('login-screen').hidden = true;
    byId('app-screen').hidden = false;
    byId('logout-btn').hidden = false;

    selectTab(window.location.hash.slice(1));
}

async function logout() {
    try {
        await api.logout();
    } catch (error) {
        reportError(error);
    }
    setCsrfToken(null);
    showLogin('login.signedOut');
}

// ---- Boot -------------------------------------------------------------------

async function boot() {
    await loadLocale();
    applyTranslations();
    document.title = t('app.documentTitle');

    initTheme({
        [THEME.LIGHT]: byId('theme-light'),
        [THEME.DARK]: byId('theme-dark'),
        [THEME.AUTO]: byId('theme-auto'),
    });
    wireLogin();
    byId('logout-btn').addEventListener('click', logout);
    onUnauthenticated(() => {
        setCsrfToken(null);
        showLogin('errors.UNAUTHENTICATED');
    });

    try {
        const session = await api.session();
        if (session.authenticated) {
            setCsrfToken(session.csrfToken);
            await enterApp();
        } else {
            showLogin();
        }
    } catch (error) {
        showLogin(`errors.${error instanceof ApiError ? error.code : ERROR_CODE.SERVER_ERROR}`);
    } finally {
        document.body.classList.remove('booting');
    }
}

boot();
