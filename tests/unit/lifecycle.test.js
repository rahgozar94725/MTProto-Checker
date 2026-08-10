// Scan lifecycle: startCheck → progress → finish, plus pause, resume and stop.
//
// app.js exports nothing — every control is bound with addEventListener at boot — so this
// suite drives the app the way a user does: it types into #inputProxies and clicks the real
// buttons, then asserts on the DOM and on what the stubbed fetch was asked to send.
//
// The stub answers /check-stream with a ReadableStream the test feeds frame by frame, which
// is what makes pause reproducible: aborting the request signal errors the stream exactly
// as a real fetch does, and that AbortError is the only thing runCheckStream keys on to
// tell a pause from a completed scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountApp } from '../helpers/dom.js';
import { body, progressFrame, doneFrame } from '../helpers/sse.js';
import { translations, interpolate } from '../../public/js/i18n.js';
import { DEFAULT_SOURCES, SNAPSHOT_SOURCE_URL, shortUrl } from '../../public/js/sources.js';

const fa = translations.fa;
const encoder = new TextEncoder();

// Captured before any mount: mountApp replaces globalThis.setTimeout with an unref'ing
// wrapper, and a timer that cannot hold the event loop open is no good for polling.
const nodeSetTimeout = globalThis.setTimeout;

function link(server, port = 443, secret = 'dd0102030405060708090a0b0c0d0e0f10') {
    return `tg://proxy?server=${server}&port=${port}&secret=${secret}`;
}

// The payload shape /check-stream writes per checked proxy (main.go:495).
function progress({ server, port = 443, secret = 'dd0102030405060708090a0b0c0d0e0f10', ok = false, ping, completed, total, working = 0 }) {
    const payload = { completed, total, working, server, port, secret, ok };
    if (ping !== undefined) payload.ping = ping;
    return progressFrame(payload);
}

// A response stream the test controls. Aborting the signal errors it, so the pending
// reader.read() rejects with AbortError just as fetch would.
function openStream(signal) {
    let controller;
    let closed = false;
    const stream = new ReadableStream({ start(c) { controller = c; } });

    if (signal) {
        signal.addEventListener('abort', () => {
            if (closed) return;
            closed = true;
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            controller.error(err);
        });
    }

    return {
        stream,
        push(text) { if (!closed) controller.enqueue(encoder.encode(text)); },
        close() { if (!closed) { closed = true; controller.close(); } },
    };
}

// Answers with a fixed body and closes: the scan runs to completion on its own.
function respondWith(text) {
    return async (_url, init) => {
        const stream = openStream(init.signal);
        stream.push(text);
        stream.close();
        return { ok: true, body: stream.stream };
    };
}

// The snapshot the Load-list button fetches. Two links, RFC 5737 addresses, and the
// `#seen=…;src=…` fragment the writer appends — which is exactly what must never reach the
// textarea, an export or the clipboard.
const SNAPSHOT_SECRETS = ['ee1a2b3c4d5e6f708192a3b4c5d6e7f8', 'ee2b3c4d5e6f708192a3b4c5d6e7f809'];
const SNAPSHOT_LINKS = [
    link('192.0.2.10', 443, SNAPSHOT_SECRETS[0]),
    link('198.51.100.20', 8443, SNAPSHOT_SECRETS[1]),
];
const SNAPSHOT_GENERATED_AT = '2026-08-09T03:17:00.000Z';
// The header names two of the real built-in sources, shortened exactly as the writer shortens
// them: scoring joins a header back onto the source model by url, so a header naming lists
// nobody has heard of would credit nothing and prove nothing.
const SNAPSHOT_TEXT = [
    `# generated ${SNAPSHOT_GENERATED_AT} by scripts/build-snapshot.mjs`,
    `# 0 ${shortUrl(DEFAULT_SOURCES[0])}`,
    `# 1 ${shortUrl(DEFAULT_SOURCES[1])}`,
    `${SNAPSHOT_LINKS[0]}#seen=1;src=0`,
    `${SNAPSHOT_LINKS[1]}#seen=2;src=0,1`,
    '',
].join('\n');

// A copy the live fetch must never be allowed to stand in for: same grammar, different link,
// so which of the two steps answered is readable straight off the textarea.
const BAKED_LINK = link('203.0.113.50', 443, 'ee6f708192a3b4c5d6e7f8091a2b3c4d');
const BAKED_TEXT = [
    `# generated ${SNAPSHOT_GENERATED_AT} by scripts/build-snapshot.mjs`,
    `# 0 ${shortUrl(DEFAULT_SOURCES[0])}`,
    `${BAKED_LINK}#seen=1;src=0`,
    '',
].join('\n');

// A source only this user has: the snapshot is built from the built-ins, so a user-added list
// is the one thing the button has to fetch on its own.
const USER_SOURCE = 'https://example.invalid/list.txt';
const USER_LINK = link('203.0.113.60', 443, 'ee708192a3b4c5d6e7f8091a2b3c4d5e');
const STORED_USER_SOURCE = JSON.stringify([{ url: USER_SOURCE, enabled: true }]);

function textResponse(text) {
    if (text === null) return { ok: false, status: 502, text: async () => '' };
    return { ok: true, status: 200, text: async () => text };
}

