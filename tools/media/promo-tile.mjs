// The 440x280 small promotional tile, which the Chrome Web Store requires to accept a submission.
//
// It is typographic on purpose. At this size a screenshot of the panel turns to mush and the store's own
// guidance is to avoid small text, so the tile carries the mark, the name and one line, in the same palette
// and with the same claim as the social card. Anything more would be unreadable at the size it is shown.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout.
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 440px; height: 280px; overflow: hidden; display: flex; flex-direction: column;
    justify-content: center; padding: 0 34px; color: #14162a;
    font: 16px/1.5 -apple-system, system-ui, sans-serif;
    background: radial-gradient(420px 260px at 84% 6%, #d9deff, transparent), linear-gradient(135deg, #fbfbff, #eef0ff); }
  .logo { width: 44px; height: 44px; }
  h1 { font-size: 31px; letter-spacing: -0.025em; margin: 16px 0 9px; }
  .claim { font-size: 16px; font-weight: 600; line-height: 1.35; color: #2b2f52; }
  .sub { font-size: 13px; margin-top: 9px; color: #5b5f80; }
</style>
<svg class="logo" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#6f4ff0"/></linearGradient></defs>
  <rect x="6" y="6" width="116" height="116" rx="28" fill="url(#g)"/>
  <path d="M34 32h60a12 12 0 0 1 12 12v28a12 12 0 0 1-12 12H62l-16 15V84H34a12 12 0 0 1-12-12V44a12 12 0 0 1 12-12z" fill="#fff"/>
  <g fill="#5a6bff"><rect x="40" y="51" width="7" height="16" rx="3.5"/><rect x="52" y="45" width="7" height="28" rx="3.5"/><rect x="64" y="40" width="7" height="38" rx="3.5"/><rect x="76" y="46" width="7" height="26" rx="3.5"/><rect x="88" y="52" width="7" height="14" rx="3.5"/></g>
</svg>
<h1>Meet Live Assist</h1>
<p class="claim">Your own agent session, in the call with you.</p>
<p class="sub">Meet and Zoom. Runs on your machine.</p>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(200);
await page.screenshot({ path: `${ROOT}/docs/media/store-promo-440x280.png` });
await browser.close();
console.log('docs/media/store-promo-440x280.png');
