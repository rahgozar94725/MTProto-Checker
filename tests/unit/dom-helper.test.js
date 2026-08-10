// Guards the contract of tests/helpers/dom.js. Every DOM-level suite (render,
// lifecycle) mounts the app through that helper, so a silent regression here --
// a missing shim, a leaked global, a stale localStorage entry -- would show up
// as a confusing failure somewhere else. Pin it once, here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountApp } from '../helpers/dom.js';
import { translations } from '../../public/js/i18n.js';

const indexHtml = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

test('mounts the app and boots it in Persian by default', async () => {
    const app = await mountApp();
    try {
        const startBtn = app.document.getElementById('startBtn');
        assert.ok(startBtn, '#startBtn should exist');
        // The label is written through innerText, which jsdom does not implement --
        // reading it back proves the shim is installed before app.js runs.
        assert.equal(startBtn.textContent, translations.fa.startBtn);
        assert.equal(app.document.documentElement.getAttribute('dir'), 'rtl');
        assert.equal(app.document.documentElement.lang, 'fa');
    } finally {
        app.cleanup();
    }
});

test('loads the real public/index.html rather than an inline copy', async () => {
    const app = await mountApp();
    try {
        const onDisk = (indexHtml.match(/data-i18n=/g) || []).length;
        assert.ok(onDisk > 0, 'index.html should carry data-i18n attributes');
        assert.equal(app.document.querySelectorAll('[data-i18n]').length, onDisk);
    } finally {
        app.cleanup();
    }
});

test('seeds localStorage before the app boots', async () => {
    const app = await mountApp({ storage: { lang: 'en', theme: 'light' } });
    try {
        assert.equal(app.document.getElementById('startBtn').textContent, translations.en.startBtn);
        assert.equal(app.document.documentElement.getAttribute('dir'), 'ltr');
        assert.equal(app.document.documentElement.getAttribute('data-theme'), 'light');
    } finally {
        app.cleanup();
    }
});

test('requestAnimationFrame is controllable, not timer-based', async () => {
    const app = await mountApp();
    try {
        const order = [];
        app.window.requestAnimationFrame(() => order.push('a'));
        app.window.requestAnimationFrame(() => order.push('b'));
        assert.deepEqual(order, [], 'callbacks must not run before an explicit flush');
        app.flushFrames();
        assert.deepEqual(order, ['a', 'b']);
        app.flushFrames();
        assert.deepEqual(order, ['a', 'b'], 'a flush must not re-run drained callbacks');
    } finally {
        app.cleanup();
    }
});

test('a frame scheduled from inside a frame runs in the same flush', async () => {
    const app = await mountApp();
    try {
        const order = [];
        app.window.requestAnimationFrame(() => {
            order.push('outer');
            app.window.requestAnimationFrame(() => order.push('inner'));
        });
        app.flushFrames();
        assert.deepEqual(order, ['outer', 'inner']);
    } finally {
        app.cleanup();
    }
});

test('stubs the browser APIs jsdom lacks', async () => {
    const app = await mountApp();
    try {
        await app.window.navigator.clipboard.writeText('hello');
        assert.deepEqual(app.recorded.clipboard, ['hello']);

        app.window.alert('boom');
        assert.deepEqual(app.recorded.alerts, ['boom']);

        app.window.open('https://example.invalid/', '_blank');
        assert.deepEqual(app.recorded.opened, ['https://example.invalid/']);

        const url = app.window.URL.createObjectURL(new app.window.Blob(['x']));
        assert.match(url, /^blob:/);
        assert.equal(app.recorded.objectURLs.length, 1);
        assert.equal(app.recorded.objectURLs[0].url, url);
        assert.equal(await app.recorded.objectURLs[0].blob.text(), 'x');

        new app.window.AudioContext();
        assert.equal(app.recorded.audioContexts, 1);

        // jsdom implements neither alert nor confirm; unstubbed, confirm answers undefined,
        // which reads as cancel and would silently disable every guarded action.
        assert.equal(app.window.confirm('sure?'), true);
        assert.deepEqual(app.recorded.confirms, ['sure?']);
    } finally {
        app.cleanup();
    }
});

test('confirm answers what the mount was told to answer', async () => {
    const app = await mountApp({ confirm: false });
    try {
        assert.equal(app.window.confirm('sure?'), false);
        assert.deepEqual(app.recorded.confirms, ['sure?'], 'a cancelled question is still recorded');
    } finally {
        app.cleanup();
    }
});

test('fetch is stubbed and the default stub refuses to reach the network', async () => {
    const app = await mountApp();
    try {
        await assert.rejects(() => app.window.fetch('/check-stream', { method: 'POST' }), /not stubbed/);
        assert.equal(app.recorded.fetches.length, 1);
        assert.equal(app.recorded.fetches[0].url, '/check-stream');
    } finally {
        app.cleanup();
    }
});

test('an injected fetch replaces the default stub', async () => {
    const calls = [];
    const app = await mountApp({
        fetch: async (url, init) => {
            calls.push({ url, init });
            return { ok: true };
        }
    });
    try {
        const res = await app.window.fetch('/check-stream', { method: 'POST' });
        assert.equal(res.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/check-stream');
    } finally {
        app.cleanup();
    }
});

test('cleanup restores the globals it installed', async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const app = await mountApp();
    assert.equal(globalThis.document, app.document, 'app.js reads bare globals, so they must be installed');
    app.cleanup();
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), before);
});

test('mounts are isolated: state does not leak between them', async () => {
    const first = await mountApp();
    first.window.localStorage.setItem('lang', 'ru');
    first.document.getElementById('inputProxies').value = 'tg://proxy?server=192.0.2.1&port=443&secret=dd00';
    first.cleanup();

    const second = await mountApp();
    try {
        // Boot re-persists the default, so the tell of a leak is the previous
        // mount's value surviving -- not the key being absent.
        assert.equal(second.window.localStorage.getItem('lang'), 'fa', 'localStorage must be cleared between mounts');
        assert.equal(second.document.getElementById('startBtn').textContent, translations.fa.startBtn);
        assert.equal(second.document.getElementById('inputProxies').value, '');
    } finally {
        second.cleanup();
    }
});
