// Offscreen document — the only place that can consume a tabCapture MediaStream in MV3.
// Records the Meet tab audio in ~6s complete WebM chunks and POSTs each to the local server's
// /stt (whisper.cpp). Each chunk is a full file (start/stop per chunk) so it decodes standalone.

let stream = null;
let recorder = null;
let audioCtx = null;
let active = false;
let cfg = null;

const CHUNK_MS = 6000;
const MIN_BYTES = 4000; // skip near-silent tiny blobs

// Pick a container the tab-capture stream can actually record; 'audio/webm' alone can be rejected
// (NotSupportedError on start) depending on the Chrome build. '' = let the browser choose.
function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
  }
  return '';
}
let mime = '';

async function start(streamId, config) {
  if (active) return;
  cfg = config;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'stt-error', reason: String(e && e.message || e) });
    return;
  }
  // tabCapture mutes the tab locally — re-route to speakers so the user still hears the call.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  mime = pickMime();
  active = true;
  chrome.runtime.sendMessage({ type: 'stt-status', on: true });
  loop();
}

async function transcribeChunk(blob) {
  try {
    const url = `${cfg.serverUrl}/stt?session=${encodeURIComponent(cfg.session)}&lang=${encodeURIComponent(cfg.lang || 'auto')}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-MLA-Token': cfg.token || '' }, body: blob });
    if (r.ok) { const { text } = await r.json(); if (text) chrome.runtime.sendMessage({ type: 'stt-line', text }); }
  } catch (_) { /* server down */ }
}

function loop() {
  if (!active || !stream) return;
  const parts = [];
  let rec;
  try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { active = false; chrome.runtime.sendMessage({ type: 'stt-error', reason: String(e && e.message || e) }); return; }
  recorder = rec;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onerror = (e) => { const err = (e && e.error) || {}; chrome.runtime.sendMessage({ type: 'stt-error', reason: String(err.message || err.name || 'recorder error') }); };
  rec.onstop = () => {
    const blob = new Blob(parts, { type: mime || 'audio/webm' });
    // Restart on a fresh tick (not synchronously inside onstop) so the previous recorder fully releases the
    // tab stream before we start the next one — starting it synchronously throws NotSupportedError.
    if (active) setTimeout(loop, 0);
    if (blob.size > MIN_BYTES) transcribeChunk(blob); // fire-and-forget; runs in parallel with recording
  };
  // Start after handlers are attached (so onerror catches start failures too), guarded so a throw
  // becomes a reported stt-error instead of an uncaught rejection.
  try { rec.start(); }
  catch (e) { active = false; chrome.runtime.sendMessage({ type: 'stt-error', reason: String(e && e.message || e) }); return; }
  // Reference THIS recorder (not the shared module var, which the next loop reassigns).
  setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {} }, CHUNK_MS);
}

function stop() {
  active = false;
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { if (audioCtx) audioCtx.close(); } catch (_) {}
  stream = null; recorder = null; audioCtx = null;
  chrome.runtime.sendMessage({ type: 'stt-status', on: false });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'offscreen-start') start(m.streamId, m);
  else if (m.type === 'offscreen-stop') stop();
});
