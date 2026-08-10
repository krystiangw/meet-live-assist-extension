// Social card: the brand block on the left, the panel-in-a-call render bleeding off the right edge.
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node stage.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shot = readFileSync(`${ROOT}/docs/media/call-share.png`).toString('base64');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; display: flex; align-items: center; overflow: hidden;
    font: 16px/1.5 -apple-system, system-ui, sans-serif; color: #14162a;
    background: radial-gradient(900px 500px at 78% 10%, #d9deff, transparent), linear-gradient(135deg, #fbfbff, #eef0ff); }
  .left { width: 600px; padding: 0 0 0 72px; }
  .logo { width: 64px; height: 64px; border-radius: 16px; }
  h1 { font-size: 58px; letter-spacing: -0.03em; margin: 22px 0 14px; }
  .claim { font-size: 27px; font-weight: 600; line-height: 1.3; color: #2b2f52; }
  .sub { font-size: 19px; margin-top: 18px; color: #5b5f80; }
  .right { flex: 1; height: 630px; position: relative; }
  /* The panel is the product, so the whole window has to fit - a crop that shows only the shared screen
     advertises the wrong half. */
  .right img { position: absolute; top: 158px; left: -12px; width: 636px; border-radius: 12px;
    border: 1px solid #dfe2f2; box-shadow: 0 30px 70px rgba(80, 70, 200, .28); transform: rotate(-2.2deg); }
</style>
<div class="left">
  <svg class="logo" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#6f4ff0"/></linearGradient></defs>
    <rect x="6" y="6" width="116" height="116" rx="28" fill="url(#g)"/>
    <path d="M34 32h60a12 12 0 0 1 12 12v28a12 12 0 0 1-12 12H62l-16 15V84H34a12 12 0 0 1-12-12V44a12 12 0 0 1 12-12z" fill="#fff"/>
    <g fill="#5a6bff"><rect x="40" y="51" width="7" height="16" rx="3.5"/><rect x="52" y="45" width="7" height="28" rx="3.5"/><rect x="64" y="40" width="7" height="38" rx="3.5"/><rect x="76" y="46" width="7" height="26" rx="3.5"/><rect x="88" y="52" width="7" height="14" rx="3.5"/></g>
  </svg>
  <h1>Meet Live Assist</h1>
  <p class="claim">Your own agent session, in the call with you.</p>
  <p class="sub">Reads the Meet or Zoom transcript live and answers in a side panel.<br/>Runs on your machine. No account, no telemetry.</p>
</div>
<div class="right"><img src="data:image/png;base64,${shot}" /></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: `${ROOT}/docs/media/og-card.png` });
await browser.close();
