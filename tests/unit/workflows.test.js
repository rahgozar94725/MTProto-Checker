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

import { SNAPSHOT_SOURCE_URL } from '../../public/js/sources.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function workflow(name) {
    // .gitattributes pins these to LF, but a stale pre-.gitattributes checkout can still
    // hold CRLF, and every assertion below is line-anchored.
    return readFileSync(`${repoRoot}.github/workflows/${name}`, 'utf8').replace(/\r\n/g, '\n');
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A job's block: from `  <name>:` to the next line at that indent or shallower.
function jobBlock(text, name) {
    const lines = text.split('\n');
    const start = lines.findIndex(l => l === `  ${name}:`);
    assert.notEqual(start, -1, `workflow has no ${name} job`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex(l => /^ {0,2}\S/.test(l));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n');
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

// The whole fail-closed promise of the nightly job is one command line. `--write-baseline`
// is a single token that sets `baseline = null` in build-snapshot.mjs, which skips checkDrift
// entirely *and* rewrites scripts/snapshot-baseline.json from the very run that should have
// been refused -- so a flooded source both ships and moves the reference it would be measured
// against next time. Every other gate in this file stays green while it happens.
test('the nightly job builds the snapshot with the drift guard armed', () => {
    const text = workflow('snapshot.yml');

    assert.match(text, /^\s+run: node scripts\/build-snapshot\.mjs "\$RUNNER_TEMP\/snapshot\.txt"$/m,
        'the nightly build command is no longer the plain guarded one');
    assert.doesNotMatch(text, /--write-baseline/,
        'regenerating the baseline is a deliberate local act, never what CI does');
});

// The "100% line and branch" claim in CLAUDE.md and SPEC.md is enforced by exactly two flags
// in one npm script, run by exactly one step. Drop either end and every suite here still
// passes while the number goes back to being documentation. Same shape as the gofmt and race
// steps above, which are guarded for the same reason.
test('the js job runs the coverage gate, and the gate still carries both thresholds', () => {
    const js = jobBlock(workflow('test.yml'), 'js');
    assert.match(js, /^\s+run: npm run test:coverage:ci$/m,
        'nothing enforces the coverage thresholds any more');

    const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'));
    const gate = pkg.scripts['test:coverage:ci'];

    assert.ok(gate, 'package.json no longer defines the coverage gate');
    assert.match(gate, /--test-coverage-lines=100\b/, 'the line threshold is gone');
    assert.match(gate, /--test-coverage-branches=100\b/, 'the branch threshold is gone');
});

// A ${{ }} expression is substituted into a run: script before bash parses it, so anything
// an outsider can name is shell source rather than an argument. git check-ref-format permits
// `$`, backticks, `;` and `&` in a tag, which makes `github.ref_name` in a run: block code
// execution for anyone who can push one -- in release.yml, next to the toolchain that builds
// every published binary. Passing it through env: is the whole fix; this pins it there.
test('no workflow interpolates a tag or event name into a shell script', () => {
    for (const name of ['snapshot.yml', 'release.yml', 'test.yml']) {
        const text = workflow(name);
        for (const line of text.split('\n')) {
            if (!/\$\{\{\s*github\.(ref_name|head_ref|event)\b/.test(line)) continue;
            assert.match(line, /^\s+[A-Z][A-Z0-9_]*: \$\{\{ github\.[a-z_.]+ \}\}$/,
                `${name} interpolates attacker-nameable context outside an env: mapping: ${line.trim()}`);
        }
    }
});

// release.yml holds the only contents: write in the repository. Declared at workflow level it
// is inherited by the build job, which runs a shell and a Go toolchain over a tag name -- the
// exact pattern snapshot.yml is written to avoid. Scoped to the job that publishes, a future
// job added here starts with no token rather than with the strongest one.
test('release.yml scopes contents: write to the publishing job', () => {
    const text = workflow('release.yml');

    assert.doesNotMatch(text, /^permissions:/m,
        'a workflow-level permissions block hands the build job a token it never uses');
    assert.match(jobBlock(text, 'build'), /^\s+permissions:\n\s+contents: read$/m,
        'the build job publishes nothing and should not be able to');
    assert.match(jobBlock(text, 'release'), /^\s+permissions:\n\s+contents: write$/m,
        'the publishing job needs the write it used to inherit');
});

// A moving ref here would let the workflow repository repoint this project at code it
// never reviewed, and a release is exactly where that would land.
test('release.yml pins the publishing workflow by SHA', () => {
    const text = workflow('release.yml');

    assert.match(text, /^\s+uses: rahgozar94725\/release-workflows\/\.github\/workflows\/release\.yml@[0-9a-f]{40}\b/m);
});

// Three files have to agree on one branch name and one filename, and none of them mentions the
// others: the button in the browser fetches SNAPSHOT_SOURCE_URL, the nightly job pushes to the
// branch that url names, and release.yml curls the same place to bake the file in. Rename the
// branch in snapshot.yml alone and every suite here stays green while every deployed binary
// degrades permanently to the committed placeholder — silently, because a live-snapshot failure
// is logged plainly by design.
test('the snapshot branch and filename agree across sources.js, snapshot.yml and release.yml', () => {
    const url = new URL(SNAPSHOT_SOURCE_URL);
    assert.equal(url.host, 'raw.githubusercontent.com');

    // /<owner>/<repo>/<branch>/<file>
    const [, owner, repo, branch, ...rest] = url.pathname.split('/');
    const file = rest.join('/');

    assert.equal(`${owner}/${repo}`, 'rahgozar94725/MTProto-Checker');
    assert.equal(rest.length, 1, 'the snapshot branch holds its files at the root');

    const snapshot = workflow('snapshot.yml');
    assert.match(snapshot, new RegExp(`^\\s+git init -q -b ${branch}$`, 'm'));
    assert.match(snapshot, new RegExp(`^\\s+git push --force .*\\s${branch}$`, 'm'));
    assert.match(snapshot, new RegExp(`^\\s+git add ${escapeRe(file)} ${escapeRe(file)}\\.sha256$`, 'm'));

    const release = workflow('release.yml');
    assert.match(release, new RegExp(`github\\.repository \\}\\}/${branch}\\b`),
        'release.yml curls a different branch than the nightly job publishes');
    assert.match(release, new RegExp(`\\$base/${escapeRe(file)}"`),
        'release.yml fetches a different filename than the nightly job publishes');
});

// The other half of the same chain, and the one that fails most quietly: the fetch can be
// perfectly correct and the file still land somewhere `//go:embed public` serves under a name
// the page never asks for. Point the cp at public/data/nightly.txt and every gate stays green
// while every released binary serves the committed RFC 5737 placeholder for good.
test('release.yml copies the snapshot to the path the page fetches it from', () => {
    const app = readFileSync(`${repoRoot}public/js/app.js`, 'utf8');
    const declared = /^const SNAPSHOT_URL = '([^']+)';$/m.exec(app);

    assert.ok(declared, 'app.js no longer declares SNAPSHOT_URL');
    // The embed is rooted at public/, and the url is served from its root.
    const embedded = `public${declared[1]}`;

    assert.ok(readFileSync(`${repoRoot}${embedded}`, 'utf8').length > 0,
        `${embedded} is not in the working tree, so the placeholder never shipped either`);
    // Escaped: the `.` in snapshot.txt is otherwise a wildcard, and a future path with a `+`
    // or a `(` in it would widen the assertion silently rather than fail.
    assert.match(workflow('release.yml'), new RegExp(`^\\s+cp "[^"]+" ${escapeRe(embedded)}$`, 'm'),
        'the nightly file has to overwrite the very file the page fetches');
});

test('test.yml ignores pushes to the snapshot branch', () => {
    const on = triggerBlock(workflow('test.yml'));

    assert.match(on, /^\s+push:\n\s+branches-ignore:\n\s+- snapshot$/m,
        'the nightly bot commit would otherwise run the whole test matrix');
});

// /fetch-sources fans goroutines over one results slice, one http.Client and one byte budget,
// and a plain `go test` sees none of it. Asserted inside the go job rather than anywhere in the
// file, so moving the step somewhere it never runs is a failure and not a rename.
test('the go job runs the suite under the race detector, after gofmt', () => {
    const go = jobBlock(workflow('test.yml'), 'go');
    const raceAt = go.indexOf('go test ./... -short -race');

    assert.notEqual(raceAt, -1, 'the go job no longer runs the race detector');
    // gofmt is deterministic and fast and the race step is neither; a job stops at its first
    // failing step, so the slow one going first would let it mask a formatting failure.
    assert.ok(go.indexOf('gofmt -l .') < raceAt, 'gofmt has to run before the race step');
});
