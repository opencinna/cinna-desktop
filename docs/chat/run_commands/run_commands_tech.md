# Run Commands from a Message: Technical Details

## File Locations

Shared
- `src/shared/commandRun.ts`: pure, no filesystem, used by the renderer and main. `splitCommandLine`, `scriptWord`, `INTERPRETERS`, `UV_RUN_FLAGS`, `READ_ONLY_COMMANDS`, `ENV_ASSIGNMENT`, the option tables (`GREP_OPTIONS`, `RG_OPTIONS`, `PLAIN_OPTIONS`, `NEEDS_PATH`, `FIND_*`), `parseOptions`, `searchShape`, `findShape` (the option tables and search logic live here so the menu's check refuses what main refuses), `looksAutoRunnable`, `KNOWN_COMMANDS`, `detectCommand`, `commandOutputFilename`. Tests: `commandRun.test.ts`, with its table in `commandRunCases.ts`
- `src/shared/userCommands.ts`: the IPC types (`UserCommandRunInput`, `UserCommandRunResult`, `UserCommandRunFailure`, output and dismiss results, `UserCommandOutputFrame`, `isUserCommandOutputFrame`), `USER_COMMAND_RUN_REASONS`, `USER_COMMAND_OUTPUT_REASONS`, `stripAnsi`
- `src/shared/sessionActivity.ts`: kind `command`, `AGENT_PROCESS_KINDS`

Main
- `src/main/services/localAgents/ownCommandPolicy.ts`: the fs-aware rule. `ownCommandAllowed`, `ownCommandRefusal` (null, or the per-case reason sentence from `OWN_COMMAND_REASONS`; `ownCommandAllowed` is `=== null`), `allowedPath`, `realPathOf`, `nodeOwnCommandFs`
- `src/main/agents/drivers/acp/antigravityAutoApproval.ts`: keeps the edit rule and the ask's rawInput parsing, calls `ownCommandAllowed` for `execute` asks; re-exports `splitCommandLine`
- `src/main/services/userCommands/userCommandService.ts`: `createUserCommandService(deps)`: `run`, `watch`, `outputText`, `outputFile`, `dismiss`, `stopper`, `chatRemoved`, `shutdown`, `sweep`. Node only, no Electron. `index.ts` builds the production instance, installs the stopper (`installSessionActivityStopper('user-commands', …)`) and holds `installUserCommandWorkspace`
- `src/main/agents/drivers/index.ts`: `agentWorkspaceFolder(userId, agent)`, `agentCommandWorkspace(userId, agent)`, and `ownCommandScriptRoots` (renamed from `antigravityScriptRoots`; the one builder of `scriptRoots` for both features)
- `src/main/hub/core.ts`: installs the workspace resolver and calls `sweep()` at start; `shutdownHubCore` awaits `userCommandService.shutdown()`
- `src/main/ipc/user_commands.ipc.ts`: `registerUserCommandHandlers()`, registered in `src/main/ipc/index.ts`
- `src/main/services/chatService.ts` (trash) and `chatRemoval.ts` (`chatHardDeleted`): call `userCommandService.chatRemoved`
- `src/main/services/sessionActivityHub.ts`, `chatSessionRelease.ts`, `agents/drivers/acp/acpPool.ts`: the `command` exclusions below

Preload: `window.api.userCommands` (`run`, `output`, `outputText`, `outputFile`, `dismiss`); `AgentData.localPath` (folder agents only).

Renderer
- `components/chat/MessageContextMenu.tsx`: `messageMenuItems(file, canPublish, command?)`, `menuCommandOf`, the `run`, `run-background`, `edit-run` actions
- `components/chat/MessageBubble.tsx` and `fileRefs.tsx`: `MessageIdContext`; `data-message-id` on a persisted, non-streaming body
- `components/chat/CommandEditDialog.tsx` (mounted once in `App.tsx`), `CommandOutputPanel.tsx` (mounted in `layout/ChatWorkspace.tsx` above the composer)
- `components/chat/SessionActivityBadges.tsx`: `CommandsBadge`, `CommandRow`, `useCommandOutputAdder`, `formatRunDuration`, `useSecondsNow`; `SessionMetaBadges.tsx` renders the badge after Subagents and Background
- `stores/userCommands.store.ts`: open panel per chat, the edit request, the dialog's start (`submitEdit`)
- `stores/composerAttachTarget.store.ts`: `ChatInput` publishes each chat's draft key and attach scope; `utils/composerUpload.ts` (`uploadComposerFiles`, extracted from `hooks/useChatAttachments.ts`) is the upload path both share
- `utils/userCommands.ts`: `agentRunsCommands`, `fenceLanguage`, `addCommandOutputToComposer`
- `package.json`: `@xterm/xterm`, `@xterm/addon-fit`; `assets/main.css` imports the xterm stylesheet into `layer(base)`

## Database Schema

None. Runs are hub items (memory) and log files.

## IPC Channels

- `userCommands:run({ chatId, messageId, command, reviewed })` (invoke) returns `{ ok: true, itemId, folder } | { ok: false, code, reason, folder? }`, `code` one of `needs_review | not_local | folder_missing | chat_not_found | spawn_failed`
- `userCommands:output` (`ipcRenderer.postMessage` with `{ chatId, itemId }` and a MessagePort): frames `start` (command, folder, start time, backlog of the log's last 2 MB), `chunk`, `end`, or one `missing`. Closing the port never stops the run; the subscription also ends if the active profile changes
- `userCommands:outputText(chatId, itemId)` returns `{ ok, text, filename }` or a refusal. `userCommands:outputFile` returns the same text written to `<userData>/command-runs/<chatId>/<itemId>/<filename>` as `{ ok, path, filename }`, and records the path with `pathGuard` so the composer's ingest accepts it. The renderer uses `outputFile`
- `userCommands:home()` returns the home folder; the dialog shows the folder through `homeDisplayPath` (`src/shared/userCommands.ts`, `~/…`) because the sandboxed renderer cannot read it
- `userCommands:dismiss(chatId, itemId)` removes an ended run (a running one is refused with `running`)
- Stop is the existing `sessionActivity:stop`. Output refusals: `not_found | running | chat_not_found | unreadable`

All handlers require activation and a chat visible to the profile and not trashed.

## Services & Key Methods

- `run`: resolves the message (it must belong to the chat; an assistant message's `sourceAgentId`, else the chat's agent), then `deps.workspace(agent)`; `missing` becomes `folder_missing`, null `not_local`. With `reviewed: false` it calls `ownCommandRefusal({ folder, scriptRoots }, folder, command)`. It spawns `$SHELL -c` (the shell env's `SHELL` if absolute, else `/bin/zsh`) with `detached: true`, `stdio: ['ignore','pipe','pipe']`, env from `shellEnvForChild(getShellEnv())` plus the colour hints, then reports an upsert (`kind: 'command'`, title the command, detail the display folder with `~`, `outputPath` the log, `canStop: true`)
- Output is decoded with a `StringDecoder` per stream before it is written, so the log holds the text the panel was sent and a replay ends on a character boundary
- `LOG_CAP_BYTES` 20 MB, `BACKLOG_BYTES` 2 MB, `ATTACHMENT_BYTES` 200 KB, `STOP_GRACE_MS` 5 s, `SHUTDOWN_GRACE_MS` 2 s
- Starts in flight are counted per chat; a chat removed while a start is awaiting its spawn is detected afterwards and the process is killed before it is reported
- `shutdown` sets `closing` before it signals anything: a start still in flight (tracked in `inFlight`) kills what it spawned once it sees the flag and answers `spawn_failed` ("Cinna is quitting…"), and quitting waits for those starts within the same grace. A removed chat's still-running runs sit in `dying` so quit reaches them
- Windows kills with `taskkill /T /F`; elsewhere `process.kill(-pid)`
- An ended run whose row the hub no longer holds is forgotten (the service subscribes to hub changes at the first run)

## Session activity changes

A `command` item is not the agent process's, so four places skip it by passing `kinds: AGENT_PROCESS_KINDS` (`subagent`, `background`):
1. `activityReapDeps` (`acpPool.ts`): `hasRunning` and `lastChangeAt`, so a long user run does not keep the agent's process alive (`lastChange` is tracked per agent per kind for this)
2. `wirePoolToActivity`: the process exiting does not end commands as `lost`
3. `releaseChatSessions` (`chatSessionRelease.ts`): switching a chat's agent does not either
4. Retention: `KEPT_ACROSS_ROUNDS` in `sessionActivityHub.ts` holds `command`; a new start does not drop its ended items. Only the `ENDED_PER_KIND` (5) cap and `hub.remove(chatId, itemId)` (ended items only) remove them

Tests: `acpPool.test.ts`, `sessionActivityHub.test.ts`, `chatSessionRelease.test.ts`.

## Renderer Components

- **Menu**: `menuCommandOf` finds `data-message-id` on the right-clicked code, reads the cached chat (`['chat', chatId]`) and agents (`['agents']`), requires an assistant message and `agentRunsCommands`, then `detectCommand` with the fence language. It is decided once at open. `needs_review` from Run closes the menu and opens the dialog with `result.reason`
- **Edit dialog**: fixed layout. The textarea's rows (3 to 12) and the "N lines" scroll note are computed once at open, so nothing changes while typing; a refusal renders last, under the buttons. While a start runs the dialog cannot be dismissed. The start lives in the store so its answer lands if the dialog unmounted
- **Output panel**: fixed 240 px (`COMMAND_PANEL_HEIGHT`), at most one per chat, read-only xterm with `disableStdin`, theme read from the `--color-*` variables at mount and on theme change. The header's right end has Stop's slot (width reserved), so a run's end swaps text in without moving Stop
- **Layout**: `ChatWorkspace` passes `pillsBottom` to `MessageStream` while the panel is open, so the scroll pills sit above the panel, not behind it. Failed runs show the crossed circle (`CircleX`); the panel header and the popover share `formatRunDuration`
- **Commands badge**: stays while the chat has any command item; the face is the icon and the running count, replaced by a check or crossed circle for the last result when nothing runs, in one fixed-size cell. A `lost` last result (the code handles it; nothing in the service ends a run as lost today, so it is defensive) shows the same glyph in the warning colour. Rows: Open output (always last), Add output to message and Remove (ended)

## Configuration

None. No setting, no environment variable. The constants above are the tuning.

## Security

- The guard is a filter, not a boundary (see the business doc). The IPC layer trusts nothing from the renderer: `reviewed: true` is the dialog's claim, and it only skips the rule, never the chat, message, agent and folder checks
- Chat ids are used as path segments, so `SAFE_SEGMENT` is checked before any path is built
- The environment carries the user's login shell variables and nothing from the agent runtime or the credential store
- Output paths the renderer sees are written by main and recorded with `pathGuard`

## Tests

`commandRun.test.ts` (detect and guard tables), `ownCommandPolicy.test.ts` (and Antigravity's auto-approval tests, unchanged, as the proof the extraction changed nothing), `userCommandService.test.ts` (cap, Stop, shutdown, chat removal, sweep), `user_commands.ipc.test.ts`, `MessageContextMenu.commands.test.tsx`, `CommandEditDialog.test.tsx`, `CommandOutputPanel.test.tsx`, `SessionActivityBadges.commands.test.tsx`, `utils/userCommands.test.ts`.
