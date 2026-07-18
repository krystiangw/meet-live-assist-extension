# Chrome Web Store listing — Meet Live Assist

Draft listing copy + the permission justifications the review dashboard asks for. Build the upload zip with
`./build.sh` → `dist/meet-live-assist-<version>.zip` (extension files only). Suggested first rollout:
a Workspace **private/unlisted** channel, then public.

## Short description (≤132 chars)
Live co-pilot for Google Meet & Zoom: real-time transcript, colour-coded advice, action items, snapshots,
chat, and speak-into-the-call TTS.

## Detailed description
Meet Live Assist turns a Google Meet or Zoom call into a live, context-aware workspace. It captures the
transcript in real time and connects to your own local assistant, which pushes colour-coded advice
(what to say, facts, summaries, risks, actions), keeps a live decisions & action-items board, answers you
in an in-panel chat, and — with an optional virtual-audio setup — can speak suggestions straight into the
call in the meeting's language. Snapshots of shared screens give the assistant visual context. A co-pilot
mode works without any meeting (it listens to your mic and watches the tab) for pair-debugging. Everything
runs against a local server on your machine; nothing is sent to a third-party product.

## Category
Productivity

## Permission justifications
- **sidePanel** — the entire UI (transcript, advice, chat) lives in the side panel.
- **storage** — persist user settings (local server URL, chosen TTS voices).
- **alarms** — periodic heartbeat that keeps the service worker alive during long calls.
- **host `https://meet.google.com/*` + `https://*.zoom.us/*`** — read captions/state and inject the assistant UI.
- **host `http://127.0.0.1:8848/*`** — talk to the user's own local bridge server.
- **tabCapture** — capture the meeting tab's audio for optional local speech-to-text.
- **offscreen** — the only MV3 surface that can consume the captured audio stream (tab or mic).
- **clipboardWrite** — copy an advice line to paste into the meeting chat.
- **notifications** — fire a system alert on a 🔴 RISK advice item when the panel is hidden mid-call.
- **scripting** — apply presentation-only, revertable DOM edits + read page storage on the shared tab.

**Optional (requested at runtime, on a user gesture — not at install):**
- **optional `debugger`** — read network/console of the shared tab for live debugging. Requested only when the
  user turns on the 🐞 toggle (shows the DevTools banner while attached). Keeping it optional avoids the heavy
  install-time review flag.
- **optional host `<all_urls>`** — needed by `captureVisibleTab` for snapshots and by `scripting`/`debugger` on
  an arbitrary app tab (co-pilot mode, live edits/debug). Requested only when the user starts co-pilot, enables
  debug, or grants it from the setup checklist — so the install prompt stays limited to Meet/Zoom + localhost.

## Data disclosure (Limited Use)
Collects meeting transcript text, tab screenshots, and typed chat **only** to provide the single purpose
(live meeting assistance), transmits them **only** to the user's own local server, and does not sell,
transfer, or use them for unrelated purposes. The local server is **token-authenticated** (no other site can
reach it), stored data is **time-purged** (default 14 days) and wipeable per meeting from the panel.
Privacy policy: `PRIVACY.md`.

## Pre-publish checklist
- [x] Move `debugger` + `<all_urls>` to optional, requested at runtime on a gesture (install prompt = Meet/Zoom + localhost).
- [x] Build the upload zip (`./build.sh` → `dist/`).
- [x] Privacy policy hosted publicly (https://krystiangw.github.io/meet-live-assist/) — link it in the listing.
- [ ] Screenshots (1280×800): panel in a Meet call + co-pilot mode.
- [ ] Note in the listing that a local companion server is required (link the docs/integration page).
- [ ] Decide public vs. Workspace-private distribution.
