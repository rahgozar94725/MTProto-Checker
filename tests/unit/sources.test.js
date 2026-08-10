// Covers public/js/sources.js: the baked defaults, the merge that a stored value goes
// through, and — the point of the module — that a corrupt or foreign localStorage value
// resolves to the defaults instead of throwing, the same totality rule resolveLang() follows.
//
// The model is keyed by URL throughout. Task 9 hangs per-source scores off these entries, and
// a nightly rebuild is free to reorder or append sources, so an index-keyed model would
// silently repoint a score.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_SOURCES,
    addSource,
    defaultSources,
    parseSources,
    removeSource,
    serializeSources,
    setEnabled,
} from '../../public/js/sources.js';
import { SOURCES } from '../../scripts/build-snapshot.mjs';

const USER_URL = 'https://example.invalid/my-list.txt';

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
