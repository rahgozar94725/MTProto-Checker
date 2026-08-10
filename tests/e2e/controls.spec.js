// The regression guard for the ES-module conversion.
//
// Every control used to be an inline onclick/onchange attribute in index.html. They are now
// addEventListener calls at the bottom of app.js, and a dropped or misspelled line there is
// invisible to every other layer of the suite: the unit tests import the modules directly,
// and jsdom cannot execute <script type="module"> at all. Only a real browser loading the
// real page proves the wiring survived — so each of the thirteen controls below gets an
// assertion on an effect the user can see.
//
// Expected labels come from public/js/i18n.js rather than from literals; locale parity is
// already pinned by tests/unit/i18n.test.js, and duplicating the strings here would only
// mean editing them twice.
import { test, expect } from '@playwright/test';
import { translations } from '../../public/js/i18n.js';
import { DEFAULT_SOURCES } from '../../public/js/sources.js';

const T = translations.fa; // the default locale, and what the page boots with

const LINK = 'tg://proxy?server=192.0.2.20&port=443&secret=ee1a2b3c4d5e6f708192a3b4c5d6e7f8';
const PING = 150;

// One working proxy, then done — enough to put a row on the page so the copy path has
// something to copy. Raw wire bytes, same shape the Go handler emits.
const ONE_WORKING_STREAM = [
    'event: progress',
    'data: {"completed":1,"total":1,"working":1,"server":"192.0.2.20","port":443,' +
        '"secret":"ee1a2b3c4d5e6f708192a3b4c5d6e7f8","ok":true,"ping":150}',
    '',
    'event: done',
    'data: {"working":1,"total":1}',
    '',
    '',
].join('\n');

// Anything the browser itself considers an error — a thrown exception, a failed module
// import, a ReferenceError from a handler that no longer resolves. Collected per test and
// asserted empty at the end of each one.
function collectErrors(page) {
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    return errors;
}

// The toast is one shared element and every guard below writes the same string into it, so
// a stale "show" from the previous click would satisfy the next assertion. Clearing it
// between clicks makes each assertion prove its own button fired.
async function clearToast(page) {
    await page.evaluate(() => {
        const el = document.getElementById('toast');
        el.className = 'toast';
        el.textContent = '';
    });
}

async function expectToast(page, message, kind) {
    await expect(page.locator('#toast')).toHaveText(message);
    await expect(page.locator('#toast')).toHaveClass(`toast show ${kind}`);
}

