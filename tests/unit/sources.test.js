// Covers public/js/sources.js: the baked defaults, the merge that a stored value goes
// through, and — the point of the module — that a corrupt or foreign localStorage value
// resolves to the defaults instead of throwing, the same totality rule resolveLang() follows.
//
// The model is keyed by URL throughout. Task 9 hangs per-source scores off these entries, and
// a nightly rebuild is free to reorder or append sources, so an index-keyed model would
// silently repoint a score.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_SOURCES,
    MAX_SOURCES_PER_REQUEST,
    addSource,
    defaultSources,
    dropDisabledSources,
    isValidSourceUrl,
    orderForScan,
    parseSources,
    rateBySourceId,
    recordScan,
    removeSource,
    serializeSources,
    setEnabled,
    shortUrl,
    sourceOwner,
    DEFAULT_SOURCE_OWNERS,
} from '../../public/js/sources.js';
import { SOURCES } from '../../scripts/build-snapshot.mjs';

const USER_URL = 'https://example.invalid/my-list.txt';

// A snapshot header declares its sources short — `# 0 iwh3n/tg-proxy/…` — so every scoring
// test feeds recordScan exactly what parseSnapshot() hands back, short urls and all.
const HEADER = [shortUrl(DEFAULT_SOURCES[0]), shortUrl(DEFAULT_SOURCES[1]), USER_URL];
const scoreOf = (list, url) => list.find(s => s.url === url).score;

test('DEFAULT_SOURCES is the same list build-snapshot.mjs builds from', () => {
    assert.deepEqual(SOURCES, DEFAULT_SOURCES);
    assert.equal(DEFAULT_SOURCES.length, 17);
    assert.equal(new Set(DEFAULT_SOURCES).size, 17);
});

test('defaultSources yields every built-in enabled and not user-added, in file order', () => {
    const list = defaultSources();

    assert.deepEqual(list.map(s => s.url), DEFAULT_SOURCES);
    assert.deepEqual(list.filter(s => !s.enabled), []);
    assert.deepEqual(list.filter(s => s.addedByUser), []);
});

test('defaultSources hands out a fresh list each call', () => {
    const first = defaultSources();
    first[0].enabled = false;

    assert.equal(defaultSources()[0].enabled, true);
});

test('a stored value round-trips through serializeSources and parseSources', () => {
    const list = addSource(setEnabled(defaultSources(), DEFAULT_SOURCES[2], false), USER_URL);

    assert.deepEqual(parseSources(serializeSources(list)), list);
});

test('parseSources keeps the stored enabled flag of a built-in', () => {
    const stored = serializeSources(setEnabled(defaultSources(), DEFAULT_SOURCES[0], false));

    assert.equal(parseSources(stored)[0].enabled, false);
});

test('parseSources reinstates a built-in the stored value dropped, enabled', () => {
    const stored = JSON.stringify([{ url: DEFAULT_SOURCES[1], enabled: false, addedByUser: false }]);
    const list = parseSources(stored);

    assert.deepEqual(list.map(s => s.url), [...DEFAULT_SOURCES, ...[]]);
    assert.equal(list[0].enabled, true, 'the dropped built-in comes back enabled');
    assert.equal(list[1].enabled, false, 'the stored one keeps its flag');
});

test('parseSources appends user-added sources after the built-ins, in stored order', () => {
    const other = 'https://example.invalid/second.txt';
    const stored = serializeSources(addSource(addSource(defaultSources(), USER_URL), other));

    assert.deepEqual(parseSources(stored).slice(DEFAULT_SOURCES.length).map(s => s.url), [USER_URL, other]);
});

test('parseSources marks a source it does not recognise as user-added', () => {
    const stored = JSON.stringify([{ url: USER_URL, enabled: true, addedByUser: false }]);

    assert.equal(parseSources(stored).at(-1).addedByUser, true);
});

test('parseSources never marks a built-in as user-added', () => {
    const stored = JSON.stringify([{ url: DEFAULT_SOURCES[0], enabled: true, addedByUser: true }]);

    assert.equal(parseSources(stored)[0].addedByUser, false);
});

