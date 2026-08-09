// Covers scripts/build-snapshot.mjs: dedupe, source-set accumulation, sort order and the
// line grammar. Nothing here touches the network — fetchAll is driven with a fake fetch and
// every other test works off tests/fixtures/snapshot-sources/, which carries RFC 5737
// documentation addresses only.
//
// The load-bearing assertion is the round-trip one: `#seen=…` must be appended with no
// space before the `#`, because new URL().search ends at `#` and a space would land inside
// the last parameter value, giving every line a secret with a trailing space.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    SOURCES,
    shortUrl,
    formatLine,
    collect,
    snapshotLines,
    buildSnapshot,
    fetchAll,
} from '../../scripts/build-snapshot.mjs';
import { parseLink, parseProxyList, proxyKey } from '../../public/js/parse.js';

const fixture = n =>
    readFileSync(fileURLToPath(new URL(`../fixtures/snapshot-sources/${n}.txt`, import.meta.url)), 'utf8');

const TEXTS = ['00', '01', '02'].map(fixture);
const URLS = ['https://raw.githubusercontent.com/a/one.txt', 'https://raw.githubusercontent.com/b/two.txt', 'https://raw.githubusercontent.com/c/three.txt'];
const GENERATED_AT = '2026-08-09T12:00:00.000Z';

const SHARED = '192.0.2.10:443:ee0102030405060708090a0b0c0d0e0f10';
const COMMENTED = '198.51.100.7:443:ee1112131415161718191a1b1c1d1e1f20';

const body = text => text.split('\n').filter(l => l && !l.startsWith('#'));

test('SOURCES is the 17 raw.githubusercontent.com URLs, each listed once', () => {
    assert.equal(SOURCES.length, 17);
    assert.equal(new Set(SOURCES).size, 17);
    assert.deepEqual(SOURCES.filter(u => !u.startsWith('https://raw.githubusercontent.com/')), []);
});

test('shortUrl drops the raw.githubusercontent.com prefix', () => {
    assert.equal(shortUrl('https://raw.githubusercontent.com/iwh3n/tg-proxy/refs/heads/main/proxys/All_Proxys.txt'),
        'iwh3n/tg-proxy/refs/heads/main/proxys/All_Proxys.txt');
});

test('collect dedupes across sources and accumulates the source set', () => {
    const { universe } = collect(TEXTS);

    assert.equal(universe.size, 4);
    assert.deepEqual(universe.get(SHARED).srcs, [0, 1, 2]);
    assert.deepEqual(universe.get('192.0.2.11:8443:dd0102030405060708090a0b0c0d0e0f').srcs, [0]);
    assert.deepEqual(universe.get(COMMENTED).srcs, [1]);
    assert.deepEqual(universe.get('203.0.113.9:2053:eeffeeffeeffeeffeeffeeffeeffeeff').srcs, [2]);
});

test('collect counts a proxy repeated inside one source only once', () => {
    const { perSource } = collect(TEXTS);

    // 00.txt lists 192.0.2.10 twice and carries one unparseable line.
    assert.equal(perSource[0].unique, 2);
    assert.equal(perSource[0].duplicates, 1);
});

test('collect drops bad ports and spam secrets without throwing', () => {
    const { perSource } = collect(TEXTS);

    assert.equal(perSource[1].unique, 2, 'the port=99999 line is dropped');
    assert.equal(perSource[2].unique, 2, 'the AAAA… spam secret is dropped');
    assert.equal(perSource[2].spam, 1);
});

test('formatLine appends the metadata with no space before the #', () => {
    assert.equal(
        formatLine('tg://proxy?server=192.0.2.10&port=443&secret=ee00', [0, 2]),
        'tg://proxy?server=192.0.2.10&port=443&secret=ee00#seen=2;src=0,2',
    );
});

