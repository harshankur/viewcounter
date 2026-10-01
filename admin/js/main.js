/**
 * Admin UI entry point: session check, login, sections, and wiring.
 */

import { api, ApiError, onUnauthenticated, setCsrfToken, setRecovery } from './api.js';
import { promptPassword } from './passwordPrompt.js';
import { byId, el, replaceChildren } from './dom.js';
import { applyTranslations, loadLocale, t } from './i18n.js';
import { icon } from './icons.js';
import { createAdminLogPanel, createTrackingLogPanel } from './logs.js';
import { closeModal } from './modal.js';
import { createOverviewPanel } from './overview.js';
import { initTheme } from './theme.js';
import { showToast, TOAST_TYPE } from './toast.js';
import { createViewsPanel, PANEL_MODE } from './views.js';
import {
    ALL_APPS, COPYRIGHT, ERROR_CODE, KEY, LEGACY_TAB_HASH, LINKS, SESSION_PING_INTERVAL_MS, STORAGE_KEY, TAB, TAB_HASH, THEME,
} from './constants.js';

const TAB_ORDER = [TAB.OVERVIEW, TAB.VIEWS, TAB.TRASH, TAB.TRACKING_LOG, TAB.ADMIN_LOG];
const TAB_ICON = {
    [TAB.OVERVIEW]: 'overview',
    [TAB.VIEWS]: 'views',
    [TAB.TRASH]: 'trash',
    [TAB.TRACKING_LOG]: 'trackingLog',
    [TAB.ADMIN_LOG]: 'adminLog',
};
/** Sections that show one app (or all), and follow the app chosen in any of them. */
const APP_TABS = [TAB.OVERVIEW, TAB.VIEWS, TAB.TRASH];

const shell = {
    meta: null,
    apps: [],
    appId: null,
    panels: new Map(),
    activeTab: null,
    tabButtons: new Map(),
};

/** Hand an exception to the browser's own error reporting (the console, and error listeners). */
function reportToBrowser(error) {
    window.reportError?.(error);
}

/** Translate any failure into a message and show it. */
function reportError(error) {
    if (!(error instanceof ApiError)) {
        // A bug in this page, not an answer from the server: say so, and
        // report the exception to the browser as if uncaught, where a
        // developer finds it with its stack.
        reportToBrowser(error);
        showToast(t(`errors.${ERROR_CODE.UNEXPECTED}`), TOAST_TYPE.ERROR);
        return;
    }
    if (error.code === ERROR_CODE.UNAUTHENTICATED) return;
    showToast(t(`errors.${error.code}`), TOAST_TYPE.ERROR);
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
    shell.panels.get(shell.activeTab)?.hide?.();
    byId('app-screen').hidden = true;
    byId('logout-btn').hidden = true;
    byId('app-footer').hidden = true;
    byId('login-screen').hidden = false;
    const error = byId('login-error');
    error.hidden = !messageKey;
    error.textContent = messageKey ? t(messageKey) : '';
    const input = byId('login-password');
    input.value = '';
    input.focus();
}

function errorKey(error) {
    return `errors.${error instanceof ApiError ? error.code : ERROR_CODE.UNEXPECTED}`;
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
            if (!(error instanceof ApiError)) reportToBrowser(error);
            showLogin(errorKey(error));
        } finally {
            submit.disabled = false;
        }
    });
}

// ---- Staying signed in ------------------------------------------------------

/** Sign in again over whatever the admin was doing, then carry on. */
function reauthenticate() {
    return promptPassword({
        title: t('session.endedTitle'),
        message: t('session.endedMessage'),
        submitLabel: t('login.submit'),
        submit: async (password) => {
            const session = await api.login(password);
            setCsrfToken(session.csrfToken);
        },
    });
}

/** The password again, before something that cannot be undone. */
function confirmPassword() {
    return promptPassword({
        title: t('session.confirmTitle'),
        message: t('session.confirmMessage'),
        submitLabel: t('session.confirmAction'),
        submit: (password) => api.reauth(password),
    });
}

/**
 * Reading counts as using the UI: clicks, keys, and scrolling extend the
 * session even when they cause no request, at most once per interval.
 */
function keepSessionAlive() {
    let lastPing = Date.now();
    const ping = () => {
        if (document.visibilityState !== 'visible' || Date.now() - lastPing < SESSION_PING_INTERVAL_MS) return;
        lastPing = Date.now();
        api.session().catch(() => {});
    };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll', 'visibilitychange']) {
        document.addEventListener(type, ping, { passive: true, capture: true });
    }
}