test('parseSources keeps one entry per URL when the stored value repeats one', () => {
    const stored = JSON.stringify([
        { url: USER_URL, enabled: false, addedByUser: true },
        { url: USER_URL, enabled: true, addedByUser: true },
    ]);
    const list = parseSources(stored);

    assert.equal(list.filter(s => s.url === USER_URL).length, 1);
    assert.equal(list.at(-1).enabled, false, 'the first occurrence wins');
});

for (const [name, stored] of [
    ['null, as a key that was never written', null],
    ['undefined, as no argument at all', undefined],
    ['an empty string', ''],
    ['unparseable JSON', '{oh no'],
    ['a JSON scalar', '42'],
    ['a JSON object', '{"url":"https://example.invalid/x.txt"}'],
    ['a foreign array of strings', '["https://example.invalid/x.txt"]'],
    ['an array of nulls', '[null,null]'],
    ['an array of entries with no url', '[{"enabled":false}]'],
    ['an array of entries whose url is not a string', '[{"url":7,"enabled":false}]'],
]) {
    test(`parseSources resolves ${name} to the defaults`, () => {
        assert.deepEqual(parseSources(stored), defaultSources());
    });
}

test('parseSources treats a non-boolean enabled as enabled', () => {
    const stored = JSON.stringify([{ url: DEFAULT_SOURCES[0], enabled: 'no', addedByUser: false }]);

    assert.equal(parseSources(stored)[0].enabled, true);
});

test('setEnabled toggles one source and leaves the rest alone', () => {
    const list = setEnabled(defaultSources(), DEFAULT_SOURCES[3], false);

    assert.equal(list[3].enabled, false);
    assert.deepEqual(list.filter(s => !s.enabled).map(s => s.url), [DEFAULT_SOURCES[3]]);
});

test('setEnabled does not mutate the list it was given', () => {
    const list = defaultSources();
    setEnabled(list, DEFAULT_SOURCES[0], false);

    assert.equal(list[0].enabled, true);
});

test('setEnabled on an unknown URL changes nothing', () => {
    assert.deepEqual(setEnabled(defaultSources(), USER_URL, false), defaultSources());
});

test('addSource appends a trimmed, user-added, enabled entry', () => {
    const list = addSource(defaultSources(), `  ${USER_URL}\n`);

    assert.deepEqual(list.at(-1), { url: USER_URL, enabled: true, addedByUser: true });
    assert.equal(list.length, DEFAULT_SOURCES.length + 1);
});

test('addSource ignores a URL already in the list', () => {
    assert.deepEqual(addSource(defaultSources(), DEFAULT_SOURCES[0]), defaultSources());
});

test('addSource ignores an empty or whitespace-only URL', () => {
    assert.deepEqual(addSource(defaultSources(), '   '), defaultSources());
});

// The server dials these on the page's behalf and its own policy is https, or http through
// SOCKS5 — so anything else is answered with an empty 200 and reported to the user as a
// successful load of zero links.
test('isValidSourceUrl accepts only an absolute http or https url', () => {
    for (const url of [USER_URL, 'http://192.0.2.1:8080/list.txt', `  ${USER_URL}  `]) {
        assert.equal(isValidSourceUrl(url), true, url);
    }
    for (const url of ['file:///etc/passwd', 'ftp://example.invalid/l.txt', 'data:text/plain,x',
        'javascript:alert(1)', 'example.invalid/list.txt', '/list.txt', '', '   ', undefined,
        // Credentials are refused rather than stripped: this value is persisted in localStorage
        // and posted to /fetch-sources on every load.
        'https://user:pw@example.invalid/list.txt', 'https://user@example.invalid/list.txt']) {
        assert.equal(isValidSourceUrl(url), false, String(url));
    }
});

