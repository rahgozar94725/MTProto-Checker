// Guards the committed placeholder at public/data/snapshot.txt. It ships inside the
// release binary (//go:embed public), so it must parse as a real snapshot — the Load-list
// button reads it on a fresh clone and on an offline machine — while carrying no live
// proxy. Every address is from RFC 5737 documentation space, the same rule
// tests/fixtures/sse-progress.txt follows, because these links reach screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSnapshot } from '../../public/js/snapshot.js';
import { parseProxyList } from '../../public/js/parse.js';

const text = readFileSync(
    fileURLToPath(new URL('../../public/data/snapshot.txt', import.meta.url)),
    'utf8'
);
const snapshot = parseSnapshot(text);

// 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24 — RFC 5737.
const DOCUMENTATION_IP = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)\d{1,3}$/;

test('the placeholder is marked as one in its header', () => {
    assert.match(text.split('\n')[0], /placeholder/i);
});

test('the placeholder parses as a snapshot', () => {
    assert.ok(snapshot.links.length > 0);
    assert.notEqual(snapshot.generatedAt, '');
    assert.ok(snapshot.sources.length > 0);
});

test('every placeholder address is RFC 5737 documentation space', () => {
    const { proxies } = parseProxyList(snapshot.links.join('\n'));
    assert.equal(proxies.length, snapshot.links.length);
    const offenders = proxies.map(p => p.server).filter(s => !DOCUMENTATION_IP.test(s));
    assert.deepEqual(offenders, []);
});

test('the placeholder links carry no attribution fragment', () => {
    const offenders = snapshot.links.filter(link => link.includes('#'));
    assert.deepEqual(offenders, []);
});

// The placeholder is hand-written, so nothing else keeps it in the order snapshotLines()
// emits. File order is scan order, and the sort is descending by `seen` — a placeholder in
// the old ascending order would model the wrong grammar for anyone reading it as the example.
test('the placeholder is ordered descending by seen, like a real build', () => {
    // Matched on the metadata, not on `tg://` — a real build also emits `https://t.me/proxy…`
    // lines, because parse.js preserves whichever form the source used.
    const seen = text
        .split('\n')
        .filter(line => !line.startsWith('#') && line.includes('#seen='))
        .map(line => Number(/#seen=(\d+);/.exec(line)[1]));

    assert.ok(seen.length > 1, 'needs at least two links to have an order');
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
});
