#!/usr/bin/env node
/*
 * Tiny local transcript sink for the Meet captions userscript.
 *
 * The userscript POSTs each finalized caption line here; this server appends it to
 *   <TRANSCRIPTS_DIR>/<session>.txt
 * so it's a real, tailable local file - fully automatic, no file picker, no clicks.
 *
 * Zero dependencies. Run with:  node transcript-server.js
 * (or install the launchd autostart - see README.)
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
const { execFile, spawn } = require('child_process');
const { createStore } = require('./state-store');

const IS_MAC = process.platform === 'darwin';

// An absolute path, not a bare command name: launchd (and Windows services) start us with a PATH that has
// no Homebrew or /usr/local, so `ffmpeg` alone resolves under a shell and fails under the service manager.
// First existing candidate wins; falling through to the bare name keeps the error an honest ENOENT.
function resolveBin(envValue, name) {
  if (envValue) return envValue;
  const candidates = [
    `/opt/homebrew/bin/${name}`,  // macOS, Apple Silicon
    `/usr/local/bin/${name}`,     // macOS Intel, and many Linux installs
    `/usr/bin/${name}`,           // Linux distro packages
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return name;
}

const FFMPEG = resolveBin(process.env.FFMPEG, 'ffmpeg');

// Local speech-to-text (whisper.cpp) - fully offline, no subscription.
const WHISPER_CLI = resolveBin(process.env.WHISPER_CLI, 'whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL || `${os.homedir()}/.local/share/whisper/ggml-base.bin`;
// Biases whisper toward words it would otherwise mangle. Keep it to vocabulary common to any technical
// meeting: your own product names and ticket prefixes belong in WHISPER_PROMPT, not in a shipped default.
const WHISPER_PROMPT = process.env.WHISPER_PROMPT
  || 'code review, pull request, feature flag, backend, frontend, deploy, release, sprint, story points, staging, rollback, API, database, migration.';
// whisper emits these for silence/music - drop them.
const STT_NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|>>|[-–—*~.…\s]+)?\s*$/; // incl. whisper's *sniff*-style annotations

// Whisper does not return "nothing" for a chunk with no speech - it invents filler. On a quiet mic it
// produced "Thank you." and "... ... ... ..." on a live call, which would fill an interview transcript with
// phantom lines. Two nets: skip silent chunks before whisper runs at all (peak level), then drop the
// boilerplate it emits anyway. Thresholds are env-tunable because mic levels differ per machine.
const STT_MIN_PEAK_DB = parseFloat(process.env.STT_MIN_PEAK_DB || '-30');   // below this, treat as no speech
const STT_QUIET_PEAK_DB = parseFloat(process.env.STT_QUIET_PEAK_DB || '-18'); // "Okay."-class filler only here
// Boilerplate whisper hallucinates on silence, in every language it was trained on subtitles for.
const STT_HALLUCINATION_RE = /^(?:\.{2,}|…)+[\s.…]*$|amara\.org|subtitles? (?:by|created)|thanks? for watching|dzięku(?:ję|je) za (?:ogl[ąa]danie|uwag[ęe])|napisy (?:stworzone|utworzone)|transcription by|^to be continued[.…!\s]*$|^credits[.!\s]*$|продолжение следует|субтитр|dimatorzok/i;

// Wrong-script guard. Whisper answers low-confidence audio with boilerplate from its subtitle training data,
// and on a quiet Polish call that came out in Russian ("Смотрите", "Субтитры создавал DimaTorzok"). Chasing
// individual phrases is endless; if the session's language is pinned to a Latin-script one, a line that is
// mostly Cyrillic or CJK cannot be a transcription of it.
const LATIN_LANGS = new Set(['pl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'cs', 'sk', 'hu', 'ro', 'sv', 'da', 'no', 'fi', 'tr']);
function isWrongScript(text, lang) {
  if (!lang || !LATIN_LANGS.has(lang)) return false;
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (!letters) return false;
  const foreign = (text.match(/[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  return foreign / letters > 0.3;
}
// Short generic phrases that are real speech sometimes - dropped only when the audio was near-silent.
// The thank-yous span languages because whisper falls back to whatever language it guessed for the silence:
// a quiet Polish call produced "Thank you." and "Gracias.", and a quiet tab channel produced "Uh...".
// Always noise: hesitation sounds carry nothing, and a thank-you in a language nobody is speaking is a
// pure artifact (a Polish call produced "Gracias.").
const STT_FILLER_ALWAYS_RE = /^(mhm+|hmm+|mm+|uh+|um+|aha|thank you|thanks|bye|gracias|merci|danke|grazie|obrigad[oa]|спасибо|dziękuję|dzięki)[.!…]*$/i;
// Real speech at a normal level, so only dropped on quiet audio - "okay" after a proposal is a decision cue
// the board depends on, and throwing it away silently would lose agreements.
const STT_FILLER_QUIET_RE = /^(okay|ok|yeah|yes|no|okej|dobrze|tak|nie)[.!…]*$/i;

// whisper-cli reloads the 1.5GB model on EVERY chunk: measured 1.55s per 6s chunk of which most is the
// load (a 2s chunk costs the same), and ~2GB allocated 20×/minute with two channels running. whisper-server
// keeps the model resident → 1.0s per chunk and one steady 1.8GB process.
// Started lazily on the first chunk (so an idle machine holds no model) and reaped when STT goes quiet;
// while it warms up, and if it ever fails, chunks go through the CLI - STT must not depend on it.
const WHISPER_SERVER_BIN = resolveBin(process.env.WHISPER_SERVER, 'whisper-server');
const WHISPER_SERVER_PORT = parseInt(process.env.WHISPER_SERVER_PORT || '8859', 10);
const WHISPER_IDLE_MS = parseInt(process.env.WHISPER_IDLE_MS || '600000', 10); // free the model after 10 min idle
const ws = { proc: null, ready: false, failed: false, lastUse: 0 };

function whisperServerHealthy(done) {
  const req = http.request({ host: '127.0.0.1', port: WHISPER_SERVER_PORT, path: '/', method: 'GET', timeout: 800 },
    (res) => { res.resume(); done(true); });
  req.on('error', () => done(false));
  req.on('timeout', () => { req.destroy(); done(false); });
  req.end();
}

function ensureWhisperServer() {
  if (ws.proc || ws.failed) return;
  if (!fs.existsSync(WHISPER_SERVER_BIN) || !fs.existsSync(WHISPER_MODEL)) { ws.failed = true; return; }
  try {
    ws.proc = spawn(WHISPER_SERVER_BIN, ['-m', WHISPER_MODEL, '--port', String(WHISPER_SERVER_PORT), '-t', '4'],
      { stdio: 'ignore' });
  } catch (_) { ws.failed = true; return; }
  ws.proc.on('exit', () => { ws.proc = null; ws.ready = false; });
  console.log(`[stt] starting whisper-server on :${WHISPER_SERVER_PORT} (${path.basename(WHISPER_MODEL)})`);
  let tries = 0;
  const poll = setInterval(() => {
    if (!ws.proc) return clearInterval(poll);
    whisperServerHealthy((ok) => {
      if (ok) { ws.ready = true; clearInterval(poll); console.log('[stt] whisper-server ready'); }
      else if (++tries > 30) { clearInterval(poll); ws.failed = true; console.log('[stt] whisper-server did not come up - staying on the CLI'); }
    });
  }, 1000);
}

setInterval(() => {
  if (ws.proc && ws.lastUse && Date.now() - ws.lastUse > WHISPER_IDLE_MS) {
    console.log('[stt] whisper-server idle - stopping to free the model');
    try { ws.proc.kill(); } catch (_) {}
    ws.proc = null; ws.ready = false;
  }
}, 60000);

function whisperArgs(wav, lang) {
  const args = ['-m', WHISPER_MODEL, '-f', wav, '-l', lang || 'auto', '-nt', '-np', '-t', '4'];
  if (WHISPER_PROMPT) args.push('--prompt', WHISPER_PROMPT);
  return args;
}
// Join segments WITHOUT adding separators: whisper starts each segment with its own leading space, and it
// also splits mid-word ("Flag\nsmith" for Flagsmith), where an inserted space would corrupt the word.
const joinWhisper = (s) => String(s || '').split('\n')
  .filter((l) => !STT_NOISE.test(l)).join('').replace(/\s+/g, ' ').trim();

function whisperViaCli(wav, lang, done) {
  execFile(WHISPER_CLI, whisperArgs(wav, lang), { maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => (err ? done(err) : done(null, joinWhisper(stdout))));
}

// Whisper reports per-word probabilities, and they separate speech from invention cleanly. Measured:
// real speech 0.80-0.97, hallucinations on noise 0.41-0.44 - and quiet speech still scores 0.97, so this
// drops the filler without punishing someone talking softly. This is the primary defence; the phrase lists
// stay as a cheap backstop for the CLI path, which reports no confidence.
const STT_MIN_CONFIDENCE = parseFloat(process.env.STT_MIN_CONFIDENCE || '0.6');

function confidentSegments(json) {
  const segs = Array.isArray(json && json.segments) ? json.segments : [];
  const kept = [];
  for (const seg of segs) {
    // The same per-segment noise filter the CLI path applies while joining lines: whisper emits non-speech
    // annotations ("*sniff*", "[music]") as segments of their own, and they are not speech.
    if (STT_NOISE.test(String(seg.text || ''))) continue;
    const words = Array.isArray(seg.words) ? seg.words.filter((w) => typeof w.probability === 'number') : [];
    const conf = words.length
      ? words.reduce((a, w) => a + w.probability, 0) / words.length
      : (typeof seg.avg_logprob === 'number' ? (seg.avg_logprob > -0.6 ? 1 : 0) : 1);
    if (conf < STT_MIN_CONFIDENCE) {
      console.log(`[stt] dropped low-confidence segment (${conf.toFixed(2)}): ${String(seg.text || '').trim()}`);
      continue;
    }
    kept.push(seg.text || '');
  }
  return kept.join('').replace(/\s+/g, ' ').trim();
}

function whisperViaServer(wav, lang, done) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wav)]), path.basename(wav));
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  // Always send the language, 'auto' included, and pin translate=false: omitting the field made
  // whisper-server return an ENGLISH TRANSLATION of Polish speech instead of a Polish transcript.
  form.append('language', lang || 'auto');
  form.append('translate', 'false');
  if (WHISPER_PROMPT) form.append('prompt', WHISPER_PROMPT);
  fetch(`http://127.0.0.1:${WHISPER_SERVER_PORT}/inference`, { method: 'POST', body: form })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`whisper-server ${r.status}`))))
    .then((j) => done(null, confidentSegments(j)))
    .catch((e) => done(e));
}

function whisperText(wav, lang, done) {
  ws.lastUse = Date.now();
  ensureWhisperServer();
  if (!ws.ready) return whisperViaCli(wav, lang, done);
  whisperViaServer(wav, lang, (err, text) => {
    if (!err) return done(null, text);
    console.log(`[stt] whisper-server failed (${err.message}) - falling back to the CLI for this chunk`);
    ws.ready = false; // re-checked on the next chunk; a crashed server must not black-hole transcription
    whisperViaCli(wav, lang, done);
  });
}

// Peak level of a decoded wav, in dBFS (0 = full scale). null when ffmpeg gives us nothing to parse.
function peakDb(wav, done) {
  execFile(FFMPEG, ['-hide_banner', '-nostats', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'],
    { maxBuffer: 1 << 20 }, (err, _stdout, stderr) => {
      if (err) return done(null);
      const m = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(String(stderr || ''));
      done(m ? parseFloat(m[1]) : null);
    });
}

// Transcribe one audio chunk (any ffmpeg-decodable format) → text. lang: 'en'|'pl'|'auto'.
function transcribe(inputFile, lang, done) {
  const wav = `${inputFile}.16k.wav`;
  execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', inputFile, '-ar', '16000', '-ac', '1', '-y', wav], (e1) => {
    if (e1) { fs.unlink(inputFile, () => {}); return done(e1); }
    peakDb(wav, (peak) => {
      if (peak !== null && peak < STT_MIN_PEAK_DB) {
        fs.unlink(inputFile, () => {}); fs.unlink(wav, () => {});
        return done(null, ''); // no speech in this chunk - running whisper on it only invents filler
      }
      whisperText(wav, lang, (e2, text) => {
        fs.unlink(inputFile, () => {}); fs.unlink(wav, () => {});
        if (e2) return done(e2);
        if (!text) return done(null, '');
        // Whisper prefixes dialogue dashes ("- Yeah."), which made the filler patterns miss - they anchor
        // on the whole line.
        text = text.replace(/^[-–—>\s]+/, '');
        if (!text) return done(null, '');
        if (STT_HALLUCINATION_RE.test(text)) { console.log(`[stt] dropped boilerplate (${peak}dB): ${text}`); return done(null, ''); }
        if (isWrongScript(text, lang)) { console.log(`[stt] dropped wrong-script output (lang=${lang}, ${peak}dB): ${text}`); return done(null, ''); }
        if (STT_FILLER_ALWAYS_RE.test(text)) { console.log(`[stt] dropped hesitation (${peak}dB): ${text}`); return done(null, ''); }
        if (STT_FILLER_QUIET_RE.test(text) && peak !== null && peak < STT_QUIET_PEAK_DB) {
          console.log(`[stt] dropped filler on quiet audio (${peak}dB): ${text}`);
          return done(null, '');
        }
        done(null, text);
      });
    });
  });
}

// TTS (Phase 2a): synthesize with macOS `say` (Polish voice) and play locally.
// device === null -> default output (you hear it); a CoreAudio device name -> routed there (into Meet, 2b).
const TTS_VOICE = process.env.TTS_VOICE || 'Zosia';

// CoreAudio output-device indices are NOT stable across device changes - resolve by name substring.
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

// Cached BlackHole presence for /health (device listing spawns ffmpeg - cache to avoid a DoS via /health).
let healthDevCache = { at: 0, blackhole: false };
function checkBlackhole(done) {
  if (!IS_MAC) return done(false); // the listing goes through ffmpeg's audiotoolbox device, macOS-only
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
    execFile('afplay', [tmp], finish); // default output - you hear it
  }
}

// TTS via macOS `say`. device: number (index) | name substring (e.g. "BlackHole") | null (default output).
// Non-macOS gets a clear refusal rather than an ENOENT: everything else in the server is portable, so a
// Linux/Windows user should learn that only this one feature is missing, not that their install is broken.
const TTS_UNAVAILABLE = 'text-to-speech needs macOS (`say` + `afplay`); advice still shows in the panel';
function speak(text, device, voice, done) {
  if (!IS_MAC) return done(new Error(TTS_UNAVAILABLE));
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
// Where meeting text and screenshots land. Explicit env always wins. Otherwise: a `transcripts/` dir
// beside the checkout means we are running from the repo, so keep using it; anything else (an npm/npx
// install, where __dirname is inside the package cache) gets a real home directory, because writing
// recordings into a cache that npm may clear is both surprising and lossy.
function defaultTranscriptsDir() {
  const beside = path.resolve(__dirname, '..', 'transcripts');
  try { if (fs.existsSync(beside)) return beside; } catch (_) {}
  return path.join(os.homedir(), 'meet-live-assist', 'transcripts');
}
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR
  ? path.resolve(process.env.TRANSCRIPTS_DIR)
  : defaultTranscriptsDir();

fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Live session state (advice, board, chat, wake buffer, ...) lived in plain Maps, so restarting the
// server mid-call dropped the meeting's history. These are still Maps to every call site below; they
// just load from and snapshot to <TRANSCRIPTS_DIR>/.state/. See state-store.js for why the snapshot
// is periodic rather than write-through.
const store = createStore({ dir: TRANSCRIPTS_DIR, log: (m) => console.log(m) });

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

// Retention: meeting text + screenshots are PII - purge anything older than this (0 = keep forever).
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '14', 10);
function purgeOld() {
  if (!(RETENTION_DAYS > 0)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  try {
    const sessionOf = (f) => f.replace(/\.(chat\.txt|mode\.txt|summary\.md|txt|wake|wakeall)$/, '');
    const touched = new Set();
    for (const f of fs.readdirSync(TRANSCRIPTS_DIR)) {
      if (f.startsWith('.')) continue; // never touch .mla-token or .state/
      if (!/\.(txt|md|wake|wakeall)$/.test(f)) continue; // .txt / .chat.txt / .mode.txt / .summary.md / .wake / .wakeall only
      const p = path.join(TRANSCRIPTS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs >= cutoff) continue;
        fs.unlinkSync(p);
        touched.add(sessionOf(f));
      } catch (_) {}
    }
    // Purging a session's text has to purge its live state too, or the sweep leaves advice and board
    // items for a meeting whose transcript is gone. But only once NOTHING of the session is left:
    // a recurring series reuses its meet code, so one forgotten `.mode.txt` from January was enough to
    // wipe the advice and the board of the call happening right now. Verified, and it was a live bug.
    const survivors = new Set(fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => !f.startsWith('.')).map(sessionOf));
    for (const s of touched) if (!survivors.has(s)) store.forget(s);
    if (fs.existsSync(SNAP_DIR)) for (const d of fs.readdirSync(SNAP_DIR)) {
      const dp = path.join(SNAP_DIR, d);
      try { if (fs.statSync(dp).mtimeMs < cutoff) fs.rmSync(dp, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

// Live session state. `store.map`/`store.set` reload from disk at boot and snapshot back, so a restart
// no longer costs a meeting its history - EXCEPT where a store is declared `{ persist: false }`, which
// is not an optimisation but a correctness rule with two cases:
//   - consent and lifecycle (`drive`, `autopilot`, `control`, `takeover`, and the two liveness stores):
//     "yes, the agent may drive my tab" and "stopped" are answers about one meeting. A recurring series
//     reuses its meet code, so persisting them hands a Monday decision back on Thursday, and a Stop at
//     the end of one call would kill the next call's assistant on its first turn.
//   - request scratch (`doms`, `dbgData`, `edits`, `acts`, `actResults`, `sttRecent`): worthless once the
//     request that asked for it is answered, and the first two are page content and debugger dumps we
//     have no reason to leave on disk.
// Adding a store? Decide which of the three it is before deciding anything else.
const seenSessions = store.set('seenSessions');

// Advice channel (Phase 1): the "brain" POSTs advice here; the side panel polls it.
const advice = store.map('advice'); // session -> { seq, items: [{ seq, ts, marker, text }] }
const ADVICE_MAX = 200;
const MARKERS = new Set(['SAY', 'INFO', 'SUMMARY', 'EXPLAIN', 'RISK', 'ACTION']);

// Agent-requested snapshots: the brain bumps a seq; the side panel polls it and triggers a capture.
const snapReq = store.map('snapReq'); // session -> seq

// Two-way chat: panel <-> brain. User messages are also appended to <session>.chat.txt so the
// brain (Claude Code session) can tail them and reply via POST /chat {role:"agent"}.
const chat = store.map('chat'); // session -> { seq, items: [{ seq, ts, role, text, image }] }
const CHAT_MAX = 300;
function chatFileFor(session) { return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.chat.txt`); }

// Presentation-only live DOM edits: brain enqueues an edit; panel polls and applies it to the shared tab.
const edits = store.map('edits', { persist: false });  // session -> { seq, items: [cmd] }
const domReq = store.map('domReq'); // session -> seq (brain asks the extension to capture the page DOM)
const doms = store.map('doms', { persist: false });   // session -> html (captured DOM for the brain to inspect)

// Live debugging: brain asks for a kind (storage/network/console); extension gathers and posts it back.
const dbgReq = store.map('dbgReq');  // session -> { seq, kind }
const dbgData = store.map('dbgData', { persist: false }); // session -> { kind, data }

// Brain liveness: the brain (Claude session running the skill) heartbeats here each loop;
// the panel polls it to show whether an assistant is actually attached to this meeting.
const brainPing = store.map('brainPing', { persist: false }); // session -> last heartbeat ms
// Same 45s the panel and the service worker use to draw the 🧠 pill (sidepanel.js, background.js).
// Env-tunable only so a test can reach staleness without waiting it out.
const BRAIN_STALE_MS = parseInt(process.env.BRAIN_STALE_MS || '45000', 10);
const brainStatus = store.map('brainStatus', { persist: false }); // session -> { text, ts } current agent activity ("creating Jira ticket…"); '' = idle
const control = store.map('control', { persist: false }); // session -> 'running' | 'paused' | 'stopped' - panel drives it; the brain obeys

// Live decisions + action items captured by the brain during the call (the board; source for Jira drafts).
const items = store.map('items'); // session -> { seq, list: [{ seq, ts, kind, text, owner, blockedBy }] }
const ITEMS_MAX = 200;
const ITEM_KINDS = new Set(['decision', 'action']);

// Autopilot: whether the brain may auto-create action items and post links to the call chat (user opt-in).
const autopilot = store.map('autopilot', { persist: false }); // session -> { create, postChat }
// Brain -> panel -> content script: messages to type into the meeting chat (gated by autopilot.postChat).
const callChat = store.map('callChat'); // session -> { seq, items: [{ seq, text }] }
// Content script -> panel -> server: delivery ACK for a /callchat message (did it actually land in Meet?).
const callChatResult = store.map('callChatResult'); // session -> { seq, items: [{ seq, ok, reason }] }
// Handoff between assistants: the latest brain to claim a meeting. A previous assistant sees a newer
// agent here and yields, so takeover is automatic instead of a manual clad-task.
const takeover = store.map('takeover', { persist: false }); // session -> { agent, ts }

// Agent-driven page actions (flow testing / debugging in the user's real tab). Gated by `drive` (panel
// opt-in). Brain enqueues to /act, the extension executes on the app tab and posts the outcome to /act-result.
const drive = store.map('drive', { persist: false });       // session -> bool (is the user letting the agent control the tab?)
const acts = store.map('acts', { persist: false });        // session -> { seq, items: [cmd] }
const actResults = store.map('actResults', { persist: false });  // session -> { seq, items: [{ seq, ok, value, error }] }
const ACT_OPS = new Set(['click', 'type', 'press', 'navigate', 'waitFor', 'getText', 'exists', 'select', 'scroll']);

// Suppressions: the user dismissed an advice/action and asked for "no more like this". The brain reads
// these each turn and skips advice/actions on a suppressed topic.
const suppress = store.map('suppress'); // session -> [{ text, kind, ts }]
const SUPPRESS_TTL_MS = 8 * 3600 * 1000; // drop dismissals older than 8h (defensive against stale bleed)

// Post-call artifact: the brain writes a summary + action items at wrap-up; the panel offers copy/download.
const summaries = store.map('summaries'); // session -> markdown
function summaryFileFor(session) { return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.summary.md`); }

// Meeting mode - steers how the brain advises. Panel sets it; brain reads it each turn.
const modes = store.map('modes'); // session -> mode
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
// NOT billing - it counts raw volume once, so it undercounts per-turn context re-reads (the panel labels it "est.").
function estTokensFor(session) {
  let bytes = 0;
  for (const f of [fileFor(session), chatFileFor(session)]) {
    try { bytes += fs.statSync(f).size; } catch (_) { /* not created yet */ }
  }
  return Math.round(bytes / 4);
}