test.describe('every migrated control still fires', () => {
    test('#themeToggle flips the theme and it survives a reload', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        const html = page.locator('html');
        await expect(html).toHaveAttribute('data-theme', 'dark');

        await page.locator('#themeToggle').click();
        await expect(html).toHaveAttribute('data-theme', 'light');
        expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');

        // The <head> bootstrap, not app.js, is what has to apply this before first paint.
        await page.reload();
        await expect(html).toHaveAttribute('data-theme', 'light');

        await page.locator('#themeToggle').click();
        await expect(html).toHaveAttribute('data-theme', 'dark');

        expect(errors).toEqual([]);
    });

    test('#langSelect relabels the whole UI, table headers included', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        for (const lang of ['en', 'ru', 'zh', 'fa']) {
            const t = translations[lang];
            await page.locator('#langSelect').selectOption(lang);

            await expect(page.locator('html')).toHaveAttribute('lang', lang);
            await expect(page.locator('html')).toHaveAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');

            // The table headers are the part a naive "translate the buttons" pass misses.
            const headers = page.locator('.results-table thead th');
            await expect(headers.nth(1)).toHaveText(t.thServer);
            await expect(headers.nth(2)).toHaveText(t.thPort);
            await expect(headers.nth(3)).toHaveText(t.thPing);

            await expect(page.locator('#startBtn')).toHaveText(t.startBtn);
            await expect(page.locator('#helpBtn')).toHaveText(t.helpBtn);
            await expect(page.locator('#viewTableBtn')).toHaveText(t.viewTable);
            await expect(page.locator('#viewTextBtn')).toHaveText(t.viewText);
            await expect(page.locator('#inputProxies')).toHaveAttribute('placeholder', t.inputPlaceholder);
        }

        await page.locator('#langSelect').selectOption('ru');
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
        await expect(page.locator('#startBtn')).toHaveText(translations.ru.startBtn);

        expect(errors).toEqual([]);
    });

    test('#helpBtn opens the README for the active language', async ({ page }) => {
        const errors = collectErrors(page);

        // Stubbed rather than fetched: the default e2e run must not leave the machine, and
        // GitHub being reachable is not what this test is about.
        await page.context().route('https://github.com/**', (route) =>
            route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }));

        await page.goto('/');

        const openHelp = async (expected) => {
            const [popup] = await Promise.all([
                page.waitForEvent('popup'),
                page.locator('#helpBtn').click(),
            ]);
            await popup.waitForLoadState();
            expect(popup.url()).toBe(expected);
            await popup.close();
        };

        await openHelp('https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_FA.md');

        await page.locator('#langSelect').selectOption('ru');
        await openHelp('https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_RU.md');

        expect(errors).toEqual([]);
    });

    test('#fileInput loads a picked file into the textarea', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        await page.locator('#fileInput').setInputFiles({
            name: 'proxies.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from(`${LINK}\n`),
        });

        await expect(page.locator('#inputProxies')).toHaveValue(`${LINK}\n`);
        await expect(page.locator('#console')).toContainText('Loaded file: proxies.txt');

        expect(errors).toEqual([]);
    });

    test('#loadListBtn fills the textarea from the embedded snapshot', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        // Nothing is shown before a load: the date line collapses to nothing.
        await expect(page.locator('#snapshotMeta')).toHaveText('');

        // No route stub — /data/snapshot.txt comes off the //go:embed tree, which is the
        // whole point of the button. The count is left to the file; the shape is not.
        await page.locator('#loadListBtn').click();
        await expect(page.locator('#inputProxies')).not.toHaveValue('');

        const lines = (await page.locator('#inputProxies').inputValue()).split('\n');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line).toMatch(/^tg:\/\/proxy\?server=/);
            expect(line).not.toContain('#seen=');
        }

        await expect(page.locator('#toast')).toHaveClass('toast show success');
        await expect(page.locator('#snapshotMeta')).not.toHaveText('');
        await expect(page.locator('#console')).toContainText('links from the built-in list');

        expect(errors).toEqual([]);
    });

    test('#sourcesList disables a source and the choice survives a reload', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        // Collapsed by default, so the rows are there but not in the way.
        await expect(page.locator('#sourcesList .source-row')).toHaveCount(DEFAULT_SOURCES.length);
        await expect(page.locator('#sourcesList input[type="checkbox"]').nth(1)).toBeHidden();

        await page.locator('#sourcesDrawer summary').click();
        const boxes = page.locator('#sourcesList input[type="checkbox"]');
        await expect(boxes.nth(1)).toBeChecked();
        await expect(page.locator('#sourcesList .source-row').nth(1)).toContainText(T.sourceUnscored);

        await boxes.nth(1).uncheck();
        await expect(boxes.nth(1)).not.toBeChecked();
        await expect(boxes.nth(0)).toBeChecked();

        // The point of persisting it: a source turned off stays off.
        await page.reload();
        await page.locator('#sourcesDrawer summary').click();
        await expect(page.locator('#sourcesList input[type="checkbox"]').nth(1)).not.toBeChecked();

        expect(errors).toEqual([]);
    });

    test('#viewTableBtn and #viewTextBtn flip the results view both ways', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        const panel = page.locator('#resultsPanel');
        await expect(panel).toHaveAttribute('data-view', 'table');

        await page.locator('#viewTextBtn').click();
        await expect(panel).toHaveAttribute('data-view', 'text');
        await expect(page.locator('#viewTableBtn')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('#viewTextBtn')).toHaveAttribute('aria-pressed', 'true');

        await page.locator('#viewTableBtn').click();
        await expect(panel).toHaveAttribute('data-view', 'table');
        await expect(page.locator('#viewTableBtn')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#viewTextBtn')).toHaveAttribute('aria-pressed', 'false');

        expect(errors).toEqual([]);
    });

    test('#exportTxtBtn and #exportJsonBtn refuse an empty list instead of downloading', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');

        let downloads = 0;
        page.on('download', () => { downloads++; });

        await page.locator('#exportTxtBtn').click();
        await expectToast(page, T.toastEmpty, 'error');

        await clearToast(page);
        await page.locator('#exportJsonBtn').click();
        await expectToast(page, T.toastEmpty, 'error');

        expect(downloads).toBe(0);
        expect(errors).toEqual([]);
    });
});

