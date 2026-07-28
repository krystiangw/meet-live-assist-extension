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
const WHISPER_PROMPT = process.env.WHISPER_PROMPT
  || 'Angular, Flagsmith, feature flag, code review, pull request, Jira, backend, frontend, deploy, release, sprint, story points.';
// whisper emits these for silence/music — drop them.
const STT_NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|>>|\.|…)?\s*$/;

// Whisper does not return "nothing" for a chunk with no speech — it invents filler. On a quiet mic it
// produced "Thank you." and "... ... ... ..." on a live call, which would fill an interview transcript with
// phantom lines. Two nets: skip silent chunks before whisper runs at all (peak level), then drop the
// boilerplate it emits anyway. Thresholds are env-tunable because mic levels differ per machine.
const STT_MIN_PEAK_DB = parseFloat(process.env.STT_MIN_PEAK_DB || '-30');   // below this, treat as no speech
const STT_QUIET_PEAK_DB = parseFloat(process.env.STT_QUIET_PEAK_DB || '-22'); // "Okay."-class filler only here
// Boilerplate whisper hallucinates on silence, in every language it was trained on subtitles for.
const STT_HALLUCINATION_RE = /^(?:\.{2,}|…)+[\s.…]*$|amara\.org|subtitles? (?:by|created)|thanks? for watching|napisy (?:stworzone|utworzone)|transcription by/i;
// Short generic phrases that are real speech sometimes — dropped only when the audio was near-silent.
// The thank-yous span languages because whisper falls back to whatever language it guessed for the silence:
// a quiet Polish call produced "Thank you." and "Gracias.", and a quiet tab channel produced "Uh...".
const STT_FILLER_RE = /^(thank you|thanks|bye|okay|ok|yeah|mhm+|hmm+|uh+|um+|aha|gracias|merci|danke|grazie|obrigad[oa]|спасибо|dziękuję|dzięki|okej|dobrze)[.!…]*$/i;

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
        return done(null, ''); // no speech in this chunk — running whisper on it only invents filler
      }
      // Bias the decoder toward our jargon. Measured on a Polish sample with English terms: without it
      // "Flagsmith" came out "flagship" and "pull requeście" as "pulrek feście"; with it both are correct,
      // and a pure-Polish sample is unaffected. Polish speech with English technical terms is the hard case.
      const args = ['-m', WHISPER_MODEL, '-f', wav, '-l', lang || 'auto', '-nt', '-np', '-t', '4'];
      if (WHISPER_PROMPT) args.push('--prompt', WHISPER_PROMPT);
      execFile(WHISPER_CLI, args,
        { maxBuffer: 4 * 1024 * 1024 }, (e2, stdout) => {
          fs.unlink(inputFile, () => {}); fs.unlink(wav, () => {});
          if (e2) return done(e2);
          const text = String(stdout || '').split('\n').map((l) => l.trim())
            .filter((l) => l && !STT_NOISE.test(l)).join(' ').trim();
          if (!text) return done(null, '');
          if (STT_HALLUCINATION_RE.test(text)) { console.log(`[stt] dropped boilerplate (${peak}dB): ${text}`); return done(null, ''); }
          if (STT_FILLER_RE.test(text) && peak !== null && peak < STT_QUIET_PEAK_DB) {
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
      if (!/\.(txt|md|wake|wakeall)$/.test(f)) continue; // .txt / .chat.txt / .mode.txt / .summary.md / .wake / .wakeall only
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

// --- Wake gating (token economy) ----------------------------------------------------------------
// The transcript file used to be BOTH the archive and the brain's doorbell (its Monitor tails it), so the
// only way to not spend a turn was to not write the line — which is why a plain "okay"/"yeah" was dropped,
// losing exactly the agreement cues the decisions board depends on ("Agree = log").
//
// Split the two channels: `<session>.txt` gets EVERYTHING (complete record), `<session>.wake` gets a batch
// only when it's worth a turn — that's what the brain tails. A skipped batch is not lost: its lines stay
// queued and ride along with the next wake, so a wrong "nothing here yet" costs latency, not information.
// That's what makes gating this aggressive safe.
//
// Measured on two real calls against ground truth (95 moments where the brain actually posted advice):
// 786 → 136 and 1109 → 237 wakes, no productive moment missed.
// Tunable via env (also how the test harness shrinks them) — no code edit needed to re-tune a call.
const WAKE_BASE_MS = parseInt(process.env.WAKE_BASE_MS || '10000', 10);   // normal coalescing window
const WAKE_MAX_MS = parseInt(process.env.WAKE_MAX_MS || '90000', 10);     // widest window, reached by doubling on empty batches
const WAKE_MIN_GAP_MS = parseInt(process.env.WAKE_MIN_GAP_MS || '8000', 10); // never wake twice inside this
const WAKE_FORCE_MS = parseInt(process.env.WAKE_FORCE_MS || '180000', 10);   // even pure chatter lands eventually — never go blind longer
const WAKE_MAX_CHARS = parseInt(process.env.WAKE_MAX_CHARS || '4000', 10);   // a burst this big is substance by volume alone
const wakeBuf = new Map(); // session -> { lines, firstAt, since, window, lastAt, timer }

// Per-session escape hatch: wake on EVERY line, small talk included, so `.wake` mirrors `.txt`. For calls
// where the brain must see the verbatim flow (dictation, note-taking, judging the gate itself) — it costs a
// turn per batch, which is exactly what the gate exists to avoid, so the gate stays the default.
// Set via POST /wake-mode; WAKE_ALL=1 flips the default for the whole server.
const WAKE_ALL_DEFAULT = process.env.WAKE_ALL === '1';
const wakeAll = new Map(); // session -> boolean
const remoteNames = new Map(); // session -> display name for tab-audio STT lines (1:1 only)
const wakeAllFileFor = (session) => path.join(TRANSCRIPTS_DIR, `${safeSession(session)}.wakeall`);
function isWakeAll(session) {
  if (wakeAll.has(session)) return wakeAll.get(session);
  // Survive a restart mid-call: the flag is a marker file, same as the meeting mode.
  const on = fs.existsSync(wakeAllFileFor(session));
  wakeAll.set(session, on || WAKE_ALL_DEFAULT);
  return wakeAll.get(session);
}

// Wake NOW: decisions, blockers, someone calling Krystian (incl. the caption manglings of his name), and
// real questions. This bypass is what keeps recall at 100% — the gating below only defers the rest.
// The name list carries Meet's real manglings of "Krystian" — captions turned it into "Christian" on a
// live test, and "Chris"/"Kirsten" on earlier calls. Missing a mangling means missing a direct callout.
const URGENT_RE = /\b(agreed|decided|decision|action item|deadline|blocker|blocked|approved|rejected|ship it|krystian|krystiana|krystianie|christian|chris|kirsten|christos)\b/i;
// Substance: a number or a domain word. Deliberately a short, editable list — it will drift with the work.
// NOTE: no bare "pr" here. With the /i flag and the trailing \w* it matched problem/pretty/probably/
// present — 3-9% of batches on real calls passed on that alone. A pull request is either uppercase "PR"
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
  // A real question wakes us — but "how are you?" and "can you see my screen?" are questions too, and
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
  // Back to fast cadence the moment anything real shows up — and cancel the pending long timer, otherwise
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
  // Nothing of substance yet: widen the window and keep the lines queued. Self-tuning — no lexicon needed
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
    // One line per brain turn — this is the log to read when tuning the WAKE_* thresholds for a real call.
    console.log(`[wake] ${session} +${b.lines.length} lines (window ${b.window}ms)`);
  } catch (e) { console.error('[transcript] wake write failed', e); }
  b.lines = []; b.firstAt = 0; b.since = 0; b.lastAt = Date.now(); b.window = WAKE_BASE_MS;
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
    // Report WHICH model, not just that one exists: `launchctl kickstart` restarts the job from its cached
    // plist, so an edited WHISPER_MODEL silently does nothing until the job is booted out and back in —
    // and transcription quality then differs from what you measured on the command line.
    const tools = { ffmpeg: fs.existsSync(FFMPEG), whisper: fs.existsSync(WHISPER_CLI), whisperModel: path.basename(WHISPER_MODEL) };
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
      // Refuse a session-less append instead of letting safeSession() mint `meeting_<timestamp>`: that turned
      // every line of a call into its own transcript file when the caller lost track of the session.
      if (!String(data.session || '').trim()) { res.writeHead(400); return res.end('missing session'); }
      const session = safeSession(data.session);
      const line = typeof data.line === 'string' ? data.line : '';
      const file = fileFor(session);
      try {
        if (!seenSessions.has(session)) {
          seenSessions.add(session);
          fs.appendFileSync(file, `==== ${session} — started ${new Date().toISOString()} ====\n`);
          console.log(`[transcript] new session → ${file}`);
        }
        if (line) {
          fs.appendFileSync(file, line); // the .txt is the complete record — nothing is ever dropped here
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
            // participants; whisper does no diarization, so there is no name to attach — unless the user
            // named the other side for this session (POST /remote-name), which is exact in a 1:1 and wrong
            // the moment a third person joins. Either way it is NOT the user, so it still authorizes nothing.
            const who = src === 'mic' ? 'You' : (remoteNames.get(session) || '(unattributed)');
            const sttLine = `[${hms}] ${who}: ${text}\n`;
            fs.appendFileSync(file, sttLine);
            queueForWake(session, sttLine);
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
    const tk = takeover.get(safeSession(u.searchParams.get('session')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ts, ageMs: ts ? Date.now() - ts : null,
      status: st ? st.text : '', statusAgeMs: st ? Date.now() - st.ts : null,
      estTokens: estTokensFor(u.searchParams.get('session')),
      agent: tk ? tk.agent : null,
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

  // Everything the brain must check each turn, in ONE request and ONE line — /control + /mode + /autopilot
  // + /suppress. Four JSON responses per turn would each land in the loop's context and be re-read on every
  // later turn; plain text keeps that to a handful of tokens. Suppression texts appear only if there are any.
  if (req.method === 'GET' && req.url.startsWith('/status')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const s = safeSession(u.searchParams.get('session'));
    const ap = autopilot.get(s) || { create: false, postChat: false };
    const sup = (suppress.get(s) || []).filter((e) => !e.ts || Date.now() - e.ts < SUPPRESS_TTL_MS);
    const lines = [`state=${control.get(s) || 'running'} mode=${modes.get(s) || 'auto'} create=${ap.create ? 1 : 0} postChat=${ap.postChat ? 1 : 0} wake=${isWakeAll(s) ? 'all' : 'gated'}${remoteNames.get(s) ? ` remote=${remoteNames.get(s)}` : ''}`];
    for (const e of sup) lines.push(`suppress[${e.kind || 'any'}] ${e.text}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(lines.join('\n') + '\n');
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

  // Wake mode: `gated` (default — only batches worth a turn reach .wake) or `all` (everything, small talk
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
      wakeAll.delete(s);
      remoteNames.delete(s);
      try { fs.rmSync(path.join(SNAP_DIR, s), { recursive: true, force: true }); } catch (_) {}
      { const b = wakeBuf.get(s); if (b && b.timer) clearTimeout(b.timer); }
      for (const m of [advice, chat, items, modes, edits, domReq, doms, dbgReq, dbgData, snapReq, brainPing, brainStatus, control, wakeBuf, summaries, autopilot, callChat, callChatResult, takeover, drive, acts, actResults, suppress]) m.delete(s);
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

  res.writeHead(404); res.end('not found');
});

// Flush queued wakes before dying (launchd reload / Ctrl-C) so a pending batch isn't lost on restart.
// The .txt needs no flushing — it's written line by line.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { for (const s of wakeBuf.keys()) flushWake(s); process.exit(0); });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[transcript] listening on http://127.0.0.1:${PORT}`);
  console.log(`[transcript] writing to ${TRANSCRIPTS_DIR}`);
  console.log(`[transcript] auth token in ${TOKEN_FILE} — paste it into the extension options (cat the file).`);
  console.log(`[transcript] retention: ${RETENTION_DAYS > 0 ? RETENTION_DAYS + ' days' : 'forever'}`);
  purgeOld();
  setInterval(purgeOld, 6 * 3600 * 1000); // re-check a few times a day
});
