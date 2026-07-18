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

async function loadState() {
  const { mla_session, mla_buffer } = await chrome.storage.session.get(['mla_session', 'mla_buffer']);
  return { session: mla_session || null, buffer: Array.isArray(mla_buffer) ? mla_buffer : [] };
}
async function saveState(session, buffer) {
  await chrome.storage.session.set({ mla_session: session, mla_buffer: buffer.slice(-BUFFER_MAX) });
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, line }),
      signal: ctrl.signal,
    });
    broadcast({ type: 'server', ok: res.ok });
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
  const tab = await findActiveMeetTab();
  if (!tab) { broadcast({ type: 'snapshot', ok: false, reason: 'meet tab not active' }); return; }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  } catch (e) { broadcast({ type: 'snapshot', ok: false, reason: String(e && e.message || e) }); return; }
  try {
    const r = await fetch((await getServerUrl()) + '/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  chrome.runtime.sendMessage({ type: 'offscreen-start', streamId, session: mla_session, lang: mla_lang || 'auto', serverUrl: await getServerUrl() });
  await chrome.storage.session.set({ mla_stt_on: true });
  try { chrome.tabs.sendMessage(tab.id, { type: 'capture-mode', captions: false }); } catch (_) {} // avoid dup transcript
}
async function stopStt() {
  chrome.runtime.sendMessage({ type: 'offscreen-stop' });
  await chrome.storage.session.set({ mla_stt_on: false });
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  for (const t of tabs) { try { chrome.tabs.sendMessage(t.id, { type: 'capture-mode', captions: true }); } catch (_) {} }
}

// ---- content script -> SW ------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'session') {
      await saveState(msg.session, []);
      await postToServer(msg.session, ''); // creates the file + header on the server
      broadcast({ type: 'session', session: msg.session, code: msg.code });
    } else if (msg.type === 'line') {
      const { session, buffer } = await loadState();
      const entry = { ts: msg.ts, speaker: msg.speaker, text: msg.text };
      buffer.push(entry);
      await saveState(msg.session || session, buffer);
      broadcast({ type: 'line', ...entry });
      await postToServer(msg.session || session, `[${msg.ts}] ${msg.speaker}: ${msg.text}\n`);
    } else if (msg.type === 'session-end') {
      await chrome.storage.session.set({ mla_sharing: false });
      broadcast({ type: 'session-end' });
      broadcast({ type: 'sharing', on: false });
    } else if (msg.type === 'sharing') {
      await chrome.storage.session.set({ mla_sharing: !!msg.on });
      broadcast({ type: 'sharing', on: !!msg.on });
    } else if (msg.type === 'lang') {
      await chrome.storage.session.set({ mla_lang: msg.lang });
      broadcast({ type: 'lang', lang: msg.lang });
    } else if (msg.type === 'stt-line') {
      const d = new Date();
      const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      broadcast({ type: 'line', ts, speaker: '', text: msg.text });
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
    }
    // 'ping' is a no-op: receiving it resets the SW idle timer (keep-alive).
  });
});