// Not merely unfetchable: shortUrl() strips the RAW_PREFIX including its scheme, so a
// scheme-less url shortens to the same key a built-in shortens to and recordScan would credit
// one source's links to the other.
test('a scheme-less url that would collide with a built-in is rejected', () => {
    const collides = shortUrl(DEFAULT_SOURCES[0]);

    assert.equal(shortUrl(collides), collides, 'the collision is real');
    assert.deepEqual(addSource(defaultSources(), collides), defaultSources());
});

test('addSource ignores a url isValidSourceUrl rejects', () => {
    assert.deepEqual(addSource(defaultSources(), 'file:///etc/passwd'), defaultSources());
});

// Both the dedupe here and shortUrl() are exact string comparisons, so an unnormalized variant
// of a built-in would be fetched twice and scored as two independent sources.
test('addSource normalizes a url so every spelling of a built-in is a duplicate', () => {
    const variants = [
        DEFAULT_SOURCES[0].replace('https://raw.', 'HTTPS://RAW.'),
        DEFAULT_SOURCES[0].replace('.com/', '.com:443/'),
        // `new URL().href` keeps both of these verbatim while reporting search and hash empty,
        // which is why the normalizer reassembles from the parts instead.
        `${DEFAULT_SOURCES[0]}#`,
        `${DEFAULT_SOURCES[0]}?`,
    ];

    for (const variant of variants) {
        assert.deepEqual(addSource(defaultSources(), variant), defaultSources(), variant);
        assert.equal(addSource([], variant)[0].url, DEFAULT_SOURCES[0], variant);
    }
});

// parseSources is the untrusted entry point, not addSource: a list written by an older build,
// or by any other page on this origin, can hold a url addSource would refuse today. A
// scheme-less one is the damaging case — shortUrl() leaves it alone, so it is a phantom row
// carrying a built-in's key, and disabling it drops that built-in's links from the next load.
test('parseSources drops a stored url addSource would refuse', () => {
    const collides = shortUrl(DEFAULT_SOURCES[0]);
    const stored = serializeSources([
        { url: collides, enabled: true },
        { url: 'file:///etc/passwd', enabled: true },
        { url: USER_URL, enabled: true },
    ]);

    assert.deepEqual(parseSources(stored).filter(s => s.addedByUser).map(s => s.url), [USER_URL]);
});

// The other half: a stored url addSource would have *rewritten*. Validation alone leaves the
// variant intact, and it then matches neither DEFAULT_SOURCES (exact compare) nor RAW_PREFIX
// (case-sensitive) — a phantom user source fetched a second time and scored on its own.
test('parseSources normalizes a stored url the same way addSource would', () => {
    const variant = DEFAULT_SOURCES[0].replace('https://raw.', 'HTTPS://RAW.');
    const list = parseSources(serializeSources([
        { url: variant, enabled: true },
        // The default port and the uppercase host both normalize away.
        { url: 'https://EXAMPLE.invalid:443/my-list.txt', enabled: true },
    ]));

    assert.deepEqual(list.filter(s => s.addedByUser).map(s => s.url), [USER_URL]);
    assert.equal(list.length, DEFAULT_SOURCES.length + 1, 'the variant is the built-in, not a new row');
});

// app.js chunks POST /fetch-sources to this number. It is the server's constant, and the two
// files have no other connection — a drift would silently 413 the whole user-source step.
test('MAX_SOURCES_PER_REQUEST is the maxSources main.go enforces', () => {
    const go = readFileSync(fileURLToPath(new URL('../../main.go', import.meta.url)), 'utf8');
    // Loose on formatting, exact on the value: the point is the number, and a red JS job
    // saying "main.go no longer declares maxSources" because someone aligned a const block
    // differently would be noise.
    const declared = /\bmaxSources\b[^=\n]*=\s*(\d+)/.exec(go);

    assert.ok(declared, 'main.go no longer declares maxSources');
    assert.equal(MAX_SOURCES_PER_REQUEST, Number(declared[1]));
});

test('removeSource drops a user-added source', () => {
    const list = removeSource(addSource(defaultSources(), USER_URL), USER_URL);

    assert.deepEqual(list, defaultSources());
});

