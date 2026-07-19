// Side panel — primary live UI. This page persists while open, so it (not the SW) owns any
// long-lived state/streaming. Renders live transcript (via the SW port) + live advice (polled
// straight from the transcript server's /advice channel — the "brain" POSTs advice there).

const logEl = document.getElementById('log');
const adviceEl = document.getElementById('advice');
const itemsEl = document.getElementById('items');
const capEl = document.getElementById('capStatus');
const srvEl = document.getElementById('srvStatus');
const brainEl = document.getElementById('brainStatus');
const talkEl = document.getElementById('talkStatus');
const muteEl = document.getElementById('muteStatus');
const mentionEl = document.getElementById('mentionStatus');
const snapEl = document.getElementById('snapStatus');
const snapBtn = document.getElementById('snapNow');
const shareEl = document.getElementById('shareStatus');
const speakEl = document.getElementById('speakStatus');
const sessionEl = document.getElementById('session');
const chatEl = document.getElementById('chat');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sttToggle = document.getElementById('sttToggle');
const sttEl = document.getElementById('sttStatus');
const editEl = document.getElementById('editStatus');
const dbgToggle = document.getElementById('dbgToggle');
const dbgEl = document.getElementById('dbgStatus');
const modeSel = document.getElementById('modeSel');

const MARKER_LABEL = { SAY: '🟢 SAY', INFO: '🔵 INFO', SUMMARY: '🟡 SUMMARY', EXPLAIN: '🟣 EXPLAIN', RISK: '🔴 RISK', ACTION: '🟠 ACTION' };
const DEFAULT_SERVER = 'http://127.0.0.1:8848';

let hasLines = false;
let hasAdvice = false;
let hasItems = false;
let currentSession = null;
let lastAdviceSeq = 0;
let lastItemsSeq = 0;
let lastReqSeq = -1; // -1 = baseline unknown for this session (don't fire on first poll)
let lastChatSeq = 0;
let lastEditSeq = -1;
let lastDomReqSeq = -1;
let lastDbgReqSeq = -1;
let sharing = false;
let serverUrl = DEFAULT_SERVER;
let serverToken = '';
let ttsVoicePl = null;
let ttsVoiceEn = null;
let callLang = null; // from Meet's caption-language selector (via content script)
let port = null;
let pingTimer = null;
let pollTimer = null;
let brainTimer = null;
let shareTimer = null;

function setStatus(el, text, cls) { el.textContent = text; el.className = 'status ' + cls; }
function hdrs(json) { const h = { 'X-MLA-Token': serverToken }; if (json) h['Content-Type'] = 'application/json'; return h; }

// Optional permissions (debugger + all-sites host) are requested at runtime on a user gesture — kept out
// of the install-time prompt for a cleaner Web Store listing.
const ALL_URLS = { origins: ['<all_urls>'] };
async function ensurePerms(perms) {
  // request() resolves true immediately if already held (no prompt), so no contains() pre-check — that
  // extra await could otherwise consume the gesture's transient activation before the prompt shows.
  try { return await chrome.permissions.request(perms); }
  catch (_) { return false; }
}

// Urgent cue on 🔴 RISK: a short beep + a system notification (the panel may be hidden mid-call).
let cueArmed = false; // stays off briefly after (re)connect so backfilled advice doesn't blast
function riskCue(text) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 660; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start(); o.stop(ctx.currentTime + 0.36);
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 600);
  } catch (_) {}
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Meet Live Assist — RISK', message: String(text || '').slice(0, 180) }); } catch (_) {}
}

// ---- transcript ----------------------------------------------------------
const liveLines = new Map(); // caption id -> element (interim lines updated in place)
function clearLog() { logEl.innerHTML = ''; hasLines = false; liveLines.clear(); }

