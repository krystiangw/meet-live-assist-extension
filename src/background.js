// Service worker — ROUTER + SCHEDULER ONLY. Holds no load-bearing in-memory state:
// it may be torn down after ~30s idle / a 5-min cap. Durable state lives in chrome.storage.session;
// the streaming/stateful work lives in the side-panel page (which survives SW death while open).
//
// Phase 0 responsibilities:
//   content script -> SW: caption lines + session lifecycle
//   SW -> side panel: broadcast lines over a long-lived port (+ replay buffer on (re)connect)
//   SW -> local server (127.0.0.1:8848 /append): keep Path A "brain" fed, unchanged
//   keep-alive: side-panel ping port + chrome.alarms heartbeat (survives SW restart)

const DEFAULT_SERVER = 'http://127.0.0.1:8848';
const BUFFER_MAX = 300; // recent lines kept for replay into a freshly-opened panel

const panelPorts = new Set();

// Open the side panel from the toolbar action.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Heartbeat: alarms fire even after the SW was unloaded, waking it back up.
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }); refreshBadge(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }); refreshBadge(); });
chrome.alarms.onAlarm.addListener(() => { refreshBadge(); }); // wake-only keepalive + keep the toolbar badge honest

// The toolbar icon reflects session state even when the panel is hidden, so you can close the
// panel and still see the session is live: no badge = idle, green = capturing, blue = an assistant
// (brain) is attached. Capture itself runs in the content script + SW, independent of the panel.
const BADGE = {
  idle:   { text: '',  color: null,      title: 'Meet Live Assist — no active session (click to open)' },
  live:   { text: '●', color: '#17935a', title: 'Meet Live Assist — capturing this meeting (click to open)' },
  brain:  { text: '●', color: '#3b6ef0', title: 'Meet Live Assist — capturing · assistant attached (click to open)' },
  paused: { text: '❙❙', color: '#b07a12', title: 'Meet Live Assist — PAUSED (capture + advice held; click to open)' },
};
async function setActionState(state) {
  const c = BADGE[state] || BADGE.idle;
  try {
    await chrome.action.setBadgeText({ text: c.text });
    if (c.color) {
      await chrome.action.setBadgeBackgroundColor({ color: c.color });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: c.color }); // glyph = bg → solid dot
    }
    await chrome.action.setTitle({ title: c.title });
  } catch (_) {}
}
// Active = a session is running (Meet/Zoom join or co-pilot), regardless of the panel being open.
// Upgrade live→brain when the server says an assistant pinged within 45s.
async function isPaused() {
  return (await chrome.storage.session.get('mla_paused')).mla_paused === true;
}
async function refreshBadge() {
  const { mla_active, mla_session, mla_paused } = await chrome.storage.session.get(['mla_active', 'mla_session', 'mla_paused']);
  if (!mla_active) { setActionState('idle'); return; }
  if (mla_paused) { setActionState('paused'); return; }
  let brain = false;
  if (mla_session) {
    try {
      const r = await fetch(`${await getServerUrl()}/brain-ping?session=${encodeURIComponent(mla_session)}`, { headers: await authHeaders() });
      if (r.ok) { const j = await r.json(); brain = j.ageMs != null && j.ageMs < 45000; }
    } catch (_) { /* server down — leave it as live */ }
  }
  setActionState(brain ? 'brain' : 'live');
}

// A keyboard command counts as invoking the extension, so it grants activeTab on the Meet tab —
// which tabCapture requires (a side-panel click does not). This is the reliable way to START STT.
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-stt') return;
  const { mla_stt_on } = await chrome.storage.session.get('mla_stt_on');
  if (mla_stt_on) stopStt(); else startStt();
});

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
}
async function getToken() {
  const { mla_token } = await chrome.storage.local.get('mla_token');
  return mla_token || '';
}
async function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-MLA-Token': await getToken() };
}

async function loadState() {
  const { mla_session, mla_buffer } = await chrome.storage.session.get(['mla_session', 'mla_buffer']);
  return { session: mla_session || null, buffer: Array.isArray(mla_buffer) ? mla_buffer : [] };
}
async function saveState(session, buffer) {
  await chrome.storage.session.set({ mla_session: session, mla_buffer: buffer.slice(-BUFFER_MAX) });
}

