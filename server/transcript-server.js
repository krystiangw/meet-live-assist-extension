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
const crypto = require('crypto');
const { execFile } = require('child_process');

// ffmpeg lives in Homebrew; launchd's PATH doesn't include it, so use an absolute path.
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

// Local speech-to-text (whisper.cpp) — fully offline, no subscription.
const WHISPER_CLI = process.env.WHISPER_CLI || '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || `${os.homedir()}/.local/share/whisper/ggml-base.bin`;
// whisper emits these for silence/music — drop them.
const STT_NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|>>|\.|…)?\s*$/;

// Transcribe one audio chunk (any ffmpeg-decodable format) → text. lang: 'en'|'pl'|'auto'.
function transcribe(inputFile, lang, done) {
  const wav = `${inputFile}.16k.wav`;
  execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', inputFile, '-ar', '16000', '-ac', '1', '-y', wav], (e1) => {
    if (e1) { fs.unlink(inputFile, () => {}); return done(e1); }
    execFile(WHISPER_CLI, ['-m', WHISPER_MODEL, '-f', wav, '-l', lang || 'auto', '-nt', '-np', '-t', '4'],
      { maxBuffer: 4 * 1024 * 1024 }, (e2, stdout) => {
        fs.unlink(inputFile, () => {}); fs.unlink(wav, () => {});
        if (e2) return done(e2);
        const text = String(stdout || '').split('\n').map((l) => l.trim())
          .filter((l) => l && !STT_NOISE.test(l)).join(' ').trim();
        done(null, text);
      });
  });
}

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

// Cached BlackHole presence for /health (device listing spawns ffmpeg — cache to avoid a DoS via /health).
let healthDevCache = { at: 0, blackhole: false };
function checkBlackhole(done) {
  if (Date.now() - healthDevCache.at < 60000) return done(healthDevCache.blackhole);
  resolveDeviceIndex('BlackHole', (err, idx) => {
    healthDevCache = { at: Date.now(), blackhole: !err && idx != null };
    done(healthDevCache.blackhole);
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

// Shared secret. Without it any website you visit could POST /speak, /edit or read /dom & /debug
// (DOM + localStorage/cookies/network of the shared tab) on this localhost server. Every route but
// /health requires the token in an `X-MLA-Token` header. Paste it into the extension options once;
// the brain (skill) reads it from this file.
const TOKEN_FILE = path.join(TRANSCRIPTS_DIR, '.mla-token');
let TOKEN = '';
try {
  if (fs.existsSync(TOKEN_FILE)) TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!TOKEN) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); }
} catch (_) { if (!TOKEN) TOKEN = crypto.randomBytes(24).toString('hex'); }

// Meet tab snapshots (Phase 1 visual context): <TRANSCRIPTS_DIR>/snapshots/<session>/<ts>.jpg
const SNAP_DIR = path.join(TRANSCRIPTS_DIR, 'snapshots');
const SNAP_MAX = 40; // keep only the most recent per session

