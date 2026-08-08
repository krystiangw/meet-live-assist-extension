// Side panel - primary live UI. This page persists while open, so it (not the SW) owns any
// long-lived state/streaming. Renders live transcript (via the SW port) + live advice (polled
// straight from the transcript server's /advice channel - the "brain" POSTs advice there).

const logEl = document.getElementById('log');
const adviceEl = document.getElementById('advice');
const itemsEl = document.getElementById('items');
const capEl = document.getElementById('capStatus');
const srvEl = document.getElementById('srvStatus');
const brainEl = document.getElementById('brainStatus');
const talkEl = document.getElementById('talkStatus');
const muteEl = document.getElementById('muteStatus');
const mentionEl = document.getElementById('mentionStatus');
const snapEl = document.getElementById('snapStatus');
const snapBtn = document.getElementById('snapNow');
const shareEl = document.getElementById('shareStatus');
const speakEl = document.getElementById('speakStatus');
const sessionEl = document.getElementById('session');
const chatEl = document.getElementById('chat');
const tokenEstEl = document.getElementById('tokenEst');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const cmdMenu = document.getElementById('cmdMenu');
const sttToggle = document.getElementById('sttToggle');
const sttEl = document.getElementById('sttStatus');
/* mla:pro-start */
const editEl = document.getElementById('editStatus');
const dbgToggle = document.getElementById('dbgToggle');
const dbgEl = document.getElementById('dbgStatus');
/* mla:pro-end */
const modeSel = document.getElementById('modeSel');

const MARKER_LABEL = { SAY: '🟢 SAY', INFO: '🔵 INFO', SUMMARY: '🟡 SUMMARY', EXPLAIN: '🟣 EXPLAIN', RISK: '🔴 RISK', ACTION: '🟠 ACTION' };
const MARKER_TIP = {
  SAY: 'Say this out loud now - ready-to-speak words (🔊 voice it, 📋 copy)',
  INFO: 'A fact, number, link or name from your context',
  SUMMARY: 'Where the discussion is / what was just decided',
  EXPLAIN: 'A short explanation of a term or the “why”',
  RISK: 'A risk, a contradiction, or a decision to recall',
  ACTION: 'Something to do / you were asked to do',
};
const DEFAULT_SERVER = 'http://127.0.0.1:8848';

let hasLines = false;
let hasAdvice = false;
let hasItems = false;
let currentSession = null;
let lastSnapAt = 0;        // when the last snapshot actually reached the assistant (ms)
let lastSnapCount = null;  // running count this meeting (from server)
let snapErrUntil = 0;      // keep a fresh capture error visible instead of ticking over it
let shareFlashUntil = 0;   // brief "📸 shot" pulse on the sharing pill when a frame is captured
let lastAdviceSeq = 0;
let lastItemsSeq = 0;
let lastReqSeq = -1; // -1 = baseline unknown for this session (don't fire on first poll)
let lastChatSeq = 0;
let lastEditSeq = -1;
let lastDomReqSeq = -1;
let lastDbgReqSeq = -1;
let sharing = false;
let serverUrl = DEFAULT_SERVER;
let serverToken = '';
let ttsVoicePl = null;
let ttsVoiceEn = null;
let callLang = null; // from Meet's caption-language selector (via content script)
let port = null;
let pingTimer = null;
let pollTimer = null;
let brainTimer = null;
let shareTimer = null;
let lastAuthWarnAt = 0;

function setStatus(el, text, cls) { el.textContent = text; el.className = 'status ' + cls; }

// Collect the token from the server rather than asking someone to copy 48 hex characters out of a dotfile.
// Only succeeds while the server has a pairing window open (`meet-live-assist-server --pair`, or its first
// ever boot), and the first claim closes it. Every other outcome is a normal, quiet no.
async function tryPair() {
  try {
    const r = await fetch(`${serverUrl}/pair`, { headers: { 'X-MLA-Pair': '1' } });
    if (!r.ok) return false;
    const { token } = await r.json();
    if (!token) return false;
    serverToken = token;
    await chrome.storage.local.set({ mla_token: token });
    return true;
  } catch (_) { return false; }
}

async function pollServerHealth() {
  if (Date.now() - lastAuthWarnAt < 20000) return;
  try {
    // /auth-check answers 200 with {authed}, so the pill reflects auth as well as reachability without a
    // failed request per poll. It used to probe a token-guarded route and read the 403; the pill was right,
    // but every poll before the token was pasted logged a console error on a fresh install.
    const r = await fetch(`${serverUrl}/auth-check`, { headers: hdrs() });
    // A server older than this route is running fine, it just cannot answer. Saying "start it" there would
    // send the user chasing a process that is already up.
    if (r.status === 404) { setStatus(srvEl, 'server ✓ (restart to update)', 'ok'); setSetupStep('server', true); return; }
    if (!r.ok) { setStatus(srvEl, 'server ✗ (start it)', 'bad'); setSetupStep('server', false); return; }
    setSetupStep('server', true);
    const { authed } = await r.json();
    setSetupStep('paired', !!authed);
    if (!authed) {
      // Try to pair before nagging. A user who has just run `--pair` sees this resolve itself within one
      // poll, which is the whole point; if no window is open, nothing happens and the advice below stands.
      if (await tryPair()) { setStatus(srvEl, 'server ✓ (paired)', 'ok'); fetchHealth(); return; }
      lastAuthWarnAt = Date.now();
      setStatus(srvEl, 'server ✗ (run the server with --pair, or set the token in options)', 'bad');
      return;
    }
    setStatus(srvEl, 'server ✓', 'ok');
  } catch (_) {
    setStatus(srvEl, 'server ✗ (start it)', 'bad');
    setSetupStep('server', false);
    setSetupStep('paired', false);
  }
}

// Live "Ns ago" next to 📷 so you can see at a glance how stale the assistant's visual context is.
function renderSnapAge() {
  const now = Date.now();
  const secs = lastSnapAt ? Math.round((now - lastSnapAt) / 1000) : null;
  const long = secs == null ? null : (secs <= 0 ? 'now' : secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`);
  const short = secs == null ? null : (secs <= 0 ? 'now' : secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`);
  // Snapshot status pill (top row): freshness of the assistant's visual context.
  if (now >= snapErrUntil && long) {
    setStatus(snapEl, `📷 ${long}`, 'ok');
    snapEl.title = `Last snapshot sent to the assistant ${long}${lastSnapCount != null ? ` · ${lastSnapCount} this meeting` : ''}`;
  }
  // Sharing pill: flash when a frame is grabbed, otherwise show how long since the last one.
  if (sharing && !shareEl.hidden) {
    if (now < shareFlashUntil) setStatus(shareEl, '● 📸 shot', 'bad');
    else setStatus(shareEl, short ? `● sharing · 📷 ${short}` : '● sharing', 'bad');
  }
}
function resetSnap() { lastSnapAt = 0; lastSnapCount = null; snapErrUntil = 0; snapEl.onclick = null; snapEl.style.cursor = ''; setStatus(snapEl, 'shots 0', 'idle'); }
setInterval(renderSnapAge, 1000);
function hdrs(json) { const h = { 'X-MLA-Token': serverToken }; if (json) h['Content-Type'] = 'application/json'; return h; }

// The all-sites host permission is optional and requested at runtime. `debugger` is NOT optional - Chrome
// refuses to list it there - so it sits in the install prompt and the public build drops it entirely.
// Requested at runtime on a user gesture - kept out
// of the install-time prompt for a cleaner Web Store listing.
const ALL_URLS = { origins: ['<all_urls>'] };
async function ensurePerms(perms) {
  // request() resolves true immediately if already held (no prompt), so no contains() pre-check - that
  // extra await could otherwise consume the gesture's transient activation before the prompt shows.
  try { return await chrome.permissions.request(perms); }
  catch (_) { return false; }
}

// Seams for the page-control / live-debugging surface, which `build.sh --public` strips (see the
// mla:pro markers). Shared code calls these three and never the pro functions directly, so stripping
// leaves working no-ops instead of dangling references and needs no build-time flag.
let pollPro = () => {};
let loadPro = () => {};
let resetPro = () => {};

// Urgent cue on 🔴 RISK: a short beep + a system notification (the panel may be hidden mid-call).
let cueArmed = false; // stays off briefly after (re)connect so backfilled advice doesn't blast
function riskCue(text) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 660; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start(); o.stop(ctx.currentTime + 0.36);
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 600);
  } catch (_) {}
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Meet Live Assist - RISK', message: String(text || '').slice(0, 180) }); } catch (_) {}
}

