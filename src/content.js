// Content script — Google Meet caption capture (ported from the Tampermonkey userscript v2.1.0).
// Phase 0: scrape finalized caption lines and hand them to the service worker. The SW fans them out
// to the side panel and to the local transcript server (127.0.0.1:8848 — the "brain" for Path A).
//
// IF CAPTURE BREAKS: Google periodically renames the caption CSS classes / jsname.
// Update the SEL block below (DevTools -> inspect the caption area -> copy new class names).

(function () {
  'use strict';

  // ---- SELECTORS (update here if Google changes the DOM) -------------------
  const SEL = {
    region: ['[jsname="dsyhDe"]', '.a4cQT', 'div[aria-label="Captions"]', '.iOzk7'],
    block: ['.nMcdL', '.TBMuR', '.bh44bd'],
    speaker: ['.NWpY1d', '.KcIKyf', '.zs7s8d', '.jxFHg'],
    text: ['.ygicle.VbkSUe', '.bh44bd', '.iTTPOb', '.VbkSUe'],
    // Chat panel messages (opportunistic — only in the DOM while the chat panel is open).
    // data-message-id / data-sender-name are the stable hooks; classes are fallbacks.
    chatMsg: ['div[data-message-id]', 'div[jsname="Ne3sFf"]'],
    chatSender: ['[data-sender-name]', '.poVWob', '.YTbUzc'],
    chatText: ['[data-message-text]', '.beTDc', '.oIy2qc', '.bzBcof'],
  };

  // ---- TUNABLES ------------------------------------------------------------
  const FLUSH_STABLE_MS = 600; // write a line once its text stops changing this long (= finalized)
  const MAX_UTTER_MS = 3500;   // force-commit a long, still-growing utterance this often (kills monologue latency)
  const POLL_MS = 200;          // caption scan interval
  const CAPTURE_WARN_MS = 12000; // in-call but no caption region this long → warn (CC off / Google reshipped the DOM)
  const AUTO_CAPTIONS = true;   // auto-enable Meet captions on every call
  const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/; // a real call URL, e.g. ngt-eyri-xso
  const NOISE_RE = /jump to bottom|arrow_downward|arrow_upward/i;

  // Conservative ASR fix-ups: Meet/whisper mangle domain nouns. Only high-precision, whole-word
  // replacements that can't corrupt ordinary English. Extend as new manglings show up in transcripts.
  const GLOSSARY = [
    [/\btest[ -]?g(?:orilla|uerrilla|orila)\b/gi, 'Acme'],
    [/\bacme\b/gi, 'Acme'],
    [/\bcore[ -]?signal\b/gi, 'Acme'],
    [/\bfeature[ -]fl(?:ag|ight)\b|\bfuture[ -]flag\b/gi, 'feature flag'], // NOT "future flight" (valid phrase)
    [/\bgen[ -]?(\d)\b/gi, 'gen$1'],
  ];
  function normalizeGlossary(s) {
    let out = s;
    for (const [re, to] of GLOSSARY) out = out.replace(re, to);
    return out;
  }

  const CC_LABEL_HINTS = ['caption', 'subtitle', 'napis', 'untertitel', 'sous-titre', 'subtítulo', 'subtitulo'];
  const CC_ON_HINTS = ['turn off', 'wyłącz', 'wylacz', 'disable', 'stop'];
  const CC_OFF_HINTS = ['turn on', 'włącz', 'wlacz', 'enable'];

  // ---- STATE ---------------------------------------------------------------
  let session = null;
  let started = false;
  let userPaused = false;
  let sttPaused = false; // paused while local STT (tab audio) is the transcript source
  let lineCount = 0;
  let scanning = false;
  let currentCode = null;
  let regionSeenAt = 0;   // last time the caption region existed (watchdog)
  let captureWarned = false;
  let trackerId = 0;
  const trackers = []; // [{ el, id, ts, text, lastChange, speaker, finalized }]
  const seenChatIds = new Set();  // meeting-chat messages already forwarded (by data-message-id)
  const seenChatEls = new WeakSet(); // …fallback for messages with no stable id
  let chatTick = 0;

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
  function blocksIn(region) {
    for (const s of SEL.block) {
      try { const list = region.querySelectorAll(s); if (list && list.length) return Array.from(list); } catch (_) {}
    }
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

  // ---- Hand a finalized line to the service worker -------------------------
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); // swallow "no receiver" while SW spins up
    } catch (_) { /* extension context invalidated on reload — ignore */ }
  }

  // Live: emit the growing caption immediately so the panel shows it in real time.
  function emitInterim(tr) {
    send({ type: 'cap', session, id: tr.id, ts: tr.ts, speaker: tr.speaker || '', text: tr.text });
  }
  // Finalize: lock the line and hand the full text to the server/brain (once per block).
  function finalize(tr) {
    const text = (tr.text || '').trim();
    if (tr.finalized || !text) return;
    tr.finalized = true;
    tr.ts = tsLabel();   // stamp the commit moment (matters for forced mid-monologue flushes)
    tr.lastFinal = now();
    lineCount++;
    send({ type: 'cap-final', session, id: tr.id, ts: tr.ts, speaker: tr.speaker || '', text });
    updateBadge();
  }

  // ---- MEETING CHAT (opportunistic — only when the chat panel is open) -----
  // People paste links / names / ticket IDs / decisions in chat that never reach the captions.
  // Forward each message once as a distinct `[chat]` line so the brain has it as context.
  function readChatMessage(node) {
    const sender = (firstMatch(node, SEL.chatSender)?.textContent || node.getAttribute('data-sender-name') || '').trim();
    let text = (firstMatch(node, SEL.chatText)?.textContent || node.getAttribute('data-message-text') || '').trim();
    if (!text) { // fallback: whole-node text minus the sender label
      text = (node.textContent || '').trim();
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
    if (!started) { scanning = false; return; }
    if (!userPaused && (++chatTick % 8 === 0)) { try { scanChat(); } catch (_) {} } // ~every 1.6s, independent of captions
    if (!userPaused && !sttPaused) {
      const region = firstRegion();
      if (region) {
        regionSeenAt = now();
        if (captureWarned) { captureWarned = false; send({ type: 'capture-health', ok: true }); updateBadge(); }
        for (const el of blocksIn(region)) {
          const { speaker, text } = readBlock(el);
          if (!text || NOISE_RE.test(text)) continue;
          let tr = trackers.find((t) => t.el === el);
          if (!tr) { tr = { el, id: ++trackerId, ts: tsLabel(), text: '', lastChange: now(), lastFinal: now(), speaker: '', finalized: false }; trackers.push(tr); }
          if (speaker) tr.speaker = speaker;
          if (text !== tr.text) { tr.text = text; tr.lastChange = now(); tr.finalized = false; emitInterim(tr); }
        }
        for (let i = trackers.length - 1; i >= 0; i--) {
          const tr = trackers[i];
          if (!document.contains(tr.el)) { finalize(tr); trackers.splice(i, 1); continue; }
          if (tr.text && !tr.finalized && (now() - tr.lastChange >= FLUSH_STABLE_MS || now() - tr.lastFinal >= MAX_UTTER_MS)) finalize(tr);
        }
      } else if (started && regionSeenAt && now() - regionSeenAt > CAPTURE_WARN_MS && !captureWarned) {
        captureWarned = true; send({ type: 'capture-health', ok: false, reason: 'no caption region' }); updateBadge();
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
    }
    if (attempt < 25) setTimeout(() => ensureCaptionsOn(attempt + 1), 2000);
  }
  // Watchdog: Meet captions sometimes switch off mid-call — re-enable them if the region disappears
  // (only click the CC button when it's actually OFF, so we never toggle captions off ourselves).
  function keepCaptionsOn() {
    if (!AUTO_CAPTIONS || !started || userPaused || sttPaused) return;
    if (firstRegion()) return; // captions visible → nothing to do
    const btn = findCaptionButton();
    if (btn && btn.off) { try { btn.el.click(); } catch (_) {} }
  }

  // ---- SESSION NAME (date_time_meeting) ------------------------------------
  function meetingCode() {
    return (location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '');
  }
  function buildSession(code) {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `${date}_${time}_${code}`;
  }

  // ---- BADGE (quick in-page status; side panel is the primary UI) ----------
  let badge;
  function updateBadge() {
    if (!badge) return;
    if (!started) { badge.textContent = '○ idle'; badge.style.background = '#555'; return; }
    if (userPaused) { badge.textContent = '⏸ paused'; badge.style.background = '#8a6d00'; return; }
    if (captureWarned) { badge.textContent = '⚠ no captions'; badge.style.background = '#d1242f'; return; }
    badge.textContent = `● rec ${lineCount}`;
    badge.style.background = '#1a7f37';
  }
  function makeBadge() {
    badge = document.createElement('button');
    Object.assign(badge.style, {
      position: 'fixed', zIndex: 2147483647, bottom: '16px', right: '16px',
      padding: '6px 10px', borderRadius: '20px', border: 'none', color: '#fff',
      background: '#555', font: '12px/1.2 system-ui, sans-serif', cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.3)', opacity: '0.85',
    });
    badge.title = 'Meet transcript capture (auto). Click to pause/resume.';
    badge.addEventListener('click', () => { userPaused = !userPaused; updateBadge(); });
    document.body.appendChild(badge);
    updateBadge();
  }

  // ---- LIFECYCLE: start/stop with the call ---------------------------------
  function startScan() { if (!scanning) { scanning = true; scan(); } }

  function tick() {
    const code = meetingCode();
    const inCall = MEETING_CODE_RE.test(code);
    if (inCall && (!started || code !== currentCode)) {
      currentCode = code;
      session = buildSession(code);
      started = true;
      lineCount = 0;
      trackers.length = 0;
      captionsHandled = false;
      regionSeenAt = now(); captureWarned = false; // grace period before the caption-region watchdog fires
      ensureCaptionsOn();
      send({ type: 'session', session, code });
      startScan();
      updateBadge();
    } else if (!inCall && started) {
      started = false; session = null; currentCode = null; trackers.length = 0;
      send({ type: 'session-end' });
      updateBadge();
    }
  }

  // ---- SCREEN-SHARE DETECTION (best-effort; heuristic — tune hints if it misfires) --------
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
  const CHAT_INPUT_SEL = 'textarea[aria-label*="message" i], textarea[aria-label*="wiadomo" i], textarea[placeholder*="message" i]';
  function findChatInput() { try { return document.querySelector(CHAT_INPUT_SEL); } catch (_) { return null; } }
  function openChatPanel() {
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (/chat with everyone|open chat|otwórz czat|czat z/i.test(l)) { try { b.click(); } catch (_) {} return; }
    }
  }
  function postToCallChat(text) {
    if (!text) return;
    if (!findChatInput()) openChatPanel();
    let tries = 0;
    const timer = setInterval(() => {
      const ta = findChatInput();
      if (!ta) { if (++tries > 12) clearInterval(timer); return; } // ~2.4s to open the panel
      clearInterval(timer);
      ta.focus(); setNativeValue(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const send = Array.from(document.querySelectorAll('button,[role="button"]'))
          .find((b) => /send a message|wyślij wiadomo/i.test((b.getAttribute('aria-label') || '')) && !b.disabled);
        if (send) { try { send.click(); return; } catch (_) {} }
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }, 120);
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
    if (msg.type === 'capture-mode') { sttPaused = (msg.captions === false); sendResponse({ ok: true }); return; }
    if (msg.type === 'grab-context') { sendResponse({ text: grabContext() }); return; }
    if (msg.type === 'call-chat') { postToCallChat(msg.text); sendResponse({ ok: true }); return; }
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
    makeBadge();
    tick();
    setInterval(tick, 1500); // handle SPA navigation (lobby -> call -> leave)
    setInterval(checkSharing, 3000);
    setInterval(checkLang, 3000);
    setInterval(keepCaptionsOn, 5000); // re-enable captions if they turn off mid-call
  }, 800);
})();