// Live captions: create/update a line by id as it grows; on final, lock it (drop from the live map).
function upsertCaption(id, { ts, speaker, text }, final) {
  if (!hasLines) { logEl.innerHTML = ''; hasLines = true; }
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  let el = liveLines.get(id);
  if (!el) { el = document.createElement('div'); logEl.appendChild(el); if (!final) liveLines.set(id, el); }
  el.className = 'line' + (final ? '' : ' live');
  el.textContent = '';
  const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts || '';
  el.append(t);
  if (speaker) { const w = document.createElement('span'); w.className = 'who'; w.textContent = speaker + ': '; el.append(w); }
  el.append(document.createTextNode(text || ''));
  if (final) liveLines.delete(id);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- talk-time + muted nudge ---------------------------------------------
let talkWords = { you: 0, others: 0 };
function resetTalk() { talkWords = { you: 0, others: 0 }; talkEl.hidden = true; muteEl.hidden = true; mentionEl.hidden = true; }
function trackTalk(speaker, text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean).length;
  if (!w) return;
  if (speaker === 'You') talkWords.you += w;
  else if (speaker && speaker !== '(unattributed)') talkWords.others += w;
  const tot = talkWords.you + talkWords.others;
  if (tot >= 25) { talkEl.hidden = false; setStatus(talkEl, `🗣 you ${Math.round(100 * talkWords.you / tot)}%`, 'idle'); }
}
const MUTED_RE = /\byou(?:'|’| a)?re (?:on mute|muted|breaking up)\b|\byou are (?:on mute|muted)\b|can'?t hear you|you broke up|you'?re on mute\b/i;
let muteNudgeAt = 0;
function checkMuted(speaker, text) {
  if (speaker === 'You') return;              // others noticing you, not you saying it
  if (!MUTED_RE.test(text || '')) return;
  if (nowMs() - muteNudgeAt < 8000) return;   // debounce
  muteNudgeAt = nowMs();
  muteEl.hidden = false; setTimeout(() => { muteEl.hidden = true; }, 6000);
  if (cueArmed) riskCue('You may be muted');
}
function nowMs() { return performance.now(); }

// Personal-mention alert: fire when someone else names you (from your options "Your name(s)" list).
let nameRe = null;
let mentionAt = 0;
function buildNameRe(names) {
  const parts = (names || 'Krystian, Chris, Christian').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  nameRe = parts.length ? new RegExp(`\\b(${parts.join('|')})\\b`, 'i') : null;
}
function checkMention(speaker, text) {
  if (speaker === 'You' || !nameRe || !nameRe.test(text || '')) return;
  if (nowMs() - mentionAt < 6000) return;
  mentionAt = nowMs();
  mentionEl.hidden = false; setTimeout(() => { mentionEl.hidden = true; }, 6000);
  if (cueArmed) riskCue('You were mentioned');
}

function appendLine({ ts, speaker, text }) {
  if (!hasLines) { logEl.innerHTML = ''; hasLines = true; }
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const div = document.createElement('div');
  div.className = 'line';
  const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts || '';
  div.append(t);
  if (speaker) { const w = document.createElement('span'); w.className = 'who'; w.textContent = speaker + ': '; div.append(w); }
  div.append(document.createTextNode(text || ''));
  logEl.appendChild(div);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- advice --------------------------------------------------------------
// Safe inline rich rendering — no innerHTML. Supports bare URLs, [text](url), ![alt](url) images,
// **bold**, and `code`. Everything else stays literal text.
const RICH = [
  { re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/, kind: 'img' },
  { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, kind: 'link' },
  { re: /(https?:\/\/[^\s]+)/, kind: 'url' },
  { re: /\*\*([^*]+)\*\*/, kind: 'bold' },
  { re: /`([^`]+)`/, kind: 'code' },
];
function renderInline(parent, line) {
  let rest = line;
  while (rest) {
    let best = null;
    for (const p of RICH) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { p, m };
    }
    if (!best) { parent.appendChild(document.createTextNode(rest)); break; }
    if (best.m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, best.m.index)));
    const [full, g1, g2] = best.m;
    if (best.p.kind === 'img') { const i = document.createElement('img'); i.src = g2; i.alt = g1 || ''; i.className = 'rich-img'; parent.appendChild(i); }
    else if (best.p.kind === 'link') { const a = document.createElement('a'); a.href = g2; a.textContent = g1; a.target = '_blank'; a.rel = 'noreferrer'; parent.appendChild(a); }
    else if (best.p.kind === 'url') { const a = document.createElement('a'); a.href = g1; a.textContent = g1; a.target = '_blank'; a.rel = 'noreferrer'; parent.appendChild(a); }
    else if (best.p.kind === 'bold') { const b = document.createElement('strong'); b.textContent = g1; parent.appendChild(b); }
    else if (best.p.kind === 'code') { const c = document.createElement('code'); c.textContent = g1; parent.appendChild(c); }
    rest = rest.slice(best.m.index + full.length);
  }
}
// Block-level: fenced ``` code, - / * bullet lists, 1. numbered lists, else inline paragraphs.
function renderRich(parent, text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  const isBullet = (l) => /^\s*[-*]\s+/.test(l);
  const isNum = (l) => /^\s*\d+\.\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      const pre = document.createElement('pre'); pre.className = 'rich-pre';
      const code = document.createElement('code'); code.textContent = buf.join('\n');
      pre.appendChild(code); parent.appendChild(pre);
      continue;
    }
    if (isBullet(line) || isNum(line)) {
      const num = isNum(line);
      const list = document.createElement(num ? 'ol' : 'ul'); list.className = 'rich-list';
      const match = num ? isNum : isBullet;
      while (i < lines.length && match(lines[i])) {
        const li = document.createElement('li');
        renderInline(li, lines[i].replace(num ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''));
        list.appendChild(li); i++;
      }
      parent.appendChild(list);
      continue;
    }
    renderInline(parent, line);
    const next = lines[i + 1];
    if (next !== undefined && !next.trim().startsWith('```') && !isBullet(next) && !isNum(next)) {
      parent.appendChild(document.createElement('br'));
    }
    i++;
  }
}