// --- Wake gating (token economy) ----------------------------------------------------------------
// The transcript file used to be BOTH the archive and the brain's doorbell (its Monitor tails it), so the
// only way to not spend a turn was to not write the line - which is why a plain "okay"/"yeah" was dropped,
// losing exactly the agreement cues the decisions board depends on ("Agree = log").
//
// Split the two channels: `<session>.txt` gets EVERYTHING (complete record), `<session>.wake` gets a batch
// only when it's worth a turn - that's what the brain tails. A skipped batch is not lost: its lines stay
// queued and ride along with the next wake, so a wrong "nothing here yet" costs latency, not information.
// That's what makes gating this aggressive safe.
//
// Measured on two real calls against ground truth (95 moments where the brain actually posted advice):
// 786 → 136 and 1109 → 237 wakes, no productive moment missed.
// Tunable via env (also how the test harness shrinks them) - no code edit needed to re-tune a call.
const WAKE_BASE_MS = parseInt(process.env.WAKE_BASE_MS || '10000', 10);   // normal coalescing window
const WAKE_MAX_MS = parseInt(process.env.WAKE_MAX_MS || '90000', 10);     // widest window, reached by doubling on empty batches
const WAKE_MIN_GAP_MS = parseInt(process.env.WAKE_MIN_GAP_MS || '8000', 10); // never wake twice inside this
const WAKE_FORCE_MS = parseInt(process.env.WAKE_FORCE_MS || '180000', 10);   // even pure chatter lands eventually - never go blind longer
const WAKE_MAX_CHARS = parseInt(process.env.WAKE_MAX_CHARS || '4000', 10);   // a burst this big is substance by volume alone
const wakeBuf = store.map('wakeBuf', { omit: ['timer'] }); // session -> { lines, firstAt, since, window, lastAt, timer }

