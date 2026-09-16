# Live-backend helpers: drive a built Cinna Desktop (through ctl.mjs) against a
# running cinna-core checkout, and read both databases, from one shell.
#
#   source scripts/live-backend/live.sh      # zsh or bash
#   live_help
#
# Settings come from the environment, else from .env (same keys):
#   CINNA_CORE_PATH        cinna-core checkout with its docker compose stack   (default: ../workflow-runner-core)
#   CINNA_LIVE_AGENT_ID    uuid of the remote agent under test (synced into the app)
#   CINNA_LIVE_AGENT_NAME  its name as the Agents list shows it
#   CINNA_LIVE_PROXY_URL   the URL the app reaches agents through               (default: http://localhost)
#   CINNA_LIVE_PORT        ctl.mjs port                                          (default: 47111)
#   CINNA_LIVE_RUN_DIR     where app.log, shots/ and results.md go               (default: drafts/live_runs/<yyyymmdd>)
#   CINNA_LIVE_USER_DATA   run on this profile instead of the real one
#   CINNA_CORE_DB_SERVICE / CINNA_CORE_DB_USER / CINNA_CORE_DB_NAME   (default: db / postgres / app)
#
# Docs: docs/development/live_backend/live_backend.md

LIVE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/../.." && pwd)"

_live_env() {
  # $1 = key; prints the environment value, else the .env value.
  local v
  eval "v=\${$1:-}"
  if [ -z "$v" ] && [ -f "$LIVE_REPO/.env" ]; then
    v="$(grep -E "^$1=" "$LIVE_REPO/.env" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  printf '%s' "$v"
}

CINNA_CORE_PATH="$(_live_env CINNA_CORE_PATH)"; CINNA_CORE_PATH="${CINNA_CORE_PATH:-$LIVE_REPO/../workflow-runner-core}"
CINNA_LIVE_AGENT_ID="$(_live_env CINNA_LIVE_AGENT_ID)"
CINNA_LIVE_AGENT_NAME="$(_live_env CINNA_LIVE_AGENT_NAME)"
CINNA_LIVE_PROXY_URL="$(_live_env CINNA_LIVE_PROXY_URL)"; CINNA_LIVE_PROXY_URL="${CINNA_LIVE_PROXY_URL:-http://localhost}"
CINNA_LIVE_PORT="$(_live_env CINNA_LIVE_PORT)"; CINNA_LIVE_PORT="${CINNA_LIVE_PORT:-47111}"
CINNA_LIVE_RUN_DIR="$(_live_env CINNA_LIVE_RUN_DIR)"; CINNA_LIVE_RUN_DIR="${CINNA_LIVE_RUN_DIR:-$LIVE_REPO/drafts/live_runs/$(date +%Y%m%d)}"
CINNA_LIVE_USER_DATA="$(_live_env CINNA_LIVE_USER_DATA)"
CINNA_CORE_DB_SERVICE="$(_live_env CINNA_CORE_DB_SERVICE)"; CINNA_CORE_DB_SERVICE="${CINNA_CORE_DB_SERVICE:-db}"
CINNA_CORE_DB_USER="$(_live_env CINNA_CORE_DB_USER)"; CINNA_CORE_DB_USER="${CINNA_CORE_DB_USER:-postgres}"
CINNA_CORE_DB_NAME="$(_live_env CINNA_CORE_DB_NAME)"; CINNA_CORE_DB_NAME="${CINNA_CORE_DB_NAME:-app}"
export CINNA_CORE_PATH CINNA_LIVE_PORT CINNA_LIVE_RUN_DIR CINNA_LIVE_USER_DATA

PROFILE="${CINNA_LIVE_USER_DATA:-$HOME/Library/Application Support/cinna-desktop}"
AGENT="remote:agent:$CINNA_LIVE_AGENT_ID"
RUN="$CINNA_LIVE_RUN_DIR"
mkdir -p "$RUN/shots"

# A tool call long enough to kill the app, the proxy or the backend under it.
# Agents refuse now and then; `starttool` retries in a fresh chat.
PTOOL='Use your bash tool to run `sleep 90; echo finished-$(date +%s)` (timeout 200000 ms) and then tell me exactly what it printed.'
PQUESTION='Use your structured question tool (ask the user a question) to ask me which colour I prefer, with options red, green and blue, and wait for my answer before doing anything else.'

_json() { node -e 'console.log(JSON.stringify(process.argv[1]))' "$1"; }

