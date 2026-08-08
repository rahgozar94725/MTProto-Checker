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

test('the embedded tree is only html, css, js and fonts', () => {
    const allowed = /\.(html|css|js|woff2|png|svg|ico)$/;
    const offenders = publicFiles.filter(f => !allowed.test(f));
    assert.deepEqual(offenders, []);
});
