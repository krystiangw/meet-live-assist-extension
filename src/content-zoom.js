// Content script — Zoom WEB CLIENT (app.zoom.us/wc) live-caption capture.
// Emits the SAME messages as the Meet content script (session / cap / cap-final / session-end),
// so the service worker, dedup pipeline, and side panel are shared and unchanged.
//
// Zoom does NOT show captions unless they're enabled in the meeting (host enables captions /
// "Show Captions"). IF NOTHING IS CAPTURED: inspect the caption line in DevTools and add its class
// to SEL below. Zoom's class names rotate, so these are broad, case-insensitive hints.

(function () {
  'use strict';

  const GEN = (window.__mlaGen = (window.__mlaGen || 0) + 1);
  const isCurrent = () => window.__mlaGen === GEN;

  const SEL = {
    region: ['[class*="live-transcription" i]', '[class*="closed-caption" i]', '[aria-label*="caption" i]',
             '[class*="subtitle" i]', '[class*="caption" i]'],
    block: ['[class*="live-transcription-content" i]', '[class*="caption" i] li', '[class*="subtitle-item" i]'],
    speaker: ['[class*="speaker" i]', '[class*="name" i]'],
    text: ['[class*="text" i]', '[class*="content" i]'],
    // Chat panel messages (opportunistic — only in the DOM while the chat panel is open).
    chatMsg: ['[class*="new-chat-message" i]', '[class*="chat-item" i]', '#chat-list [class*="message" i]'],
    chatSender: ['[class*="sender" i]', '[class*="chat-item__sender" i]'],
    chatText: ['[class*="chat-info" i]', '[class*="message-text" i]', '[class*="text" i]'],
  };

  const FLUSH_SENT_MS = 900;   // sentence-complete line → commit after this much quiet
  const FLUSH_MID_MS = 2500;   // mid-sentence → wait longer for ASR to settle
  const MAX_UTTER_MS = 8000;   // force-commit a long monologue at least this often
  const SENT_END = /[.!?…]["')\]]?\s*$/;
  const POLL_MS = 200;
  const CAPTURE_WARN_MS = 12000;
  const ZOOM_WC_RE = /\/wc\//;
  const NOISE_RE = /^(show captions|hide captions|captions|save|more|settings)$/i;

  const GLOSSARY = [
    [/\btest[ -]?g(?:orilla|uerrilla|orila)\b/gi, 'Acme'],
    [/\bacme\b/gi, 'Acme'],
    [/\bcore[ -]?signal\b/gi, 'Acme'],
    [/\bfeature[ -]fl(?:ag|ight)\b|\bfuture[ -]flag\b/gi, 'feature flag'],
    [/\bgen[ -]?(\d)\b/gi, 'gen$1'],
  ];
  const normalizeGlossary = (s) => { let o = s; for (const [re, to] of GLOSSARY) o = o.replace(re, to); return o; };

  // "Name: caption" heuristic — only treat the prefix as a speaker if it looks like a display name
  // (1–4 capitalized words), never for ordinary prose that happens to contain a colon.
  const NAME_WORD = /^[A-Z][\p{L}.'-]*$/u;
  const NOT_NAME = new Set(['actually', 'note', 'so', 'well', 'yeah', 'ok', 'okay', 'right', 'yes', 'no',
    'sorry', 'hmm', 'um', 'uh', 'and', 'but', 'because', 'also', 'anyway', 'basically', 'honestly', 'wait', 'look']);
  function splitSpeaker(text) {
    const ci = text.indexOf(':');
    if (ci <= 0 || ci > 40) return null;
    const pre = text.slice(0, ci).trim(), rest = text.slice(ci + 1).trim();
    if (!rest) return null;
    const words = pre.split(/\s+/);
    if (words.length < 1 || words.length > 4 || !words.every((w) => NAME_WORD.test(w))) return null;
    if (words.length === 1 && NOT_NAME.has(words[0].toLowerCase())) return null; // "Actually: …" is prose
    return { speaker: pre, text: rest };
  }

  let session = null, started = false, userPaused = false, sttPaused = false, scanning = false;
  const seenChatEls = new WeakSet(); let chatTick = 0; // meeting-chat dedup (Zoom messages carry no stable id)
  let currentCode = null, regionSeenAt = 0, captureWarned = false, lineCount = 0, trackerId = 0;
  const trackers = [];
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
    // Fallback: direct child elements that carry text.
    const kids = Array.from(region.children || []).filter((el) => (el.textContent || '').trim());
    return kids.length ? kids : [region];
  }
  function readBlock(block) {
    const spkEl = firstMatch(block, SEL.speaker);
    const txtEl = firstMatch(block, SEL.text);
    let speaker = spkEl ? spkEl.textContent.trim() : '';
    let text = txtEl ? txtEl.textContent.trim() : '';
    if (!text) {
      text = (block.textContent || '').trim();
      if (speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
      if (!speaker) { const s = splitSpeaker(text); if (s) { speaker = s.speaker; text = s.text; } }
    }
    return { speaker, text: normalizeGlossary(text) };
  }
  function tsLabel() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (_) {}
  }
  // Prefix ids with 'z' so a concurrent Meet tab (numeric ids) can't collide in the SW's dedup map.
  function emitInterim(tr) { send({ type: 'cap', session, id: 'z' + tr.id, ts: tr.ts, speaker: tr.speaker || '', text: tr.text }); }
  function finalize(tr) {
    const text = (tr.text || '').trim();
    if (tr.finalized || !text) return;
    tr.finalized = true; tr.ts = tsLabel(); tr.lastFinal = now(); lineCount++;
    send({ type: 'cap-final', session, id: 'z' + tr.id, ts: tr.ts, speaker: tr.speaker || '', text });
    updateBadge();
  }

  // Meeting chat → forward each message once as a distinct [chat] line for the brain's context.
  function scanChat() {
    let nodes = [];
    for (const s of SEL.chatMsg) { try { const l = document.querySelectorAll(s); if (l && l.length) { nodes = Array.from(l); break; } } catch (_) {} }
    for (const node of nodes) {
      if (seenChatEls.has(node)) continue;
      seenChatEls.add(node);
      const sender = (firstMatch(node, SEL.chatSender)?.textContent || '').trim();
      let text = (firstMatch(node, SEL.chatText)?.textContent || '').trim();
      if (!text) { text = (node.textContent || '').trim(); if (sender && text.startsWith(sender)) text = text.slice(sender.length).trim(); }
      if (!text || NOISE_RE.test(text)) continue;
      send({ type: 'chat-in', session, ts: tsLabel(), sender: sender || '?', text: normalizeGlossary(text) });
    }
  }

  function scan() {
    if (!started || !isCurrent()) { scanning = false; return; } // stand down if a newer instance took over
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
          const quiet = now() - tr.lastChange;
          const dueStable = SENT_END.test(tr.text) ? quiet >= FLUSH_SENT_MS : quiet >= FLUSH_MID_MS;
          if (tr.text && !tr.finalized && (dueStable || now() - tr.lastFinal >= MAX_UTTER_MS)) finalize(tr);
        }
      } else if (started && regionSeenAt && now() - regionSeenAt > CAPTURE_WARN_MS && !captureWarned) {
        captureWarned = true; send({ type: 'capture-health', ok: false, reason: 'no caption region' }); updateBadge();
      }
    }
    setTimeout(scan, POLL_MS);
  }

  function meetingCode() {
    const m = /\/wc\/([A-Za-z0-9]+)/.exec(location.pathname);
    return m ? `zoom-${m[1].slice(0, 12)}` : 'zoom-wc';
  }
  function buildSession(code) {
    const d = new Date();
    // No time component: same meeting on the same day → same file across a disconnect/rejoin
    // (a recurring meeting on another day still gets its own date → own file).
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${code}`;
  }

  let badge;
  function updateBadge() {
    if (!badge) return;
    if (!started) { badge.textContent = '○ zoom idle'; badge.style.background = '#555'; return; }
    if (userPaused) { badge.textContent = '⏸ zoom paused'; badge.style.background = '#8a6d00'; return; }
    if (captureWarned) { badge.textContent = '⚠ zoom no captions'; badge.style.background = '#d1242f'; return; }
    badge.textContent = `● zoom rec ${lineCount}`; badge.style.background = '#1a7f37';
  }
  function makeBadge() {
    badge = document.createElement('button');
    Object.assign(badge.style, {
      position: 'fixed', zIndex: 2147483647, bottom: '16px', right: '16px', padding: '6px 10px',
      borderRadius: '20px', border: 'none', color: '#fff', background: '#555',
      font: '12px/1.2 system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.3)', opacity: '0.85',
    });
    badge.title = 'Zoom transcript capture (auto). Click to pause/resume.';
    badge.addEventListener('click', () => { userPaused = !userPaused; updateBadge(); });
    document.body.appendChild(badge);
    updateBadge();
  }

  function startScan() { if (!scanning) { scanning = true; scan(); } }
  function tick() {
    if (!isCurrent()) return; // a newer instance owns capture now
    const inCall = ZOOM_WC_RE.test(location.pathname);
    const code = meetingCode();
    if (inCall && (!started || code !== currentCode)) {
      currentCode = code; session = buildSession(code); started = true; lineCount = 0;
      trackers.length = 0; regionSeenAt = now(); captureWarned = false;
      send({ type: 'session', session, code });
      startScan(); updateBadge();
    } else if (!inCall && started) {
      started = false; session = null; currentCode = null; trackers.length = 0;
      send({ type: 'session-end' }); updateBadge();
    }
  }

  // Post a message into the Zoom chat (autopilot link-sharing). Best-effort; Zoom's chat DOM varies.
  function zoomChatInput() {
    return document.querySelector('textarea[placeholder*="message" i], textarea[aria-label*="message" i], div[contenteditable="true"][aria-label*="message" i], div.tmp-editor-content[contenteditable="true"]');
  }
  function openZoomChat() {
    for (const b of document.querySelectorAll('button,[role="button"],[aria-label]')) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (/^chat$|open the chat|chat panel|otwórz czat/i.test(l)) { try { b.click(); } catch (_) {} return; }
    }
  }
  function postToZoomChat(text) {
    if (!text) return;
    if (!zoomChatInput()) openZoomChat();
    let tries = 0;
    const timer = setInterval(() => {
      const el = zoomChatInput();
      if (!el) { if (++tries > 12) clearInterval(timer); return; }
      clearInterval(timer);
      el.focus();
      if (el.tagName === 'TEXTAREA') {
        const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (d && d.set) d.set.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else { // contenteditable
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      setTimeout(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }, 120);
    }, 200);
  }

  function grabContext() {
    const sel = (window.getSelection && String(window.getSelection() || '')).trim();
    if (sel.length > 20) return sel.slice(0, 8000);
    const hints = ['[aria-label*="companion" i]', '[aria-label*="summary" i]', '[class*="summary" i]', '[aria-label*="meeting summary" i]'];
    for (const h of hints) { try { const el = document.querySelector(h); if (el) { const t = (el.innerText || '').trim(); if (t.length > 60) return t.slice(0, 8000); } } catch (_) {} }
    return '';
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg) return;
    // Liveness probe from the SW. Without it every ensureCapture() re-injects this script blindly,
    // and two live instances scrape the same captions.
    if (msg.type === 'ping') { sendResponse({ ok: true, gen: GEN, started, session }); return; }
    if (msg.type === 'capture-mode') { sttPaused = (msg.captions === false); sendResponse({ ok: true }); return; }
    if (msg.type === 'grab-context') { sendResponse({ text: grabContext() }); return; }
    if (msg.type === 'call-chat') { postToZoomChat(msg.text); sendResponse({ ok: true }); return; }
  });

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    makeBadge(); tick(); setInterval(tick, 1500);
  }, 800);
})();