// The Load-list button's three steps, each routable on its own: the live snapshot and the user
// sources through POST /fetch-sources, the baked copy off /data/snapshot.txt, and the scan.
// A step left null answers as a failure.
function respondToLoad({ live = null, baked = null, userSources = null, scan = respondWith('') } = {}) {
    return async (url, init) => {
        const target = String(url);
        if (target === '/fetch-sources') {
            const { urls } = JSON.parse(init.body);
            return textResponse(urls.includes(SNAPSHOT_SOURCE_URL) ? live : userSources);
        }
        if (target.includes('snapshot.txt')) return textResponse(baked);
        return scan(url, init);
    };
}

// The ordinary case: the same snapshot answers whichever of the two steps gets there.
function respondToSnapshot(snapshot, scan = respondWith('')) {
    return respondToLoad({ live: snapshot, baked: snapshot, scan });
}

function localizedDate(lang, iso) {
    return new Date(iso).toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' });
}

// Hands every request back to the test, so a scan can be held open mid-flight.
function respondManually(requests) {
    return async (_url, init) => {
        const stream = openStream(init.signal);
        requests.push({ init, push: stream.push, close: stream.close });
        return { ok: true, body: stream.stream };
    };
}

async function waitFor(predicate, what) {
    for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await new Promise(resolve => nodeSetTimeout(resolve, 0));
    }
    throw new Error(`timed out waiting for ${what}`);
}

function tick() {
    return new Promise(resolve => nodeSetTimeout(resolve, 0));
}

function click(app, id) {
    app.document.getElementById(id).click();
}

function paste(app, ...lines) {
    app.document.getElementById('inputProxies').value = lines.join('\n');
}

const toastText = app => app.document.getElementById('toast').textContent;
const checkedTile = app => app.document.getElementById('tileChecked').textContent;
const rows = app => [...app.document.querySelectorAll('#resultsBody tr')];
const isIdle = app => app.document.getElementById('startBtn').textContent === fa.startBtn;
const isScanning = app => app.document.body.classList.contains('scanning');

test('an empty input toasts and posts nothing', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        click(app, 'startBtn');
        await tick();

        assert.equal(app.recorded.fetches.length, 0);
        assert.equal(toastText(app), fa.toastEmpty);
        assert.match(app.document.getElementById('toast').className, /error/);
        assert.equal(isScanning(app), false);
    } finally {
        app.cleanup();
    }
});

test('a paste with no valid link toasts and posts nothing', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        paste(app, 'not a link at all', 'tg://proxy?server=192.0.2.1&port=99999&secret=dd01', 'https://example.com/');
        click(app, 'startBtn');
        await tick();

        assert.equal(app.recorded.fetches.length, 0);
        assert.equal(toastText(app), fa.toastNoValid);
        assert.equal(isScanning(app), false);
    } finally {
        app.cleanup();
    }
});

test('a scan posts X-Concurrency and a per-proxy timeout matching the selects', async () => {
    const app = await mountApp({ fetch: respondWith(body([doneFrame()])) });
    try {
        app.document.getElementById('concurrencySelect').value = '20';
        app.document.getElementById('timeoutSelect').value = '10';
        paste(app, link('192.0.2.10'), link('192.0.2.11', 8443, 'ee0102030405060708090a0b0c0d0e0f10'));
        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        assert.equal(app.recorded.fetches.length, 1);
        const { url, init } = app.recorded.fetches[0];
        assert.equal(url, '/check-stream');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['X-Concurrency'], '20');
        assert.deepEqual(JSON.parse(init.body), [
            { server: '192.0.2.10', port: 443, secret: 'dd0102030405060708090a0b0c0d0e0f10', timeout: 10 },
            { server: '192.0.2.11', port: 8443, secret: 'ee0102030405060708090a0b0c0d0e0f10', timeout: 10 },
        ]);
    } finally {
        app.cleanup();
    }
});

test('working results land in the table sorted ascending by ping', async () => {
    const stream = body([
        progress({ server: '192.0.2.10', ok: true, ping: 300, completed: 1, total: 3, working: 1 }),
        progress({ server: '192.0.2.11', ok: true, ping: 100, completed: 2, total: 3, working: 2 }),
        progress({ server: '192.0.2.12', ok: false, completed: 3, total: 3, working: 2 }),
        doneFrame({ completed: 3 }),
    ]);
    const app = await mountApp({ fetch: respondWith(stream) });
    try {
        paste(app, link('192.0.2.10'), link('192.0.2.11'), link('192.0.2.12'));
        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');
        app.flushFrames();

        assert.deepEqual(rows(app).map(tr => tr.querySelectorAll('td')[1].textContent), ['192.0.2.11', '192.0.2.10']);
        assert.deepEqual(rows(app).map(tr => tr.querySelector('.ping').textContent), ['100 ms', '300 ms']);
        assert.equal(app.document.getElementById('tileWorking').textContent, '2');
        assert.equal(app.document.getElementById('tileBest').textContent, '100 ms');
        assert.equal(app.document.getElementById('tileFailed').textContent, '1');

        // The plain-text view is written from the same sorted list, secrets intact.
        assert.deepEqual(app.document.getElementById('outputProxies').value.split('\n\n'), [
            `${link('192.0.2.11')} # Ping: 100ms`,
            `${link('192.0.2.10')} # Ping: 300ms`,
        ]);
    } finally {
        app.cleanup();
    }
});