// ---- transcript ----------------------------------------------------------
// One utterance = one line that grows in place. A caption block (id) keeps emitting the FULL growing text
// (interim + on each finalize), so we UPDATE the same element while the text is a continuation, and only
// start a new line when the same id begins a genuinely new utterance (text no longer extends the last one).
const liveById = new Map(); // caption id -> { el, text }
function clearLog() { logEl.innerHTML = ''; hasLines = false; liveById.clear(); }
function renderLine(el, ts, speaker, text, final) {
  el.className = 'line' + (final ? '' : ' live');
  el.textContent = '';
  const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts || ''; el.append(t);
  if (speaker) { const w = document.createElement('span'); w.className = 'who'; w.textContent = speaker + ': '; el.append(w); }
  linkify(el, text);
}
// Same utterance if the two texts share a substantial leading chunk - tolerant of ASR revising later words
// (e.g. "…TG site cream" → "…TG site. Creamier"), which a strict prefix check would wrongly split.
function sameUtterance(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a) return true;
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i >= Math.min(18, Math.floor(a.length * 0.5));
}
function upsertCaption(id, { ts, speaker, text }, final) {
  if (!hasLines) { logEl.innerHTML = ''; hasLines = true; }
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  const cur = (text || '').trim();
  const prev = liveById.get(id);
  let el;
  if (prev && sameUtterance(prev.text, cur)) el = prev.el; // same utterance (still growing / ASR-revised) → in place
  else { el = document.createElement('div'); logEl.appendChild(el); } // first, or a genuinely new utterance on this id
  renderLine(el, ts, speaker, text, final);
  liveById.set(id, { el, text: cur });
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- talk-time + muted nudge ---------------------------------------------
let talkWords = { you: 0, others: 0 };
function resetTalk() { talkWords = { you: 0, others: 0 }; talkEl.hidden = true; muteEl.hidden = true; mentionEl.hidden = true; }
function trackTalk(speaker, text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean).length;
  if (!w) return;
  if (speaker === 'You') talkWords.you += w;
  else if (speaker && speaker !== '(unattributed)') talkWords.others += w;
  const tot = talkWords.you + talkWords.others;
  if (tot >= 25) { talkEl.hidden = false; setStatus(talkEl, `🗣 you ${Math.round(100 * talkWords.you / tot)}%`, 'idle'); }
}
const MUTED_RE = /\byou(?:'|’| a)?re (?:on mute|muted|breaking up)\b|\byou are (?:on mute|muted)\b|can'?t hear you|you broke up|you'?re on mute\b/i;
let muteNudgeAt = 0;
function checkMuted(speaker, text) {
  if (speaker === 'You') return;              // others noticing you, not you saying it
  if (!MUTED_RE.test(text || '')) return;
  if (nowMs() - muteNudgeAt < 8000) return;   // debounce
  muteNudgeAt = nowMs();
  muteEl.hidden = false; setTimeout(() => { muteEl.hidden = true; }, 6000);
  if (cueArmed) riskCue('You may be muted');
}
function nowMs() { return performance.now(); }

// Personal-mention alert: fire when someone else names you (from your options "Your name(s)" list).
let nameRe = null;
let mentionAt = 0;
function buildNameRe(names) {
  // No default: a shipped name list would fire someone else's mention alerts on a stranger's meeting,
  // and a missed alert is a smaller failure than an alert about a person who is not in the room.
  const parts = String(names || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  nameRe = parts.length ? new RegExp(`\\b(${parts.join('|')})\\b`, 'i') : null;
}
function checkMention(speaker, text) {
  if (speaker === 'You' || !nameRe || !nameRe.test(text || '')) return;
  if (nowMs() - mentionAt < 6000) return;
  mentionAt = nowMs();
  mentionEl.hidden = false; setTimeout(() => { mentionEl.hidden = true; }, 6000);
  if (cueArmed) riskCue('You were mentioned');
}

function appendLine({ ts, speaker, text }) {
  if (!hasLines) { logEl.innerHTML = ''; hasLines = true; }
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const div = document.createElement('div');
  div.className = 'line';
  const t = document.createElement('span'); t.className = 'ts'; t.textContent = ts || '';
  div.append(t);
  if (speaker) { const w = document.createElement('span'); w.className = 'who'; w.textContent = speaker + ': '; div.append(w); }
  linkify(div, text);
  logEl.appendChild(div);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- advice --------------------------------------------------------------
// Safe inline rich rendering - no innerHTML. Supports bare URLs, [text](url), ![alt](url) images,
// **bold**, and `code`. Everything else stays literal text.
// The issue tracker is configurable: Jira and Linear share the `ABC-123` key shape, and other tools have no
// short keys at all. `trackerName` is what the Draft button and the assistant call the thing they produce;
// `trackerUrl` is an optional link template with `{key}`. A team on Asana or plain email sets no URL and the
// keys stay literal text - which is the right default, since linking a key to the wrong tool is worse than
// not linking it. `mla_jira_base` is migrated to this on load (see setSession's storage read).
let trackerName = '';   // e.g. "Jira", "Linear"; blank = a plain note, no tool assumed
let trackerUrl = '';    // e.g. "https://team.atlassian.net/browse/{key}"; needs {key} to link at all
// Tokens shaped like a key but that never are one, so a stray "GPT-4" in advice is not turned into a link.
const KEY_DENY = /^(UTF|GPT|SHA|ISO|RFC|CVE|AES|IPV|MP|ID|PR|CI|HTTP|HTTPS|COVID|IE|MS|H)$/;
function trackerLink(key) {
  if (!trackerUrl || !trackerUrl.includes('{key}') || KEY_DENY.test(key.split('-')[0])) return null;
  const a = document.createElement('a');
  a.href = trackerUrl.replace('{key}', encodeURIComponent(key));
  a.textContent = key; a.target = '_blank'; a.rel = 'noreferrer';
  a.title = trackerName ? `Open ${key} in ${trackerName}` : `Open ${key}`;
  return a;
}
// Linkify PLAIN text (transcript, item text): URLs + Jira keys → <a>, everything else stays text.
const LINKIFY_RE = /(https?:\/\/[^\s]+)|(\b[A-Z][A-Z0-9]{1,5}-\d+\b)/g;
function linkify(parent, text) {
  const s = String(text || ''); let last = 0; let m; LINKIFY_RE.lastIndex = 0;
  while ((m = LINKIFY_RE.exec(s))) {
    if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
    if (m[1]) { const a = document.createElement('a'); a.href = m[1]; a.textContent = m[1]; a.target = '_blank'; a.rel = 'noreferrer'; parent.appendChild(a); }
    else parent.appendChild(trackerLink(m[2]) || document.createTextNode(m[2]));
    last = m.index + m[0].length;
  }
  if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
}

const RICH = [
  { re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/, kind: 'img' },
  { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, kind: 'link' },
  { re: /(https?:\/\/[^\s]+)/, kind: 'url' },
  { re: /\b[A-Z][A-Z0-9]{1,5}-\d+\b/, kind: 'jira' },
  { re: /\*\*([^*]+)\*\*/, kind: 'bold' },
  { re: /`([^`]+)`/, kind: 'code' },
  // Auto-emphasise the highest-stakes tokens so they pop even when the brain didn't bold them:
  // money, number+unit (SP/pts/%/days/…), times, ISO dates, and 3+-digit counts (SP totals, refs).
  { re: /([$€£]\s?\d[\d.,]*|\b\d[\d.,]*\s?%|\b\d[\d.,]*\s?(?:SP|pts?|points?|days?|weeks?|hrs?|hours?|mins?|minutes?)\b|\b\d{1,2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b)/i, kind: 'num' },
];
function renderInline(parent, line) {
  let rest = line;
  while (rest) {
    let best = null;
    for (const p of RICH) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { p, m };
    }
    if (!best) { parent.appendChild(document.createTextNode(rest)); break; }
    if (best.m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, best.m.index)));
    const [full, g1, g2] = best.m;
    if (best.p.kind === 'img') { const i = document.createElement('img'); i.src = g2; i.alt = g1 || ''; i.className = 'rich-img'; parent.appendChild(i); }
    else if (best.p.kind === 'link') { const a = document.createElement('a'); a.href = g2; a.textContent = g1; a.target = '_blank'; a.rel = 'noreferrer'; parent.appendChild(a); }
    else if (best.p.kind === 'url') { const a = document.createElement('a'); a.href = g1; a.textContent = g1; a.target = '_blank'; a.rel = 'noreferrer'; parent.appendChild(a); }
    else if (best.p.kind === 'jira') { parent.appendChild(trackerLink(full) || document.createTextNode(full)); }
    else if (best.p.kind === 'bold') { const b = document.createElement('strong'); renderInline(b, g1); parent.appendChild(b); } // recurse so a Jira key / URL inside **…** still links
    else if (best.p.kind === 'code') { const c = document.createElement('code'); c.textContent = g1; parent.appendChild(c); }
    else if (best.p.kind === 'num') { const s = document.createElement('span'); s.className = 'kw-num'; s.textContent = full; parent.appendChild(s); }
    rest = rest.slice(best.m.index + full.length);
  }
}
// Block-level: fenced ``` code, - / * bullet lists, 1. numbered lists, else inline paragraphs.
function renderRich(parent, text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  const isBullet = (l) => /^\s*[-*]\s+/.test(l);
  const isNum = (l) => /^\s*\d+\.\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      const pre = document.createElement('pre'); pre.className = 'rich-pre';
      const code = document.createElement('code'); code.textContent = buf.join('\n');
      pre.appendChild(code); parent.appendChild(pre);
      continue;
    }
    if (isBullet(line) || isNum(line)) {
      const num = isNum(line);
      const list = document.createElement(num ? 'ol' : 'ul'); list.className = 'rich-list';
      const match = num ? isNum : isBullet;
      while (i < lines.length && match(lines[i])) {
        const li = document.createElement('li');
        renderInline(li, lines[i].replace(num ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''));
        list.appendChild(li); i++;
      }
      parent.appendChild(list);
      continue;
    }
    renderInline(parent, line);
    const next = lines[i + 1];
    if (next !== undefined && !next.trim().startsWith('```') && !isBullet(next) && !isNum(next)) {
      parent.appendChild(document.createElement('br'));
    }
    i++;
  }
}

// SAY = words to actually speak. Split the quoted line(s) (what to say, rendered prominent) from any
// framing/why (rendered muted) so the user reads their line at a glance. No quotes → whole body is the line.
function renderSay(parent, text) {
  const s = String(text || '');
  const re = /["“”]([^"“”]+)["“”]/g;
  let last = 0; let m; let any = false;
  const seg = (cls, str) => { const e = document.createElement('span'); e.className = cls; renderInline(e, str); parent.appendChild(e); };
  while ((m = re.exec(s))) {
    any = true;
    if (m.index > last) seg('say-frame', s.slice(last, m.index));
    seg('say-quote', m[1]);
    last = m.index + m[0].length;
  }
  if (last < s.length) seg(any ? 'say-frame' : 'say-quote', s.slice(last)); // no quotes at all → all speakable
}

// ---- list controls: keyword filter + per-item delete / suppress-similar ----
let adviceFilter = '', itemFilter = '';
async function suppress(text, kind) {
  if (!currentSession || !text) return;
  try { await fetch(`${serverUrl}/suppress`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ session: currentSession, text, kind }) }); } catch (_) {}
}
function iconBtn(label, title, onClick) {
  const b = document.createElement('button'); b.className = 'speak-btn'; b.textContent = label; b.title = title;
  b.addEventListener('click', onClick); return b;
}
function applyFilter(container, sel, filter) {
  for (const el of container.querySelectorAll(sel)) el.hidden = !!filter && !(el.dataset.text || '').includes(filter);
}

