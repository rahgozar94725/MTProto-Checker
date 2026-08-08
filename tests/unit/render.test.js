// DOM-level coverage for public/js/render.js and public/js/state.js.
//
// The suite renders into the real public/index.html, mounted through the jsdom
// helper, so a renamed id or a restructured table fails here rather than in the
// browser. The XSS case is the load-bearing one: server and port are
// attacker-controlled strings pasted by the user, and the only thing standing
// between them and script execution is textContent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountApp } from '../helpers/dom.js';
import { pingClass } from '../../public/js/format.js';
import {
    renderResultsTable,
    renderStats,
    setResultsView,
    showToast,
    resultCell,
} from '../../public/js/render.js';
import { createScanState } from '../../public/js/state.js';

function proxy(server, port, ping) {
    return {
        link: `tg://proxy?server=${server}&port=${port}&secret=dd0102`,
        ping,
        server,
        port,
    };
}

test('renders one row per proxy with cells in rank/server/port/ping/copy order', async () => {
    const app = await mountApp();
    try {
        renderResultsTable(app.document, [proxy('192.0.2.1', 443, 120), proxy('192.0.2.2', 8443, 250)], 'کپی');

        const rows = app.document.querySelectorAll('#resultsBody tr');
        assert.equal(rows.length, 2);

        const cells = rows[1].querySelectorAll('td');
        assert.equal(cells.length, 5);
        assert.equal(cells[0].textContent, '2');
        assert.equal(cells[0].className, 'rank');
        assert.equal(cells[1].textContent, '192.0.2.2');
        assert.equal(cells[1].className, 'host');
        assert.equal(cells[2].textContent, '8443');
        assert.equal(cells[2].className, 'host');
        assert.equal(cells[3].querySelector('span.ping').textContent, '250 ms');
        assert.equal(cells[4].querySelector('button.rowcopy').textContent, 'کپی');
    } finally {
        app.cleanup();
    }
});

test('a hostile server string renders as text and creates no element', async () => {
    const app = await mountApp();
    try {
        const hostile = '<img src=x onerror=alert(1)>';
        renderResultsTable(app.document, [proxy(hostile, '<script>alert(2)</script>', 10)], 'copy');

        const cells = app.document.querySelectorAll('#resultsBody td');
        assert.equal(cells[1].textContent, hostile);
        assert.equal(cells[2].textContent, '<script>alert(2)</script>');
        assert.equal(app.document.querySelectorAll('#resultsBody img').length, 0, 'no <img> may be created');
        assert.equal(app.document.querySelectorAll('#resultsBody script').length, 0, 'no <script> may be created');
        assert.equal(cells[1].children.length, 0, 'the server cell must hold text only');
        assert.deepEqual(app.recorded.alerts, [], 'nothing may execute');
    } finally {
        app.cleanup();
    }
});

test('every row copy button carries its own array index', async () => {
    const app = await mountApp();
    try {
        const proxies = [proxy('192.0.2.1', 443, 10), proxy('192.0.2.2', 443, 20), proxy('192.0.2.3', 443, 30)];
        renderResultsTable(app.document, proxies, 'copy');

        const buttons = [...app.document.querySelectorAll('#resultsBody .rowcopy')];
        assert.deepEqual(buttons.map(b => b.dataset.index), ['0', '1', '2']);
        assert.equal(buttons[2].type, 'button');
    } finally {
        app.cleanup();
    }
});

test('the ping badge class comes from pingClass', async () => {
    const app = await mountApp();
    try {
        const pings = [0, 179, 180, 299, 300, 9999];
        renderResultsTable(app.document, pings.map((p, i) => proxy(`192.0.2.${i + 1}`, 443, p)), 'copy');

        const badges = [...app.document.querySelectorAll('#resultsBody span.ping')];
        assert.deepEqual(
            badges.map(b => b.className),
            pings.map(p => 'ping ' + pingClass(p)),
        );
    } finally {
        app.cleanup();
    }
});

test('the results count and the has-results flag follow the list', async () => {
    const app = await mountApp();
    try {
        const panel = app.document.getElementById('resultsPanel');

        renderResultsTable(app.document, [], 'copy');
        assert.equal(app.document.getElementById('resultsCount').textContent, '0');
        assert.equal(panel.classList.contains('has-results'), false);

        renderResultsTable(app.document, [proxy('192.0.2.1', 443, 10)], 'copy');
        assert.equal(app.document.getElementById('resultsCount').textContent, '1');
        assert.equal(panel.classList.contains('has-results'), true);
    } finally {
        app.cleanup();
    }
});

test('re-rendering a shorter list leaves no stale rows behind', async () => {
    const app = await mountApp();
    try {
        const many = Array.from({ length: 500 }, (_, i) => proxy(`192.0.2.${i % 254 + 1}`, 443, i));
        renderResultsTable(app.document, many, 'copy');
        assert.equal(app.document.querySelectorAll('#resultsBody tr').length, 500);

        renderResultsTable(app.document, many.slice(0, 2), 'copy');
        const rows = app.document.querySelectorAll('#resultsBody tr');
        assert.equal(rows.length, 2);
        assert.equal(rows[1].querySelectorAll('td')[0].textContent, '2');
    } finally {
        app.cleanup();
    }
});

