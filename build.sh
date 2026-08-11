#!/usr/bin/env bash
# Build a Chrome Web Store zip: extension files only (no server/, docs/, or dev markdown).
#
#   ./build.sh              full build, everything this repo can do (load-unpacked / own use)
#   ./build.sh --public     store build: strips the page-control + live-debugging surface
#
# Why two builds: the full extension both observes a meeting AND acts on arbitrary pages (DOM edits,
# agent-driven clicks, chrome.debugger). That reads as a remote-control tool, which collides with the
# store's single-purpose policy and drags `debugger` through a heavier review. The public build keeps
# the assistant that sees and hears, and drops the half that clicks.
#
# The cut is driven by `mla:pro-start` / `mla:pro-end` markers in src/. Regions are whole statements,
# so removing them leaves valid syntax, enforced below by `node --check` on every stripped .js.
set -euo pipefail
cd "$(dirname "$0")"

PUBLIC=0
[ "${1:-}" = "--public" ] && PUBLIC=1

VER=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")

# The store rejects the upload itself over this, after the zip is built and mailed to someone. Cheaper to
# fail here. The limit is the store's, not the manifest format's, so nothing local ever complains.
python3 - <<'PY'
import json, sys
d = json.load(open('manifest.json')).get('description', '')
if len(d) > 132:
    sys.exit(f"❌ manifest description is {len(d)} characters; the Chrome Web Store limit is 132")
PY

mkdir -p dist

if [ "$PUBLIC" = 0 ]; then
  OUT="dist/meet-live-assist-$VER.zip"
  rm -f "$OUT"
  zip -r -q "$OUT" manifest.json src -x '*/.DS_Store' '*.map'
else
  OUT="dist/meet-live-assist-$VER-public.zip"
  rm -f "$OUT"
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' EXIT

  cp -R src "$STAGE/src"
  rm -f "$STAGE/src/.DS_Store" "$STAGE"/src/*.map

  STRIPPED=0
  while IFS= read -r f; do
    grep -q 'mla:pro-start' "$f" || continue
    perl -0pi -e 's{[^\n]*mla:pro-start.*?mla:pro-end[^\n]*\n}{}gs' "$f"
    case "$f" in *.js) node --check "$f" || { echo "❌ $f is not valid JS after stripping" >&2; exit 1; };; esac
    STRIPPED=$((STRIPPED + 1))
  done < <(find "$STAGE/src" -type f \( -name '*.js' -o -name '*.html' \))
  [ "$STRIPPED" -gt 0 ] || { echo "❌ no mla:pro markers found - the strip would be a no-op" >&2; exit 1; }

  # A leftover reference to a stripped function is a runtime crash that a store review would never catch.
  for sym in handleAct applyEdit captureDom attachDebugger detachDebugger handleDebugDo \
             pollActs pollEdits pollDomRequest pollDebugRequest setDrive loadDrive; do
    if grep -rq "$sym" "$STAGE/src"; then
      echo "❌ '$sym' still referenced after stripping - widen the mla:pro markers" >&2; exit 1
    fi
  done

  # `debugger` is the permission the store reviews hardest, and nothing left in the build can use it.
  python3 - "$STAGE/manifest.json" <<'PY'
import json, sys
m = json.load(open('manifest.json'))
m['permissions'] = [p for p in m['permissions'] if p != 'debugger']
json.dump(m, open(sys.argv[1], 'w'), indent=2, ensure_ascii=False)
PY
  ! grep -q '"debugger"' "$STAGE/manifest.json" || { echo "❌ debugger survived in the manifest" >&2; exit 1; }

  (cd "$STAGE" && zip -r -q "$OLDPWD/$OUT" manifest.json src)
  echo "stripped $STRIPPED file(s); dropped the debugger permission"
fi

echo "built $OUT ($(unzip -l "$OUT" | tail -1 | awk '{print $1}') bytes across $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
