// Content script - Google Meet caption capture (ported from the Tampermonkey userscript v2.1.0).
// Phase 0: scrape finalized caption lines and hand them to the service worker. The SW fans them out
// to the side panel and to the local transcript server (127.0.0.1:8848 - the "brain" for Path A).
//
// IF CAPTURE BREAKS: Google periodically renames the caption CSS classes / jsname.
// Update the SEL block below (DevTools -> inspect the caption area -> copy new class names).

(function () {
  'use strict';

  // Reloading the extension orphans this script: its chrome.* calls throw, `send()` swallows them, and it
  // keeps scraping into the void - capture looks alive but nothing arrives (silent, and it cost us a real
  // meeting). The SW heals that by re-injecting; this generation counter makes that safe, because an older
  // instance stands down as soon as a newer one loads. Exactly one instance ever captures.
  const GEN = (window.__mlaGen = (window.__mlaGen || 0) + 1);
  const isCurrent = () => window.__mlaGen === GEN;

  // ---- SELECTORS (update here if Google changes the DOM) -------------------
  const SEL = {
    region: ['[jsname="dsyhDe"]', '.a4cQT', 'div[aria-label="Captions"]', '.iOzk7'],
    block: ['.nMcdL', '.TBMuR', '.bh44bd'],
    speaker: ['.NWpY1d', '.KcIKyf', '.zs7s8d', '.jxFHg'],
    text: ['.ygicle.VbkSUe', '.bh44bd', '.iTTPOb', '.VbkSUe'],
    // Chat panel messages (opportunistic - only in the DOM while the chat panel is open).
    // data-message-id / data-sender-name are the stable hooks; classes are fallbacks.
    chatMsg: ['div[data-message-id]', 'div[jsname="Ne3sFf"]'],
    chatSender: ['[data-sender-name]', '.poVWob', '.YTbUzc'],
    chatText: ['[data-message-text]', '.beTDc', '.oIy2qc', '.bzBcof'],
  };

  // ---- TUNABLES ------------------------------------------------------------
  // Commit a line when it looks utterance-complete, NOT every 600ms - cuts revision-dups, mid-word splits,
  // and (with the SILENT-on-filler rule) the agent's wake/turn count. Sentence-aware: end-punctuation lines
  // commit fast; mid-sentence lines wait longer for ASR to settle/continue.
  const FLUSH_SENT_MS = 900;   // text ends in . ? ! … → commit after this much quiet
  const FLUSH_MID_MS = 2500;   // no sentence end yet → wait longer (let ASR finish the thought)
  const MAX_UTTER_MS = 8000;   // force-commit a long, still-growing monologue at least this often
  const SENT_END = /[.!?…]["')\]]?\s*$/;
  const POLL_MS = 200;          // caption scan interval
  const CAPTURE_WARN_MS = 12000; // in-call but no caption region this long → warn (CC off / Google reshipped the DOM)
  const AUTO_CAPTIONS = true;   // auto-enable Meet captions on every call
  const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/; // a real call URL, e.g. ngt-eyri-xso
  const NOISE_RE = /jump to bottom|arrow_downward|arrow_upward/i;

  // Conservative ASR fix-ups: Meet/whisper mangle domain nouns. Only high-precision, whole-word
  // replacements that can't corrupt ordinary English. Extend as new manglings show up in transcripts.
  const GLOSSARY = [
    // Domain nouns belong to whoever is in the meeting, not to whoever wrote this. Company names used to be
    // hardcoded here and rewrote strangers' transcripts - "acme", a plausible Spanish ASR output,
    // became a company they have never heard of, in the record of their own conversation.
    [/\bfeature[ -]fl(?:ag|ight)\b|\bfuture[ -]flag\b/gi, 'feature flag'], // NOT "future flight" (valid phrase)
    [/\bgen[ -]?(\d)\b/gi, 'gen$1'],
  ];
  function normalizeGlossary(s) {
    let out = s;
    for (const [re, to] of GLOSSARY) out = out.replace(re, to);
    for (const [re, to] of userGlossary) out = out.replace(re, to);
    return out;
  }

  // User terms the transcriber mishears - names, products, jargon. Entered in Options as `heard => correct`,
  // one per line. EVERYTHING from the user is escaped to a literal before it touches a RegExp: a glossary is
  // not a place to accept a pattern, and an un-escaped entry would be either an injection or a catastrophic
  // backtrack on live captions. `$` in the replacement is escaped too, so "correct" is inserted verbatim.
  let userGlossary = [];
  function buildUserGlossary(raw) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    userGlossary = String(raw || '').split('\n').map((line) => {
      const i = line.indexOf('=>');
      if (i < 0) return null;
      const heard = line.slice(0, i).trim();
      const correct = line.slice(i + 2).trim();
      if (!heard || !correct) return null;
      try { return [new RegExp(`\\b${esc(heard)}\\b`, 'gi'), correct.replace(/\$/g, '$$$$')]; } catch (_) { return null; }
    }).filter(Boolean);
  }
  try {
    chrome.storage.local.get(['mla_glossary']).then((c) => buildUserGlossary(c && c.mla_glossary));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.mla_glossary) buildUserGlossary(ch.mla_glossary.newValue);
    });
  } catch (_) {}

  const CC_LABEL_HINTS = ['caption', 'subtitle', 'napis', 'untertitel', 'sous-titre', 'subtítulo', 'subtitulo'];
  const CC_ON_HINTS = ['turn off', 'wyłącz', 'wylacz', 'disable', 'stop', 'hide', 'ukryj'];
  const CC_OFF_HINTS = ['turn on', 'włącz', 'wlacz', 'enable', 'show', 'pokaż', 'pokaz'];

  // ---- STATE ---------------------------------------------------------------
  let session = null;
  let started = false;
  let sttPaused = false; // paused while local STT (tab audio) is the transcript source
  let scanning = false;
  let currentCode = null;
  let regionSeenAt = 0;   // last time the caption region existed (watchdog)
  let captureWarned = false;
  let trackerId = 0;
  const trackers = []; // [{ el, id, ts, text, lastChange, speaker, finalized }]
  const seenChatIds = new Set();  // meeting-chat messages already forwarded (by data-message-id)
  const seenChatEls = new WeakSet(); // …fallback for messages with no stable id
  let chatTick = 0;
  let primed = false; // false until the first scan pass has absorbed the captions already on screen
  // Sentences already handed over in THIS session. Per-element `sent` is not enough: Meet re-renders caption
  // nodes (and when SEL.block misses, blocksIn() falls back to the whole region), so a fresh tracker can hold
  // the entire history and re-emit it - live, every utterance after a re-injection re-sent 11 minutes of talk.
  // Deduping by sentence is DOM-shape independent. Short confirmations ("Okay.", "Yeah.") are exempt: they
  // legitimately repeat.
  const emitted = new Set();
  const DEDUPE_MIN_CHARS = 8;
  const EMITTED_MAX = 3000;
  function normSentence(x) {
    return x.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function dropAlreadyEmitted(text) {
    const parts = String(text || '').split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
    const keep = [];
    for (const part of parts) {
      const key = normSentence(part);
      if (!key) continue;
      if (key.length >= DEDUPE_MIN_CHARS && emitted.has(key)) continue;
      keep.push(part);
    }
    for (const part of parts) {
      const key = normSentence(part);
      if (key.length >= DEDUPE_MIN_CHARS) emitted.add(key);
    }
    if (emitted.size > EMITTED_MAX) emitted.clear(); // bound memory on a very long call
    return keep.join(' ');
  }

  const now = () => Date.now();
  const pad = (n) => String(n).padStart(2, '0');

  function firstMatch(root, selectors) {
    for (const s of selectors) { try { const el = root.querySelector(s); if (el) return el; } catch (_) {} }
    return null;
  }
  function firstRegion() {
    for (const s of SEL.region) { try { const el = document.querySelector(s); if (el) return el; } catch (_) {} }
    return null;
  }
  // Returns the per-utterance blocks, or - when Google's block classes don't match - the region itself with
  // fallback:true. The fallback element is CUMULATIVE (it holds the whole caption history), so callers must
  // treat it as one growing stream, not as a new utterance each time it is re-rendered.
  let usedRegionFallback = false;
  function blocksIn(region) {
    for (const s of SEL.block) {
      try { const list = region.querySelectorAll(s); if (list && list.length) { usedRegionFallback = false; return Array.from(list); } } catch (_) {}
    }
    usedRegionFallback = true;
    return region ? [region] : [];
  }
  function readBlock(block) {
    const spkEl = firstMatch(block, SEL.speaker);
    const txtEl = firstMatch(block, SEL.text);
    let speaker = spkEl ? spkEl.textContent.trim() : '';
    let text = txtEl ? txtEl.textContent.trim() : '';
    if (!text) {
      text = (block.textContent || '').trim();
      if (speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
    }
    return { speaker, text: normalizeGlossary(text) };
  }
  function tsLabel() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // What of the text now on screen has NOT been handed over yet.
  //
  // Meet's caption area is a WINDOW over the stream, not an append-only log: old utterances scroll out of it,
  // and the recogniser rewrites words it has already shown - capitalising after a sentence break ("jak" →
  // "Jak"), adding punctuation. Either one breaks a character-prefix test (`text.startsWith(sent)`), and the
  // moment it breaks, the whole visible window looks new and gets sent again. That is what put the same
  // sentence in the panel two and three times over.
  // So align on WORDS compared without case or punctuation, and take the LONGEST overlap between the tail of
  // what was sent and the head of what is on screen. No overlap at all means the window has scrolled clean
  // past everything we hold, and then the whole of it really is new.
  const wordKey = (w) => w.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/g, '');
  function unsentTail(sent, text) {
    const cur = String(text || '').trim();
    if (!sent || !cur) return cur;
    const curWords = cur.split(/\s+/).filter(Boolean);
    const sentKeys = String(sent).trim().split(/\s+/).filter(Boolean).map(wordKey);
    const curKeys = curWords.map(wordKey);
    for (let k = Math.min(sentKeys.length, curKeys.length); k > 0; k--) {
      let same = true;
      for (let i = 0; i < k; i++) if (sentKeys[sentKeys.length - k + i] !== curKeys[i]) { same = false; break; }
      if (same) return curWords.slice(k).join(' ');
    }
    return cur;
  }

  // ---- Hand a finalized line to the service worker -------------------------
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); // swallow "no receiver" while SW spins up
    } catch (_) { /* extension context invalidated on reload - ignore */ }
  }

  // Live: emit the growing caption immediately so the panel shows it in real time.
  // The invariant that keeps the panel to one line per utterance: an interim carries exactly the tail that
  // the next cap-final will carry, so the finalized line REPLACES the live one instead of landing under it.
  function emitInterim(tr) {
    const text = unsentTail(tr.sent, tr.text);
    if (!text) return;
    send({ type: 'cap', session, id: tr.id, ts: tr.ts, speaker: tr.speaker || '', text });
  }
  // Finalize: lock the line and hand the full text to the server/brain (once per block).
  function finalize(tr) {
    const text = (tr.text || '').trim();
    if (tr.finalized || !text) return;
    tr.finalized = true;
    tr.ts = tsLabel();   // stamp the commit moment (matters for forced mid-monologue flushes)
    tr.lastFinal = now();
    // Emit only what hasn't been sent for this block (matters after priming, and for a block that keeps
    // growing past a forced mid-monologue commit).
    const delta = unsentTail(tr.sent, text);
    tr.sent = text;
    const out = dropAlreadyEmitted(delta);
    if (!out) return;
    send({ type: 'cap-final', session, id: tr.id, ts: tr.ts, speaker: tr.speaker || '', text: out });
  }

  // ---- MEETING CHAT (opportunistic - only when the chat panel is open) -----
  // People paste links / names / ticket IDs / decisions in chat that never reach the captions.
  // Forward each message once as a distinct `[chat]` line so the brain has it as context.
  // Meet renders a hover action-toolbar INSIDE each message node ("Pin message", "keep", "More options").
  // Reading raw textContent drags those button labels into the captured line. Strip interactive nodes
  // before reading, and mop up any label that survives as a plain text node.
  // Anchored to end-of-string (no /g): only peel toolbar labels that TRAIL the message - never mid-text,
  // so a real "…pin message #1423, more options?" stays intact. Loop to strip a run of stacked labels.
  const CHAT_UI_NOISE_TRAIL = /\s*(?:Hover over a message to pin it|Unpin message|Pin message|More options|React to message)\s*$/i;
  function cleanNodeText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, [role="button"]').forEach((n) => n.remove());
    let out = (clone.textContent || '').replace(/\s{2,}/g, ' ').trim();
    while (CHAT_UI_NOISE_TRAIL.test(out)) out = out.replace(CHAT_UI_NOISE_TRAIL, '').trim();
    return out;
  }
  function readChatMessage(node) {
    const sender = cleanNodeText(firstMatch(node, SEL.chatSender)) || (node.getAttribute('data-sender-name') || '').trim();
    let text = cleanNodeText(firstMatch(node, SEL.chatText)) || (node.getAttribute('data-message-text') || '').trim();
    if (!text) { // fallback: whole-node text (interactive UI stripped) minus the sender label
      text = cleanNodeText(node);
      if (sender && text.startsWith(sender)) text = text.slice(sender.length).trim();
    }
    return { sender, text };
  }
  function scanChat() {
    let nodes = [];
    for (const s of SEL.chatMsg) { try { const l = document.querySelectorAll(s); if (l && l.length) { nodes = Array.from(l); break; } } catch (_) {} }
    for (const node of nodes) {
      const id = node.getAttribute('data-message-id') || '';
      if (id) { if (seenChatIds.has(id)) continue; } else if (seenChatEls.has(node)) continue;
      const { sender, text } = readChatMessage(node);
      if (!text || NOISE_RE.test(text)) continue;
      if (id) seenChatIds.add(id); else seenChatEls.add(node);
      send({ type: 'chat-in', session, ts: tsLabel(), sender: sender || '?', text: normalizeGlossary(text) });
    }
  }

  // ---- SCAN LOOP -----------------------------------------------------------
  function scan() {
    if (!started || !isCurrent()) { scanning = false; return; } // stand down if a newer instance took over
    if (++chatTick % 8 === 0) { try { scanChat(); } catch (_) {} } // ~every 1.6s, independent of captions
    if (!sttPaused) {
      const region = firstRegion();
      if (region) {
        regionSeenAt = now();
        if (captureWarned) { captureWarned = false; send({ type: 'capture-health', ok: true }); }
        for (const el of blocksIn(region)) {
          const { speaker, text } = readBlock(el);
          if (!text || NOISE_RE.test(text)) continue;
          let tr = usedRegionFallback ? trackers.find((t) => t.fallback) : trackers.find((t) => t.el === el);
          if (tr && usedRegionFallback) tr.el = el; // same logical stream, new DOM node
          if (!tr) {
            // `sent` = text already handed to the SW. Empty for a normal new block; on a re-injection the
            // priming pass below fills it with whatever is ALREADY on screen, so the accumulated caption
            // history is not re-emitted as one giant "new" line (it was, live: 11 minutes in one line).
            tr = { el, id: ++trackerId, fallback: usedRegionFallback, ts: tsLabel(), text: '', sent: usedRegionFallback || !primed ? text : '', lastChange: now(), lastFinal: now(), speaker: '', finalized: !primed };
            trackers.push(tr);
          }
          if (speaker) tr.speaker = speaker;
          if (text !== tr.text) { tr.text = text; tr.lastChange = now(); tr.finalized = false; emitInterim(tr); }
        }
        if (!primed) {
          // Seed the dedupe from the whole caption area - covers re-rendered nodes and the whole-region
          // fallback, which per-element priming missed.
          try { dropAlreadyEmitted((region.textContent || '').trim()); } catch (_) {}
          primed = true;
        }
        for (let i = trackers.length - 1; i >= 0; i--) {
          const tr = trackers[i];
          if (!document.contains(tr.el)) {
            if (tr.fallback) continue; // node swapped out under us; the stream lives on, keep its `sent`
            finalize(tr); trackers.splice(i, 1); continue;
          }
          const quiet = now() - tr.lastChange;
          const dueStable = SENT_END.test(tr.text) ? quiet >= FLUSH_SENT_MS : quiet >= FLUSH_MID_MS;
          if (tr.text && !tr.finalized && (dueStable || now() - tr.lastFinal >= MAX_UTTER_MS)) finalize(tr);
        }
      } else if (started && regionSeenAt && now() - regionSeenAt > CAPTURE_WARN_MS && !captureWarned) {
        captureWarned = true; send({ type: 'capture-health', ok: false, reason: 'no caption region' });
      }
    }
    setTimeout(scan, POLL_MS);
  }

  // ---- AUTO-ENABLE CAPTIONS ------------------------------------------------
  function findCaptionButton() {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const icon = b.querySelector('i, .google-symbols, .material-icons, .material-symbols-outlined, .material-icons-extended');
      const iconText = icon ? (icon.textContent || '').trim().toLowerCase() : '';
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || '')).toLowerCase();
      if (!(iconText.includes('closed_caption') || CC_LABEL_HINTS.some((h) => label.includes(h)))) continue;
      const off = iconText.includes('closed_caption_off') || (CC_OFF_HINTS.some((h) => label.includes(h)) && !CC_ON_HINTS.some((h) => label.includes(h)));
      const on = (iconText === 'closed_caption') || CC_ON_HINTS.some((h) => label.includes(h));
      return { el: b, off, on };
    }
    return null;
  }
  let captionsHandled = false;
  function ensureCaptionsOn(attempt) {
    attempt = attempt || 0;
    if (!AUTO_CAPTIONS || captionsHandled) return;
    if (firstRegion()) { captionsHandled = true; return; }
    const btn = findCaptionButton();
    if (btn) {
      if (btn.on && !btn.off) { captionsHandled = true; return; }
      if (btn.off) { try { btn.el.click(); } catch (_) {} captionsHandled = true; return; }
      // Found the button but cannot read its state from the label, which is what happens whenever Google
      // rewords it. The old code did nothing here and retried silently for fifty seconds, so captions never
      // came on and nothing said why. There is no caption region either, so the odds are they are off.
      // Click once and check: if a region appears we were right; if not we just turned someone's captions
      // off, so put them back and say so rather than leaving the room transcribed against their choice.
      if (attempt >= 3) {
        captionsHandled = true;
        try { btn.el.click(); } catch (_) { return; }
        setTimeout(() => {
          if (firstRegion()) return;
          try { btn.el.click(); } catch (_) {}
          send({ type: 'capture-health', ok: false, reason: 'cannot tell whether captions are on - turn them on with the CC button' });
        }, 2500);
        return;
      }
    }
    if (attempt < 25) setTimeout(() => ensureCaptionsOn(attempt + 1), 2000);
  }
  // Captions that were on and went off are NOT re-enabled. This used to click the CC button back on every
  // five seconds, which was written as a watchdog for Meet dropping captions by itself - but the code
  // cannot tell that apart from a person deliberately switching them off, so in practice it overrode a
  // human's choice about being transcribed, silently, every five seconds. There is no version of that
  // which is defensible in a room where not everyone installed this. The panel already warns when
  // captions stop, so the user is told rather than obeyed-over.

  // ---- SESSION NAME (date_time_meeting) ------------------------------------
  function meetingCode() {
    return (location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '');
  }
  function buildSession(code) {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    // No time component: same meeting code on the same day → same file, so a disconnect/rejoin
    // resumes the SAME transcript. A recurring meeting on another day gets its own date → own file.
    return `${date}_${code}`;
  }

  // ---- LIFECYCLE: start/stop with the call ---------------------------------
  function startScan() { if (!scanning) { scanning = true; scan(); } }

  function tick() {
    if (!isCurrent()) return; // a newer instance owns capture now
    const code = meetingCode();
    const inCall = MEETING_CODE_RE.test(code);
    if (inCall && (!started || code !== currentCode)) {
      currentCode = code;
      session = buildSession(code);
      started = true;
      trackers.length = 0;
      primed = false;
      usedRegionFallback = false;
      emitted.clear();
      captionsHandled = false;
      regionSeenAt = now(); captureWarned = false; // grace period before the caption-region watchdog fires
      ensureCaptionsOn();
      send({ type: 'session', session, code });
      startScan();
    } else if (!inCall && started) {
      started = false; session = null; currentCode = null; trackers.length = 0;
      send({ type: 'session-end' });
    }
  }

  // ---- SCREEN-SHARE DETECTION (best-effort; heuristic - tune hints if it misfires) --------
  // When someone presents, the panel switches to frequent (15s) snapshots; otherwise on-demand only.
  const SHARE_LABEL_HINTS = ['stop presenting', 'zatrzymaj prezentacj', 'is presenting', 'presentation', 'prezentuje', 'udostępnia', 'is sharing'];
  let sharing = false;
  function detectSharing() {
    for (const n of document.querySelectorAll('button,[role="button"],[aria-label],[data-tooltip]')) {
      const s = ((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('data-tooltip') || '')).toLowerCase();
      if (s && SHARE_LABEL_HINTS.some((h) => s.includes(h))) return true;
    }
    return false;
  }
  function checkSharing() {
    const on = started ? detectSharing() : false;
    if (on !== sharing) { sharing = on; send({ type: 'sharing', on }); }
  }

  // ---- CALL LANGUAGE (from Meet's caption-language selector) ---------------
  // Drives which TTS voice to use. Meet shows the caption language as a short control label
  // like "Polish (Poland)" / "English (US)". Best-effort; the panel falls back to text heuristics.
  const LANG_MAP = [
    [/^(polski|polish)\b/i, 'pl'], [/^(english|angielski)\b/i, 'en'],
    [/^(deutsch|german|niemiecki)\b/i, 'de'], [/^(espa[nñ]ol|spanish|hiszpa)\b/i, 'es'],
    [/^(fran[cç]ais|french|francuski)\b/i, 'fr'], [/^(italiano|italian|w[lł]oski)\b/i, 'it'],
  ];
  let callLang = null;
  function detectCallLang() {
    for (const el of document.querySelectorAll('button,[role="button"],[role="combobox"]')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 30) continue;
      for (const [re, code] of LANG_MAP) if (re.test(t)) return code;
    }
    return null;
  }
  function checkLang() {
    const lang = started ? detectCallLang() : null;
    if (lang && lang !== callLang) { callLang = lang; send({ type: 'lang', lang }); }
  }

  // ---- MIC CONTROL (auto-unmute while speaking TTS into the call) ----------
  const MIC_MUTED_HINTS = ['turn on microphone', 'włącz mikrofon', 'wlacz mikrofon']; // currently muted
  const MIC_LIVE_HINTS = ['turn off microphone', 'wyłącz mikrofon', 'wylacz mikrofon']; // currently live
  function findMicButton() {
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (!label.includes('microphone') && !label.includes('mikrofon')) continue;
      const muted = MIC_MUTED_HINTS.some((h) => label.includes(h));
      const live = MIC_LIVE_HINTS.some((h) => label.includes(h));
      if (muted || live) return { el: b, muted };
    }
    return null;
  }
  // ---- Post a message into the Meet chat (for autopilot "share the ticket link with everyone") ----
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  }
  const CHAT_INPUT_SEL = 'textarea[aria-label*="message" i], textarea[aria-label*="wiadomo" i], '
    + 'textarea[aria-label*="send" i], textarea[placeholder*="message" i], textarea[placeholder*="wiadomo" i], '
    + 'div[contenteditable="true"][aria-label*="message" i], div[contenteditable="true"][aria-label*="wiadomo" i], '
    + 'div[contenteditable="true"][role="textbox"]';
  function findChatInput() {
    try {
      const el = document.querySelector(CHAT_INPUT_SEL);
      if (el) return el;
      // Fallback (Meet's DOM rotates): any textarea/textbox inside a chat side-panel region.
      for (const r of document.querySelectorAll('[aria-label*="chat" i], [aria-label*="czat" i], [role="complementary"]')) {
        const c = r.querySelector('textarea, div[contenteditable="true"][role="textbox"]');
        if (c) return c;
      }
    } catch (_) {}
    return null;
  }
  function chatToggleBtn() {
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (/chat with everyone|open chat|otwórz czat|czat z/i.test(l)) return b;
    }
    return null;
  }
  // Is the chat panel already open? Check the composer, a live Send button, or the toggle's pressed state -
  // so we NEVER click the toggle on an open panel (that would close it, which broke delivery before).
  function chatOpen() {
    if (findChatInput() || findSendButton()) return true;
    const t = chatToggleBtn();
    return !!t && (t.getAttribute('aria-pressed') === 'true' || t.getAttribute('aria-expanded') === 'true');
  }
  function openChatPanel() {
    if (chatOpen()) return; // already open - clicking the toggle would CLOSE it
    const t = chatToggleBtn();
    if (t) { try { t.click(); } catch (_) {} }
  }
  // Meet's chat composer is framework-controlled: a plain `value =` is ignored (Send stays disabled) and a
  // lone synthetic Enter won't fire. execCommand('insertText') drives the *real* input pipeline, so the
  // framework registers the text (works for both <textarea> and contenteditable). Fall back to value+InputEvent.
  function typeInto(el, text) {
    el.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) {}
    if (!ok) {
      if (el.isContentEditable) el.textContent = text; else setNativeValue(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }
  function findSendButton() {
    return Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
      return !disabled && /send( a)? message|wyślij wiadomo|wyslij wiadomo/.test(l);
    });
  }
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  function reportCallChat(seq, ok, reason) { send({ type: 'callchat-done', session, seq, ok, reason: reason || '' }); }
  function postToCallChat(text, seq) {
    if (!text) return;
    if (!chatOpen()) openChatPanel(); // open only if closed - never toggle an open panel shut
    let tries = 0;
    const timer = setInterval(() => {
      const ta = findChatInput();
      if (!ta) { if (++tries > 15) { clearInterval(timer); reportCallChat(seq, false, 'chat panel/input not found'); } return; } // ~3s to open
      clearInterval(timer);
      typeInto(ta, text);
      setTimeout(() => {
        const send1 = findSendButton();
        if (send1) { try { send1.click(); } catch (_) { pressEnter(ta); } } else pressEnter(ta);
        // Meet clears the composer on a successful send - use that as the delivery signal.
        setTimeout(() => {
          const after = findChatInput();
          const leftover = after ? ((after.value != null ? after.value : after.textContent) || '').trim() : '';
          reportCallChat(seq, !leftover, leftover ? 'composer not cleared - send likely failed' : '');
        }, 500);
      }, 150);
    }, 200);
  }

  // Grab pre-join context to import: prefer the user's current selection (highlight the Gemini summary),
  // else best-effort the Gemini/notes side-panel text. Selectors are heuristic (Google's DOM rotates).
  function grabContext() {
    const sel = (window.getSelection && String(window.getSelection() || '')).trim();
    if (sel.length > 20) return sel.slice(0, 8000);
    const hints = ['[aria-label*="Gemini" i]', '[aria-label*="summary" i]', '[aria-label*="notes" i]', '[aria-label*="took notes" i]'];
    for (const h of hints) { try { const el = document.querySelector(h); if (el) { const t = (el.innerText || '').trim(); if (t.length > 60) return t.slice(0, 8000); } } catch (_) {} }
    return '';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ping') { sendResponse({ ok: true, gen: GEN, started, session }); return; } // liveness probe from the SW
    if (msg.type === 'capture-mode') { sttPaused = (msg.captions === false); sendResponse({ ok: true }); return; }
    if (msg.type === 'grab-context') { sendResponse({ text: grabContext() }); return; }
    if (msg.type === 'call-chat') { postToCallChat(msg.text, msg.seq); sendResponse({ ok: true }); return; }
    if (msg.type !== 'mic') return;
    const b = findMicButton();
    if (!b) { sendResponse({ ok: false }); return; }
    if (msg.action === 'unmute') {
      const wasMuted = b.muted;
      if (wasMuted) { try { b.el.click(); } catch (_) {} }
      sendResponse({ ok: true, wasMuted });
    } else if (msg.action === 'restore') {
      if (msg.wasMuted && !b.muted) { try { b.el.click(); } catch (_) {} } // re-mute to prior state
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  });

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    tick();
    setInterval(tick, 1500); // handle SPA navigation (lobby -> call -> leave)
    setInterval(checkSharing, 3000);
    setInterval(checkLang, 3000);
  }, 800);
})();
