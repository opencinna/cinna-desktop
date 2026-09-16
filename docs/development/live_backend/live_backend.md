# Live-Backend Testing

## Purpose

Test a desktop change end to end against a **real, running cinna-core**, by hand or with an agent at the keyboard. Use it for scenarios that neither the unit suite nor the E2E suite can reach: the backend is stopped, killed, paused, or rewound to an older commit while the app is mid-turn, and the outcome is judged in the chat, the app's database, the backend's database and both logs at once.

The crash-recovery work ([Turn Recovery](../../agents/turn_recovery/turn_recovery.md)) was verified this way. The run found bugs on both sides, which the E2E suite's fake agent could not have shown:
- `tasks/cancel` answering `{}`;
- a question turn ending `completed`;
- an orphan repair that saved no reply row;
- a live stream drop that failed at once.

Each backend finding went back to cinna-core as a written handover, and the scenarios were re-run on each fix.

It complements [End-to-End Tests](../e2e/e2e.md), and does not replace them. A scenario that settles here, and can be scripted against a fake, should become an E2E spec.

## Core Concepts

- **Control server (`scripts/live-backend/ctl.mjs`)**: a small HTTP server on `127.0.0.1:47111` that holds one launched app (the built `out/`, through Playwright's Electron launcher). It accepts these requests:
  - `/launch`;
  - `/kill`: SIGKILL of the main process, so `will-quit` never runs (a crash);
  - `/quit`: `app.quit()`, so the quit flushes run (Cmd+Q);
  - `/front`: shows the window;
  - `/status`;
  - `/run`: any async Playwright code against the window.

  The app stays alive between shell commands, so a scenario can be walked one step at a time and inspected in between.
- **Helpers (`scripts/live-backend/live.sh`)**: shell functions, sourced in zsh or bash, around the control server, the app's SQLite database (always read from a copy) and cinna-core's docker compose stack and Postgres. `live_help` lists them.
- **`CINNA_CORE_PATH`**: the cinna-core checkout whose `docker compose` stack serves the agent. `CINNA_LIVE_AGENT_ID` and `CINNA_LIVE_AGENT_NAME` name a remote agent already synced into the app. These and the other `CINNA_LIVE_*` settings are read from the environment, then from `.env` (see `.env.example`).
- **Real profile**: unlike the E2E sandbox, the app runs on the profile `npm run dev` uses (`~/Library/Application Support/cinna-desktop`), unless `CINNA_LIVE_USER_DATA` is set.
  - **Why not a copy:** a synced Cinna account's tokens are encrypted with the login keychain, so the E2E suite's mock keychain cannot decrypt them.
  - **Why not a copied profile on the real keychain:** its token refreshes would rotate the real profile's refresh token and sign it out.

  Back the database up first (`live_backup`), and run nothing else that uses this profile.
- **Levers**: what the scenario does to the server, all from `CINNA_CORE_PATH`:

  | To simulate | Command | What the app sees |
  |---|---|---|
  | Server unreachable, agent keeps working | `dc stop frontend` / `dc start frontend` | connection refused on the card and A2A URLs |
  | Server error | `dc stop backend` | the proxy answers 502 (sometimes 504) |
  | Backend crash | `dc kill backend`, then `dc start backend` | the stream drops; the orphan repair ends the turn about 3 minutes later |
  | Server that hangs | `dc pause frontend` / `dc unpause frontend` | connections accepted, never answered |
  | An older backend | `core_switch <commit>` / `core_back` | the dev server reloads the checked-out code |
  | Signed out | revoke the desktop device session in the web UI | 401 on the card fetch |

- **Run directory** (default `drafts/live_runs/<yyyymmdd>/`, gitignored) holds:
  - `app.log`: the app's stdout, timestamped, with `LAUNCH` / `EXIT` markers;
  - `shots/`: screenshots;
  - `results.md`: your notes, added with `note`.

## User Stories / Flows

### Preparing a run
1. Quit every other Cinna Desktop, including the installed release. Both share the profile and the single-instance lock. The installed release also catches `cinna://` sign-in redirects. `ctl launch` refuses to start while another instance runs.
2. With the app closed, run `source scripts/live-backend/live.sh`, then `live_backup`. Note the printed folder.
3. Run `live_preflight`. It shows:
   - the cinna-core commit, a clean tree, and the compose services up;
   - the agent card answering `401` (up, not signed in to curl);
   - the agent present in the app.
4. Start the control server in another terminal: `make live-ctl` builds `out/` and holds the app. Then `ctl launch`.
5. Send one throwaway message (`newchat`, `send hi`, `waitidle`), so a suspended agent environment is awake before timing-sensitive steps.

### Walking a scenario
1. Write the plan first, in `drafts/<topic>/`: goal, steps, and what to expect in four places (the UI, the app DB, the backend DB, the log), plus a results sheet.
2. Put the agent into a state worth breaking. `starttool` sends a 90-second tool call and retries in a fresh chat when the agent refuses, which some agents do now and then.
3. Pull a lever (`ctl kill`, `dc stop frontend`, …) and read the state straight away:
   - `state <chat>` for the app DB;
   - `bsessions` / `bmsgs <session>` for the backend DB.
4. Relaunch or restore, then watch:
   - `ui` gives Stop, composer, "Still running" and the Inbox count;
   - `waitidle`, `sidebar`, `body`, `shot <name>`;
   - `applog` gives the recovery log lines since the last launch.
5. Record the outcome with timings and log lines (`note …`).
6. When a person has to act (sign in, look at the screen), run `ctl front` first. The window is hidden by default (`CINNA_BACKGROUND_WINDOW=1`).

### Finishing
1. Run `ctl quit`, then `core_back` if you switched commits. Also run `dc start frontend` / `dc unpause frontend` if you left one down.
2. Check that `q "select count(*) from inflight_turns"` is 0 and no marker was left behind.
3. Delete the test chats you no longer need. `live_restore <backup>` puts the database back, with the app closed.

## Business Rules

- **Nothing here is a test run.** It is a manual, user-decided session; nothing in CI or `npm test` calls it.
- **Protect the real profile.**
  - Back up before the first launch.
  - Edit the real database only with the app closed (for example, ageing a marker).
  - Put back any row you changed to stage a scenario.
- **One instance only.** A second Cinna Desktop makes the launched app exit silently, and can steal the OAuth redirect.
- **Read the app database from a copy** (`snap`) while the app runs; WAL mode keeps recent writes in `-wal`.
- **Judge on four sources, not the screenshot**: UI, app DB, backend DB, log. Several defects looked right on screen.
- **Plan and results live in `drafts/`**, which is never committed. A finding that changes code goes through the usual build, review and docs loop.
- **Backend findings go back as a handover:**
  - a self-contained prompt for a cinna-core session: what was seen, the sessions to look at, what is wanted and what to send back;
  - the backend's reply is saved beside it, and the scenarios are re-run on the fixed commit.

## Architecture Overview

```
shell (you / an agent)
  source scripts/live-backend/live.sh
    ctl / pw ──HTTP──▶ scripts/live-backend/ctl.mjs ──Playwright──▶ Electron (out/, real profile)
    snap / q / state ───────────────────────────────────────────▶ copy of cinna.db
    dc / psqlb / bmsgs ──docker compose (CINNA_CORE_PATH)──▶ cinna-core backend, proxy, Postgres
  run dir: app.log · shots/ · results.md
```

## Integration Points

- [End-to-End Tests](../e2e/e2e.md): the automated, sandboxed suite. `make e2e-integration` is its one cross-repo spec.
- [Turn Recovery](../../agents/turn_recovery/turn_recovery.md): the feature this was built to test.
- [Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md): the sign-in step a revoked-session scenario exercises.
- Sub-doc: [Running a Live-Backend Session](live_backend_llm.md) is the step-by-step reference an agent follows.
