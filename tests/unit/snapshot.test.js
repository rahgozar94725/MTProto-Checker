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

import { parseSnapshot, resolveSourceUrls, splitFragment } from '../../public/js/snapshot.js';
import { parseProxyList, proxyKey } from '../../public/js/parse.js';
import { DEFAULT_SOURCES, DEFAULT_SOURCE_OWNERS } from '../../public/js/sources.js';
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

// The rule three files share: scripts/build-snapshot.mjs when it collects the corpus,
// parseSnapshot below, and app.js when it loads a user's own list. The trailing-space trim is
// what keeps `…secret=ee00 # comment` from yielding a secret the server only rescues through
// decodeSecret's junk-trim path.
test('splitFragment cuts at the first # and trims what is left', () => {
    assert.deepEqual(splitFragment(`${SHARED_LINK} # MTProto EU (100)`),
        { link: SHARED_LINK, fragment: ' MTProto EU (100)' });
    assert.deepEqual(splitFragment(`${SHARED_LINK}#seen=1;src=0#more`),
        { link: SHARED_LINK, fragment: 'seen=1;src=0#more' });
    assert.deepEqual(splitFragment(`${SHARED_LINK}  `), { link: SHARED_LINK, fragment: '' });
    assert.deepEqual(splitFragment('#all comment'), { link: '', fragment: 'all comment' });
});

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

// The link and its srcs are kept — dropDisabledSources still has to be able to say "no source
// the user disabled published this". What the id does not do is add to `seen`: this reader
// cannot tell whether id 99 is an independent publisher or the same account as id 0, and
// `seen` is the first scan-order key. Counting it would hand a compromised branch the whole
// ranking back, since `src=100,101,…` is 32 ids no header ever has to declare.
test('parseSnapshot keeps a src id that no header line declares, and does not count it', () => {
    const { sources, attribution } = parseSnapshot(`${SHARED_LINK}#seen=1;src=99`);

    assert.deepEqual(attribution.get(SHARED_KEY), { seen: 0, srcs: [99] });
    assert.equal(sources[99], undefined);
});