// A brain refining the same thought mid-call otherwise piles up near-duplicate cards (noise).
// Detect the refined version, replace the earlier card, resurface it with an "updated" badge.
// Crude singularize (credits→credit, limits→limit) so plural rewording still matches; skip -ss (class, access).
function normTokens(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((w) => w.length > 2).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
function similarity(a, b) {
  const A = new Set(normTokens(a)); const B = new Set(normTokens(b));
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0; A.forEach((w) => { if (B.has(w)) inter++; });
  const jaccard = inter / (A.size + B.size - inter);
  const an = [...A].join(' '); const bn = [...B].join(' ');
  const contained = an.includes(bn) || bn.includes(an) ? 0.15 : 0; // brain expanded/tightened same point
  return Math.min(1, jaccard + contained);
}
function findSimilarCard(container, sel, text, min = 0.5) {
  let best = null; let bestScore = 0;
  for (const el of container.querySelectorAll(sel)) {
    const s = similarity(text, el.dataset.text || '');
    if (s > bestScore) { bestScore = s; best = el; }
  }
  return bestScore >= min ? best : null;
}
function updatedBadge(n) {
  const u = document.createElement('span'); u.className = 'upd-badge';
  u.textContent = n > 1 ? `✎ updated ×${n}` : '✎ updated';
  u.title = `Refined during the call${n > 1 ? ` (${n}×)` : ''} - replaces an earlier, similar suggestion`;
  return u;
}
// Filtering a single card is pointless - only surface the search box once there's something to sift.
function toggleSearch(inputId, container, sel, clearFilter) {
  const el = document.getElementById(inputId);
  const show = container.querySelectorAll(sel).length > 1;
  el.hidden = !show;
  if (!show && el.value) { el.value = ''; clearFilter(); applyFilter(container, sel, ''); }
}
function syncSearchVisibility() {
  toggleSearch('adviceSearch', adviceEl, '.advice-item', () => { adviceFilter = ''; });
  toggleSearch('itemSearch', itemsEl, '.item', () => { itemFilter = ''; });
}

function appendAdvice({ marker, text, image }) {
  if (!hasAdvice) { adviceEl.innerHTML = ''; hasAdvice = true; }
  const m = (marker || 'INFO').toUpperCase();
  const dup = text ? findSimilarCard(adviceEl, '.advice-item', text) : null;
  const upd = dup ? Number(dup.dataset.uc || 0) + 1 : 0;
  if (dup) dup.remove();
  const div = document.createElement('div');
  div.className = 'advice-item ' + (MARKER_LABEL[m] ? m : 'INFO');
  const mk = document.createElement('span'); mk.className = 'marker'; mk.textContent = MARKER_LABEL[m] || '🔵 INFO';
  mk.title = MARKER_TIP[m] || MARKER_TIP.INFO;
  const bd = document.createElement('span'); bd.className = 'body';
  if (m === 'SAY') renderSay(bd, text); else renderRich(bd, text);
  if (image && /^(https?:|data:image\/)/.test(image)) {
    const img = document.createElement('img'); img.src = image; img.className = 'rich-img'; bd.appendChild(img);
  }
  div.append(mk, bd);
  if (upd) { div.dataset.uc = String(upd); div.append(updatedBadge(upd)); div.classList.add('flash'); }
  if (m === 'SAY' && text) {
    const sp = document.createElement('button');
    sp.className = 'speak-btn'; sp.textContent = '🔊'; sp.title = 'Speak this (TTS)';
    sp.addEventListener('click', () => speak(text, sp));
    div.append(sp);
  }
  if (text) {
    const cp = document.createElement('button');
    cp.className = 'speak-btn'; cp.textContent = '📋'; cp.title = 'Copy (paste into Meet chat)';
    cp.addEventListener('click', () => navigator.clipboard.writeText(text)
      .then(() => { cp.textContent = '✓'; setTimeout(() => { cp.textContent = '📋'; }, 900); }).catch(() => {}));
    div.append(cp);
  }
  div.append(iconBtn('✕', 'Remove this advice', () => { div.remove(); syncSearchVisibility(); }));
  if (text) div.append(iconBtn('🚫', 'Remove & stop suggesting similar', () => { div.remove(); syncSearchVisibility(); suppress(text, 'advice'); }));
  div.dataset.text = (text || '').toLowerCase();
  if (adviceFilter && !div.dataset.text.includes(adviceFilter)) div.hidden = true;
  adviceEl.appendChild(div);
  adviceEl.scrollTop = adviceEl.scrollHeight;
  syncSearchVisibility();
  if (m === 'RISK' && cueArmed) riskCue(text);
}

// Pick a voice matching the SAY text's language. SAY phrasing is in the meeting's spoken
// language (usually English); Polish is detected by its diacritics.
function pickVoice(text) {
  if (callLang === 'pl') return ttsVoicePl;
  if (callLang === 'en') return ttsVoiceEn;
  // Unknown call language (or a language we don't have a voice for) → fall back to text heuristic.
  return /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(text) ? ttsVoicePl : ttsVoiceEn;
}

async function meetTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  const t = tabs.find((x) => x.active) || tabs[0];
  return t && t.id;
}
async function micUnmute() {
  const id = await meetTabId();
  if (!id) return null;
  try {
    const r = await chrome.tabs.sendMessage(id, { type: 'mic', action: 'unmute' });
    return r && r.ok ? { id, wasMuted: r.wasMuted } : null;
  } catch (_) { return null; }
}
async function micRestore(info) {
  if (!info || !info.wasMuted) return;
  try { await chrome.tabs.sendMessage(info.id, { type: 'mic', action: 'restore', wasMuted: true }); } catch (_) {}
}

async function speak(text, btn) {
  if (btn) btn.disabled = true;
  const intoCall = document.getElementById('ttsCall').checked;
  let mic = null;
  let ok = true;
  setStatus(speakEl, intoCall ? '🔊 speaking → call' : '🔊 speaking', 'ok');
  speakEl.hidden = false;
  try {
    if (intoCall) mic = await micUnmute(); // unmute Meet so the TTS is actually transmitted
    const r = await fetch(`${serverUrl}/speak`, {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, text, voice: pickVoice(text), device: intoCall ? 'BlackHole' : null }),
    });
    ok = r.ok;
  } catch (_) { ok = false; } finally {
    await micRestore(mic); // re-mute only if it was muted before
    setStatus(speakEl, ok ? '🔊 spoke ✓' : '🔊 failed', ok ? 'ok' : 'bad');
    setTimeout(() => { speakEl.hidden = true; }, 2000);
    if (btn) setTimeout(() => { btn.disabled = false; }, 300);
  }
}

function resetAdvice() {
  adviceEl.innerHTML = '<div class="empty small">Suggestions will appear here live…</div>';
  hasAdvice = false; lastAdviceSeq = 0;
  syncSearchVisibility();
  // Redraw the checklist immediately. Without this the box sat on its placeholder until some step happened to
  // change, so clearing a meeting or starting a new one lost the one piece of guidance on the screen.
  if (typeof renderSetupSteps === 'function') renderSetupSteps();
}

// Server seq only grows within one server lifetime; if `last` comes back BELOW our cursor the transcript
// server restarted (its in-memory queue reset to 0). Resync from 0 so we don't miss the fresh queue -
// otherwise Math.max would pin the stale-high cursor and drop every post-restart message.
function nextSeq(cur, last) {
  if (typeof last !== 'number') return cur;
  return last < cur ? 0 : Math.max(cur, last);
}

// A first-run panel used to show: an idle pill, a red "no capture - reload the Meet tab" even with no meeting
// tab open at all, three pills reading `?`, an empty chat, and a setup checklist that opened itself with red
// crosses. The install had worked. It read as broken, at the exact moment someone decides whether to keep it.
//
// So the empty state is the onboarding: the four things that have to be true, each showing whether it is,
// each naming the one action that makes it true. It replaces itself with advice the moment advice arrives.
const SETUP_STEPS = [
  { key: 'server',    label: 'Bridge server running',
    todo: 'start it: node server/transcript-server.js --pair' },
  { key: 'paired',    label: 'Extension paired with the server',
    todo: 'run the server with --pair, or paste the token in Options' },
  { key: 'capture',   label: 'In a Google Meet or Zoom call',
    todo: 'open a call - if one is already open, reload that tab' },
  { key: 'assistant', label: 'Assistant attached',
    todo: 'open Claude Code and ask it to assist your meeting' },
];
const setupState = { server: null, paired: null, capture: null, assistant: null };

