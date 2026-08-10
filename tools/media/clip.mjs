// The still shows the end state. This shows the thing that actually sells it: advice ARRIVING while people
// are still talking. Same real panel, played forward frame by frame.
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node still.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRAMES = path.join(tmpdir(), 'mla-frames');
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 492 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(ROOT, 'src', 'sidepanel.html'));

await page.evaluate(() => {
  const set = (id, t, c) => { const e = document.getElementById(id); if (e) { e.textContent = t; if (c) e.className = 'status ' + c; } };
  set('capStatus', 'capturing', 'ok'); set('srvStatus', 'server ✓', 'ok');
  set('brainStatus', '🧠 assistant on', 'ok'); set('snapStatus', 'shots 3', 'idle');
  document.getElementById('session').textContent = '2026-08-10_release-review';
  document.getElementById('modeSel').value = 'lead';
  document.getElementById('log').innerHTML = '';
  document.getElementById('advice').innerHTML = '';
  // Hide the sections that would only be noise in a short loop - the element itself and its label, NOT the
  // parent: these blocks are siblings directly in <body>, so hiding a parent hides the whole panel.
  const hide = (el) => { if (el) el.style.display = 'none'; };
  for (const id of ['items', 'itemCtl', 'chat']) {
    const e = document.getElementById(id);
    hide(e);
    if (e && e.previousElementSibling && e.previousElementSibling.classList.contains('section-label')) hide(e.previousElementSibling);
  }
  // The chat composer and quick-asks sit at the bottom and would eat the frame.
  for (const sel of ['#chatForm', '#quickAsk']) hide(document.querySelector(sel));
  // The loop is short and the panel is tall - let advice and transcript share the frame instead of
  // capping advice at 46vh and scrolling the newest card out of view.
  document.getElementById('advice').style.maxHeight = 'none';
});

const say = (ts, who, text) => page.evaluate(([ts, who, text]) => {
  const log = document.getElementById('log');
  const d = document.createElement('div'); d.className = 'line';
  const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts + ' ';
  const w = document.createElement('span'); w.className = 'spk'; w.textContent = who + ': ';
  d.append(t, w, document.createTextNode(text)); log.appendChild(d); log.scrollTop = log.scrollHeight;
}, [ts, who, text]);

const advise = (marker, text) => page.evaluate(([marker, text]) => {
  const adv = document.getElementById('advice');
  const d = document.createElement('div'); d.className = 'advice-item ' + marker + ' flash';
  const m = document.createElement('span'); m.className = 'marker'; m.textContent = marker;
  const body = document.createElement('span'); body.className = 'body';
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith('**')) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); body.appendChild(b); }
    else body.appendChild(document.createTextNode(part));
  }
  d.append(m, body); adv.appendChild(d);
}, [marker, text]);

let n = 0;
const hold = async (ms) => {
  const shots = Math.max(1, Math.round(ms / 200)); // 5 fps
  for (let i = 0; i < shots; i++) {
    await page.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(4, '0')}.png`) });
    await page.waitForTimeout(200);
  }
};

await hold(600);
await say('10:02:11', 'Dana', 'so where are we on the billing migration');      await hold(800);
await say('10:02:19', 'You', 'backfill is done, we are on the read path');      await hold(800);
await say('10:02:31', 'Marc', 'can we promise the fifteenth to the customer');  await hold(600);
await advise('RISK', 'The **15th is inside the release freeze** you agreed on 22 July.'); await hold(2000);
await advise('SAY', '"That lands in the freeze window - can we say the 18th?"'); await hold(2400);
await say('10:02:44', 'You', 'hold on - the fifteenth is in the freeze');       await hold(1200);
await say('10:02:52', 'Marc', 'fair enough, let us commit to the eighteenth');  await hold(600);
await advise('ACTION', 'Decision: **release moves to the 18th** - owner Marc.'); await hold(2600);

await browser.close();

const OUT = path.join(ROOT, 'docs', 'media');
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '5', '-i', path.join(FRAMES, 'f%04d.png'), ...args], { stdio: 'inherit' });
ff(['-vf', 'scale=840:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', path.join(OUT, 'panel-live.mp4')]);
ff(['-vf', 'scale=680:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', path.join(OUT, 'panel-live.gif')]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, 'panel-live.mp4'), '-vf', 'select=eq(n\\,50)', '-vframes', '1', '-q:v', '4', path.join(OUT, 'panel-live-poster.jpg')], { stdio: 'inherit' });
rmSync(FRAMES, { recursive: true, force: true });
console.log(`frames: ${n} -> panel-live.mp4, panel-live.gif, panel-live-poster.jpg`);
