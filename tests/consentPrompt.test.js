/**
 * The consent prompt's operator sentence (tracker/consent.js), unit-tested in
 * Node: the script runs in a vm context over a small stand-in for the DOM, so
 * the CI gate, which runs no browser, still proves what the prompt says about
 * who runs the site. tests/ui/consent.spec.js proves the same in Chromium.
 *
 * The stand-in refuses every HTML-parsing property, so a prompt that set the
 * name as HTML instead of text would fail here, not render.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'tracker', 'consent.js'), 'utf8');
/** The limit as consent.js defines it, so the tests follow the one constant. */
const OPERATOR_MAX_LENGTH = Number(SOURCE.match(/const OPERATOR_MAX_LENGTH = (\d+);/)[1]);

const QUESTION = 'May I count in more detail how this site is used?';
const EXPLANATION = 'Without your consent I only count which pages are opened. With it, also how long a page stays open, how far it is scrolled, and which links and features are used. No cookies, nothing personal, nothing shared.';

/** A DOM element, with only what consent.js uses. */
class FakeElement {
    constructor(document, localName) {
        this.ownerDocument = document;
        this.localName = localName;
        this.childNodes = [];
        this.attributes = {};
        this.parent = null;
        this.hidden = false;
        this.ownText = '';
    }

    get isConnected() {
        let node = this;
        while (node.parent) node = node.parent;
        return node === this.ownerDocument.documentElement;
    }

    get textContent() {
        return this.ownText + this.childNodes.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
    }

    set textContent(value) {
        this.ownText = String(value);
        this.childNodes = [];
    }

    set innerHTML(value) { throw new TypeError(`innerHTML set to ${value}`); }

    set outerHTML(value) { throw new TypeError(`outerHTML set to ${value}`); }

    insertAdjacentHTML() { throw new TypeError('insertAdjacentHTML called'); }

    append(...nodes) {
        for (const node of nodes) {
            if (typeof node !== 'string') node.parent = this;
            this.childNodes.push(node);
        }
    }

    appendChild(node) {
        this.append(node);
        return node;
    }

    remove() {
        if (!this.parent) return;
        this.parent.childNodes = this.parent.childNodes.filter((node) => node !== this);
        this.parent = null;
    }

    get children() {
        return this.childNodes.filter((node) => typeof node !== 'string');
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }

    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }

    addEventListener() {}

    attachShadow() {
        this.shadowRoot = new FakeElement(this.ownerDocument, '#shadow-root');
        this.shadowRoot.parent = this;
        return this.shadowRoot;
    }

    /** The first descendant of this local name, as querySelector('name') finds it. */
    querySelector(localName) {
        for (const child of this.children) {
            if (child.localName === localName) return child;
            const found = child.querySelector(localName);
            if (found) return found;
        }
        return null;
    }

    focus() {
        let node = this;
        while (node.parent && node.localName !== '#shadow-root') node = node.parent;
        this.ownerDocument.activeElement = node.localName === '#shadow-root' ? node.parent : this;
    }
}

/**
 * Run consent.js on a page at example.com whose consent.js tag carries
 * `dataset`, and return what a test needs to look at the prompt.
 */
function load(dataset = {}) {
    const document = {
        readyState: 'complete',
        prerendering: false,
        scripts: [],
        addEventListener() {},
        createElement: (name) => new FakeElement(document, name),
    };
    document.documentElement = new FakeElement(document, 'html');
    document.documentElement.lang = 'en';
    document.body = new FakeElement(document, 'body');
    document.documentElement.append(document.body);
    document.activeElement = document.body;
    document.currentScript = { dataset: { app: 'blog', ...dataset }, src: 'https://views.example.com/consent.js' };

    const store = new Map();
    const window = {
        document,
        location: { hostname: 'example.com', href: 'https://example.com/' },
        localStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: (key) => store.delete(key),
        },
        URL,
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init.detail; }
        },
        // The announcement waits a moment; the tests do not.
        setTimeout: (callback) => {
            callback();
            return 0;
        },
        addEventListener() {},
        dispatchEvent() {},
    };
    window.window = window;
    vm.runInNewContext(SOURCE, window);

    /** The card on the page now (the prompt is built again when it is outdated). */
    const card = () => {
        const host = document.body.children.find((node) => node.localName === 'viewcounter-consent');
        return host.shadowRoot.children.find((node) => node.className === 'card');
    };
    /** The prompt's first paragraph: the question and what it means. */
    const paragraph = () => card().querySelector('p');
    return {
        script: document.currentScript,
        open: () => window.viewcounterConsent.open(),
        card,
        paragraph,
        /** The operator sentence's element, or null when there is none. */
        sentence: () => paragraph().children.find((node) => node.className === 'operator') || null,
    };
}

