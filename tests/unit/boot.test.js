// Boot resilience.
//
// app.js is an ES module, so a throw anywhere in its top-level prelude aborts
// module evaluation. Unlike the classic script it replaced -- whose function
// declarations landed on window and kept the inline onclick attributes alive --
// nothing after the throw runs, including the addEventListener block that binds
// all eleven controls. The page then paints normally with every control dead and
// no visible error.
//
// The prelude reads localStorage, and localStorage is keyed by origin. This app
// lives on 127.0.0.1:3000, the most contested local development origin there is,
// so both triggers below are reachable without anything exotic happening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountApp } from '../helpers/dom.js';
import { translations } from '../../public/js/i18n.js';

test('boots with an unrecognised persisted locale and still wires the controls', async () => {
    // Another project on 127.0.0.1:3000 writing lang="en-US" is enough: the
    // locale is not a key of translations, so any translations[lang][key] lookup
    // throws TypeError before the wiring block is reached.
    const { document, cleanup } = await mountApp({ storage: { lang: 'en-US' } });

    try {
        assert.equal(document.documentElement.lang, 'fa', 'unknown locale falls back to the default');
        assert.equal(document.documentElement.dir, 'rtl');
        assert.equal(document.getElementById('langSelect').value, 'fa');
        assert.equal(
            document.querySelector('[data-i18n="helpBtn"]').textContent,
            translations.fa.helpBtn,
            'the UI is translated, not left half-painted'
        );

        // The control is the point: wiring runs even though the prelude met a
        // value it could not resolve.
        const before = document.documentElement.getAttribute('data-theme');
        document.getElementById('themeToggle').dispatchEvent(new document.defaultView.MouseEvent('click'));
        assert.notEqual(
            document.documentElement.getAttribute('data-theme'),
            before,
            'themeToggle is wired'
        );
    } finally {
        cleanup();
    }
});

// Chrome's "block all cookies" and Firefox's strict mode make the localStorage
// accessor itself raise SecurityError rather than returning an empty store.
//
// The whole object is swapped rather than one method patched: jsdom implements
// Storage as a Proxy whose defineProperty trap drops the definition without
// error, so a per-method patch reads as working and denies nothing.
function denyStorage(method) {
    return ({ window }) => {
        const backing = new Map();
        const stub = {
            getItem: (k) => (backing.has(k) ? backing.get(k) : null),
            setItem: (k, v) => { backing.set(k, String(v)); },
            removeItem: (k) => { backing.delete(k); },
            clear: () => { backing.clear(); },
        };
        stub[method] = () => { throw new window.DOMException('denied', 'SecurityError'); };

        Object.defineProperty(window, 'localStorage', { value: stub, configurable: true });
    };
}

test('boots with localStorage reads denied', async () => {
    const { document, cleanup } = await mountApp({ beforeBoot: denyStorage('getItem') });

    try {
        assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', 'falls back to the default theme');
        assert.equal(document.documentElement.lang, 'fa');

        const before = document.documentElement.getAttribute('data-theme');
        document.getElementById('themeToggle').dispatchEvent(new document.defaultView.MouseEvent('click'));
        assert.notEqual(document.documentElement.getAttribute('data-theme'), before, 'themeToggle is wired');
    } finally {
        cleanup();
    }
});

test('boots with localStorage writes denied and still applies a theme change', async () => {
    const { document, cleanup } = await mountApp({ beforeBoot: denyStorage('setItem') });

    try {
        const before = document.documentElement.getAttribute('data-theme');
        document.getElementById('themeToggle').dispatchEvent(new document.defaultView.MouseEvent('click'));

        // A failed persist must not cost the user the change they just made.
        assert.notEqual(document.documentElement.getAttribute('data-theme'), before);
    } finally {
        cleanup();
    }
});

// The <head> bootstrap is a classic inline script that runs before the
// stylesheets, so it decides the pre-paint attributes on its own -- app.js only
// corrects them later, after the module has been fetched and evaluated. The
// jsdom helper seeds localStorage after constructing the document, which is too
// late for this script, so it is exercised directly against stub globals.
function runHeadBootstrap(localStorage) {
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    const open = html.indexOf('<script>');
    const source = html.slice(open + '<script>'.length, html.indexOf('</script>', open));

    const root = {
        lang: '',
        dir: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
    };
    new Function('document', 'localStorage', source)({ documentElement: root }, localStorage);
    return root;
}

function storageStub(entries) {
    return { getItem: (key) => (key in entries ? entries[key] : null) };
}

test('the <head> bootstrap paints the default locale for an unrecognised one', () => {
    // Same trigger as the first test in this file: a foreign `lang` on the shared
    // 127.0.0.1:3000 origin. app.js resolves it to fa, so trusting it here would
    // paint LTR and then flip to RTL -- exactly the flash the script exists to
    // prevent. Adding a locale to i18n.js means adding it to this list too.
    const root = runHeadBootstrap(storageStub({ lang: 'en-US' }));

    assert.equal(root.lang, 'fa');
    assert.equal(root.dir, 'rtl');
});

test('the <head> bootstrap keeps a known locale', () => {
    const root = runHeadBootstrap(storageStub({ lang: 'ru', theme: 'light' }));

    assert.equal(root.lang, 'ru');
    assert.equal(root.dir, 'ltr');
    assert.equal(root.attributes['data-theme'], 'light');
});

test('the <head> bootstrap survives denied storage', () => {
    const root = runHeadBootstrap({ getItem() { throw new Error('denied'); } });

    // The markup defaults stand; nothing is half-applied.
    assert.equal(root.attributes['data-theme'], undefined);
    assert.equal(root.lang, '');
});

test('binds every control before the first paint', async () => {
    // The regression this file exists for: wiring used to sit after the paint
    // calls, so any throw in the prelude left all eleven controls dead. Asserting
    // the order directly means a future edit that moves them back fails here and
    // not in a user's browser.
    const source = readFileSync(new URL('../../public/js/app.js', import.meta.url), 'utf8');
    const lastWiring = source.lastIndexOf(".addEventListener(");
    const firstPaint = source.indexOf('\nsetLanguage(currentLang);');

    assert.ok(lastWiring > 0 && firstPaint > 0, 'both anchors found');
    assert.ok(
        lastWiring < firstPaint,
        'every addEventListener must run before setLanguage/setTheme/updateStartBtn'
    );
});
