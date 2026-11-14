#!/bin/sh
# make vault-image: builds the Agent Vault guest into build/vault-guest/
#   Image  initrd.img  rootfs.img  guest.lock.json
# Steps: compile and ad-hoc sign vzbuild (native/vault/tools/vzbuild, dev-only, never shipped),
# then scripts/vault/build-guest.mjs downloads and sha256-checks the pinned inputs
# (native/vault/guest/build/inputs.lock), boots a throwaway NAT build VM and receives the artifacts.
#
# Apple silicon macOS only. Needs swiftc (Command Line Tools), node and network.
#   RELEASE=1          refuse to build without the real out/main/vaultd.js (default: placeholder + warning)
#   VERSION=<x.y.z-n>  image version (default 1.0.0-<yyyymmdd>)
set -eu

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "vault-image: Apple silicon macOS only" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="$ROOT/build/vault-guest/tools"
SRC="$ROOT/native/vault/tools/vzbuild/main.swift"
BIN="$TOOLS/vzbuild"
mkdir -p "$TOOLS"

if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ]; then
  cat >"$TOOLS/vz.entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.virtualization</key><true/>
</dict></plist>
EOF
  echo "vault-image: compiling vzbuild"
  swiftc -O -o "$BIN.tmp" "$SRC"
  codesign -f -s - --options runtime --entitlements "$TOOLS/vz.entitlements" "$BIN.tmp"
  mv "$BIN.tmp" "$BIN"
fi

exec node "$ROOT/scripts/vault/build-guest.mjs" "$@"
