# Meet Live Assist - Chrome extension

Live Google Meet assistant. During a call it captures the transcript, shows it in a side panel,
and (Path A) feeds the local transcript server so a Claude Code session with your context can
advise you in real time.

**Integration guide / landing page:** [`docs/index.html`](docs/index.html) - a self-contained page.
Hosted (public docs-only repo, so this code stays private): **https://krystiangw.github.io/meet-live-assist/**
(source: `github.com/krystiangw/meet-live-assist`). It also opens fine locally (`open docs/index.html`).

**This is a personal / dogfood tool**, distributed unpacked - not a public Chrome Web Store product.
See `../agent/.../meet-live-assist-BUILD-PLAN.md` for the full plan and why.

## Status (v0.2)

Working, dogfood. What it does now:

- **Live transcript** - Meet captions scraped, streamed to the panel instantly, de-duplicated + monologue
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

**The assistant reaches it through MCP, not HTTP.** `server/mcp-server.js` is a zero-dependency stdio MCP
adapter over the same API, ~12 tools. Register it once:

```bash
claude mcp add meet-live-assist -- node <repo>/server/mcp-server.js
```

It asks the running server where its data dir is (`/health` needs no token) and reads the token from there,
so it needs no environment. The keystone tool is `poll`: one call returns the transcript batch worth a turn,
the panel's state, and any pending results, with the read offset held server-side per assistant. That
replaces four or five `curl` calls a turn plus a byte offset kept in a shell variable - and it works with no
filesystem in reach, which is what a hosted deployment needs.

What MCP does **not** do is wake the assistant: the protocol is client-pull, so nothing on the server can
start a turn. A client-side loop polling `/poll?...&format=text` remains the wake source; it prints only
when something happened - a batch worth a turn, a panel state change, a message typed in the panel chat, a
failed meeting-chat delivery, or its own inability to reach the server. The state change matters most: it is
the only way pressing Stop can reach an assistant at all, since capture ends there and no later caption
would arrive.

Read positions are per **reader**, held server-side, and a reader nobody has seen before starts at the *end*
of the channel - `backlog=1` is how the wake loop asks for the meeting so far on its first read. The loop and
the `poll` tool are deliberately separate readers: reading is destructive, so sharing a position let a
mid-turn tool call swallow a wake the loop still owed. Positions are bounded per meeting and evicted
least-recently-seen, which never touches a loop that is polling.

**Multi-tenancy seam.** State is keyed by `(user, session)`; see `server/scope.js`. On a local install the
single user resolves to the data dir itself, so nothing about the layout changes. The seam exists so a
hosted profile can namespace users without a second code path, and so the guarantee that one user cannot
reach another's meeting is stated in one place and tested directly.

**Auth:** every route except `/health` requires an `X-MLA-Token` header. The server generates the token
into `<transcripts>/.mla-token` on first start; **paste it into the extension Options once** (and the brain
reads the same file). Without it any website you visit could reach the localhost server.

**Two files per meeting.** `/append` writes every caption to `<session>.txt` - the complete record, nothing
dropped - and only appends a batch to `<session>.wake` when the batch is worth waking the brain for
(decisions, blockers, your name, real questions, accumulated substance). The assistant reads the wake channel
(through `poll`), never the raw transcript: that is what keeps a 40-minute call from costing hundreds of brain
turns. A held-back batch is never lost - it rides along with the next wake, and a force-flush fires after
`WAKE_FORCE_MS` regardless. `poll` reads that channel and deliberately does not force it: flushing on a
2-second poll would hand back everything the gate was holding, which is the gate deleted.

### Stand up the server

The server is published on its own as `meet-live-assist-server` (zero dependencies, `server/package.json`),
so a user who only wants to run it needs neither this repo nor a clone:

```bash
npx meet-live-assist-server
```

