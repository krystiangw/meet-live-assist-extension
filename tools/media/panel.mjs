// Fills the REAL panel - src/sidepanel.html and its stylesheet, untouched - with a scripted session that
// never happened. Nothing here is a mockup: every pixel is the shipping interface. What is invented is only
// the conversation, so no real person's words end up on a marketing page.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = path.join(ROOT, 'docs', 'media');
export const PANEL_URL = 'file://' + path.join(ROOT, 'src', 'sidepanel.html');

export async function fillPanel(page, script) {
  await page.evaluate((s) => {
    const set = (id, text, cls) => { const e = document.getElementById(id); if (!e) return; e.textContent = text; if (cls) e.className = 'status ' + cls; };
    set('capStatus', s.capturing || 'capturing', 'ok');
    set('srvStatus', 'server ✓', 'ok');
    set('brainStatus', '🧠 assistant on', 'ok');
    set('snapStatus', s.shots || 'shots 3', 'idle');
    document.getElementById('session').textContent = s.session;
    document.getElementById('modeSel').value = s.mode;

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
      const body = document.createElement('span'); body.className = 'body'; rich(body, text);
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
  }, script);
  await page.waitForTimeout(300);
}

// A meeting a stranger recognises: a release call where a date gets promised that contradicts a freeze.
export const RELEASE_REVIEW = {
  session: '2026-08-10_release-review',
  mode: 'lead',
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

// The same panel with nobody else in the room: it watches the tab and listens to you think out loud.
export const COPILOT = {
  session: '2026-08-10_copilot',
  mode: 'auto',
  shots: 'shots 7',
  transcript: [
    ['14:07:02', 'You', 'the migration script keeps timing out on the second batch'],
    ['14:07:15', 'You', 'it ran fine yesterday and the query has not changed'],
  ],
  advice: [
    ['INFO', 'The index on **billing_events.created_at** was dropped in migration 0141, yesterday 18:40.'],
    ['EXPLAIN', 'Batch 1 reads by primary key, batch 2 filters on that column - without the index it is a full scan, so the timeout tracks table size, not batch size.'],
    ['ACTION', 'Re-add the index and re-run batch 2. I can write the migration.'],
  ],
  items: [
    ['action', 'Restore the created_at index before the next run', 'You'],
  ],
  chat: [
    ['agent', '🧠 **assistant** attached. Watching this tab. Mode: auto.'],
    ['user', 'why only the second batch?'],
    ['agent', 'Batch 1 never touches **created_at**. Batch 2 filters on it, and that is the index that went.'],
  ],
};