# ---- the app (through ctl.mjs) --------------------------------------------
ctl() { curl -s -X POST "http://127.0.0.1:$CINNA_LIVE_PORT/$1" --data-binary "${2:-}"; }
pw() { ctl run "$1"; }                                   # pw '<async JS using page / app>'
shot() { pw "await page.screenshot({ path: dir + '/shots/$1.png' }); return dir + '/shots/$1.png'"; }
body() { pw "return (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(-${1:-1500})"; }
aria() { pw "return (await page.locator('body').ariaSnapshot()).split('\n').slice(${1:-0}, ${2:-60}).join('\n')"; }
ui() {
  pw "const n = (r, o) => page.getByRole(r, o).count(); return { stop: await n('button', { name: 'Stop', exact: true }), idle: await n('combobox', { name: 'Type a message...', exact: true }), running: await n('combobox', { name: /^Send a follow-up/ }), stillRunning: await page.getByText(/Still running on the agent/).count(), inbox: await page.getByRole('button', { name: /^Inbox/ }).first().getAttribute('aria-label').catch(() => null) }" | tr -d '\n '
  echo
}
sidebar() { pw "return (await page.locator('body').ariaSnapshot()).split('\n').filter(l => /^- text: /.test(l)).slice(1, ${1:-5}).map(l => l.slice(8, 40)).join(' | ')"; }
newchat() {
  local n; n=$(_json "Start a new chat with ${1:-$CINNA_LIVE_AGENT_NAME}")
  pw "await page.getByRole('button', { name: 'Agents', exact: true }).click(); await page.getByRole('button', { name: $n, exact: true }).click(); await page.waitForTimeout(800); await page.getByRole('button', { name: 'Chats', exact: true }).click(); return 'ok'"
}
send() {
  local t; t=$(_json "$1")
  pw "const c = page.getByRole('combobox', { name: /^(Type a message|Send a follow-up)/ }).first(); await c.fill($t); await c.press('Enter'); return new Date().toISOString()"
}
stop() { pw "await page.getByRole('button', { name: 'Stop', exact: true }).click(); return new Date().toISOString()"; }
# openchat <chat id>: sidebar titles are truncated, so the title is read from the DB.
openchat() {
  local t; t=$(_json "$(sqlite3 "$(snap)" "select title from chats where id='$1'")")
  pw "await page.getByRole('button', { name: 'Chats', exact: true }).click(); await page.getByText($t, { exact: true }).first().click(); await page.waitForTimeout(500); return 'ok'"
}
waitidle() {  # waitidle [tries=60] — polls every 5 s until Stop is gone
  local i
  for i in $(seq 1 "${1:-60}"); do
    [ "$(pw "return await page.getByRole('button', { name: 'Stop', exact: true }).count()")" = "0" ] && { echo "idle after ~$((i * 5))s"; return 0; }
    sleep 5
  done
  echo "still running after $((i * 5))s"; return 1
}
# starttool [fresh=1]: send $PTOOL and make sure the agent is inside the tool; prints the chat id.
starttool() {
  local k c
  for k in 1 2 3 4; do
    if [ "${1:-1}" = 1 ] || [ "$k" -gt 1 ]; then newchat >/dev/null; fi
    send "$PTOOL" >/dev/null
    sleep 12
    c=$(lastchat)
    if [ "$(pw "return await page.getByRole('button', { name: 'Stop', exact: true }).count()")" = 1 ] &&
      sqlite3 "$(snap)" "select parts from messages where chat_id='$c' and role='assistant' order by sort_order desc limit 1" | grep -q '"kind":"tool"'; then
      echo "$c"; return 0
    fi
    echo "agent refused or finished in $c, retrying" >&2
    waitidle 10 >/dev/null
  done
  return 1
}

# ---- the app's database (always read from a copy) --------------------------
snap() { local s; s=$(mktemp -d); cp "$PROFILE"/cinna.db* "$s"/ 2>/dev/null; echo "$s/cinna.db"; }
q() { sqlite3 -header -column "$(snap)" "$1"; }
lastchat() { sqlite3 "$(snap)" "select chat_id from messages where addressed_agent_id='$AGENT' order by created_at desc limit 1;"; }
lastchatany() { sqlite3 "$(snap)" "select chat_id from messages order by created_at desc limit 1;"; }
state() {
  local c d; c=${1:-$(lastchat)}; d=$(snap); echo "chat $c"
  sqlite3 -header -column "$d" "select sort_order so, role, substr(replace(content,char(10),' '),1,70) content, json_array_length(parts) parts, id from messages where chat_id='$c' order by sort_order;"
  sqlite3 -header -column "$d" "select id, driver, user_message_id, draft_message_id, datetime(started_at/1000,'unixepoch') started from inflight_turns where chat_id='$c';"
  sqlite3 -header -column "$d" "select context_id, task_id, task_state from a2a_sessions where chat_id='$c';"
  sqlite3 -header -column "$d" "select status, unread from chat_run_results where chat_id='$c';"
}
session_of() { sqlite3 "$(snap)" "select context_id from a2a_sessions where chat_id='$1'"; }
# Only with the app closed: back up, and restore, the profile database.
live_backup() {
  local b; b="$HOME/cinna-profile-backup-$(date +%Y%m%d-%H%M)"; mkdir -p "$b"
  cp "$PROFILE"/cinna.db* "$b"/ && echo "$b"
}
live_restore() {
  [ -d "$1" ] || { echo "usage: live_restore <backup dir>"; return 2; }
  [ "$(ctl status | grep -c '"running": true')" = 0 ] || { echo "quit the app first"; return 1; }
  rm -f "$PROFILE"/cinna.db-wal "$PROFILE"/cinna.db-shm; cp "$1"/cinna.db* "$PROFILE"/ && echo restored
}

