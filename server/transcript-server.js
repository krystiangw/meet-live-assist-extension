#!/usr/bin/env node
/*
 * Tiny local transcript sink for the Meet captions userscript.
 *
 * The userscript POSTs each finalized caption line here; this server appends it to
 *   <TRANSCRIPTS_DIR>/<session>.txt
 * so it's a real, tailable local file — fully automatic, no file picker, no clicks.
 *
 * Zero dependencies. Run with:  node transcript-server.js
 * (or install the launchd autostart — see README.)
 *
 * Config via env:
 *   TRANSCRIPTS_DIR   where to write (default: ../transcripts next to this script = <meet-live-assist>/transcripts)
 *   PORT              default 8848
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ffmpeg lives in Homebrew; launchd's PATH doesn't include it, so use an absolute path.
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

// TTS (Phase 2a): synthesize with macOS `say` (Polish voice) and play locally.
// device === null -> default output (you hear it); a CoreAudio device name -> routed there (into Meet, 2b).
const TTS_VOICE = process.env.TTS_VOICE || 'Zosia';

// CoreAudio output-device indices are NOT stable across device changes — resolve by name substring.
const deviceIndexCache = new Map();
function resolveDeviceIndex(nameSub, done) {
  const key = nameSub.toLowerCase();
  if (deviceIndexCache.has(key)) return done(null, deviceIndexCache.get(key));
  execFile(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '0.05', '-f', 'audiotoolbox', '-list_devices', 'true', '-y', '/dev/null'], (err, stdout, stderr) => {
    const out = String(stderr || '') + String(stdout || '');
    const re = /\[(\d+)\]\s+(.+?),/g;
    let m, idx = null;
    while ((m = re.exec(out))) { if (m[2].toLowerCase().includes(key)) { idx = parseInt(m[1], 10); break; } }
    if (idx == null) return done(new Error('audio device not found: ' + nameSub));
    deviceIndexCache.set(key, idx);
    done(null, idx);
  });
}

function playFile(tmp, deviceIndex, done) {
  const finish = (e) => { fs.unlink(tmp, () => {}); done(e || null); };
  if (deviceIndex != null) {
    // Play to a specific device without changing the system default (into Meet via BlackHole).
    execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', tmp,
      '-f', 'audiotoolbox', '-audio_device_index', String(deviceIndex), '-'], finish);
  } else {
    execFile('afplay', [tmp], finish); // default output — you hear it
  }
}

// TTS via macOS `say`. device: number (index) | name substring (e.g. "BlackHole") | null (default output).
function speak(text, device, voice, done) {
  const clean = String(text || '').slice(0, 600);
  if (!clean.trim()) return done(new Error('empty'));
  const v = (typeof voice === 'string' && voice.trim()) ? voice.trim() : TTS_VOICE;
  const tmp = path.join(os.tmpdir(), `mla-tts-${Date.now()}.aiff`);
  execFile('say', ['-v', v, '-o', tmp, clean], (err) => {
    if (err) return done(err);
    if (typeof device === 'number') return playFile(tmp, device, done);
    if (typeof device === 'string' && device.trim()) {
      return resolveDeviceIndex(device.trim(), (e, idx) => {
        if (e) { fs.unlink(tmp, () => {}); return done(e); }
        playFile(tmp, idx, done);
      });
    }
    playFile(tmp, null, done);
  });
}

const PORT = parseInt(process.env.PORT || '8848', 10);
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR
  ? path.resolve(process.env.TRANSCRIPTS_DIR)
  : path.resolve(__dirname, '..', 'transcripts');

fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Meet tab snapshots (Phase 1 visual context): <TRANSCRIPTS_DIR>/snapshots/<session>/<ts>.jpg
const SNAP_DIR = path.join(TRANSCRIPTS_DIR, 'snapshots');
const SNAP_MAX = 40; // keep only the most recent per session

const seenSessions = new Set();

// Advice channel (Phase 1): the "brain" POSTs advice here; the side panel polls it.
// In-memory only — advice is ephemeral live guidance, not a record.
const advice = new Map(); // session -> { seq, items: [{ seq, ts, marker, text }] }
const ADVICE_MAX = 200;
const MARKERS = new Set(['SAY', 'INFO', 'SUMMARY', 'EXPLAIN', 'RISK', 'ACTION']);

// Agent-requested snapshots: the brain bumps a seq; the side panel polls it and triggers a capture.
const snapReq = new Map(); // session -> seq

// Only allow safe, contained filenames (no path traversal).
function safeSession(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || `meeting_${Date.now()}`;
}

function fileFor(session) {
  return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.txt`);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome Private Network Access: extension SW -> 127.0.0.1 preflight is blocked without this.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, dir: TRANSCRIPTS_DIR }));
  }

  if (req.method === 'POST' && req.url === '/append') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      const line = typeof data.line === 'string' ? data.line : '';
      const file = fileFor(session);
      try {
        if (!seenSessions.has(session)) {
          seenSessions.add(session);
          fs.appendFileSync(file, `==== ${session} — started ${new Date().toISOString()} ====\n`);
          console.log(`[transcript] new session → ${file}`);
        }
        if (line) fs.appendFileSync(file, line);
        res.writeHead(204); res.end();
      } catch (e) {
        console.error('[transcript] write failed', e);
        res.writeHead(500); res.end('write failed');
      }
    });
    return;
  }

  // Brain -> server: push one piece of live advice.
  if (req.method === 'POST' && req.url === '/advice') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      const marker = String(data.marker || 'INFO').toUpperCase();
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const image = typeof data.image === 'string' && /^(https?:|data:image\/)/.test(data.image) ? data.image : null;
      if (!text && !image) { res.writeHead(400); return res.end('empty'); }
      let a = advice.get(session);
      if (!a) { a = { seq: 0, items: [] }; advice.set(session, a); }
      a.seq++;
      const item = { seq: a.seq, ts: new Date().toISOString(), marker: MARKERS.has(marker) ? marker : 'INFO', text, image };
      a.items.push(item);
      if (a.items.length > ADVICE_MAX) a.items.splice(0, a.items.length - ADVICE_MAX);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
    });
    return;
  }

  // Extension -> server: store a Meet-tab snapshot (base64 data URL) for visual context.
  if (req.method === 'POST' && req.url === '/snapshot') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      const m = /^data:image\/(jpeg|png);base64,(.+)$/s.exec(String(data.dataUrl || ''));
      if (!m) { res.writeHead(400); return res.end('bad dataUrl'); }
      const dir = path.join(SNAP_DIR, session);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${Date.now()}.${m[1] === 'png' ? 'png' : 'jpg'}`);
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        const shots = fs.readdirSync(dir).filter((f) => /\.(jpg|png)$/.test(f)).sort();
        for (const old of shots.slice(0, Math.max(0, shots.length - SNAP_MAX))) {
          try { fs.unlinkSync(path.join(dir, old)); } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ file, count: Math.min(shots.length, SNAP_MAX) }));
      } catch (e) {
        console.error('[snapshot] write failed', e);
        res.writeHead(500); res.end('write failed');
      }
    });
    return;
  }

  // Brain -> server: ask the extension to capture a snapshot now (agent-initiated).
  if (req.method === 'POST' && req.url === '/snapshot-request') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      const seq = (snapReq.get(session) || 0) + 1;
      snapReq.set(session, seq);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq }));
    });
    return;
  }

  // Side panel <- server: poll for a pending snapshot request.
  if (req.method === 'GET' && req.url.startsWith('/snapshot-request')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ seq: snapReq.get(session) || 0 }));
    return;
  }

  // Options page -> server: list installed `say` voices (for the voice picker).
  if (req.method === 'GET' && req.url === '/voices') {
    execFile('say', ['-v', '?'], (err, stdout) => {
      if (err) { res.writeHead(500); return res.end('[]'); }
      const voices = String(stdout).split('\n').map((l) => {
        const m = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(l);
        return m ? { name: m[1].trim(), locale: m[2] } : null;
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(voices));
    });
    return;
  }

  // Brain/panel -> server: speak text aloud (TTS). No device = default output (you hear it);
  // a CoreAudio device index = routed there (into Meet via BlackHole, Phase 2b).
  if (req.method === 'POST' && req.url === '/speak') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const device = data.device != null ? data.device : null;
      speak(data.text, device, data.voice, (err) => {
        if (err) { res.writeHead(err.message === 'empty' ? 400 : 500); return res.end(String(err.message || 'tts failed')); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // Side panel <- server: poll advice newer than `since`.
  if (req.method === 'GET' && req.url.startsWith('/advice')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const a = advice.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: a.items.filter((i) => i.seq > since), last: a.seq }));
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[transcript] listening on http://127.0.0.1:${PORT}`);
  console.log(`[transcript] writing to ${TRANSCRIPTS_DIR}`);
});
