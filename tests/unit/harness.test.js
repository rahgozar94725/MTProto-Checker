// Guards the one constraint the test harness itself can violate: main.go carries
// //go:embed public, so anything that lands under public/ is baked into the ~20.6 MiB
// release binary. Test files, package manifests and node_modules must stay at the repo root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const publicDir = join(repoRoot, 'public');

function walk(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else found.push(full);
    }
    return found;
}

const publicFiles = walk(publicDir).map(f => relative(repoRoot, f).replace(/\\/g, '/'));

test('public/ carries no test files', () => {
    const offenders = publicFiles.filter(f => /\.(test|spec)\.[cm]?js$/.test(f));
    assert.deepEqual(offenders, [], 'these would be embedded into the release binary');
});

test('public/ carries no npm manifests or dependencies', () => {
    const offenders = publicFiles.filter(f =>
        /(^|\/)(package(-lock)?\.json|node_modules)(\/|$)/.test(f)
    );
    assert.deepEqual(offenders, [], 'these would be embedded into the release binary');
});

// public/data/snapshot.txt is the one data file the embed carries on purpose: the
// placeholder proxy snapshot a fresh clone serves at /data/snapshot.txt, overwritten by
// release.yml at build time. The entry is deliberately narrow — a .txt elsewhere under
// public/, or a non-.txt under public/data/, is still an offender.
const CODE_AND_ASSETS = /\.(html|css|js|woff2|png|svg|ico)$/;
const DATA_SNAPSHOT = /^public\/data\/[^/]+\.txt$/;
const isEmbeddable = f => CODE_AND_ASSETS.test(f) || DATA_SNAPSHOT.test(f);

test('the embedded tree is only html, css, js, fonts and public/data/*.txt', () => {
    const offenders = publicFiles.filter(f => !isEmbeddable(f));
    assert.deepEqual(offenders, []);
});

test('the data allowlist admits public/data/*.txt and nothing broader', () => {
    assert.equal(isEmbeddable('public/data/snapshot.txt'), true);
    assert.equal(isEmbeddable('public/js/notes.txt'), false);
    assert.equal(isEmbeddable('public/data/nested/other.txt'), false);
    assert.equal(isEmbeddable('public/data/proxies.csv'), false);
});