test('results survive a stop and the input pane comes back', async () => {
    const requests = [];
    const app = await mountApp({ fetch: respondManually(requests) });
    try {
        paste(app, link('192.0.2.10'), link('192.0.2.11'));
        click(app, 'startBtn');
        await waitFor(() => requests.length === 1, 'the scan to start');
        assert.equal(isScanning(app), true);

        requests[0].push(progress({ server: '192.0.2.10', ok: true, ping: 120, completed: 1, total: 2, working: 1 }));
        await waitFor(() => checkedTile(app) === '1', 'the first result');

        click(app, 'startBtn');   // the Start button is a Stop button mid-scan
        await tick();
        app.flushFrames();

        assert.equal(requests[0].init.signal.aborted, true);
        assert.equal(isScanning(app), false, 'the input pane is restored');
        assert.equal(isIdle(app), true);
        assert.equal(app.document.getElementById('pauseBtn').style.display, 'none');
        assert.equal(rows(app).length, 1, 'the result found before the stop survives it');
        assert.equal(app.document.getElementById('tileWorking').textContent, '1');
    } finally {
        app.cleanup();
    }
});

test('pause aborts in flight, keeps the input collapsed, and resume re-posts only unchecked proxies', async () => {
    const requests = [];
    const app = await mountApp({ fetch: respondManually(requests) });
    try {
        paste(app, link('192.0.2.10'), link('192.0.2.11'), link('192.0.2.12'));
        click(app, 'startBtn');
        await waitFor(() => requests.length === 1, 'the scan to start');

        requests[0].push(progress({ server: '192.0.2.10', ok: false, completed: 1, total: 3 }));
        await waitFor(() => checkedTile(app) === '1', 'the first result');

        click(app, 'pauseBtn');
        await tick();

        assert.equal(requests[0].init.signal.aborted, true, 'pause aborts the in-flight request');
        assert.equal(isScanning(app), true, 'pause leaves the input collapsed');
        assert.equal(app.document.getElementById('pauseBtn').textContent, fa.resumeBtn);
        assert.equal(isIdle(app), false, 'a paused scan is not idle');
        assert.equal(requests.length, 1, 'pause posts nothing');

        click(app, 'pauseBtn');
        await waitFor(() => requests.length === 2, 'the resumed request');

        assert.equal(app.document.getElementById('pauseBtn').textContent, fa.pauseBtn);
        assert.deepEqual(JSON.parse(requests[1].init.body).map(p => p.server), ['192.0.2.11', '192.0.2.12']);

        requests[1].push(progress({ server: '192.0.2.11', ok: false, completed: 1, total: 2 }));
        requests[1].push(progress({ server: '192.0.2.12', ok: false, completed: 2, total: 2 }));
        requests[1].push(doneFrame({ completed: 2 }));
        requests[1].close();
        await waitFor(() => isIdle(app), 'the resumed scan to finish');

        assert.equal(checkedTile(app), '3', 'the resumed scan continues the original count');
        assert.equal(isScanning(app), false);
    } finally {
        app.cleanup();
    }
});

test('finishing with no working proxy toasts and does not beep', async () => {
    const stream = body([
        progress({ server: '192.0.2.10', ok: false, completed: 1, total: 1 }),
        doneFrame({ completed: 1 }),
    ]);
    const app = await mountApp({ fetch: respondWith(stream) });
    try {
        app.document.getElementById('soundCheck').checked = true;   // enabled, and still silent
        paste(app, link('192.0.2.10'));
        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        assert.equal(toastText(app), fa.toastNoWorking);
        assert.match(app.document.getElementById('toast').className, /error/);
        assert.equal(app.recorded.audioContexts, 0);
    } finally {
        app.cleanup();
    }
});

test('finishing with a working proxy toasts the count and beeps when sound is on', async () => {
    const stream = body([
        progress({ server: '192.0.2.10', ok: true, ping: 90, completed: 1, total: 1, working: 1 }),
        doneFrame({ completed: 1 }),
    ]);
    const app = await mountApp({ fetch: respondWith(stream) });
    try {
        app.document.getElementById('soundCheck').checked = true;
        paste(app, link('192.0.2.10'));
        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        assert.equal(toastText(app), interpolate(fa.toastFound, { n: 1 }));
        assert.doesNotMatch(app.document.getElementById('toast').className, /error/);
        assert.equal(app.recorded.audioContexts, 1);
    } finally {
        app.cleanup();
    }
});

test('the load-list button fills the input with fragment-free links and shows the date', async () => {
    const app = await mountApp({ fetch: respondToSnapshot(SNAPSHOT_TEXT) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), SNAPSHOT_LINKS);
        assert.doesNotMatch(app.document.getElementById('inputProxies').value, /#seen=/);
        assert.equal(app.recorded.fetches[0].url, '/fetch-sources');

        // The generation date is on the page without opening anything, in the active locale.
        assert.equal(
            app.document.getElementById('snapshotMeta').textContent,
            interpolate(fa.snapshotDate, { date: localizedDate('fa', SNAPSHOT_GENERATED_AT) })
        );

        // …and follows a language change, since it is written by JS, not by [data-i18n].
        const langSelect = app.document.getElementById('langSelect');
        langSelect.value = 'ru';
        langSelect.dispatchEvent(new app.window.Event('change'));
        assert.equal(
            app.document.getElementById('snapshotMeta').textContent,
            interpolate(translations.ru.snapshotDate, { date: localizedDate('ru', SNAPSHOT_GENERATED_AT) })
        );
    } finally {
        app.cleanup();
    }
});

