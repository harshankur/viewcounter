/*!
 * viewcounter tracker
 *
 * If you found this on a site you were visiting: this is viewcounter, a
 * privacy-first view counter that the site runs on its own server. It is built
 * for GDPR compliance:
 *   - it sets no cookie and stores nothing on your device;
 *   - it sends no identifier;
 *   - the server never stores your IP address or your browser's user agent,
 *     only a masked address and a visitor hash that changes every day by
 *     default, so nothing it keeps identifies you directly.
 * Check it yourself: the source is at https://github.com/harshankur/viewcounter
 * and the homepage at https://viewcounter.harshankur.com.
 *
 * For site owners:
 *
 *   <script defer src="https://your-server/tracker.js" data-app="blog"></script>
 *
 * Records a view of each page (including page changes in single-page apps),
 * how long it was visible and, on a page that scrolls, how far (reported when the page
 * is hidden or left, and every half minute while it is being read), clicks on links to
 * other sites and on downloads, and the campaign tags of the landing URL.
 * The page before is sent as its origin and path only.
 *
 * It stores nothing on the visitor's device (no cookie, no localStorage, no
 * sessionStorage), so it needs no consent banner, and it sends no identifier:
 * the server tells repeat visits apart with a hash it rotates every day by default.
 *
 * Options, as attributes on the script tag:
 *   data-app="blog"                 required: the app ID the views belong to
 *   data-hosts="example.com,www.example.com"
 *                                   only track on these hostnames (keeps dev
 *                                   servers and previews out of the data)
 *   data-spa="false"                do not treat history changes as page views
 *   data-hash="#docs/,#spec/"       count a URL fragment that starts with one of
 *                                   these as its own page (hash-routed pages)
 *   data-heartbeat="false"          report time on page only when the page is
 *                                   hidden or left, not while it is being read
 *   data-campaigns="false"          do not send the landing URL's utm_* tags
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
    const hashRoutes = (script.dataset.hash || '').split(',').map((prefix) => prefix.trim()).filter(Boolean);
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    // Automated browsers are not visitors.
    if (navigator.webdriver) return;
    if (option('respectDnt', false) && (navigator.doNotTrack === '1' || window.doNotTrack === '1')) return;

    const base = script.src.replace(/[^/]*$/, '');
    const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const DOWNLOAD = /\.(pdf|zip|gz|tgz|rar|7z|dmg|exe|msi|pkg|deb|rpm|apk|iso|csv|xlsx?|docx?|pptx?|odt|ods|epub|mp3|mp4|mov|avi|wav)$/i;
    const MAX_ENGAGED_MS = 6 * 60 * 60 * 1000;
    const ENGAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const HEARTBEAT_MS = 30 * 1000;
    // A tab left open with nobody at it stops reporting after this long without input.
    const IDLE_MS = 30 * 60 * 1000;

    const deviceSize = () => (innerWidth < 768 ? 'small' : innerWidth < 1200 ? 'medium' : 'large');
    /**
     * How much of the page has been on screen, from 0 to 100, or null for a
     * page that fits the window: there is nothing to scroll, so "all of it"
     * would say nothing about the reader.
     */
    const seen = () => {
        const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
        return height <= innerHeight + 1 ? null : Math.min(100, Math.round(((scrollY + innerHeight) / height) * 100));
    };
    /** Note how far the page on screen has been scrolled, if it scrolls at all (it may have grown since it loaded). */
    const measure = () => {
        const depth = view ? seen() : null;
        if (depth !== null) view.scroll = Math.max(view.scroll === null ? 0 : view.scroll, depth);
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

    /** The page on screen: its path, and its fragment when that is one of the site's own routes. */
    const currentPage = () => location.pathname
        + (hashRoutes.some((prefix) => location.hash.startsWith(prefix)) ? location.hash : '');

    let view = null;
    let referrer = document.referrer ? originAndPath(document.referrer) : '';
    let path = currentPage();

    /**
     * Tell the server how long a page was visible and how far it was scrolled.
     * `alive` sends it even when neither has grown since the last report: that
     * is the heartbeat saying the visitor is still there.
     */
    function reportEngagement(of = view, alive = false) {
        if (!of || !of.id) return;
        const ms = Math.min(MAX_ENGAGED_MS, Math.round(of.visibleMs + (of.visibleSince === null ? 0 : performance.now() - of.visibleSince)));
        const scroll = of.scroll === null ? -1 : of.scroll;
        if (!alive && ms <= of.sentMs && scroll <= of.sentScroll) return;
        of.sentMs = ms;
        of.sentScroll = scroll;
        // A page that never scrolled reports its time alone.
        const body = JSON.stringify({ appId: app, id: of.id, ms, scroll: of.scroll === null ? undefined : of.scroll });
        // text/plain needs no CORS preflight, so the beacon survives the page closing.
        if (!(navigator.sendBeacon && navigator.sendBeacon(`${base}engage`, new Blob([body], { type: 'text/plain' })))) {
            fetch(`${base}engage`, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
                .catch(() => {});
        }
    }

    function pageview() {
        // The page being left stops counting here, and reports what it has.
        if (view) {
            if (view.visibleSince !== null) view.visibleMs += performance.now() - view.visibleSince;
            view.visibleSince = null;
            reportEngagement();
        }
        const params = new URLSearchParams({
            appId: app,
            deviceSize: deviceSize(),
            page: currentPage().slice(0, 500),
            title: document.title.slice(0, 200),
            referrer: referrer.slice(0, 500),
        });
        // Only the campaign tags: the rest of a query string can carry
        // emails, tokens, or IDs, and never leaves the page.
        if (option('campaigns', true)) {
            const query = new URLSearchParams(location.search);
            for (const key of UTM) {
                const value = query.get(key);
                if (value) params.set(key, value.slice(0, 100));
            }
        }

        const current = {
            id: null,
            startedAt: Date.now(),
            visibleMs: 0,
            visibleSince: document.visibilityState === 'visible' ? performance.now() : null,
            scroll: null,
            sentMs: 0,
            sentScroll: -1,
        };
        view = current;
        measure();
        fetch(`${base}registerView?${params}`, { keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' })
            .then((response) => (response.ok ? response.json() : null))
            .then((result) => {
                if (!result || !result.id) return;
                current.id = result.id;
                // Left before the server answered: its report could not go then, so it goes now.
                if (view !== current) reportEngagement(current);
            })
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
                page: currentPage().slice(0, 500),
                title: document.title.slice(0, 200),
            }),
        }).catch(() => {});
    }

    // A page change in a single-page app is a new page view, with the page it
    // came from as its referrer (which the server files as internal).
    function navigated() {
        if (currentPage() === path) return;
        // Like every referrer, without the fragment: the server keeps an origin and a path.
        referrer = `${location.origin}${path.split('#')[0]}`;
        path = currentPage();
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
    // Asked for by name, so it does not wait on data-spa.
    if (hashRoutes.length) addEventListener('hashchange', navigated);

    let scrollQueued = false;
    addEventListener('scroll', () => {
        if (scrollQueued) return;
        scrollQueued = true;
        requestAnimationFrame(() => {
            scrollQueued = false;
            measure();
        });
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
        if (!view) return;
        if (document.visibilityState === 'hidden') {
            if (view.visibleSince !== null) view.visibleMs += performance.now() - view.visibleSince;
            view.visibleSince = null;
            measure();
            reportEngagement();
        } else if (view.visibleSince === null) {
            view.visibleSince = performance.now();
        }
    });
    addEventListener('pagehide', () => { measure(); reportEngagement(); });

    // While the page is being read, report as it goes: the server then knows the
    // visitor is still there, and a tab the browser kills without warning (common
    // on phones) loses half a minute of its time at most, not all of it.
    if (option('heartbeat', true)) {
        let lastInput = performance.now();
        const active = () => { lastInput = performance.now(); };
        for (const type of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart']) {
            addEventListener(type, active, { passive: true, capture: true });
        }
        setInterval(() => {
            if (!view || document.visibilityState !== 'visible' || performance.now() - lastInput > IDLE_MS) return;
            // The server takes reports for a view for a day. A page open longer says no more.
            if (Date.now() - view.startedAt > ENGAGE_WINDOW_MS) return;
            measure();
            reportEngagement(view, true);
        }, HEARTBEAT_MS);
    }

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
