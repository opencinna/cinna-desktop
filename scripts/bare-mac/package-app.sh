#!/bin/bash
# Package the working tree as the arm64 .app the bare-mac suite installs, and
# print the path of the zip.
#
# Unsigned (no Developer ID, no notarization — minutes and an Apple round trip
# a test does not need), then ad-hoc signed, because Apple silicon will not run
# unsigned code at all. The zip carries no quarantine flag, so Gatekeeper never
# sees it: to test what a user downloads, pass the release DMG instead
# (make bare-mac APP=dist/cinna-desktop-<v>-arm64.dmg).
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT="$ROOT/dist/bare-mac"
cd "$ROOT"

rm -rf "$OUT"
npx electron-vite build >&2
npx electron-builder --mac dir --arm64 \
  -c.mac.identity=null -c.mac.notarize=false -c.directories.output="$OUT" >&2

APP=$(ls -d "$OUT"/mac-arm64/*.app)
codesign --force --deep -s - "$APP" >&2
(cd "$(dirname "$APP")" && ditto -c -k --keepParent "$(basename "$APP")" "$OUT/cinna-bare.zip")
echo "$OUT/cinna-bare.zip"