// Retention: meeting text + screenshots are PII — purge anything older than this (0 = keep forever).
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '14', 10);
function purgeOld() {
  if (!(RETENTION_DAYS > 0)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  try {
    for (const f of fs.readdirSync(TRANSCRIPTS_DIR)) {
      if (f.startsWith('.')) continue; // never touch .mla-token etc.
      if (!/\.(txt|md)$/.test(f)) continue; // .txt / .chat.txt / .mode.txt / .summary.md only
      const p = path.join(TRANSCRIPTS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
    }
    if (fs.existsSync(SNAP_DIR)) for (const d of fs.readdirSync(SNAP_DIR)) {
      const dp = path.join(SNAP_DIR, d);
      try { if (fs.statSync(dp).mtimeMs < cutoff) fs.rmSync(dp, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

const seenSessions = new Set();

// Advice channel (Phase 1): the "brain" POSTs advice here; the side panel polls it.
// In-memory only — advice is ephemeral live guidance, not a record.
const advice = new Map(); // session -> { seq, items: [{ seq, ts, marker, text }] }
const ADVICE_MAX = 200;
const MARKERS = new Set(['SAY', 'INFO', 'SUMMARY', 'EXPLAIN', 'RISK', 'ACTION']);

// Agent-requested snapshots: the brain bumps a seq; the side panel polls it and triggers a capture.
const snapReq = new Map(); // session -> seq

// Two-way chat: panel <-> brain. User messages are also appended to <session>.chat.txt so the
// brain (Claude Code session) can tail them and reply via POST /chat {role:"agent"}.
const chat = new Map(); // session -> { seq, items: [{ seq, ts, role, text, image }] }
const CHAT_MAX = 300;
function chatFileFor(session) { return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.chat.txt`); }

// Presentation-only live DOM edits: brain enqueues an edit; panel polls and applies it to the shared tab.
const edits = new Map();  // session -> { seq, items: [cmd] }
const domReq = new Map(); // session -> seq (brain asks the extension to capture the page DOM)
const doms = new Map();   // session -> html (captured DOM for the brain to inspect)

// Live debugging: brain asks for a kind (storage/network/console); extension gathers and posts it back.
const dbgReq = new Map();  // session -> { seq, kind }
const dbgData = new Map(); // session -> { kind, data }

// Brain liveness: the brain (Claude session running the skill) heartbeats here each loop;
// the panel polls it to show whether an assistant is actually attached to this meeting.
const brainPing = new Map(); // session -> last heartbeat ms
const brainStatus = new Map(); // session -> { text, ts } current agent activity ("creating Jira ticket…"); '' = idle
const control = new Map(); // session -> 'running' | 'paused' | 'stopped' — panel drives it; the brain obeys

// Live decisions + action items captured by the brain during the call (the board; source for Jira drafts).
const items = new Map(); // session -> { seq, list: [{ seq, ts, kind, text, owner, blockedBy }] }
const ITEMS_MAX = 200;
const ITEM_KINDS = new Set(['decision', 'action']);

// Autopilot: whether the brain may auto-create action items and post links to the call chat (user opt-in).
const autopilot = new Map(); // session -> { create, postChat }
// Brain -> panel -> content script: messages to type into the meeting chat (gated by autopilot.postChat).
const callChat = new Map(); // session -> { seq, items: [{ seq, text }] }
// Content script -> panel -> server: delivery ACK for a /callchat message (did it actually land in Meet?).
const callChatResult = new Map(); // session -> { seq, items: [{ seq, ok, reason }] }
// Handoff between assistants: the latest brain to claim a meeting. A previous assistant sees a newer
// agent here and yields, so takeover is automatic instead of a manual clad-task.
const takeover = new Map(); // session -> { agent, ts }

// Agent-driven page actions (flow testing / debugging in the user's real tab). Gated by `drive` (panel
// opt-in). Brain enqueues to /act, the extension executes on the app tab and posts the outcome to /act-result.
const drive = new Map();       // session -> bool (is the user letting the agent control the tab?)
const acts = new Map();        // session -> { seq, items: [cmd] }
const actResults = new Map();  // session -> { seq, items: [{ seq, ok, value, error }] }
const ACT_OPS = new Set(['click', 'type', 'press', 'navigate', 'waitFor', 'getText', 'exists', 'select', 'scroll']);

// Suppressions: the user dismissed an advice/action and asked for "no more like this". The brain reads
// these each turn and skips advice/actions on a suppressed topic.
const suppress = new Map(); // session -> [{ text, kind, ts }]
const SUPPRESS_TTL_MS = 8 * 3600 * 1000; // drop dismissals older than 8h (defensive against stale bleed)

// Post-call artifact: the brain writes a summary + action items at wrap-up; the panel offers copy/download.
const summaries = new Map(); // session -> markdown
function summaryFileFor(session) { return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.summary.md`); }

// Meeting mode — steers how the brain advises. Panel sets it; brain reads it each turn.
const modes = new Map(); // session -> mode
const MODES = new Set(['auto', 'listener', 'lead', 'explain', 'produce']);
function modeFileFor(session) { return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.mode.txt`); }

// Only allow safe, contained filenames (no path traversal).
function safeSession(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  // Reject pure-dot names ('.', '..'): joined with a dir they'd escape it (e.g. /clear on '..' would
  // recursively delete the whole transcripts dir). Any other name stays inside TRANSCRIPTS_DIR.
  if (!cleaned || /^\.+$/.test(cleaned)) return `meeting_${Date.now()}`;
  return cleaned;
}

function fileFor(session) {
  return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.txt`);
}

// Rough, volume-based estimate of tokens the brain has processed this call: transcript + chat bytes ÷ 4.
// NOT billing — it counts raw volume once, so it undercounts per-turn context re-reads (the panel labels it "est.").
function estTokensFor(session) {
  let bytes = 0;
  for (const f of [fileFor(session), chatFileFor(session)]) {
    try { bytes += fs.statSync(f).size; } catch (_) { /* not created yet */ }
  }
  return Math.round(bytes / 4);
}

function cors(req, res) {
  // Reflect only the extension's own origin — never a web page's. A malicious site's cross-origin
  // request then fails its preflight (custom X-MLA-Token header forces one) and is never sent.
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MLA-Token');
  // Chrome Private Network Access: extension -> 127.0.0.1 preflight is blocked without this.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

const server = http.createServer((req, res) => {
  cors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && req.url === '/health') {
    const tools = { ffmpeg: fs.existsSync(FFMPEG), whisper: fs.existsSync(WHISPER_CLI), whisperModel: fs.existsSync(WHISPER_MODEL) };
    checkBlackhole((blackhole) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dir: TRANSCRIPTS_DIR, tools: { ...tools, blackhole } }));
    });
    return;
  }

  // Everything past here requires the shared token (see TOKEN_FILE above).
  if ((req.headers['x-mla-token'] || '') !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }

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

  // Extension -> server: transcribe a tab-audio chunk locally (whisper.cpp) and append to the transcript.
  if (req.method === 'POST' && req.url.startsWith('/stt')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const lang = (u.searchParams.get('lang') || 'auto').slice(0, 5);
    const src = u.searchParams.get('src') === 'mic' ? 'mic' : 'tab';
    const chunks = []; let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 25e6) req.destroy(); });
    req.on('end', () => {
      if (!size) { res.writeHead(400); return res.end('empty'); }
      const tmp = path.join(os.tmpdir(), `mla-stt-${Date.now()}.webm`);
      try { fs.writeFileSync(tmp, Buffer.concat(chunks)); } catch (_) { res.writeHead(500); return res.end('write'); }
      transcribe(tmp, lang, (err, text) => {
        if (err) { res.writeHead(500); return res.end('stt failed'); }
        if (text) {
          const d = new Date();
          const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
          try {
            const file = fileFor(session);
            if (!seenSessions.has(session)) {
              seenSessions.add(session);
              fs.appendFileSync(file, `==== ${session} — started ${new Date().toISOString()} ====\n`);
            }
            // Mic STT is the user (co-pilot) → 'You' (authorizes actions). tabCapture STT is remote
            // participants with no labels → mark unattributed so the brain never auto-authorizes from it.
            const who = src === 'mic' ? 'You' : '(unattributed)';
            fs.appendFileSync(file, `[${hms}] ${who}: ${text}\n`);
          } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: text || '' }));
      });
    });
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

  // Brain -> server: enqueue a presentation DOM edit; panel polls and applies it to the shared tab.
  if (req.method === 'POST' && req.url === '/edit') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      if (!data.op) { res.writeHead(400); return res.end('no op'); }
      let e = edits.get(session);
      if (!e) { e = { seq: 0, items: [] }; edits.set(session, e); }
      e.seq++;
      const cmd = { seq: e.seq, op: String(data.op), find: data.find, replace: data.replace, text: data.text, selector: data.selector, value: data.value, css: data.css };
      e.items.push(cmd);
      if (e.items.length > 100) e.items.splice(0, e.items.length - 100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq: e.seq }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/edit')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const e = edits.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: e.items.filter((i) => i.seq > since), last: e.seq }));
    return;
  }

  // DOM capture: brain requests it, extension posts it, brain reads it (to target selector-based edits).
  if (req.method === 'POST' && req.url === '/dom-request') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const session = safeSession(d.session);
      domReq.set(session, (domReq.get(session) || 0) + 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq: domReq.get(session) }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/dom-request')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ seq: domReq.get(safeSession(u.searchParams.get('session'))) || 0 }));
    return;
  }
  if (req.method === 'POST' && req.url === '/dom') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      doms.set(safeSession(d.session), String(d.html || ''));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/dom')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(doms.get(safeSession(u.searchParams.get('session'))) || '');
    return;
  }

  // Brain -> server: ask the extension for debug data of a given kind.
  if (req.method === 'POST' && req.url === '/debug-request') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const session = safeSession(d.session);
      const prev = dbgReq.get(session) || { seq: 0 };
      dbgReq.set(session, { seq: prev.seq + 1, kind: String(d.kind || 'storage') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dbgReq.get(session)));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/debug-request')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dbgReq.get(safeSession(u.searchParams.get('session'))) || { seq: 0, kind: null }));
    return;
  }
  if (req.method === 'POST' && req.url === '/debug') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      dbgData.set(safeSession(d.session), { kind: d.kind, data: d.data });
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/debug')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dbgData.get(safeSession(u.searchParams.get('session'))) || { kind: null, data: null }));
    return;
  }

  // Brain -> server: liveness heartbeat (call each monitoring-loop turn). Panel <- server: read age.
  if (req.method === 'POST' && req.url === '/brain-ping') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const s = safeSession(d.session);
      brainPing.set(s, Date.now());
      // Optional: current activity to surface in the panel. Sent each turn; '' clears it.
      if (d.status !== undefined) brainStatus.set(s, { text: String(d.status || '').slice(0, 120), ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/brain-ping')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ts = brainPing.get(safeSession(u.searchParams.get('session'))) || 0;
    const st = brainStatus.get(safeSession(u.searchParams.get('session')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ts, ageMs: ts ? Date.now() - ts : null,
      status: st ? st.text : '', statusAgeMs: st ? Date.now() - st.ts : null,
      estTokens: estTokensFor(u.searchParams.get('session')),
    }));
    return;
  }

  // Brain -> server: claim a meeting ("I'm taking this session now"). Other assistants GET this and, on
  // seeing a NEWER agent than themselves, yield — automatic handoff instead of a manual clad-task.
  if (req.method === 'POST' && req.url === '/brain-takeover') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const agent = String(d.agent || '').slice(0, 80);
      if (!agent) { res.writeHead(400); return res.end('agent required'); }
      takeover.set(safeSession(d.session), { agent, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/brain-takeover')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const t = takeover.get(safeSession(u.searchParams.get('session')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent: t ? t.agent : null, ageMs: t ? Date.now() - t.ts : null }));
    return;
  }

  // Panel -> server: session control the brain obeys. paused = stay silent (panel also stops capture);
  // stopped = do the wrap-up and TaskStop. Panel sets it; the brain GETs it each loop.
  if (req.method === 'POST' && req.url === '/control') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const state = ['running', 'paused', 'stopped'].includes(d.state) ? d.state : null;
      if (!state) { res.writeHead(400); return res.end('bad state'); }
      control.set(safeSession(d.session), state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/control')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: control.get(safeSession(u.searchParams.get('session'))) || 'running' }));
    return;
  }

  // Panel -> server: wipe everything for one meeting (transcript, chat, mode, snapshots, in-memory).
  if (req.method === 'POST' && req.url === '/clear') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const s = safeSession(d.session);
      for (const suf of ['.txt', '.chat.txt', '.mode.txt', '.summary.md']) { try { fs.unlinkSync(path.join(TRANSCRIPTS_DIR, s + suf)); } catch (_) {} }
      try { fs.rmSync(path.join(SNAP_DIR, s), { recursive: true, force: true }); } catch (_) {}
      for (const m of [advice, chat, items, modes, edits, domReq, doms, dbgReq, dbgData, snapReq, brainPing, brainStatus, control, summaries, autopilot, callChat, callChatResult, takeover, drive, acts, actResults, suppress]) m.delete(s);
      seenSessions.delete(s);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Brain -> server: save the post-call summary. Panel <- server: fetch it for copy/download.
  if (req.method === 'POST' && req.url === '/summary') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const s = safeSession(d.session);
      const text = typeof d.text === 'string' ? d.text : '';
      if (!text.trim()) { res.writeHead(400); return res.end('empty'); }
      summaries.set(s, text);
      try { fs.writeFileSync(summaryFileFor(s), text); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/summary')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    let text = summaries.get(s);
    if (text == null) { try { text = fs.readFileSync(summaryFileFor(s), 'utf8'); } catch (_) { text = ''; } }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: text || '' }));
    return;
  }

  // Autopilot flags: panel sets them; brain reads them each turn to decide auto-create / post-to-chat.
  if (req.method === 'POST' && req.url === '/autopilot') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      autopilot.set(safeSession(d.session), { create: !!d.create, postChat: !!d.postChat });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(autopilot.get(safeSession(d.session))));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/autopilot')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(autopilot.get(safeSession(u.searchParams.get('session'))) || { create: false, postChat: false }));
    return;
  }

  // Drive flag: panel opt-in for the agent to control the tab. Panel sets; brain reads before acting.
  if (req.method === 'POST' && req.url === '/drive') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      drive.set(safeSession(d.session), !!d.on);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ on: drive.get(safeSession(d.session)) }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/drive')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ on: !!drive.get(safeSession(u.searchParams.get('session'))) }));
    return;
  }

  // Brain -> server: enqueue a page action. Panel polls + relays to the app tab (only while drive is on).
  if (req.method === 'POST' && req.url === '/act') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(d.session);
      if (!ACT_OPS.has(d.op)) { res.writeHead(400); return res.end('bad op'); }
      let a = acts.get(session);
      if (!a) { a = { seq: 0, items: [] }; acts.set(session, a); }
      a.seq++;
      const cmd = { seq: a.seq, op: d.op, selector: d.selector, text: d.text, value: d.value, key: d.key, url: d.url, timeout: d.timeout };
      a.items.push(cmd);
      if (a.items.length > 100) a.items.splice(0, a.items.length - 100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq: a.seq }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/act-result')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const r = actResults.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: r.items.filter((i) => i.seq > since), last: r.seq }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/act')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const a = acts.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: a.items.filter((i) => i.seq > since), last: a.seq }));
    return;
  }
  // Extension -> server: the outcome of an action (brain polls this).
  if (req.method === 'POST' && req.url === '/act-result') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const session = safeSession(d.session);
      let r = actResults.get(session);
      if (!r) { r = { seq: 0, items: [] }; actResults.set(session, r); }
      r.seq = Math.max(r.seq, d.seq || 0);
      r.items.push({ seq: d.seq || r.seq, ok: !!d.ok, value: d.value, error: d.error });
      if (r.items.length > 100) r.items.splice(0, r.items.length - 100);
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  // Panel -> server: import pre-join context (e.g. a Gemini / Zoom-AI "summarize so far") into the
  // transcript so the brain has what happened before capture started.
  if (req.method === 'POST' && req.url === '/context') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(d.session);
      const text = typeof d.text === 'string' ? d.text.trim() : '';
      if (!text) { res.writeHead(400); return res.end('empty'); }
      const dt = new Date();
      const hms = [dt.getHours(), dt.getMinutes(), dt.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      try {
        const file = fileFor(session);
        if (!seenSessions.has(session)) { seenSessions.add(session); fs.appendFileSync(file, `==== ${session} — started ${new Date().toISOString()} ====\n`); }
        fs.appendFileSync(file, `\n[${hms}] ===== PRE-JOIN CONTEXT (imported) =====\n${text}\n=================================================\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, chars: text.length }));
      } catch (e) { res.writeHead(500); res.end('write failed'); }
    });
    return;
  }

  // Brain -> server: enqueue a message to send into the meeting chat. Panel polls + relays to the tab.
  if (req.method === 'POST' && req.url === '/callchat') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const session = safeSession(d.session);
      const text = typeof d.text === 'string' ? d.text.trim() : '';
      if (!text) { res.writeHead(400); return res.end('empty'); }
      let cc = callChat.get(session);
      if (!cc) { cc = { seq: 0, items: [] }; callChat.set(session, cc); }
      cc.seq++; cc.items.push({ seq: cc.seq, text });
      if (cc.items.length > 50) cc.items.splice(0, cc.items.length - 50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq: cc.seq }));
    });
    return;
  }
  // Extension -> server: did a /callchat message actually land in Meet? (delivery ACK, so the brain isn't
  // posting into the void). MUST be matched before GET /callchat (startsWith).
  if (req.method === 'POST' && req.url === '/callchat-result') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const session = safeSession(d.session);
      let cr = callChatResult.get(session);
      if (!cr) { cr = { seq: 0, items: [] }; callChatResult.set(session, cr); }
      cr.seq++;
      cr.items.push({ seq: Number(d.seq) || cr.seq, ok: !!d.ok, reason: typeof d.reason === 'string' ? d.reason.slice(0, 200) : '' });
      if (cr.items.length > 50) cr.items.splice(0, cr.items.length - 50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/callchat-result')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const cr = callChatResult.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: cr.items.filter((i) => i.seq > since), last: cr.seq }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/callchat')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const cc = callChat.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: cc.items.filter((i) => i.seq > since), last: cc.seq }));
    return;
  }

  // Panel -> server: suppress a topic ("don't suggest similar"). Brain <- server: read + honour it.
  if (req.method === 'POST' && req.url === '/suppress') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const session = safeSession(d.session);
      const text = typeof d.text === 'string' ? d.text.trim().slice(0, 500) : '';
      if (!text) { res.writeHead(400); return res.end('empty'); }
      const list = suppress.get(session) || [];
      list.push({ text, kind: d.kind === 'action' ? 'action' : d.kind === 'advice' ? 'advice' : 'any', ts: Date.now() });
      if (list.length > 100) list.splice(0, list.length - 100);
      suppress.set(session, list);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: list.length }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/suppress')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    // TTL so stale dismissals never bleed into a later meeting (defensive; entries are already per-session).
    const list = (suppress.get(safeSession(u.searchParams.get('session'))) || []).filter((e) => !e.ts || Date.now() - e.ts < SUPPRESS_TTL_MS);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: list.map(({ text, kind }) => ({ text, kind })) }));
    return;
  }

  // Brain -> server: capture a decision or action item. Panel <- server: poll the board.
  if (req.method === 'POST' && req.url === '/items') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(d.session);
      const text = typeof d.text === 'string' ? d.text.trim() : '';
      if (!text) { res.writeHead(400); return res.end('empty'); }
      const kind = ITEM_KINDS.has(d.kind) ? d.kind : 'action';
      let it = items.get(session);
      if (!it) { it = { seq: 0, list: [] }; items.set(session, it); }
      it.seq++;
      const item = { seq: it.seq, ts: new Date().toISOString(), kind, text,
        owner: String(d.owner || '').slice(0, 80), blockedBy: String(d.blockedBy || '').slice(0, 120) };
      it.list.push(item);
      if (it.list.length > ITEMS_MAX) it.list.splice(0, it.list.length - ITEMS_MAX);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/items')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const it = items.get(session) || { seq: 0, list: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: it.list.filter((i) => i.seq > since), last: it.seq }));
    return;
  }

  // Meeting mode: panel sets it; brain reads it (also written to <session>.mode.txt for a cheap cat).
  if (req.method === 'POST' && req.url === '/mode') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      const mode = MODES.has(data.mode) ? data.mode : 'auto';
      modes.set(session, mode);
      try { fs.writeFileSync(modeFileFor(session), mode); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/mode')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: modes.get(session) || 'auto' }));
    return;
  }

  // Chat write: panel posts role="user", brain posts role="agent".
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      const session = safeSession(data.session);
      const role = data.role === 'agent' ? 'agent' : 'user';
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const image = typeof data.image === 'string' && /^(https?:|data:image\/)/.test(data.image) ? data.image : null;
      if (!text && !image) { res.writeHead(400); return res.end('empty'); }
      let c = chat.get(session);
      if (!c) { c = { seq: 0, items: [] }; chat.set(session, c); }
      c.seq++;
      const item = { seq: c.seq, ts: new Date().toISOString(), role, text, image };
      c.items.push(item);
      if (c.items.length > CHAT_MAX) c.items.splice(0, c.items.length - CHAT_MAX);
      // Only user messages go to the tailable file (the brain reads those and replies).
      if (role === 'user' && text) {
        try { fs.appendFileSync(chatFileFor(session), `[${item.ts}] ${text}\n`); } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
    });
    return;
  }

  // Chat read (panel polls).
  if (req.method === 'GET' && req.url.startsWith('/chat')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const session = safeSession(u.searchParams.get('session'));
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const c = chat.get(session) || { seq: 0, items: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: c.items.filter((i) => i.seq > since), last: c.seq }));
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
  console.log(`[transcript] auth token in ${TOKEN_FILE} — paste it into the extension options (cat the file).`);
  console.log(`[transcript] retention: ${RETENTION_DAYS > 0 ? RETENTION_DAYS + ' days' : 'forever'}`);
  purgeOld();
  setInterval(purgeOld, 6 * 3600 * 1000); // re-check a few times a day
});