function appendAdvice({ marker, text, image }) {
  if (!hasAdvice) { adviceEl.innerHTML = ''; hasAdvice = true; }
  const m = (marker || 'INFO').toUpperCase();
  const div = document.createElement('div');
  div.className = 'advice-item ' + (MARKER_LABEL[m] ? m : 'INFO');
  const mk = document.createElement('span'); mk.className = 'marker'; mk.textContent = MARKER_LABEL[m] || '🔵 INFO';
  const bd = document.createElement('span'); bd.className = 'body';
  renderRich(bd, text);
  if (image && /^(https?:|data:image\/)/.test(image)) {
    const img = document.createElement('img'); img.src = image; img.className = 'rich-img'; bd.appendChild(img);
  }
  div.append(mk, bd);
  if (m === 'SAY' && text) {
    const sp = document.createElement('button');
    sp.className = 'speak-btn'; sp.textContent = '🔊'; sp.title = 'Speak this (TTS)';
    sp.addEventListener('click', () => speak(text, sp));
    div.append(sp);
  }
  if (text) {
    const cp = document.createElement('button');
    cp.className = 'speak-btn'; cp.textContent = '📋'; cp.title = 'Copy (paste into Meet chat)';
    cp.addEventListener('click', () => navigator.clipboard.writeText(text)
      .then(() => { cp.textContent = '✓'; setTimeout(() => { cp.textContent = '📋'; }, 900); }).catch(() => {}));
    div.append(cp);
  }
  adviceEl.appendChild(div);
  adviceEl.scrollTop = adviceEl.scrollHeight;
  if (m === 'RISK' && cueArmed) riskCue(text);
}

// Pick a voice matching the SAY text's language. SAY phrasing is in the meeting's spoken
// language (usually English); Polish is detected by its diacritics.
function pickVoice(text) {
  if (callLang === 'pl') return ttsVoicePl;
  if (callLang === 'en') return ttsVoiceEn;
  // Unknown call language (or a language we don't have a voice for) → fall back to text heuristic.
  return /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(text) ? ttsVoicePl : ttsVoiceEn;
}

async function meetTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  const t = tabs.find((x) => x.active) || tabs[0];
  return t && t.id;
}
async function micUnmute() {
  const id = await meetTabId();
  if (!id) return null;
  try {
    const r = await chrome.tabs.sendMessage(id, { type: 'mic', action: 'unmute' });
    return r && r.ok ? { id, wasMuted: r.wasMuted } : null;
  } catch (_) { return null; }
}
async function micRestore(info) {
  if (!info || !info.wasMuted) return;
  try { await chrome.tabs.sendMessage(info.id, { type: 'mic', action: 'restore', wasMuted: true }); } catch (_) {}
}

