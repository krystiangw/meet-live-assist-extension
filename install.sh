#!/usr/bin/env bash
# Meet Live Assist — one-shot local install on a new machine.
# Wires the 3 parts together: the bundled skill (-> ~/.claude/skills), the transcripts dir the server
# writes to, and the token the extension/brain share. Load-unpacked + paste-token stay manual (Chrome UI).
# Safe to re-run (idempotent). Override the data dir with MLA_TRANSCRIPTS_DIR=/path ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# The server (run from server/) defaults its data dir to <repo>/transcripts — keep the skill in lock-step.
TRANSCRIPTS_DIR="${MLA_TRANSCRIPTS_DIR:-$REPO_DIR/transcripts}"
SKILL_SRC="$REPO_DIR/skill/meet-live-assist/SKILL.md"
SKILL_DEST_DIR="$HOME/.claude/skills/meet-live-assist"

echo "→ transcripts/data dir: $TRANSCRIPTS_DIR"
mkdir -p "$TRANSCRIPTS_DIR"

# Footgun guard: on the AUTHOR's machine this repo sits beside meet-live-assist/, and the dest below IS the
# canonical source-of-truth skill. Refuse to clobber it unless explicitly forced.
if [ -e "$REPO_DIR/../meet-live-assist/meet-transcript/transcript-server.js" ] && [ "${MLA_FORCE:-}" != "1" ]; then
  echo "⚠ This looks like the author's machine (meet-live-assist/meet-transcript present next to the repo)."
  echo "  Refusing to overwrite the canonical skill at $SKILL_DEST_DIR. Set MLA_FORCE=1 to override."
  exit 1
fi

echo "→ installing skill to $SKILL_DEST_DIR"
mkdir -p "$SKILL_DEST_DIR"
[ -f "$SKILL_DEST_DIR/SKILL.md" ] && { cp "$SKILL_DEST_DIR/SKILL.md" "$SKILL_DEST_DIR/SKILL.md.bak"; echo "  (backed up existing skill → SKILL.md.bak)"; }
# Fill the per-machine paths into the skill the brain reads. Escape sed replacement metachars (& # \).
esc() { printf '%s' "$1" | sed 's/[&#\]/\\&/g'; }
sed -e "s#__MLA_TRANSCRIPTS__#$(esc "$TRANSCRIPTS_DIR")#g" \
    -e "s#__MLA_REPO__#$(esc "$REPO_DIR")#g" \
    "$SKILL_SRC" > "$SKILL_DEST_DIR/SKILL.md"

echo "→ checking dependencies"
command -v node >/dev/null 2>&1 && echo "  node: $(node --version)" || echo "  ⚠ node NOT found — the bridge server needs Node (install it first)."
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: ok (TTS into call available)" || echo "  · ffmpeg not found — optional (only for TTS routing)."
command -v whisper-cli >/dev/null 2>&1 && echo "  whisper-cli: ok (local STT available)" || echo "  · whisper-cli not found — optional (only for local STT)."

cat <<EOF

✓ Install wired. Remaining steps:

1) Start the bridge server (creates the auth token on first run):
     node "$REPO_DIR/server/transcript-server.js"
   Verify:  curl -s http://127.0.0.1:8848/health   # -> {"ok":true,...}
   (Data dir is $TRANSCRIPTS_DIR — set MLA_TRANSCRIPTS_DIR and re-run this script to change it.)

2) Load the extension (manual, Chrome UI):
     chrome://extensions → enable Developer mode → Load unpacked → pick:
       $REPO_DIR
   Pin it; click the icon to open the side panel.

3) Paste the server token into the extension Options (once):
     cat "$TRANSCRIPTS_DIR/.mla-token"
   Right-click the icon → Options → paste it.

4) Run your Claude Code session and invoke the meet-live-assist skill to act as the "brain".

Note: launchd autostart (server/com.mla.meet-transcript-server.plist) is machine-specific — edit its
absolute paths (node binary, this repo, $TRANSCRIPTS_DIR) before using it, or just run node manually.
EOF