// Per-session escape hatch: wake on EVERY line, small talk included, so `.wake` mirrors `.txt`. For calls
// where the brain must see the verbatim flow (dictation, note-taking, judging the gate itself) - it costs a
// turn per batch, which is exactly what the gate exists to avoid, so the gate stays the default.
// Set via POST /wake-mode; WAKE_ALL=1 flips the default for the whole server.
const WAKE_ALL_DEFAULT = process.env.WAKE_ALL === '1';
const wakeAll = store.map('wakeAll'); // session -> boolean
const remoteNames = store.map('remoteNames'); // session -> display name for tab-audio STT lines (1:1 only)
// Language for STT, pinned per session. Only the Meet content script can report the call's caption language,
// so on Zoom every chunk ran with lang=auto - and auto-detect on a 4s chunk sometimes picks the wrong
// language outright: a Polish sentence came back as "Por um tanto de burro." Pinning removes that class of
// failure at no measured cost (a pinned 'pl' transcribed an English sample correctly anyway).
const sttLangs = store.map('sttLangs'); // session -> 'pl' | 'en' | ...

// Cross-channel echo guard. The two STT channels can hear the same speech: if the other side has no
// headphones, the user's voice returns through their mic into the tab channel (measured on a live call with
// a second device in the room - the same utterance landed as both 'You' and the remote speaker). Keep a
// short window of recent lines per session and drop one that just arrived on the OTHER channel.
const STT_ECHO_MS = parseInt(process.env.STT_ECHO_MS || '9000', 10);
const sttRecent = store.map('sttRecent', { persist: false });