async function speak(text, btn) {
  if (btn) btn.disabled = true;
  const intoCall = document.getElementById('ttsCall').checked;
  let mic = null;
  let ok = true;
  setStatus(speakEl, intoCall ? '🔊 speaking → call' : '🔊 speaking', 'ok');
  speakEl.hidden = false;
  try {
    if (intoCall) mic = await micUnmute(); // unmute Meet so the TTS is actually transmitted
    const r = await fetch(`${serverUrl}/speak`, {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, text, voice: pickVoice(text), device: intoCall ? 'BlackHole' : null }),
    });
    ok = r.ok;
  } catch (_) { ok = false; } finally {
    await micRestore(mic); // re-mute only if it was muted before
    setStatus(speakEl, ok ? '🔊 spoke ✓' : '🔊 failed', ok ? 'ok' : 'bad');
    setTimeout(() => { speakEl.hidden = true; }, 2000);
    if (btn) setTimeout(() => { btn.disabled = false; }, 300);
  }
}

function resetAdvice() { adviceEl.innerHTML = '<div class="empty small">Advice will appear here live…</div>'; hasAdvice = false; lastAdviceSeq = 0; }

// Reflect brain liveness in the advice empty-state so "nothing happening" is explained, not silent.
function setBrainEmpty(live) {
  if (hasAdvice) return;
  const e = adviceEl.querySelector('.empty');
  if (e) e.textContent = live ? 'Advice will appear here live…'
    : 'No assistant attached — run your Claude session with the meet-live-assist skill.';
}

async function pollBrain() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/brain-ping?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { ageMs } = await r.json();
    const live = ageMs != null && ageMs < 45000; // heartbeat within 45s = attached
    setStatus(brainEl, live ? '🧠 assistant on' : '🧠 no assistant', live ? 'ok' : 'bad');
    setBrainEmpty(live);
  } catch (_) { /* server down — srv pill already reflects it */ }
}

async function pollAdvice() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/advice?session=${encodeURIComponent(currentSession)}&since=${lastAdviceSeq}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendAdvice);
    if (typeof last === 'number') lastAdviceSeq = Math.max(lastAdviceSeq, last);
  } catch (_) { /* server down — transcript-side status already reflects it */ }
}

async function pollSnapRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/snapshot-request?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { seq } = await r.json();
    if (typeof seq !== 'number') return;
    if (lastReqSeq < 0) { lastReqSeq = seq; return; } // first poll = baseline, don't fire
    if (seq > lastReqSeq) { lastReqSeq = seq; requestCapture(); } // agent asked for a shot
  } catch (_) { /* server down */ }
}

function requestCapture() { try { port.postMessage({ type: 'snapshot-now' }); } catch (_) {} }

// ---- decisions & action items (the board) --------------------------------
function resetItems() { itemsEl.innerHTML = '<div class="empty small">Decisions and action items will appear here…</div>'; hasItems = false; lastItemsSeq = 0; }
function appendItem({ kind, text, owner, blockedBy }) {
  if (!hasItems) { itemsEl.innerHTML = ''; hasItems = true; }
  const decision = kind === 'decision';
  const div = document.createElement('div');
  div.className = 'item ' + (decision ? 'decision' : 'action');
  const k = document.createElement('span'); k.className = 'kind'; k.textContent = decision ? 'DECISION' : 'ACTION';
  const body = document.createElement('div'); body.className = 'body';
  const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = text;
  txt.title = 'Click to mark done'; txt.addEventListener('click', () => div.classList.toggle('done'));
  body.appendChild(txt);
  if (owner || blockedBy) {
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = [owner ? `owner: ${owner}` : '', blockedBy ? `blocked by: ${blockedBy}` : ''].filter(Boolean).join(' · ');
    body.appendChild(meta);
  }
  div.append(k, body);
  if (!decision) {
    const j = document.createElement('button'); j.className = 'jira'; j.textContent = 'Draft Jira';
    j.title = 'Ask the assistant to draft a Jira ticket for this (draft only)';
    j.addEventListener('click', () => sendChat(`Draft a Jira ticket (DRAFT only — do not create) for this action item: "${text}"${owner ? ` — owner ${owner}` : ''}. Use the team's Goal / Summary / Test plan sections.`));
    div.append(j);
  }
  itemsEl.appendChild(div);
  itemsEl.scrollTop = itemsEl.scrollHeight;
}
async function pollItems() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/items?session=${encodeURIComponent(currentSession)}&since=${lastItemsSeq}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendItem);
    if (typeof last === 'number') lastItemsSeq = Math.max(lastItemsSeq, last);
  } catch (_) {}
}

