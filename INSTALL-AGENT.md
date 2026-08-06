# Install Meet Live Assist on this machine - instructions for a Claude Code agent

You (the agent) are setting up **Meet Live Assist** on a new machine. It has 3 parts: this **Chrome
extension**, a local **bridge server** (Node, `127.0.0.1:8848`), and the **`meet-live-assist` skill** (the
"brain" you run to advise during calls). Do the steps you can automate; hand the two Chrome-UI steps to the
user (you can't click Chrome).

## Prerequisites (check, don't assume)
- `node` on PATH (`node --version`). Required for the server. If missing, tell the user to install it and stop.
- `git` access to the repo (`gh auth status` or an ssh key) if you still have to clone it.
- Optional: `ffmpeg` (TTS into the call), `whisper-cli` (local STT). Not needed for core advice.

## Steps
1. **Clone (if not already here):**
   ```bash
   git clone git@github.com:krystiangw/meet-live-assist-extension.git
   cd meet-live-assist-extension
   ```
2. **Run the installer** - copies the skill to `~/.claude/skills/meet-live-assist` with this machine's data
   path wired in, registers the MCP adapter at user scope, and creates the transcripts dir:
   ```bash
   ./install.sh
   ```
   To put runtime data elsewhere: `MLA_TRANSCRIPTS_DIR=/desired/path ./install.sh`. Personalise the skill
   with `MLA_USER`, `MLA_LANGUAGE`, `MLA_DOMAIN` - otherwise it addresses the user by their login name, in
   English, with no idea what their meetings are about.
3. **Start the bridge server with a pairing window** (part of install/verification, so running it here is
   fine). Background it so it survives, then verify health:
   ```bash
   node server/transcript-server.js --pair   # run in background
   curl -s http://127.0.0.1:8848/health      # expect {"ok":true,...}
   ```
   The window lasts two minutes and the first claim closes it, so start it when the user is at the keyboard,
   not before. If it lapses, run the same command again - against an already-running server it just re-opens
   the window.
4. **Hand the user the one thing you cannot do** - Chrome UI:
   - `chrome://extensions` → **Developer mode** → **Load unpacked** → pick this repo folder.
   - Pin the icon and click it. The side panel pairs itself; there is no token to copy.
   - Only if pairing failed: `cat "<transcripts>/.mla-token"` and have them paste it into **Options**.
5. **Confirm the skill is installed:** `~/.claude/skills/meet-live-assist/SKILL.md` exists and its `DIR=`
   lines point at this machine's transcripts dir (install.sh already substituted them). In a **new** Claude
   Code session, invoking `meet-live-assist` will pick it up.
6. **Confirm the tools are registered:** `claude mcp list` shows `meet-live-assist`. Without it the skill's
   first step - the `attach` tool - has nothing to call, and the failure reads as a broken skill.

## Verify end-to-end
- `/health` returns ok, extension shows `server ✓` green.
- Join a test Meet call → side panel shows `capturing` + live lines within a few seconds; the transcript
  file under the transcripts dir grows.
- Run a Claude session with the `meet-live-assist` skill → it heartbeats (`🧠 assistant on` in the panel)
  and can post advice.

## Keeping the bundled skill in sync (for the maintainer, not the install)
`skill/meet-live-assist/SKILL.md` is the **distributable** copy; the maintainer's working copy is the
installed `~/.claude/skills/meet-live-assist/SKILL.md`. When that changes, re-sync it here and re-insert the
five placeholders `install.sh` fills per machine: `__MLA_TRANSCRIPTS__`, `__MLA_REPO__`, `__MLA_USER__`,
`__MLA_LANGUAGE__`, `__MLA_DOMAIN__`. **Never commit an absolute `/Users/...` path or a real name** - the
installer refuses to finish if any placeholder survives substitution, which catches a newly added one, but
nothing catches a hard-coded path that was never made into a placeholder.
