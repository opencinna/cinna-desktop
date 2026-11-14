#!/bin/sh
# `make vault-dev`: run `electron-vite dev` under a copy of Electron.app signed
# as Cinna, so a dev-flavor VaultHelper accepts it as its parent.
#
# The dev helper trusts only a parent with identifier io.opencinna.desktop,
# signed by team G5E484HA2U, with the hardened runtime (ParentCheck.swift). The
# stock node_modules/electron binary is ad-hoc signed as "Electron", so with it
# the Security tab reports the vault as unavailable (helper-untrusted). This
# copies Electron.app to build/vault-dev-electron/, signs the nested code with
# the team's Apple Development identity and the app with Cinna's identifier,
# then points electron-vite at it through ELECTRON_EXEC_PATH.
#
# The copy is re-made when node_modules/electron changes. Keychain items the
# stock Electron created (safeStorage) may ask once for the re-signed binary.
set -eu

ROOT=$(git rev-parse --show-toplevel)
SRC="$ROOT/node_modules/electron/dist/Electron.app"
DEST_DIR="$ROOT/build/vault-dev-electron"
APP="$DEST_DIR/Electron.app"
BASE_ENTS="$ROOT/build/entitlements.mac.plist"
STAMP="$DEST_DIR/.source-version"

[ -d "$SRC" ] || { echo "no $SRC; run npm install" >&2; exit 1; }

# The stamp covers Electron's version, this script and the base entitlements,
# so a change to any of them re-signs the copy.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$SRC/Contents/Info.plist") $(cat "$0" "$BASE_ENTS" | shasum -a 256 | cut -c1-12)"
if [ ! -d "$APP" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$VERSION" ]; then
  # Apple Development first, as helper-smoke.mjs does; the dev helper takes any team certificate.
  IDS=$(security find-identity -v -p codesigning)
  IDENTITY=$(printf '%s\n' "$IDS" | grep -m1 'Apple Development' | sed -E 's/^ *[0-9]+\) ([0-9A-F]+) .*/\1/' || true)
  [ -n "$IDENTITY" ] || IDENTITY=$(printf '%s\n' "$IDS" | grep -m1 'Developer ID Application: .*(G5E484HA2U)' | sed -E 's/^ *[0-9]+\) ([0-9A-F]+) .*/\1/' || true)
  [ -n "$IDENTITY" ] || { echo "no Apple Development identity to sign the dev Electron with" >&2; exit 1; }

  echo "vault-dev: signing a copy of Electron $VERSION as io.opencinna.desktop ($IDENTITY)"
  rm -rf "$DEST_DIR"
  mkdir -p "$DEST_DIR"
  ditto "$SRC" "$APP"

  # The app's own entitlements plus disable-library-validation: in dev the
  # native modules (better-sqlite3 and the rest) load straight from
  # node_modules with their own or ad-hoc signatures, which the hardened
  # runtime refuses in a team-signed process ("different Team IDs"). A
  # packaged build signs them with the team instead. Dev copy only.
  ENTS="$DEST_DIR/entitlements.dev.plist"
  cp "$BASE_ENTS" "$ENTS"
  /usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$ENTS"

  sign() { codesign -f -s "$IDENTITY" -o runtime --timestamp=none --entitlements "$ENTS" "$@"; }
  # Inside out: dylibs, frameworks and helper apps first, the app last.
  find "$APP/Contents/Frameworks" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 | xargs -0 -n1 -I{} codesign -f -s "$IDENTITY" -o runtime --timestamp=none {}
  for fw in "$APP"/Contents/Frameworks/*.framework; do codesign -f -s "$IDENTITY" -o runtime --timestamp=none "$fw"; done
  for helper in "$APP"/Contents/Frameworks/*.app; do sign "$helper"; done
  sign --identifier io.opencinna.desktop "$APP"
  codesign --verify --strict "$APP"
  echo "$VERSION" > "$STAMP"
fi

codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|TeamIdentifier)='
export ELECTRON_EXEC_PATH="$APP/Contents/MacOS/Electron"
cd "$ROOT"
[ "${1:-}" = "--sign-only" ] && exit 0
exec npx electron-vite dev "$@"
