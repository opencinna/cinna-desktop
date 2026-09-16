# Running a Live-Backend Session (LLM reference)

This is how an agent runs an interactive end-to-end session against a real cinna-core with `scripts/live-backend/`. Read [Live-Backend Testing](live_backend.md) first. This page covers the loop, the timings, and the traps that cost time in the crash-recovery run.

## Before anything

- **Ask before starting.** The session uses the user's real profile and restarts their local backend.
- **Confirm three facts with the user:**
  - no other Cinna Desktop is running;
  - nothing else is using the local cinna-core;
  - which remote agent to use. Set `CINNA_LIVE_AGENT_ID` and `CINNA_LIVE_AGENT_NAME`, and `CINNA_CORE_PATH` if the checkout isn't the sibling `workflow-runner-core`.
- **Back up first.** `live_backup` runs with the app closed. Put the backup path in your notes and in your final report.
- **Start the control server in the background.** Run `make live-ctl` as a background command, then `source scripts/live-backend/live.sh` in each foreground command. Shell state does not persist between tool calls, so every command sources the helpers again.
- **Build before you launch.** `make live-ctl` builds. After changing code, run `npx electron-vite build`, then `ctl quit` and `ctl launch`; the control server keeps running.

## The loop, per scenario

1. **Arrange.** Use `newchat`, then `starttool` (it prints the chat id; keep it). For a question, `send "$PQUESTION"`. For a later turn, `openchat <id>` and `send`.
2. **Break.** Pull one lever and note the UTC time (`date -u +%T`):
   - `ctl kill` (crash) or `ctl quit` (normal quit);
   - `dc stop frontend`, `dc kill backend`, `dc pause frontend`;
   - `core_switch <sha>`.
3. **Read at once:**
   - `state <id>`: rows, marker, `a2a_sessions`, run result;
   - `bmsgs "$(session_of <id>)"` and `bsessions`.
4. **Restore or relaunch.** Use `ctl launch`, then `openchat <id>`, then `ui`.
5. **Wait on a condition, not a guess:**
   - `waitidle N` for Stop to go;
   - a loop on `sqlite3 "$(snap)" "select count(*) from inflight_turns where chat_id='<id>'"` for a marker to clear;
   - `wait_core` for the backend to answer again.
6. **Judge on four sources.** Check `ui`, `body`, `state`, `bmsgs` and `applog 'turn-recovery|A2A'`, and take a `shot` when layout matters (Read the PNG).
7. **Record.** `note "- A7 PASS …"`, with timestamps, the log line, and anything odd, even if it's out of scope.

Batch a whole scenario into one foreground command with a generous tool timeout (up to 10 min). A foreground `sleep` is fine inside a command. Do not wrap commands in `timeout`: the binary does not exist here.

## Timings to plan around

- **Waking the agent environment:** up to 2 minutes for the first message after a suspend.
- **Relaunch recovery retry timer:** 2 minutes after a `network` defer. There is no timer for an `auth` defer; signing in again triggers it.
- **Orphan repair after a backend kill:** about 3 minutes.
- **Live ride-out and recovery polling:** up to 10 minutes.
- **Relaunch with the backend down or restarting:** the window can take about 40 seconds to appear.
- **Proxy read timeout (nginx):** 60 seconds. An SSE stream with no events for 60 seconds is closed. A backend that sends no keep-alives looks like a drop.

## Traps

- **Agents are nondeterministic.** A joke agent refused the tool about one time in three, and answered in German at times. `starttool` retries. Check that the chat really ran the tool (the assistant row has a `"kind":"tool"` part) before killing anything, or the kill tests nothing.
- **Use chat ids, not titles.** Sidebar titles are truncated with `…`; `openchat` looks the title up by id.
- **Watch the harness itself:**
  - The guest profile's display name is random on every render; match it by pattern (`/Guest$/`), not by text.
  - The window is hidden; run `ctl front` before asking the user to click anything.
  - A sign-in redirect can open the installed app instead. If `ctl launch` suddenly fails with "another Cinna Desktop is running", ask the user to quit it; never kill their app.
- **Every shell command stands alone:**
  - In zsh, an unquoted `$var` is one word: `for s in $list` does not split.
  - A bare `=====` in zsh is a command lookup; quote it.
- **Reading the app log:**
  - `applog` shows only lines since the last launch; grep `$RUN/app.log` directly for older ones.
  - Nested objects in the log print as `[Object]`. When you need a response body, read the raw `SSE chunk` lines, or ask the backend.
- **Don't trust an empty grep.** The shell's `grep` is a wrapper that can miss matches. Widen the pattern, or read the lines around a known timestamp.
- **Staging a scenario in the DB:** only with the app closed, and write down the original values first (`sqlite3 … > $RUN/<name>_backup.txt`) so you can restore them.
- **Handing over to the user:**
  - Say exactly what they must do and what they must not (for example, "revoke the session; don't open any Cinna app").
  - Wait for their reply, then continue from the state you left.

## Finding a bug

- **Desktop:**
  - Record it with the evidence (log lines, rows, sessions) and read the code before calling it.
  - Fixes follow the project loop: design here, hand the implementation to `cinna-desktop-developer`, review with `cinna-desktop-code-reviewer`, re-run the failing scenario on a rebuilt `out/`, and update docs through `cinna-desktop-feature-documenter`.
- **Backend:**
  - Write `drafts/<topic>/cinna_core_handover_<n>.md` for a cinna-core session: context and commit, what was seen (session ids, timestamps, raw answers), why it matters to the desktop, what is wanted, how to reproduce, and what to send back.
  - The user relays it. Their reply comes back as `cinna_core_reply_<n>.md`.
  - Restart the backend on the new commit (`dc restart backend`, then `wait_core`) and re-run every scenario the fix touches, plus a regression pair: a normal turn and a kill with recovery.
- **Expectation wrong:** if the plan's expectation contradicts a documented design, say so. Don't bend the result.

## Reporting

- Give a results table: scenario, pass/fail, one line of why.
- List the bugs to fix, split by side.
- List the observations.
- Say what was not run, and why.
- Give the cleanup state:
  - which commit the backend is on;
  - which services are up;
  - that the app has quit;
  - the marker count;
  - where the backup is.

Keep the detail in `$RUN/results.md`, not in the reply.
