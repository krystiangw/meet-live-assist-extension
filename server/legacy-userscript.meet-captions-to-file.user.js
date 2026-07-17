// ==UserScript==
// @name         Google Meet Captions → local transcript (auto)
// @namespace    mla.local.meet
// @version      2.1.0
// @description  Fully automatic: auto-enables Meet captions, auto-captures them (no clicks), tags the speaker, and streams each line to a tiny local server that writes <meet-live-assist>/transcripts/<date_time_meeting>.txt — tailable live.
// @match        https://meet.google.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

/*
 * Pairs with transcript-server.js (run that once; see README).
 * No buttons to click per meeting — it starts itself when you're in a call.
 *
 * IF CAPTURE BREAKS: Google periodically renames the caption CSS classes / jsname.
 * Update the SEL block below (DevTools → inspect the caption area → copy new class names).
 */

(function () {
  'use strict';

  // ---- Server (transcript-server.js) ---------------------------------------
  const SERVER = 'http://127.0.0.1:8848';

  // ---- SELECTORS (update here if Google changes the DOM) -------------------
  const SEL = {
    region: ['[jsname="dsyhDe"]', '.a4cQT', 'div[aria-label="Captions"]', '.iOzk7'],
    block: ['.nMcdL', '.TBMuR', '.bh44bd'],
    speaker: ['.NWpY1d', '.KcIKyf', '.zs7s8d', '.jxFHg'],
    text: ['.ygicle.VbkSUe', '.bh44bd', '.iTTPOb', '.VbkSUe'],
  };

  // ---- TUNABLES ------------------------------------------------------------
  const FLUSH_STABLE_MS = 1200; // write a line once its text stops changing this long (= finalized)
  const POLL_MS = 350;          // caption scan interval
  const AUTO_CAPTIONS = true;   // auto-enable Meet captions on every call
  const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/; // a real call URL, e.g. ngt-eyri-xso
  const NOISE_RE = /jump to bottom|arrow_downward|arrow_upward/i; // non-caption UI controls inside the captions region

  const CC_LABEL_HINTS = ['caption', 'subtitle', 'napis', 'untertitel', 'sous-titre', 'subtítulo', 'subtitulo'];
  const CC_ON_HINTS  = ['turn off', 'wyłącz', 'wylacz', 'disable', 'stop'];
  const CC_OFF_HINTS = ['turn on', 'włącz', 'wlacz', 'enable'];

  // ---- STATE ---------------------------------------------------------------
  let session = null;       // current transcript filename stem
  let started = false;      // in a call + capturing
  let userPaused = false;   // manual pause via badge
  let lineCount = 0;
  let lastPostOk = true;
  let scanning = false;     // guards a single scan loop
  let currentCode = null;   // meeting code of the active session
  const trackers = [];      // [{ el, text, lastChange, flushed, speaker }]

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
    return { speaker, text };
  }
  function tsLabel() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ---- POST to local server (ordered) --------------------------------------
  let postChain = Promise.resolve();
  function postLine(line) {
    if (!session) return;
    postChain = postChain.then(() => new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SERVER + '/append',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ session, line }),
        timeout: 5000,
        onload: () => { lastPostOk = true; updateBadge(); resolve(); },
        onerror: () => { lastPostOk = false; updateBadge(); resolve(); },
        ontimeout: () => { lastPostOk = false; updateBadge(); resolve(); },
      });
    }));
    return postChain;
  }

  function flush(tr) {
    const text = (tr.text || '').trim();
    if (!text || text === tr.flushed) return;
    // Meet keeps a growing rolling caption per speaker — write only the NEW part, not the whole thing again.
    let out = text;
    if (tr.flushed && text.startsWith(tr.flushed)) out = text.slice(tr.flushed.length).trim();
    tr.flushed = text;
    if (!out) return;
    lineCount++;
    const who = tr.speaker || 'Unknown';
    postLine(`[${tsLabel()}] ${who}: ${out}\n`); // <-- speaker attribution
    updateBadge();
  }

  // ---- SCAN LOOP -----------------------------------------------------------
  function scan() {
    if (!started) { scanning = false; return; }
    if (!userPaused) {
      const region = firstRegion();
      if (region) {
        for (const el of blocksIn(region)) {
          const { speaker, text } = readBlock(el);
          if (!text || NOISE_RE.test(text)) continue; // skip non-caption UI (e.g. "Jump to bottom")
          let tr = trackers.find((t) => t.el === el);
          if (!tr) { tr = { el, text: '', lastChange: now(), flushed: '', speaker: '' }; trackers.push(tr); }
          if (speaker) tr.speaker = speaker;
          if (text !== tr.text) { tr.text = text; tr.lastChange = now(); }
        }
        for (let i = trackers.length - 1; i >= 0; i--) {
          const tr = trackers[i];
          if (!document.contains(tr.el)) { flush(tr); trackers.splice(i, 1); continue; }
          if (tr.text && tr.text !== tr.flushed && now() - tr.lastChange >= FLUSH_STABLE_MS) flush(tr);
        }
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

  // ---- SESSION NAME (date_time_meeting) ------------------------------------
  function meetingCode() {
    return (location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '');
  }
  function buildSession(code) {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `${date}_${time}_${code}`; // stable: date_time_meetingcode (no volatile document.title)
  }

  // ---- BADGE (status only; click to pause/resume) --------------------------
  let badge;
  function updateBadge() {
    if (!badge) return;
    if (!started) { badge.textContent = '○ idle'; badge.style.background = '#555'; return; }
    if (userPaused) { badge.textContent = '⏸ paused'; badge.style.background = '#8a6d00'; return; }
    if (!lastPostOk) { badge.textContent = '● server? (start it)'; badge.style.background = '#a11'; return; }
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
      // entered a call, or navigated to a different meeting → (re)start a session
      currentCode = code;
      session = buildSession(code);
      started = true;
      trackers.length = 0;
      captionsHandled = false;
      ensureCaptionsOn();
      postLine('');       // creates the file + header on the server
      startScan();        // single scan loop (guarded)
      updateBadge();
    } else if (!inCall && started) {
      started = false; session = null; currentCode = null; trackers.length = 0; updateBadge();
    }
  }

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    makeBadge();
    tick();
    setInterval(tick, 1500); // handle SPA navigation (lobby → call → leave)
  }, 800);
})();
