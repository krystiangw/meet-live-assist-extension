# Chrome Web Store listing - Meet Live Assist

Draft listing copy + the permission justifications the review dashboard asks for. Suggested first rollout:
**unlisted** (same review, no discovery, so a rejection costs nothing publicly), then public.

**Upload `./build.sh --public` → `dist/meet-live-assist-<version>-public.zip`, not the full build.** The
public zip drops the `debugger` permission and strips the page-control + live-debugging surface (DOM edits,
agent-driven clicks, network/console reads) so the listing has one purpose: a meeting assistant that sees
and hears. The full `./build.sh` zip keeps everything and is for load-unpacked use only. What the cut
covers is marked `mla:pro-start` / `mla:pro-end` in `src/`; a dangling reference fails the build. The bundled skill is cut the same way, by `install.sh` (see `MLA_PRO`).

## Short description (132 char limit; this is 122)
Live co-pilot for Meet & Zoom: real-time transcript, colour-coded advice, decisions and action items, all on your machine.

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

## Trademark notice (put this in the listing description)
Meet Live Assist is an independent project. It is not affiliated with, endorsed by or sponsored by Google or Zoom; "Google Meet" and "Zoom" are their owners' trademarks and are used here only to say which products this works with.

### Two things to say plainly in the description

**This needs a companion server on your own machine.** The extension is the eyes, ears and hands; the
assistant is an agent session you already run. Install: https://meet-live-assist.github.io/

**The first screenshot asks for screen access.** `<all_urls>` is granted on a gesture, not at install, so the
prompt appears the first time you press 📷 or start co-pilot. Without that sentence in the listing, an
expected prompt reads as a failure.

## Category
Productivity

## Permission justifications

| Permission | Why it is needed |
| --- | --- |
| `sidePanel` | The entire UI lives there: transcript, advice, chat. |
| `storage` | Persist settings: local server URL, chosen TTS voices. |
| `alarms` | Heartbeat that keeps the service worker alive through a long call. |
| host `https://meet.google.com/*`, `https://*.zoom.us/*` | Read captions and call state, inject the assistant UI. |
| host `http://127.0.0.1:8848/*` | Talk to the user's own local bridge server. |
| `tabCapture` | Capture the meeting tab's audio for optional local speech-to-text. |
| `offscreen` | The only MV3 surface that can consume a captured audio stream. |
| `clipboardWrite` | Copy an advice line to paste into the meeting chat. |
| `notifications` | Alert on a 🔴 RISK item when the panel is hidden mid-call. |
| `scripting` | Inject the caption reader into the meeting tab. |

**`debugger` is not in the public build at all.** Chrome forbids it in `optional_permissions`, so it can only
be required, and required it draws heavier review plus a scarier install warning for a capability the store
build no longer uses. `build.sh --public` removes the permission and the code behind it.

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
- [x] `manifest.json` `description` is 132 characters or fewer. The store rejects the upload over this and
      nothing local complains, so `build.sh` now fails the build instead of the dashboard failing the person
      holding the zip. The listing copy lives in `STORE-LISTING.txt`; the manifest reuses its short
      description word for word rather than keeping a second string that drifts.
- [x] `<all_urls>` optional, requested at runtime on a gesture (host prompt = Meet/Zoom + localhost).
- [x] `debugger` and the page-control surface stripped from the public build (`build.sh --public`).
- [x] Bundled skill is a template, not the author's personal one (`install.sh` fills user/language/domain).
- [x] Privacy policy at a URL that works: https://meet-live-assist.github.io/privacy.html
      (goes live with the docs sync; the form rejects a 404).
- [x] Upload zip rebuilt at the submitted version: `dist/meet-live-assist-0.7.2-public.zip`
      (226 KB across 17 files). Verified as an artifact at THIS version, not on the build script's word:
      manifest says 0.7.2, has 8 permissions and no `debugger`, host permissions are only Meet, Zoom and
      loopback, no `chrome.debugger` call survives the strip, every stripped file still parses, every path
      the manifest references exists inside the zip, and the caption fix is in the shipped source. Re-run
      this at every version: a check that describes the previous build is worse than no check.
- [x] Screenshots (1280x800): `store-1-in-a-call.png`, `store-2-screen-share.png`,
      `store-3-co-pilot.png` - the extension in a call, beside a shared screen, and in co-pilot mode.
      Regenerate with `node tools/media/stage.mjs`.
- [x] Small promotional tile (440x280): `store-promo-440x280.png`. The store treats this as mandatory and
      the form blocks without it. Regenerate with `node tools/media/promo-tile.mjs`.
- [x] The listing says a local companion server is required, and that the first 📷 triggers the screen-access
      prompt. Copy is under "Two things to say plainly in the description".
- [x] Licence picked: PolyForm Internal Use 1.0.0, and `package.json` points at the file because there is
      no SPDX identifier for it.
- [x] Source repo is public: https://github.com/krystiangw/meet-live-assist-extension
- [x] Submitted 2026-08-12, version 0.7.2, visibility **unlisted**.
      Item ID `elhddnpchalnmgcgdicegfggifojbadk`; the listing lives at
      https://chromewebstore.google.com/detail/elhddnpchalnmgcgdicegfggifojbadk once the review passes.
      The console warned this needs an in-depth review because `<all_urls>` is an optional host permission,
      so expect days rather than hours.
- [x] **Published 2026-08-15**, version 0.7.2, unlisted. In-depth review (triggered by the optional
      `<all_urls>`) took four days. Live at https://chromewebstore.google.com/detail/meet-live-assist/elhddnpchalnmgcgdicegfggifojbadk and confirmed against Chrome's own update service, which
      serves `..._0_7_2_0.crx` for this ID - the dashboard shows no submission history, so "the review
      finished" looks exactly like "the submission disappeared".
- [ ] Go public once one stranger has installed it and the first-run path is confirmed on someone else's
      machine. Ratings are public and permanent; the unlisted link is not.

## Disclosure to other participants

Capture posts a single line into the meeting chat when it starts ("I'm using an AI assistant that
transcribes this meeting locally on my machine"), sent as the user, once per meeting. It is **on by
default**; the wording is editable and it can be turned off in Options. Turning captions on is invisible to
the rest of the room, so this is what makes the transcript visible to them. Delivery is verified and a
failure is surfaced in the panel, never assumed.