It prints the auth token to paste into the extension Options, and writes to
`~/meet-live-assist/transcripts` unless `TRANSCRIPTS_DIR` says otherwise. **Node 20+ is the only hard
requirement**; `ffmpeg` and `whisper-cli` are optional and only local STT depends on them. Binary paths
resolve from Homebrew, `/usr/local`, `/usr/bin` and then `PATH`, so Linux works as well as either Mac
architecture. **Text-to-speech is macOS-only** (`say` + `afplay`); elsewhere advice still shows as text in
the panel and only spoken output is missing. Details: [`server/README.md`](server/README.md).

Publishing a new version is `cd server && npm publish` (check `npm pack --dry-run` first: it should be
six files, ~42 kB - the server, the MCP adapter, the state store, the wake-channel cut helper, a README and the manifest).

### Autostart it on a Mac (launchd)

From a clone, if you want it to come back after a reboot:

```bash
git clone https://github.com/krystiangw/meet-live-assist-extension.git
cd meet-live-assist-extension
MLA_DRY_RUN=1 ./server/install-server.sh   # optional: see the plan + generated plist, change nothing
./server/install-server.sh                 # install as a launchd agent + start it
```

It resolves the machine-specific bits itself (node binary via `process.execPath` - a bare `which node` under
fnm/nvm points at a per-shell shim that dies with the shell; Homebrew prefix for `ffmpeg`/`whisper-cli`, so
Intel and Apple Silicon both work), writes `~/Library/LaunchAgents/com.mla.meet-transcript-server.plist`,
waits for `/health`, then prints the auth token to paste into the extension Options.

- **Only Node 20+ is required.** `ffmpeg` and `whisper-cli` are optional (`brew install ffmpeg whisper-cpp`);
  without them the server still runs - TTS-into-the-call and local STT are the parts that go dark.
- **Re-run it after `git pull`** - it is idempotent and restarts the service with the new code.
- Override defaults with env vars: `TRANSCRIPTS_DIR=~/mla PORT=8849 ./server/install-server.sh`.
  Default transcripts dir is `~/meet-live-assist/transcripts`, deliberately **outside** the repo - meeting
  text and screenshots are PII and must not risk being committed.
- The **brain** reaches the server through the MCP adapter, which asks it where its data is, so changing
  `TRANSCRIPTS_DIR` needs no change on the assistant's side. Only the launchd plist and the extension's
  token need to agree.

Manual run instead of launchd (handy for debugging - logs to your terminal, `Ctrl-C` stops it for real):

```bash
PORT=8899 TRANSCRIPTS_DIR=/tmp/mla node server/transcript-server.js
curl -s http://127.0.0.1:8899/health
```

**Operating it**

| | |
| --- | --- |
| health | `curl -s http://127.0.0.1:8848/health` |
| what the panel is asking of the brain | `curl -s -H "X-MLA-Token: $(cat <transcripts>/.mla-token)" "http://127.0.0.1:8848/status?session=<session>"` |
| logs | `~/Library/Logs/meet-live-assist-server.log` |
| restart | `launchctl kickstart -k gui/$UID/com.mla.meet-transcript-server` |
| stop for real | `launchctl unload -w ~/Library/LaunchAgents/com.mla.meet-transcript-server.plist` |

`KeepAlive` is on, so `kill`/`pkill` does **not** stop it - launchd restarts it within seconds.

**A restart mid-call is survivable.** Advice, the decisions board, chat, the wrap-up, the wake buffer and
each assistant's read position are snapshotted to `<transcripts>/.state/` and reloaded on boot, so a bounce
costs at most the last couple of seconds (`STATE_SNAPSHOT_MS`, default 2000) rather than the meeting. Two
things deliberately do **not** come back, because they are answers about one call and a recurring series
reuses its meet code: the panel's Stop/pause state, and consent (🕹 drive, autopilot). You will still see a
brief capture gap while the process is down.

Only one process may write a given data dir. A second server on the same `TRANSCRIPTS_DIR` serves normally
but does not persist (it logs why), so a sandbox run beside the launchd job cannot rewind the live meeting.

