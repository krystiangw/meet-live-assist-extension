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
    }
    // 'ping' is a no-op: receiving it resets the SW idle timer (keep-alive).
  });
});