test('every emitted line re-parses to the exact proxy it was built from', () => {
    const { universe } = collect(TEXTS);

    for (const line of snapshotLines(universe)) {
        const result = parseLink(line);
        assert.equal(result.ok, true, `${line} no longer parses`);
        assert.ok(universe.has(proxyKey(result.proxy)), `${line} re-parses to a different key`);
        assert.equal(result.proxy.secret.trim(), result.proxy.secret, `${line} yields a padded secret`);
    }
});

test('a source-side comment fragment never reaches the emitted line', () => {
    const { universe } = collect(TEXTS);
    const line = snapshotLines(universe).find(l => l.includes('198.51.100.7'));

    assert.ok(line.endsWith('#seen=1;src=1'), line);
    assert.equal(line.split('#').length, 2, 'exactly one # per line');
    assert.ok(!line.includes('MTProto EU'), line);
});

// Descending, not ascending: file order is scan order, and the 2026-08-10 re-scan measured
// `seen>=5` at 81–100 % working against `seen<=2` at 15–24 %. Phase 0 measured the opposite
// and it did not reproduce — see the Phase 0b section of the plan.
test('snapshotLines sorts descending by seen, then ascending by key', () => {
    const { universe } = collect(TEXTS);

    assert.deepEqual(snapshotLines(universe).map(l => l.slice(l.indexOf('#') + 1)), [
        'seen=3;src=0,1,2',
        'seen=1;src=0',
        'seen=1;src=1',
        'seen=1;src=2',
    ]);
});

test('snapshotLines keeps the key tie-break ascending within one seen bucket', () => {
    const { universe } = collect(TEXTS);
    const keysAtSeen1 = snapshotLines(universe)
        .filter(l => l.includes('#seen=1;'))
        .map(l => l.slice(0, l.indexOf('#')));

    assert.deepEqual(keysAtSeen1, [...keysAtSeen1].sort());
});

test('buildSnapshot writes the generation timestamp and one line per source', () => {
    const { text } = buildSnapshot({ urls: URLS, texts: TEXTS, generatedAt: GENERATED_AT });
    const header = text.split('\n').filter(l => l.startsWith('#'));

    assert.equal(header[0], `# generated ${GENERATED_AT} by scripts/build-snapshot.mjs`);
    assert.deepEqual(header.slice(1), ['# 0 a/one.txt', '# 1 b/two.txt', '# 2 c/three.txt']);
    assert.ok(text.endsWith('\n'));
});

test('buildSnapshot rejects a source that yielded no parseable link', () => {
    assert.throws(
        () => buildSnapshot({ urls: URLS, texts: [TEXTS[0], '404: Not Found\n', TEXTS[2]], generatedAt: GENERATED_AT }),
        /b\/two\.txt/,
    );
});

test('the snapshot body round-trips through parseProxyList to the same secrets', () => {
    const { text, universe } = buildSnapshot({ urls: URLS, texts: TEXTS, generatedAt: GENERATED_AT });
    const { proxies, skipped, duplicates } = parseProxyList(body(text).join('\n'));

    assert.equal(proxies.length, universe.size);
    assert.equal(skipped, 0);
    assert.equal(duplicates, 0);
    assert.deepEqual(proxies.map(proxyKey).sort(), [...universe.keys()].sort());
});

test('fetchAll returns each body in source order', async () => {
    const seen = [];
    const fetchImpl = async url => {
        seen.push(url);
        return { ok: true, status: 200, text: async () => `body of ${url}` };
    };

    assert.deepEqual(await fetchAll(URLS, { fetchImpl }), URLS.map(u => `body of ${u}`));
    assert.deepEqual(seen.sort(), [...URLS].sort());
});

test('fetchAll rejects when a source answers non-200', async () => {
    const fetchImpl = async url => ({
        ok: !url.endsWith('two.txt'),
        status: url.endsWith('two.txt') ? 404 : 200,
        text: async () => 'body',
    });

    await assert.rejects(() => fetchAll(URLS, { fetchImpl }), /404/);
});

test('fetchAll rejects when a source cannot be reached at all', async () => {
    const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };

    await assert.rejects(() => fetchAll(URLS, { fetchImpl }), /ENOTFOUND/);
});
