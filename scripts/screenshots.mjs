// Retakes the four README screenshots, one per locale, with a finished scan on
// screen instead of the empty state. /check-stream is answered from
// tests/fixtures/sse-progress.txt, so nothing leaves the machine and the pings
// in the image are the ones scan.spec.js already asserts. No live proxy has
// ever appeared in these images; keep it that way.
//
//   go run .                 # in one shell, or NO_BROWSER=1 go run .
//   node scripts/screenshots.mjs
//
// Unlike the e2e suite this does not boot the server itself: retaking is a
// deliberate, eyeball-the-result act, not something to run unattended.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const BASE = 'http://127.0.0.1:3000/';

const P10 = 'tg://proxy?server=192.0.2.10&port=443&secret=ee1a2b3c4d5e6f708192a3b4c5d6e7f8';
const P11 = 'tg://proxy?server=192.0.2.11&port=8443&secret=ee2b3c4d5e6f708192a3b4c5d6e7f809';
const P12 = 'https://t.me/proxy?server=192.0.2.12&port=443&secret=dd3c4d5e6f708192a3b4c5d6e7f8091a';
const P13 = 'tg://proxy?server=192.0.2.13&port=443&secret=ee4d5e6f708192a3b4c5d6e7f8091a2b';

const PASTED = [
    P10,
    P11,
    P12,
    P13,
    P10,
    'tg://proxy?server=192.0.2.14&port=70000&secret=ee5e6f708192a3b4c5d6e7f8091a2b3c',
    `tg://proxy?server=192.0.2.15&port=443&secret=${'A'.repeat(42)}`,
].join('\n');

const SHOTS = [
    { lang: 'en', file: 'screenshot.png' },
    { lang: 'fa', file: 'screenshot_fa.png' },
    { lang: 'ru', file: 'screenshot_ru.png' },
    { lang: 'zh', file: 'screenshot_zh.png' },
];

const bytes = (await readFile(repo('tests/fixtures/sse-progress.txt'), 'utf8')).replace(/\r\n/g, '\n');

const browser = await chromium.launch();

for (const { lang, file } of SHOTS) {
    // Matches the width of the screenshots being replaced: 1836 CSS px at 2x.
    const context = await browser.newContext({ viewport: { width: 1836, height: 1100 }, deviceScaleFactor: 2 });
    const page = await context.newPage();

    await page.route('**/check-stream', (route) => route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: bytes,
    }));

    await page.goto(BASE);
    await page.selectOption('#langSelect', lang);
    await page.fill('#inputProxies', PASTED);
    await page.click('#startBtn');

    // Three survivors in the fixture; wait for the last row rather than a timer.
    await page.waitForFunction(() => document.querySelectorAll('#resultsBody tr').length === 3);
    // The start button flips back to its idle label only once finish() has run.
    await page.waitForFunction(() => !document.body.classList.contains('scanning'));
    // The finish toast sits over the third row's ping badge for 3s.
    await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'));
    await page.waitForTimeout(400);   // let the toast fade and the progress bar settle
    await page.evaluate(() => document.activeElement?.blur());   // no focus ring on the start button

    await page.screenshot({ path: repo(`images/${file}`), fullPage: true });
    console.log(`${file} written`);
    await context.close();
}

await browser.close();
