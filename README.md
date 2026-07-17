# Meet Live Assist — Chrome extension

Live Google Meet assistant. During a call it captures the transcript, shows it in a side panel,
and (Path A) feeds the local transcript server so a Claude Code session with your context can
advise you in real time.

**This is a personal / dogfood tool**, distributed unpacked — not a public Chrome Web Store product.
See `../agent/.../meet-live-assist-BUILD-PLAN.md` for the full plan and why.

## Status: Phase 0 (spike)

Goal of Phase 0 is to prove the MV3 architecture, not to ship features:

- Content script scrapes Meet captions (ported from the Tampermonkey userscript).
- Service worker routes lines and keeps the local server (`127.0.0.1:8848`) fed — **so the existing
  Claude Code flow is unchanged**.
- Side panel renders the live transcript and, being a persistent page, keeps the SW alive so
  capture never stalls on a long call.

No LLM/advice wiring yet — that is Phase 1.

## Architecture (why it's shaped this way)

- **Streaming + state live in the side panel, not the service worker.** The SW is event-driven and
  gets torn down (~30s idle / 5-min cap); durable state is in `chrome.storage.session`, and the
  panel re-hydrates via a `restore` message on (re)connect.
- **Keep-alive:** the side panel holds a `runtime.connect` port and pings it every 20s; a
  `chrome.alarms` heartbeat (30s) wakes the SW even after it was unloaded.
- **Server POST happens in the SW** (has `127.0.0.1:8848` host permission), not the content script.

## Load it (unpacked)

1. Make sure the transcript server is running (launchd autostart is already installed):
   `curl -s http://127.0.0.1:8848/health` → `{"ok":true,...}`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
3. Pin the extension; click its toolbar icon to open the side panel.
4. (Optional) right-click the icon → **Options** to change the server URL.
5. Disable the old Tampermonkey userscript to avoid double-capture.

## Phase 0 acceptance test

- [ ] Join a real Meet call → within a few seconds the side panel shows `capturing` and live lines.
- [ ] `server ✓` shows green; the transcript file under `meet-live-assist/transcripts/` grows.
- [ ] **SW-death resilience:** open `chrome://serviceworker-internals` (or just wait), let the SW go
      idle / click "Stop" on the extension's SW, keep talking — capture resumes and the panel
      re-hydrates without a reload. Verify a **10-minute** call captures end-to-end with no gaps.
- [ ] Leave the call → panel shows `call ended`.

## Phase 1 (in progress) — advice + visual context

Brain = a Claude Code session (subscription, no API key) via the `meet-live-assist` skill.

- **Advice channel:** the brain POSTs advice to the server (`POST /advice {session, marker, text}`); the
  side panel polls `GET /advice?session=&since=` and renders each with its colour marker
  (🟢SAY / 🔵INFO / 🟡SUMMARY / 🟣EXPLAIN / 🔴RISK / 🟠ACTION).
- **Visual context:** the extension captures the Meet tab (periodic, default 60s, + the panel's 📷 button)
  and POSTs it (`POST /snapshot`); frames are saved to `meet-live-assist/transcripts/snapshots/<session>/` (~40 kept)
  for the brain to Read on demand.
- Agentic actions (Tier1/Tier2, drafts-only) stay in the session/call per the skill — the panel is display-only.

### Permissions liability
`<all_urls>` host permission is present because `captureVisibleTab` requires it for unattended periodic
capture (a per-site grant is not enough). Fine for unpacked/dogfood; **must be tightened / justified before
any Chrome Web Store or shared distribution.**

## Roadmap

- **Auth north-star (product):** user authorizes a provider (Claude, later ChatGPT) in the extension's
  settings and it "just works." Reality: the Agent SDK / API is **API-key based, not account-OAuth**, and a
  pure extension can't run the MCP agent brain (needs Node). So the full-brain path needs a local bridge or a
  hosted backend; the pure-extension path is BYO-key (weaker, no MCP). Revisit in Phase 3.
- **Phase 2:** replace caption scraping with `chrome.tabCapture` audio → streaming STT; auto-detect "key
  moments" for snapshots; in-panel chat.
- **Phase 3 (optional):** Agent SDK brain (`@anthropic-ai/claude-agent-sdk`, `settingSources:["user"]` to
  inherit CLAUDE.md + MCP) via local bridge, or backend proxy / BYO-key (Path B) for sharing; privacy policy;
  Workspace private store.