// ---- autopilot (auto-create action items) + post links to the meeting chat ----
const autoCreateEl = document.getElementById('autoCreate');
const postChatEl = document.getElementById('postChat');
let lastCallChatSeq = -1; // baseline so old queued messages aren't replayed on (re)connect
async function postAutopilot() {
  if (!currentSession) return;
  try {
    await fetch(`${serverUrl}/autopilot`, { method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, create: autoCreateEl.checked, postChat: postChatEl.checked }) });
  } catch (_) {}
}
autoCreateEl.addEventListener('change', postAutopilot);
postChatEl.addEventListener('change', postAutopilot);
async function loadAutopilot() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/autopilot?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const a = await r.json();
    autoCreateEl.checked = !!a.create; postChatEl.checked = !!a.postChat;
  } catch (_) {}
}
async function pollCallChat() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/callchat?session=${encodeURIComponent(currentSession)}&since=${Math.max(lastCallChatSeq, 0)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    if (lastCallChatSeq < 0) { lastCallChatSeq = last || 0; return; } // baseline: don't replay old
    for (const it of items || []) {
      if (postChatEl.checked) { try { port.postMessage({ type: 'send-call-chat', text: it.text }); } catch (_) {} } // double-guard the opt-in
    }
    if (typeof last === 'number') lastCallChatSeq = Math.max(lastCallChatSeq, last);
  } catch (_) {}
}

// ---- chat ----------------------------------------------------------------
function appendChat({ role, text, image }) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (role === 'agent' ? 'agent' : 'user');
  renderRich(div, text);
  if (image && /^(https?:|data:image\/)/.test(image)) {
    const img = document.createElement('img'); img.src = image; img.className = 'rich-img'; div.appendChild(img);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function pollChat() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/chat?session=${encodeURIComponent(currentSession)}&since=${lastChatSeq}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendChat);
    if (typeof last === 'number') lastChatSeq = Math.max(lastChatSeq, last);
  } catch (_) { /* server down */ }
}

async function sendChat(text) {
  if (!text || !currentSession) return;
  try {
    await fetch(`${serverUrl}/chat`, {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, role: 'user', text }),
    });
    pollChat(); // reflect immediately
  } catch (_) {}
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  sendChat(text);
});

// Quick-ask chips → preset chat prompts (recap / mentioned-me / action-items).
document.getElementById('quickAsk').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ask]');
  if (btn) sendChat(btn.dataset.ask);
});

function setSharing(on) {
  sharing = !!on;
  shareEl.hidden = !sharing;
  clearInterval(shareTimer);
  if (sharing) {
    requestCapture(); // grab one immediately when sharing starts
    shareTimer = setInterval(requestCapture, 15000); // frequent while presenting
  }
}

async function pollEdits() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/edit?session=${encodeURIComponent(currentSession)}&since=${Math.max(lastEditSeq, 0)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    if (lastEditSeq < 0) { lastEditSeq = last || 0; return; } // baseline: don't re-apply old edits
    for (const cmd of items || []) { try { port.postMessage({ type: 'apply-edit', cmd }); } catch (_) {} }
    if (typeof last === 'number') lastEditSeq = Math.max(lastEditSeq, last);
  } catch (_) {}
}
async function pollDomRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/dom-request?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { seq } = await r.json();
    if (lastDomReqSeq < 0) { lastDomReqSeq = seq; return; }
    if (seq > lastDomReqSeq) { lastDomReqSeq = seq; try { port.postMessage({ type: 'capture-dom' }); } catch (_) {} }
  } catch (_) {}
}

