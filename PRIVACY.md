# Privacy Policy — Meet Live Assist

_Last updated: 2026-07-18. Internal / private preview._

Meet Live Assist is a **local-first** browser extension. It has no accounts, no analytics, and no
first-party servers. This policy describes what the extension accesses and where it goes.

## What the extension accesses
- **Google Meet page content** (`https://meet.google.com/*`): the on-screen caption text, screen-share
  state, the meeting's caption language, and the microphone mute control — read to produce the live
  transcript and to drive assistance.
- **Screenshots of the active tab** while you are in a Meet call, for visual context (e.g. shared slides).
- **The text you type** into the extension's chat box.
- **Extension settings** you enter (local server URL, server token, chosen TTS voices, your name(s) for
  mention alerts) — stored with `chrome.storage`.

## Where the data goes
All of the above is sent **only** to a server you run on your own machine at `http://127.0.0.1:8848`
(the bundled bridge server). From there it is available to your own local assistant session.
- The extension makes **no requests to any third-party or first-party remote server.**
- Transcripts and snapshots are written to files on **your** machine.
- If your local assistant uses a cloud LLM, the transcript/chat you route to it are subject to **that
  provider's** policy — that choice and configuration are yours, outside this extension.

## What is NOT collected
No accounts, no telemetry, no advertising identifiers, no selling or sharing of data. The extension does
not transmit data off your device on its own.

## Retention & control
- The local server is **token-authenticated** (`X-MLA-Token`) so no other site or app can read it.
- Stored transcripts, chat, summaries and snapshots are **auto-purged after a retention window** (default
  14 days, configurable via `RETENTION_DAYS`).
- You can **wipe a single meeting's data** at any time from the panel (🗑), which deletes its transcript,
  chat, summary and snapshots immediately.

## Recording & consent
Capturing a meeting transcript and screenshots is a form of recording. You are responsible for obtaining
participants' consent where required (e.g. two-party-consent jurisdictions), especially on external calls.
The panel shows a one-time disclosure reminder at the start of each call.

## Permissions — why each is requested
See `STORE.md` for the per-permission justification.

## Contact
Internal preview — direct questions to the maintainer (Krystian).
