#!/bin/sh
# Builds resources/speech/cinna-speech, the macOS speech recognition helper
# (native/speech/cinna-speech.swift), as a universal arm64 + x86_64 binary with
# native/speech/Info.plist embedded in its __TEXT,__info_plist section. The
# Speech framework aborts a process whose main bundle has no
# NSSpeechRecognitionUsageDescription, and a bare binary's "main bundle" is
# that embedded plist.
#
# macOS only; elsewhere it does nothing, and the app reports voice input as
# unsupported. The output is gitignored and shipped through extraResources.
#
# The macOS 26 engine (SpeechAnalyzer) needs the macOS 26 SDK, which only
# Xcode 26 ships; the Command Line Tools SDKs stop at 15.x. With an older SDK
# the helper still builds, on SFSpeechRecognizer alone, and this script warns.
# The deployment target stays macOS 12 either way.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-speech-helper: not macOS, skipping"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/speech"
OUT_DIR="$ROOT/resources/speech"
OUT="$OUT_DIR/cinna-speech"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
case "$SDK_VERSION" in
  1[0-9].*|2[0-5].*)
    echo "build-speech-helper: WARNING macOS SDK $SDK_VERSION has no SpeechAnalyzer; the helper will use SFSpeechRecognizer only. Install Xcode 26 and select it with xcode-select for release builds." >&2
    ;;
esac

mkdir -p "$OUT_DIR"
for arch in arm64 x86_64; do
  xcrun --sdk macosx swiftc -O -swift-version 5 \
    -target "$arch-apple-macos12" \
    -framework Speech \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC/Info.plist" \
    -o "$WORK/cinna-speech-$arch" \
    "$SRC/cinna-speech.swift"
done
lipo -create -output "$OUT" "$WORK/cinna-speech-arm64" "$WORK/cinna-speech-x86_64"
# Ad-hoc signature with a stable identifier for local runs; electron-builder
# re-signs it with the app's identity when packaging.
codesign --force --sign - --identifier io.opencinna.desktop.speech "$OUT"
echo "build-speech-helper: wrote $OUT (macOS SDK $SDK_VERSION)"
