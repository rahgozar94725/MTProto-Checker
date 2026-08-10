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

// Scoped to the job that pushes, not to the workflow: a second job added later would
// otherwise inherit write access to the repository without anyone deciding it should.
test('snapshot.yml asks for contents: write on the job, and nothing else anywhere', () => {
    const text = workflow('snapshot.yml');

    assert.doesNotMatch(text, /^permissions:/m,
        'a workflow-level permissions block hands write access to every future job');

    const permissions = text.match(/^ {4}permissions:\n((?: {6}\S.*\n)+)/m);
    assert.ok(permissions, 'the build job declares no permissions block');
    assert.deepEqual(
        permissions[1].trim().split('\n').map(l => l.trim()),
        ['contents: write']
    );
});

// The nightly job holds a contents: write token, so an action resolved through a movable
// tag is arbitrary code running next to it — the same argument release.yml already makes
// for the reusable workflow it pins. Applied to all three workflows so the rule cannot rot
// back in through the low-privilege one.
test('every workflow pins its actions by SHA', () => {
    for (const name of ['snapshot.yml', 'release.yml', 'test.yml']) {
        const text = workflow(name);
        // Both spellings: a step's `- uses:` and a job's bare `uses:`.
        const uses = [...text.matchAll(/^[ \t]+(?:- )?uses: (\S+)/gm)].map(m => m[1]);

        assert.ok(uses.length > 0, `${name} uses no actions at all`);
        for (const ref of uses) {
            assert.match(ref, /@[0-9a-f]{40}$/, `${name} resolves ${ref} through a movable ref`);
        }
    }
});

// Both files or neither: release.yml refuses to build without the checksum, so publishing
// only the snapshot would red every release rather than degrade quietly.
test('snapshot.yml publishes the snapshot and its checksum together', () => {
    const text = workflow('snapshot.yml');

    assert.match(text, /^\s+git add snapshot\.txt snapshot\.txt\.sha256$/m,
        'the checksum has to be pushed alongside the file it attests');
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
    assert.match(text, /raw\.githubusercontent\.com\/\$\{\{ github\.repository \}\}\/snapshot/,
        'the snapshot branch holds the files at its root');
    assert.match(text, /\$base\/snapshot\.txt"/, 'the snapshot itself is still fetched');
});

// The checksum is what makes the embedded list attested to be the one the nightly job
// produced. Verified before the copy into public/data/, so a mismatch reds the release
// instead of shipping. `set -euo pipefail` is what makes a failed sha256sum -c stop the
// step at all — without it the script continues to the copy and the build succeeds.
test('release.yml verifies the snapshot checksum before it embeds the file', () => {
    const text = workflow('release.yml');
    const verifyAt = text.indexOf('sha256sum -c');
    const copyAt = text.indexOf('public/data/snapshot.txt');
    const buildAt = text.indexOf('go build');

    assert.notEqual(verifyAt, -1, 'nothing checks that the fetched snapshot is the published one');
    assert.ok(verifyAt < copyAt, 'the checksum has to be verified before the file is accepted');
    assert.ok(copyAt < buildAt, '//go:embed reads public/ at compile time');
    assert.match(text, /^\s+set -euo pipefail$/m,
        'without -e a failed sha256sum -c is ignored and the release ships anyway');
    assert.match(text, /snapshot\.txt\.sha256/, 'the checksum file is never fetched');
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
