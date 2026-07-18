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
- **tabCapture** — capture the Meet tab's audio for optional local speech-to-text.
- **offscreen** — the only MV3 surface that can consume the captured audio stream.
- **scripting** — apply presentation-only, revertable DOM edits + read page storage on the shared tab.
- **debugger** — read network/console of the shared tab for live debugging (behind the 🐞 toggle; shows the
  DevTools banner while attached). **Liability**: `debugger` draws heavy Web Store review — keep it strictly
  user-toggled and consider dropping it for a public listing.
- **host `<all_urls>`** — required by `chrome.tabs.captureVisibleTab` for unattended periodic snapshots and
  by `scripting`/`debugger` on the shared app tab. **Liability**: overly broad for public distribution;
  scope down (e.g. `activeTab` + gesture) before a public listing.

## Data disclosure (Limited Use)
Collects meeting transcript text, tab screenshots, and typed chat **only** to provide the single purpose
(live meeting assistance), transmits them **only** to the user's own local server, and does not sell,
transfer, or use them for unrelated purposes. Privacy policy: `PRIVACY.md`.

## Pre-publish checklist
- [ ] Tighten `<all_urls>` → `activeTab`/gesture-gated capture, or justify in review.
- [ ] Host the privacy policy at a public URL (Pages) and link it in the listing.
- [ ] Screenshots (1280×800) of the panel in a call.
- [ ] Decide public vs. Workspace-private distribution.
