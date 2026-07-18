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
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener(() => { /* wake-only keepalive; snapshots are driven by the panel */ });

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
async function persistCapFinal(msg) {
  const { session, buffer } = await loadState();
  const sess = msg.session || session;
  const { mla_commit, mla_recent } = await chrome.storage.session.get(['mla_commit', 'mla_recent']);
  const commit = (mla_commit && typeof mla_commit === 'object') ? mla_commit : {};
  const recent = Array.isArray(mla_recent) ? mla_recent : [];
  const full = (msg.text || '').trim();
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
  commit[msg.id] = full;
  const ids = Object.keys(commit);
  if (ids.length > 60) for (const k of ids.slice(0, ids.length - 60)) delete commit[k];
  if (delta) {
    recent.push({ speaker: spk, text: delta });
    if (recent.length > 12) recent.shift();
    buffer.push({ ts: msg.ts, speaker: msg.speaker, text: delta });
    await saveState(sess, buffer);
    const who = msg.speaker ? `${msg.speaker}: ` : '';
    await postToServer(sess, `[${msg.ts}] ${who}${delta}\n`);
  } else {
    await saveState(sess, buffer);
  }
  await chrome.storage.session.set({ mla_commit: commit, mla_recent: recent });
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

async function captureSnapshot() {
  const { mla_session } = await chrome.storage.session.get('mla_session');
  if (!mla_session) return;
  // Capture what the user is actually looking at: the active tab of the focused window. During a
  // self-share that's the shared app tab (Meet is inactive then); for a remote share it's usually the
  // Meet tab (which renders the shared screen). Fall back to any active Meet tab.
  let tab = null;
  try { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); tab = t || null; } catch (_) {}
  if (!tab || !/^https?:/.test(tab.url || '')) tab = await findActiveMeetTab();
  if (!tab) { broadcast({ type: 'snapshot', ok: false, reason: 'no capturable tab' }); return; }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  } catch (e) { broadcast({ type: 'snapshot', ok: false, reason: String(e && e.message || e) }); return; }
  try {
    const r = await fetch((await getServerUrl()) + '/snapshot', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({ session: mla_session, dataUrl }),
    });
    const j = r.ok ? await r.json() : null;
    await chrome.storage.session.set({ mla_lastSnap: Date.now() });
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
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
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
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  for (const t of tabs) { try { chrome.tabs.sendMessage(t.id, { type: 'capture-mode', captions: true }); } catch (_) {} }
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

// ---- live debugging: storage (scripting) + network/console (chrome.debugger) ----
let dbgTabId = null;
const netBuf = [];   // { method, url, status, mime, type }
const conBuf = [];   // { level, text }
const netReq = new Map(); // requestId -> { method, url }

chrome.debugger.onEvent.addListener((source, method, params) => {
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
chrome.debugger.onDetach.addListener((source) => { if (source.tabId === dbgTabId) { dbgTabId = null; broadcast({ type: 'debug', on: false }); } });

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
      await saveState(msg.session, []);
      // Ordered behind any in-flight persist so it can't be clobbered by a late cap-final from the old call.
      await (capQueue = capQueue.then(() => chrome.storage.session.set({ mla_commit: {}, mla_recent: [] })).catch(() => {}));
      await postToServer(msg.session, ''); // creates the file + header on the server
      broadcast({ type: 'session', session: msg.session, code: msg.code });
    } else if (msg.type === 'cap') {
      broadcast({ type: 'cap', id: msg.id, ts: msg.ts, speaker: msg.speaker, text: msg.text }); // live, no server
    } else if (msg.type === 'cap-final') {
      // Panel gets FULL text immediately (low latency, upserts by id → one clean line). Persistence to
      // the file/brain (dedup + delta) is serialized behind capQueue so concurrent cap-finals don't race.
      broadcast({ type: 'cap-final', ts: msg.ts, speaker: msg.speaker, text: msg.text, id: msg.id });
      capQueue = capQueue.then(() => persistCapFinal(msg)).catch(() => {});
    } else if (msg.type === 'session-end') {
      await chrome.storage.session.set({ mla_sharing: false });
      broadcast({ type: 'session-end' });
      broadcast({ type: 'sharing', on: false });
    } else if (msg.type === 'capture-health') {
      broadcast({ type: 'capture-health', ok: !!msg.ok, reason: msg.reason });
    } else if (msg.type === 'sharing') {
      await chrome.storage.session.set({ mla_sharing: !!msg.on });
      broadcast({ type: 'sharing', on: !!msg.on });
    } else if (msg.type === 'lang') {
      await chrome.storage.session.set({ mla_lang: msg.lang });
      broadcast({ type: 'lang', lang: msg.lang });
    } else if (msg.type === 'stt-line') {
      const d = new Date();
      const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      broadcast({ type: 'line', ts, speaker: '(unattributed)', text: msg.text });
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
      const { mla_sharing, mla_lang } = await chrome.storage.session.get(['mla_sharing', 'mla_lang']);
      port.postMessage({ type: 'restore', session, buffer, sharing: !!mla_sharing, lang: mla_lang || null });
    } else if (m.type === 'snapshot-now') {
      captureSnapshot();
    } else if (m.type === 'stt-start') {
      startStt();
    } else if (m.type === 'stt-stop') {
      stopStt();
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
