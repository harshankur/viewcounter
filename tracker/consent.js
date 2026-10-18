/*!
 * viewcounter consent
 *
 * If you found this on a site you were visiting: this small script asks
 * whether the site may count your visit in more detail. The site counts with
 * viewcounter, a privacy-first view counter it runs on its own server.
 *   - Until you allow it, nothing runs in your browser to count you. At most
 *     the site's server notes which pages were requested, from the requests
 *     your browser makes for them anyway.
 *   - If you allow it, this loads the view counter's script (tracker.js, next
 *     to this file), which also measures how long a page stays open, how far
 *     it is scrolled, and which links and features are used. It sets no
 *     cookie and sends nothing that identifies you.
 *   - Your answer is the one thing kept on your device: "granted" or "denied"
 *     in this site's localStorage, under "viewcounter-consent:" and the
 *     site's name for it. Change it at any time with the site's privacy settings
 *     link; saying no costs you nothing.
 * Check it yourself: the source is at https://github.com/harshankur/viewcounter
 * and the homepage at https://viewcounter.harshankur.com.
 *
 * For site owners, instead of tracker.js:
 *
 *   <script defer src="https://your-server/consent.js" data-app="blog"
 *     data-hosts="example.com" data-privacy-url="https://example.com/privacy"></script>
 *
 * Options, as attributes on the script tag:
 *   data-app="blog"                 required: the app ID, as for the tracker
 *   data-hosts="example.com,www.example.com"
 *                                   only on these hostnames; anywhere else this
 *                                   does nothing at all (no prompt on dev servers)
 *   data-consent-key="officeparser" the name the answer is kept under (letters,
 *                                   digits, _ and -); the app ID by default.
 *                                   Apps sharing one site share one answer by
 *                                   sharing the key
 *   data-privacy-url="https://..."  the privacy notice the prompt links to
 *   data-lang="de"                  "de" or "en"; otherwise German when <html lang>
 *                                   starts with "de", English when it does not
 *   data-ui="none"                  never show the prompt by itself; the site
 *                                   asks through the API below
 *   data-edge="false"               nothing counts this site's pages without
 *                                   consent (no edge Worker), and the prompt says so
 *   data-spa, data-hash, data-query, data-heartbeat, data-campaigns,
 *   data-outbound, data-downloads, data-respect-dnt
 *                                   passed on to the tracker
 *
 * window.viewcounterConsent: open() shows the prompt again, status() is
 * "granted", "denied", or "unset", grant() and deny() answer for the visitor.
 * Every change fires a "viewcounter:consent" event on window, with
 * event.detail.status. A click on any element with the attribute
 * data-viewcounter-consent opens the prompt (a footer link "Privacy settings").
 *
 * The prompt is styled in a closed shadow root, so the page's CSS cannot
 * reach it. These custom properties on the viewcounter-consent element (or
 * any ancestor) change it: --viewcounter-consent-font, -background, -color,
 * -border, -radius, -shadow, -button-background, -button-color,
 * -button-border, -link, -focus, -z-index.
 */