test('removeSource refuses to drop a built-in — disabling is the only way out', () => {
    assert.deepEqual(removeSource(defaultSources(), DEFAULT_SOURCES[0]), defaultSources());
});

test('removeSource on an unknown URL changes nothing', () => {
    assert.deepEqual(removeSource(defaultSources(), USER_URL), defaultSources());
});

test('restoring the defaults drops user-added sources and re-enables the built-ins', () => {
    const dirty = addSource(setEnabled(defaultSources(), DEFAULT_SOURCES[5], false), USER_URL);
    assert.notDeepEqual(dirty, defaultSources());

    // Restore is defaultSources() itself: the action is wiring, not arithmetic. What matters
    // is that what it produces survives a write/read cycle unchanged.
    assert.deepEqual(parseSources(serializeSources(defaultSources())), defaultSources());
});

// --- scoring ---------------------------------------------------------------------------

test('recordScan credits every source of a working proxy, not just the first', () => {
    // One link, published by both built-ins. A "first source wins" implementation scores
    // source 1 at 0 working and passes every other test in this file.
    const list = recordScan(defaultSources(), {
        sourceUrls: HEADER,
        provided: [[0, 1]],
        working: [[0, 1]],
        scannedAt: '2026-08-10T00:00:00.000Z',
    });

    assert.deepEqual(scoreOf(list, DEFAULT_SOURCES[0]), {
        linksProvided: 1, linksWorking: 1, lastScan: '2026-08-10T00:00:00.000Z',
    });
    assert.deepEqual(scoreOf(list, DEFAULT_SOURCES[1]), {
        linksProvided: 1, linksWorking: 1, lastScan: '2026-08-10T00:00:00.000Z',
    });
});

test('recordScan counts a link once per source when a fragment repeats an id', () => {
    const list = recordScan(defaultSources(), {
        sourceUrls: HEADER,
        provided: [[0, 0]],
        working: [[0, 0]],
    });

    assert.deepEqual(scoreOf(list, DEFAULT_SOURCES[0]), {
        linksProvided: 1, linksWorking: 1, lastScan: '',
    });
});

test('recordScan scores working links as a subset of the links provided', () => {
    const list = recordScan(defaultSources(), {
        sourceUrls: HEADER,
        provided: [[0], [0], [0, 1], [1]],
        working: [[0, 1]],
    });

    assert.equal(scoreOf(list, DEFAULT_SOURCES[0]).linksProvided, 3);
    assert.equal(scoreOf(list, DEFAULT_SOURCES[0]).linksWorking, 1);
    assert.equal(scoreOf(list, DEFAULT_SOURCES[1]).linksProvided, 2);
    assert.equal(scoreOf(list, DEFAULT_SOURCES[1]).linksWorking, 1);
});

test('recordScan scores a user-added source through the header it was declared in', () => {
    const list = recordScan(addSource(defaultSources(), USER_URL), {
        sourceUrls: HEADER,
        provided: [[2]],
        working: [],
    });

    assert.deepEqual(scoreOf(list, USER_URL), { linksProvided: 1, linksWorking: 0, lastScan: '' });
});

test('recordScan neither credits nor penalizes a source that provided nothing', () => {
    const list = recordScan(defaultSources(), { sourceUrls: HEADER, provided: [[0]] });

    assert.equal('score' in list.find(s => s.url === DEFAULT_SOURCES[1]), false);
});

test('recordScan leaves an untouched source score exactly as it was', () => {
    const scanned = recordScan(defaultSources(), { sourceUrls: HEADER, provided: [[1]], working: [[1]] });
    const again = recordScan(scanned, { sourceUrls: HEADER, provided: [[0]] });

    assert.deepEqual(scoreOf(again, DEFAULT_SOURCES[1]), scoreOf(scanned, DEFAULT_SOURCES[1]));
});