// cap-final persistence is a read-modify-write on chrome.storage.session; MV3 dispatches onMessage
// concurrently and Meet fires many cap-finals in bursts, so serialize persists to avoid lost updates.
let capQueue = Promise.resolve();
function commonPrefixLen(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; }
function textKey(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function tokenSim(a, b) {
  const A = new Set(textKey(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(textKey(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let i = 0; A.forEach((w) => { if (B.has(w)) i++; });
  return i / (A.size + B.size - i);
}
async function persistCapFinal(msg) {
  if (await isPaused()) return; // dropped during a hold — nothing recorded while paused
  const { session, buffer } = await loadState();
  const sess = msg.session || session;
  const { mla_commit, mla_recent, mla_committedLines, mla_rebaseline } = await chrome.storage.session.get(['mla_commit', 'mla_recent', 'mla_committedLines', 'mla_rebaseline']);
  const commit = (mla_commit && typeof mla_commit === 'object') ? mla_commit : {};
  const recent = Array.isArray(mla_recent) ? mla_recent : [];
  const committedLines = Array.isArray(mla_committedLines) ? mla_committedLines : [];
  const full = (msg.text || '').trim();
  // First cap-final after RESUME: adopt the current caption text as this block's baseline and emit nothing,
  // so words spoken during the hold don't leak as a delta on a block that straddled the pause. One-shot
  // (rare multi-block straddle may still leak one line; acceptable for the privacy win).
  if (mla_rebaseline) {
    commit[msg.id] = full;
    await chrome.storage.session.set({ mla_commit: commit, mla_rebaseline: false });
    await saveState(sess, buffer);
    return;
  }
  const prev = commit[msg.id] || '';
  // Emit only what's new vs this block's last commit, diffing on the longest common prefix so an ASR
  // mid-sentence revision re-posts just the changed tail (not the whole line). Back up to a word boundary.
  let lcp = commonPrefixLen(prev, full);
  if (lcp > 0 && lcp < full.length && full[lcp] !== ' ') { const sp = full.lastIndexOf(' ', lcp); lcp = sp >= 0 ? sp : 0; }
  let delta = full.slice(lcp).trim();
  const spk = msg.speaker || '';
  // Cross-block replay guard: drop an exact repeat, or a long substring of a very recent delta (a short
  // utterance like "yes"/"right" is kept even if it appears inside a recent line).
  if (delta && recent.some((r) => r.speaker === spk && (r.text === delta || (delta.length >= 15 && r.text.includes(delta))))) delta = '';
  // ASR revised an already-committed block's EARLY words → LCP=0 so the whole line re-posts as "new".
  // If the delta is basically the full line and it's mostly the same content we already committed, drop it.
  if (delta && prev && delta.length >= full.length * 0.6 && tokenSim(prev, full) > 0.6) delta = '';
  // Whole-session replay guard: a DOM re-scrape re-finalizes OLD blocks (new id, old text) long after they
  // left the small `recent` window. Drop an exact re-commit of a line already written this session.
  const fullKey = textKey(full);
  if (delta && full.length >= 15 && committedLines.includes(fullKey)) delta = '';
  commit[msg.id] = full;
  const ids = Object.keys(commit);
  if (ids.length > 60) for (const k of ids.slice(0, ids.length - 60)) delete commit[k];
  if (delta) {
    recent.push({ speaker: spk, text: delta });
    if (recent.length > 12) recent.shift();
    if (full.length >= 15) { committedLines.push(fullKey); if (committedLines.length > 400) committedLines.shift(); }
    buffer.push({ ts: msg.ts, speaker: msg.speaker, text: delta });
    await saveState(sess, buffer);
    const who = msg.speaker ? `${msg.speaker}: ` : '';
    await postToServer(sess, `[${msg.ts}] ${who}${delta}\n`);
  } else {
    await saveState(sess, buffer);
  }
  await chrome.storage.session.set({ mla_commit: commit, mla_recent: recent, mla_committedLines: committedLines });
}

function broadcast(msg) {
  for (const port of panelPorts) { try { port.postMessage(msg); } catch (_) { panelPorts.delete(port); } }
}

async function postToServer(session, line) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000); // never let a POST hang silently
  try {
    const res = await fetch((await getServerUrl()) + '/append', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ session, line }),
      signal: ctrl.signal,
    });
    broadcast({ type: 'server', ok: res.ok, status: res.status });
  } catch (_) {
    broadcast({ type: 'server', ok: false });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Meet tab snapshots (visual context) ---------------------------------
async function findActiveMeetTab() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  return tabs.find((t) => t.active) || null; // captureVisibleTab needs the tab active in its window
}

const SNAP_HASH_THRESHOLD = 6;    // dHash bits changed that count as a material visual change
const SNAP_FLOOR_MS = 5000;       // never auto-send faster than this (kills video/animation spam)
const SNAP_HEARTBEAT_MS = 60000;  // …but land at least one frame/min even if the slide is static

// 9x8 grayscale difference-hash → 64-bit fingerprint (hex). Tolerant of compression noise / cursor jitter.
async function frameHash(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const w = 9; const h = 8;
    const ctx = new OffscreenCanvas(w, h).getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let bits = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 4; const j = (y * w + x + 1) * 4;
        const g1 = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const g2 = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
        bits += g1 > g2 ? '1' : '0';
      }
    }
    let hex = '';
    for (let k = 0; k < bits.length; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
    return hex;
  } catch (_) { return null; }
}
function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}

