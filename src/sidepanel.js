// Side panel — primary live UI. This page persists while open, so it (not the SW) owns any
// long-lived state/streaming. Renders live transcript (via the SW port) + live advice (polled
// straight from the transcript server's /advice channel — the "brain" POSTs advice there).

const logEl = document.getElementById('log');
const adviceEl = document.getElementById('advice');
const capEl = document.getElementById('capStatus');
const srvEl = document.getElementById('srvStatus');
const snapEl = document.getElementById('snapStatus');
const snapBtn = document.getElementById('snapNow');
const shareEl = document.getElementById('shareStatus');
const speakEl = document.getElementById('speakStatus');
const sessionEl = document.getElementById('session');
const chatEl = document.getElementById('chat');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

const MARKER_LABEL = { SAY: '🟢 SAY', INFO: '🔵 INFO', SUMMARY: '🟡 SUMMARY', EXPLAIN: '🟣 EXPLAIN', RISK: '🔴 RISK', ACTION: '🟠 ACTION' };
const DEFAULT_SERVER = 'http://127.0.0.1:8848';

let hasLines = false;
let hasAdvice = false;
let currentSession = null;
let lastAdviceSeq = 0;
let lastReqSeq = -1; // -1 = baseline unknown for this session (don't fire on first poll)
let lastChatSeq = 0;
let sharing = false;
let serverUrl = DEFAULT_SERVER;
let ttsVoicePl = null;
let ttsVoiceEn = null;
let callLang = null; // from Meet's caption-language selector (via content script)
let port = null;
let pingTimer = null;
let pollTimer = null;
let shareTimer = null;

function setStatus(el, text, cls) { el.textContent = text; el.className = 'status ' + cls; }

// ---- transcript ----------------------------------------------------------
function clearLog() { logEl.innerHTML = ''; hasLines = false; }

function appendLine({ ts, speaker, text }) {
  if (!hasLines) { logEl.innerHTML = ''; hasLines = true; }
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const div = document.createElement('div');
  div.className = 'line';
  const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts || '';
  const w = document.createElement('span'); w.className = 'who'; w.textContent = (speaker || 'Unknown') + ': ';
  div.append(t, w, document.createTextNode(text || ''));
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
function renderRich(parent, text) {
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => { if (i) parent.appendChild(document.createElement('br')); renderInline(parent, line); });
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
  adviceEl.appendChild(div);
  adviceEl.scrollTop = adviceEl.scrollHeight;
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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

async function pollAdvice() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/advice?session=${encodeURIComponent(currentSession)}&since=${lastAdviceSeq}`);
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendAdvice);
    if (typeof last === 'number') lastAdviceSeq = Math.max(lastAdviceSeq, last);
  } catch (_) { /* server down — transcript-side status already reflects it */ }
}

async function pollSnapRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/snapshot-request?session=${encodeURIComponent(currentSession)}`);
    if (!r.ok) return;
    const { seq } = await r.json();
    if (typeof seq !== 'number') return;
    if (lastReqSeq < 0) { lastReqSeq = seq; return; } // first poll = baseline, don't fire
    if (seq > lastReqSeq) { lastReqSeq = seq; requestCapture(); } // agent asked for a shot
  } catch (_) { /* server down */ }
}

function requestCapture() { try { port.postMessage({ type: 'snapshot-now' }); } catch (_) {} }

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
    const r = await fetch(`${serverUrl}/chat?session=${encodeURIComponent(currentSession)}&since=${lastChatSeq}`);
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendChat);
    if (typeof last === 'number') lastChatSeq = Math.max(lastChatSeq, last);
  } catch (_) { /* server down */ }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !currentSession) return;
  chatInput.value = '';
  try {
    await fetch(`${serverUrl}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: currentSession, role: 'user', text }),
    });
    pollChat(); // reflect immediately
  } catch (_) {}
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

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollAdvice(); pollSnapRequest(); pollChat(); }, 1500);
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
    case 'session':
      clearLog(); resetAdvice();
      setStatus(capEl, 'capturing', 'ok');
      sessionEl.textContent = msg.session || '';
      setSession(msg.session);
      break;
    case 'line':
      setStatus(capEl, 'capturing', 'ok');
      appendLine(msg);
      break;
    case 'session-end':
      setStatus(capEl, 'call ended', 'idle');
      setSharing(false);
      break;
    case 'sharing':
      setSharing(msg.on);
      break;
    case 'lang':
      callLang = msg.lang;
      break;
    case 'server':
      setStatus(srvEl, msg.ok ? 'server ✓' : 'server ✗ (start it)', msg.ok ? 'ok' : 'bad');
      break;
    case 'snapshot':
      if (msg.ok) setStatus(snapEl, `shots ${msg.count ?? '·'}`, 'ok');
      else setStatus(snapEl, `shot ✗ ${msg.reason || ''}`.trim(), 'bad');
      break;
  }
}

snapBtn.addEventListener('click', () => { try { port.postMessage({ type: 'snapshot-now' }); } catch (_) {} });

function setSession(session) {
  if (session && session !== currentSession) {
    currentSession = session; lastAdviceSeq = 0; lastReqSeq = -1; lastChatSeq = 0;
    chatEl.innerHTML = '';
    pollAdvice(); pollSnapRequest(); pollChat();
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

chrome.storage.local.get(['serverUrl', 'ttsVoicePl', 'ttsVoiceEn']).then((c) => {
  if (c.serverUrl) serverUrl = c.serverUrl.replace(/\/+$/, '');
  ttsVoicePl = c.ttsVoicePl || 'Zosia';
  ttsVoiceEn = c.ttsVoiceEn || 'Daniel';
});
connect();
startPolling();