test('recordScan accumulates across scans and moves lastScan forward', () => {
    const first = recordScan(defaultSources(), {
        sourceUrls: HEADER, provided: [[0], [0]], working: [[0]], scannedAt: 'first',
    });
    const second = recordScan(first, {
        sourceUrls: HEADER, provided: [[0], [0], [0]], working: [[0], [0]], scannedAt: 'second',
    });

    assert.deepEqual(scoreOf(second, DEFAULT_SOURCES[0]), {
        linksProvided: 5, linksWorking: 3, lastScan: 'second',
    });
});

test('an accumulated score survives a write/read cycle', () => {
    const list = recordScan(addSource(defaultSources(), USER_URL), {
        sourceUrls: HEADER, provided: [[0], [2]], working: [[2]], scannedAt: 'first',
    });

    assert.deepEqual(parseSources(serializeSources(list)), list);
});

test('recordScan ignores a src id the header never declared', () => {
    const list = recordScan(defaultSources(), { sourceUrls: HEADER, provided: [[9]], working: [[9]] });

    assert.deepEqual(list, defaultSources());
});

test('recordScan ignores a link whose srcs are not an array', () => {
    const list = recordScan(defaultSources(), { sourceUrls: HEADER, provided: [null, [0]] });

    assert.equal(scoreOf(list, DEFAULT_SOURCES[0]).linksProvided, 1);
});

test('recordScan with no scan at all changes nothing', () => {
    assert.deepEqual(recordScan(defaultSources()), defaultSources());
});

test('recordScan does not mutate the list it was given', () => {
    const list = defaultSources();
    recordScan(list, { sourceUrls: HEADER, provided: [[0]], working: [[0]] });

    assert.equal('score' in list[0], false);
});

for (const [name, score] of [
    ['is not an object', '"7"'],
    ['is null', 'null'],
    ['counts links with a non-number', '{"linksProvided":"3","linksWorking":1,"lastScan":""}'],
    ['counts working with a non-number', '{"linksProvided":3,"linksWorking":null,"lastScan":""}'],
    ['counts a NaN', '{"linksProvided":3,"linksWorking":1e999,"lastScan":""}'],
    ['counts negative links', '{"linksProvided":-3,"linksWorking":1,"lastScan":""}'],
    ['counts negative working links', '{"linksProvided":3,"linksWorking":-1,"lastScan":""}'],
    ['dates the scan with a non-string', '{"linksProvided":3,"linksWorking":1,"lastScan":7}'],
]) {
    test(`parseSources drops a stored score that ${name}`, () => {
        const stored = `[{"url":${JSON.stringify(DEFAULT_SOURCES[0])},"enabled":true,"score":${score}}]`;

        assert.deepEqual(parseSources(stored), defaultSources());
    });
}

test('shortUrl drops the raw.githubusercontent.com prefix and leaves anything else alone', () => {
    assert.equal(shortUrl(DEFAULT_SOURCES[0]), 'iwh3n/tg-proxy/refs/heads/main/proxys/All_Proxys.txt');
    assert.equal(shortUrl(USER_URL), USER_URL);
});

// Who has to be compromised for a source to lie, which is not the same question as which
// file the line came from. parseSnapshot counts publishers rather than files because ten of
// the seventeen defaults are one account.
test('sourceOwner reduces a source to the account that can rewrite it', () => {
    assert.equal(sourceOwner(DEFAULT_SOURCES[0]), 'iwh3n');
    assert.equal(sourceOwner(DEFAULT_SOURCES[6]), 'v2rayconfigspool');
    assert.equal(sourceOwner(DEFAULT_SOURCES[15]), 'v2rayconfigspool',
        'ten files, one account — that is the whole point');
    assert.equal(sourceOwner(USER_URL), 'example.invalid', 'anything else is its host');
    // Total, like everything else a stored value reaches: a string that is no URL at all is
    // its own owner rather than a throw at module scope.
    assert.equal(sourceOwner('not a url'), 'not a url');
    assert.equal(sourceOwner(''), '');
});

