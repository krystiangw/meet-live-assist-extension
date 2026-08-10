// The two 1280x800 tiles the Chrome Web Store listing needs. Each one is a caption plus the real panel,
// rendered live - not a photograph of a browser window. Deliberately: faking a call grid would mean
// inventing faces, and a listing image that invents its own users is the one thing a reviewer should reject.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fillPanel, PANEL_URL, OUT, RELEASE_REVIEW, COPILOT } from './panel.mjs';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node store.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
mkdirSync(OUT, { recursive: true });

const TILES = [
  {
    file: 'store-1-in-a-call.png',
    script: RELEASE_REVIEW,
    title: 'Advice while the call is<br/>still going',
    lines: [
      'It reads the Meet or Zoom transcript as it happens.',
      'The sentence to say next, the decision just made, the risk you are about to agree to.',
      'Everything stays on your machine: no account, no telemetry.',
    ],
  },
  {
    file: 'store-2-co-pilot.png',
    script: COPILOT,
    title: 'The same panel with<br/>nobody else in the room',
    lines: [
      'Co-pilot mode needs no meeting at all.',
      'It watches the tab you are working in and listens while you think out loud.',
      'The answers come from your own context: your notes, your repo, your tickets.',
    ],
  },
];

const card = (tile, shot) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 800px; display: flex; align-items: center; overflow: hidden;
    font: 16px/1.5 -apple-system, system-ui, sans-serif; color: #14162a;
    background: radial-gradient(900px 600px at 80% 0%, #dde1ff, transparent), linear-gradient(140deg, #fcfcff, #eceeff); }
  .left { width: 700px; padding: 0 40px 0 76px; }
  h1 { font-size: 50px; line-height: 1.12; letter-spacing: -0.03em; }
  ul { margin-top: 30px; padding: 0; list-style: none; }
  li { font-size: 21px; line-height: 1.45; color: #3a3f63; padding-left: 30px; margin-bottom: 18px; position: relative; }
  li::before { content: ""; position: absolute; left: 0; top: 11px; width: 12px; height: 12px; border-radius: 4px;
    background: linear-gradient(135deg, #4f7cff, #6f4ff0); }
  .right { flex: 1; height: 800px; position: relative; }
  .right img { position: absolute; top: 40px; left: 84px; width: 370px; border-radius: 18px;
    border: 1px solid #dfe2f2; box-shadow: 0 30px 70px rgba(80, 70, 200, .28); }
</style>
<div class="left"><h1>${tile.title}</h1><ul>${tile.lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>
<div class="right"><img src="data:image/png;base64,${shot}" /></div>`;

const browser = await chromium.launch();
for (const tile of TILES) {
  const panel = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
  await panel.goto(PANEL_URL);
  await fillPanel(panel, tile.script);
  const shot = (await panel.screenshot({ fullPage: true })).toString('base64');
  await panel.close();

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.setContent(card(tile, shot));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, tile.file) });
  await page.close();
  console.log('  ' + tile.file);
}
await browser.close();