// ---- Header and footer ------------------------------------------------------

/** An outbound link: new tab, no referrer, no opener. */
function outboundLink(href, label, iconName) {
    return el('a', {
        className: 'footer-link',
        attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
    }, [iconName ? icon(iconName) : null, el('span', { text: label })]);
}

function renderChrome() {
    const version = byId('app-version');
    version.textContent = t('app.version', { version: shell.meta.version });
    version.hidden = false;

    const credits = (shell.meta.attributions ?? []).map((credit) => (credit.url
        ? el('a', { text: credit.text, attrs: { href: credit.url, target: '_blank', rel: 'noopener noreferrer' } })
        : el('span', { text: credit.text })));
    const external = (text, href) => el('a', { text, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } });
    // "© 2026 Harsh Ankur", with the name a link: built around the name so a
    // translation can put the parts in its own order.
    const [beforeHolder, afterHolder] = t('footer.copyright', { year: COPYRIGHT.YEAR, holder: '\u0000' }).split('\u0000');
    replaceChildren(byId('app-footer'), [
        el('div', { className: 'footer-row' }, [
            el('span', { className: 'footer-product', text: t('footer.product', { version: shell.meta.version }) }),
            el('nav', { className: 'footer-links', attrs: { 'aria-label': t('footer.links') } }, [
                outboundLink(LINKS.WEBSITE, t('footer.website'), 'globe'),
                outboundLink(LINKS.DOCS_ADMIN, t('footer.docs'), 'book'),
                outboundLink(LINKS.CHANGELOG, t('footer.changelog'), 'clock'),
                outboundLink(LINKS.SOURCE, t('footer.source'), 'code'),
                outboundLink(LINKS.NPM, t('footer.npm'), 'package'),
            ]),
        ]),
        el('div', { className: 'footer-row footer-legal' }, [
            el('p', { className: 'footer-copyright' }, [
                beforeHolder, external(COPYRIGHT.HOLDER, COPYRIGHT.HOLDER_URL), afterHolder ?? '',
                ' · ', external(t('footer.license'), LINKS.LICENSE),
            ]),
            credits.length ? el('p', { className: 'footer-credits' }, [
                el('span', { text: t('footer.credits') }),
                ...credits.flatMap((credit, index) => [index ? ' · ' : ' ', credit]),
            ]) : null,
        ]),
    ]);
    byId('app-footer').hidden = false;
}

// ---- App shell --------------------------------------------------------------

async function refreshApps() {
    const { apps } = await api.apps();
    shell.apps = apps;
    for (const tab of APP_TABS) shell.panels.get(tab)?.syncApps();
}

function setAppId(appId) {
    shell.appId = appId;
    rememberApp(appId);
    for (const tab of APP_TABS) {
        const panel = shell.panels.get(tab);
        panel.syncApps();
        panel.appChanged();
    }
}

