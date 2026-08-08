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
#   MLA_PROFILE=engineering              which meeting types the assistant knows about. One of the files in
#                                        skill/profiles/ - engineering (default), second-language, research,
#                                        generic. Nothing else changes: the markers and modes are the same,
#                                        because they turned out to be domain-neutral. Add your own by
#                                        dropping a file in that directory.
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
PROFILE="${MLA_PROFILE:-engineering}"
PROFILE_FILE="$REPO_DIR/skill/profiles/$PROFILE.md"
if [ ! -f "$PROFILE_FILE" ]; then
  echo "⚠ unknown MLA_PROFILE=$PROFILE. Available: $(cd "$REPO_DIR/skill/profiles" && ls *.md | sed 's/\.md$//' | tr '\n' ' ')" >&2
  exit 1
fi

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
echo "  user: $USER_NAME · language: $LANGUAGE · domain: $DOMAIN · profile: $PROFILE · pro sections: $([ "$PRO" = 1 ] && echo kept || echo dropped)"
mkdir -p "$SKILL_DEST_DIR"
[ -f "$SKILL_DEST_DIR/SKILL.md" ] && { cp "$SKILL_DEST_DIR/SKILL.md" "$SKILL_DEST_DIR/SKILL.md.bak"; echo "  (backed up existing skill → SKILL.md.bak)"; }
# Splice the profile's meeting-type block in FIRST, so its own placeholders go through the substitution
# below. A profile is a file that ships with this repo, not user input, so it uses the same placeholders as
# the skill - and getting the order wrong leaves them raw, which the guard further down catches.
awk -v f="$PROFILE_FILE" '/__MLA_MEETING_TYPES__/ { while ((getline l < f) > 0) print l; next } { print }' \
  "$SKILL_SRC" > "$SKILL_DEST_DIR/SKILL.spliced"

# Fill the per-machine values into the skill the brain reads. Escape sed replacement metachars (& # \).
esc() { printf '%s' "$1" | sed 's/[&#\]/\\&/g'; }
sed -e "s#__MLA_TRANSCRIPTS__#$(esc "$TRANSCRIPTS_DIR")#g" \
    -e "s#__MLA_REPO__#$(esc "$REPO_DIR")#g" \
    -e "s#__MLA_USER__#$(esc "$USER_NAME")#g" \
    -e "s#__MLA_LANGUAGE__#$(esc "$LANGUAGE")#g" \
    -e "s#__MLA_DOMAIN__#$(esc "$DOMAIN")#g" \
    "$SKILL_DEST_DIR/SKILL.spliced" > "$SKILL_DEST_DIR/SKILL.md"
rm -f "$SKILL_DEST_DIR/SKILL.spliced"

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

# Register the MCP adapter here rather than printing it as homework. The skill's very first step is the
# `attach` tool, so an install that stops short of this leaves an assistant with nothing to call - and the
# failure looks like the skill being broken, not like a step nobody ran.
echo "→ registering the MCP adapter with Claude Code"
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q '^meet-live-assist:'; then
    echo "  already registered - leaving it alone"
  elif claude mcp add meet-live-assist --scope user -- node "$REPO_DIR/server/mcp-server.js" >/dev/null 2>&1; then
    # User scope, not project: the brain runs from whatever directory you happen to be in when a meeting
    # starts, and a project-scoped server is invisible from everywhere else.
    echo "  registered at user scope (restart your Claude session to pick the tools up)"
  else
    echo "  ⚠ could not register automatically. Run:"
    echo "      claude mcp add meet-live-assist --scope user -- node \"$REPO_DIR/server/mcp-server.js\""
  fi
else
  echo "  · claude CLI not found - this extension is only useful with Claude Code. Once it is installed:"
  echo "      claude mcp add meet-live-assist --scope user -- node \"$REPO_DIR/server/mcp-server.js\""
fi

cat <<EOF

✓ Skill installed, MCP registered, data dir ready. Three steps left, and only the first needs a terminal:

1) Start the bridge server, with a pairing window open:
     TRANSCRIPTS_DIR="$TRANSCRIPTS_DIR" node "$REPO_DIR/server/transcript-server.js" --pair
   Leave it running. Verify in another shell:
     curl -s http://127.0.0.1:8848/health   # -> {"ok":true,...}
   (Data dir is $TRANSCRIPTS_DIR - set MLA_TRANSCRIPTS_DIR and re-run this script to change it.)

2) Load the extension in Chrome:
     chrome://extensions → enable Developer mode → Load unpacked → pick:
       $REPO_DIR
   Pin it and click the icon. The side panel collects the token from the pairing window by itself -
   nothing to copy. If the window has expired, run the command in step 1 again with --pair.

3) Open Claude Code and ask it to assist your meeting. It loads the meet-live-assist skill and attaches.

The server reads TRANSCRIPTS_DIR, this script reads MLA_TRANSCRIPTS_DIR, and they must agree - that is why
step 1 sets it explicitly. Start it without and the skill looks in one place while the server writes to
another, with nothing reporting a problem.

Autostart (optional, macOS): server/install-server.sh installs a launchd job so step 1 stops being a
step. Pair a new extension against a server that is already running with:
     TRANSCRIPTS_DIR="$TRANSCRIPTS_DIR" node "$REPO_DIR/server/transcript-server.js" --pair
EOF
