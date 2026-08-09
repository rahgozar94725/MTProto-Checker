// Guards the containment rules between the two push-triggered workflows. The nightly
// snapshot job force-pushes a bot commit to the orphan branch `snapshot`; test.yml
// triggers on a bare `push`, so without `branches-ignore` every nightly commit burns
// all three of its jobs. Neither rule is visible from either file alone, and nothing
// else in the repository fails when one of them is dropped.
//
// These are text assertions rather than parsed YAML on purpose: the repo has no YAML
// dependency and adding one to check four lines is not worth the supply chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function workflow(name) {
    // .gitattributes pins these to LF, but a stale pre-.gitattributes checkout can still
    // hold CRLF, and every assertion below is line-anchored.
    return readFileSync(`${repoRoot}.github/workflows/${name}`, 'utf8').replace(/\r\n/g, '\n');
}

// The `on:` block: from the `on:` key to the next top-level key.
function triggerBlock(text) {
    const lines = text.split('\n');
    const start = lines.findIndex(l => /^on:/.test(l));
    assert.notEqual(start, -1, 'workflow has no `on:` key');
    const rest = lines.slice(start + 1);
    const end = rest.findIndex(l => /^\S/.test(l));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

test('snapshot.yml runs on a schedule and by hand, never on push', () => {
    const on = triggerBlock(workflow('snapshot.yml'));

    assert.match(on, /^\s+schedule:/m);
    assert.match(on, /^\s+workflow_dispatch:/m);
    assert.doesNotMatch(on, /^\s+push:/m, 'a push trigger would rebuild the snapshot on every commit');
});

test('snapshot.yml asks for contents: write and nothing else', () => {
    const text = workflow('snapshot.yml');
    // Indented lines only — `\s` would swallow the blank line and run into `jobs:`.
    const permissions = text.match(/^permissions:\n((?:[ \t]+\S.*\n)+)/m);

    assert.ok(permissions, 'snapshot.yml declares no permissions block');
    assert.deepEqual(
        permissions[1].trim().split('\n').map(l => l.trim()),
        ['contents: write']
    );
});

// `//go:embed public` reads the working tree at compile time, so the only window in which
// a release binary can pick up the nightly snapshot is between checkout and `go build`.
// Nothing else fails if the step is dropped or reordered: the build stays green and every
// binary ships the committed placeholder instead.
test('release.yml bakes the nightly snapshot in before it builds', () => {
    const text = workflow('release.yml');
    const fetchAt = text.indexOf('public/data/snapshot.txt');
    const buildAt = text.indexOf('go build');

    assert.notEqual(fetchAt, -1, 'without the fetch every release ships the committed placeholder');
    assert.notEqual(buildAt, -1, 'release.yml no longer builds');
    assert.ok(fetchAt < buildAt, '//go:embed reads public/ at compile time — the fetch has to come first');
    assert.match(text, /curl[^\n]*--fail/,
        'without --fail curl saves the 404 body over the snapshot and exits 0');
    assert.match(text, /raw\.githubusercontent\.com\/\$\{\{ github\.repository \}\}\/snapshot\/snapshot\.txt/,
        'the snapshot branch holds the file at its root');
});

// A moving ref here would let the workflow repository repoint this project at code it
// never reviewed, and a release is exactly where that would land.
test('release.yml pins the publishing workflow by SHA', () => {
    const text = workflow('release.yml');

    assert.match(text, /^\s+uses: rahgozar94725\/release-workflows\/\.github\/workflows\/release\.yml@[0-9a-f]{40}\b/m);
});

test('test.yml ignores pushes to the snapshot branch', () => {
    const on = triggerBlock(workflow('test.yml'));

    assert.match(on, /^\s+push:\n\s+branches-ignore:\n\s+- snapshot$/m,
        'the nightly bot commit would otherwise run the whole test matrix');
});