// Where each assistant has read up to on the wake channel, so nobody keeps a byte offset in a shell
// variable any more. Nested per session (session -> { consumer: offset }) rather than keyed
// `session|consumer`, so wiping a meeting clears its offsets with everything else.
const pollOffsets = store.map('pollOffsets');
// Cap on a single poll or transcript read. A 40-minute call is a few hundred KB, and handing all of it
// to a model in one tool result is how you spend a context window on backlog. The remainder is not
// dropped: a capped poll leaves the rest for the next one and says `truncated: true`.
const POLL_MAX_BYTES = 64 * 1024; // session -> [{ at, src, norm }]
const normStt = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function isSttEcho(session, src, text) {
  const norm = normStt(text);
  if (norm.length < 12) return false; // too short to tell an echo from a genuine "yes, exactly"
  const now = Date.now();
  const recent = (sttRecent.get(session) || []).filter((e) => now - e.at < STT_ECHO_MS);
  // Word overlap, not substring: the two channels hear the same speech through different mics, so the
  // transcripts differ ("Chodziło mi o rozmowę typu interview." vs "Chodzi o rozmowy w interwiewie." -
  // the same sentence, and substring matching missed it entirely).
  const words = new Set(norm.split(' '));
  const echo = recent.some((e) => {
    if (e.src === src) return false;
    const other = new Set(e.norm.split(' '));
    const smaller = words.size <= other.size ? words : other;
    const bigger = smaller === words ? other : words;
    let hit = 0;
    for (const w of smaller) if (bigger.has(w)) hit++;
    return hit / smaller.size >= 0.5;
  });
  recent.push({ at: now, src, norm });
  sttRecent.set(session, recent);
  return echo;
}
const wakeAllFileFor = (session) => path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.wakeall`);
function isWakeAll(session) {
  if (wakeAll.has(session)) return wakeAll.get(session);
  // Survive a restart mid-call: the flag is a marker file, same as the meeting mode.
  const on = fs.existsSync(wakeAllFileFor(session));
  wakeAll.set(session, on || WAKE_ALL_DEFAULT);
  return wakeAll.get(session);
}

// Wake NOW: decisions, blockers, someone calling Krystian (incl. the caption manglings of his name), and
// real questions. This bypass is what keeps recall at 100% - the gating below only defers the rest.
// The name list carries Meet's real manglings of "Krystian" - captions turned it into "Christian" on a
// live test, and "Chris"/"Kirsten" on earlier calls. Missing a mangling means missing a direct callout.
const URGENT_RE = /\b(agreed|decided|decision|action item|deadline|blocker|blocked|approved|rejected|ship it|krystian|krystiana|krystianie|christian|chris|kirsten|christos)\b/i;
// Substance: a number or a domain word. Deliberately a short, editable list - it will drift with the work.
// NOTE: no bare "pr" here. With the /i flag and the trailing \w* it matched problem/pretty/probably/
// present - 3-9% of batches on real calls passed on that alone. A pull request is either uppercase "PR"
// or comes with a number, so match those two shapes explicitly instead (see PR_RE).
const CONTENT_RE = /[0-9]|\b(ticket|jira|sprint|epic|story|point|backend|frontend|api|flag|deploy|release|bug|test|column|filter|sort|invite|credit|email|status|candidate|job|search|design|figma|migration|angular|eslint|contract|deliverab|onboarding|roadmap|ticket[ai]|sprint[uy]|zadani|błąd|blad|wdroż|wdroz)\w*/i;
const PR_RE = /\bPR\b|\bpr\s*#?\d/;  // case-sensitive on purpose: "PR" the noun, or "pr 1234"
const SMALLTALK_RE = /\b(good morning|good afternoon|how are you|how'?s it going|weekend|holiday|vacation|weather|coffee|lunch|haha|lol|thank you|thanks|bye|see you|cheers|sorry|no worries|exactly|of course|makes sense|got it|fair enough|dzień dobry|dzien dobry|cześć|czesc|dzięki|dzieki|jasne|no dobra|w porządku|w porzadku|do zobaczenia|weekend)\b/i;
const TECH_NOISE_RE = /\b(can you hear|you'?re muted|i'?m muted|mute|unmute|my (mic|camera|internet)|connection|breaking up|share (my )?screen|do you see|can you see (my|the) screen|let me (share|refresh|reload)|hold on|one second|just a (sec|moment)|lag|frozen|freezing|słyszysz|slyszysz|widzisz|udostępni|udostepni|sekund|zaraz wracam)\b/i;

function spokenText(line) { // strip "[hh:mm:ss] Speaker: " to classify the actual words
  return line.replace(/^\[[^\]]*\]\s*/, '').replace(/^[^:]{1,40}:\s*/, '').trim();
}
function wakeFileFor(session) { return path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.wake`); }
function isUrgentLine(line) {
  const t = spokenText(line);
  if (URGENT_RE.test(t)) return true;
  // A real question wakes us - but "how are you?" and "can you see my screen?" are questions too, and
  // they were burning a turn each until the noise check was added here (not just in batchWorthATurn).
  if (!(t.endsWith('?') && t.length > 25)) return false;
  return !SMALLTALK_RE.test(t) && !TECH_NOISE_RE.test(t);
}
function batchWorthATurn(lines) {
  const texts = lines.map(spokenText);
  const hasContent = texts.some((t) => CONTENT_RE.test(t) || PR_RE.test(t) || URGENT_RE.test(t));
  const allNoise = texts.every((t) => SMALLTALK_RE.test(t) || TECH_NOISE_RE.test(t));
  return hasContent && !allNoise;
}
function queueForWake(session, line) {
  let b = wakeBuf.get(session);
  if (!b) { b = { lines: [], firstAt: 0, since: 0, window: WAKE_BASE_MS, lastAt: 0, timer: null }; wakeBuf.set(session, b); }
  b.lines.push(line);
  const now = Date.now();
  if (!b.firstAt) b.firstAt = now;
  if (!b.since) b.since = now;
  // Back to fast cadence the moment anything real shows up - and cancel the pending long timer, otherwise
  // a window widened to 90s during small talk would sit on the first meaningful line for up to 90s.
  if (isUrgentLine(line) || CONTENT_RE.test(spokenText(line)) || PR_RE.test(spokenText(line))) {
    b.window = WAKE_BASE_MS;
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  }
  scheduleWake(session);
}
function scheduleWake(session) {
  const b = wakeBuf.get(session);
  if (!b || !b.lines.length || b.timer) return;
  const urgent = b.lines.some(isUrgentLine);
  const dueAt = Math.max(urgent ? b.since : b.since + b.window, b.lastAt + WAKE_MIN_GAP_MS);
  b.timer = setTimeout(() => { b.timer = null; evaluateWake(session); }, Math.max(0, dueAt - Date.now()));
}
function evaluateWake(session) {
  const b = wakeBuf.get(session);
  if (!b || !b.lines.length) return;
  const chars = b.lines.reduce((n, l) => n + l.length, 0);
  const stale = Date.now() - b.firstAt >= WAKE_FORCE_MS;
  if (stale || chars >= WAKE_MAX_CHARS || b.lines.some(isUrgentLine) || batchWorthATurn(b.lines)) {
    flushWake(session);
    return;
  }
  // Nothing of substance yet: widen the window and keep the lines queued. Self-tuning - no lexicon needed
  // to sit out a long stretch of chatter, and the WAKE_FORCE_MS ceiling bounds how long we stay quiet.
  b.window = Math.min(WAKE_MAX_MS, b.window * 2);
  b.since = Date.now();
  scheduleWake(session);
}
function flushWake(session) {
  const b = wakeBuf.get(session);
  if (!b) return;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  if (!b.lines.length) return;
  try {
    fs.appendFileSync(wakeFileFor(session), b.lines.join(''));
    // One line per brain turn - this is the log to read when tuning the WAKE_* thresholds for a real call.
    console.log(`[wake] ${session} +${b.lines.length} lines (window ${b.window}ms)`);
  } catch (e) { console.error('[transcript] wake write failed', e); }
  b.lines = []; b.firstAt = 0; b.since = 0; b.lastAt = Date.now(); b.window = WAKE_BASE_MS;
}