async function pollDebugRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/debug-request?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { seq, kind } = await r.json();
    if (lastDbgReqSeq < 0) { lastDbgReqSeq = seq; return; }
    if (seq > lastDbgReqSeq) { lastDbgReqSeq = seq; try { port.postMessage({ type: 'debug-do', kind }); } catch (_) {} }
  } catch (_) {}
}

dbgToggle.addEventListener('change', async () => {
  // `debugger` is a required permission; the scripting-based debug kinds (storage/perf) still need all-sites.
  if (dbgToggle.checked && !(await ensurePerms(ALL_URLS))) {
    dbgToggle.checked = false; dbgEl.hidden = false; setStatus(dbgEl, '🐞 needs all-sites access', 'bad'); return;
  }
  try { port.postMessage({ type: 'debug-toggle', on: dbgToggle.checked }); } catch (_) {}
  dbgEl.hidden = false; setStatus(dbgEl, dbgToggle.checked ? '🐞 attaching…' : '🐞 off', 'idle');
});

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollAdvice(); pollItems(); pollCallChat(); pollSnapRequest(); pollChat(); pollEdits(); pollDomRequest(); pollDebugRequest(); }, 1500);
  clearInterval(brainTimer);
  brainTimer = setInterval(pollBrain, 5000); // liveness is coarse — no need to poll it fast
}

// ---- SW port (transcript + status) ---------------------------------------
function onMessage(msg) {
  switch (msg.type) {
    case 'restore':
      clearLog();
      if (msg.session) { setStatus(capEl, 'capturing', 'ok'); sessionEl.textContent = msg.session; setSession(msg.session); }
      (msg.buffer || []).forEach(appendLine);
      setSharing(!!msg.sharing);
      if (msg.lang) callLang = msg.lang;
      break;
    case 'session': {
      clearLog(); resetAdvice(); resetItems();
      const isCopilot = msg.code === 'copilot';
      setStatus(capEl, isCopilot ? 'co-pilot' : 'capturing', 'ok');
      sessionEl.textContent = msg.session || '';
      copilotOn = isCopilot; copilotBtn.classList.toggle('on', isCopilot);
      document.getElementById('consent').hidden = isCopilot; // no participants to disclose to in co-pilot
      setSession(msg.session);
      break;
    }
    case 'line': // STT lines (no id)
      setStatus(capEl, 'capturing', 'ok');
      appendLine(msg);
      checkMuted(msg.speaker, msg.text);
      checkMention(msg.speaker, msg.text);
      break;
    case 'cap':
      setStatus(capEl, 'capturing', 'ok');
      upsertCaption(msg.id, msg, false);
      break;
    case 'cap-final':
      setStatus(capEl, 'capturing', 'ok');
      upsertCaption(msg.id, msg, true);
      trackTalk(msg.speaker, msg.text);
      checkMuted(msg.speaker, msg.text);
      checkMention(msg.speaker, msg.text);
      break;
    case 'session-end':
      setStatus(capEl, 'ended', 'idle');
      setSharing(false);
      copilotOn = false; copilotBtn.classList.remove('on');
      break;
    case 'capture-health':
      if (!msg.ok) setStatus(capEl, '⚠ no captions — turn on CC / check language', 'bad');
      else setStatus(capEl, 'capturing', 'ok');
      break;
    case 'sharing':
      setSharing(msg.on);
      break;
    case 'lang':
      callLang = msg.lang;
      break;
    case 'server':
      setStatus(srvEl, msg.ok ? 'server ✓' : (msg.status === 403 ? 'server ✗ (set token in options)' : 'server ✗ (start it)'), msg.ok ? 'ok' : 'bad');
      break;
    case 'snapshot':
      if (msg.ok) setStatus(snapEl, `shots ${msg.count ?? '·'}`, 'ok');
      else setStatus(snapEl, `shot ✗ ${msg.reason || ''}`.trim(), 'bad');
      break;
    case 'debug':
      dbgEl.hidden = false;
      if (msg.on) { setStatus(dbgEl, '🐞 debugging', 'ok'); dbgToggle.checked = true; }
      else if (msg.reason) { setStatus(dbgEl, `🐞 ✗ ${msg.reason}`, 'bad'); dbgToggle.checked = false; }
      else { setStatus(dbgEl, '🐞 off', 'idle'); dbgToggle.checked = false; setTimeout(() => { dbgEl.hidden = true; }, 2000); }
      break;
    case 'debug-done':
      dbgEl.hidden = false; setStatus(dbgEl, `🐞 ${msg.kind} ✓`, 'ok');
      setTimeout(() => { if (!dbgToggle.checked) dbgEl.hidden = true; }, 2500);
      break;
    case 'edit':
      editEl.hidden = false;
      if (msg.ok) {
        const r = msg.result || {};
        const label = r.dom ? '✏ page read' : (r.reverted != null ? `✏ reverted ${r.reverted}` : `✏ edited ${r.count ?? ''}`.trim());
        setStatus(editEl, label, 'ok');
      } else setStatus(editEl, `✏ ✗ ${msg.reason || 'no match'}`, 'bad');
      setTimeout(() => { editEl.hidden = true; }, 3000);
      break;
    case 'stt':
      sttEl.hidden = false;
      if (msg.on) { setStatus(sttEl, '🎧 listening', 'ok'); sttToggle.checked = true; }
      else if (msg.reason) { setStatus(sttEl, '🎧 ✗ press ⌘⇧U on the Meet tab', 'bad'); sttToggle.checked = false; }
      else { sttEl.hidden = true; sttToggle.checked = false; }
      break;
  }
}