function renderSetupSteps() {
  if (hasAdvice) return; // real advice outranks onboarding, and never gets replaced by it
  const box = adviceEl.querySelector('.empty');
  if (!box) return;
  box.textContent = '';
  const done = SETUP_STEPS.filter((s) => setupState[s.key] === true).length;
  const head = document.createElement('div');
  head.style.marginBottom = '6px';
  head.textContent = done === SETUP_STEPS.length
    ? 'Ready. Advice will appear here as the call goes on.'
    : `Setup ${done}/${SETUP_STEPS.length} - advice appears here once these are true:`;
  box.appendChild(head);
  for (const step of SETUP_STEPS) {
    const st = setupState[step.key];
    const row = document.createElement('div');
    row.style.margin = '3px 0';
    const mark = document.createElement('span');
    mark.textContent = st === true ? '✓ ' : st === false ? '· ' : '  ';
    mark.style.opacity = st === true ? '1' : '.6';
    row.appendChild(mark);
    const name = document.createElement('span');
    name.textContent = step.label;
    if (st === true) name.style.opacity = '.55';
    row.appendChild(name);
    // The action only helps where it is needed, and only for the first thing that is missing - a wall of
    // four instructions is the same as none.
    if (st === false && SETUP_STEPS.find((x) => setupState[x.key] !== true) === step) {
      const todo = document.createElement('div');
      todo.style.cssText = 'margin:2px 0 6px 14px;opacity:.75;';
      todo.textContent = `→ ${step.todo}`;
      row.appendChild(todo);
    }
    box.appendChild(row);
  }
}

function setSetupStep(key, ok) {
  if (setupState[key] === ok) return;
  setupState[key] = ok;
  renderSetupSteps();
}

// Kept for the call sites that already tracked liveness; it just feeds the checklist now.
function setBrainEmpty(live) { setSetupStep('assistant', !!live); }

// Two failures that leave everything else looking green: the wake channel cannot be written (so the
// assistant receives nothing) or local speech-to-text is erroring (so nothing is transcribed). Both used to
// be a line in a log file nobody tails. Said once per distinct problem, in the panel, in plain words.
let lastPipelineProblem = '';
function showPipelineProblem(wakeError, sttError) {
  const problem = wakeError ? `wake:${wakeError.message}` : (sttError ? `stt:${sttError.message}` : '');
  if (problem === lastPipelineProblem) return;
  lastPipelineProblem = problem;
  if (!problem) return;
  const text = wakeError
    ? `⚠ **Your assistant is not receiving this meeting.** The server cannot write the channel it reads: ${wakeError.message}. The transcript file is still complete - this is about delivery, not the recording.`
    : `⚠ **Speech-to-text is failing**, so nothing is being transcribed from audio: ${sttError.message}. Captions, if the meeting has them, are unaffected.`;
  appendChat({ role: 'agent', text });
}

async function pollBrain() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/brain-ping?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) { setBrainWork(''); return; } // can't confirm activity → don't leave a stale bubble pinned
    const { ageMs, status, statusAgeMs, estTokens, agent, wakeError, sttError } = await r.json();
    // A pipeline that is failing has to say so here, because every other signal looks healthy: capture is
    // green, the server is green, the assistant is heartbeating - and nothing is reaching it.
    showPipelineProblem(wakeError, sttError);
    const live = ageMs != null && ageMs < 45000; // heartbeat within 45s = attached
    // Name the attached agent so it's obvious WHICH one is on (multiple agents share the machine).
    setStatus(brainEl, live ? `🧠 ${agent || 'assistant'} on` : '🧠 no assistant', live ? 'ok' : 'bad');
    setBrainEmpty(live);
    // Show a live "working…" bubble while the agent is mid-action; stale (>30s) = drop it (crash guard).
    setBrainWork(live && status && statusAgeMs != null && statusAgeMs < 30000 ? status : '');
    renderTokenEst(estTokens);
  } catch (_) { setBrainWork(''); /* server down - srv pill already reflects it */ }
}

// A single, reused typing/working indicator pinned to the bottom of the Chat section.
let brainWorkEl = null;
function setBrainWork(text) {
  if (!text) { if (brainWorkEl) { brainWorkEl.remove(); brainWorkEl = null; } return; }
  if (!brainWorkEl) {
    brainWorkEl = document.createElement('div');
    brainWorkEl.className = 'chat-msg agent working';
    const dots = document.createElement('span'); dots.className = 'work-dots';
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const label = document.createElement('span'); label.className = 'work-label';
    brainWorkEl.append(dots, label);
  }
  brainWorkEl.querySelector('.work-label').textContent = text;
  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
  chatEl.appendChild(brainWorkEl); // keep pinned below the latest message
  if (atBottom) chatEl.scrollTop = chatEl.scrollHeight; // don't yank the view if user scrolled up to read
}

// Volume-based token estimate near the chat (server computes it). Directional gauge, not billing.
function fmtTok(n) {
  if (!n || n < 1) return null;
  if (n < 1000) return String(n);
  const k = Math.round(n / 1000); // round first, then roll over so 999.5k shows as 1M, not "1000k"
  return k >= 1000 ? (k / 1000).toFixed(1).replace(/\.0$/, '') + 'M' : k + 'k';
}
function renderTokenEst(n) {
  const s = fmtTok(n);
  if (!s) { tokenEstEl.hidden = true; return; }
  tokenEstEl.textContent = `⛃ ~${s} tok (est.)`;
  tokenEstEl.hidden = false;
}

async function pollAdvice() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/advice?session=${encodeURIComponent(currentSession)}&since=${lastAdviceSeq}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendAdvice);
    lastAdviceSeq = nextSeq(lastAdviceSeq, last);
  } catch (_) { /* server down - transcript-side status already reflects it */ }
}

async function pollSnapRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/snapshot-request?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { seq } = await r.json();
    if (typeof seq !== 'number') return;
    if (lastReqSeq < 0) { lastReqSeq = seq; return; } // first poll = baseline, don't fire
    if (seq > lastReqSeq) { lastReqSeq = seq; requestCapture(); } // agent asked for a shot
  } catch (_) { /* server down */ }
}

function requestCapture(auto) { try { port.postMessage({ type: 'snapshot-now', auto: !!auto }); } catch (_) {} }

// ---- decisions & action items (the board) --------------------------------
function resetItems() { itemsEl.innerHTML = '<div class="empty small">Decisions and action items will appear here…</div>'; hasItems = false; lastItemsSeq = 0; syncSearchVisibility(); }
function appendItem({ kind, text, owner, blockedBy }) {
  if (!hasItems) { itemsEl.innerHTML = ''; hasItems = true; }
  const decision = kind === 'decision';
  const dup = text ? findSimilarCard(itemsEl, '.item.' + (decision ? 'decision' : 'action'), text) : null;
  const upd = dup ? Number(dup.dataset.uc || 0) + 1 : 0;
  if (dup) dup.remove();
  const div = document.createElement('div');
  div.className = 'item ' + (decision ? 'decision' : 'action');
  const k = document.createElement('span'); k.className = 'kind'; k.textContent = decision ? 'DECISION' : 'ACTION';
  k.title = decision ? 'A decision reached in the meeting' : 'An action item / to-do (click text to mark done)';
  const body = document.createElement('div'); body.className = 'body';
  const txt = document.createElement('div'); txt.className = 'txt'; renderInline(txt, text);
  txt.title = 'Click to mark done'; txt.addEventListener('click', (e) => { if (e.target.tagName === 'A') return; div.classList.toggle('done'); });
  body.appendChild(txt);
  if (owner || blockedBy) {
    const meta = document.createElement('div'); meta.className = 'meta';
    const parts = [['owner: ', owner], ['blocked by: ', blockedBy]].filter(([, v]) => v);
    parts.forEach(([label, val], idx) => {
      if (idx) meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(document.createTextNode(label));
      const s = document.createElement('strong'); s.textContent = val; meta.appendChild(s); // who/blocker is the scan-anchor
    });
    body.appendChild(meta);
  }
  div.append(k, body);
  if (upd) { div.dataset.uc = String(upd); div.append(updatedBadge(upd)); div.classList.add('flash'); }
  if (!decision) {
    // The tracker is whatever the user named in Options. With no name it is a plain note, which is the right
    // default for a recruiter, a teacher, a lawyer - anyone whose "action item" is not an engineering ticket.
    const noun = trackerName || 'note';
    const j = document.createElement('button'); j.className = 'jira'; j.textContent = `Draft ${noun}`;
    j.title = `Ask the assistant to draft a ${noun} for this (draft only)`;
    j.addEventListener('click', () => {
      const what = trackerName
        ? `Draft a ${trackerName} ticket (DRAFT only - do not create) for this action item`
        : `Draft a ready-to-send note (DRAFT only) capturing this action item`;
      sendChat(`${what}: "${text}"${owner ? ` - owner ${owner}` : ''}. Match the format the user's team uses.`);
    });
    div.append(j);
  }
  div.append(iconBtn('✕', 'Remove this item', () => { div.remove(); syncSearchVisibility(); }));
  if (!decision) div.append(iconBtn('🚫', 'Remove & stop suggesting similar', () => { div.remove(); syncSearchVisibility(); suppress(text, 'action'); }));
  div.dataset.text = (text || '').toLowerCase();
  if (itemFilter && !div.dataset.text.includes(itemFilter)) div.hidden = true;
  itemsEl.appendChild(div);
  itemsEl.scrollTop = itemsEl.scrollHeight;
  syncSearchVisibility();
}
async function pollItems() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/items?session=${encodeURIComponent(currentSession)}&since=${lastItemsSeq}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendItem);
    lastItemsSeq = nextSeq(lastItemsSeq, last);
  } catch (_) {}
}

