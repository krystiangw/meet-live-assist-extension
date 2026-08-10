// The two stills that put the panel back where it lives: docked beside a call, and beside a shared screen.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fillPanel, PANEL_URL, OUT, RELEASE_REVIEW } from './panel.mjs';
import { W, H, PANEL_W, BAR_H, shell, gridStage, shareStage } from './call-shell.mjs';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node stage.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
mkdirSync(OUT, { recursive: true });

// The panel is rendered on its own first and pasted in as an image: a file:// iframe inside a generated
// document is same-origin-blocked, and the pixels are identical either way.
const browser = await chromium.launch();

async function renderPanel(script, h) {
  const p = await browser.newPage({ viewport: { width: PANEL_W, height: h - BAR_H }, deviceScaleFactor: 2 });
  await p.goto(PANEL_URL);
  await fillPanel(p, script);
  const png = (await p.screenshot()).toString('base64');
  await p.close();
  return png;
}

async function shoot(file, stage, panelScript, { w = W, h = H, scale = 2, ...tab } = {}) {
  const panel = await renderPanel(panelScript, h);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.setContent(shell(stage, panel, { w, h, ...tab }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
  console.log('  ' + file);
}

// A five-line transcript ends on a half-clipped row in the shorter docked panel. Show what fits.
const DOCKED = { ...RELEASE_REVIEW, transcript: RELEASE_REVIEW.transcript.slice(0, 3), chat: RELEASE_REVIEW.chat.slice(0, 2) };

await shoot('call-share.png', shareStage('Marc T.'), DOCKED);

// The Chrome Web Store wants exactly 1280x800, and the same composite is the most honest tile there is:
// the extension doing its job, in the window it does it in.
const STORE = { w: 1280, h: 800, scale: 1 };
// 44px less dock height clips the chat composer, so the shorter tile carries a shorter transcript.
const DOCKED_SHORT = { ...RELEASE_REVIEW, transcript: RELEASE_REVIEW.transcript.slice(0, 2), chat: RELEASE_REVIEW.chat.slice(0, 1) };
await shoot('store-3-in-a-call.png', gridStage('Marc T.'), DOCKED_SHORT, STORE);
await shoot('store-4-screen-share.png', shareStage('Marc T.'), DOCKED_SHORT, STORE);

await browser.close();
