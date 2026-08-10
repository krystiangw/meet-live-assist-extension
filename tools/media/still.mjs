// The whole panel in one image, for the landing page.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fillPanel, PANEL_URL, OUT, RELEASE_REVIEW } from './panel.mjs';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node still.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(PANEL_URL);
await fillPanel(page, RELEASE_REVIEW);
await page.screenshot({ path: path.join(OUT, 'panel-full.png'), fullPage: true });
console.log('  panel-full.png');
await browser.close();
