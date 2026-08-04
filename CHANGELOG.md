# Changelog

Notable changes only. Earlier history is in `git log` (91 commits from 2026-07-17); this file starts at the
point the project was prepared for a public release, because that is where a version number began to mean
something to anyone other than the author.

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
