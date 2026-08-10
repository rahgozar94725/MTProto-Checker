// Happy path, end to end: paste a dirty list into the real page served by the Go binary,
// start a scan, and answer /check-stream with a canned SSE body.
//
// The unit suites already prove each module in isolation; what only a browser can prove is
// the whole chain — the embedded index.html, the module graph Chromium actually loads, the
// TextDecoder/ReadableStream path through runCheckStream, and the blob download that no
// jsdom stub can stand in for.
//
// tests/fixtures/sse-progress.txt is raw wire bytes, so it carries no comment header: the
// servers, ports and secrets in it must stay in step with PASTED_LIST below, since app.js
// matches a progress event back to its original link by `server:port:secret`.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

// Secrets are synthetic; every address is from the RFC 5737 documentation range.
const P10 = 'tg://proxy?server=192.0.2.10&port=443&secret=ee1a2b3c4d5e6f708192a3b4c5d6e7f8';
const P11 = 'tg://proxy?server=192.0.2.11&port=8443&secret=ee2b3c4d5e6f708192a3b4c5d6e7f809';
const P12 = 'https://t.me/proxy?server=192.0.2.12&port=443&secret=dd3c4d5e6f708192a3b4c5d6e7f8091a';
const P13 = 'tg://proxy?server=192.0.2.13&port=443&secret=ee4d5e6f708192a3b4c5d6e7f8091a2b';

// Four survivors, one duplicate, one out-of-range port, one spam secret — so the scan
// exercises dedupe (silent), a malformed drop (silent) and #tileSkipped (spam only).
const PASTED_LIST = [
    P10,
    P11,
    P12,
    P13,
    P10,
    'tg://proxy?server=192.0.2.14&port=70000&secret=ee5e6f708192a3b4c5d6e7f8091a2b3c',
    `tg://proxy?server=192.0.2.15&port=443&secret=${'A'.repeat(42)}`,
].join('\n');

// What the fixture reports, after app.js sorts ascending by ping.
const EXPECTED_ROWS = [
    { server: '192.0.2.10', port: '443', ping: 120, cls: 'p-fast', link: P10 },
    { server: '192.0.2.12', port: '443', ping: 240, cls: 'p-mid', link: P12 },
    { server: '192.0.2.13', port: '443', ping: 480, cls: 'p-slow', link: P13 },
];

const proxyLine = (r) => `${r.link} # Ping: ${r.ping}ms`;

// Serves the canned stream and records what the client asked for. CRLF-normalised because
// the fixture is wire bytes and a checkout must not be able to change them.
async function stubStream(page, captured) {
    const bytes = (await readFile(fixture('sse-progress.txt'), 'utf8')).replace(/\r\n/g, '\n');
    await page.route('**/check-stream', async (route) => {
        captured.headers = route.request().headers();
        captured.body = JSON.parse(route.request().postData());
        await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
            body: bytes,
        });
    });
}

// Nothing in the default e2e run may leave the machine. Collected per test and asserted at
// the end of each one; a CDN font or an analytics beacon would show up here.
function trackHosts(page) {
    const hosts = new Set();
    page.on('request', (req) => hosts.add(new URL(req.url()).hostname));
    return hosts;
}

