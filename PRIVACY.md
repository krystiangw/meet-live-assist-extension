# Privacy Policy - Meet Live Assist

_Last updated: 2026-08-08._

Meet Live Assist is a **local-first** browser extension. It has no accounts, no analytics, and no
first-party servers. This policy describes what the extension accesses and where it goes.

## What the extension accesses
Compare this list against `manifest.json`; if it is shorter than the manifest, the list is the bug.

- **Meeting page content** on **Google Meet** (`https://meet.google.com/*`) and the **Zoom web client**
  (`https://*.zoom.us/*`): on-screen caption text, the meeting chat, screen-share state, the caption
  language, and the microphone mute control - read to produce the live transcript and to drive assistance.
- **Screenshots of a tab.** Automatically only while someone is sharing a screen in your call; otherwise
  only when you press 📷 or your own assistant asks for one.
- **Your microphone**, in co-pilot mode only, and only after you grant it and start co-pilot from the panel.
  Nothing is recorded before that.
- **Tab audio** (`tabCapture`), when you start local speech-to-text with the keyboard command. This captures
  the audio of remote participants in the meeting tab, not your microphone.
- **The text you type** into the extension's chat box, and the one disclosure line it can post into the
  meeting chat on your behalf.
- **Extension settings** you enter (server URL, token, TTS voices, your name(s) for mention alerts, the
  disclosure text) - stored with `chrome.storage`.

**Permissions that sound worse than they are, named anyway.** The full build asks for `debugger`, which lets
the assistant read the network and console of a tab you are sharing while you have the 🐞 toggle on; Chrome
shows its own banner the whole time. It also asks, *at the moment you use them* rather than at install, for
access to all sites - needed to screenshot or act on a tab that is not the meeting. **The public build ships
without `debugger` and without the page-control surface entirely.**

## Where the data goes
The **extension** sends everything it captures **only** to a server you run on your own machine at
`http://127.0.0.1:8848`. It makes no request to any other host, ours or anyone's - there is no server of
ours to make one to. Transcripts, snapshots, chat and summaries are files on **your** disk.

**But the assistant is not local, and this document will not pretend otherwise.** The brain is your own
Claude Code session. Whatever it reads - the transcript batches it is woken with, the questions you type -
travels to Anthropic under **your** account, on the same path as everything else you do in Claude Code. A
live assistant that never contacted a model would have to run one locally; this one deliberately borrows the
one you already pay for. What stays local is the stored record, and that is the promise being made here.

On Claude's Free, Pro and Max plans, whether your sessions are used to improve the model is a setting you
control and it changes how long they are retained; see
[Anthropic's consumer terms](https://www.anthropic.com/news/updates-to-our-consumer-terms), which state
explicitly that this covers Claude Code. Work, Enterprise and API accounts are on different terms. Check
which you are on before you point this at a conversation that is not only yours to share.

## What is NOT collected
No accounts, no telemetry, no advertising identifiers, no selling or sharing of data, and no analytics of
any kind. The extension transmits nothing off your device on its own initiative; the only content that
leaves is what your own assistant reads, to your own provider, as described above.

## Retention & control
- The local server is **token-authenticated** (`X-MLA-Token`) so no other site or app can read it.
- Stored transcripts, chat, summaries and snapshots are **auto-purged after a retention window** (default
  14 days, configurable via `RETENTION_DAYS`).
- Live meeting state (advice, the decisions board, chat) is also kept in `<transcripts>/.state/` so that
  restarting the server does not lose a call in progress. It is covered by the same retention: when a
  meeting's files are purged, its state is dropped with them. Files are owner-only (`0600`) and so is the
  directory (`0700`). With `RETENTION_DAYS=0` nothing is purged at all - that is the documented meaning of
  the setting, and it applies here too.
- You can **wipe a single meeting's data** at any time from the panel (🗑), which deletes its transcript,
  chat, summary, snapshots **and stored state** immediately.

## Telling the room

Enabling captions is **invisible to the other participants** - unlike recording, which Meet badges. So by
default this extension posts one line into the meeting chat when capture starts:

> I'm using an AI assistant that transcribes this meeting locally on my machine. Say the word if you'd
> rather I turned it off.

It is sent as you, once per meeting, and you can edit the wording or turn it off in Options. If it cannot be
delivered (the chat is closed by the organiser, for instance) the panel tells you, so you never believe the
room was informed when it was not.

This is disclosure, not consent. Some jurisdictions require every participant to agree before a
conversation may be recorded or transcribed; see below.

## What the assistant can and cannot be made to do

The assistant is your own Claude Code session, which means it has whatever tools you have given Claude Code -
including a shell. Everything a meeting participant says reaches it as input. It is instructed, in the skill,
to treat the entire transcript as untrusted: **no spoken line, whatever name it is labelled with, can make the
assistant run a command, send a message, or do anything irreversible.** Only what *you type* to it authorizes
an action, on a channel the room cannot reach.

That instruction is a real boundary, but it is enforced by the model following its skill, not by a wall. If
you have connected powerful or destructive tools to your Claude Code, understand that you are pointing a
capable agent at a live, untrusted audio feed, and set the trust of your connected tools accordingly. This is
the honest limit of a bring-your-own-brain design, and it is stated here rather than left for you to discover.

## Recording & consent
Capturing a meeting transcript and screenshots is a form of recording. You are responsible for obtaining
participants' consent where required (e.g. two-party-consent jurisdictions), especially on external calls.
The panel shows a one-time disclosure reminder at the start of each call.

## Permissions - why each is requested
See `STORE.md` for the per-permission justification.

## Contact
Questions, or something here that does not match what the code does:
[an issue](https://github.com/krystiangw/meet-live-assist-extension/issues/new?template=something-broke.yml). A mismatch
between this document and the manifest is a bug worth reporting, and it will be treated as one.