async function captureSnapshot(auto = false) {
  const { mla_session } = await chrome.storage.session.get('mla_session');
  if (!mla_session) return;
  if (auto && await isPaused()) return; // no automatic frames while paused (manual 📷 still allowed)
  // Capture what the user is actually looking at: the active tab of the focused window. During a
  // self-share that's the shared app tab (Meet is inactive then); for a remote share it's usually the
  // Meet tab (which renders the shared screen). Fall back to any active Meet tab.
  let tab = null;
  try { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); tab = t || null; } catch (_) {}
  if (auto) {
    // Auto-capture stays ON THE MEETING — never snapshot a private tab the user flips to mid-call.
    // Allowed: the Meet/Zoom tab (renders a remote share) and the "presented" tab (first non-meeting tab
    // seen during a share, i.e. the one being self-shared). Any other tab → skip. Manual 📷 / agent
    // requests below still capture whatever's visible.
    if (!tab || !/^https?:/.test(tab.url || '')) return;
    const isMeeting = /^https:\/\/meet\.google\.com\//.test(tab.url) || /^https:\/\/[^/]*\.zoom\.us\//.test(tab.url);
    if (!isMeeting) {
      const { mla_shareTabId } = await chrome.storage.session.get('mla_shareTabId');
      if (mla_shareTabId == null) await chrome.storage.session.set({ mla_shareTabId: tab.id });
      else if (tab.id !== mla_shareTabId) return; // unrelated tab the user flipped to → don't capture it
    }
  } else {
    if (!tab || !/^https?:/.test(tab.url || '')) tab = await findActiveMeetTab();
    if (!tab) { broadcast({ type: 'snapshot', ok: false, reason: 'no capturable tab' }); return; }
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  } catch (e) {
    const m = String((e && e.message) || e);
    const perm = /permission|<all_urls>|activeTab/i.test(m); // shared tab not covered by host perms
    if (!auto) broadcast({ type: 'snapshot', ok: false, perm, reason: perm ? 'needs screen access for this tab' : m });
    return;
  }

  const hash = await frameHash(dataUrl);
  // Auto (presentation) sampling: forward only when the screen actually changed, so a static slide
  // doesn't flood the brain with identical frames. Manual button / agent request always send.
  if (auto) {
    const { mla_snapHash, mla_snapSentTs } = await chrome.storage.session.get(['mla_snapHash', 'mla_snapSentTs']);
    const now = Date.now();
    const changed = !mla_snapHash || !hash || hammingHex(hash, mla_snapHash) > SNAP_HASH_THRESHOLD;
    const floorOk = !mla_snapSentTs || (now - mla_snapSentTs) >= SNAP_FLOOR_MS;
    const heartbeat = !mla_snapSentTs || (now - mla_snapSentTs) > SNAP_HEARTBEAT_MS;
    if (!((changed && floorOk) || heartbeat)) return; // unchanged → skip silently
  }

  try {
    const r = await fetch((await getServerUrl()) + '/snapshot', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({ session: mla_session, dataUrl }),
    });
    const j = r.ok ? await r.json() : null;
    if (r.ok) await chrome.storage.session.set({ mla_lastSnap: Date.now(), mla_snapHash: hash, mla_snapSentTs: Date.now() });
    broadcast({ type: 'snapshot', ok: r.ok, count: j && j.count });
  } catch (_) { broadcast({ type: 'snapshot', ok: false, reason: 'server' }); }
}