test.describe('controls that need a scan behind them', () => {
    // #copyBtn writes through navigator.clipboard, which needs the permission granted at the
    // context level. 127.0.0.1 is already a secure context in Chromium, so no HTTPS games.
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('#startBtn runs a scan and #copyBtn copies the result', async ({ page }) => {
        const errors = collectErrors(page);
        await page.route('**/check-stream', (route) => route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
            body: ONE_WORKING_STREAM,
        }));

        await page.goto('/');
        await page.locator('#inputProxies').fill(LINK);
        await page.locator('#startBtn').click();

        // Back to btn-start means the scan reached finish().
        await expect(page.locator('#startBtn')).toHaveClass('btn-start');
        await expect(page.locator('#resultsBody tr')).toHaveCount(1);

        // The interpolated success toast, which the unit suites can only assert in isolation.
        await expectToast(page, T.toastFound.replace('{n}', '1'), 'success');

        await clearToast(page);
        await page.locator('#copyBtn').click();
        await expectToast(page, T.toastCopied, 'success');

        // The copied text carries the original pasted link, secret included.
        const clipboard = await page.evaluate(() => navigator.clipboard.readText());
        expect(clipboard).toBe(`${LINK} # Ping: ${PING}ms`);

        expect(errors).toEqual([]);
    });

    test('#startBtn stops a running scan and #pauseBtn pauses and resumes it', async ({ page }) => {
        const errors = collectErrors(page);

        // The stream is held open so the scan stays in flight: pause and stop both work by
        // aborting the request, and neither is observable against a stream that already ended.
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const posted = [];
        await page.route('**/check-stream', async (route) => {
            posted.push(JSON.parse(route.request().postData()));
            await held;
            // The client aborted this request long ago; fulfilling it now is best-effort.
            await route.fulfill({ status: 200, body: '' }).catch(() => {});
        });

        await page.goto('/');
        await page.locator('#inputProxies').fill(LINK);
        await page.locator('#startBtn').click();

        // Scanning: Start became Stop, Pause appeared, the input pane collapsed to a summary.
        await expect(page.locator('#startBtn')).toHaveClass('btn-stop');
        await expect(page.locator('#startBtn')).toHaveText(T.stopBtn);
        await expect(page.locator('#pauseBtn')).toBeVisible();
        await expect(page.locator('#inputProxies')).toBeHidden();
        await expect(page.locator('#inputSummary')).toHaveText(
            T.summaryLoaded.replace('{n}', '1').replace('{m}', '0'));

        await page.locator('#pauseBtn').click();
        await expect(page.locator('#pauseBtn')).toHaveText(T.resumeBtn);
        await expect(page.locator('#pauseBtn')).toHaveClass('btn-pause resume');
        await expect(page.locator('#console')).toContainText('PAUSED');
        // A pause deliberately leaves the input collapsed; only a stop restores it.
        await expect(page.locator('#inputProxies')).toBeHidden();
        expect(posted).toHaveLength(1);

        await page.locator('#pauseBtn').click();
        await expect(page.locator('#pauseBtn')).toHaveText(T.pauseBtn);
        await expect(page.locator('#console')).toContainText('RESUMED');
        // Resume is a second POST of what is still unchecked — here, the whole list.
        await expect.poll(() => posted.length).toBe(2);
        expect(posted[1]).toEqual([
            { server: '192.0.2.20', port: 443, secret: 'ee1a2b3c4d5e6f708192a3b4c5d6e7f8', timeout: 5 },
        ]);

        await page.locator('#startBtn').click();
        await expect(page.locator('#startBtn')).toHaveClass('btn-start');
        await expect(page.locator('#pauseBtn')).toBeHidden();
        await expect(page.locator('#inputProxies')).toBeVisible();
        await expect(page.locator('#console')).toContainText('STOPPED');

        release();
        expect(errors).toEqual([]);
    });
});
