# Changelog

Notable changes only. Earlier history is in `git log` (91 commits from 2026-07-17); this file starts at the
point the project was prepared for a public release, because that is where a version number began to mean
something to anyone other than the author.

## Unreleased - preparing a free, self-hosted release

The decision behind this section: no hosting. Anyone can install this on their own machine, for free, and
the point of the work below is that a stranger can actually get to the end of it.

### The install lost a step, and it was the worst one

- **The extension pairs with the server instead of being handed a token.** `GET /pair` returns the token
  exactly once, and only while a window is open - the server's first ever boot, or a run with `--pair`,
  which against an already-running server just re-opens the window on it. A claim must carry `X-MLA-Pair: 1`
  (a web page cannot send it without a preflight that betrays its origin) and any `Origin` present must be
  `chrome-extension://`. The first claim closes the window and the extension id that took it is logged.
  This does not stop another extension of yours that already holds a `127.0.0.1` permission from racing you
  inside those two minutes, which is why the window is not simply left open. Pasting by hand still works.
- **`install.sh` registers the MCP adapter** at user scope instead of printing it as homework. Skipping it
  left the skill's first step - the `attach` tool - with nothing to call, and the failure read as a broken
  skill rather than a step nobody ran.

### A licence

- **[PolyForm Internal Use 1.0.0](LICENSE.md)**: free to use, including at your company; no redistribution,
  no resale, no hosting it as a service. Source-available rather than open source, deliberately - the point
  is that it stays owned while being free to use.
- The first choice was PolyForm *Noncommercial*, and it was wrong: its permitted purposes are personal,
  hobby, academic and non-profit only, so it would have forbidden the one thing this tool exists for - a
  meeting at a company. Caught by reading the licence text against the use case before committing it.

### It stops being the author's tool

- Mention alerts defaulted to three of the author's names, ticket keys linked to their employer's Jira, the
  Options hint carried an absolute `/Users/...` path, and a quick-ask chip named the author in the prompt it
  sent. All of it fired on a stranger's meeting. Both defaults are now empty, which the code already handled
  correctly: no names means no mention alerts, no Jira base means ticket keys stay plain text.
- The checked-in launchd plist is gone. It carried the author's absolute paths and, in the installed copy, a
  stray second path as an argument; `install-server.sh` generates the real one from the machine it runs on.
- The README says what this is, that **Claude Code is required**, and that the meeting is other people's
  conversation too - before the install, not after it. It also documents what is stored, where, and how to
  delete all of it. One claim in it was simply false and is corrected: the npm package is **not** published,
  so `npx meet-live-assist-server` 404s. Publishing it is now unblocked by the licence but is a separate,
  deliberate act - it is not something to do as a side effect of a docs edit.
- After your first call ends, the panel asks once whether it was any use. Once, ever.

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

### A second review, and what it found

Twelve more defects, each reproduced before being fixed. The ones that would have hurt most:

- The adapter cached the data dir it discovered from the server, but latched the guess on **failure** too.
  It starts with the client's session, normally *before* the server, so the usual case was: pin the wrong
  directory, then report "token rejected" for the rest of the session while pointing at a path where no
  token has ever been.
- `attach` refused the meeting it was **already assisting**. The heartbeat it checked is bumped by the
  assistant's own `working` calls, so a client reconnecting mid-call saw its own liveness, and the skill's
  documented answer to a refusal is to stop and tell the user. It now compares the claim name; a different
  assistant is still refused, and now named.
- A mid-turn `poll` could swallow the wake the loop still owed - including **Stop**, which has no other
  route. The loop and the tools now read under separate positions, which costs nothing because a reader
  nobody has seen before starts at the end of the channel rather than replaying the meeting. `backlog=1`
  is how the loop asks for the meeting so far on its first read.
- A consumer name of `constructor` or `__proto__` survived sanitising and then inherited from
  `Object.prototype`, so that reader's offset came back as a function and its batch was empty forever, with
  no error anywhere.
- One stray `null` on stdin killed the adapter: destructuring threw, and the catch handler threw again
  reading `msg.id`. A batched request was silently discarded, leaving the client waiting forever.
- Non-ASCII text at the size caps. The wake channel cut on a byte boundary, costing one replacement
  character on each side and leaving the next read starting mid-character; `/transcript` capped by UTF-16
  code units against a byte limit, letting through half again as much on Polish (3x with emoji) and able to
  leave a lone surrogate at the cut. Both now cut on whole lines. `lines` reports what came back.
- The wake loop's own failures were invisible: a rejected token printed the 403 body every two seconds - a
  wake storm, the exact opposite of the gate's purpose - and a dead server was indistinguishable from a
  quiet meeting. It now says either once, backs off, and has a timeout.
- Two tool calls in one turn could write to the previous meeting, because `pinned` is set only after
  `attach`'s round trips. Tool calls are serialised.
- Read positions were unbounded: `consumer` comes off the query string, and 2000 of them measured 807 KB
  re-serialised on every snapshot tick. Bounded to 8 per session, least-recently-seen evicted, and the
  status signature is a digest instead of the whole status object.