// ---- local STT (tab audio -> offscreen -> /stt whisper) ------------------
async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Transcribe Meet tab audio locally (whisper).',
  });
}
async function startStt() {
  const tabs = await chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://*.zoom.us/*'] });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) { broadcast({ type: 'stt', on: false, reason: 'no meet tab' }); return; }
  let streamId;
  try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }); }
  catch (e) { broadcast({ type: 'stt', on: false, reason: String(e && e.message || e) }); return; }
  await ensureOffscreen();
  const { mla_session, mla_lang } = await chrome.storage.session.get(['mla_session', 'mla_lang']);
  chrome.runtime.sendMessage({ type: 'offscreen-start', streamId, session: mla_session, lang: mla_lang || 'auto', serverUrl: await getServerUrl(), token: await getToken() });
  await chrome.storage.session.set({ mla_stt_on: true });
  try { chrome.tabs.sendMessage(tab.id, { type: 'capture-mode', captions: false }); } catch (_) {} // avoid dup transcript
}
async function stopStt() {
  chrome.runtime.sendMessage({ type: 'offscreen-stop' });
  await chrome.storage.session.set({ mla_stt_on: false });
  const tabs = await chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://*.zoom.us/*'] });
  for (const t of tabs) { try { chrome.tabs.sendMessage(t.id, { type: 'capture-mode', captions: true }); } catch (_) {} }
}