test('the load-list button asks the server for the nightly snapshot before touching the embed', async () => {
    const app = await mountApp({ fetch: respondToLoad({ live: SNAPSHOT_TEXT, baked: BAKED_TEXT }) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), SNAPSHOT_LINKS,
            'the live snapshot is what fills the textarea, not the baked copy');

        const [first] = app.recorded.fetches;
        assert.equal(first.url, '/fetch-sources');
        assert.equal(first.init.method, 'POST');
        assert.deepEqual(JSON.parse(first.init.body).urls, [SNAPSHOT_SOURCE_URL]);
        assert.ok(!app.recorded.fetches.some(f => f.url.includes('snapshot.txt')),
            'the embed is a fallback, not a second request');
    } finally {
        app.cleanup();
    }
});

test('a failed live fetch falls back to the copy baked into the binary', async () => {
    const app = await mountApp({ fetch: respondToLoad({ live: null, baked: BAKED_TEXT }) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), [BAKED_LINK]);
        assert.equal(toastText(app), interpolate(fa.toastSnapshotLoaded, { n: 1 }));
        assert.doesNotMatch(app.document.getElementById('toast').className, /error/);

        // A network the live fetch cannot cross is the case this feature exists for, so the
        // fallback is a log line and not an error that throws the drawer open.
        assert.equal(app.document.querySelectorAll('#console .error-log').length, 0);
        assert.equal(app.document.getElementById('consoleDrawer').open, false);
        assert.match(app.document.getElementById('console').textContent, /LIVE SNAPSHOT/);
    } finally {
        app.cleanup();
    }
});

test('a user-added source is fetched after the snapshot and deduped against it', async () => {
    const app = await mountApp({
        fetch: respondToLoad({
            live: SNAPSHOT_TEXT,
            // The second line is a link the snapshot already published: two lists carrying the
            // same proxy must not put it in the textarea twice.
            userSources: [USER_LINK, SNAPSHOT_LINKS[0]].join('\n'),
        }),
        storage: { sources: STORED_USER_SOURCE },
    });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'),
            [...SNAPSHOT_LINKS, USER_LINK]);

        // Two requests, in the documented order, and the built-ins are not among them: they are
        // what the nightly snapshot is built from.
        assert.deepEqual(
            app.recorded.fetches.filter(f => f.url === '/fetch-sources').map(f => JSON.parse(f.init.body).urls),
            [[SNAPSHOT_SOURCE_URL], [USER_SOURCE]]
        );
    } finally {
        app.cleanup();
    }
});

test('a disabled user source is not fetched at all', async () => {
    const app = await mountApp({
        fetch: respondToLoad({ live: SNAPSHOT_TEXT, userSources: USER_LINK }),
        storage: { sources: JSON.stringify([{ url: USER_SOURCE, enabled: false }]) },
    });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), SNAPSHOT_LINKS);
        assert.equal(app.recorded.fetches.filter(f => f.url === '/fetch-sources').length, 1);
    } finally {
        app.cleanup();
    }
});

test('a user source that fails does not cost the snapshot that succeeded', async () => {
    const app = await mountApp({
        fetch: respondToLoad({ live: SNAPSHOT_TEXT, userSources: null }),
        storage: { sources: STORED_USER_SOURCE },
    });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), SNAPSHOT_LINKS);
        assert.equal(toastText(app), interpolate(fa.toastSnapshotLoaded, { n: SNAPSHOT_LINKS.length }));

        const errors = [...app.document.querySelectorAll('#console .error-log')];
        assert.equal(errors.length, 1);
        assert.match(errors[0].textContent, /USER SOURCES/);
    } finally {
        app.cleanup();
    }
});

test('a disabled built-in keeps its exclusive links out of the load', async () => {
    const app = await mountApp({
        fetch: respondToLoad({ live: SNAPSHOT_TEXT }),
        // SNAPSHOT_TEXT publishes link 0 from source 0 alone and link 1 from both.
        storage: { sources: JSON.stringify([{ url: DEFAULT_SOURCES[0], enabled: false }]) },
    });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), [SNAPSHOT_LINKS[1]],
            'the link the other source also publishes stays');
        assert.equal(toastText(app), interpolate(fa.toastSnapshotLoaded, { n: 1 }));
        assert.match(app.document.getElementById('console').textContent, /Dropped 1 link/);
    } finally {
        app.cleanup();
    }
});

test('disabling every source leaves nothing to load, and says so', async () => {
    const app = await mountApp({
        fetch: respondToLoad({ live: SNAPSHOT_TEXT }),
        storage: { sources: JSON.stringify(DEFAULT_SOURCES.map(url => ({ url, enabled: false }))) },
    });
    try {
        paste(app, link('192.0.2.99'));
        click(app, 'loadListBtn');
        await waitFor(() => toastText(app) !== '', 'the failure toast');

        assert.equal(app.document.getElementById('inputProxies').value, link('192.0.2.99'),
            'an empty load must not cost the user their paste');

        const errors = [...app.document.querySelectorAll('#console .error-log')];
        assert.equal(errors.length, 1);
        assert.match(errors[0].textContent, /Dropped 2 links/);
        assert.equal(app.document.getElementById('consoleDrawer').open, true);
    } finally {
        app.cleanup();
    }
});