test.describe('full scan against the real server', () => {
    test('a pasted list runs to completion and fills the results panel', async ({ page }) => {
        const hosts = trackHosts(page);
        const captured = {};
        await stubStream(page, captured);

        await page.goto('/');

        // Pre-scan: the bar has no width yet and every tile is at its zero state.
        expect(await page.locator('#progressBar').evaluate((el) => el.style.width)).toBe('');
        await expect(page.locator('#tileChecked')).toHaveText('0');
        await expect(page.locator('#tileBest')).toHaveText('—');

        await page.locator('#inputProxies').fill(PASTED_LIST);
        await page.locator('#startBtn').click();

        // The scan is over once the Start button comes back out of its Stop state.
        await expect(page.locator('#startBtn')).toHaveClass('btn-start');

        // The client sent exactly the four survivors, with the settings the selects show.
        expect(captured.headers['x-concurrency']).toBe('50');
        expect(captured.body).toEqual([
            { server: '192.0.2.10', port: 443, secret: 'ee1a2b3c4d5e6f708192a3b4c5d6e7f8', timeout: 5 },
            { server: '192.0.2.11', port: 8443, secret: 'ee2b3c4d5e6f708192a3b4c5d6e7f809', timeout: 5 },
            { server: '192.0.2.12', port: 443, secret: 'dd3c4d5e6f708192a3b4c5d6e7f8091a', timeout: 5 },
            { server: '192.0.2.13', port: 443, secret: 'ee4d5e6f708192a3b4c5d6e7f8091a2b', timeout: 5 },
        ]);

        // Progress ran to the end, and the tiles agree with the fixture.
        await expect(page.locator('#progressBar')).toHaveAttribute('style', 'width: 100%;');
        await expect(page.locator('#tileChecked')).toHaveText('4');
        await expect(page.locator('#tileTotal')).toHaveText('4');
        await expect(page.locator('#tileWorking')).toHaveText('3');
        await expect(page.locator('#tileBest')).toHaveText('120 ms');
        await expect(page.locator('#tileFailed')).toHaveText('1');
        await expect(page.locator('#tileSkipped')).toHaveText('1');

        // One row per working proxy, sorted by ping, badge colour from pingClass.
        const rows = page.locator('#resultsBody tr');
        await expect(rows).toHaveCount(3);
        await expect(page.locator('#resultsCount')).toHaveText('3');

        for (const [i, expected] of EXPECTED_ROWS.entries()) {
            const cells = rows.nth(i).locator('td');
            await expect(cells.nth(0)).toHaveText(String(i + 1));
            await expect(cells.nth(1)).toHaveText(expected.server);
            await expect(cells.nth(2)).toHaveText(expected.port);
            await expect(cells.nth(3).locator('span.ping')).toHaveText(`${expected.ping} ms`);
            await expect(cells.nth(3).locator('span.ping')).toHaveClass(`ping ${expected.cls}`);
            await expect(cells.nth(4).locator('button.rowcopy')).toHaveAttribute('data-index', String(i));
        }

        for (const host of hosts) expect(host).toBe('127.0.0.1');
    });

    test('the plain-text view shows the same results, secrets included', async ({ page }) => {
        const hosts = trackHosts(page);
        await stubStream(page, {});
        await page.goto('/');

        await page.locator('#inputProxies').fill(PASTED_LIST);
        await page.locator('#startBtn').click();
        await expect(page.locator('#startBtn')).toHaveClass('btn-start');

        await expect(page.locator('#resultsPanel')).toHaveAttribute('data-view', 'table');

        await page.locator('#viewTextBtn').click();
        await expect(page.locator('#resultsPanel')).toHaveAttribute('data-view', 'text');
        await expect(page.locator('#viewTableBtn')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('#viewTextBtn')).toHaveAttribute('aria-pressed', 'true');

        // Same three results, same order, each carrying the original link it was pasted as.
        await expect(page.locator('#outputProxies')).toHaveValue(EXPECTED_ROWS.map(proxyLine).join('\n\n'));

        await page.locator('#viewTableBtn').click();
        await expect(page.locator('#resultsPanel')).toHaveAttribute('data-view', 'table');
        await expect(page.locator('#resultsBody tr')).toHaveCount(3);

        for (const host of hosts) expect(host).toBe('127.0.0.1');
    });

    test('the TXT and JSON exports download the secret-bearing links', async ({ page }) => {
        const hosts = trackHosts(page);
        await stubStream(page, {});
        await page.goto('/');

        await page.locator('#inputProxies').fill(PASTED_LIST);
        await page.locator('#startBtn').click();
        await expect(page.locator('#startBtn')).toHaveClass('btn-start');

        const txtWait = page.waitForEvent('download');
        await page.locator('#exportTxtBtn').click();
        const txt = await txtWait;
        expect(txt.suggestedFilename()).toBe('proxies.txt');
        const txtBody = await readFile(await txt.path(), 'utf8');
        expect(txtBody).toBe(EXPECTED_ROWS.map(proxyLine).join('\n\n'));

        const jsonWait = page.waitForEvent('download');
        await page.locator('#exportJsonBtn').click();
        const json = await jsonWait;
        expect(json.suggestedFilename()).toBe('proxies.json');
        const jsonBody = JSON.parse(await readFile(await json.path(), 'utf8'));
        expect(jsonBody).toEqual(EXPECTED_ROWS.map((r) => ({ link: r.link, ping: r.ping })));

        // The whole point of the export: the secret survives the round trip.
        for (const row of EXPECTED_ROWS) {
            const secret = new URL(row.link).searchParams.get('secret');
            expect(txtBody).toContain(secret);
            expect(JSON.stringify(jsonBody)).toContain(secret);
        }

        for (const host of hosts) expect(host).toBe('127.0.0.1');
    });
});