# ---- cinna-core ------------------------------------------------------------
dc() { (cd "$CINNA_CORE_PATH" && docker compose "$@"); }
psqlb() { dc exec -T "$CINNA_CORE_DB_SERVICE" psql -U "$CINNA_CORE_DB_USER" -d "$CINNA_CORE_DB_NAME" -c "$1"; }
bsessions() { psqlb "select id, status, interaction_status, session_metadata->>'stream_heartbeat_at' hb, updated_at from session where agent_id='$CINNA_LIVE_AGENT_ID' order by updated_at desc limit ${1:-3};"; }
bmsgs() { psqlb "select role, status, left(replace(content,E'\n',' '),60) content, message_metadata->>'client_message_id' client_id, message_metadata->>'streaming_in_progress' streaming, timestamp from message where session_id='$1' order by sequence_number;"; }
card_code() { curl -s -o /dev/null -w '%{http_code}' "$CINNA_LIVE_PROXY_URL/api/v1/external/a2a/agent/$CINNA_LIVE_AGENT_ID/"; }
# wait_core [tries=40]: until the agent card answers 401 (up, not signed in) — 3 s steps.
wait_core() {
  local i c
  for i in $(seq 1 "${1:-40}"); do c=$(card_code); [ "$c" = 401 ] || [ "$c" = 200 ] && { echo "core up ($c) after ~$((i * 3))s"; return 0; }; sleep 3; done
  echo "core not answering ($c)"; return 1
}
# core_switch <commit>: run an older backend (tree must be clean); core_back returns to the branch.
core_switch() {
  (cd "$CINNA_CORE_PATH" && [ -z "$(git status --porcelain)" ] || { echo "cinna-core tree is dirty"; exit 1; }) || return 1
  (cd "$CINNA_CORE_PATH" && git switch --detach "$1") && dc restart backend && wait_core
}
core_back() { (cd "$CINNA_CORE_PATH" && git switch "${1:-main}") && dc restart backend && wait_core; }

# ---- logs and notes --------------------------------------------------------
# applog [pattern] [lines]: log lines since the last launch.
applog() {
  awk '/^===== LAUNCH /{buf=""} {buf = buf $0 "\n"} END {printf "%s", buf}' "$RUN/app.log" |
    grep -E "${1:-\[(turn-recovery|managed-recovery|boot)\]}" | tail -"${2:-30}"
}
note() { printf '%s\n' "$*" >> "$RUN/results.md"; }

live_preflight() {
  echo "cinna-core:  $CINNA_CORE_PATH @ $(cd "$CINNA_CORE_PATH" && git log --oneline -1)"
  (cd "$CINNA_CORE_PATH" && git status --porcelain | head -3)
  dc ps
  echo "agent card:  $(card_code)  ($CINNA_LIVE_PROXY_URL, agent ${CINNA_LIVE_AGENT_ID:-<unset CINNA_LIVE_AGENT_ID>})"
  echo "profile:     $PROFILE"
  echo "run dir:     $RUN"
  local st; st="$(curl -sf -X POST "http://127.0.0.1:$CINNA_LIVE_PORT/status" | tr -d '\n')"
  echo "ctl:         ${st:-not running (make live-ctl)}"
  [ -n "$CINNA_LIVE_AGENT_ID" ] && [ -n "$CINNA_LIVE_AGENT_NAME" ] && echo "app agent:   $(sqlite3 "$(snap)" "select name from agents where id='$AGENT'")"
}

live_help() {
  cat <<'EOF'
app:      ctl launch | ctl kill | ctl quit | ctl front | ctl status
          pw '<js>'  shot <name>  body [chars]  aria [from to]  ui  sidebar
          newchat [agent name]  send <text>  stop  openchat <chat id>  waitidle [tries]  starttool
app db:   snap  q <sql>  state [chat id]  lastchat  session_of <chat id>  live_backup  live_restore <dir>
core:     dc <compose args>  psqlb <sql>  bsessions [n]  bmsgs <session id>  card_code  wait_core
          core_switch <commit>  core_back [branch]
levers:   dc stop|start frontend   (unreachable)     dc pause|unpause frontend (hangs)
          dc stop backend          (proxy 502)       dc kill backend; dc start backend (crash)
notes:    applog [pattern] [lines]  note <text>  live_preflight
EOF
}