(() => {
    const script = document.currentScript;
    const app = script && script.dataset.app;
    if (!app) return;

    const hosts = (script.dataset.hosts || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (hosts.length && !hosts.includes(location.hostname.toLowerCase())) return;

    const GRANTED = 'granted';
    const DENIED = 'denied';
    const UNSET = 'unset';
    // One answer per key: the app's own, unless the site shares one across its apps.
    const CONSENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;
    const KEY = `viewcounter-consent:${CONSENT_KEY.test(script.dataset.consentKey || '') ? script.dataset.consentKey : app}`;
    const EVENT = 'viewcounter:consent';
    const TRIGGER = 'data-viewcounter-consent';
    /** The tracker's own options, passed on to it as they are. */
    const TRACKER_OPTIONS = ['app', 'hosts', 'spa', 'hash', 'query', 'heartbeat', 'campaigns', 'outbound', 'downloads', 'respectDnt'];
    const base = script.src.replace(/[^/]*$/, '');

    const TEXT = {
        en: {
            label: 'Usage statistics',
            question: 'May I count in more detail how this site is used?',
            edge: 'Without your consent I only count which pages are opened.',
            noEdge: 'Without your consent nothing is counted.',
            detail: 'With it, also how long a page stays open, how far it is scrolled, and which links and features are used. No cookies, nothing personal, nothing shared.',
            allow: 'Allow',
            deny: 'No thanks',
            privacy: 'Privacy notice',
            [GRANTED]: 'Your current answer: allowed.',
            [DENIED]: 'Your current answer: no.',
            announce: 'A question about usage statistics is waiting at the end of the page.',
        },
        de: {
            label: 'Nutzungsstatistik',
            question: 'Darf ich genauer zählen, wie diese Seite genutzt wird?',
            edge: 'Ohne Ihre Einwilligung zähle ich nur, welche Seiten aufgerufen werden.',
            noEdge: 'Ohne Ihre Einwilligung wird nichts gezählt.',
            detail: 'Mit ihr auch, wie lange eine Seite offen ist, wie weit gescrollt wird und welche Links und Funktionen genutzt werden. Keine Cookies, nichts Persönliches, keine Weitergabe.',
            allow: 'Erlauben',
            deny: 'Nein danke',
            privacy: 'Datenschutzerklärung',
            [GRANTED]: 'Ihre aktuelle Antwort: erlaubt.',
            [DENIED]: 'Ihre aktuelle Antwort: nein.',
            announce: 'Am Ende der Seite wartet eine Frage zur Nutzungsstatistik.',
        },
    };
    const lang = (() => {
        const wanted = (script.dataset.lang || '').toLowerCase();
        if (Object.hasOwn(TEXT, wanted)) return wanted;
        return document.documentElement.lang.toLowerCase().startsWith('de') ? 'de' : 'en';
    })();
    const text = TEXT[lang];

    /** Only an http(s) address is linked, never a script URL. */
    const privacyUrl = (() => {
        try {
            const url = new URL(script.dataset.privacyUrl || '', location.href);
            return script.dataset.privacyUrl && /^https?:$/.test(url.protocol) ? url.href : '';
        } catch {
            return '';
        }
    })();

    // ---- The answer ---------------------------------------------------------

    /**
     * The answer given on this page, which wins over storage: storage may be
     * unavailable (a private window, blocked site data), and then the visitor
     * is asked on every page and this is all there is.
     */
    let answer = null;
    /** The status last made known, by the events below; set once the API is up. */
    let known = UNSET;

    function status() {
        if (answer) return answer;
        try {
            const stored = localStorage.getItem(KEY);
            if (stored === GRANTED || stored === DENIED) return stored;
        } catch {
            // Storage unavailable: unanswered, as far as this page knows.
        }
        return UNSET;
    }

    function announce(value) {
        if (value === known) return;
        known = value;
        window.dispatchEvent(new CustomEvent(EVENT, { detail: { status: value } }));
    }

    function decide(value) {
        answer = value;
        try {
            localStorage.setItem(KEY, value);
        } catch {
            // Kept for this page only.
        }
        hide();
        if (value === GRANTED) loadTracker();
        announce(value);
    }

    // Answered in another tab of the same site (or the site's data cleared):
    // that answer is this one's too.
    window.addEventListener('storage', (event) => {
        if (event.key !== KEY && event.key !== null) return;
        answer = null;
        const now = status();
        if (now === known) return;
        if (now !== UNSET) hide();
        if (now === GRANTED) loadTracker();
        announce(now);
    });

    // ---- The tracker ---------------------------------------------------------

    let trackerLoaded = false;

    /**
     * Load the tracker once, from where this script came, with the site's
     * options. Never beside a tracker the page loads itself (which it should
     * not: that one would not wait for an answer).
     */
    function loadTracker() {
        if (trackerLoaded || window.viewcounter || [...document.scripts].some((tag) => tag.src === `${base}tracker.js`)) return;
        trackerLoaded = true;
        const tag = document.createElement('script');
        tag.src = `${base}tracker.js`;
        for (const name of TRACKER_OPTIONS) {
            if (script.dataset[name] !== undefined) tag.dataset[name] = script.dataset[name];
        }
        // A page whose content security policy allows this script by nonce allows the tracker too.
        if (script.nonce) tag.nonce = script.nonce;
        (document.head || document.documentElement).appendChild(tag);
    }

    // ---- The prompt ------------------------------------------------------------

    const STYLE = `
        :host { all: initial; }
        .card {
            --bg: #ffffff; --fg: #1f2328; --line: #d0d7de; --button: #f6f8fa; --link: #0b5cad; --focus: #0b5cad;
            position: fixed; z-index: var(--viewcounter-consent-z-index, 2147483000);
            inset-inline-end: 16px; bottom: 16px; box-sizing: border-box; width: min(360px, calc(100vw - 32px));
            padding: 16px; border-radius: var(--viewcounter-consent-radius, 12px);
            border: 1px solid var(--viewcounter-consent-border, var(--line));
            background: var(--viewcounter-consent-background, var(--bg));
            color: var(--viewcounter-consent-color, var(--fg));
            box-shadow: var(--viewcounter-consent-shadow, 0 8px 28px rgba(0, 0, 0, 0.18));
            font: 14px/1.45 var(--viewcounter-consent-font, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
            text-align: start;
        }
        @media (prefers-color-scheme: dark) {
            .card { --bg: #1c2128; --fg: #e6edf3; --line: #3d444d; --button: #2d333b; --link: #6cb6ff; --focus: #6cb6ff; }
        }
        @media (max-width: 480px) {
            .card { inset-inline: 12px; bottom: 12px; width: auto; }
        }
        @media (prefers-reduced-motion: no-preference) {
            .card { animation: enter 0.18s ease-out; }
            @keyframes enter { from { opacity: 0; transform: translateY(8px); } }
        }
        .card[hidden] { display: none; }
        p { margin: 0 0 12px; }
        p[hidden] { display: none; }
        strong { display: block; margin-bottom: 4px; font-weight: 600; }
        .actions { display: flex; gap: 8px; }
        button {
            flex: 1 1 0; margin: 0; padding: 8px 12px; cursor: pointer;
            font: inherit; font-weight: 600; line-height: 1.3;
            border-radius: calc(var(--viewcounter-consent-radius, 12px) / 2);
            border: 1px solid var(--viewcounter-consent-button-border, var(--line));
            background: var(--viewcounter-consent-button-background, var(--button));
            color: var(--viewcounter-consent-button-color, var(--fg));
        }
        button:hover { filter: brightness(0.95); }
        a { display: inline-block; margin-top: 10px; font-size: 13px; color: var(--viewcounter-consent-link, var(--link)); }
        button:focus-visible, a:focus-visible { outline: 2px solid var(--viewcounter-consent-focus, var(--focus)); outline-offset: 2px; }
        .announce {
            position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
            overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
        }
    `;

    let host = null;
    let card = null;
    /** The answer given so far, when the prompt is opened again to change it. */
    let current = null;
    /**
     * A polite live region beside the card, which says once that the question
     * is there when it appears by itself. The card is not live: read in full
     * on every change, it would talk over the page.
     */
    let announcer = null;
    /** A live region announces a change, so its text is set a moment after it exists. */
    const ANNOUNCE_DELAY_MS = 150;
    /** Where focus was when the prompt was opened by hand, to return it there. */
    let returnFocus = null;

    function element(name, properties = {}, children = []) {
        const node = document.createElement(name);
        Object.assign(node, properties);
        node.append(...children);
        return node;
    }

    function build() {
        host = document.createElement('viewcounter-consent');
        // Closed: the page's scripts and styles cannot reach in, and nothing in here reaches out.
        const root = host.attachShadow({ mode: 'closed' });
        const button = (label, value) => {
            const node = element('button', { type: 'button', textContent: label });
            node.addEventListener('click', () => decide(value));
            return node;
        };
        current = element('p', { hidden: true });
        const content = [
            element('p', {}, [
                element('strong', { textContent: text.question }),
                `${script.dataset.edge === 'false' ? text.noEdge : text.edge} ${text.detail}`,
            ]),
            current,
            // Equal weight: the same look, side by side, neither preselected.
            element('div', { className: 'actions' }, [button(text.allow, GRANTED), button(text.deny, DENIED)]),
        ];
        if (privacyUrl) {
            content.push(element('a', { href: privacyUrl, target: '_blank', rel: 'noopener', textContent: text.privacy }));
        }
        card = element('div', { className: 'card', lang, hidden: true }, content);
        card.setAttribute('role', 'region');
        card.setAttribute('aria-label', text.label);
        // A constructed sheet, which a page's content security policy does
        // not block as it may a <style> element; the element where there is none.
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(STYLE);
            root.adoptedStyleSheets = [sheet];
        } catch {
            root.append(element('style', { textContent: STYLE }));
        }
        announcer = element('div', { className: 'announce' });
        announcer.setAttribute('role', 'status');
        announcer.setAttribute('aria-live', 'polite');
        announcer.setAttribute('aria-atomic', 'true');
        root.append(card, announcer);
        (document.body || document.documentElement).appendChild(host);
    }

    /** Show the prompt; `focus` when the visitor asked for it, so the keyboard lands in it. */
    function show(focus) {
        if (!host) build();
        if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
        const answered = status();
        current.hidden = answered === UNSET;
        current.textContent = answered === UNSET ? '' : text[answered];
        if (focus) {
            if (document.activeElement && document.activeElement !== host) returnFocus = document.activeElement;
            card.hidden = false;
            // Focus lands in it, which says where the reader is: nothing to announce.
            announcer.textContent = '';
            card.querySelector('button').focus();
        } else {
            card.hidden = false;
            // Not modal, so focus stays where it is; a screen reader is told instead.
            setTimeout(() => {
                if (!card.hidden) announcer.textContent = text.announce;
            }, ANNOUNCE_DELAY_MS);
        }
    }

    function hide() {
        if (!card || card.hidden) return;
        const hadFocus = document.activeElement === host;
        card.hidden = true;
        announcer.textContent = '';
        if (hadFocus && returnFocus && returnFocus.isConnected) returnFocus.focus();
        returnFocus = null;
    }

    // Escape puts the prompt away for this page view, without an answer:
    // from inside it, or with nothing else on the page focused.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !card || card.hidden) return;
        const focused = document.activeElement;
        if (focused === host || focused === document.body || !focused) hide();
    });

    // A "privacy settings" link anywhere on the page opens the prompt.
    document.addEventListener('click', (event) => {
        const trigger = event.target && event.target.closest ? event.target.closest(`[${TRIGGER}]`) : null;
        if (!trigger) return;
        event.preventDefault();
        show(true);
    });

    /** Run once the document has a body to put the prompt in. */
    function whenReady(callback) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
        else callback();
    }

    /** Run once the page is shown: a page the browser prerenders asks nobody until then. */
    function whenShown(callback) {
        if (document.prerendering) document.addEventListener('prerenderingchange', callback, { once: true });
        else callback();
    }

    window.viewcounterConsent = Object.freeze({
        open: () => whenReady(() => show(true)),
        status,
        grant: () => decide(GRANTED),
        deny: () => decide(DENIED),
    });

    const initial = status();
    known = initial;
    if (initial === GRANTED) loadTracker();
    // Asked only if still unanswered once the page is ready: the site, or
    // another tab, may have answered in between.
    else if (initial === UNSET && script.dataset.ui !== 'none') whenReady(() => whenShown(() => { if (status() === UNSET) show(false); }));
})();
