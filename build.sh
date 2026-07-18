#!/usr/bin/env bash
# Build the Chrome Web Store zip — extension files only (no server/, docs/, or dev markdown).
set -euo pipefail
cd "$(dirname "$0")"
VER=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/meet-live-assist-$VER.zip"
mkdir -p dist
rm -f "$OUT"
zip -r -q "$OUT" manifest.json src -x '*/.DS_Store' '*.map'
echo "built $OUT ($(unzip -l "$OUT" | tail -1 | awk '{print $1}') bytes across $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