// The attack the owner mapping closes. Ten of the seventeen defaults are one GitHub account
// (V2RAYCONFIGSPOOL, ids 6–15), so writing one line into all ten of that account's files is a
// single compromise that used to mint seen=10 — above essentially every legitimately
// redundant proxy, and orderForScan sorts on seen before source score.
test('parseSnapshot counts distinct publishers, not distinct files', () => {
    const oneAccount = `${SHARED_LINK}#seen=10;src=6,7,8,9,10,11,12,13,14,15`;

    assert.deepEqual(parseSnapshot(oneAccount).attribution.get(SHARED_KEY),
        { seen: 1, srcs: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
});

test('parseSnapshot counts a publisher once however many of its files carried the proxy', () => {
    const mixed = `${SHARED_LINK}#seen=4;src=0,6,7,99`;

    assert.deepEqual(parseSnapshot(mixed).attribution.get(SHARED_KEY),
        { seen: 2, srcs: [0, 6, 7, 99] }, 'iwh3n and V2RAYCONFIGSPOOL — 99 is not a publisher this reader knows');
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

// `sources[id] = url` on a sparse array, with `id` read straight off the file: an unbounded
// index lets a compromised snapshot branch hand every later reader — rateBySourceId() on the
// way into a scan, above all — a four-billion-slot walk. The page loads and then freezes on
// Start. Four digits is well past the 17 real sources, and an id that overruns it fails the
// match outright, which is the same as any other comment line.
test('parseSnapshot ignores a source id too long to be one', () => {
    const { sources } = parseSnapshot(`# 4294967294 evil/list.txt\n${SHARED_LINK}`);

    assert.equal(sources.length, 0, 'a 10-digit index would allocate a 4-billion-slot array');
});

test('parseSnapshot still reads a source id at the edge of the bound', () => {
    assert.equal(parseSnapshot('# 9999 far/out.txt').sources[9999], 'far/out.txt');
});

// `seen=` past Number's range reads back as Infinity, and orderForScan subtracts two of them:
// `Infinity - Infinity` is NaN, which makes a sort comparator inconsistent rather than merely
// wrong. Overrunning the bound drops the attribution and keeps the link, exactly as an
// undeclared `src=` id does.
// The id list is bounded in length as well as per id: one line can otherwise declare hundreds
// of thousands of ids inside the 1 MiB per-source cap, and every one of them is walked again by
// bestRate(), dropDisabledSources() and tally().
test('parseSnapshot ignores a fragment declaring more sources than exist', () => {
    const many = Array.from({ length: 40 }, (_, i) => i % 10).join(',');
    const { links, attribution } = parseSnapshot(`${SHARED_LINK}#seen=40;src=${many}`);

    assert.deepEqual(links, [SHARED_LINK]);
    assert.equal(attribution.size, 0);
});

test('parseSnapshot still reads an id list as long as the source list could plausibly be', () => {
    const ids = Array.from({ length: 32 }, (_, i) => i);
    const { attribution } = parseSnapshot(`${SHARED_LINK}#seen=32;src=${ids.join(',')}`);

    assert.deepEqual(attribution.get(SHARED_KEY).srcs, ids);
});

// `seen` is the first scan-order key, so an inflated one pins a proxy to the head of every
// user's next scan. The writer always emits it equal to srcs.length, so a line where they
// disagree was not written by the builder — and bounding the digits alone would not have
// caught `seen=999999;src=0`.
test('parseSnapshot ignores a fragment whose seen count its own id list contradicts', () => {
    const { links, attribution } = parseSnapshot(`${SHARED_LINK}#seen=999999;src=0`);

    assert.deepEqual(links, [SHARED_LINK]);
    assert.equal(attribution.size, 0);
});

// Repeating one id is the other half of the same attack, and the digit bound does not touch it:
// `src=0,0,…,0` declares 32 publishers that are all the same source, and comparing `seen` against
// the raw list length accepts it. Counting distinct ids is what makes the check mean what its
// name says — how many sources published this proxy.
test('parseSnapshot ignores a fragment inflating seen by repeating one source id', () => {
    const ids = Array.from({ length: 32 }, () => 0);
    const { links, attribution } = parseSnapshot(`${SHARED_LINK}#seen=32;src=${ids.join(',')}`);

    assert.deepEqual(links, [SHARED_LINK]);
    assert.equal(attribution.size, 0);
});

test('parseSnapshot ignores a two-id fragment that names one source twice', () => {
    assert.equal(parseSnapshot(`${SHARED_LINK}#seen=2;src=0,0`).attribution.size, 0);
});

// The one line dedupe accepts that the raw comparison rejected. It is honest — one distinct
// source, declared as one — and the builder never emits it, so this pins the direction rather
// than blessing a format.
test('parseSnapshot accepts a repeated id whose seen count matches the distinct one', () => {
    assert.deepEqual(parseSnapshot(`${SHARED_LINK}#seen=1;src=0,0`).attribution.get(SHARED_KEY),
        { seen: 1, srcs: [0] });
});

test('parseSnapshot ignores a fragment whose numbers are out of scale', () => {
    for (const fragment of [`seen=${'9'.repeat(400)};src=0`, 'seen=1;src=99999']) {
        const { links, attribution } = parseSnapshot(`${SHARED_LINK}#${fragment}`);

        assert.deepEqual(links, [SHARED_LINK], fragment);
        assert.equal(attribution.size, 0, fragment);
    }
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

// The header is not evidence. `seen` was moved off it because a branch that can write the lines
// writes the header too; the two consumers that map an id back to a *url* — dropDisabledSources
// and rateBySourceId — were left trusting it. Relabelling source 0 as a url the model has never
// heard of empties dropDisabledSources' id set, so every link of a source the user explicitly
// disabled loads and gets scanned.
test('resolveSourceUrls answers a known id from this build, not from the header', () => {
    const lying = ['evil/relabelled.txt', 'also/evil.txt'];

    assert.deepEqual(resolveSourceUrls(lying).slice(0, 2), DEFAULT_SOURCES.slice(0, 2));
});

test('resolveSourceUrls covers every id this build knows, header or no header', () => {
    assert.deepEqual(resolveSourceUrls(parseSnapshot(SNAPSHOT).sources), DEFAULT_SOURCES);
    assert.deepEqual(resolveSourceUrls([]), DEFAULT_SOURCES);
    assert.deepEqual(resolveSourceUrls(), DEFAULT_SOURCES);
});

// Past this build's list the header is the only answer there is: a client older than the
// snapshot it just fetched still has to be able to name the sources it does not carry.
test('resolveSourceUrls keeps a header slot past the end of this build\'s list', () => {
    const header = [];
    header[DEFAULT_SOURCES.length] = 'newer/source.txt';

    const resolved = resolveSourceUrls(header);
    assert.equal(resolved[DEFAULT_SOURCES.length], 'newer/source.txt');
    assert.deepEqual(resolved.slice(0, DEFAULT_SOURCES.length), DEFAULT_SOURCES);
});

// rateBySourceId maps over this array and hands each entry to shortUrl(), which throws on
// undefined. Array.prototype.map skips a hole and does not skip an own property holding
// undefined, so copying a sparse header across slot by slot would freeze the page on Start.
test('resolveSourceUrls leaves an undeclared slot as a hole rather than an undefined entry', () => {
    const header = [];
    header[DEFAULT_SOURCES.length + 3] = 'far/out.txt';

    const resolved = resolveSourceUrls(header);
    assert.equal(DEFAULT_SOURCES.length in resolved, false, 'a gap must stay a hole');
    resolved.forEach(url => assert.equal(typeof url, 'string'));
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
        // Not `srcs.length`. The builder writes one id per file and `seen=` to match, which is
        // what keeps the line well-formed; the number the reader hands to orderForScan is
        // derived from the ids' publishers instead. These fixtures sit at ids 0–2, which are
        // three different accounts, so the two agree here — state it as the publisher count
        // rather than the id count so it keeps meaning that if the defaults ever move.
        const publishers = new Set(entry.srcs.map(id => DEFAULT_SOURCE_OWNERS[id]).filter(o => o !== undefined));
        assert.equal(entry.seen, publishers.size);
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
