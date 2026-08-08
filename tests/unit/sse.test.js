// The frame parser is the one place where the client's view of a scan can silently diverge
// from the server's: a chunk boundary in the wrong place used to mean a dropped result or a
// half-parsed JSON payload. These tests cut the same body at every offset that matters and
// assert the parser reassembles it identically. `data` stays a raw string here on purpose —
// JSON.parse belongs to the caller, so a malformed payload still throws where it always did.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSSEParser } from '../../public/js/sse.js';
import { frame, progressFrame, doneFrame, body, chunkAt, chunksOf } from '../helpers/sse.js';

const OK = { server: '192.0.2.10', port: 443, secret: 'ee00', ok: true, ping: 42, completed: 1 };
const FAIL = { server: '192.0.2.11', port: 8443, secret: 'ee01', ok: false, completed: 2 };

test('one frame per chunk yields one event per push', () => {
    const parser = createSSEParser();
    assert.deepEqual(parser.push(progressFrame(OK)), [
        { event: 'progress', data: JSON.stringify(OK) },
    ]);
    assert.deepEqual(parser.push(progressFrame(FAIL)), [
        { event: 'progress', data: JSON.stringify(FAIL) },
    ]);
});

test('two frames in one chunk yield both, in order', () => {
    const parser = createSSEParser();
    const events = parser.push(body([progressFrame(OK), progressFrame(FAIL)]));
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => JSON.parse(e.data).server), ['192.0.2.10', '192.0.2.11']);
});

test('a frame split across chunks is emitted once, whole', () => {
    const text = progressFrame(OK);
    const chunks = chunkAt(text, 5);
    const parser = createSSEParser();

    assert.deepEqual(parser.push(chunks[0]), [], 'no event before the terminator arrives');
    assert.deepEqual(parser.push(chunks[1]), [{ event: 'progress', data: JSON.stringify(OK) }]);
});

test('a split inside the data: line still yields intact JSON', () => {
    const text = progressFrame(OK);
    const cut = text.indexOf('data: ') + 10;
    const [head, tail] = chunkAt(text, cut);
    const parser = createSSEParser();

    assert.deepEqual(parser.push(head), []);
    const events = parser.push(tail);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data), OK);
});

test('a body split byte by byte yields exactly the same events as one chunk', () => {
    const text = body([progressFrame(OK), progressFrame(FAIL), doneFrame({ completed: 2 })]);

    const whole = createSSEParser().push(text);
    const drip = createSSEParser();
    const dripped = chunksOf(text, 1).flatMap(c => drip.push(c));

    assert.deepEqual(dripped, whole);
    assert.equal(whole.length, 3);
});

test('a chunk that is only a terminator yields nothing', () => {
    const parser = createSSEParser();
    assert.deepEqual(parser.push('\n\n'), []);
});

test('progress and done events keep their own event names', () => {
    const parser = createSSEParser();
    const events = parser.push(body([progressFrame(OK), doneFrame({ completed: 1 })]));
    assert.deepEqual(events.map(e => e.event), ['progress', 'done']);
    assert.deepEqual(JSON.parse(events[1].data), { completed: 1 });
});

test('a frame with no data: line yields nothing', () => {
    const parser = createSSEParser();
    assert.deepEqual(parser.push(frame({ event: 'progress' })), []);
});

test('a frame with an empty data: value yields nothing', () => {
    const parser = createSSEParser();
    assert.deepEqual(parser.push(frame({ event: 'progress', data: '' })), []);
});

test('blank and whitespace-only frames are ignored', () => {
    const parser = createSSEParser();
    const events = parser.push(body(['\n\n', '   \n\n', '\t\n\n', progressFrame(OK)]));
    assert.deepEqual(events, [{ event: 'progress', data: JSON.stringify(OK) }]);
});

test('lines that are neither event: nor data: are ignored', () => {
    const parser = createSSEParser();
    const events = parser.push(`: keep-alive comment\nid: 7\nevent: progress\ndata: {"ok":false}\nretry: 100\n\n`);
    assert.deepEqual(events, [{ event: 'progress', data: '{"ok":false}' }]);
});

test('a data: line with no event: line yields an empty event name', () => {
    const parser = createSSEParser();
    assert.deepEqual(parser.push(frame({ data: '{"ok":true}' })), [
        { event: '', data: '{"ok":true}' },
    ]);
});

test('a trailing partial frame is buffered, never emitted early', () => {
    const parser = createSSEParser();
    const text = body([progressFrame(OK), progressFrame(FAIL)]);
    const partial = text.slice(0, text.length - 5);

    const first = parser.push(partial);
    assert.equal(first.length, 1, 'only the complete leading frame');
    assert.deepEqual(JSON.parse(first[0].data), OK);

    assert.deepEqual(parser.push(text.slice(text.length - 5)), [
        { event: 'progress', data: JSON.stringify(FAIL) },
    ]);
});

test('data is returned as a raw string, not parsed', () => {
    const parser = createSSEParser();
    const [event] = parser.push(frame({ event: 'progress', data: 'not json' }));
    assert.equal(event.data, 'not json');
    assert.throws(() => JSON.parse(event.data), SyntaxError);
});

test('two parsers keep separate buffers', () => {
    const a = createSSEParser();
    const b = createSSEParser();
    const text = progressFrame(OK);

    a.push(text.slice(0, 8));
    assert.deepEqual(b.push(text), [{ event: 'progress', data: JSON.stringify(OK) }]);
    assert.deepEqual(a.push(text.slice(8)), [{ event: 'progress', data: JSON.stringify(OK) }]);
});