// ---- autopilot (auto-create action items) + post links to the meeting chat ----
const autoCreateEl = document.getElementById('autoCreate');
const postChatEl = document.getElementById('postChat');
let lastCallChatSeq = -1; // baseline so old queued messages aren't replayed on (re)connect
async function postAutopilot() {
  if (!currentSession) return;
  try {
    await fetch(`${serverUrl}/autopilot`, { method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, create: autoCreateEl.checked, postChat: postChatEl.checked }) });
  } catch (_) {}
}
autoCreateEl.addEventListener('change', postAutopilot);
postChatEl.addEventListener('change', postAutopilot);
async function loadAutopilot() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/autopilot?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const a = await r.json();
    autoCreateEl.checked = !!a.create; postChatEl.checked = !!a.postChat;
  } catch (_) {}
}
async function pollCallChat() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/callchat?session=${encodeURIComponent(currentSession)}&since=${Math.max(lastCallChatSeq, 0)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    if (lastCallChatSeq < 0) { lastCallChatSeq = last || 0; return; } // baseline: don't replay old
    for (const it of items || []) {
      // The disclosure is not the autopilot. `postChat` is consent to share ticket links with the room;
      // `announce` is the line saying you are transcribing. Gating the second on the first meant the room
      // was never told, silently, on every call.
      if (it.announce || postChatEl.checked) { try { port.postMessage({ type: 'send-call-chat', text: it.text, seq: it.seq }); } catch (_) {} }
    }
    if (typeof last === 'number') lastCallChatSeq = Math.max(lastCallChatSeq, last);
  } catch (_) {}
}

