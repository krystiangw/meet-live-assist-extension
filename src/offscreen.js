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
  active = true;
  chrome.runtime.sendMessage({ type: 'stt-status', on: true });
  loop();
}

function loop() {
  if (!active || !stream) return;
  const parts = [];
  recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(parts, { type: 'audio/webm' });
    if (blob.size > MIN_BYTES) {
      try {
        const url = `${cfg.serverUrl}/stt?session=${encodeURIComponent(cfg.session)}&lang=${encodeURIComponent(cfg.lang || 'auto')}`;
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
        if (r.ok) { const { text } = await r.json(); if (text) chrome.runtime.sendMessage({ type: 'stt-line', text }); }
      } catch (_) { /* server down */ }
    }
    if (active) loop();
  };
  recorder.start();
  setTimeout(() => { try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {} }, CHUNK_MS);
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
