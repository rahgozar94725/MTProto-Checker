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
