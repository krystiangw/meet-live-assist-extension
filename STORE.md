# Chrome Web Store listing — Meet Live Assist

Draft listing copy + the permission justifications the review dashboard asks for. Internal preview:
distribute via a Workspace **private/unlisted** channel first; go public only after the `<all_urls>`
scope is tightened and the privacy story is reviewed.

## Short description (≤132 chars)
Live Google Meet assistant: real-time transcript, colour-coded advice, screen snapshots, chat, and
text-to-speech into the call.

## Detailed description
Meet Live Assist turns a Google Meet call into a live, context-aware workspace. It captures the
transcript in real time and connects to your own local assistant, which pushes colour-coded advice
(what to say, facts, summaries, risks, actions), answers you in an in-panel chat, and — with an optional
virtual-audio setup — can speak suggestions straight into the call in the meeting's language. Snapshots
of shared screens give the assistant visual context. Everything runs against a local server on your
machine; nothing is sent to a third-party product.

## Category
Productivity

## Permission justifications
- **sidePanel** — the entire UI (transcript, advice, chat) lives in the side panel.
- **storage** — persist user settings (local server URL, chosen TTS voices).
- **alarms** — periodic heartbeat that keeps the service worker alive during long calls.
- **host `https://meet.google.com/*`** — read captions/state and inject the assistant UI on Meet.
- **host `http://127.0.0.1:8848/*`** — talk to the user's own local bridge server.
- **host `<all_urls>`** — required by `chrome.tabs.captureVisibleTab` for unattended periodic snapshots
  of the Meet tab. **Liability**: overly broad for public distribution; tighten (or gate snapshots behind
  a user gesture using `activeTab`) before a public listing.

## Data disclosure (Limited Use)
Collects meeting transcript text, tab screenshots, and typed chat **only** to provide the single purpose
(live meeting assistance), transmits them **only** to the user's own local server, and does not sell,
transfer, or use them for unrelated purposes. Privacy policy: `PRIVACY.md`.

## Pre-publish checklist
- [ ] Tighten `<all_urls>` → `activeTab`/gesture-gated capture, or justify in review.
- [ ] Host the privacy policy at a public URL (Pages) and link it in the listing.
- [ ] Screenshots (1280×800) of the panel in a call.
- [ ] Decide public vs. Workspace-private distribution.