snapBtn.addEventListener('click', () => { try { port.postMessage({ type: 'snapshot-now' }); } catch (_) {} });

// Co-pilot: start/stop a meeting-less session (agent watches this tab + hears your mic).
const copilotBtn = document.getElementById('copilotBtn');
let copilotOn = false;
copilotBtn.addEventListener('click', async () => {
  if (!copilotOn) {
    if (!(await ensurePerms(ALL_URLS))) return; // co-pilot watches arbitrary tabs → needs all-sites access
    copilotOn = true; copilotBtn.classList.add('on');
    try { port.postMessage({ type: 'copilot-start' }); } catch (_) {}
  } else {
    copilotOn = false; copilotBtn.classList.remove('on');
    try { port.postMessage({ type: 'copilot-stop' }); } catch (_) {}
  }
});

const consentEl = document.getElementById('consent');
document.getElementById('consentDismiss').addEventListener('click', () => { consentEl.hidden = true; });

// ---- setup / health checklist --------------------------------------------
const setupEl = document.getElementById('setup');
let autoSetupShown = false;
function setupRow(ok, label, hint) {
  const d = document.createElement('div'); d.className = 'setup-row ' + (ok ? 'ok' : 'bad');
  const m = document.createElement('span'); m.className = 'setup-mark'; m.textContent = ok ? '✓' : '✗';
  const t = document.createElement('span'); t.textContent = label + (ok ? '' : ` — ${hint}`);
  d.append(m, t); return d;
}
function renderSetup(h, allSites) {
  const t = (h && h.tools) || {};
  setupEl.innerHTML = '';
  setupEl.appendChild(setupRow(!!h, 'Local server running', 'start transcript-server.js (launchd)'));
  setupEl.appendChild(setupRow(!!serverToken, 'Server token set', 'paste .mla-token into extension options'));
  setupEl.appendChild(setupRow(!!t.ffmpeg, 'ffmpeg (TTS + STT)', 'brew install ffmpeg'));
  setupEl.appendChild(setupRow(!!(t.whisper && t.whisperModel), 'Local STT (whisper + model)', 'brew install whisper-cpp + ggml model'));
  setupEl.appendChild(setupRow(!!t.blackhole, 'BlackHole (speak into call — optional)', 'install BlackHole 2ch + Aggregate device'));
  const permRow = setupRow(!!allSites, 'All-sites access (co-pilot / snapshots / edits on any tab)', 'optional');
  if (!allSites) {
    const g = document.createElement('button'); g.className = 'setup-grant'; g.textContent = 'Grant';
    g.addEventListener('click', async () => { if (await ensurePerms(ALL_URLS)) fetchHealth(); });
    permRow.appendChild(g);
  }
  setupEl.appendChild(permRow);
  const note = document.createElement('div'); note.className = 'setup-note';
  note.textContent = 'Tip: set the meeting caption language to the spoken language (⋮ → Settings → Captions).';
  setupEl.appendChild(note);
  const missing = !h || !serverToken || !t.ffmpeg;
  if (missing && !autoSetupShown) { autoSetupShown = true; setupEl.hidden = false; } // nudge once on first run
}
async function fetchHealth() {
  let h = null;
  try { const r = await fetch(`${serverUrl}/health`); if (r.ok) h = await r.json(); } catch (_) {}
  let allSites = false;
  try { allSites = await chrome.permissions.contains(ALL_URLS); } catch (_) {}
  renderSetup(h, allSites);
}
document.getElementById('setupBtn').addEventListener('click', () => { setupEl.hidden = !setupEl.hidden; if (!setupEl.hidden) fetchHealth(); });