// --- the SOCKS5 proxy the server fetches through -------------------------------------

function typeInto(app, id, value) {
    const field = app.document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new app.window.Event('change'));
}

const postedTo = (app, url) => app.recorded.fetches.filter(f => f.url === url).map(f => JSON.parse(f.init.body));

test('a SOCKS5 address rides every fetch-sources request and persists', async () => {
    const app = await mountApp({
        fetch: respondToLoad({ live: SNAPSHOT_TEXT, userSources: USER_LINK }),
        storage: { sources: STORED_USER_SOURCE },
    });
    try {
        typeInto(app, 'socks5Addr', '127.0.0.1:9050');
        typeInto(app, 'socks5User', 'tor');
        typeInto(app, 'socks5Pass', 'hunter2');

        assert.equal(app.window.localStorage.getItem('socks5Addr'), '127.0.0.1:9050');
        assert.equal(app.window.localStorage.getItem('socks5User'), 'tor');
        assert.equal(app.window.localStorage.getItem('socks5Pass'), 'hunter2');

        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        // Both steps, not just the snapshot: a user's own source is on the same network.
        const proxy = { addr: '127.0.0.1:9050', user: 'tor', pass: 'hunter2' };
        assert.deepEqual(postedTo(app, '/fetch-sources').map(b => b.socks5), [proxy, proxy]);
    } finally {
        app.cleanup();
    }
});

test('an empty SOCKS5 address leaves the request carrying no proxy at all', async () => {
    const app = await mountApp({ fetch: respondToLoad({ live: SNAPSHOT_TEXT }) });
    try {
        // A username with no address is the half-filled form: the server reads an empty addr as
        // direct-only, so sending the rest of it would be noise.
        typeInto(app, 'socks5User', 'tor');

        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        const [body] = postedTo(app, '/fetch-sources');
        assert.ok(!('socks5' in body), 'no proxy configured means no socks5 key');
    } finally {
        app.cleanup();
    }
});

test('stored SOCKS5 settings come back in the fields on the next boot', async () => {
    const app = await mountApp({
        fetch: respondWith(''),
        storage: { socks5Addr: '10.0.0.1:1080', socks5User: 'u', socks5Pass: 'p' },
    });
    try {
        assert.equal(app.document.getElementById('socks5Addr').value, '10.0.0.1:1080');
        assert.equal(app.document.getElementById('socks5User').value, 'u');
        assert.equal(app.document.getElementById('socks5Pass').value, 'p');
    } finally {
        app.cleanup();
    }
});

test('the plaintext-password warning is on the page and follows a language change', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        const warning = app.document.getElementById('socks5Warning');
        assert.equal(warning.textContent, fa.socks5Warning);

        const langSelect = app.document.getElementById('langSelect');
        langSelect.value = 'zh';
        langSelect.dispatchEvent(new app.window.Event('change'));
        assert.equal(warning.textContent, translations.zh.socks5Warning);
    } finally {
        app.cleanup();
    }
});

test('a failed snapshot fetch toasts, logs an error, and leaves the textarea untouched', async () => {
    const app = await mountApp({ fetch: respondToSnapshot(null) });
    try {
        paste(app, link('192.0.2.99'));
        click(app, 'loadListBtn');
        await waitFor(() => toastText(app) !== '', 'the failure toast');

        assert.equal(toastText(app), fa.toastSnapshotFailed);
        assert.match(app.document.getElementById('toast').className, /error/);
        assert.equal(app.document.getElementById('inputProxies').value, link('192.0.2.99'),
            'a failed load must not cost the user their paste');
        assert.equal(app.document.getElementById('snapshotMeta').textContent, '');

        const errors = [...app.document.querySelectorAll('#console .error-log')];
        assert.equal(errors.length, 1, 'one error line, not a stack of them');
        assert.match(errors[0].textContent, /SNAPSHOT ERROR/);
    } finally {
        app.cleanup();
    }
});