// A buffer that came back from disk has its lines but not its timer - a setTimeout handle cannot be
// serialized. Without this, held lines sat there until the same meeting code came round again and then
// arrived in a batch the assistant reads as "what was just said", which is a leak across meetings, not
// merely stale data. Overdue buffers are dropped rather than flushed: past WAKE_FORCE_MS the gate would
// have released them long ago, so their moment has passed and they are not evidence of anything now.
for (const s of [...wakeBuf.keys()]) {
  const b = wakeBuf.get(s);
  if (!b || !b.lines.length) { wakeBuf.delete(s); continue; }
  b.timer = null;
  if (!b.firstAt || Date.now() - b.firstAt >= WAKE_FORCE_MS) {
    console.log(`[wake] dropped ${b.lines.length} stale buffered line(s) for ${s}`);
    wakeBuf.delete(s);
  } else {
    scheduleWake(s);
  }
}

function cors(req, res) {
  // Reflect only the extension's own origin - never a web page's. A malicious site's cross-origin
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
    // Report WHICH model, not just that one exists: `launchctl kickstart` restarts the job from its cached
    // plist, so an edited WHISPER_MODEL silently does nothing until the job is booted out and back in -
    // and transcription quality then differs from what you measured on the command line.
    const tools = { ffmpeg: fs.existsSync(FFMPEG), whisper: fs.existsSync(WHISPER_CLI), whisperModel: path.basename(WHISPER_MODEL) };
    checkBlackhole((blackhole) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dir: TRANSCRIPTS_DIR, tools: { ...tools, blackhole } }));
    });
    return;
  }

  // Is the caller's token good? Answers 200 either way, so the panel can show "set your token" without
  // logging a 403 on every poll. A brand-new install polls this before the token is pasted, and a console
  // full of red on first run reads as "broken" to someone who has done nothing wrong yet.
  // Safe to sit before the gate: it reveals only whether the caller already knows the token.
  if (req.method === 'GET' && req.url.startsWith('/auth-check')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ authed: (req.headers['x-mla-token'] || '') === TOKEN }));
  }

  // Everything past here requires the shared token (see TOKEN_FILE above).
  if ((req.headers['x-mla-token'] || '') !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }

  if (req.method === 'POST' && req.url === '/append') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      // Refuse a session-less append instead of letting safeSession() mint `meeting_<timestamp>`: that turned
      // every line of a call into its own transcript file when the caller lost track of the session.
      // Also reject the literal strings a broken caller sends: a template that interpolated an undefined
      // variable produced session="undefined", the server dutifully created `undefined.txt`, and it then
      // became the newest transcript - which is what the brain pins. One hour of a real interview landed
      // there while the panel, holding no session at all, could not display a single line of advice.
      if (!/\S/.test(String(data.session || '')) || /^(undefined|null|NaN)$/i.test(String(data.session).trim())) {
        res.writeHead(400); return res.end('missing or invalid session');
      }
      const session = safeSession(data.session);
      const line = typeof data.line === 'string' ? data.line : '';
      const file = fileFor(session);
      try {
        if (!seenSessions.has(session)) {
          seenSessions.add(session);
          fs.appendFileSync(file, `==== ${session} - started ${new Date().toISOString()} ====\n`);
          console.log(`[transcript] new session → ${file}`);
        }
        if (line) {
          fs.appendFileSync(file, line); // the .txt is the complete record - nothing is ever dropped here
          queueForWake(session, line);   // whether it's worth a turn is decided on the .wake channel
          if (isWakeAll(session)) flushWake(session); // "collect everything" mode: no gate, no coalescing
        } else {
          flushWake(session); // empty keepalive → push out anything pending
        }
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
  if (req.method === 'POST' && (req.url === '/stt' || req.url.startsWith('/stt?'))) { // not /stt-lang
    const u = new URL(req.url, 'http://127.0.0.1');
    const rawSession = String(u.searchParams.get('session') || '').trim();
    if (!rawSession || /^(undefined|null|NaN)$/i.test(rawSession)) {
      res.writeHead(400); return res.end('missing or invalid session'); // see /append - no phantom sessions
    }
    const session = safeSession(rawSession);
    // A session pin wins over whatever the extension sends - the panel has no Zoom language selector.
    const lang = sttLangs.get(session) || (u.searchParams.get('lang') || 'auto').slice(0, 5);
    const src = u.searchParams.get('src') === 'mic' ? 'mic' : 'tab';
    const chunks = []; let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 25e6) req.destroy(); });
    req.on('end', () => {
      if (!size) { res.writeHead(400); return res.end('empty'); }
      const tmp = path.join(os.tmpdir(), `mla-stt-${Date.now()}.webm`);
      try { fs.writeFileSync(tmp, Buffer.concat(chunks)); } catch (_) { res.writeHead(500); return res.end('write'); }
      transcribe(tmp, lang, (err, text) => {
        if (err) { res.writeHead(500); return res.end('stt failed'); }
        if (text && isSttEcho(session, src, text)) {
          console.log(`[stt] dropped echo on ${src}: ${text.slice(0, 60)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ text: '' }));
        }
        if (text) {
          const d = new Date();
          const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
          try {
            const file = fileFor(session);
            if (!seenSessions.has(session)) {
              seenSessions.add(session);
              fs.appendFileSync(file, `==== ${session} - started ${new Date().toISOString()} ====\n`);
            }
            // Mic STT is the user (co-pilot) → 'You' (authorizes actions). tabCapture STT is remote
            // participants; whisper does no diarization, so there is no name to attach - unless the user
            // named the other side for this session (POST /remote-name), which is exact in a 1:1 and wrong
            // the moment a third person joins. Either way it is NOT the user, so it still authorizes nothing.
            const who = src === 'mic' ? 'You' : (remoteNames.get(session) || '(unattributed)');
            const sttLine = `[${hms}] ${who}: ${text}\n`;
            fs.appendFileSync(file, sttLine);
            queueForWake(session, sttLine);
          } catch (_) {}
        }
        // Return the label too: the panel used to hardcode '(unattributed)' for tab audio and so showed a
        // different speaker than the transcript the brain reads.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: text || '', speaker: src === 'mic' ? 'You' : (remoteNames.get(session) || '(unattributed)') }));
      });
    });
    return;
  }

  // Options page -> server: list installed `say` voices (for the voice picker).
  if (req.method === 'GET' && req.url === '/voices') {
    // An empty list, not a 500: off macOS there are no voices to pick and that is not an error.
    if (!IS_MAC) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]'); }
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
    const tk = takeover.get(safeSession(u.searchParams.get('session')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ts, ageMs: ts ? Date.now() - ts : null,
      status: st ? st.text : '', statusAgeMs: st ? Date.now() - st.ts : null,
      estTokens: estTokensFor(u.searchParams.get('session')),
      // A claim is only worth showing while the claimant is still heartbeating. Reporting the name of an
      // assistant that died an hour ago puts a 🧠 pill on a panel nobody is behind.
      agent: (tk && ts && Date.now() - ts < BRAIN_STALE_MS) ? tk.agent : null,
    }));
    return;
  }

  // Brain -> server: claim a meeting ("I'm taking this session now"). Other assistants GET this and, on
  // seeing a NEWER agent than themselves, yield - automatic handoff instead of a manual clad-task.
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

  // Everything the brain must check each turn, in ONE request and ONE line - /control + /mode + /autopilot
  // + /suppress. Four JSON responses per turn would each land in the loop's context and be re-read on every
  // later turn; plain text keeps that to a handful of tokens. Suppression texts appear only if there are any.
  if (req.method === 'GET' && req.url.startsWith('/status')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    const ap = autopilot.get(s) || { create: false, postChat: false };
    const sup = (suppress.get(s) || []).filter((e) => !e.ts || Date.now() - e.ts < SUPPRESS_TTL_MS);
    const lines = [`state=${control.get(s) || 'running'} mode=${modes.get(s) || 'auto'} create=${ap.create ? 1 : 0} postChat=${ap.postChat ? 1 : 0} wake=${isWakeAll(s) ? 'all' : 'gated'}${remoteNames.get(s) ? ` remote=${remoteNames.get(s)}` : ''}${sttLangs.get(s) ? ` lang=${sttLangs.get(s)}` : ''}`];
    for (const e of sup) lines.push(`suppress[${e.kind || 'any'}] ${e.text}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  // Pin the STT language for a session (removes wrong-language transcriptions; see sttLangs).
  if (req.method === 'POST' && req.url === '/stt-lang') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const s2 = safeSession(d.session);
      const lang = String(d.lang || '').trim().toLowerCase().slice(0, 5);
      if (lang && lang !== 'auto') sttLangs.set(s2, lang); else sttLangs.delete(s2);
      console.log(`[stt] ${s2} language = ${lang || 'auto'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lang: lang || 'auto' }));
    });
    return;
  }

  // Who the tab-audio STT lines belong to. Only meaningful in a 1:1 (whisper does no diarization); with a
  // third participant the label would be plain wrong, so it is opt-in per session and never inferred.
  if (req.method === 'POST' && req.url === '/remote-name') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const s = safeSession(d.session);
      const name = String(d.name || '').replace(/[\r\n:]/g, ' ').trim().slice(0, 40);
      if (name) remoteNames.set(s, name); else remoteNames.delete(s);
      console.log(`[stt] ${s} remote name = ${name || '(unattributed)'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: name || null }));
    });
    return;
  }

  // Wake mode: `gated` (default - only batches worth a turn reach .wake) or `all` (everything, small talk
  // included). Panel or brain can flip it mid-call; a pending batch is flushed so nothing waits behind it.
  if (req.method === 'POST' && req.url === '/wake-mode') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const s = safeSession(d.session);
      const on = d.all === true || d.all === 'true' || d.mode === 'all';
      wakeAll.set(s, on);
      try { if (on) fs.writeFileSync(wakeAllFileFor(s), '1'); else fs.unlinkSync(wakeAllFileFor(s)); } catch (_) {}
      flushWake(s);
      console.log(`[wake] ${s} mode=${on ? 'all' : 'gated'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: on ? 'all' : 'gated' }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/wake-mode')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: isWakeAll(s) ? 'all' : 'gated' }));
    return;
  }

  // Panel -> server: wipe everything for one meeting (transcript, chat, mode, snapshots, in-memory).
  if (req.method === 'POST' && req.url === '/clear') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad'); }
      const s = safeSession(d.session);
      for (const suf of ['.txt', '.wake', '.wakeall', '.chat.txt', '.mode.txt', '.summary.md']) { try { fs.unlinkSync(path.join(TRANSCRIPTS_DIR, s + suf)); } catch (_) {} }
      try { fs.rmSync(path.join(SNAP_DIR, s), { recursive: true, force: true }); } catch (_) {}
      { const b = wakeBuf.get(s); if (b && b.timer) clearTimeout(b.timer); }
      // Drops the key from every registered store. The hand-written list this replaced had grown to 27
      // names and had already missed one (sttRecent), so a wiped meeting kept its STT dedup state.
      store.forget(s);
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
        if (!seenSessions.has(session)) { seenSessions.add(session); fs.appendFileSync(file, `==== ${session} - started ${new Date().toISOString()} ====\n`); }
        const block = `\n[${hms}] ===== PRE-JOIN CONTEXT (imported) =====\n${text}\n=================================================\n`;
        fs.appendFileSync(file, block);
        queueForWake(session, block); // imported background is worth a turn
        flushWake(session);
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

  // ---------------------------------------------------------------------------------------------------
  // Assistant-facing reads, shaped for the MCP adapter (server/mcp-server.js).
  //
  // These exist because the assistant's two most important inputs were not HTTP at all: it resolved the
  // active meeting with `ls -t` and read new captions by tailing `<session>.wake` with `tail -c +N`,
  // keeping the byte offset in a shell variable. Both need a filesystem, so neither survives the
  // assistant running anywhere but this machine. Same data, over the wire, with the offset held here.

  // Which meeting is live, and is someone already assisting it?
  if (req.method === 'GET' && req.url.startsWith('/sessions')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const want = u.searchParams.get('session');
    let session = '';
    if (want) {
      const s = safeSession(want);
      if (fs.existsSync(fileFor(s))) session = s;
    } else {
      let newest = 0;
      try {
        for (const f of fs.readdirSync(TRANSCRIPTS_DIR)) {
          if (!f.endsWith('.txt') || f.endsWith('.chat.txt') || f.endsWith('.mode.txt')) continue;
          const m = fs.statSync(path.join(TRANSCRIPTS_DIR, f)).mtimeMs;
          if (m > newest) { newest = m; session = f.slice(0, -4); }
        }
      } catch (_) {}
    }
    const ping = session ? (brainPing.get(session) || 0) : 0;
    let lines = 0; let startedAt = null;
    if (session) {
      try {
        const st = fs.statSync(fileFor(session));
        startedAt = new Date(st.birthtimeMs || st.mtimeMs).toISOString();
        lines = fs.readFileSync(fileFor(session), 'utf8').split('\n').length - 1;
      } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: session || null, lines, startedAt,
      otherAssistantAgeMs: ping ? Date.now() - ping : null,
    }));
    return;
  }

  // The keystone. New wake batch since this consumer's last poll, plus everything the assistant used to
  // fetch separately. `consumer` is per assistant, not per session, so two assistants do not eat each
  // other's batches; `statusOnly` reads without consuming, for a first attach.
  if (req.method === 'GET' && req.url.startsWith('/poll')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    const consumer = String(u.searchParams.get('consumer') || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    const statusOnly = u.searchParams.get('statusOnly') === '1';
    const asText = u.searchParams.get('format') === 'text';

    const ap = autopilot.get(s) || { create: false, postChat: false };
    const status = {
      state: control.get(s) || 'running',
      mode: modes.get(s) || 'auto',
      wake: isWakeAll(s) ? 'all' : 'gated',
      autopilot: { create: !!ap.create, postChat: !!ap.postChat },
      remoteName: remoteNames.get(s) || null,
      sttLang: sttLangs.get(s) || null,
      suppress: (suppress.get(s) || [])
        .filter((e) => !e.ts || Date.now() - e.ts < SUPPRESS_TTL_MS)
        .map(({ text, kind }) => ({ text, kind })),
      estTokens: estTokensFor(s),
    };
    if (statusOnly) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: s, batch: '', status }));
      return;
    }

    // Deliberately does NOT flush the wake buffer. Held lines are held because the gate judged them not
    // worth a turn yet; forcing them out on a 2-second poll would make every poll return a batch and undo
    // the gate entirely (measured on a real call: 786 wakes gated down to 189). Nothing is stranded
    // either - WAKE_FORCE_MS bounds how long even pure chatter can sit there.
    const wf = wakeFileFor(s);
    const offsets = pollOffsets.get(s) || {};
    let from = offsets[consumer] || 0;
    let batch = '';
    let size = 0;
    try {
      size = fs.statSync(wf).size;
      if (size < from) from = 0; // the meeting was cleared and the file restarted
      if (size > from) {
        const fd = fs.openSync(wf, 'r');
        try {
          const buf = Buffer.alloc(Math.min(size - from, POLL_MAX_BYTES));
          const read = fs.readSync(fd, buf, 0, buf.length, from);
          batch = buf.slice(0, read).toString('utf8');
          from += read; // a capped read leaves the rest for the next poll rather than dropping it
        } finally { fs.closeSync(fd); }
      }
    } catch (_) { /* no wake file yet: nothing has been judged worth a turn */ }
    offsets[consumer] = from;
    pollOffsets.set(s, offsets);

    const ccr = callChatResult.get(s) || { seq: 0, items: [] };
    const ackKey = `${consumer}:callchat`;
    const ackFrom = offsets[ackKey] || 0;
    offsets[ackKey] = ccr.seq;

    // A change the user made in the panel is worth an assistant turn on its own. Without this, pressing
    // Stop ended capture, the transcript stopped growing, nothing woke the assistant, and the wrap-up it
    // was supposed to write never happened. estTokens is excluded from the signature deliberately: it
    // moves with every caption, so including it would wake on every poll and defeat the gate entirely.
    const { estTokens, ...stable } = status;
    const sig = JSON.stringify(stable);
    const statusChanged = offsets[`${consumer}:sig`] !== sig;
    offsets[`${consumer}:sig`] = sig;

    if (asText) {
      // Shaped for the wake loop: empty body means "nothing happened, do not wake anybody".
      let out = '';
      if (statusChanged) {
        out += `state=${status.state} mode=${status.mode} create=${status.autopilot.create ? 1 : 0}`
          + ` postChat=${status.autopilot.postChat ? 1 : 0} wake=${status.wake}`
          + `${status.remoteName ? ` remote=${status.remoteName}` : ''}${status.sttLang ? ` lang=${status.sttLang}` : ''}\n`;
        for (const e of status.suppress) out += `suppress[${e.kind || 'any'}] ${e.text}\n`;
      }
      for (const r of ccr.items.filter((i) => i.seq > ackFrom)) out += `callchat[${r.ok ? 'sent' : 'failed'}] ${r.reason || ''}\n`;
      if (batch) out += `${statusChanged ? '--\n' : ''}${batch}`;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: s,
      batch,
      truncated: size > from,
      status,
      statusChanged,
      pending: {
        callChatResults: ccr.items.filter((i) => i.seq > ackFrom),
        snapshotSeq: snapReq.get(s) || 0,
      },
    }));
    return;
  }

  // The complete record, as opposed to the batches the wake gate let through.
  if (req.method === 'GET' && req.url.startsWith('/transcript')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    const tail = Math.min(Math.max(parseInt(u.searchParams.get('tail') || '200', 10) || 200, 1), 2000);
    let all = '';
    try { all = fs.readFileSync(fileFor(s), 'utf8'); } catch (_) {}
    const lines = all.split('\n').filter((l) => l !== '');
    const slice = lines.slice(-tail);
    let text = slice.join('\n');
    // A whole meeting can outgrow the caller's context. Truncating from the front keeps the most recent
    // exchange, which is what a mid-call question is almost always about.
    const truncated = Buffer.byteLength(text) > POLL_MAX_BYTES;
    if (truncated) text = text.slice(-POLL_MAX_BYTES);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: s, text, lines: slice.length, totalLines: lines.length, truncated }));
    return;
  }

  // Captured screen snapshots, newest first. Paths, not bytes: the caller reads the image itself.
  if (req.method === 'GET' && req.url.startsWith('/snapshots')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '5', 10) || 5, 1), SNAP_MAX);
    const dir = path.join(SNAP_DIR, s);
    let snapshots = [];
    try {
      snapshots = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jpg'))
        .map((f) => {
          const p = path.join(dir, f);
          const st = fs.statSync(p);
          return { path: p, at: new Date(st.mtimeMs).toISOString(), bytes: st.size };
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, limit);
    } catch (_) { /* no snapshot dir: none captured */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: s, snapshots }));
    return;
  }

  res.writeHead(404); res.end('not found');
});

// Flush queued wakes before dying (launchd reload / Ctrl-C) so a pending batch isn't lost on restart.
// The .txt needs no flushing - it's written line by line.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const s of wakeBuf.keys()) flushWake(s);
    store.close(); // final snapshot, so a restart resumes from the last second rather than the last tick
    process.exit(0);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[transcript] listening on http://127.0.0.1:${PORT}`);
  console.log(`[transcript] writing to ${TRANSCRIPTS_DIR}`);
  console.log(`[transcript] auth token in ${TOKEN_FILE} - paste it into the extension options (cat the file).`);
  console.log(`[transcript] retention: ${RETENTION_DAYS > 0 ? RETENTION_DAYS + ' days' : 'forever'}`);
  purgeOld();
  setInterval(purgeOld, 6 * 3600 * 1000); // re-check a few times a day
});