/* mla:pro-start */
// ---- agent-driven page actions (flow testing) - opt-in "drive" ----
const driveBtn = document.getElementById('driveBtn');
const driveBar = document.getElementById('driveBar');
let driveOn = false;
let lastActSeq = -1;
async function postDrive(on) {
  if (!currentSession) return;
  try { await fetch(`${serverUrl}/drive`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ session: currentSession, on }) }); } catch (_) {}
}
function setDrive(on) { driveOn = on; driveBtn.classList.toggle('on', on); driveBar.hidden = !on; }
driveBtn.addEventListener('click', async () => {
  if (!driveOn) {
    if (!(await ensurePerms(ALL_URLS))) return; // acting on arbitrary tabs needs all-sites access
    setDrive(true); postDrive(true);
  } else { setDrive(false); postDrive(false); }
});
document.getElementById('driveStop').addEventListener('click', () => { setDrive(false); postDrive(false); });
async function loadDrive() {
  if (!currentSession) return;
  try { const r = await fetch(`${serverUrl}/drive?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() }); if (r.ok) setDrive(!!(await r.json()).on); } catch (_) {}
}
async function pollActs() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/act?session=${encodeURIComponent(currentSession)}&since=${Math.max(lastActSeq, 0)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    if (lastActSeq < 0) { lastActSeq = last || 0; return; } // baseline: don't replay old actions
    for (const cmd of items || []) {
      if (driveOn) { try { port.postMessage({ type: 'do-act', cmd }); } catch (_) {} } // double-guard the opt-in
    }
    if (typeof last === 'number') lastActSeq = Math.max(lastActSeq, last);
  } catch (_) {}
}
resetPro = () => setDrive(false);
loadPro = () => loadDrive();
/* mla:pro-end */

// ---- chat ----------------------------------------------------------------
function appendChat({ role, text, image }) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (role === 'agent' ? 'agent' : 'user');
  renderRich(div, text);
  if (image && /^(https?:|data:image\/)/.test(image)) {
    const img = document.createElement('img'); img.src = image; img.className = 'rich-img'; div.appendChild(img);
  }
  chatEl.appendChild(div);
  if (brainWorkEl) chatEl.appendChild(brainWorkEl); // keep the working indicator last
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Ask once, ever, after the first call ends - the only moment someone has actually formed an opinion and
// is not busy. Silence is the default outcome of a free tool, and silence is indistinguishable from nobody
// having tried it, which is the one thing worth knowing early.
const FEEDBACK_URL = 'https://github.com/krystiangw/meet-live-assist-extension/discussions';
async function maybeAskForFeedback() {
  try {
    const { mla_feedback_asked } = await chrome.storage.local.get('mla_feedback_asked');
    if (mla_feedback_asked) return;
    await chrome.storage.local.set({ mla_feedback_asked: Date.now() });
    appendChat({
      role: 'agent',
      text: `That was your first call with me. Was it any use? Even "I gave up during the install" is worth`
        + ` saying - it is the most useful thing you can tell me: ${FEEDBACK_URL}`,
    });
  } catch (_) {}
}

async function pollChat() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/chat?session=${encodeURIComponent(currentSession)}&since=${lastChatSeq}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    (items || []).forEach(appendChat);
    lastChatSeq = nextSeq(lastChatSeq, last);
  } catch (_) { /* server down */ }
}

async function sendChat(text) {
  if (!text || !currentSession) return;
  try {
    await fetch(`${serverUrl}/chat`, {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, role: 'user', text }),
    });
    pollChat(); // reflect immediately
  } catch (_) {}
}

const COMMANDS = [
  {
    name: '/snapshot', aliases: ['/snap', '/shot'], arg: null,
    desc: 'Send a screen snapshot to the assistant',
    run: () => { try { port.postMessage({ type: 'snapshot-now' }); } catch (_) {} },
  },
  { name: '/summary', aliases: [], arg: null, desc: 'Fetch & copy the post-call summary', run: () => doSummary() },
  { name: '/clear', aliases: [], arg: null, desc: 'Clear the transcript', run: () => doClear() },
  { name: '/pause', aliases: [], arg: null, desc: 'Pause capture + advice', run: () => applyPause(true) },
  { name: '/resume', aliases: [], arg: null, desc: 'Resume', run: () => applyPause(false) },
  { name: '/stop', aliases: [], arg: null, desc: 'Stop & wrap up', run: () => applyStop() },
  {
    name: '/autopilot', aliases: [], arg: 'on|off', desc: 'Toggle auto-create of decisions/actions',
    run: (argText) => { autoCreateEl.checked = argText.trim() === 'on'; postAutopilot(); },
  },
  {
    name: '/postchat', aliases: [], arg: 'on|off', desc: 'Toggle posting links to call chat',
    run: (argText) => { postChatEl.checked = argText.trim() === 'on'; postAutopilot(); },
  },
  { name: '/suppress', aliases: [], arg: '<text>', desc: 'Suppress advice like this', run: (argText) => suppress(argText, 'any') },
  { name: '/ask', aliases: [], arg: '<question>', desc: 'Ask the assistant', run: (argText) => sendChat(argText) },
  {
    name: '/recap', aliases: [], arg: null, desc: 'Quick recap so far',
    run: () => sendChat('Quick recap of the discussion so far, please - 3 bullets max.'),
  },
  {
    name: '/explain', aliases: [], arg: '<term>', desc: 'Explain a term/decision',
    run: (argText) => sendChat('Explain briefly: ' + argText),
  },
  {
    name: '/draft', aliases: [], arg: '<action item>', desc: 'Draft a Jira ticket (DRAFT only)',
    run: (argText) => sendChat('Draft a Jira ticket (DRAFT only - do not create) for this action item: "' + argText + '". Use the team\'s Goal / Summary / Test plan sections.'),
  },
];
let cmdMatches = [];
let cmdFocus = 0;

function findCommand(token) {
  return COMMANDS.find((cmd) => cmd.name === token || cmd.aliases.includes(token));
}
function hideCommandMenu() {
  cmdMenu.hidden = true;
  cmdMatches = [];
  cmdFocus = 0;
}
function renderCommandMenu() {
  const value = chatInput.value;
  if (!value.startsWith('/') || value.includes(' ')) { hideCommandMenu(); return; }
  const token = value.toLowerCase();
  cmdMatches = COMMANDS.filter((cmd) => [cmd.name, ...cmd.aliases].some((name) => name.startsWith(token)));
  if (!cmdMatches.length) { hideCommandMenu(); return; }
  cmdFocus = Math.min(cmdFocus, cmdMatches.length - 1);
  cmdMenu.innerHTML = '';
  cmdMatches.forEach((cmd, index) => {
    const row = document.createElement('div');
    row.className = 'cmd-row' + (index === cmdFocus ? ' focused' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', index === cmdFocus ? 'true' : 'false');
    const name = document.createElement('span'); name.className = 'cmd-name';
    name.textContent = cmd.name + (cmd.arg ? ` ${cmd.arg}` : '');
    const desc = document.createElement('span'); desc.className = 'cmd-desc'; desc.textContent = cmd.desc;
    row.append(name, desc);
    row.addEventListener('mousedown', (e) => { e.preventDefault(); chooseCommand(cmd); });
    cmdMenu.appendChild(row);
  });
  cmdMenu.hidden = false;
}
function completeCommand(cmd) {
  chatInput.value = cmd.name + (cmd.arg ? ' ' : '');
  hideCommandMenu();
  chatInput.focus();
}
function runCommand(cmd, argText) {
  if (cmd.arg && !argText.trim()) { completeCommand(cmd); return false; }
  chatInput.value = '';
  hideCommandMenu();
  cmd.run(argText);
  return true;
}
function chooseCommand(cmd) {
  if (cmd.arg) completeCommand(cmd);
  else runCommand(cmd, '');
}

chatInput.addEventListener('input', () => { cmdFocus = 0; renderCommandMenu(); });
chatInput.addEventListener('keydown', (e) => {
  if (cmdMenu.hidden) {
    if (e.key === 'Escape') hideCommandMenu();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    cmdFocus = (cmdFocus + step + cmdMatches.length) % cmdMatches.length;
    renderCommandMenu();
  } else if (e.key === 'Tab' || e.key === 'ArrowRight') {
    e.preventDefault();
    completeCommand(cmdMatches[cmdFocus]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideCommandMenu();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    chooseCommand(cmdMatches[cmdFocus]);
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const [token] = text.split(/\s+/, 1);
  const cmd = findCommand(token.toLowerCase());
  if (cmd) {
    const argText = text.slice(token.length).trim();
    runCommand(cmd, argText);
    return;
  }
  chatInput.value = '';
  hideCommandMenu();
  sendChat(text);
});

// Quick-ask chips → preset chat prompts (recap / mentioned-me / action-items).
document.getElementById('quickAsk').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ask]');
  if (btn) sendChat(btn.dataset.ask);
});

function setSharing(on) {
  sharing = !!on;
  shareEl.hidden = !sharing;
  clearInterval(shareTimer);
  if (sharing) {
    requestCapture(false); // grab one immediately (force) when sharing starts
    shareTimer = setInterval(() => requestCapture(true), 4000); // sample often; SW forwards only on visual change
  }
}

/* mla:pro-start */
async function pollEdits() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/edit?session=${encodeURIComponent(currentSession)}&since=${Math.max(lastEditSeq, 0)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { items, last } = await r.json();
    if (lastEditSeq < 0) { lastEditSeq = last || 0; return; } // baseline: don't re-apply old edits
    // Same gate pollActs has. The red banner and the 🕹 toggle READ as the consent control for page
    // control; without this they were the consent control for one route out of four, while /edit assigns
    // innerHTML in the user's logged-in tab and /debug hands back its cookies.
    for (const cmd of items || []) { if (driveOn) { try { port.postMessage({ type: 'apply-edit', cmd }); } catch (_) {} } }
    if (typeof last === 'number') lastEditSeq = Math.max(lastEditSeq, last);
  } catch (_) {}
}
async function pollDomRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/dom-request?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { seq } = await r.json();
    if (lastDomReqSeq < 0) { lastDomReqSeq = seq; return; }
    if (seq > lastDomReqSeq) { lastDomReqSeq = seq; if (driveOn) { try { port.postMessage({ type: 'capture-dom' }); } catch (_) {} } }
  } catch (_) {}
}

async function pollDebugRequest() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/debug-request?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { seq, kind } = await r.json();
    if (lastDbgReqSeq < 0) { lastDbgReqSeq = seq; return; }
    if (seq > lastDbgReqSeq) { lastDbgReqSeq = seq; if (driveOn) { try { port.postMessage({ type: 'debug-do', kind }); } catch (_) {} } }
  } catch (_) {}
}

dbgToggle.addEventListener('change', async () => {
  // `debugger` is a required permission; the scripting-based debug kinds (storage/perf) still need all-sites.
  if (dbgToggle.checked && !(await ensurePerms(ALL_URLS))) {
    dbgToggle.checked = false; dbgEl.hidden = false; setStatus(dbgEl, '🐞 needs all-sites access', 'bad'); return;
  }
  try { port.postMessage({ type: 'debug-toggle', on: dbgToggle.checked }); } catch (_) {}
  dbgEl.hidden = false; setStatus(dbgEl, dbgToggle.checked ? '🐞 attaching…' : '🐞 off', 'idle');
});
pollPro = () => { pollActs(); pollEdits(); pollDomRequest(); pollDebugRequest(); };
/* mla:pro-end */

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollAdvice(); pollItems(); pollCallChat(); pollSnapRequest(); pollChat(); pollPro(); }, 1500);
  clearInterval(brainTimer);
  brainTimer = setInterval(pollBrain, 5000); // liveness is coarse - no need to poll it fast
}

// ---- SW port (transcript + status) ---------------------------------------
function onMessage(msg) {
  switch (msg.type) {
    case 'restore':
      clearLog();
      if (msg.session) { setStatus(capEl, 'capturing', 'ok'); sessionEl.textContent = msg.session; setSession(msg.session); }
      (msg.buffer || []).forEach(appendLine);
      setSharing(!!msg.sharing);
      if (msg.lang) callLang = msg.lang;
      setPausedUI(!!msg.paused);
      break;
    case 'session': {
      clearLog(); resetAdvice(); resetItems(); resetSnap();
      const isCopilot = msg.code === 'copilot';
      setStatus(capEl, isCopilot ? 'co-pilot' : 'capturing', 'ok');
      sessionEl.textContent = msg.session || '';
      copilotOn = isCopilot; copilotBtn.classList.toggle('on', isCopilot);
      document.getElementById('consent').hidden = isCopilot; // no participants to disclose to in co-pilot
      setSession(msg.session);
      setPausedUI(false); // a fresh session is never paused
      break;
    }
    case 'line': // STT lines (no id)
      setStatus(capEl, 'capturing', 'ok');
      appendLine(msg);
      checkMuted(msg.speaker, msg.text);
      checkMention(msg.speaker, msg.text);
      break;
    case 'cap':
      setStatus(capEl, 'capturing', 'ok');
      upsertCaption(msg.id, msg, false);
      break;
    case 'cap-final':
      setStatus(capEl, 'capturing', 'ok');
      upsertCaption(msg.id, msg, true);
      trackTalk(msg.speaker, msg.text);
      checkMuted(msg.speaker, msg.text);
      checkMention(msg.speaker, msg.text);
      break;
    case 'chat-in': // meeting-chat message captured into context
      appendLine({ ts: msg.ts, speaker: `💬 ${msg.sender}`, text: msg.text });
      checkMention(msg.sender, msg.text);
      break;
    case 'session-end':
      setStatus(capEl, 'ended', 'idle');
      setSharing(false);
      copilotOn = false; copilotBtn.classList.remove('on');
      resetPro();
      setPausedUI(false);
      maybeAskForFeedback();
      break;
    case 'paused':
      setPausedUI(!!msg.on);
      break;
    /* mla:pro-start */
    case 'act': {
      const el = document.getElementById('actStatus'); el.hidden = false;
      setStatus(el, msg.ok ? `🕹 ${msg.op} ✓` : `🕹 ${msg.op} ✗ ${msg.reason || ''}`.trim(), msg.ok ? 'ok' : 'bad');
      setTimeout(() => { el.hidden = true; }, 3000);
      break;
    }
    /* mla:pro-end */
    // Result of the SW's liveness probe (sent on panel open, and on demand). Without this the panel just
    // said "idle" while an orphaned content script scraped into the void - no way to tell from the UI.
    case 'capture-probe':
      if (msg.ok && msg.healed) setStatus(capEl, 'capture restored', 'ok');
      else if (!msg.ok && msg.reason === 'no call tab') setStatus(capEl, 'no Meet/Zoom tab', 'idle');
      else if (!msg.ok) setStatus(capEl, `⚠ capture: ${msg.reason}`, 'bad');
      break;
    case 'capture-health':
      if (!msg.ok) setStatus(capEl, '⚠ no captions - turn on CC / check language', 'bad');
      else setStatus(capEl, 'capturing', 'ok');
      break;
    case 'sharing':
      setSharing(msg.on);
      break;
    case 'lang':
      callLang = msg.lang;
      break;
    case 'server':
      if (!msg.ok && msg.status === 403) lastAuthWarnAt = Date.now();
      setStatus(srvEl, msg.ok ? 'server ✓' : (msg.status === 403 ? 'server ✗ (set token in options)' : 'server ✗ (start it)'), msg.ok ? 'ok' : 'bad');
      break;
    case 'snapshot':
      if (msg.ok) { snapErrUntil = 0; snapEl.onclick = null; snapEl.style.cursor = ''; lastSnapAt = Date.now(); shareFlashUntil = lastSnapAt + 1200; if (msg.count != null) lastSnapCount = msg.count; renderSnapAge(); }
      else if (msg.perm) {
        // Capturing an arbitrary shared tab needs All-sites - offer a one-click grant (a panel click is a gesture).
        snapErrUntil = Date.now() + 60000;
        setStatus(snapEl, '📷 grant screen access', 'bad');
        snapEl.title = 'Snapshots need All-sites access for the shared tab - click to grant';
        snapEl.style.cursor = 'pointer';
        snapEl.onclick = async () => { if (await ensurePerms(ALL_URLS)) { snapEl.onclick = null; snapEl.style.cursor = ''; snapErrUntil = 0; requestCapture(false); } };
      } else { snapErrUntil = Date.now() + 4000; setStatus(snapEl, `shot ✗ ${msg.reason || ''}`.trim(), 'bad'); }
      break;
    /* mla:pro-start */
    case 'debug':
      dbgEl.hidden = false;
      if (msg.on) { setStatus(dbgEl, '🐞 debugging', 'ok'); dbgToggle.checked = true; }
      else if (msg.reason) { setStatus(dbgEl, `🐞 ✗ ${msg.reason}`, 'bad'); dbgToggle.checked = false; }
      else { setStatus(dbgEl, '🐞 off', 'idle'); dbgToggle.checked = false; setTimeout(() => { dbgEl.hidden = true; }, 2000); }
      break;
    case 'debug-done':
      dbgEl.hidden = false; setStatus(dbgEl, `🐞 ${msg.kind} ✓`, 'ok');
      setTimeout(() => { if (!dbgToggle.checked) dbgEl.hidden = true; }, 2500);
      break;
    case 'edit':
      editEl.hidden = false;
      if (msg.ok) {
        const r = msg.result || {};
        const label = r.dom ? '✏ page read' : (r.reverted != null ? `✏ reverted ${r.reverted}` : `✏ edited ${r.count ?? ''}`.trim());
        setStatus(editEl, label, 'ok');
      } else setStatus(editEl, `✏ ✗ ${msg.reason || 'no match'}`, 'bad');
      setTimeout(() => { editEl.hidden = true; }, 3000);
      break;
    /* mla:pro-end */
    case 'stt':
      sttEl.hidden = false;
      if (msg.on) { setStatus(sttEl, '🎧 listening', 'ok'); sttToggle.checked = true; }
      else if (msg.reason) { setStatus(sttEl, '🎧 ✗ press ⌘⇧U on the Meet tab', 'bad'); sttToggle.checked = false; }
      else { sttEl.hidden = true; sttToggle.checked = false; }
      break;
  }
}

snapBtn.addEventListener('click', () => { try { port.postMessage({ type: 'snapshot-now' }); } catch (_) {} });

// Co-pilot: start/stop a meeting-less session (agent watches this tab + hears your mic).
const copilotBtn = document.getElementById('copilotBtn');
let copilotOn = false;
copilotBtn.addEventListener('click', async () => {
  if (!copilotOn) {
    if (!(await ensurePerms(ALL_URLS))) return; // co-pilot watches arbitrary tabs → needs all-sites access
    copilotOn = true; copilotBtn.classList.add('on');
    try { port.postMessage({ type: 'copilot-start' }); } catch (_) {}
  } else {
    copilotOn = false; copilotBtn.classList.remove('on');
    try { port.postMessage({ type: 'copilot-stop' }); } catch (_) {}
  }
});

// ---- session control: pause / resume / stop -------------------------------
// Pause holds capture + advice (SW drops caps/snapshots; brain obeys /control and stays silent);
// stop is a graceful end (brain wraps up), distinct from 🗑 clear which wipes data.
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
let paused = false;
function setPausedUI(on) {
  paused = !!on;
  pauseBtn.textContent = paused ? '⏵' : '⏸';
  pauseBtn.classList.toggle('on', paused);
  pauseBtn.title = paused
    ? 'Resume - restart capture & advice'
    : 'Pause - hold capture & advice; nothing is recorded until you resume';
  if (paused) setStatus(capEl, '⏸ paused', 'idle');
  else if (currentSession) setStatus(capEl, copilotOn ? 'co-pilot' : 'capturing', 'ok');
}
async function postControl(state) {
  if (!currentSession) return;
  try { await fetch(`${serverUrl}/control`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ session: currentSession, state }) }); } catch (_) {}
}
// Full pause/stop behavior lives here so both the buttons and the /pause,/resume,/stop
// slash commands apply it identically - postControl alone only notifies the server/brain,
// it does NOT tell the SW to actually drop captures or update the pause UI.
function applyPause(next) {
  if (!currentSession) return;
  setPausedUI(next); // optimistic; SW echoes a 'paused' broadcast that re-affirms it
  try { port.postMessage({ type: next ? 'pause' : 'resume' }); } catch (_) {}
  postControl(next ? 'paused' : 'running');
}
function applyStop() {
  if (!currentSession) return;
  if (!confirm('End this session? The assistant wraps up and stops capturing. Data is kept - use 🗑 to wipe.')) return;
  postControl('stopped');
  try { port.postMessage({ type: 'session-stop' }); } catch (_) {}
  setPausedUI(false);
  setStatus(capEl, 'ended', 'idle');
}
pauseBtn.addEventListener('click', () => applyPause(!paused));
stopBtn.addEventListener('click', applyStop);

const consentEl = document.getElementById('consent');
document.getElementById('consentDismiss').addEventListener('click', () => { consentEl.hidden = true; });

// Import pre-join context (a Gemini / AI "summarize so far", or highlighted text) into the transcript.
document.getElementById('ctxBtn').addEventListener('click', async () => {
  const ctxEl = document.getElementById('ctxStatus'); ctxEl.hidden = false;
  if (!currentSession) { setStatus(ctxEl, '📥 no active session', 'bad'); setTimeout(() => { ctxEl.hidden = true; }, 3000); return; }
  let tab = null;
  try { const tabs = await chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://*.zoom.us/*'] }); tab = tabs.find((t) => t.active) || tabs[0]; } catch (_) {}
  if (!tab) { setStatus(ctxEl, '📥 no meeting tab', 'bad'); setTimeout(() => { ctxEl.hidden = true; }, 3000); return; }
  let text = '';
  try { const r = await chrome.tabs.sendMessage(tab.id, { type: 'grab-context' }); text = (r && r.text) || ''; } catch (_) {}
  if (!text) { setStatus(ctxEl, '📥 highlight the summary first', 'bad'); setTimeout(() => { ctxEl.hidden = true; }, 3500); return; }
  try {
    const res = await fetch(`${serverUrl}/context`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ session: currentSession, text }) });
    setStatus(ctxEl, res.ok ? `📥 imported ${(await res.json()).chars} chars` : '📥 failed', res.ok ? 'ok' : 'bad');
  } catch (_) { setStatus(ctxEl, '📥 failed', 'bad'); }
  setTimeout(() => { ctxEl.hidden = true; }, 3500);
});

// ---- setup / health checklist --------------------------------------------
const setupEl = document.getElementById('setup');
let autoSetupShown = false;
// One compact row of status chips (icon + ✓/✗), full text in the tooltip - instead of six full lines.
function renderSetup(h, allSites) {
  const t = (h && h.tools) || {};
  const checks = [
    ['🖥', 'Local server', !!h, 'start transcript-server.js (launchd)'],
    ['🔑', 'Server token', !!serverToken, 'paste .mla-token into extension Options'],
    ['🎬', 'ffmpeg', !!t.ffmpeg, 'brew install ffmpeg (needed for TTS + STT)'],
    ['🎧', 'Local STT', !!(t.whisper && t.whisperModel), 'brew install whisper-cpp + ggml model'],
    ['🔊', 'BlackHole', !!t.blackhole, 'optional: BlackHole 2ch + Aggregate device (speak into call)'],
    ['🌐', 'All-sites', !!allSites, 'optional: co-pilot / snapshots / edits on any tab'],
  ];
  setupEl.innerHTML = '';
  const row = document.createElement('div'); row.className = 'setup-chips';
  for (const [icon, name, ok, hint] of checks) {
    const c = document.createElement('span'); c.className = 'chk ' + (ok ? 'ok' : 'bad');
    c.textContent = `${icon} ${ok ? '✓' : '✗'}`;
    c.title = ok ? name : `${name} - ${hint}`;
    row.appendChild(c);
  }
  if (!allSites) {
    const g = document.createElement('button'); g.className = 'setup-grant'; g.textContent = 'Grant';
    g.title = 'Grant all-sites access (co-pilot / snapshots / edits)';
    g.addEventListener('click', async () => { if (await ensurePerms(ALL_URLS)) fetchHealth(); });
    row.appendChild(g);
  }
  setupEl.appendChild(row);
  const note = document.createElement('div'); note.className = 'setup-note';
  note.textContent = 'Tip: set the meeting caption language to the spoken language (⋮ → Settings → Captions).';
  setupEl.appendChild(note);
  // ffmpeg and whisper are optional - only speech in and out need them. Counting them as missing opened
  // the setup panel on a first run that was working perfectly, which reads as "broken".
  const missing = !h || !serverToken;
  if (missing && !autoSetupShown) { autoSetupShown = true; setupEl.hidden = false; } // nudge once on first run
}
async function fetchHealth() {
  let h = null;
  try { const r = await fetch(`${serverUrl}/health`); if (r.ok) h = await r.json(); } catch (_) {}
  let allSites = false;
  try { allSites = await chrome.permissions.contains(ALL_URLS); } catch (_) {}
  renderSetup(h, allSites);
}
document.getElementById('setupBtn').addEventListener('click', () => { setupEl.hidden = !setupEl.hidden; if (!setupEl.hidden) fetchHealth(); });

document.getElementById('adviceSearch').addEventListener('input', (e) => { adviceFilter = e.target.value.trim().toLowerCase(); applyFilter(adviceEl, '.advice-item', adviceFilter); });
document.getElementById('itemSearch').addEventListener('input', (e) => { itemFilter = e.target.value.trim().toLowerCase(); applyFilter(itemsEl, '.item', itemFilter); });

function downloadText(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (_) {}
}
async function doSummary() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${serverUrl}/summary?session=${encodeURIComponent(currentSession)}`, { headers: hdrs() });
    if (!r.ok) return;
    const { text } = await r.json();
    if (text && text.trim()) { appendChat({ role: 'agent', text }); downloadText(`${currentSession}.summary.md`, text); }
    else { appendChat({ role: 'agent', text: '_No summary yet - ask the assistant to wrap up, or it writes one when the call ends._' }); }
  } catch (_) {}
}
document.getElementById('summaryBtn').addEventListener('click', doSummary);