test('a snapshot-fed scan exports and copies with no #seen= anywhere', async () => {
    const stream = body([
        progress({ server: '192.0.2.10', secret: SNAPSHOT_SECRETS[0], ok: true, ping: 90, completed: 1, total: 2, working: 1 }),
        progress({ server: '198.51.100.20', port: 8443, secret: SNAPSHOT_SECRETS[1], ok: true, ping: 140, completed: 2, total: 2, working: 2 }),
        doneFrame({ completed: 2 }),
    ]);
    const app = await mountApp({ fetch: respondToSnapshot(SNAPSHOT_TEXT, respondWith(stream)) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');
        app.flushFrames();

        assert.equal(rows(app).length, 2);
        assert.doesNotMatch(app.document.getElementById('outputProxies').value, /#seen=/);

        click(app, 'exportTxtBtn');
        click(app, 'exportJsonBtn');
        assert.equal(app.recorded.objectURLs.length, 2);
        const [txt, json] = await Promise.all(app.recorded.objectURLs.map(o => o.blob.text()));

        assert.doesNotMatch(txt, /#seen=/);
        assert.doesNotMatch(json, /#seen=/);
        assert.ok(txt.includes(SNAPSHOT_LINKS[0]), 'the exported link is the published one');
        assert.deepEqual(JSON.parse(json).map(p => p.link), [SNAPSHOT_LINKS[0], SNAPSHOT_LINKS[1]]);

        app.document.querySelector('#resultsBody .rowcopy').click();
        await tick();
        assert.equal(app.recorded.clipboard.length, 1);
        assert.doesNotMatch(app.recorded.clipboard[0], /#seen=/);
        assert.ok(app.recorded.clipboard[0].startsWith(SNAPSHOT_LINKS[0]));
    } finally {
        app.cleanup();
    }
});

test('a snapshot-fed scan tags its results with their sources and leaves a pasted one bare', async () => {
    const PASTED = link('203.0.113.30', 443, 'ee3c4d5e6f708192a3b4c5d6e7f8091a');
    const stream = body([
        progress({ server: '192.0.2.10', secret: SNAPSHOT_SECRETS[0], ok: true, ping: 90, completed: 1, total: 3, working: 1 }),
        progress({ server: '198.51.100.20', port: 8443, secret: SNAPSHOT_SECRETS[1], ok: true, ping: 140, completed: 2, total: 3, working: 2 }),
        progress({ server: '203.0.113.30', secret: 'ee3c4d5e6f708192a3b4c5d6e7f8091a', ok: true, ping: 200, completed: 3, total: 3, working: 3 }),
        doneFrame({ completed: 3 }),
    ]);
    const app = await mountApp({ fetch: respondToSnapshot(SNAPSHOT_TEXT, respondWith(stream)) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        // A link the snapshot never mentioned, appended to what the button loaded.
        app.document.getElementById('inputProxies').value += `\n${PASTED}`;

        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');
        app.flushFrames();

        // Rows are sorted by ping: the two snapshot links, then the pasted one.
        assert.deepEqual(rows(app).map(tr => tr.dataset.srcs), ['0', '0,1', undefined]);

        // Attribution is display state only -- Decision 6 keeps it out of every artifact.
        click(app, 'exportJsonBtn');
        const json = JSON.parse(await app.recorded.objectURLs[0].blob.text());
        assert.deepEqual(json.map(p => Object.keys(p).sort()), [
            ['link', 'ping'], ['link', 'ping'], ['link', 'ping'],
        ]);
    } finally {
        app.cleanup();
    }
});

test('five results in one tick queue exactly one render', async () => {
    const requests = [];
    const app = await mountApp({ fetch: respondManually(requests) });
    try {
        const servers = ['192.0.2.10', '192.0.2.11', '192.0.2.12', '192.0.2.13', '192.0.2.14'];
        paste(app, ...servers.map(s => link(s)));
        click(app, 'startBtn');
        await waitFor(() => requests.length === 1, 'the scan to start');

        // startCheck queues a render of its own to clear the previous results; drain it so
        // the count below can only come from the progress burst.
        app.flushFrames();
        assert.equal(app.pendingFrames(), 0);

        // One chunk, so every frame is handled inside a single reader.read().
        requests[0].push(body(servers.map((server, i) =>
            progress({ server, ok: true, ping: 100 + i, completed: i + 1, total: 5, working: i + 1 })
        )));
        await waitFor(() => checkedTile(app) === '5', 'all five results');

        assert.equal(app.pendingFrames(), 1, 'five results coalesce into one queued render');
        assert.equal(rows(app).length, 0, 'nothing is rendered before the frame runs');

        app.flushFrames();
        assert.equal(rows(app).length, 5);
    } finally {
        app.cleanup();
    }
});

// --- the source list, its scores, and the scan order they decide ---------------------

// Two links seen once each, one per source, so nothing but the source scores can order them.
const TIE_SECRETS = ['ee4d5e6f708192a3b4c5d6e7f8091a2b', 'ee5e6f708192a3b4c5d6e7f8091a2b3c'];
const TIE_LINKS = [link('192.0.2.40', 443, TIE_SECRETS[0]), link('192.0.2.41', 443, TIE_SECRETS[1])];
const TIE_SNAPSHOT = [
    `# generated ${SNAPSHOT_GENERATED_AT} by scripts/build-snapshot.mjs`,
    `# 0 ${shortUrl(DEFAULT_SOURCES[0])}`,
    `# 1 ${shortUrl(DEFAULT_SOURCES[1])}`,
    `${TIE_LINKS[0]}#seen=1;src=0`,
    `${TIE_LINKS[1]}#seen=1;src=1`,
    '',
].join('\n');

// A stored list where the second source is the one that has ever worked.
function storedScores({ secondEnabled = true } = {}) {
    return JSON.stringify([
        { url: DEFAULT_SOURCES[0], enabled: true, score: { linksProvided: 10, linksWorking: 0, lastScan: 'once' } },
        { url: DEFAULT_SOURCES[1], enabled: secondEnabled, score: { linksProvided: 10, linksWorking: 5, lastScan: 'once' } },
    ]);
}

const sourceRows = app => [...app.document.querySelectorAll('#sourcesList .source-row')];
const sourceBoxes = app => sourceRows(app).map(row => row.querySelector('input'));
const sourceDetails = app => sourceRows(app).map(row => row.querySelector('.source-detail').textContent);
const storedSources = app => JSON.parse(app.window.localStorage.getItem('sources'));

test('the source list boots with every built-in enabled and unscored', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        assert.equal(sourceRows(app).length, DEFAULT_SOURCES.length);
        assert.deepEqual(sourceBoxes(app).map(box => box.checked), DEFAULT_SOURCES.map(() => true));
        assert.deepEqual(sourceRows(app).map(row => row.querySelector('.source-name').textContent),
            DEFAULT_SOURCES.map(shortUrl));
        assert.deepEqual(sourceDetails(app), DEFAULT_SOURCES.map(() => fa.sourceUnscored));
    } finally {
        app.cleanup();
    }
});

test('disabling a source persists it, and it comes back disabled on the next boot', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    let stored;
    try {
        sourceBoxes(app)[1].click();
        await tick();

        stored = app.window.localStorage.getItem('sources');
        assert.equal(storedSources(app).find(s => s.url === DEFAULT_SOURCES[1]).enabled, false);
        assert.equal(sourceBoxes(app)[1].checked, false, 'the row redraws in its new state');
        assert.equal(sourceBoxes(app)[0].checked, true, 'and nothing else moved');
    } finally {
        app.cleanup();
    }

    const reloaded = await mountApp({ fetch: respondWith(''), storage: { sources: stored } });
    try {
        assert.deepEqual(sourceBoxes(reloaded).map(box => box.checked),
            DEFAULT_SOURCES.map((_, i) => i !== 1));
    } finally {
        reloaded.cleanup();
    }
});

test('a stored source list the app cannot read resolves to the defaults instead of breaking boot', async () => {
    const app = await mountApp({ fetch: respondWith(''), storage: { sources: '{not json at all' } });
    try {
        assert.equal(sourceRows(app).length, DEFAULT_SOURCES.length);
        assert.deepEqual(sourceBoxes(app).map(box => box.checked), DEFAULT_SOURCES.map(() => true));
    } finally {
        app.cleanup();
    }
});

test('a finished scan credits every source of a working proxy and persists the score', async () => {
    const stream = body([
        progress({ server: '192.0.2.10', secret: SNAPSHOT_SECRETS[0], ok: true, ping: 90, completed: 1, total: 2, working: 1 }),
        progress({ server: '198.51.100.20', port: 8443, secret: SNAPSHOT_SECRETS[1], ok: false, completed: 2, total: 2, working: 1 }),
        doneFrame({ completed: 2 }),
    ]);
    const app = await mountApp({ fetch: respondToSnapshot(SNAPSHOT_TEXT, respondWith(stream)) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        // Source 0 published both links and one of them worked; source 1 published only the
        // link that failed -- and is credited for having published it, not penalized.
        assert.deepEqual(sourceDetails(app).slice(0, 2), [
            interpolate(fa.sourceScore, { n: 2, w: 1, rate: '50.0' }),
            interpolate(fa.sourceScore, { n: 1, w: 0, rate: '0.0' }),
        ]);
        assert.deepEqual(sourceDetails(app).slice(2), DEFAULT_SOURCES.slice(2).map(() => fa.sourceUnscored));

        const persisted = storedSources(app);
        assert.equal(persisted.find(s => s.url === DEFAULT_SOURCES[0]).score.linksWorking, 1);
        assert.equal(persisted.find(s => s.url === DEFAULT_SOURCES[1]).score.linksProvided, 1);
    } finally {
        app.cleanup();
    }
});

test('a scan posts the most-redundant proxy first, whatever order the file was in', async () => {
    const app = await mountApp({ fetch: respondToSnapshot(SNAPSHOT_TEXT, respondWith(body([doneFrame()]))) });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');

        // The textarea holds seen=1 first, seen=2 second -- the request must not.
        assert.deepEqual(app.document.getElementById('inputProxies').value.split('\n'), SNAPSHOT_LINKS);

        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        const posted = JSON.parse(app.recorded.fetches.at(-1).init.body);
        assert.deepEqual(posted.map(p => p.secret), [SNAPSHOT_SECRETS[1], SNAPSHOT_SECRETS[0]]);
    } finally {
        app.cleanup();
    }
});

test('proxies tied on redundancy are posted best-scoring source first', async () => {
    const app = await mountApp({
        fetch: respondToSnapshot(TIE_SNAPSHOT, respondWith(body([doneFrame()]))),
        storage: { sources: storedScores() },
    });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');
        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        const posted = JSON.parse(app.recorded.fetches.at(-1).init.body);
        assert.deepEqual(posted.map(p => p.secret), [TIE_SECRETS[1], TIE_SECRETS[0]]);
    } finally {
        app.cleanup();
    }
});

// Disabling used to affect ranking alone; it now decides what is loaded, so the proxy only the
// disabled source published never reaches the request at all.
test('a disabled source keeps its exclusive proxies out of the scan entirely', async () => {
    const app = await mountApp({
        fetch: respondToSnapshot(TIE_SNAPSHOT, respondWith(body([doneFrame()]))),
        storage: { sources: storedScores({ secondEnabled: false }) },
    });
    try {
        click(app, 'loadListBtn');
        await waitFor(() => app.document.getElementById('inputProxies').value !== '', 'the snapshot to load');
        click(app, 'startBtn');
        await waitFor(() => isIdle(app), 'the scan to finish');

        const posted = JSON.parse(app.recorded.fetches.at(-1).init.body);
        assert.deepEqual(posted.map(p => p.secret), [TIE_SECRETS[0]]);
    } finally {
        app.cleanup();
    }
});

// --- adding, removing and restoring sources -------------------------------------------

function typeUrl(app, url) {
    app.document.getElementById('sourceUrlInput').value = url;
}

const sourceUrls = app => sourceRows(app).map(row => row.querySelector('input').dataset.url);
const removeButtons = app => sourceRows(app).map(row => row.querySelector('.source-remove'));

test('adding a source appends it, clears the field and persists it', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        typeUrl(app, `  ${USER_SOURCE}  `);
        click(app, 'addSourceBtn');

        assert.deepEqual(sourceUrls(app).slice(-1), [USER_SOURCE], 'user sources land after the built-ins');
        assert.equal(sourceRows(app).length, DEFAULT_SOURCES.length + 1);
        assert.equal(app.document.getElementById('sourceUrlInput').value, '');
        assert.equal(storedSources(app).find(s => s.url === USER_SOURCE).enabled, true);
    } finally {
        app.cleanup();
    }
});

