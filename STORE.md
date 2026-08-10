# Chrome Web Store listing - Meet Live Assist

Draft listing copy + the permission justifications the review dashboard asks for. Suggested first rollout:
**unlisted** (same review, no discovery, so a rejection costs nothing publicly), then public.

**Upload `./build.sh --public` → `dist/meet-live-assist-<version>-public.zip`, not the full build.** The
public zip drops the `debugger` permission and strips the page-control + live-debugging surface (DOM edits,
agent-driven clicks, network/console reads) so the listing has one purpose: a meeting assistant that sees
and hears. The full `./build.sh` zip keeps everything and is for load-unpacked use only. What the cut
covers is marked `mla:pro-start` / `mla:pro-end` in `src/`; the build fails rather than shipping a dangling
reference. The bundled skill is cut the same way, by `install.sh` (see `MLA_PRO`).

## Short description (≤132 chars)
Live co-pilot for Google Meet & Zoom: real-time transcript, colour-coded advice, action items, snapshots,
chat, and speak-into-the-call TTS.

## Detailed description
Meet Live Assist turns a Google Meet or Zoom call into a live, context-aware workspace. It captures the
transcript in real time and connects to your own local assistant, which pushes colour-coded advice
(what to say, facts, summaries, risks, actions), keeps a live decisions & action-items board, answers you
in an in-panel chat, and - with an optional virtual-audio setup - can speak suggestions straight into the
call in the meeting's language. Snapshots of shared screens give the assistant visual context. A co-pilot
mode works without any meeting (it listens to your mic and watches the tab) for pair-debugging.

The extension talks to one place only: a companion server you run on your own machine. It has no accounts,
no analytics and no servers of ours, and your transcripts stay in files on your disk. What your assistant
then does with them is your configuration: if it uses a cloud model, that model's provider sees what you
route to it.

## Category
Productivity

## Permission justifications
- **sidePanel** - the entire UI (transcript, advice, chat) lives in the side panel.
- **storage** - persist user settings (local server URL, chosen TTS voices).
- **alarms** - periodic heartbeat that keeps the service worker alive during long calls.
- **host `https://meet.google.com/*` + `https://*.zoom.us/*`** - read captions/state and inject the assistant UI.
- **host `http://127.0.0.1:8848/*`** - talk to the user's own local bridge server.
- **tabCapture** - capture the meeting tab's audio for optional local speech-to-text.
- **offscreen** - the only MV3 surface that can consume the captured audio stream (tab or mic).
- **clipboardWrite** - copy an advice line to paste into the meeting chat.
- **notifications** - fire a system alert on a 🔴 RISK advice item when the panel is hidden mid-call.
- **scripting** - inject the caption reader into the meeting tab.
- **debugger** - **not in the public build.** Chrome forbids `debugger` in `optional_permissions`, so it can
  only be required, and required it draws heavier review plus a scarier install warning for a capability the
  store build no longer uses. `build.sh --public` removes both the permission and the code behind it.

**Optional (requested at runtime, on a user gesture - not at install):**
- **optional host `<all_urls>`** - needed by `captureVisibleTab` to snapshot a shared slide or app, and by
  co-pilot mode, which watches the tab the user is working in. Requested only when the user starts co-pilot,
  takes a snapshot outside the meeting tab, or grants it from the setup checklist, so the install-time host
  prompt stays limited to Meet/Zoom + localhost. Kept in the public build: without it the assistant is
  deaf to anything on screen, which is half of what it is for.

## Data disclosure (Limited Use)
Collects meeting transcript text, tab screenshots, and typed chat **only** to provide the single purpose
(live meeting assistance), transmits them **only** to the user's own local server, and does not sell,
transfer, or use them for unrelated purposes. The local server is **token-authenticated** (no other site can
reach it), stored data is **time-purged** (default 14 days) and wipeable per meeting from the panel.
Privacy policy: `PRIVACY.md`.

## Pre-publish checklist
- [x] `<all_urls>` optional, requested at runtime on a gesture (host prompt = Meet/Zoom + localhost).
- [x] `debugger` and the page-control surface stripped from the public build (`build.sh --public`).
- [x] Bundled skill is a template, not the author's personal one (`install.sh` fills user/language/domain).
- [x] Privacy policy hosted publicly (https://krystiangw.github.io/meet-live-assist/) - link it in the listing.
- [ ] Rebuild the upload zip at the version you are submitting (`npm run build:public`).
- [x] Screenshots (1280x800), four to choose from:
      `store-3-in-a-call.png` and `store-4-screen-share.png` are the extension in a call (`tools/media/stage.mjs`);
      `store-1-advice.png` and `store-2-co-pilot.png` are caption tiles (`tools/media/store.mjs`).
- [ ] Note in the listing that a local companion server is required (link the docs/integration page).
- [ ] Note that the first 📷 asks for screen access: `<all_urls>` is granted on a gesture, not at install,
      so an unexpected prompt reads as a failure. Same for starting co-pilot.
- [ ] Pick a licence and decide whether the source repo goes public alongside the listing.
- [ ] Submit unlisted first; go public once the review comes back clean.

## Disclosure to other participants

Capture posts a single line into the meeting chat when it starts ("I'm using an AI assistant that
transcribes this meeting locally on my machine"), sent as the user, once per meeting. It is **on by
default**; the wording is editable and it can be turned off in Options. Turning captions on is invisible to
the rest of the room, so this is what makes the transcript visible to them. Delivery is verified and a
failure is surfaced in the panel rather than assumed.
