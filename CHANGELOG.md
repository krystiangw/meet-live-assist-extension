# Changelog

Notable changes only. Earlier history is in `git log` (91 commits from 2026-07-17); this file starts at the
point the project was prepared for a public release, because that is where a version number began to mean
something to anyone other than the author.

## 0.4.0 - 2026-08-05

A restart no longer costs you a meeting, and the assistant reaches the server through MCP tools instead of
`curl` plus a byte offset in a shell variable.

### State survives a restart

- Advice, the decisions board, chat, the wrap-up, the wake buffer and each assistant's read position load from
  and snapshot to `<transcripts>/.state/`. Bouncing the server mid-call costs at most the last two seconds
  (`STATE_SNAPSHOT_MS`), not the meeting. The README's "never restart it during a live call" warning is gone.
- The snapshot is periodic rather than write-through because values are mutated in place: `/items` calls
  `set()` once and then pushes onto the list, so a `set()` hook would have persisted an empty board.
- Stores stay `Map`/`Set` compatible, so the ~90 call sites are untouched.
- **Consent and lifecycle deliberately do not persist.** 🕹 drive, autopilot, pause/stop and the liveness
  stores are answers about one call, and a recurring series reuses its meet code: persisting them would hand
  back a Monday "the agent may click in my tab" on Thursday, and a Stop at the end of one call would kill the
  next call's assistant on its first turn. Request scratch (captured DOM, debugger dumps) never touches disk.
- Only one process may write a data dir. A second server on the same `TRANSCRIPTS_DIR` serves normally but
  does not persist, so a sandbox run beside the launchd job cannot rewind the live meeting.

### The assistant talks MCP

- `server/mcp-server.js`: a zero-dependency stdio MCP adapter, 12 tools, published in the same npm package as
  `meet-live-assist-mcp`. Register with `claude mcp add meet-live-assist -- node <repo>/server/mcp-server.js`;
  it asks the server where its data is, so it needs no environment.
- The keystone is `poll`: one call for the transcript batch worth a turn, the panel's state, and pending
  results, with the read offset held server-side per assistant. It replaces a file tail plus four `curl` calls
  a turn, and works with no filesystem in reach.
- `poll` reads the wake channel and does **not** flush it. Forcing the buffer on a 2-second poll would return
  every caption the gate was holding, which is the gate deleted and roughly 4x the assistant turns.
- New reads behind it: `/sessions`, `/poll`, `/transcript`, `/snapshots`.
- `attach` refuses a meeting another assistant is live on, skips sessions named `undefined`/`null`/`NaN`, and
  hands back the wake loop ready to run so the session and consumer identity cannot be mistyped.
- Pressing **Stop** now reaches the assistant. `poll` reports a state change, which is the only signal
  available once capture has ended and no further caption can arrive.
- The skill (1.5.0) is rewritten around the tools. Raw HTTP remains only for the page-driving surface, which
  will never have a hosted equivalent.

### Fixes

- A retention sweep could wipe the state of the meeting happening right now: one leftover `.mode.txt` past the
  cutoff was enough, because a recurring series reuses its meet code. It now forgets a session only once no
  file of it is left.
- Wake lines held by the gate were persisted without their flush timer and nothing re-armed it, so they waited
  on disk until the same meet code returned and then arrived as "what was just said". Boot re-arms buffers
  still inside their window and drops overdue ones, loudly.
- `.state` is `0700`; the files were already owner-only but the listing leaked meeting codes.
- The 🧠 pill no longer names an assistant whose heartbeat has stopped.
- A busy port says so instead of printing an unhandled `error` event and a stack trace.
- The MCP adapter no longer exits with a request still in flight when its client closes stdin.

### Tests

`npm test` is now four suites, ~143 checks: the server contract, **the panel's own request cycle replayed
without a browser**, the MCP adapter over stdio, and retention plus cross-meeting leaks. Each fix above was
reproduced first and is covered by a check that fails when the fix is reverted. Also validated against a copy
of a real 113 MB data dir with 75 sessions, which is what surfaced three of the adapter bugs.

