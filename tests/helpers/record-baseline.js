// Records what the CURRENT parser does, before the ES-module refactor touches it.
//
// Run with:  node tests/helpers/record-baseline.js
//
// The output file is generated, never hand-edited. Regenerating it after a
// behaviour change is the same as deleting the regression pin, so only do that
// deliberately -- tests/unit/parse.test.js replays this file to prove the
// refactor preserved behaviour.
//
// It loads the real public/index.html into jsdom and injects the real frontend
// script, because the parser is a bare function in a classic script with
// top-level DOM side effects and cannot be imported.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const p = (...parts) => join(repoRoot, ...parts);

// The frontend was called script.js before the refactor and app.js after it.
// Prefer whichever exists so the recorder stays runnable either way.
function readFrontendSource() {
    for (const name of ['script.js', 'app.js']) {
        try {
            return { name, source: readFileSync(p('public', 'js', name), 'utf8') };
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    throw new Error('neither public/js/script.js nor public/js/app.js exists');
}

const { name: frontendName, source } = readFrontendSource();
const html = readFileSync(p('public', 'index.html'), 'utf8');

const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
});
const { window } = dom;

// jsdom does not implement innerText -- assigning it creates a plain expando and
// leaves the element empty. script.js writes through innerText in log(),
// setLanguage(), updateStartBtn() and showToast(), so without this shim every
// one of those writes silently vanishes. Must be installed before the script runs.
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    set(value) { this.textContent = value; },
    configurable: true,
});

// The <script src> in index.html is never fetched (resources are not loaded), so
// inject the source directly. A classic script's function declarations land on
// window; its top-level `let` bindings do not, which is why skippedCount has to
// come out through a global eval below.
const el = window.document.createElement('script');
el.textContent = source;
window.document.body.appendChild(el);

if (typeof window.parseProxyList !== 'function') {
    throw new Error(`${frontendName} did not expose parseProxyList on window -- is it still a classic script?`);
}

const fixturePath = p('tests', 'fixtures', 'proxies-dirty.txt');
const input = readFileSync(fixturePath, 'utf8');

const consoleBefore = window.document.getElementById('console').textContent;
const proxies = window.parseProxyList(input);
const consoleAfter = window.document.getElementById('console').textContent;

// skippedCount is a top-level `let`, reachable only from a global eval.
const skippedCount = window.eval('skippedCount');

// parseProxyList only reports duplicates through log(); read it back the same way
// a user would see it, so the golden file records observable behaviour.
const dupLine = consoleAfter.slice(consoleBefore.length).match(/Removed (\d+) duplicate entries\./);
const dupCount = dupLine ? Number(dupLine[1]) : 0;

const baseline = {
    _generatedBy: 'node tests/helpers/record-baseline.js',
    _recordedFrom: `public/js/${frontendName}`,
    _fixture: 'tests/fixtures/proxies-dirty.txt',
    _note: 'Generated file. Do not hand-edit. Behaviour pin for the ES-module refactor.',
    inputLines: input.split('\n').length,
    skippedCount,
    dupCount,
    proxyCount: proxies.length,
    proxies,
};

const outPath = p('tests', 'fixtures', 'golden', 'parse-baseline.json');
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
dom.window.close();

console.log(`recorded from public/js/${frontendName}`);
console.log(`  input lines : ${baseline.inputLines}`);
console.log(`  parsed      : ${baseline.proxyCount}`);
console.log(`  skipped     : ${baseline.skippedCount}`);
console.log(`  duplicates  : ${baseline.dupCount}`);
console.log(`  written     : tests/fixtures/golden/parse-baseline.json`);
