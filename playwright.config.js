// Playwright drives the real product: the Go server serving the embedded public/ tree, not a
// static file copy. That is the point of the e2e layer — it is the only place where the
// //go:embed path, the module graph the browser actually loads, and Chromium's own URL and
// download behaviour are exercised together.
//
// NO_BROWSER=1 keeps the server from opening the user's browser on top of Playwright's.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: 'tests/e2e',
    // The suite shares one server and one fixed port; parallel workers would race on it.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list'], ['html', { open: 'never' }]],

    use: {
        baseURL: 'http://127.0.0.1:3000',
        trace: 'on-first-retry',
    },

    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],

    webServer: {
        command: 'go run .',
        url: 'http://127.0.0.1:3000',
        env: { NO_BROWSER: '1' },
        reuseExistingServer: !process.env.CI,
        // `go run .` compiles first; a cold module cache needs well over the 60s default.
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
