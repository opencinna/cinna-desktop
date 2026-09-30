#!/bin/bash
# Build the bare-Mac base VM image the bare-mac suite clones for every test.
#
#   scripts/bare-mac/build-image.sh [--force]
#
# Starts from Cirrus Labs' "vanilla" macOS image and makes it what a user's new
# Mac actually is. "Vanilla" is not bare: it ships the full Command Line Tools
# (a real /usr/bin/git) and has Gatekeeper switched off — exactly the two things
# that hide first-run problems. So this removes the tools (Apple's documented
# uninstall), turns Gatekeeper back on, checks both, and shuts the VM down.
#
# Env: CINNA_BARE_SOURCE (default the Sequoia vanilla image), CINNA_BARE_IMAGE
# (default cinna-bare-sequoia). Needs Tart on PATH and ~55 GB of disk.
set -euo pipefail

SOURCE=${CINNA_BARE_SOURCE:-ghcr.io/cirruslabs/macos-sequoia-vanilla:latest}
IMAGE=${CINNA_BARE_IMAGE:-cinna-bare-sequoia}
HERE=$(cd "$(dirname "$0")" && pwd)

command -v tart >/dev/null || {
  echo "tart not found — install it from https://github.com/cirruslabs/tart/releases (docs/development/bare_mac/bare_mac.md)"
  exit 1
}

if tart get "$IMAGE" >/dev/null 2>&1 && [ "${1:-}" != "--force" ]; then
  echo "$IMAGE already exists; pass --force (make bare-mac-image FORCE=1) to rebuild it"
  exit 0
fi

# Built under a temporary name and renamed only once verified: a half-built
# image under the real name — tools still installed, Gatekeeper still off —
# would be kept by the next run and make every spec pass for nothing. With
# --force the old image stays until the new one has passed.
BUILD="$IMAGE-building"
tart delete "$BUILD" >/dev/null 2>&1 || true

echo "==> pulling $SOURCE (about 25 GB the first time)"
tart pull "$SOURCE"
tart clone "$SOURCE" "$BUILD"

echo "==> booting $BUILD"
tart run "$BUILD" --no-graphics >/dev/null 2>&1 &
RUN_PID=$!
cleanup() {
  tart stop "$BUILD" --timeout 30 >/dev/null 2>&1 || true
  wait "$RUN_PID" 2>/dev/null || true
  tart delete "$BUILD" >/dev/null 2>&1 || true
}
trap cleanup EXIT

IP=$(tart ip "$BUILD" --wait 180)
export SSH_ASKPASS="$HERE/askpass.sh" SSH_ASKPASS_REQUIRE=force DISPLAY=:0
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
  -o PubkeyAuthentication=no -o ConnectTimeout=5)
for _ in $(seq 1 36); do ssh "${SSH_OPTS[@]}" "admin@$IP" true 2>/dev/null && break; sleep 5; done
ssh "${SSH_OPTS[@]}" "admin@$IP" true

echo "==> removing the Command Line Tools, enabling Gatekeeper"
ssh "${SSH_OPTS[@]}" "admin@$IP" 'echo admin | sudo -S -p "" sh -c "
  rm -rf /Library/Developer/CommandLineTools
  for p in \$(pkgutil --pkgs | grep CLTools); do pkgutil --forget \$p >/dev/null 2>&1; done
  xcode-select --reset
  spctl --master-enable
"'

echo "==> verifying"
ssh "${SSH_OPTS[@]}" "admin@$IP" '
  fail=0
  if xcode-select -p >/dev/null 2>&1; then echo "FAIL: developer tools still selected"; fail=1; fi
  if [ -e /Library/Developer/CommandLineTools ]; then echo "FAIL: CommandLineTools still on disk"; fail=1; fi
  spctl --status | grep -q "assessments enabled" || { echo "FAIL: Gatekeeper off"; fail=1; }
  for t in brew uv node; do command -v $t >/dev/null && { echo "FAIL: $t present"; fail=1; }; done
  sw_vers -productVersion
  exit $fail
'

echo "==> shutting down"
ssh "${SSH_OPTS[@]}" "admin@$IP" 'echo admin | sudo -S -p "" shutdown -h now' >/dev/null 2>&1 || true
wait "$RUN_PID" 2>/dev/null || true
trap - EXIT
tart delete "$IMAGE" >/dev/null 2>&1 || true
tart rename "$BUILD" "$IMAGE"
echo "==> $IMAGE ready"