test('Enter in the url field adds the source too', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        typeUrl(app, USER_SOURCE);
        app.document.getElementById('sourceUrlInput')
            .dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        assert.deepEqual(sourceUrls(app).slice(-1), [USER_SOURCE]);
    } finally {
        app.cleanup();
    }
});

test('adding a blank or duplicate url changes nothing', async () => {
    const app = await mountApp({ fetch: respondWith(''), storage: { sources: STORED_USER_SOURCE } });
    try {
        const before = sourceUrls(app);

        typeUrl(app, '   ');
        click(app, 'addSourceBtn');
        typeUrl(app, USER_SOURCE);
        click(app, 'addSourceBtn');
        typeUrl(app, DEFAULT_SOURCES[0]);
        click(app, 'addSourceBtn');

        assert.deepEqual(sourceUrls(app), before);
    } finally {
        app.cleanup();
    }
});

test('only a user-added source offers a remove button, and it removes', async () => {
    const app = await mountApp({ fetch: respondWith(''), storage: { sources: STORED_USER_SOURCE } });
    try {
        assert.deepEqual(removeButtons(app).map(Boolean),
            [...DEFAULT_SOURCES.map(() => false), true]);

        removeButtons(app).at(-1).click();
        await tick();

        assert.equal(sourceRows(app).length, DEFAULT_SOURCES.length);
        assert.ok(!storedSources(app).some(s => s.url === USER_SOURCE));
    } finally {
        app.cleanup();
    }
});