test('renderStats writes all six tiles', async () => {
    const app = await mountApp();
    try {
        renderStats(app.document, { checked: 40, total: 100, working: 7, best: 133, skipped: 5 });

        assert.equal(app.document.getElementById('tileChecked').textContent, '40');
        assert.equal(app.document.getElementById('tileTotal').textContent, '100');
        assert.equal(app.document.getElementById('tileWorking').textContent, '7');
        assert.equal(app.document.getElementById('tileBest').textContent, '133 ms');
        assert.equal(app.document.getElementById('tileFailed').textContent, '33');
        assert.equal(app.document.getElementById('tileSkipped').textContent, '5');
    } finally {
        app.cleanup();
    }
});

test('the best-ping tile falls back to an em dash with no results', async () => {
    const app = await mountApp();
    try {
        renderStats(app.document, { checked: 12, total: 12, working: 0, best: null, skipped: 0 });
        assert.equal(app.document.getElementById('tileBest').textContent, '—');
        assert.equal(app.document.getElementById('tileFailed').textContent, '12');
    } finally {
        app.cleanup();
    }
});

test('the failed tile never goes negative', async () => {
    const app = await mountApp();
    try {
        // A resumed scan can report more working proxies than the checked counter
        // of the current leg; the tile must clamp rather than show -3.
        renderStats(app.document, { checked: 2, total: 10, working: 5, best: 90, skipped: 0 });
        assert.equal(app.document.getElementById('tileFailed').textContent, '0');
    } finally {
        app.cleanup();
    }
});

test('setResultsView flips data-view and both aria-pressed flags', async () => {
    const app = await mountApp();
    try {
        const panel = app.document.getElementById('resultsPanel');
        const tableBtn = app.document.getElementById('viewTableBtn');
        const textBtn = app.document.getElementById('viewTextBtn');

        setResultsView(app.document, 'text');
        assert.equal(panel.dataset.view, 'text');
        assert.equal(tableBtn.getAttribute('aria-pressed'), 'false');
        assert.equal(textBtn.getAttribute('aria-pressed'), 'true');

        setResultsView(app.document, 'table');
        assert.equal(panel.dataset.view, 'table');
        assert.equal(tableBtn.getAttribute('aria-pressed'), 'true');
        assert.equal(textBtn.getAttribute('aria-pressed'), 'false');
    } finally {
        app.cleanup();
    }
});

test('showToast writes the message as text and marks success or error', async () => {
    const app = await mountApp();
    try {
        const toast = app.document.getElementById('toast');

        showToast(app.document, 'done');
        assert.equal(toast.textContent, 'done');
        assert.equal(toast.className, 'toast show success');

        showToast(app.document, '<b>boom</b>', true);
        assert.equal(toast.textContent, '<b>boom</b>');
        assert.equal(toast.querySelectorAll('b').length, 0, 'toast text must not be parsed as markup');
        assert.equal(toast.className, 'toast show error');
    } finally {
        app.cleanup();
    }
});

test('resultCell puts a node in as a child and anything else in as text', async () => {
    const app = await mountApp();
    try {
        const span = app.document.createElement('span');
        const withNode = resultCell(app.document, null, span);
        assert.equal(withNode.className, '');
        assert.equal(withNode.firstChild, span);

        const withText = resultCell(app.document, 'rank', 3);
        assert.equal(withText.className, 'rank');
        assert.equal(withText.textContent, '3');
        assert.equal(withText.children.length, 0);
    } finally {
        app.cleanup();
    }
});

test('createScanState hands out an idle, empty scan state', () => {
    const state = createScanState();
    assert.deepEqual(state.workingProxies, []);
    assert.deepEqual(state.allProxies, []);
    assert.equal(state.lastSkipped, 0);
    assert.equal(state.isPaused, false);
    assert.equal(state.scanState, 'idle');
    assert.equal(state.currentController, null);
    assert.equal(state.lastChecked, 0);
    assert.equal(state.lastTotal, 0);
    assert.equal(state.checkedKeys.size, 0);
    assert.equal(state.globalLinkMap.size, 0);
});

test('each scan state is independent, so two mounts cannot share one', () => {
    const first = createScanState();
    const second = createScanState();

    first.workingProxies.push(proxy('192.0.2.1', 443, 10));
    first.checkedKeys.add('192.0.2.1:443:dd');
    first.globalLinkMap.set('k', 'v');
    first.scanState = 'scanning';

    assert.deepEqual(second.workingProxies, []);
    assert.equal(second.checkedKeys.size, 0);
    assert.equal(second.globalLinkMap.size, 0);
    assert.equal(second.scanState, 'idle');
});
