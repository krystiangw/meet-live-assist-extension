# Meet Live Assist — Chrome extension

Live Google Meet assistant. During a call it captures the transcript, shows it in a side panel,
and (Path A) feeds the local transcript server so a Claude Code session with your context can
advise you in real time.

**Integration guide / landing page:** [`docs/index.html`](docs/index.html) — a self-contained page.
Hosted (public docs-only repo, so this code stays private): **https://krystiangw.github.io/meet-live-assist/**
(source: `github.com/krystiangw/meet-live-assist`). It also opens fine locally (`open docs/index.html`).

**This is a personal / dogfood tool**, distributed unpacked — not a public Chrome Web Store product.
See `../agent/.../meet-live-assist-BUILD-PLAN.md` for the full plan and why.

## Status (v0.2)

Working, dogfood. What it does now:

- **Live transcript** — Meet captions scraped, streamed to the panel instantly, de-duplicated + monologue
  forced-flush before hitting the file/brain, with a conservative ASR glossary.
- **Colour-coded advice** from the brain (🟢SAY/🔵INFO/🟡SUMMARY/🟣EXPLAIN/🔴RISK/🟠ACTION), rich
  (links/images/diagrams/lists), each **copyable**; RISK fires an audible + notification cue.
- **Brain-liveness** pill (is a Claude session actually attached?), **capture watchdog** (warns if captions break).
- **Decisions & action-items board** with one-click **Draft Jira**; **recap** quick-asks; two-way **chat**.
- **Snapshots** (auto on screen-share + on demand), **TTS into the call**, **local STT** (whisper),
  **meeting modes** + type-awareness, **live presentation edits** + **debug** of the shared tab.
- **Talk-time**, **muted-mic** + **personal-mention** alerts; **post-call summary** export.
- **Privacy:** token-authed local server, per-meeting **clear**, time-based **retention**, consent nudge.

## Architecture (why it's shaped this way)

- **Streaming + state live in the side panel, not the service worker.** The SW is event-driven and
  gets torn down (~30s idle / 5-min cap); durable state is in `chrome.storage.session`, and the
  panel re-hydrates via a `restore` message on (re)connect.
- **Keep-alive:** the side panel holds a `runtime.connect` port and pings it every 20s; a
  `chrome.alarms` heartbeat (30s) wakes the SW even after it was unloaded.
- **Server POST happens in the SW** (has `127.0.0.1:8848` host permission), not the content script.

## The bridge server

The extension talks to a small local Node server (`127.0.0.1:8848`) that is the "brain" bridge:
transcript sink (`/append`), advice (`/advice`), board (`/items`), chat (`/chat`), snapshots
(`/snapshot`, `/snapshot-request`), TTS (`/speak`, `/voices`), STT (`/stt`), meeting mode (`/mode`),
presentation edits (`/edit`, `/dom*`), debug (`/debug*`), brain heartbeat (`/brain-ping`), summary
(`/summary`), per-meeting wipe (`/clear`), and health (`/health`).

**Auth:** every route except `/health` requires an `X-MLA-Token` header. The server generates the token
into `<transcripts>/.mla-token` on first start; **paste it into the extension Options once** (and the brain
reads the same file). Without it any website you visit could reach the localhost server.

`server/transcript-server.js` here is a **version-controlled snapshot**. The **live** copy runs from
`~/projects/meet-live-assist/meet-transcript/transcript-server.js` via launchd
(`com.mla.meet-transcript-server`, also snapshotted in `server/`). Keep the two in sync, or repoint launchd
at this repo copy to make it the single source. Requires `ffmpeg` (Homebrew) for TTS device routing;
launchd's PATH lacks it, so the server uses an absolute `/opt/homebrew/bin/ffmpeg`.

## Load it (unpacked)

1. Make sure the transcript server is running (launchd autostart is already installed):
   `curl -s http://127.0.0.1:8848/health` → `{"ok":true,...}`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
3. Pin the extension; click its toolbar icon to open the side panel.
4. Right-click the icon → **Options** → paste the **server token** (`cat ~/projects/meet-live-assist/transcripts/.mla-token`).
   Optionally set TTS voices and your name(s) (for mention alerts). The panel's ⚙ shows a setup checklist.
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
`<all_urls>` (needed by `captureVisibleTab` + `scripting`/`debugger` on the shared tab) and `debugger`
together make this **unpacked/dogfood only** — both must be tightened/justified before any Web Store or
shared distribution (see `STORE.md`). Added in v0.2: `clipboardWrite` (copy advice) and `notifications`
(RISK cue) — both low-review. The token auth closes the "any website can drive the localhost server" hole.

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