## 0.3.0 - 2026-08-04

Everything needed to put the extension in the Chrome Web Store, plus a server anyone can run.

### Two builds

- `build.sh --public` produces the store zip. It drops the `debugger` permission and strips the surface that
  acts on pages (DOM edits, agent-driven clicks, network and console reads), leaving the assistant that sees
  and hears. The full `build.sh` build keeps everything, for load-unpacked use.
- The cut is driven by `mla:pro-start` / `mla:pro-end` markers. The build syntax-checks every stripped file
  and fails if a removed function is still referenced, so a broken strip cannot reach a review.
- `optional_host_permissions: <all_urls>` stays in both builds: co-pilot mode and snapshots need it, and as
  an optional permission requested on a gesture it never appears in the install prompt.

### The skill is a template, not one person's setup

- `SKILL.md` is parameterised with `__MLA_USER__`, `__MLA_LANGUAGE__` and `__MLA_DOMAIN__` alongside the
  existing path placeholders. `install.sh` fills them from `MLA_USER` / `MLA_LANGUAGE` / `MLA_DOMAIN` and
  **fails if any placeholder is left unsubstituted**.
- `MLA_PRO=1` keeps the page-control sections, matching the full build. Default drops them, so the skill
  never offers a control the panel does not have.
- Worked examples are generic: no real names, hostnames or ticket numbers.
- Regenerated from the current skill: the bundled copy had drifted to a snapshot that predated the `.wake`
  channel the server has written for weeks.

### The server runs off macOS, and installs without a clone

- Published as **`meet-live-assist-server`** (`server/package.json`, zero dependencies, ~25 kB):
  `npx meet-live-assist-server`.
- Binary paths resolve from Homebrew, `/usr/local`, `/usr/bin` and then `PATH`, instead of assuming Apple
  Silicon Homebrew. Service managers start with a PATH that has none of these, which is why absolute
  candidates are tried at all.
- Text-to-speech (`say`, `afplay`) and the BlackHole device check are gated on macOS and now fail with an
  explanation instead of an `ENOENT`. `/voices` returns an empty list rather than a 500.
- The default data dir is `~/meet-live-assist/transcripts` unless a `transcripts/` dir sits beside the
  checkout. Under `npx` the old default resolved inside the npm cache, where recordings do not belong.
- `WHISPER_PROMPT`'s default is generic technical vocabulary; product names belong in the env var.

### Fixes

- The 🔑 setup chip stayed on ✗ after pasting the token, because the storage listener updated the variable
  without re-rendering the checklist. On a first install the token is always pasted after the panel is open,
  so the chip contradicted a working setup.
- New `GET /auth-check` answers 200 with `{authed}` and the panel polls it instead of reading a 403 off a
  token-guarded route. The pill still tells the truth about auth, without a console error per poll before the
  token exists. A server too old to answer reports "restart to update" rather than "start it".

### Repo

- `package.json` with `lint` / `test` / `build` / `build:public` and `engines: node>=20`.
- `test/smoke.mjs`: 20 checks over the auth gate, `/auth-check`, the invalid-session guard, the append and
  advice round-trips, `since` paging and path traversal. Verified to fail when the auth gate is disarmed.
- GitHub Actions runs lint, the test and both builds on every push.
- Swept 251 lines of em and en dashes out of prose, leaving the two regex character classes that need them
  verbatim (whisper emits them as dialogue markers and the server strips them).

## 0.2.0 and earlier

Dogfood releases, `git log` is the record. Highlights: caption capture with speaker attribution and dedup,
the colour-coded advice channel, the decisions and action-items board, two-way chat, snapshots on
screen-share, local whisper STT with a resident model, text-to-speech into the call, meeting modes and
type-awareness, Zoom support, and the `.wake` gate that keeps a 40-minute call from costing hundreds of
assistant turns.
