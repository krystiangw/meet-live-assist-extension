#!/usr/bin/env bash
# Meet Live Assist - one-shot local install on a new machine.
# Wires the 3 parts together: the bundled skill (-> ~/.claude/skills), the transcripts dir the server
# writes to, and the token the extension/brain share. Load-unpacked + paste-token stay manual (Chrome UI).
# Safe to re-run (idempotent).
#
# The bundled skill is a template, not a finished skill: it addresses the user by name, answers in their
# language, and pre-briefs against their domain. Those three come from the environment, so a stranger's
# install does not end up assisting the author.
#
#   MLA_USER="Ada"                       who the assistant is helping (default: your login name)
#   MLA_LANGUAGE="Polish"                language for advice labels and framing (default: English)
#   MLA_DOMAIN="backend eng, payments"   one line naming the meetings you sit in, used for pre-briefs
#   MLA_TRANSCRIPTS_DIR=/path            where the server writes (default: <repo>/transcripts)
#   MLA_PRO=1                            keep the page-control / live-debugging sections in the skill;
#                                        default drops them, matching `build.sh --public`
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# The server (run from server/) defaults its data dir to <repo>/transcripts - keep the skill in lock-step.
TRANSCRIPTS_DIR="${MLA_TRANSCRIPTS_DIR:-$REPO_DIR/transcripts}"
SKILL_SRC="$REPO_DIR/skill/meet-live-assist/SKILL.md"
SKILL_DEST_DIR="$HOME/.claude/skills/meet-live-assist"
USER_NAME="${MLA_USER:-$(id -F 2>/dev/null || id -un)}"
LANGUAGE="${MLA_LANGUAGE:-English}"
DOMAIN="${MLA_DOMAIN:-your day-to-day work}"
PRO="${MLA_PRO:-0}"

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
echo "  user: $USER_NAME · language: $LANGUAGE · domain: $DOMAIN · pro sections: $([ "$PRO" = 1 ] && echo kept || echo dropped)"
mkdir -p "$SKILL_DEST_DIR"
[ -f "$SKILL_DEST_DIR/SKILL.md" ] && { cp "$SKILL_DEST_DIR/SKILL.md" "$SKILL_DEST_DIR/SKILL.md.bak"; echo "  (backed up existing skill → SKILL.md.bak)"; }
# Fill the per-machine values into the skill the brain reads. Escape sed replacement metachars (& # \).
esc() { printf '%s' "$1" | sed 's/[&#\]/\\&/g'; }
sed -e "s#__MLA_TRANSCRIPTS__#$(esc "$TRANSCRIPTS_DIR")#g" \
    -e "s#__MLA_REPO__#$(esc "$REPO_DIR")#g" \
    -e "s#__MLA_USER__#$(esc "$USER_NAME")#g" \
    -e "s#__MLA_LANGUAGE__#$(esc "$LANGUAGE")#g" \
    -e "s#__MLA_DOMAIN__#$(esc "$DOMAIN")#g" \
    "$SKILL_SRC" > "$SKILL_DEST_DIR/SKILL.md"

# Drop the sections describing capabilities the public extension build does not ship. A skill that offers
# a control the panel lacks sends the brain chasing a feature that will silently never respond.
if [ "$PRO" != 1 ]; then
  perl -0pi -e 's{[^\n]*mla:pro-start.*?mla:pro-end[^\n]*\n}{}gs' "$SKILL_DEST_DIR/SKILL.md"
fi

# An unfilled placeholder means a new one was added to the template and never wired here.
if grep -oE '__MLA_[A-Z_]+__' "$SKILL_DEST_DIR/SKILL.md" | sort -u | grep .; then
  echo "❌ the placeholders above were not substituted - add them to the sed above" >&2
  exit 1
fi

echo "→ checking dependencies"
command -v node >/dev/null 2>&1 && echo "  node: $(node --version)" || echo "  ⚠ node NOT found - the bridge server needs Node (install it first)."
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: ok (TTS into call available)" || echo "  · ffmpeg not found - optional (only for TTS routing)."
command -v whisper-cli >/dev/null 2>&1 && echo "  whisper-cli: ok (local STT available)" || echo "  · whisper-cli not found - optional (only for local STT)."

cat <<EOF

✓ Install wired. Remaining steps:

1) Start the bridge server (creates the auth token on first run):
     node "$REPO_DIR/server/transcript-server.js"
   Verify:  curl -s http://127.0.0.1:8848/health   # -> {"ok":true,...}
   (Data dir is $TRANSCRIPTS_DIR - set MLA_TRANSCRIPTS_DIR and re-run this script to change it.)

2) Load the extension (manual, Chrome UI):
     chrome://extensions → enable Developer mode → Load unpacked → pick:
       $REPO_DIR
   Pin it; click the icon to open the side panel.

3) Paste the server token into the extension Options (once):
     cat "$TRANSCRIPTS_DIR/.mla-token"
   Right-click the icon → Options → paste it.

4) Run your Claude Code session and invoke the meet-live-assist skill to act as the "brain".

Note: launchd autostart (server/com.mla.meet-transcript-server.plist) is machine-specific - edit its
absolute paths (node binary, this repo, $TRANSCRIPTS_DIR) before using it, or just run node manually.
EOF