// The Load-list button's first step is POST /fetch-sources, which is the server dialling out on
// the page's behalf. Every test here stubs that route, so the browser stays on 127.0.0.1 and the
// server never leaves the machine either.
test.describe('the load-list button against its three network conditions', () => {
    const LIVE_LINK = 'tg://proxy?server=198.51.100.70&port=443&secret=ee7a8b9c0d1e2f3a4b5c6d7e8f901a2b';
    const LIVE_SNAPSHOT = [
        '# generated 2026-08-10T02:00:00.000Z by scripts/build-snapshot.mjs',
        '# 0 iwh3n/tg-proxy/refs/heads/main/proxys/All_Proxys.txt',
        `${LIVE_LINK}#seen=3;src=0`,
        '',
    ].join('\n');

    async function stubFetchSources(page, respond) {
        await page.route('**/fetch-sources', respond);
    }

    test('a reachable snapshot branch fills the textarea from the live list', async ({ page }) => {
        const hosts = trackHosts(page);
        await stubFetchSources(page, (route) => route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: LIVE_SNAPSHOT,
        }));
        await page.goto('/');

        await page.locator('#loadListBtn').click();
        await expect(page.locator('#inputProxies')).toHaveValue(LIVE_LINK);
        await expect(page.locator('#toast')).toHaveClass('toast show success');
        await expect(page.locator('#console')).toContainText('nightly list');

        for (const host of hosts) expect(host).toBe('127.0.0.1');
    });

    test('an unreachable snapshot branch falls back to the list baked into the binary', async ({ page }) => {
        const hosts = trackHosts(page);
        // What the real handler answers when it could not reach the source: 200, and nothing in
        // the body. A source that failed is skipped, not turned into a failed request.
        await stubFetchSources(page, (route) => route.fulfill({ status: 200, body: '' }));
        await page.goto('/');

        await page.locator('#loadListBtn').click();
        await expect(page.locator('#inputProxies')).not.toHaveValue('');
        await expect(page.locator('#inputProxies')).not.toHaveValue(LIVE_LINK);
        await expect(page.locator('#toast')).toHaveClass('toast show success');
        await expect(page.locator('#console')).toContainText('built-in list');

        for (const host of hosts) expect(host).toBe('127.0.0.1');
    });

    test('both steps failing toasts an error and leaves the paste alone', async ({ page }) => {
        const hosts = trackHosts(page);
        // What the real handler answers when it could not reach the source: 200, and nothing in
        // the body. A source that failed is skipped, not turned into a failed request.
        await stubFetchSources(page, (route) => route.fulfill({ status: 200, body: '' }));
        // The embed is stubbed away too, which is the only way to reach the both-fail path from
        // a binary that always carries a usable copy.
        await page.route('**/data/snapshot.txt', (route) => route.fulfill({ status: 404, body: '' }));
        await page.goto('/');

        await page.locator('#inputProxies').fill(P10);
        await page.locator('#loadListBtn').click();

        await expect(page.locator('#toast')).toHaveClass('toast show error');
        await expect(page.locator('#inputProxies')).toHaveValue(P10);
        await expect(page.locator('#consoleDrawer')).toHaveAttribute('open', '');

        for (const host of hosts) expect(host).toBe('127.0.0.1');
    });
});