describe('consent.js: who runs the site (data-operator)', () => {
    test('without it, the prompt is as before: the question and its explanation, nothing more', () => {
        const prompt = load();
        expect(prompt.sentence()).toBeNull();
        expect(prompt.paragraph().children.map((node) => node.localName)).toEqual(['strong']);
        expect(prompt.paragraph().textContent).toBe(`${QUESTION}${EXPLANATION}`);
        expect(prompt.card().getAttribute('aria-label')).toBe('Usage statistics');
    });

    test('an empty or blank one is none', () => {
        expect(load({ operator: '' }).sentence()).toBeNull();
        expect(load({ operator: ' \t\n ' }).sentence()).toBeNull();
        expect(load({ operator: '\u0000‮' }).sentence()).toBeNull();
    });

    test('names the operator in English, before the question', () => {
        const prompt = load({ operator: 'Harsh Ankur' });
        expect(prompt.sentence().textContent).toBe('This site is run by Harsh Ankur.');
        expect(prompt.sentence().localName).toBe('span');
        expect(prompt.paragraph().childNodes[0]).toBe(prompt.sentence());
        expect(prompt.paragraph().textContent).toBe(`This site is run by Harsh Ankur.${QUESTION}${EXPLANATION}`);
        // The region's name stays the same.
        expect(prompt.card().getAttribute('aria-label')).toBe('Usage statistics');
    });

    test('and in German', () => {
        const prompt = load({ operator: 'Harsh Ankur', lang: 'de' });
        expect(prompt.sentence().textContent).toBe('Diese Seite wird von Harsh Ankur betrieben.');
        expect(prompt.paragraph().childNodes[1].textContent).toBe('Darf ich genauer zählen, wie diese Seite genutzt wird?');
        expect(prompt.card().getAttribute('aria-label')).toBe('Nutzungsstatistik');
    });

    test('a name that looks like HTML is text, as it was written', () => {
        const prompt = load({ operator: '<b>x</b><img src=x onerror=alert(1)>' });
        expect(prompt.sentence().textContent).toBe('This site is run by <b>x</b><img src=x onerror=alert(1)>.');
        expect(prompt.sentence().children).toEqual([]);
    });

    test('control and direction-changing characters are dropped, whitespace runs become one space', () => {
        expect(load({ operator: '  Harsh\u0000 \n\tAnkur\u0007 ' }).sentence().textContent).toBe('This site is run by Harsh Ankur.');
        // A right-to-left override would turn the rest of the sentence around.
        expect(load({ operator: '‮Harsh⁦ Ankur⁩‏' }).sentence().textContent).toBe('This site is run by Harsh Ankur.');
        // Letters of any script stay.
        expect(load({ operator: 'Müller & Söhne GmbH' }).sentence().textContent).toBe('This site is run by Müller & Söhne GmbH.');
    });

    test(`a name of up to ${OPERATOR_MAX_LENGTH} characters is shown; a longer one is not, rather than in part`, () => {
        expect(OPERATOR_MAX_LENGTH).toBeGreaterThan(0);
        const longest = 'a'.repeat(OPERATOR_MAX_LENGTH);
        expect(load({ operator: longest }).sentence().textContent).toBe(`This site is run by ${longest}.`);
        expect(load({ operator: `${longest}b` }).sentence()).toBeNull();
        // Counted in characters, not UTF-16 units, and after the clean-up.
        const emoji = '\u{1F600}'.repeat(OPERATOR_MAX_LENGTH);
        expect(load({ operator: emoji }).sentence().textContent).toBe(`This site is run by ${emoji}.`);
        expect(load({ operator: `  ${longest}\u0000  ` }).sentence().textContent).toBe(`This site is run by ${longest}.`);
    });

    test('a changed attribute is named the next time the prompt is shown, and a removed one is gone', () => {
        const prompt = load({ operator: 'Harsh Ankur' });
        const first = prompt.card();
        prompt.script.dataset.operator = 'Example Ltd';
        prompt.open();
        expect(prompt.card()).not.toBe(first);
        expect(prompt.sentence().textContent).toBe('This site is run by Example Ltd.');
        // Unchanged, the same prompt is shown again.
        const second = prompt.card();
        prompt.open();
        expect(prompt.card()).toBe(second);
        delete prompt.script.dataset.operator;
        prompt.open();
        expect(prompt.sentence()).toBeNull();
        expect(prompt.paragraph().textContent).toBe(`${QUESTION}${EXPLANATION}`);
    });

    test('the announcement for screen readers stays short: it says where the question is, not who asks', () => {
        const announcement = (dataset) => {
            const prompt = load(dataset);
            return prompt.card().parent.children.find((node) => node.className === 'announce');
        };
        const plain = announcement();
        const named = announcement({ operator: 'Harsh Ankur' });
        expect(plain.textContent).toBe('A question about usage statistics is waiting at the end of the page.');
        expect(named.textContent).toBe(plain.textContent);
        expect(named.getAttribute('role')).toBe('status');
        expect(announcement({ operator: 'Harsh Ankur', lang: 'de' }).textContent).toBe('Am Ende der Seite wartet eine Frage zur Nutzungsstatistik.');
    });
});
