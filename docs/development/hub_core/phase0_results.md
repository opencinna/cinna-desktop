# Phase 0 evidence and Phase 1 extraction

Measured locally on macOS arm64, Node 22.23.2, 2026-09-19–20. The design remains in
`drafts/remote_cinna_hub/draft.md`; the implemented ownership rules are in
`docs/development/hub_core/hub_core_llm.md`.

## Offline evidence

`npm run test:hub` bundles and executes the real shared runtime under plain Node.
It rejects Electron and desktop UI modules in the bundle dependency graph. The
fixture installs an explicit diagnostic host, with no desktop fallback, external
HTTP, real credentials or native dialogs. A temporary HOME/userData isolates it
from the developer's profile.

The experiment boots production migrations and recovery, activates the existing
fixed `__default__` profile, creates a custom ACP fixture agent, and uses the
production run executor, ACP process pool, conductor MCP, live run hub and Inbox.
The first viewer unsubscribes after acceptance. A permission request parks with
no viewer attached; a new viewer receives a snapshot, answers through Inbox, and
also disconnects before completion. The assistant result is persisted, passes
foreign-key checks, and is readable after closing/reopening the database.

This proves that activation and turn ownership need no window or Electron runtime.
It uses an ACP fixture command, not an authenticated remote Claude folder agent.
Detach is an in-process subscriber removal; a network client and SSH tunnel are
Phase 2/3 transports. The unattended wait is deliberately short, not an hour.

The installed `better-sqlite3` addon rejects plain Node: Electron ABI 145 versus
Node ABI 127. Do not rebuild this checkout's addon for Node and break desktop
E2E. The diagnostic injects the existing narrow `node:sqlite` adapter into the
normal database initializer. It exercises real SQLite, migrations and Drizzle,
but is not a production replacement for `better-sqlite3`. Choose a separate
Node-built addon or validate a full production SQLite adapter before shipping.

The installed pinned Claude and Codex CLIs also passed the existing offline
interface-contract suite: 57 passed, 3 explicitly live-only skipped. These use
loopback fake providers, temporary profiles and no real login. They establish
CLI/adapter behavior on this Mac, not non-interactive SSH authentication.

## Real-host checks still unverified

No Linux/macOS SSH destinations were supplied. The following remain live
validation gates; no host has been installed, modified or logged into:

1. A real Claude folder turn on Linux and macOS, including an authenticated
   non-interactive launch and client disconnect while work continues.
2. An hour-long parked Claude/Codex permission with the viewer absent. Existing
   asks are durable rows but their live resolvers remain process-owned; restart
   expires orphaned asks. Expiry/standing-grant policy remains later-phase work.
3. launchd and `systemd --user` with linger across logout/reboot.
4. SSH ControlMaster/tunnel reconnect after sleep/network changes and clean
   stdout under the target user's shell profile.
5. macOS Keychain/login availability from SSH and credentials provisioning.

The new Linux CI job runs the offline Node spike; its result is not claimed as
locally observed until CI runs. No daemon API, installer, supervisor or credential
push is implemented in Phases 0/1.

## Phase 1

- Explicit platform host: paths, keystore, HTTP/proxy, package files, Node child
  runtime, shutdown callbacks and UI actions.
- Shared core initialization, readiness wiring and synchronous-before-await
  shutdown. The desktop still calls core in the same process.
- Data-only event publisher, preserving main-window/all-window audiences.
- Desktop implementation code under `host/desktop`; optional Local Development
  hooks prevent core importing its workspace orchestration.
- IPC handlers recorded in a transport-neutral generic table, with the existing
  Electron adapter, activation checks and error serialization preserved.
- AST layering ratchet in unit tests and an independent bundle-graph/Node spike
  in CI. Developer and reviewer instructions record feature ownership.

## Desktop regression validation

| Check | Observed result |
|---|---|
| `npm test` | 397 files passed; 6,531 tests passed, 6 skipped |
| `npm run test:contract` | 57 passed, 3 live-only skipped |
| `npm run test:hub` | Import boundary, plain-Node boot, detached turn, parked permission and database reopen passed |
| `npm run test:packaging` | 15 passed |
| `npm run typecheck` | Main, preload, renderer and E2E passed |
| `npm run build` | Production build passed |
| `make e2e-offline` | 146 passed, 3 live-only skipped; full final-build rerun completed in 15.8 minutes |
| Unsigned macOS arm64 package | Built with installed Electron, native rebuild/signing/notarization/publishing disabled; unpacked dependency checks passed |
| `npm run test:packaged:main` | 24 external imports, SQLite, libsodium, canvas, RTF and PDF extraction passed against that package |
| `npm run test:packaged:acp` | Both packaged Claude and Codex adapters initialized successfully |

The first full offline E2E run exposed two stale test assumptions. Both failures
were reproduced in an untouched `1c54126` checkout before changing the tests:
OpenCode's Permissions tab now includes delegation controls, and Inbox reads
task detail to discover structured delegation asks. The corrected tests explicitly
select OpenCode and distinguish task-list titles from detail-response titles,
preserving the behavior each scenario is intended to verify.
