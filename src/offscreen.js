// Offscreen document — the only place that can consume a tabCapture MediaStream in MV3.
// Records audio in short complete WebM chunks (CHUNK_MS) and POSTs each to the local server's /stt.
// Each chunk is a full file (start/stop per chunk) so it decodes standalone.
//
// Two sources can run at once, which is what makes STT a usable caption fallback: `tab` carries the
// REMOTE participants (tabCapture never includes your own mic) and `mic` carries the user. The server
// labels them differently ('(unattributed)' vs 'You'), so attribution — and with it the rule that only
// the user can authorize actions — survives a call with no captions at all.

// 4s, not 6: whisper costs the same per call regardless of chunk length (measured 1.5s for both a 2s and a
// 6s chunk — the model load dominates), so a shorter chunk buys ~1.5s of latency at the price of more calls.
// Worth it now that the model stays resident server-side; 2s chunks were measurably worse ("wandelskich").
const CHUNK_MS = 4000;
const MIN_BYTES = 4000; // skip near-silent tiny blobs

const sources = new Map(); // 'tab' | 'mic' -> { stream, recorder, audioCtx, active }
let cfg = null;

// Pick a container the capture stream can actually record; 'audio/webm' alone can be rejected
// (NotSupportedError on start) depending on the Chrome build. '' = let the browser choose.
function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
  }
  return '';
}
let mime = '';

function anyActive() {
  for (const s of sources.values()) if (s.active) return true;
  return false;
}

async function startSource(kind, streamId, config) {
  if (sources.has(kind)) return; // already recording this source
  cfg = config;
  let stream;
  try {
    stream = kind === 'mic'
      ? await navigator.mediaDevices.getUserMedia({ audio: true })
      : await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } });
  } catch (e) {
    // One source failing must not take the other down — tab-only (or mic-only) is still useful.
    chrome.runtime.sendMessage({
      type: 'stt-error', source: kind, fatal: !anyActive(),
      reason: kind === 'mic' ? 'microphone blocked — allow it for the extension' : String((e && e.message) || e),
    });
    return;
  }
  const entry = { stream, recorder: null, audioCtx: null, active: true };
  // tabCapture mutes the tab locally — re-route to speakers so the user still hears the call. Mic needs no reroute.
  if (kind !== 'mic') {
    entry.audioCtx = new AudioContext();
    entry.audioCtx.createMediaStreamSource(stream).connect(entry.audioCtx.destination);
  }
  sources.set(kind, entry);
  mime = mime || pickMime();
  chrome.runtime.sendMessage({ type: 'stt-status', on: true, source: kind });
  loop(kind);
}

async function transcribeChunk(kind, blob) {
  try {
    const url = `${cfg.serverUrl}/stt?session=${encodeURIComponent(cfg.session)}&lang=${encodeURIComponent(cfg.lang || 'auto')}&src=${kind}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-MLA-Token': cfg.token || '' }, body: blob });
    if (r.ok) { const { text, speaker } = await r.json(); if (text) chrome.runtime.sendMessage({ type: 'stt-line', text, speaker, source: kind }); }
  } catch (_) { /* server down */ }
}

function loop(kind) {
  const entry = sources.get(kind);
  if (!entry || !entry.active || !entry.stream) return;
  const parts = [];
  let rec;
  try { rec = mime ? new MediaRecorder(entry.stream, { mimeType: mime }) : new MediaRecorder(entry.stream); }
  catch (e) {
    entry.active = false;
    chrome.runtime.sendMessage({ type: 'stt-error', source: kind, fatal: !anyActive(), reason: String((e && e.message) || e) });
    return;
  }
  entry.recorder = rec;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onerror = (e) => {
    const err = (e && e.error) || {};
    chrome.runtime.sendMessage({ type: 'stt-error', source: kind, fatal: false, reason: String(err.message || err.name || 'recorder error') });
  };
  rec.onstop = () => {
    const blob = new Blob(parts, { type: mime || 'audio/webm' });
    // Restart on a fresh tick (not synchronously inside onstop) so the previous recorder fully releases the
    // stream before we start the next one — starting it synchronously throws NotSupportedError.
    if (entry.active) setTimeout(() => loop(kind), 0);
    if (blob.size > MIN_BYTES) transcribeChunk(kind, blob); // fire-and-forget; runs in parallel with recording
  };
  // Start after handlers are attached (so onerror catches start failures too), guarded so a throw
  // becomes a reported stt-error instead of an uncaught rejection.
  try { rec.start(); }
  catch (e) {
    entry.active = false;
    chrome.runtime.sendMessage({ type: 'stt-error', source: kind, fatal: !anyActive(), reason: String((e && e.message) || e) });
    return;
  }
  // Reference THIS recorder (not entry.recorder, which the next loop reassigns).
  setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {} }, CHUNK_MS);
}

function stopSource(kind) {
  const entry = sources.get(kind);
  if (!entry) return;
  entry.active = false;
  try { if (entry.recorder && entry.recorder.state !== 'inactive') entry.recorder.stop(); } catch (_) {}
  try { entry.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { if (entry.audioCtx) entry.audioCtx.close(); } catch (_) {}
  sources.delete(kind);
}

function stopAll() {
  for (const kind of Array.from(sources.keys())) stopSource(kind);
  chrome.runtime.sendMessage({ type: 'stt-status', on: false });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'offscreen-start') startSource(m.source === 'mic' ? 'mic' : 'tab', m.streamId, m);
  else if (m.type === 'offscreen-stop') { if (m.source) stopSource(m.source); else stopAll(); }
});
