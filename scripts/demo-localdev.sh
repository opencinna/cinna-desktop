#!/bin/sh
# Drive the one-click onboarding flow by hand, in a throwaway profile.
#
# For looking at the UI — the E2E suite proves the flow works, but it tears the
# window down in seconds, and the local-dev progress is several minutes of
# screen nobody can review that way.
#
# Everything lives under a sandbox directory: a fresh HOME, so the agents home
# and the account workspace land there and never in ~/Documents, and a fresh
# userData, so the toolchain downloads from scratch and the per-component
# progress bars have something to show. `make demo-clean` deletes the sandbox
# for a cold run again; keep it to land straight in the ready state.
#
#   make demo-localdev SERVER=http://localhost:8000
#
# SERVER must be the origin serving /.well-known/cinna-desktop — the backend,
# not the SPA dev server. The app opens on the connect-confirm step via the same
# argv funnel the OS uses for `cinna://`, so the flow is the real one from there
# on, including the browser authorization.
set -e

SERVER="${SERVER:-http://localhost:8000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${SANDBOX:-${TMPDIR:-/tmp}cinna-demo-profile}"

if [ ! -d "$REPO/out/main" ]; then
  echo "out/ is missing — run 'make build' first." >&2
  exit 2
fi

mkdir -p "$SANDBOX/home" "$SANDBOX/userData"
# The app asks the login shell for its PATH; a home with no rc files yields the
# bare launchd one, in which uv and git do not exist. Same workaround the E2E
# fixture uses, for the same reason.
for rc in .zprofile .zshrc .bash_profile .profile; do
  printf 'export PATH=%s\n' "\"$PATH\"" > "$SANDBOX/home/$rc"
done

echo "sandbox:  $SANDBOX"
echo "server:   $SERVER"
echo "(delete the sandbox for a cold toolchain download)"

# Reuse the real uv cache so `uv tool install` does not re-provision a CPython.
# The two stages with real byte progress download into userData and are
# unaffected, so this only shortens the least informative part of the wait.
REAL_HOME="$HOME"
export HOME="$SANDBOX/home"
export CINNA_USER_DATA="$SANDBOX/userData"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$REAL_HOME/.cache/uv}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$REAL_HOME/.cache}"

# `--use-mock-keychain`: with HOME pointed at a sandbox, macOS resolves the
# login keychain under it and safeStorage cannot open one.
exec npx electron "$REPO" --use-mock-keychain \
  "--cinna-connect-intent=cinna://connect?server=$SERVER"