**Config** (all optional, set in the plist's `EnvironmentVariables` or on the manual command line):

| var | default | what it does |
| --- | --- | --- |
| `PORT` | `8848` | the extension has host permission for `127.0.0.1:8848` - changing it needs a manifest change |
| `TRANSCRIPTS_DIR` | `<server-dir>/../transcripts` | where transcripts, snapshots and `.mla-token` live |
| `RETENTION_DAYS` | `14` | purge transcripts + snapshots older than this (`0` = keep forever) |
| `WAKE_BASE_MS` / `WAKE_MAX_MS` | `10000` / `90000` | wake-gate backoff window: starts here, doubles on an empty batch up to the max |
| `WAKE_FORCE_MS` | `180000` | flush whatever is buffered after this long, gate or no gate |
| `WAKE_MAX_CHARS` | `4000` | flush early once a batch gets this big |
| `WAKE_MIN_GAP_MS` | `8000` | floor between two wakes |
| `FFMPEG` / `WHISPER_CLI` / `WHISPER_MODEL` / `TTS_VOICE` | Homebrew paths / `Zosia` | TTS + STT plumbing |

**Two copies of the server exist on the author's machine.** `server/transcript-server.js` here is the
version-controlled one; the live launchd service historically ran
`~/projects/meet-live-assist/meet-transcript/transcript-server.js`, which is **not** in any repo. They are
byte-identical as of 2026-08-04, but nothing enforces that - re-run `install-server.sh` to repoint launchd at
this repo copy and make it the only source.

## Two builds, and the skill that matches each

`./build.sh` zips everything this repo can do. `./build.sh --public` produces the **store** zip: it drops the
`debugger` permission and strips the surface that acts on pages (DOM edits, agent-driven clicks,
network/console reads), leaving the assistant that only sees and hears. The store reviews for a single
purpose, and the full build reads as a remote control. The cut is driven by `mla:pro-start` / `mla:pro-end`
markers in `src/`; the build refuses to ship a dangling reference to anything it removed.

The bundled skill is cut the same way and, more importantly, is a **template** - it addresses the user by
name, answers in their language and pre-briefs against their domain, none of which can be hardcoded for
someone else. `install.sh` fills it:

```bash
MLA_USER="Ada Lovelace" MLA_LANGUAGE=Polish MLA_DOMAIN="backend eng, payments" ./install.sh
MLA_PRO=1 ./install.sh      # keep the page-control sections (pairs with the full build)
```

It refuses to run on the author's machine without `MLA_FORCE=1`, because there the destination is the
canonical personal skill rather than a copy of the template.

## Checks

```bash
npm run lint            # node --check over src/ and server/
npm test                # all five suites below, ~296 checks
npm run test:scope      # the (user, session) rules in isolation
npm run test:server     # auth gate, session guard, round-trips, restart survival
npm run test:panel      # every request sidepanel.js makes, replayed without a browser
npm run test:mcp        # the MCP adapter over stdio JSON-RPC
npm run test:limits     # the size caps, with non-ASCII text
npm run test:retention  # the retention sweep, and content not leaking between meetings
```

Both run in CI on every push, along with both builds.

The suites are split by what they protect, not by layer. `test:panel` exists because the panel is the half
of the product a server test never touches - a renamed route or a cursor that stops advancing looks fine
from the assistant's side and leaves the user staring at an empty panel. `test:limits` is the only suite that
uses non-ASCII text, and three real defects were hiding behind English-only fixtures. `test:retention` needs
file timestamps and restarts with a gap, so it does not belong in the fast path.

## Load it (unpacked)

1. Make sure the transcript server is running - `curl -s http://127.0.0.1:8848/health` → `{"ok":true,...}`.
   On a fresh Mac install it first: `./server/install-server.sh` (see *Stand up the server on a Mac* above).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
3. Pin the extension; click its toolbar icon to open the side panel.
4. Right-click the icon → **Options** → paste the **server token** (`cat <TRANSCRIPTS_DIR>/.mla-token`; the
   installer prints it, and it is per-machine - a token from another Mac will be rejected).
   Optionally set TTS voices and your name(s) (for mention alerts). The panel's ⚙ shows a setup checklist.
5. Disable the old Tampermonkey userscript to avoid double-capture.

## Phase 0 acceptance test

- [ ] Join a real Meet call → within a few seconds the side panel shows `capturing` and live lines.
- [ ] `server ✓` shows green; the transcript file under `meet-live-assist/transcripts/` grows.
- [ ] **SW-death resilience:** open `chrome://serviceworker-internals` (or just wait), let the SW go
      idle / click "Stop" on the extension's SW, keep talking - capture resumes and the panel
      re-hydrates without a reload. Verify a **10-minute** call captures end-to-end with no gaps.
- [ ] Leave the call → panel shows `call ended`.

## Phase 1 (in progress) - advice + visual context

Brain = a Claude Code session (subscription, no API key) via the `meet-live-assist` skill.

- **Advice channel:** the brain POSTs advice to the server (`POST /advice {session, marker, text}`); the
  side panel polls `GET /advice?session=&since=` and renders each with its colour marker
  (🟢SAY / 🔵INFO / 🟡SUMMARY / 🟣EXPLAIN / 🔴RISK / 🟠ACTION).
- **Visual context:** the extension captures the Meet tab (periodic, default 60s, + the panel's 📷 button)
  and POSTs it (`POST /snapshot`); frames are saved to `meet-live-assist/transcripts/snapshots/<session>/` (~40 kept)
  for the brain to Read on demand.
- Agentic actions (Tier1/Tier2, drafts-only) stay in the session/call per the skill - the panel is display-only.

### Permissions
The `<all_urls>` host is **optional**, requested at runtime on a user gesture (starting co-pilot, turning on
🐞 Debug, or the setup checklist's *Grant* button), so the host prompt stays limited to **Meet + Zoom +
localhost**. `debugger` stays a **required** permission - Chrome forbids listing it as optional - so it's in
the install prompt (heavier review; a public build can drop it, the code degrades gracefully). Token auth
closes the "any website can drive the localhost server" hole. Build the store zip with `./build.sh`
(→ `dist/`, extension files only). Full listing + justifications: `STORE.md`.

> Reloading an already-installed copy will drop the now-optional `<all_urls>` grant - re-grant once from the
> panel (co-pilot / 🐞 / ⚙ setup → Grant).

## Roadmap

- **Mute-aware mic capture** (deferred 2026-07-28 - idea worth keeping). Muting yourself in Zoom does not stop
  the OS microphone, so the `mic` STT channel keeps recording asides nobody in the call heard, and the brain
  treats them as things you said in the meeting. Don't drop them - **label them** `You (muted):` so muting
  becomes a deliberate private voice channel to the assistant (still authorizes actions; never quotable as
  something said to the room). Open question is only how to read the state: the toolbar button is localized
  ("Wyłącz wyciszenie" / "Unmute"), so it needs a state attribute or an icon class, not a text match - the same
  fragility that already bit the caption selectors.

- **Auth north-star (product):** user authorizes a provider (Claude, later ChatGPT) in the extension's
  settings and it "just works." Reality: the Agent SDK / API is **API-key based, not account-OAuth**, and a
  pure extension can't run the MCP agent brain (needs Node). So the full-brain path needs a local bridge or a
  hosted backend; the pure-extension path is BYO-key (weaker, no MCP). Revisit in Phase 3.
- **Phase 2:** replace caption scraping with `chrome.tabCapture` audio → streaming STT; auto-detect "key
  moments" for snapshots; in-panel chat.
- **Phase 3 (optional):** Agent SDK brain (`@anthropic-ai/claude-agent-sdk`, `settingSources:["user"]` to
  inherit CLAUDE.md + MCP) via local bridge, or backend proxy / BYO-key (Path B) for sharing; privacy policy;
  Workspace private store.
