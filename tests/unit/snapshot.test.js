// Covers public/js/snapshot.js: the header, the fragment-free links, the attribution map
// and — the point of the module — that none of it throws on garbage. Every address here is
// from the RFC 5737 documentation range, as in every other fixture in this suite.
//
// The round-trip test at the bottom is the load-bearing one: it feeds a real
// build-snapshot.mjs output through parseSnapshot and then through parseProxyList, which is
// the exact path the Load-list button will take in Task 5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSnapshot } from '../../public/js/snapshot.js';
import { parseProxyList, proxyKey } from '../../public/js/parse.js';
import { buildSnapshot } from '../../scripts/build-snapshot.mjs';

const fixture = n =>
    readFileSync(fileURLToPath(new URL(`../fixtures/snapshot-sources/${n}.txt`, import.meta.url)), 'utf8');

const SHARED_LINK = 'tg://proxy?server=192.0.2.10&port=443&secret=ee0102030405060708090a0b0c0d0e0f10';
const SHARED_KEY = '192.0.2.10:443:ee0102030405060708090a0b0c0d0e0f10';
const LONE_LINK = 'tg://proxy?server=203.0.113.9&port=2053&secret=eeffeeffeeffeeffeeffeeffeeffeeff';

const SNAPSHOT = [
    '# generated 2026-08-09T12:00:00.000Z by scripts/build-snapshot.mjs',
    '# 0 a/one.txt',
    '# 1 b/two.txt',
    '# 2 c/three.txt',
    `${LONE_LINK}#seen=1;src=2`,
    `${SHARED_LINK}#seen=3;src=0,1,2`,
    '',
].join('\n');

test('parseSnapshot reads the generation timestamp off the header', () => {
    assert.equal(parseSnapshot(SNAPSHOT).generatedAt, '2026-08-09T12:00:00.000Z');
});

test('parseSnapshot indexes the source table by its numeric id', () => {
    assert.deepEqual(parseSnapshot(SNAPSHOT).sources, ['a/one.txt', 'b/two.txt', 'c/three.txt']);
});

test('parseSnapshot ignores a header comment that is neither the stamp nor a source', () => {
    const { generatedAt, sources } = parseSnapshot(`# hand-written note\n${SNAPSHOT}`);

    assert.equal(generatedAt, '2026-08-09T12:00:00.000Z');
    assert.deepEqual(sources, ['a/one.txt', 'b/two.txt', 'c/three.txt']);
});

test('parseSnapshot yields links with the attribution fragment stripped, in file order', () => {
    assert.deepEqual(parseSnapshot(SNAPSHOT).links, [LONE_LINK, SHARED_LINK]);
});

test('parseSnapshot keys attribution by proxyKey', () => {
    assert.deepEqual(parseSnapshot(SNAPSHOT).attribution.get(SHARED_KEY), { seen: 3, srcs: [0, 1, 2] });
});

test('parseSnapshot keeps a src id that no header line declares', () => {
    const { sources, attribution } = parseSnapshot(`${SHARED_LINK}#seen=1;src=99`);

    assert.deepEqual(attribution.get(SHARED_KEY), { seen: 1, srcs: [99] });
    assert.equal(sources[99], undefined);
});

test('parseSnapshot accepts a plain link and records no attribution for it', () => {
    const { links, attribution } = parseSnapshot(SHARED_LINK);

    assert.deepEqual(links, [SHARED_LINK]);
    assert.equal(attribution.size, 0);
});

test('parseSnapshot drops a line whose fragment is not the snapshot grammar', () => {
    const { links, attribution } = parseSnapshot(`${SHARED_LINK}# MTProto EU`);

    assert.deepEqual(links, [SHARED_LINK], 'the link survives the source-side comment');
    assert.equal(attribution.size, 0);
});

test('parseSnapshot is total on a body of garbage', () => {
    const { generatedAt, sources, links, attribution } = parseSnapshot('not a link\n\n???\ntg://\n');

    assert.equal(generatedAt, '');
    assert.deepEqual(sources, []);
    assert.deepEqual(links, []);
    assert.equal(attribution.size, 0);
});

test('parseSnapshot is total on a body with no header at all', () => {
    const { generatedAt, sources, links } = parseSnapshot(`${LONE_LINK}#seen=1;src=2\n`);

    assert.equal(generatedAt, '');
    assert.deepEqual(sources, []);
    assert.deepEqual(links, [LONE_LINK]);
});

test('parseSnapshot called with nothing yields empty structures', () => {
    const { generatedAt, sources, links, attribution } = parseSnapshot();

    assert.equal(generatedAt, '');
    assert.deepEqual(sources, []);
    assert.deepEqual(links, []);
    assert.equal(attribution.size, 0);
});

test('a real build-snapshot output round-trips to the same proxies it was built from', () => {
    const texts = ['00', '01', '02'].map(fixture);
    const { text, universe } = buildSnapshot({
        urls: ['https://raw.githubusercontent.com/a/one.txt', 'https://raw.githubusercontent.com/b/two.txt', 'https://raw.githubusercontent.com/c/three.txt'],
        texts,
        generatedAt: '2026-08-09T12:00:00.000Z',
    });

    const { links, attribution, sources } = parseSnapshot(text);
    const { proxies, skipped, duplicates } = parseProxyList(links.join('\n'));

    assert.deepEqual(sources, ['a/one.txt', 'b/two.txt', 'c/three.txt']);
    assert.equal(links.length, universe.size);
    assert.equal(skipped, 0);
    assert.equal(duplicates, 0);
    assert.deepEqual(proxies.map(proxyKey), [...attribution.keys()]);

    for (const [key, entry] of attribution) {
        assert.deepEqual(entry.srcs, universe.get(key).srcs);
        assert.equal(entry.seen, universe.get(key).srcs.length);
    }
});

test('no link carries a fragment after the round trip', () => {
    const { text } = buildSnapshot({
        urls: ['https://raw.githubusercontent.com/a/one.txt'],
        texts: [fixture('00')],
        generatedAt: '2026-08-09T12:00:00.000Z',
    });

    for (const link of parseSnapshot(text).links) assert.ok(!link.includes('#'), link);
});
