// Fills the REAL panel - src/sidepanel.html and its stylesheet, untouched - with a scripted session that
// never happened. Nothing here is a mockup: every pixel is the shipping interface. What is invented is only
// the conversation, so no real person's words end up on a marketing page.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = path.join(ROOT, 'docs', 'media');
export const PANEL_URL = 'file://' + path.join(ROOT, 'src', 'sidepanel.html');

// Installed into the page as window.__mla: the panel's own writers, reduced to what a scripted scene needs
// and building the same DOM the real ones build (see appendItem / renderInline in src/sidepanel.js).
// Tracker keys become links exactly as linkify() does once the user has set a tracker URL in Options.
const WRITERS = `window.__mla = (() => {
  const TRACKER = 'https://team.atlassian.net/browse/{key}';
  const keys = (parent, text) => {
    const re = /\\b[A-Z][A-Z0-9]{1,5}-\\d+\\b/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = TRACKER.replace('{key}', m[0]); a.textContent = m[0]; a.target = '_blank'; a.rel = 'noreferrer';
      parent.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  };
  const rich = (parent, text) => {
    for (const part of String(text).split(/(\\*\\*[^*]+\\*\\*)/g)) {
      if (!part) continue;
      if (part.startsWith('**')) { const b = document.createElement('strong'); keys(b, part.slice(2, -2)); parent.appendChild(b); }
      else keys(parent, part);
    }
  };
  return {
    rich,
    tracker: '',
    line(ts, who, text) {
      const log = document.getElementById('log');
      const d = document.createElement('div'); d.className = 'line';
      const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts + ' ';
      const w = document.createElement('span'); w.className = 'spk'; w.textContent = who + ': ';
      d.append(t, w, document.createTextNode(text));
      log.appendChild(d); log.scrollTop = log.scrollHeight;
    },
    advice(marker, text, flash) {
      const d = document.createElement('div'); d.className = 'advice-item ' + marker + (flash ? ' flash' : '');
      const m = document.createElement('span'); m.className = 'marker'; m.textContent = marker;
      const body = document.createElement('span'); body.className = 'body'; rich(body, text);
      d.append(m, body); document.getElementById('advice').appendChild(d);
    },
    item(kind, text, owner, flash) {
      const decision = kind === 'decision';
      const d = document.createElement('div'); d.className = 'item ' + (decision ? 'decision' : 'action') + (flash ? ' flash' : '');
      const k = document.createElement('span'); k.className = 'kind'; k.textContent = decision ? 'DECISION' : 'ACTION';
      const body = document.createElement('div'); body.className = 'body';
      const txt = document.createElement('div'); txt.className = 'txt'; rich(txt, text);
      body.appendChild(txt);
      if (owner) {
        const meta = document.createElement('div'); meta.className = 'meta';
        meta.appendChild(document.createTextNode('owner: '));
        const s = document.createElement('strong'); s.textContent = owner; meta.appendChild(s);
        body.appendChild(meta);
      }
      d.append(k, body);
      if (!decision) {
        const b = document.createElement('button'); b.className = 'jira';
        b.textContent = 'Draft ' + (window.__mla.tracker || 'note');
        d.appendChild(b);
      }
      const items = document.getElementById('items');
      items.appendChild(d); items.scrollTop = items.scrollHeight;
    },
    chat(role, text) {
      const d = document.createElement('div'); d.className = 'chat-msg ' + role; rich(d, text);
      document.getElementById('chat').appendChild(d);
    },
  };
})();`;

// Header, toggles and an empty board. Everything a scene adds afterwards goes through window.__mla.
async function prime(page, s) {
  await page.evaluate(WRITERS);
  await page.evaluate((s) => {
    const set = (id, text, cls) => { const e = document.getElementById(id); if (!e) return; e.textContent = text; if (cls) e.className = 'status ' + cls; };
    set('capStatus', s.capturing || 'capturing', 'ok');
    set('srvStatus', 'server ✓', 'ok');
    set('brainStatus', '🧠 assistant on', 'ok');
    set('snapStatus', s.shots || 'shots 3', 'idle');
    document.getElementById('session').textContent = s.session;
    document.getElementById('modeSel').value = s.mode;
    document.getElementById('autoCreate').checked = !!(s.autopilot && s.autopilot.create);
    document.getElementById('postChat').checked = !!(s.autopilot && s.autopilot.postChat);
    window.__mla.tracker = s.tracker || '';
    for (const id of ['log', 'advice', 'items', 'chat']) document.getElementById(id).innerHTML = '';
  }, s);
}

export async function fillPanel(page, script) {
  await prime(page, script);
  await page.evaluate((s) => {
    for (const [ts, who, text] of s.transcript) window.__mla.line(ts, who, text);
    for (const [marker, text] of s.advice) window.__mla.advice(marker, text, false);
    for (const [kind, text, owner] of s.items) window.__mla.item(kind, text, owner, false);
    for (const [role, text] of s.chat) window.__mla.chat(role, text);
  }, script);
  await page.waitForTimeout(300);
}

// The same writers, exposed one call at a time so a clip can play a scene forward instead of showing the
// end state. The board starts empty; the timeline in the clip script fills it.
export async function driver(page, script) {
  await prime(page, script);
  return {
    say: (ts, who, text) => page.evaluate(([ts, who, text]) => window.__mla.line(ts, who, text), [ts, who, text]),
    advise: (marker, text) => page.evaluate(([m, t]) => window.__mla.advice(m, t, true), [marker, text]),
    item: (kind, text, owner) => page.evaluate(([k, t, o]) => window.__mla.item(k, t, o, true), [kind, text, owner]),
    chat: (role, text) => page.evaluate(([r, t]) => window.__mla.chat(r, t), [role, text]),
  };
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

// The other half of the value, and the harder half to put in prose: with autopilot on the assistant is not
// suggesting, it is doing. It checks a claim against the tracker, files the ticket and drafts the note while
// the conversation carries on without you.
export const PLANNING = {
  session: '2026-08-10_sprint-planning',
  mode: 'produce',
  tracker: 'Jira',
  autopilot: { create: true, postChat: true },
  transcript: [
    ['09:31:04', 'Dana', 'search revamp should be quick, we did filters in Q1'],
    ['09:31:12', 'Marc', 'filters was what, two weeks'],
    ['09:31:20', 'You', 'it felt longer than that'],
    ['09:31:34', 'Dana', 'ok then search is a month, not a sprint'],
    ['09:31:47', 'Marc', 'someone raise a ticket for the reindex spike'],
    ['09:32:05', 'Dana', 'and we need the planning note before Friday'],
  ],
  advice: [
    ['INFO', 'Filters took **31 days** (PROJ-2841, 12 Feb to 15 Mar), not two weeks. Three of those weeks were the reindex.'],
    ['ACTION', 'Created **PROJ-3120** - Reindex spike, 3 days, owner you. Link posted in the meeting chat.'],
    ['ACTION', 'Drafted **Search revamp - planning note**: the sizing, the two open questions, who owns what.'],
  ],
  items: [
    ['decision', 'Search revamp is a month, not a sprint', 'Dana'],
    ['action', 'Reindex spike - PROJ-3120', 'You'],
  ],
  chat: [
    ['agent', '🧠 **assistant** attached. Mode: produce. Auto-create on.'],
    ['agent', 'Filed **PROJ-3120** and dropped the link in the call chat.'],
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