async function doClear() {
  if (!currentSession || !confirm('Delete ALL data for this meeting (transcript, snapshots, chat)? This cannot be undone.')) return;
  try {
    const r = await fetch(`${serverUrl}/clear`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ session: currentSession }) });
    if (r.ok) { clearLog(); resetAdvice(); resetItems(); resetSnap(); chatEl.innerHTML = ''; brainWorkEl = null; lastChatSeq = 0; setStatus(capEl, 'cleared', 'idle'); }
  } catch (_) {}
}
document.getElementById('clearBtn').addEventListener('click', doClear);

sttToggle.addEventListener('change', () => {
  try { port.postMessage({ type: sttToggle.checked ? 'stt-start' : 'stt-stop' }); } catch (_) {}
  if (sttToggle.checked) { sttEl.hidden = false; setStatus(sttEl, '🎧 starting…', 'idle'); }
});

async function postMode(mode) {
  if (!currentSession) return;
  try {
    await fetch(`${serverUrl}/mode`, {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ session: currentSession, mode }),
    });
  } catch (_) {}
}
modeSel.addEventListener('change', () => { chrome.storage.local.set({ mla_mode: modeSel.value }); postMode(modeSel.value); });

// Tell the room. Enabling captions is invisible to the other participants - unlike recording, which Meet
// badges - so without this nobody in the meeting has any way to know a transcript is being taken. Posted
// once per meeting, as the user, with text they control. Off is a deliberate choice, not the default.
//
// It goes through /callchat rather than straight to the content script so it reuses the delivery path that
// already works: open the chat panel if closed, type through the real input pipeline, verify the composer
// cleared. And so a failure is reported rather than assumed.
const ANNOUNCE_DEFAULT = "I'm using an AI assistant that transcribes this meeting locally on my machine. Say the word if you'd rather I turned it off.";
async function announceToMeeting(session) {
  try {
    const c = await chrome.storage.local.get(['mla_announce', 'mla_announce_text']);
    if (c.mla_announce === false) return;
    const text = (c.mla_announce_text || '').trim() || ANNOUNCE_DEFAULT;
    // Once per meeting, even across a panel reload or a service-worker recycle. Session storage, so a new
    // browser session announces again - which is right, because that is a new call.
    const mark = `mla_announced_${session}`;
    const seen = await chrome.storage.session.get([mark]);
    if (seen[mark]) return;
    await chrome.storage.session.set({ [mark]: true });

    // Zoom's web client has no chat automation here - `content-zoom.js` never handled `callchat`, only
    // `content.js` does. Posting anyway queued a message nothing would ever type, and the delivery check
    // below cannot tell "nobody answered" from "not yet", so it stayed quiet. The result was the exact
    // failure this feature exists to prevent: disclosure switched on, nothing said, nobody told.
    if (/_zoom-/.test(session)) {
      appendChat({
        role: 'agent',
        text: '⚠ Zoom: I cannot type the disclosure into the meeting chat - only Google Meet supports that.'
          + ' **The room has not been told.** Say it out loud, or paste it into the chat yourself:\n\n'
          + `> ${text}`,
      });
      return;
    }

    const r = await fetch(`${serverUrl}/callchat`, {
      method: 'POST', headers: hdrs(true), body: JSON.stringify({ session, text, announce: true }),
    });
    if (!r.ok) return;
    const { seq } = await r.json();
    // The content script reports whether the composer actually cleared. Silence here would mean the user
    // believes the room was told when it was not, which is worse than not offering the feature.
    setTimeout(async () => {
      try {
        const res = await fetch(`${serverUrl}/callchat-result?session=${encodeURIComponent(session)}&since=${seq - 1}`, { headers: hdrs() });
        if (!res.ok) return;
        const { items } = await res.json();
        // No result at all is the FAILURE case, not the pending one: the content script reports every
        // attempt. Warning only on an explicit `ok:false` meant the most likely breakage - nothing relayed
        // the message at all - produced no warning, which is the exact belief this check exists to prevent.
        const mine = (items || []).find((i) => i.seq === seq);
        if (!mine || !mine.ok) {
          const why = mine ? (mine.reason || 'unknown') : 'nothing relayed it to the meeting';
          appendChat({ role: 'agent', text: `⚠ Could not post the disclosure to the meeting chat (${why}). **The room has not been told.**` });
        }
      } catch (_) {}
    }, 6000);
  } catch (_) {}
}