// ---- co-pilot: a session without any meeting (debug your app with the agent watching + listening) ----
function pad2(n) { return String(n).padStart(2, '0'); }
function buildCopilotSession() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}_copilot`;
}
async function startCoPilot() {
  const session = buildCopilotSession();
  await saveState(session, []);
  await (capQueue = capQueue.then(() => chrome.storage.session.set({ mla_commit: {}, mla_recent: [], mla_committedLines: [] })).catch(() => {}));
  await postToServer(session, ''); // create the file + header
  await chrome.storage.session.set({ mla_active: true, mla_paused: false }); // never inherit a stale pause
  setActionState('live');
  broadcast({ type: 'session', session, code: 'copilot' });
  // Listen to the microphone (the user), transcribed locally — no Meet tab involved.
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'offscreen-start', source: 'mic', session, lang: 'auto', serverUrl: await getServerUrl(), token: await getToken() });
  await chrome.storage.session.set({ mla_stt_on: true });
}
async function stopCoPilot() {
  stopStt();
  await chrome.storage.session.set({ mla_session: null, mla_active: false, mla_paused: false });
  setActionState('idle');
  broadcast({ type: 'session-end' });
}

// Relay a message into the meeting chat via the active Meet/Zoom tab's content script. The content script
// reports actual delivery back via a 'callchat-done' message → /callchat-result (so the brain gets an ACK).
async function sendToCallChat(text, seq) {
  if (!text) return;
  const tabs = await chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://*.zoom.us/wc/*'] });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) { broadcast({ type: 'callchat', ok: false, reason: 'no meeting tab' }); await postCallChatResult(seq, false, 'no meeting tab'); return; }
  try { await chrome.tabs.sendMessage(tab.id, { type: 'call-chat', text, seq }); broadcast({ type: 'callchat', ok: true }); }
  catch (e) { broadcast({ type: 'callchat', ok: false, reason: String(e && e.message || e) }); await postCallChatResult(seq, false, 'content script unreachable'); }
}
async function postCallChatResult(seq, ok, reason) {
  const { mla_session } = await chrome.storage.session.get('mla_session');
  if (!mla_session) return;
  try {
    await fetch((await getServerUrl()) + '/callchat-result', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({ session: mla_session, seq, ok, reason: reason || '' }),
    });
  } catch (_) {}
}

// ---- presentation DOM edits on the shared (non-Meet) tab -----------------
let lastAppTabId = null; // most recently focused http(s) tab that isn't Meet = the app being shared
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.url && /^https?:/.test(t.url) && !t.url.startsWith('https://meet.google.com')) lastAppTabId = tabId;
  } catch (_) {}
});
async function appTabId() {
  if (lastAppTabId != null) { try { await chrome.tabs.get(lastAppTabId); return lastAppTabId; } catch (_) { lastAppTabId = null; } }
  const tabs = await chrome.tabs.query({});
  const cand = tabs.filter((t) => t.url && /^https?:/.test(t.url) && !t.url.startsWith('https://meet.google.com'))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return cand[0] && cand[0].id;
}
async function applyEdit(cmd) {
  const id = await appTabId();
  if (!id) { broadcast({ type: 'edit', ok: false, reason: 'no app tab' }); return; }
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: pageApplyEdit, args: [cmd] });
    broadcast({ type: 'edit', ok: !!(r && r.result && r.result.ok), result: r && r.result });
  } catch (e) { broadcast({ type: 'edit', ok: false, reason: String(e && e.message || e) }); }
}
async function captureDom() {
  const id = await appTabId();
  if (!id) return;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: pageGetDom });
    const { mla_session } = await chrome.storage.session.get('mla_session');
    await fetch((await getServerUrl()) + '/dom', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({ session: mla_session, html: (r && r.result) || '' }),
    });
    broadcast({ type: 'edit', ok: true, result: { dom: true } });
  } catch (_) {}
}

// These run in the SHARED page's context (serialized by executeScript — must be self-contained).
function pageApplyEdit(cmd) {
  const store = (window.__mlaEdits = window.__mlaEdits || { items: [] });
  const texts = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(n.parentElement.tagName) && n.nodeValue.trim()) ? 1 : 2,
    });
    const out = []; let n; while ((n = w.nextNode())) out.push(n); return out;
  };
  try {
    const o = cmd.op;
    if (o === 'replaceText') {
      if (!cmd.find) return { ok: false, msg: 'no find' };
      let c = 0;
      for (const n of texts(document.body)) if (n.nodeValue.includes(cmd.find)) {
        store.items.push({ type: 'text', node: n, original: n.nodeValue });
        n.nodeValue = n.nodeValue.split(cmd.find).join(cmd.replace == null ? '' : cmd.replace); c++;
      }
      return { ok: c > 0, count: c };
    }
    if (o === 'hideText') {
      let c = 0;
      for (const n of texts(document.body)) if (cmd.text && n.nodeValue.includes(cmd.text)) {
        const el = n.parentElement; if (el) { store.items.push({ type: 'style', el, prop: 'display', original: el.style.display }); el.style.display = 'none'; c++; }
      }
      return { ok: c > 0, count: c };
    }
    const els = cmd.selector ? Array.from(document.querySelectorAll(cmd.selector)) : [];
    if (o === 'setText') { els.forEach((el) => { store.items.push({ type: 'prop', el, prop: 'textContent', original: el.textContent }); el.textContent = cmd.value == null ? '' : cmd.value; }); return { ok: els.length > 0, count: els.length }; }
    if (o === 'setHtml') { els.forEach((el) => { store.items.push({ type: 'prop', el, prop: 'innerHTML', original: el.innerHTML }); el.innerHTML = cmd.value == null ? '' : cmd.value; }); return { ok: els.length > 0, count: els.length }; }
    if (o === 'hide') { els.forEach((el) => { store.items.push({ type: 'style', el, prop: 'display', original: el.style.display }); el.style.display = 'none'; }); return { ok: els.length > 0, count: els.length }; }
    if (o === 'style' && cmd.css) { els.forEach((el) => { for (const k in cmd.css) { store.items.push({ type: 'style', el, prop: k, original: el.style[k] }); el.style[k] = cmd.css[k]; } }); return { ok: els.length > 0, count: els.length }; }
    if (o === 'revert') {
      let n = 0;
      for (let i = store.items.length - 1; i >= 0; i--) { const it = store.items[i]; try { if (it.type === 'text') it.node.nodeValue = it.original; else if (it.type === 'prop') it.el[it.prop] = it.original; else if (it.type === 'style') it.el.style[it.prop] = it.original; n++; } catch (_) {} }
      store.items.length = 0; return { ok: true, reverted: n };
    }
    return { ok: false, msg: 'unknown op' };
  } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
}
function pageGetDom() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script,style,svg,noscript,link,path').forEach((e) => e.remove());
  return clone.outerHTML.replace(/\s+/g, ' ').slice(0, 180000);
}

// ---- agent-driven page actions (flow testing / debugging) ----------------
// Runs in the app tab's context (self-contained). Real interaction, so it is NOT reversible like /edit.
async function pageAct(cmd) {
  const q = (s) => { try { return s ? document.querySelector(s) : null; } catch (_) { return null; } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v == null ? '' : v); else el.value = v == null ? '' : v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  try {
    const o = cmd.op;
    if (o === 'waitFor' || o === 'exists') {
      const to = Math.min(cmd.timeout || 8000, 20000); const t0 = Date.now();
      let el = q(cmd.selector);
      while (o === 'waitFor' && !el && Date.now() - t0 < to) { await wait(150); el = q(cmd.selector); }
      return { ok: !!el, value: !!el };
    }
    if (o === 'getText') { const el = q(cmd.selector); return el ? { ok: true, value: (el.innerText || el.textContent || '').trim().slice(0, 2000) } : { ok: false, error: 'not found' }; }
    const el = q(cmd.selector);
    if (o === 'scroll') { if (!el) return { ok: false, error: 'not found' }; el.scrollIntoView({ block: 'center' }); return { ok: true }; }
    if (o === 'click') { if (!el) return { ok: false, error: 'not found' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true }; }
    if (o === 'type') {
      if (!el) return { ok: false, error: 'not found' };
      el.focus();
      if (el.isContentEditable) { el.textContent = cmd.text || ''; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
      else setVal(el, cmd.text);
      return { ok: true };
    }
    if (o === 'press') {
      const target = el || document.activeElement || document.body;
      const key = cmd.key || 'Enter';
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: key === 'Enter' ? 13 : 0, bubbles: true }));
      return { ok: true };
    }
    if (o === 'select') { if (!el) return { ok: false, error: 'not found' }; el.value = cmd.value; el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; }
    return { ok: false, error: 'unknown op' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
async function handleAct(cmd) {
  const { mla_session } = await chrome.storage.session.get('mla_session');
  let result;
  const id = await appTabId();
  if (!id) result = { ok: false, error: 'no app tab' };
  else if (cmd.op === 'navigate') {
    try { await chrome.tabs.update(id, { url: cmd.url }); result = { ok: true }; }
    catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
  } else {
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: pageAct, args: [cmd] }); result = (r && r.result) || { ok: false, error: 'no result' }; }
    catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
  }
  broadcast({ type: 'act', ok: result.ok, op: cmd.op, reason: result.error });
  try {
    await fetch((await getServerUrl()) + '/act-result', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({ session: mla_session, seq: cmd.seq, ok: result.ok, value: result.value, error: result.error }),
    });
  } catch (_) {}
}

// ---- live debugging: storage (scripting) + network/console (chrome.debugger) ----
let dbgTabId = null;
const netBuf = [];   // { method, url, status, mime, type }
const conBuf = [];   // { level, text }
const netReq = new Map(); // requestId -> { method, url }

// Guarded: `debugger` is an optional permission — the namespace may be inert until granted.
if (chrome.debugger) chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== dbgTabId) return;
  if (method === 'Network.requestWillBeSent') {
    netReq.set(params.requestId, { method: params.request.method, url: params.request.url });
  } else if (method === 'Network.responseReceived') {
    const r = netReq.get(params.requestId) || {};
    netBuf.push({ method: r.method || params.type, url: params.response.url, status: params.response.status, mime: params.response.mimeType });
    if (netBuf.length > 250) netBuf.shift();
  } else if (method === 'Runtime.consoleAPICalled') {
    conBuf.push({ level: params.type, text: (params.args || []).map((a) => a.value != null ? a.value : (a.description || '')).join(' ').slice(0, 500) });
    if (conBuf.length > 250) conBuf.shift();
  } else if (method === 'Runtime.exceptionThrown') {
    const e = params.exceptionDetails || {};
    conBuf.push({ level: 'error', text: `${e.text || ''} ${(e.exception && e.exception.description) || ''}`.slice(0, 500) });
    if (conBuf.length > 250) conBuf.shift();
  }
});
if (chrome.debugger) chrome.debugger.onDetach.addListener((source) => { if (source.tabId === dbgTabId) { dbgTabId = null; broadcast({ type: 'debug', on: false }); } });

async function attachDebugger() {
  const id = await appTabId();
  if (!id) { broadcast({ type: 'debug', on: false, reason: 'no app tab' }); return; }
  try {
    await chrome.debugger.attach({ tabId: id }, '1.3');
    dbgTabId = id; netBuf.length = 0; conBuf.length = 0; netReq.clear();
    await chrome.debugger.sendCommand({ tabId: id }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.enable');
    broadcast({ type: 'debug', on: true });
  } catch (e) { broadcast({ type: 'debug', on: false, reason: String(e && e.message || e) }); }
}
async function detachDebugger() {
  if (dbgTabId != null) { try { await chrome.debugger.detach({ tabId: dbgTabId }); } catch (_) {} dbgTabId = null; }
  broadcast({ type: 'debug', on: false });
}

function pageGetStorage() {
  const dump = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } } catch (_) {} return o; };
  return { url: location.href, cookies: document.cookie, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
}
function pageGetPerf() {
  return performance.getEntriesByType('resource').slice(-120)
    .map((e) => ({ url: e.name, type: e.initiatorType, dur: Math.round(e.duration), size: e.transferSize || 0 }));
}

async function gatherDebug(kind) {
  if (kind === 'storage') {
    const id = await appTabId(); if (!id) return { error: 'no app tab' };
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: pageGetStorage }); return r && r.result; }
    catch (e) { return { error: String(e && e.message || e) }; }
  }
  if (kind === 'network') {
    if (dbgTabId != null) return { source: 'debugger', requests: netBuf.slice(-120) };
    const id = await appTabId(); if (!id) return { error: 'no app tab' };
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: pageGetPerf }); return { source: 'performance (enable 🐞 debug for status/bodies)', requests: r && r.result }; }
    catch (e) { return { error: String(e && e.message || e) }; }
  }
  if (kind === 'console') {
    if (dbgTabId == null) return { error: 'enable 🐞 debug to capture console' };
    return { logs: conBuf.slice(-120) };
  }
  return { error: 'unknown kind' };
}
async function handleDebugDo(kind) {
  const data = await gatherDebug(kind);
  const { mla_session } = await chrome.storage.session.get('mla_session');
  try {
    await fetch((await getServerUrl()) + '/debug', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({ session: mla_session, kind, data }),
    });
  } catch (_) {}
  broadcast({ type: 'debug-done', kind });
}

// ---- content script -> SW ------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'session') {
      // A genuinely new session started (Meet/Zoom join or rejoin). Stop any active STT first so a co-pilot
      // mic / tab recorder can't keep writing to the previous (now stale) session or keep holding the mic.
      const { mla_stt_on } = await chrome.storage.session.get('mla_stt_on');
      if (mla_stt_on) await stopStt();
      await saveState(msg.session, []);
      // Ordered behind any in-flight persist so it can't be clobbered by a late cap-final from the old call.
      await (capQueue = capQueue.then(() => chrome.storage.session.set({ mla_commit: {}, mla_recent: [], mla_committedLines: [] })).catch(() => {}));
      await postToServer(msg.session, ''); // creates the file + header on the server
      await chrome.storage.session.set({ mla_active: true, mla_paused: false });
      setActionState('live');
      broadcast({ type: 'session', session: msg.session, code: msg.code });
    } else if (msg.type === 'cap') {
      if (!(await isPaused())) broadcast({ type: 'cap', id: msg.id, ts: msg.ts, speaker: msg.speaker, text: msg.text }); // live, no server
    } else if (msg.type === 'cap-final') {
      // Panel gets FULL text immediately (low latency, upserts by id → one clean line). Persistence to
      // the file/brain (dedup + delta) is serialized behind capQueue so concurrent cap-finals don't race.
      // Enqueue SYNCHRONOUSLY (before any await) so cap-final file order is preserved; persistCapFinal
      // itself drops the write while paused. Broadcast is upsert-by-id, so gating it async is harmless.
      capQueue = capQueue.then(() => persistCapFinal(msg)).catch(() => {});
      if (!(await isPaused())) broadcast({ type: 'cap-final', ts: msg.ts, speaker: msg.speaker, text: msg.text, id: msg.id });
    } else if (msg.type === 'chat-in') {
      // Meeting-chat message → feed the brain as a distinct [chat] line + mirror to the panel transcript.
      const { mla_session } = await chrome.storage.session.get('mla_session');
      const sess = msg.session || mla_session;
      if (sess) {
        // Enqueue synchronously (order-safe); the thunk skips the write while paused.
        capQueue = capQueue.then(async () => { if (await isPaused()) return; return postToServer(sess, `[${msg.ts}] [chat] ${msg.sender}: ${msg.text}\n`); }).catch(() => {});
        if (!(await isPaused())) broadcast({ type: 'chat-in', ts: msg.ts, sender: msg.sender, text: msg.text });
      }
    } else if (msg.type === 'callchat-done') {
      // Content script reports whether a /callchat message actually landed in Meet → ACK for the brain.
      await postCallChatResult(msg.seq, !!msg.ok, msg.reason);
      broadcast({ type: 'callchat', ok: !!msg.ok, reason: msg.reason || '' });
    } else if (msg.type === 'session-end') {
      await chrome.storage.session.set({ mla_sharing: false, mla_active: false, mla_shareTabId: null, mla_paused: false });
      setActionState('idle');
      broadcast({ type: 'session-end' });
      broadcast({ type: 'sharing', on: false });
    } else if (msg.type === 'capture-health') {
      broadcast({ type: 'capture-health', ok: !!msg.ok, reason: msg.reason });
    } else if (msg.type === 'sharing') {
      // Reset the learned "presented" tab on every share transition so it re-learns per share.
      await chrome.storage.session.set({ mla_sharing: !!msg.on, mla_shareTabId: null });
      broadcast({ type: 'sharing', on: !!msg.on });
    } else if (msg.type === 'lang') {
      await chrome.storage.session.set({ mla_lang: msg.lang });
      broadcast({ type: 'lang', lang: msg.lang });
    } else if (msg.type === 'stt-line') {
      if (!(await isPaused())) {
        const d = new Date();
        const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
        // Mic STT is the user (Krystian → 'You'); tabCapture STT is remote participants (unattributed).
        broadcast({ type: 'line', ts, speaker: msg.source === 'mic' ? 'You' : '(unattributed)', text: msg.text });
      }
    } else if (msg.type === 'stt-status') {
      broadcast({ type: 'stt', on: !!msg.on });
    } else if (msg.type === 'stt-error') {
      broadcast({ type: 'stt', on: false, reason: msg.reason });
    }
    sendResponse({ ok: true });
  })();
  return true; // async response
});

// ---- side panel <-> SW (long-lived port) ---------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener(async (m) => {
    if (m.type === 'hello') {
      const { session, buffer } = await loadState();
      const { mla_sharing, mla_lang, mla_paused } = await chrome.storage.session.get(['mla_sharing', 'mla_lang', 'mla_paused']);
      port.postMessage({ type: 'restore', session, buffer, sharing: !!mla_sharing, lang: mla_lang || null, paused: !!mla_paused });
    } else if (m.type === 'snapshot-now') {
      captureSnapshot(!!m.auto);
    } else if (m.type === 'stt-start') {
      startStt();
    } else if (m.type === 'stt-stop') {
      stopStt();
    } else if (m.type === 'copilot-start') {
      startCoPilot();
    } else if (m.type === 'copilot-stop') {
      stopCoPilot();
    } else if (m.type === 'pause') {
      await chrome.storage.session.set({ mla_paused: true });
      setActionState('paused');
      broadcast({ type: 'paused', on: true });
    } else if (m.type === 'resume') {
      // mla_rebaseline: next cap-final adopts current text as baseline so paused words don't leak (see persistCapFinal).
      await chrome.storage.session.set({ mla_paused: false, mla_rebaseline: true });
      refreshBadge();
      broadcast({ type: 'paused', on: false });
    } else if (m.type === 'session-stop') {
      // Graceful end from the panel: stop capture (like a real call ending). The brain wraps up + stops
      // via the /control 'stopped' the panel also posts. Distinct from 🗑 clear (which wipes data).
      await chrome.storage.session.set({ mla_sharing: false, mla_active: false, mla_shareTabId: null, mla_paused: false });
      setActionState('idle');
      broadcast({ type: 'session-end' });
      broadcast({ type: 'sharing', on: false });
    } else if (m.type === 'send-call-chat') {
      sendToCallChat(m.text, m.seq);
    } else if (m.type === 'do-act') {
      handleAct(m.cmd);
    } else if (m.type === 'apply-edit') {
      applyEdit(m.cmd);
    } else if (m.type === 'capture-dom') {
      captureDom();
    } else if (m.type === 'debug-toggle') {
      if (m.on) attachDebugger(); else detachDebugger();
    } else if (m.type === 'debug-do') {
      handleDebugDo(m.kind);
    }
    // 'ping' is a no-op: receiving it resets the SW idle timer (keep-alive).
  });
});
