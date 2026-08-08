// Locale parity is the one i18n property that cannot be checked by reading a single
// file: a key added to fa/ and forgotten in zh/ leaves the UI silently untranslated,
// because setLanguage() skips keys the active locale does not carry. These tests read
// the real public/index.html so a data-i18n attribute with no translation also fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { translations, t, interpolate } from '../../public/js/i18n.js';

const LOCALES = ['fa', 'en', 'ru', 'zh'];

const indexHtml = readFileSync(
    fileURLToPath(new URL('../../public/index.html', import.meta.url)),
    'utf8'
);

const markupKeys = [...indexHtml.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);

test('every locale in the spec is present', () => {
    assert.deepEqual(Object.keys(translations).sort(), [...LOCALES].sort());
});

test('all four locales carry an identical key set', () => {
    const union = new Set(LOCALES.flatMap(lang => Object.keys(translations[lang])));
    const missing = {};
    for (const lang of LOCALES) {
        const gaps = [...union].filter(key => !(key in translations[lang]));
        if (gaps.length) missing[lang] = gaps;
    }
    assert.deepEqual(missing, {}, `untranslated keys per locale: ${JSON.stringify(missing)}`);
});

test('every data-i18n key in index.html exists in all four locales', () => {
    assert.ok(markupKeys.length > 0, 'index.html should carry data-i18n attributes');
    const missing = {};
    for (const lang of LOCALES) {
        const gaps = markupKeys.filter(key => !(key in translations[lang]));
        if (gaps.length) missing[lang] = gaps;
    }
    assert.deepEqual(missing, {}, `markup keys with no translation: ${JSON.stringify(missing)}`);
});

test('no translation value is empty', () => {
    const empty = [];
    for (const lang of LOCALES) {
        for (const [key, value] of Object.entries(translations[lang])) {
            if (typeof value !== 'string' || value.trim() === '') empty.push(`${lang}.${key}`);
        }
    }
    assert.deepEqual(empty, []);
});

test('toastFound keeps its {n} placeholder in every locale', () => {
    for (const lang of LOCALES) {
        assert.ok(
            translations[lang].toastFound.includes('{n}'),
            `${lang}.toastFound lost {n}`
        );
    }
});

test('summaryLoaded keeps both {n} and {m} in every locale', () => {
    for (const lang of LOCALES) {
        const value = translations[lang].summaryLoaded;
        assert.ok(value.includes('{n}'), `${lang}.summaryLoaded lost {n}`);
        assert.ok(value.includes('{m}'), `${lang}.summaryLoaded lost {m}`);
    }
});

test('t returns the string for a known locale and key', () => {
    assert.equal(t('en', 'startBtn'), translations.en.startBtn);
    assert.equal(t('fa', 'startBtn'), translations.fa.startBtn);
});

test('t returns undefined for an unknown locale or key', () => {
    assert.equal(t('de', 'startBtn'), undefined);
    assert.equal(t('en', 'nope'), undefined);
});

test('interpolate substitutes named placeholders', () => {
    assert.equal(interpolate('{n} links loaded · {m} skipped', { n: 227, m: 5 }),
        '227 links loaded · 5 skipped');
});

test('interpolate leaves placeholders with no matching variable untouched', () => {
    assert.equal(interpolate('{n} of {m}', { n: 1 }), '1 of {m}');
});

test('interpolate replaces every occurrence of a placeholder', () => {
    assert.equal(interpolate('{n}/{n}', { n: 3 }), '3/3');
});

test('interpolate is a no-op without variables', () => {
    assert.equal(interpolate('{n} found'), '{n} found');
    assert.equal(interpolate('plain', {}), 'plain');
});

test('interpolate does not treat a substituted value as a placeholder pattern', () => {
    assert.equal(interpolate('{a}', { a: '{b}', b: 'nested' }), '{b}');
});