- `attach` could not target a session that has only a chat file - which is exactly the documented recovery
  from the `undefined` incident, since in that scenario the transcript is going to the wrong file.
- A session line count lost the last line of a file with no trailing newline.

### A third review, of the second review's fixes

Fixing twelve things introduced eleven more, which is the argument for reviewing fixes rather than only
features. Four of them were in the wake loop, the one component that can start an assistant's turn: it read
the token from the file only when the environment did *not* have one (exactly backwards - the loop runs in a
shell that does not inherit this process's environment), reported an unreachable server every two seconds
instead of backing off, told a rejected token apart from real content by matching the body against
`forbidden*` (which also matches a transcript line starting with that word, and swallowed it), and left the
token path unquoted so a data dir with a space in it produced a false "paste the token again".

The rest were in the read positions the second review had just split apart. `seed` was honoured only when
creating a position, so a re-attach fell through to a real read and ate the batch the loop had not collected.
Eviction protected recently-seen readers, which is backwards - forty one-shot readers are all newer than a
wake loop - so it evicted exactly the reader whose place must not be lost; it now goes by how established a
reader is. A fresh reader's chat position still started at zero, so its first poll returned every question the
user had typed all meeting. And `/transcript` returned an empty string when the newest line alone exceeded the
cap, making that content unreachable by any tail.

The review also demonstrated that **four of the previous round's fixes had tests that passed for unrelated
reasons** - including the headline one, which no test touched at all because every adapter in the suite was
handed both environment variables and so never ran the discovery path. Each now has a check that fails when
the fix is reverted.

### A fourth review, of the third's fixes

Seven more, two of them introduced by the third round's fixes. The critical one: an assistant attaching to a
meeting that already held the maximum number of readers received **nothing at all** and woke every two
seconds for the rest of the call - ranking eviction by how established a reader is put a freshly created one
last, so it was evicted before its first read and recreated at the end of the channel by its own next poll.

The wake loop needed rewriting again. It glued the last line of every batch to the first line of the next
(`$(...)` strips trailing newlines) in the assistant's primary input; it used `--fail-with-body`, which
landed in curl 7.76, so on Debian 11, Ubuntu 20.04, RHEL 8 or macOS 11 it reported a perfectly healthy
server as unreachable, permanently; and it tied "report this once" to the retry cadence, so a second failure
was reported to nobody and a recovered server went unnoticed for thirty seconds. **None of this was caught
by four rounds of review because no test ever ran the script against a working server** - only against a
dead one. It does now.

**And one older than all of it, found while testing the above: every request body was corrupted at chunk
boundaries.** Twenty-nine handlers accumulated `body += chunk`, decoding each Buffer separately, so any
character whose bytes straddled a 64 KB boundary was destroyed - silently, in exactly the two things this
product carries: long Polish captions and the wrap-up summary. They now share one helper that concatenates
bytes and decodes once.

### Keyed by (user, session)

The prerequisite for ever running this for more than one person. Every store
and every path is now derived from a `(user, session)` pair rather than a session name alone.

**For a local install this is invisible, deliberately.** The single-user profile resolves with no extra path
segment, so the file names, the directory and the layout are exactly what they were: an existing install
needs no migration, and a server can be swapped underneath one that is already running. `test/scope.mjs`
and a listing assertion in `test/retention.mjs` are there to fail if that ever stops being true.

`server/scope.js` owns the rules. Its own module because the two failure modes are severe in opposite
directions - too strict and a meeting becomes unreachable, too loose and one user reads another's call -
and because with one user nothing else in the suite can exercise the second one.

The pair travels as a single string joined by NUL, which cannot appear in a sanitised segment or in a
filename. A plain `user:session` prefix would let someone name their meeting `bob:standup` and read Bob's;
this cannot be forged, and the suite proves it for several spellings of the attempt.

`userOf()` is the seam and currently returns a constant. Step 4 (per-user tokens on the extension side,
OAuth on the MCP side) is the only thing that has to change to make it real.

The refactor shipped four regressions of its own, all with the same root cause: the pair was joined with
NUL, so a key that reached a path helper by mistake made the fs call throw into one of the empty catch
blocks this server uses for missing files. A missed site therefore failed **silently and reported
success** - `/clear` deleted nothing, `/snapshots` returned an empty list. The separator is a plain `~`
now, and a missed site produces a visibly wrong file that a listing assertion catches. State written under
the old keys is migrated on boot rather than stranded.

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

`npm test` is now five suites, ~296 checks: the server contract, **the panel's own request cycle replayed
without a browser**, the MCP adapter over stdio, **the size caps with non-ASCII text**, and retention plus
cross-meeting leaks. Each fix above was reproduced first and is covered by a check that fails when the fix is
reverted. Also validated against a copy of a real 113 MB data dir with 75 sessions, and by driving the adapter
by hand over a pipe with no environment - between them that is where five of the defects came from.

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
