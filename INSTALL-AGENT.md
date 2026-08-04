# Install Meet Live Assist on this machine - instructions for a Claude Code agent

You (the agent) are setting up **Meet Live Assist** on a new machine. It has 3 parts: this **Chrome
extension**, a local **bridge server** (Node, `127.0.0.1:8848`), and the **`meet-live-assist` skill** (the
"brain" you run to advise during calls). Do the steps you can automate; hand the two Chrome-UI steps to the
user (you can't click Chrome).

## Prerequisites (check, don't assume)
- `node` on PATH (`node --version`). Required for the server. If missing, tell the user to install it and stop.
- `git` auth to the private repo (`gh auth status` or an ssh key). The repo is private.
- Optional: `ffmpeg` (TTS into the call), `whisper-cli` (local STT). Not needed for core advice.

## Steps
1. **Clone (if not already here):**
   ```bash
   git clone git@github.com:krystiangw/meet-live-assist-extension.git
   cd meet-live-assist-extension
   ```
2. **Run the installer** - copies the skill to `~/.claude/skills/meet-live-assist` with this machine's data
   path wired in, and creates the transcripts dir:
   ```bash
   ./install.sh
   ```
   To put runtime data elsewhere: `MLA_TRANSCRIPTS_DIR=/desired/path ./install.sh`.
3. **Start the bridge server** (this is part of install/verification, so running it here is fine). Use a
   background run so it survives, then verify health:
   ```bash
   node server/transcript-server.js   # run in background
   curl -s http://127.0.0.1:8848/health   # expect {"ok":true,...}
   ```
   First start writes the auth token to `<transcripts>/.mla-token`.
4. **Give the user the token and the two manual steps** (you cannot do these - they are Chrome UI):
   ```bash
   cat "<transcripts>/.mla-token"   # the path install.sh printed
   ```
   Tell the user:
   - `chrome://extensions` → **Developer mode** → **Load unpacked** → pick this repo folder.
   - Right-click the icon → **Options** → paste the token above. (Pin the icon; click it for the side panel.)
5. **Confirm the skill is installed:** `~/.claude/skills/meet-live-assist/SKILL.md` exists and its `DIR=`
   lines point at this machine's transcripts dir (install.sh already substituted them). In a **new** Claude
   Code session, invoking `meet-live-assist` will pick it up.

## Verify end-to-end
- `/health` returns ok, extension shows `server ✓` green.
- Join a test Meet call → side panel shows `capturing` + live lines within a few seconds; the transcript
  file under the transcripts dir grows.
- Run a Claude session with the `meet-live-assist` skill → it heartbeats (`🧠 assistant on` in the panel)
  and can post advice.

## Keeping in sync (for the maintainer, not the install)
`server/transcript-server.js` and `skill/meet-live-assist/SKILL.md` here are the **distributable copies**.
The live originals on the author's machine are `meet-live-assist/meet-transcript/transcript-server.js` and
`~/.claude/skills/meet-live-assist/SKILL.md`. When those change, re-sync them into this repo. The bundled skill copy uses
two placeholders that `install.sh` fills per-machine: `__MLA_TRANSCRIPTS__` (the data/transcripts dir) and
`__MLA_REPO__` (this repo root, e.g. for the server path and cards dir). Re-generate the copy by replacing
the author-machine paths (`<meet-live-assist>/transcripts` → `__MLA_TRANSCRIPTS__`, `<meet-live-assist>/meet-transcript` →
`__MLA_REPO__/server`) - do not commit absolute `/Users/...` paths.