test('DEFAULT_SOURCE_OWNERS is positional, so a src= id resolves to a publisher', () => {
    assert.equal(DEFAULT_SOURCE_OWNERS.length, DEFAULT_SOURCES.length);
    assert.deepEqual(DEFAULT_SOURCE_OWNERS, DEFAULT_SOURCES.map(sourceOwner));
    assert.equal(new Set(DEFAULT_SOURCE_OWNERS).size, 8,
        '17 sources, 8 accounts — update this number deliberately when the list changes');
});

// --- Task 10: what the scan order is built from -------------------------------------

// The rates a scan-ordering comparison reads, and the ordering itself. Both are pure and
// both are keyed through the snapshot header, which is the only thing joining a `src=` id
// to a source URL.

const RATED = recordScan(defaultSources(), {
    sourceUrls: HEADER,
    provided: [[0], [0], [0], [0], [1], [1]],   // source 0 published 4 links, source 1 two
    working: [[0]],                              // one of source 0's worked; none of source 1's
    scannedAt: 'first',
});

test('rateBySourceId keys a source rate by the header id the snapshot used', () => {
    assert.deepEqual(rateBySourceId(RATED, HEADER), [0.25, 0, 0]);
});

test('rateBySourceId rates a disabled source zero, so disabling it stops ranking with it', () => {
    const off = setEnabled(RATED, DEFAULT_SOURCES[0], false);

    assert.deepEqual(rateBySourceId(off, HEADER), [0, 0, 0]);
});

test('rateBySourceId rates an unscored source zero rather than NaN', () => {
    assert.deepEqual(rateBySourceId(defaultSources(), HEADER), [0, 0, 0]);
});

test('rateBySourceId rates a stored zero-link score zero instead of dividing by it', () => {
    const stored = `[{"url":${JSON.stringify(DEFAULT_SOURCES[0])},"enabled":true,` +
        `"score":{"linksProvided":0,"linksWorking":0,"lastScan":"once"}}]`;

    assert.deepEqual(rateBySourceId(parseSources(stored), HEADER), [0, 0, 0]);
});

test('rateBySourceId ignores a header slot no source in the model matches', () => {
    assert.deepEqual(rateBySourceId(RATED, ['example.invalid/nobody.txt']), [0]);
});

// The scan list, in the shape parseProxyList() hands back.
function px(server, secret = 'dd01') {
    return { server, port: 443, secret, original: `tg://proxy?server=${server}&port=443&secret=${secret}` };
}

function attributed(entries) {
    return new Map(entries.map(([proxy, seen, srcs]) => [`${proxy.server}:443:${proxy.secret}`, { seen, srcs }]));
}

test('orderForScan puts the most-redundant proxy first', () => {
    const [a, b, c] = [px('192.0.2.1'), px('192.0.2.2'), px('192.0.2.3')];
    const attribution = attributed([[a, 1, [0]], [b, 7, [0]], [c, 3, [0]]]);

    assert.deepEqual(
        orderForScan([a, b, c], { attribution }).map(p => p.server),
        ['192.0.2.2', '192.0.2.3', '192.0.2.1']
    );
});

test('orderForScan breaks a tie on seen by the best-scoring source', () => {
    const [a, b] = [px('192.0.2.1'), px('192.0.2.2')];
    const attribution = attributed([[a, 2, [1]], [b, 2, [0]]]);
    const rates = rateBySourceId(RATED, HEADER);   // source 0 at 0.25, source 1 at 0

    assert.deepEqual(
        orderForScan([a, b], { attribution, rates }).map(p => p.server),
        ['192.0.2.2', '192.0.2.1']
    );
});

test('orderForScan ranks a proxy by its best source, not by its first', () => {
    const [a, b] = [px('192.0.2.1'), px('192.0.2.2')];
    // b's first source is the dead one; its second is the source that scored.
    const attribution = attributed([[a, 2, [1]], [b, 2, [1, 0]]]);

    assert.deepEqual(
        orderForScan([a, b], { attribution, rates: rateBySourceId(RATED, HEADER) }).map(p => p.server),
        ['192.0.2.2', '192.0.2.1']
    );
});

