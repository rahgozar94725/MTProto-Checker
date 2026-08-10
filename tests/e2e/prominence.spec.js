// Checkpoint B, item 4: Task 0's staleness verdict applied to the UI.
//
// Task 0 measured a 23-hour-old snapshot at 38.6 % / 35.4 % working against a same-minute
// fresh build at 39.2 %, and concluded the baked list is a *headline feature* rather than a
// fallback. The button shipped as a peer of the secondary File button instead: same row,
// same flex share, and literally the same gradient, because components.css styled both with
// one `.btn-file, .btn-load { … }` rule.
//
// Prominence is a cascade outcome, not a source-text one — a later rule, a specificity
// change or a theme override can quietly re-merge the two without touching the line this
// test would otherwise grep for. So these read `getComputedStyle` off the real page in a
// real browser, in both themes, since the light-theme override was a third shared rule.
import { test, expect } from '@playwright/test';

const styleOf = (page, selector, prop) =>
    page.locator(selector).evaluate((el, p) => getComputedStyle(el)[p], prop);

test.describe('the built-in list button carries its own weight', () => {
    for (const theme of ['dark', 'light']) {
        test(`#loadListBtn is not styled as a peer of the File button (${theme})`, async ({ page }) => {
            await page.goto('/');
            await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

            const load = await styleOf(page, '#loadListBtn', 'backgroundImage');
            const file = await styleOf(page, '.btn-file', 'backgroundImage');

            // A gradient of its own, and not the one the secondary button wears.
            expect(load).toContain('gradient');
            expect(load).not.toBe(file);
        });
    }

    test('#loadListBtn takes more of the row than the File button', async ({ page }) => {
        await page.goto('/');

        const load = Number(await styleOf(page, '#loadListBtn', 'flexGrow'));
        const file = Number(await styleOf(page, '.btn-file', 'flexGrow'));

        expect(load).toBeGreaterThan(file);

        // Width is what the user actually sees; flex-grow only implies it while both are in
        // the same row with the same basis.
        const loadBox = await page.locator('#loadListBtn').boundingBox();
        const fileBox = await page.locator('.btn-file').boundingBox();
        expect(loadBox.width).toBeGreaterThan(fileBox.width);
    });
});