function setSession(session) {
  if (session && session !== currentSession) {
    setSetupStep('capture', true);
    currentSession = session; lastAdviceSeq = 0; lastItemsSeq = 0; lastReqSeq = -1; lastChatSeq = 0; lastEditSeq = -1; lastDomReqSeq = -1; lastDbgReqSeq = -1; lastCallChatSeq = -1; lastActSeq = -1;
    chatEl.innerHTML = ''; brainWorkEl = null; resetItems(); resetTalk(); resetSnap(); resetPro();
    setStatus(brainEl, '🧠 ?', 'idle');
    cueArmed = false; setTimeout(() => { cueArmed = true; }, 2500); // don't cue on initial backfill
    postMode(modeSel.value); // register the current mode for the new session
    announceToMeeting(session);
    loadAutopilot(); loadPro(); // sync toggles to this session's stored state
    pollAdvice(); pollItems(); pollCallChat(); pollSnapRequest(); pollChat(); pollPro(); pollBrain();
  }
}

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.postMessage({ type: 'hello' });
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) {} }, 20000);
  port.onDisconnect.addListener(() => {
    clearInterval(pingTimer);
    setTimeout(connect, 1000); // SW recycled - reconnect and re-hydrate
  });
}

// Read the tracker config, migrating the pre-0.6 Jira-only setting so an existing install keeps working
// without the user touching Options: a bare base URL becomes a `{key}` template and the name defaults to Jira.
function applyTracker(c) {
  if (c.mla_tracker_name !== undefined || c.mla_tracker_url !== undefined) {
    trackerName = (c.mla_tracker_name || '').trim();
    trackerUrl = (c.mla_tracker_url || '').trim();
  } else if (c.mla_jira_base) {
    trackerName = 'Jira';
    trackerUrl = `${String(c.mla_jira_base).replace(/\/+$/, '')}/browse/{key}`;
  }
}

chrome.storage.local.get(['serverUrl', 'ttsVoicePl', 'ttsVoiceEn', 'mla_mode', 'mla_token', 'mla_names', 'mla_jira_base', 'mla_tracker_name', 'mla_tracker_url']).then((c) => {
  if (c.serverUrl) serverUrl = c.serverUrl.replace(/\/+$/, '');
  ttsVoicePl = c.ttsVoicePl || 'Zosia';
  ttsVoiceEn = c.ttsVoiceEn || 'Daniel';
  serverToken = c.mla_token || '';
  applyTracker(c);
  buildNameRe(c.mla_names);
  if (c.mla_mode) modeSel.value = c.mla_mode;
  renderSetupSteps();  // something useful on screen before the first poll answers
  fetchHealth(); // first-run checklist (auto-opens once if something's missing)
  pollServerHealth();
  setInterval(pollServerHealth, 5000);

// Capture watchdog: a session that never appears means the content script is missing or orphaned - a
// reloaded extension is never re-injected into tabs that were already open, and that cost a whole meeting's
// transcript once. Worth shouting about.
//
// But only if there IS a meeting tab. It used to fire unconditionally, so someone who had just installed the
// extension and clicked the icon on a random tab was told to reload a Meet tab that did not exist. The first
// thing the product ever said to them was a red warning about their own correct behaviour.
const MEETING_URLS = ['https://meet.google.com/*', 'https://*.zoom.us/*'];
async function meetingTab() {
  try {
    const tabs = await chrome.tabs.query({ url: MEETING_URLS });
    return tabs && tabs.length ? tabs[0] : null;
  } catch (_) { return null; }
}

let captureRetried = false;
setTimeout(async function checkCapture() {
  if (currentSession) return;
  const tab = await meetingTab();
  if (!tab) {
    // No call open: not a fault, just the first step of the checklist not done yet.
    setSetupStep('capture', false);
    setStatus(capEl, 'no call open', 'idle');
    setTimeout(checkCapture, 8000);
    return;
  }
  if (!captureRetried) {
    captureRetried = true;
    try { port.postMessage({ type: 'ensure-capture' }); } catch (_) {}
    setTimeout(checkCapture, 6000);
    return;
  }
  if (!currentSession) {
    setSetupStep('capture', false);
    const where = /zoom\.us/.test(tab.url || '') ? 'Zoom' : 'Meet';
    setStatus(capEl, `⚠ not capturing - reload the ${where} tab`, 'bad');
  }
}, 8000);
});
// Pick up token / names edited in options without reopening the panel.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.mla_token) {
    serverToken = ch.mla_token.newValue || '';
    // Re-render the checklist, or the 🔑 chip stays ✗ until the next health poll. On a first install the
    // token is always pasted after the panel is already open, so the chip contradicted a working setup.
    fetchHealth();
  }
  if (ch.mla_names) buildNameRe(ch.mla_names.newValue);
  if (ch.mla_tracker_name || ch.mla_tracker_url || ch.mla_jira_base) {
    chrome.storage.local.get(['mla_tracker_name', 'mla_tracker_url', 'mla_jira_base']).then(applyTracker);
  }
});
connect();
startPolling();

// ---- tooltips: instant, styled, from any element's title (moved to data-tip so the native one doesn't
// double up). Fixed-positioned so it never clips inside a scrolling section. ----
(function initTips() {
  const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
  let cur = null;
  function show(el, text) {
    tip.textContent = text; tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 6);
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 6) top = r.top - th - 6; // flip above if no room below
    tip.style.left = `${left}px`; tip.style.top = `${Math.max(6, top)}px`;
  }
  function hide() { tip.classList.remove('show'); cur = null; }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip],[title]');
    if (!el || el === cur) return;
    let text = el.getAttribute('data-tip');
    if (text == null) { text = el.getAttribute('title'); if (text != null) { el.setAttribute('data-tip', text); el.removeAttribute('title'); } }
    if (!text) return;
    cur = el; show(el, text);
  });
  document.addEventListener('mouseout', (e) => { if (cur && (!e.relatedTarget || !cur.contains(e.relatedTarget))) hide(); });
  document.addEventListener('mousedown', hide);
  window.addEventListener('scroll', hide, true);
})();
