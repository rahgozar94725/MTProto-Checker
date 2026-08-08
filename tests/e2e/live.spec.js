// The only test in the repo that talks to the real /check-stream with no stub in front of
// it. Everything else routes the endpoint, which means everything else would stay green if
// the server changed its SSE contract — renamed an event, moved a field, stopped emitting
// `done`. This one would not.
//
// It costs a real Telegram handshake attempt per run, so it is opt-in: E2E_LIVE=1.
import { test, expect } from '@playwright/test';

test.skip(!process.env.E2E_LIVE, 'live smoke test: set E2E_LIVE=1 to run it');

// RFC 5737 documentation address. Nothing listens there, by definition — so the run is
// deterministic in its outcome (all failed) while still exercising the whole real path:
// handler, TCP pre-check, SSE framing, done event.
const BOGUS = 'tg://proxy?server=192.0.2.99&port=443&secret=ee1a2b3c4d5e6f708192a3b4c5d6e7f8';

test('a bogus proxy fails cleanly against the real endpoint', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });

    await page.goto('/');
    await page.locator('#inputProxies').fill(BOGUS);
    await page.locator('#startBtn').click();

    // A real dial has to time out first: tcpTimeout is 1.5s, the selected timeout 5s, and
    // the client's own watchdog far longer. 60s is slack, not an expectation.
    await expect(page.locator('#startBtn')).toHaveClass('btn-start', { timeout: 60_000 });

    await expect(page.locator('#tileChecked')).toHaveText('1');
    await expect(page.locator('#tileTotal')).toHaveText('1');
    await expect(page.locator('#tileWorking')).toHaveText('0');
    await expect(page.locator('#tileFailed')).toHaveText('1');
    await expect(page.locator('#tileSkipped')).toHaveText('0');
    await expect(page.locator('#resultsBody tr')).toHaveCount(0);

    // Failure is a normal outcome, not an error path: the run ends with the no-working
    // toast, and nothing in the page threw on the way there.
    await expect(page.locator('#toast')).toHaveClass('toast show error');
    await expect(page.locator('#console')).toContainText('Process finished.');
    expect(errors).toEqual([]);
});