// A list a user has been scoring for weeks, and the one action that throws it away.
const SCORED_AND_ADDED = JSON.stringify([
    { url: DEFAULT_SOURCES[0], enabled: false, score: { linksProvided: 10, linksWorking: 5, lastScan: 'once' } },
    { url: USER_SOURCE, enabled: true },
]);

test('restoring the defaults asks first, in the active locale', async () => {
    const app = await mountApp({ fetch: respondWith(''), storage: { sources: SCORED_AND_ADDED } });
    try {
        click(app, 'restoreSourcesBtn');

        assert.deepEqual(app.recorded.confirms, [fa.confirmRestore]);
    } finally {
        app.cleanup();
    }
});

test('cancelling the restore leaves the list exactly as it was', async () => {
    const app = await mountApp({
        fetch: respondWith(''),
        storage: { sources: SCORED_AND_ADDED },
        confirm: false,
    });
    try {
        const before = app.window.localStorage.getItem('sources');

        click(app, 'restoreSourcesBtn');

        assert.equal(sourceRows(app).length, DEFAULT_SOURCES.length + 1, 'the user source is still there');
        assert.equal(sourceBoxes(app)[0].checked, false, 'and so is the disabled built-in');
        assert.notEqual(sourceDetails(app)[0], fa.sourceUnscored, 'and its score');
        assert.equal(app.window.localStorage.getItem('sources'), before, 'nothing was written');
    } finally {
        app.cleanup();
    }
});

test('restoring the defaults drops user sources and clears every score', async () => {
    const app = await mountApp({ fetch: respondWith(''), storage: { sources: SCORED_AND_ADDED } });
    try {
        click(app, 'restoreSourcesBtn');

        assert.deepEqual(sourceUrls(app), DEFAULT_SOURCES);
        assert.deepEqual(sourceBoxes(app).map(box => box.checked), DEFAULT_SOURCES.map(() => true));
        assert.deepEqual(sourceDetails(app), DEFAULT_SOURCES.map(() => fa.sourceUnscored));
        assert.deepEqual(storedSources(app), DEFAULT_SOURCES.map(url => ({ url, enabled: true, addedByUser: false })));
    } finally {
        app.cleanup();
    }
});

test('the source list follows a language change', async () => {
    const app = await mountApp({ fetch: respondWith('') });
    try {
        const langSelect = app.document.getElementById('langSelect');
        langSelect.value = 'ru';
        langSelect.dispatchEvent(new app.window.Event('change'));

        assert.deepEqual(sourceDetails(app), DEFAULT_SOURCES.map(() => translations.ru.sourceUnscored));
    } finally {
        app.cleanup();
    }
});