/** The section named by the address, including the names earlier versions used. */
function tabFromHash(hash) {
    const name = hash.replace(/^#/, '');
    return TAB_ORDER.find((tab) => TAB_HASH[tab] === name) ?? LEGACY_TAB_HASH[name] ?? TAB.OVERVIEW;
}

function selectTab(tab, { focus = false } = {}) {
    const next = TAB_ORDER.includes(tab) ? tab : TAB.OVERVIEW;
    if (shell.activeTab && shell.activeTab !== next) shell.panels.get(shell.activeTab)?.hide();
    shell.activeTab = next;
    for (const [key, button] of shell.tabButtons) {
        const active = key === next;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        button.classList.toggle('active', active);
        if (active && focus) button.focus();
    }
    for (const [key, panel] of shell.panels) panel.element.hidden = key !== next;
    shell.panels.get(next).show();

    if (window.location.hash !== `#${TAB_HASH[next]}`) history.replaceState(null, '', `#${TAB_HASH[next]}`);
}

function buildTabs() {
    const tablist = byId('tabs');
    const buttons = TAB_ORDER.map((tab) => {
        const button = el('button', {
            className: 'tab',
            attrs: { type: 'button', role: 'tab', id: `tab-${tab}`, 'aria-controls': `panel-${tab}` },
            on: { click: () => selectTab(tab) },
        }, [icon(TAB_ICON[tab]), el('span', { text: t(`tabs.${tab}`) })]);
        shell.tabButtons.set(tab, button);
        return button;
    });
    replaceChildren(tablist, buttons);
}

/** Arrow keys, Home, and End move between sections (ARIA tabs pattern). Wired once. */
function wireTabKeys() {
    byId('tabs').addEventListener('keydown', (event) => {
        const index = TAB_ORDER.indexOf(shell.activeTab);
        const moves = {
            [KEY.ARROW_RIGHT]: (index + 1) % TAB_ORDER.length,
            [KEY.ARROW_LEFT]: (index - 1 + TAB_ORDER.length) % TAB_ORDER.length,
            [KEY.HOME]: 0,
            [KEY.END]: TAB_ORDER.length - 1,
        };
        if (!(event.key in moves)) return;
        event.preventDefault();
        selectTab(TAB_ORDER[moves[event.key]], { focus: true });
    });
}

function buildPanels() {
    const context = {
        apps: () => shell.apps,
        appId: () => shell.appId,
        setAppId,
        refreshApps,
        reportError,
        /** Views were edited, trashed, restored, or erased: every count is out of date. */
        viewsChanged() {
            for (const tab of APP_TABS) {
                if (tab !== shell.activeTab) shell.panels.get(tab).invalidate();
            }
        },
        /** Open the Views table on exactly the rows an Overview describes. */
        openViews(filters) {
            shell.panels.get(TAB.VIEWS).applyFilters(filters);
            selectTab(TAB.VIEWS);
        },
    };
    const appIds = () => shell.apps.map((app) => app.appId);

    shell.panels.set(TAB.OVERVIEW, createOverviewPanel({ meta: shell.meta, context }));
    shell.panels.set(TAB.VIEWS, createViewsPanel({ mode: PANEL_MODE.VIEWS, meta: shell.meta, context }));
    shell.panels.set(TAB.TRASH, createViewsPanel({ mode: PANEL_MODE.TRASH, meta: shell.meta, context }));
    shell.panels.set(TAB.TRACKING_LOG, createTrackingLogPanel({
        meta: shell.meta,
        appIds,
        reportError,
        // A logged view, found in the table whether or not it is in the trash.
        openView: (appId, viewId) => {
            if (shell.appId !== appId && shell.apps.some((app) => app.appId === appId)) setAppId(appId);
            shell.panels.get(TAB.VIEWS).findView(viewId);
            selectTab(TAB.VIEWS);
        },
    }));
    shell.panels.set(TAB.ADMIN_LOG, createAdminLogPanel({ meta: shell.meta, appIds, reportError }));

    const container = byId('panels');
    replaceChildren(container, TAB_ORDER.map((tab) => {
        const panel = shell.panels.get(tab);
        panel.element.id = `panel-${tab}`;
        panel.element.setAttribute('role', 'tabpanel');
        panel.element.setAttribute('aria-labelledby', `tab-${tab}`);
        panel.element.hidden = true;
        return panel.element;
    }));
}

async function enterApp() {
    shell.meta = await api.meta();
    const { apps } = await api.apps();
    shell.apps = apps;
    // Every app together by default; a remembered app wins while it still exists.
    const remembered = readLastApp();
    shell.appId = apps.some((app) => app.appId === remembered) ? remembered : ALL_APPS;

    shell.activeTab = null;
    shell.panels.clear();
    shell.tabButtons.clear();
    buildTabs();
    buildPanels();
    for (const tab of APP_TABS) shell.panels.get(tab).syncApps();
    renderChrome();

    byId('login-screen').hidden = true;
    byId('app-screen').hidden = false;
    byId('logout-btn').hidden = false;

    selectTab(tabFromHash(window.location.hash));
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

    for (const node of document.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon));
    initTheme({
        [THEME.LIGHT]: byId('theme-light'),
        [THEME.DARK]: byId('theme-dark'),
        [THEME.AUTO]: byId('theme-auto'),
    });
    wireLogin();
    wireTabKeys();
    byId('logout-btn').addEventListener('click', logout);
    setRecovery({ reauthenticate, confirmPassword });
    keepSessionAlive();
    onUnauthenticated(() => {
        setCsrfToken(null);
        showLogin('errors.UNAUTHENTICATED');
    });
    window.addEventListener('hashchange', () => {
        if (!byId('app-screen').hidden) selectTab(tabFromHash(window.location.hash));
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
        if (!(error instanceof ApiError)) reportToBrowser(error);
        showLogin(errorKey(error));
    } finally {
        document.body.classList.remove('booting');
    }
}

boot();
