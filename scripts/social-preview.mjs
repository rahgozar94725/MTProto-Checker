// Renders scripts/social-preview.html to images/social-preview.png, the card
// GitHub unfurls wherever a link to this repo is shared. Upload it by hand in
// Settings → General → Social preview; GitHub never reads it from the tree,
// which is exactly why the source lives here — without it, changing one word
// six months from now means rebuilding the card from scratch.
//
//   node scripts/social-preview.mjs
//
// Needs no server: the page is opened over file://, and the Inter woff2 it
// pulls is the one already in public/fonts. Like scripts/screenshots.mjs this
// is a look-at-the-result act, not something to run unattended.
//
// 1280x640 at 2x. GitHub wants 2:1 and caps the upload at 1 MB; the render is
// ~0.7 MB, so a redesign with a photographic background would need checking.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });

await page.goto(pathToFileURL(repo('scripts/social-preview.html')).href);
// The card is entirely type; screenshotting before the woff2 lands renders it
// in the fallback face and the wordmark comes out a different width.
await page.evaluate(() => document.fonts.ready);

await page.screenshot({ path: repo('images/social-preview.png') });
console.log('images/social-preview.png written');

await browser.close();