test('orderForScan sorts a proxy the snapshot never mentioned last, in paste order', () => {
    const [a, b, c] = [px('192.0.2.1'), px('192.0.2.2'), px('192.0.2.3')];
    const attribution = attributed([[c, 1, [0]]]);

    assert.deepEqual(
        orderForScan([a, b, c], { attribution }).map(p => p.server),
        ['192.0.2.3', '192.0.2.1', '192.0.2.2']
    );
});

test('orderForScan rates a src id no header slot declared as zero', () => {
    const [a, b] = [px('192.0.2.1'), px('192.0.2.2')];
    const attribution = attributed([[a, 2, [9]], [b, 2, [0]]]);

    assert.deepEqual(
        orderForScan([a, b], { attribution, rates: rateBySourceId(RATED, HEADER) }).map(p => p.server),
        ['192.0.2.2', '192.0.2.1']
    );
});

test('orderForScan with nothing to go on keeps the list as it is', () => {
    const list = [px('192.0.2.1'), px('192.0.2.2')];

    assert.deepEqual(orderForScan(list), list);
});

test('orderForScan does not mutate the list it was given', () => {
    const [a, b] = [px('192.0.2.1'), px('192.0.2.2')];
    const list = [a, b];
    orderForScan(list, { attribution: attributed([[b, 5, [0]]]) });

    assert.deepEqual(list, [a, b]);
});

// --- what a disabled source removes from a load ---------------------------------------

// The user turned off the first built-in and nothing else.
const FIRST_OFF = setEnabled(defaultSources(), DEFAULT_SOURCES[0], false);

test('dropDisabledSources drops a proxy every source of which is disabled', () => {
    const [a, b] = [px('192.0.2.1'), px('192.0.2.2')];
    const attribution = attributed([[a, 1, [0]], [b, 1, [1]]]);

    assert.deepEqual(
        dropDisabledSources([a, b], { attribution, sources: FIRST_OFF, sourceUrls: HEADER }).map(p => p.server),
        ['192.0.2.2']
    );
});

test('dropDisabledSources keeps a proxy one of whose sources is still enabled', () => {
    const a = px('192.0.2.1');
    const attribution = attributed([[a, 2, [0, 1]]]);

    assert.deepEqual(dropDisabledSources([a], { attribution, sources: FIRST_OFF, sourceUrls: HEADER }), [a]);
});

test('dropDisabledSources keeps a proxy the snapshot never attributed', () => {
    const a = px('192.0.2.1');

    assert.deepEqual(
        dropDisabledSources([a], { attribution: new Map(), sources: FIRST_OFF, sourceUrls: HEADER }),
        [a]
    );
});

test('dropDisabledSources keeps a proxy whose only src id no header slot declares', () => {
    const a = px('192.0.2.1');
    const attribution = attributed([[a, 1, [9]]]);

    assert.deepEqual(
        dropDisabledSources([a], { attribution, sources: FIRST_OFF, sourceUrls: HEADER }), [a],
        'a source the model cannot identify is not a source the user disabled'
    );
});

test('dropDisabledSources keeps a proxy published by a source the model has never heard of', () => {
    const a = px('192.0.2.1');
    const attribution = attributed([[a, 1, [0]]]);
    const header = ['nobody/has-this-list/main/proxies.txt'];

    assert.deepEqual(dropDisabledSources([a], { attribution, sources: FIRST_OFF, sourceUrls: header }), [a]);
});

test('dropDisabledSources with nothing disabled returns the list as it is', () => {
    const [a, b] = [px('192.0.2.1'), px('192.0.2.2')];
    const attribution = attributed([[a, 1, [0]], [b, 1, [1]]]);

    assert.deepEqual(
        dropDisabledSources([a, b], { attribution, sources: defaultSources(), sourceUrls: HEADER }),
        [a, b]
    );
});

test('dropDisabledSources with no arguments at all keeps everything', () => {
    const list = [px('192.0.2.1')];

    assert.deepEqual(dropDisabledSources(list), list);
});
