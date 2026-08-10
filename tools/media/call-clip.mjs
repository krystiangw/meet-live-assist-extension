// The whole thing in motion: people talking and the panel reacting, frame by frame. Stills cannot show the
// one thing that matters - that this happens while the sentence is still in the air, without you touching
// anything.
//
// Two scenes. The release review is about catching something before it becomes a promise. The planning call
// is the other half: with autopilot on the assistant checks a claim, files the ticket and drafts the note
// itself, which is the part that is impossible to explain in prose.
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { PANEL_URL, OUT, driver, RELEASE_REVIEW, PLANNING } from './panel.mjs';
import { W, H, PANEL_W, BAR_H, shell, gridStage, shareStage } from './call-shell.mjs';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node call-clip.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function record(name, script, timeline, posterFrame, tab) {
  const frames = path.join(tmpdir(), 'mla-' + name);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  const panel = await browser.newPage({ viewport: { width: PANEL_W, height: H - BAR_H }, deviceScaleFactor: 2 });
  await panel.goto(PANEL_URL);
  const d = await driver(panel, script);

  const stage = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await stage.setContent(shell(gridStage(''), '', tab));

  let n = 0;
  const hold = async (ms) => {
    for (let i = 0; i < Math.max(1, Math.round(ms / 200)); i++) { // 5 fps
      const png = (await panel.screenshot()).toString('base64');
      await stage.evaluate((png) => { document.querySelector('img.panel').src = 'data:image/png;base64,' + png; }, png);
      await stage.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
    }
  };
  const setStage = (html) => stage.evaluate((html) => { document.querySelector('.call').innerHTML = html; }, html);

  await timeline({ ...d, hold, setStage });

  await panel.close();
  await stage.close();

  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '5', '-i', path.join(frames, 'f%04d.png'), ...args], { stdio: 'inherit' });
  ff(['-vf', 'scale=1200:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', path.join(OUT, `${name}.mp4`)]);
  ff(['-vf', 'scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', path.join(OUT, `${name}.gif`)]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, `${name}.mp4`), '-vf', `select=eq(n\\,${Math.min(posterFrame, n - 1)})`, '-vframes', '1', '-q:v', '4', path.join(OUT, `${name}-poster.jpg`)], { stdio: 'inherit' });
  rmSync(frames, { recursive: true, force: true });
  console.log(`  ${name}.{mp4,gif} + poster - ${n} frames`);
}

await record('call-live', RELEASE_REVIEW, async ({ say, advise, item, hold, setStage }) => {
  await setStage(gridStage('Dana K.'));                                                            await hold(600);
  await say('10:02:11', 'Dana', 'so where are we on the billing migration');                       await hold(1000);
  await setStage(gridStage('You'));
  await say('10:02:19', 'You', 'backfill is done, we are on the read path');                       await hold(1000);
  await setStage(shareStage('Marc T.'));                                                           await hold(1200);
  await say('10:02:31', 'Marc', 'can we promise the fifteenth to the customer');                   await hold(600);
  await advise('RISK', 'The **15th is inside the release freeze** you agreed on 22 July.');        await hold(2200);
  await advise('SAY', '"That lands in the freeze window - can we say the 18th?"');                 await hold(2400);
  await setStage(shareStage('You'));
  await say('10:02:44', 'You', 'hold on - the fifteenth is in the freeze');                        await hold(1400);
  await setStage(shareStage('Marc T.'));
  await say('10:02:52', 'Marc', 'fair enough, let us commit to the eighteenth');                   await hold(800);
  await item('decision', 'Release moves to the 18th', 'Marc');                                     await hold(2600);
}, 62, { title: 'Release review', url: 'meet.google.com/qtr-8f2k-nvd' });

await record('planning-live', PLANNING, async ({ say, advise, item, hold, setStage }) => {
  await setStage(gridStage('Dana K.'));                                                            await hold(600);
  await say('09:31:04', 'Dana', 'search revamp should be quick, we did filters in Q1');            await hold(900);
  await setStage(gridStage('Marc T.'));
  await say('09:31:12', 'Marc', 'filters was what, two weeks');                                    await hold(700);
  await advise('INFO', 'Filters took **31 days** (PROJ-2841, 12 Feb to 15 Mar), not two weeks.');  await hold(2400);
  await setStage(gridStage('Dana K.'));
  await say('09:31:34', 'Dana', 'ok then search is a month, not a sprint');                        await hold(700);
  await item('decision', 'Search revamp is a month, not a sprint', 'Dana');                        await hold(1600);
  await setStage(gridStage('Marc T.'));
  await say('09:31:47', 'Marc', 'someone raise a ticket for the reindex spike');                   await hold(900);
  await advise('ACTION', 'Created **PROJ-3120** - Reindex spike, 3 days, owner you. Link posted in the meeting chat.');
  await item('action', 'Reindex spike - PROJ-3120', 'You');                                        await hold(2600);
  await setStage(gridStage('Dana K.'));
  await say('09:32:05', 'Dana', 'and we need the planning note before Friday');                    await hold(800);
  await advise('ACTION', 'Drafted **Search revamp - planning note**: the sizing, the two open questions, who owns what.');
  await hold(3000);
}, 70, { title: 'Sprint planning', url: 'meet.google.com/vzd-4m1p-hks' });

await browser.close();
