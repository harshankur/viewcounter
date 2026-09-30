/*!
 * viewcounter tracker, https://viewcounter.harshankur.com
 *
 *   <script defer src="https://your-server/tracker.js" data-app="blog"></script>
 *
 * Records a view of each page (including page changes in single-page apps),
 * how long it was visible and how far it was scrolled, clicks on links to
 * other sites and on downloads, and the campaign tags of the landing URL.
 * The page before is sent as its origin and path only.
 *
 * It stores nothing on the visitor's device (no cookie, no localStorage, no
 * sessionStorage), so it needs no consent banner, and it sends no identifier:
 * the server tells repeat visits apart with a hash it rotates every day.
 *
 * Options, as attributes on the script tag:
 *   data-app="blog"                 required: the app ID the views belong to
 *   data-hosts="example.com,www.example.com"
 *                                   only track on these hostnames (keeps dev
 *                                   servers and previews out of the data)
 *   data-spa="false"                do not treat history changes as page views
 *   data-outbound="false"           do not record clicks on links to other sites
 *   data-downloads="false"          do not record clicks on downloads
 *   data-respect-dnt="true"         send nothing when Do Not Track is on
 *
 * Custom events: window.viewcounter.track('signup', { plan: 'pro' }).
 */
(() => {
    const script = document.currentScript;
    const app = script && script.dataset.app;
    if (!app) return;

    const option = (name, fallback) => (script.dataset[name] === undefined ? fallback : script.dataset[name] !== 'false');
    const hosts = (script.dataset.hosts || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (hosts.length && !hosts.includes(location.hostname.toLowerCase())) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    // Automated browsers are not visitors.
    if (navigator.webdriver) return;
    if (option('respectDnt', false) && (navigator.doNotTrack === '1' || window.doNotTrack === '1')) return;

    const base = script.src.replace(/[^/]*$/, '');
    const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const DOWNLOAD = /\.(pdf|zip|gz|tgz|rar|7z|dmg|exe|msi|pkg|deb|rpm|apk|iso|csv|xlsx?|docx?|pptx?|odt|ods|epub|mp3|mp4|mov|avi|wav)$/i;
    const MAX_ENGAGED_MS = 6 * 60 * 60 * 1000;

    const deviceSize = () => (innerWidth < 768 ? 'small' : innerWidth < 1200 ? 'medium' : 'large');
    /** How much of the page has been on screen, from 0 to 100. */
    const seen = () => {
        const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
        return height <= 0 ? 100 : Math.min(100, Math.round(((scrollY + innerHeight) / height) * 100));
    };

    /** A URL's origin and path: its query and fragment can carry tokens or emails. */
    const originAndPath = (url) => {
        try {
            const parsed = new URL(url);
            return `${parsed.origin}${parsed.pathname}`;
        } catch {
            return '';
        }
    };

    let view = null;
    let referrer = document.referrer ? originAndPath(document.referrer) : '';
    let path = location.pathname;

    /** Tell the server how long the current page was visible and how far it was scrolled. */
    function reportEngagement() {
        if (!view || !view.id) return;
        const ms = Math.min(MAX_ENGAGED_MS, Math.round(view.visibleMs + (view.visibleSince === null ? 0 : performance.now() - view.visibleSince)));
        if (ms <= view.sentMs && view.scroll <= view.sentScroll) return;
        view.sentMs = ms;
        view.sentScroll = view.scroll;
        const body = JSON.stringify({ appId: app, id: view.id, ms, scroll: view.scroll });
        // text/plain needs no CORS preflight, so the beacon survives the page closing.
        if (!(navigator.sendBeacon && navigator.sendBeacon(`${base}engage`, new Blob([body], { type: 'text/plain' })))) {
            fetch(`${base}engage`, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
                .catch(() => {});
        }
    }

    function pageview() {
        reportEngagement();
        const params = new URLSearchParams({
            appId: app,
            deviceSize: deviceSize(),
            page: location.pathname.slice(0, 500),
            title: document.title.slice(0, 200),
            referrer: referrer.slice(0, 500),
        });
        // Only the campaign tags: the rest of a query string can carry
        // emails, tokens, or IDs, and never leaves the page.
        const query = new URLSearchParams(location.search);
        for (const key of UTM) {
            const value = query.get(key);
            if (value) params.set(key, value.slice(0, 100));
        }

        const current = {
            id: null,
            visibleMs: 0,
            visibleSince: document.visibilityState === 'visible' ? performance.now() : null,
            scroll: seen(),
            sentMs: 0,
            sentScroll: 0,
        };
        view = current;
        fetch(`${base}registerView?${params}`, { keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' })
            .then((response) => (response.ok ? response.json() : null))
            .then((result) => { if (result && result.id) current.id = result.id; })
            .catch(() => {});
    }

    function track(eventType, eventData) {
        if (typeof eventType !== 'string' || !eventType) return;
        fetch(`${base}event`, {
            method: 'POST',
            keepalive: true,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appId: app,
                eventType: eventType.slice(0, 50),
                eventData: eventData && typeof eventData === 'object' ? eventData : undefined,
                page: location.pathname.slice(0, 500),
                title: document.title.slice(0, 200),
            }),
        }).catch(() => {});
    }

    // A page change in a single-page app is a new page view, with the page it
    // came from as its referrer (which the server files as internal).
    function navigated() {
        if (location.pathname === path) return;
        referrer = `${location.origin}${path}`;
        path = location.pathname;
        pageview();
    }
    if (option('spa', true)) {
        for (const method of ['pushState', 'replaceState']) {
            const original = history[method];
            history[method] = function patched(...args) {
                const result = original.apply(this, args);
                navigated();
                return result;
            };
        }
        addEventListener('popstate', navigated);
    }

    let scrollQueued = false;
    addEventListener('scroll', () => {
        if (scrollQueued) return;
        scrollQueued = true;
        requestAnimationFrame(() => {
            scrollQueued = false;
            if (view) view.scroll = Math.max(view.scroll, seen());
        });
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
        if (!view) return;
        if (document.visibilityState === 'hidden') {
            if (view.visibleSince !== null) view.visibleMs += performance.now() - view.visibleSince;
            view.visibleSince = null;
            reportEngagement();
        } else if (view.visibleSince === null) {
            view.visibleSince = performance.now();
        }
    });
    addEventListener('pagehide', reportEngagement);

    // Links out and downloads. Only the other site's hostname, or the file's
    // name, is recorded: never the whole URL, which can carry personal data.
    document.addEventListener('click', (event) => {
        const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!link) return;
        let url;
        try { url = new URL(link.href, location.href); } catch { return; }
        if (option('downloads', true) && DOWNLOAD.test(url.pathname)) {
            let file = url.pathname.split('/').pop();
            try { file = decodeURIComponent(file); } catch { /* keep it encoded */ }
            track('download', { file: file.slice(0, 100) });
        } else if (option('outbound', true) && /^https?:$/.test(url.protocol) && url.hostname !== location.hostname) {
            track('outbound', { host: url.hostname });
        }
    }, { capture: true });

    window.viewcounter = { track };
    pageview();
})();
