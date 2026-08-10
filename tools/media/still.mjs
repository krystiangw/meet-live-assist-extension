// Renders the REAL panel - src/sidepanel.html and its stylesheet, untouched - and fills it with a scripted
// meeting that never happened. Nothing here is a mockup: every pixel is the shipping interface. What is
// invented is only the conversation, so no real person's words end up on a marketing page.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// Playwright is not a dependency of this project - install it where you run this, or point
// MLA_PLAYWRIGHT at an existing checkout: MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node still.mjs
const { chromium } = await import(process.env.MLA_PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'media');
mkdirSync(OUT, { recursive: true });

// A meeting a stranger recognises: a release call where a date gets promised that contradicts a freeze.
const SCRIPT = {
  session: '2026-08-10_release-review',
  transcript: [
    ['10:02:11', 'Dana', 'so where are we on the billing migration'],
    ['10:02:19', 'You', 'backfill is done, we are on the read path now'],
    ['10:02:31', 'Marc', 'can we promise the fifteenth to the customer'],
    ['10:02:38', 'Dana', 'if the read path lands this week, sure'],
    ['10:02:44', 'Marc', 'good, I will tell them the fifteenth'],
  ],
  advice: [
    ['RISK', 'The **15th is inside the release freeze** you agreed on 22 July. Ask before it becomes a promise.'],
    ['SAY', '"Before we commit to the 15th - that lands in the freeze window. Can we say the 18th?"'],
    ['INFO', 'Freeze runs **13-17 Aug**. Last exception needed VP sign-off and took four days.'],
  ],
  items: [
    ['decision', 'Ship the billing read path this week', 'You'],
    ['action', 'Confirm the customer date against the freeze calendar', 'Marc'],
  ],
  chat: [
    ['agent', '🧠 **assistant** attached. Mode: lead.'],
    ['user', 'what did we actually agree about the freeze?'],
    ['agent', 'On 22 July you agreed **no customer-facing releases 13-17 Aug**. Marc was in that call.'],
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(ROOT, 'src', 'sidepanel.html'));

// Populate through the DOM the panel itself builds - same classes, same structure, no innerHTML tricks.
await page.evaluate((s) => {
  const set = (id, text, cls) => { const e = document.getElementById(id); if (!e) return; e.textContent = text; if (cls) e.className = 'status ' + cls; };
  set('capStatus', 'capturing', 'ok');
  set('srvStatus', 'server ✓', 'ok');
  set('brainStatus', '🧠 assistant on', 'ok');
  set('snapStatus', 'shots 3', 'idle');
  document.getElementById('session').textContent = s.session;
  document.getElementById('modeSel').value = 'lead';

  const log = document.getElementById('log'); log.innerHTML = '';
  for (const [ts, who, text] of s.transcript) {
    const d = document.createElement('div'); d.className = 'line';
    const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts + ' ';
    const w = document.createElement('span'); w.className = 'spk'; w.textContent = who + ': ';
    d.append(t, w, document.createTextNode(text)); log.appendChild(d);
  }

  // Minimal bold renderer, matching what the panel does with **…**
  const rich = (parent, text) => {
    for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
      if (!part) continue;
      if (part.startsWith('**')) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); parent.appendChild(b); }
      else parent.appendChild(document.createTextNode(part));
    }
  };

  const adv = document.getElementById('advice'); adv.innerHTML = '';
  for (const [marker, text] of s.advice) {
    const d = document.createElement('div'); d.className = 'advice-item ' + marker;
    const m = document.createElement('span'); m.className = 'marker'; m.textContent = marker;
    const body = document.createElement('span'); rich(body, text);
    d.append(m, body); adv.appendChild(d);
  }

  const items = document.getElementById('items'); items.innerHTML = '';
  for (const [kind, text, owner] of s.items) {
    const d = document.createElement('div'); d.className = 'item ' + kind;
    const k = document.createElement('span'); k.className = 'kind'; k.textContent = kind === 'decision' ? 'DECISION' : 'ACTION';
    const body = document.createElement('span'); body.textContent = ' ' + text + (owner ? ` - ${owner}` : '');
    d.append(k, body);
    if (kind === 'action') { const b = document.createElement('button'); b.className = 'jira'; b.textContent = 'Draft note'; d.appendChild(b); }
    items.appendChild(d);
  }

  const chat = document.getElementById('chat'); chat.innerHTML = '';
  for (const [role, text] of s.chat) {
    const d = document.createElement('div'); d.className = 'chat-msg ' + role; rich(d, text); chat.appendChild(d);
  }
}, SCRIPT);

await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, 'panel-full.png'), fullPage: true });
console.log('  panel-full.png');
await browser.close();