function downloadText(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (_) {}
}
document.getElementById('summaryBtn').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/summary?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { text } = await r.json();
    if (text && text.trim()) { appendChat({ role: 'agent', text }); downloadText(`${currentSession}.summary.md`, text); }
    else { appendChat({ role: 'agent', text: '_No summary yet — ask the assistant to wrap up, or it writes one when the call ends._' }); }
  } catch (_) {}
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!currentSession || !confirm('Delete ALL data for this meeting (transcript, snapshots, chat)? This cannot be undone.')) return;
  try {
    const r = await fetch(`${serverUrl}/clear`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ session: currentSession }) });
    if (r.ok) { clearLog(); resetAdvice(); resetItems(); chatEl.innerHTML = ''; lastChatSeq = 0; setStatus(capEl, 'cleared', 'idle'); }
  } catch (_) {}
});

sttToggle.addEventListener('change', () => {
  try { port.postMessage({ type: sttToggle.checked ? 'stt-start' : 'stt-stop' }); } catch (_) {}
  if (sttToggle.checked) { sttEl.hidden = false; setStatus(sttEl, '🎧 starting…', 'idle'); }
});

async function postMode(mode) {
  if (!currentSession) return;
  try {
    await fetch(`${serverUrl}/mode`, {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, mode }),
    });
  } catch (_) {}
}
modeSel.addEventListener('change', () => { chrome.storage.local.set({ mla_mode: modeSel.value }); postMode(modeSel.value); });

function setSession(session) {
  if (session && session !== currentSession) {
    currentSession = session; lastAdviceSeq = 0; lastItemsSeq = 0; lastReqSeq = -1; lastChatSeq = 0; lastEditSeq = -1; lastDomReqSeq = -1; lastDbgReqSeq = -1; lastCallChatSeq = -1;
    chatEl.innerHTML = ''; resetItems(); resetTalk();
    setStatus(brainEl, '🧠 ?', 'idle');
    cueArmed = false; setTimeout(() => { cueArmed = true; }, 2500); // don't cue on initial backfill
    postMode(modeSel.value); // register the current mode for the new session
    loadAutopilot(); // sync the toggles to this session's stored state
    pollAdvice(); pollItems(); pollCallChat(); pollSnapRequest(); pollChat(); pollEdits(); pollDomRequest(); pollDebugRequest(); pollBrain();
  }
}

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.postMessage({ type: 'hello' });
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) {} }, 20000);
  port.onDisconnect.addListener(() => {
    clearInterval(pingTimer);
    setTimeout(connect, 1000); // SW recycled — reconnect and re-hydrate
  });
}

chrome.storage.local.get(['serverUrl', 'ttsVoicePl', 'ttsVoiceEn', 'mla_mode', 'mla_token', 'mla_names']).then((c) => {
  if (c.serverUrl) serverUrl = c.serverUrl.replace(/\/+$/, '');
  ttsVoicePl = c.ttsVoicePl || 'Zosia';
  ttsVoiceEn = c.ttsVoiceEn || 'Daniel';
  serverToken = c.mla_token || '';
  buildNameRe(c.mla_names);
  if (c.mla_mode) modeSel.value = c.mla_mode;
  fetchHealth(); // first-run checklist (auto-opens once if something's missing)
});
// Pick up token / names edited in options without reopening the panel.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.mla_token) serverToken = ch.mla_token.newValue || '';
  if (ch.mla_names) buildNameRe(ch.mla_names.newValue);
});
connect();
startPolling();
