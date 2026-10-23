# Run Commands from a Message: Technical Details

## File Locations

Shared
- `src/shared/commandRun.ts`: pure, no filesystem, used by the renderer and main. `splitCommandLine`, `scriptWord`, `INTERPRETERS`, `UV_RUN_FLAGS`, `READ_ONLY_COMMANDS`, `ENV_ASSIGNMENT`, the option tables (`GREP_OPTIONS`, `RG_OPTIONS`, `PLAIN_OPTIONS`, `NEEDS_PATH`, `FIND_*`), `parseOptions`, `searchShape`, `findShape` (the option tables and search logic live here so the menu's check refuses what main refuses), `looksAutoRunnable`, `chainsCommands`, `autoRunRefusal` (`'several_commands' | 'not_read_only' | null`, judged by the same checks as `looksAutoRunnable`), `KNOWN_COMMANDS`, `detectCommand`, `commandOutputFilename`. Tests: `commandRun.test.ts`, with its table in `commandRunCases.ts`
- `src/shared/userCommands.ts`: the IPC types (`UserCommandRunInput`, `UserCommandRunResult`, `UserCommandRunFailure`, output and dismiss results, `UserCommandOutputFrame`, `isUserCommandOutputFrame`), `USER_COMMAND_RUN_REASONS`, `USER_COMMAND_OUTPUT_REASONS`, `COMMAND_REVIEW_REASONS` / `commandReviewReason` (the window's guard sentences), `COMMAND_COLUMNS` (`min` 40, `max` 400, `default` 120) / `commandColumns`, `homeDisplayPath`, `stripAnsi`
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
- `components/chat/MessageContextMenu.tsx`: `messageMenuItems(file, canPublish, command?)`, `menuCommandOf` (now also `agentId`), the `run`, `run-background`, `edit-run` actions
- `components/chat/fileRefs.tsx`: `CommandScopeContext` (provided by `MessageStream`: persisted assistant messages of agents that `agentRunsCommands`, by id, with agent and folder) and `CommandMessageContext` (set by `MessageBubble` for a persisted, settled reply only); `MarkdownPre` and the inline `code` renderer add `command-ref`, `role="button"`, `tabIndex 0`, `title="Run…"`, `aria-label="Run… <command>"` and the click/key handlers (`commandActivation`, `commandKey`). `fencedBlock` reads a block's text and language from the hast tree, since highlighting splits it into spans. Also `MessageIdContext`; `data-message-id` on a persisted, non-streaming body
- `components/chat/MessageBubble.tsx`, `MessageStream.tsx`: build the two contexts above (memoised on values, so a transcript refetch does not re-render every code span)
- `components/chat/RunScriptModal.tsx` (mounted once in `App.tsx`): `RunScriptModal` holds the last window so it can play its exit, `RunScriptCard` is keyed by `seq`. `commandsBadgeOf(chatId)` finds the Commands badge by `button[data-badge="command"]` and `data-chat-id`; `STOP_PRESS_GUARD_MS` (400); `OPEN_PRESS_GUARD_MS` (500); the ⋯ menu is `RunScriptActions`, its portal marked `data-run-script-popover` so a press on it is not a press outside
- `components/chat/RunScriptCommandLine.tsx`: the `$` prompt and textarea (`commandLineRows`, `measureCharsPerLine`, `COMMAND_LINE_MAX_ROWS` 6) and the key rules
- `components/chat/CommandTerminal.tsx`: the xterm (`terminalTheme`, `TERMINAL_FONT_SIZE` 12, `runSeparator`, `dimLine`), 10 000 lines of scrollback, fit by `FitAddon` and a `ResizeObserver`
- `utils/cardMotion.ts`: `CARD_MOTION` (170 ms), `playCardEntrance`, `playCardExit(card, backdrop, into?)`, `prefersReducedMotion`, `CardOrigin`. Shared with `FilePreviewModal`, from which it was extracted unchanged
- `components/chat/SessionActivityBadges.tsx`: `CommandsBadge`, `CommandRow`, `useCommandOutputAdder`, `formatRunDuration`, `useSecondsNow`; `SessionMetaBadges.tsx` renders the badge after Subagents and Background
- `stores/runScript.store.ts` (`useRunScriptStore`): the one `window` (or null) with `chatId`, `messageId`, `agentId`, `folder`, `command`, `reason`, `origin`, the `runs` started in it and a `seq`; plus `pending` (`'run' | 'background' | null`), `error`, `exit` (`'close' | 'collapse'`) and `runSources` (run id to its source message, so a reopened run can run again). Actions: `openFromCode`, `openForRun`, `runFromMenu`, `start`, `close`, `dismiss`, `runRemoved`. Also `estimateRunColumns` and `RUN_SCRIPT_CARD_MAX_WIDTH`
- `stores/composerAttachTarget.store.ts`: `ChatInput` publishes each chat's draft key and attach scope; `utils/composerUpload.ts` (`uploadComposerFiles`, extracted from `hooks/useChatAttachments.ts`) is the upload path both share
- `utils/userCommands.ts`: `agentRunsCommands`, `fenceLanguage`, `addCommandOutputToComposer`
- `package.json`: `@xterm/xterm`, `@xterm/addon-fit`; `assets/main.css` imports the xterm stylesheet into `layer(base)`

## Database Schema

None. Runs are hub items (memory) and log files.

## IPC Channels

- `userCommands:run({ chatId, messageId, command, reviewed, columns? })` (invoke; `columns` is passed on only when a number) returns `{ ok: true, itemId, folder } | { ok: false, code, reason, folder? }`, `code` one of `needs_review | not_local | folder_missing | chat_not_found | spawn_failed`
- `userCommands:output` (`ipcRenderer.postMessage` with `{ chatId, itemId }` and a MessagePort): frames `start` (command, folder, start time, backlog of the log's last 2 MB), `chunk`, `end`, or one `missing`. Closing the port never stops the run; the subscription also ends if the active profile changes
- `userCommands:outputText(chatId, itemId)` returns `{ ok, text, filename }` or a refusal. `userCommands:outputFile` returns the same text written to `<userData>/command-runs/<chatId>/<itemId>/<filename>` as `{ ok, path, filename }`, and records the path with `pathGuard` so the composer's ingest accepts it. The renderer uses `outputFile`
- `userCommands:home()` returns the home folder; the window shows the folder through `homeDisplayPath` (`src/shared/userCommands.ts`, `~/…`) because the sandboxed renderer cannot read it
- `userCommands:dismiss(chatId, itemId)` removes an ended run (a running one is refused with `running`)
- Stop is the existing `sessionActivity:stop`. Output refusals: `not_found | running | chat_not_found | unreadable`

All handlers require activation and a chat visible to the profile and not trashed.

## Services & Key Methods

- `run`: resolves the message (it must belong to the chat; an assistant message's `sourceAgentId`, else the chat's agent), then `deps.workspace(agent)`; `missing` becomes `folder_missing`; a null answer is `not_local`, except for an agent id with the folder-agent prefix (`FOLDER_AGENT_ID_PREFIX`), which is `folder_missing` too (a moved folder drops out of the rescanned list). With `reviewed: false` it calls `ownCommandRefusal({ folder, scriptRoots }, folder, command)`. It spawns `$SHELL -c` (the shell env's `SHELL` if absolute, else `/bin/zsh`) with `detached: true`, `stdio: ['ignore','pipe','pipe']`, env from `shellEnvForChild(getShellEnv())` plus the colour hints, `COLUMNS` = `commandColumns(input.columns)` and `PYTHONUNBUFFERED=1`, then reports an upsert (`kind: 'command'`, title the command, detail the display folder with `~`, `outputPath` the log, `canStop: true`)
- Output is decoded with a `StringDecoder` per stream before it is written, so the log holds the text the terminal was sent and a replay ends on a character boundary
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

- **Click**: a command is detected once per text, in `fileRefs.tsx`, and only in a reply inside a `CommandMessageContext`; a click or Enter/Space calls `openFromCode`, with the click point or null for a key. A non-collapsed text selection and `event.detail > 1` open nothing. `command-ref` styling is in `main.css` (`code.command-ref`, `pre.command-ref`): the file reference's fill and hover transition with the edge from `--color-command-ref-edge` (`#3f6f52` dark, `#8cc09f` light); only colours differ, so nothing moves
- **Menu**: `menuCommandOf` finds `data-message-id` on the right-clicked code, reads the cached chat (`['chat', chatId]`) and agents (`['agents']`), requires an assistant message and `agentRunsCommands`, then `detectCommand` with the fence language. It is decided once at open. Run calls `runFromMenu` (the store starts it, so the answer lands after the menu has gone); `edit-run` calls `openFromCode`
- **Store and `seq`**: every open takes the next `seq` from a module counter that never repeats, even after a close, so the card (keyed by it) starts fresh and an open during the previous window's exit never reuses its card. Every asynchronous answer compares the `seq` it started under with the window now shown: `start` writes to the window only `still` if it is the same, and `runFromMenu` opens one only if none, or the one that was shown at the call, is still up (`mayOpen`). A late answer therefore never lands on a newer window; the run it started still reaches the badge. `openFromCode` and `openForRun` are ignored while a start is `pending`, as is `close` (the window cannot be dismissed while a start is in flight; `dismiss` can, for a profile change). The start lives in the store, not the window, so its answer lands if the window unmounted
- **Window**: `reason` is `commandReviewReason(command)` at `openFromCode`, main's reason at a `needs_review`, null for a run. The run shown is the last of `runs`; `start` appends. The `facts` per run (start time, end, missing) come from the output frames. The state text is `Running`, `Completed`, `Stopped`, `Exit N`, a signal name, `Failed`, or `Output no longer available`. The columns sent are the terminal's fitted count (`onColumns`), else 120
- **Exit**: `exit: 'collapse'` plays `playCardExit` into the badge's rect when `commandsBadgeOf` finds one on screen, else the plain reverse; `close` fades. The card unmounts after `CARD_MOTION.duration`, at once where nothing can animate
- **Terminal**: read-only xterm with `disableStdin`, theme read from the `--color-*` variables at mount and on theme change. Each run is its own `userCommands:output` subscription; a later run of the same window clears the terminal and begins with `runSeparator(n)`. The idle hint is dimmed and the first run clears it
- **Command line**: rows from `commandLineRows`, decided at open from `measureCharsPerLine` in a layout effect before first paint. `history` is the chat's `command` items' titles, newest first, deduplicated; `walk` keeps the typed draft so ↓ returns to it. Keys are in the business doc
- **Layout**: the transcript's scroll pills sit as for any chat; nothing is docked above the composer any more. Failed runs show the crossed circle (`CircleX`); the window header and the popover share `formatRunDuration`
- **Commands badge**: stays while the chat has any command item; the face is the icon and the running count, replaced by a check or crossed circle for the last result when nothing runs, in one fixed-size cell. A `lost` last result (the code handles it; nothing in the service ends a run as lost today, so it is defensive) shows the same glyph in the warning colour. Rows: Open output (always last; the `AppWindow` icon), Add output to message and Remove (ended). Open output calls `openForRun` with the click point (null for a keyboard activation) and then closes the popover through `onOpenOutput`; Remove calls `runRemoved`, which closes a window showing that run. The badge carries `data-chat-id`, which the collapse animation looks it up by

## Configuration

None. No setting, no environment variable. The constants above are the tuning.

## Security

- The guard is a filter, not a boundary (see the business doc). The IPC layer trusts nothing from the renderer: `reviewed: true` is the window's claim, and it only skips the rule, never the chat, message, agent and folder checks
- Chat ids are used as path segments, so `SAFE_SEGMENT` is checked before any path is built
- The environment carries the user's login shell variables and nothing from the agent runtime or the credential store
- Output paths the renderer sees are written by main and recorded with `pathGuard`

## Tests

`commandRun.test.ts` (detect and guard tables), `ownCommandPolicy.test.ts` (and Antigravity's auto-approval tests, unchanged, as the proof the extraction changed nothing), `userCommandService.test.ts` (cap, Stop, shutdown, chat removal, sweep), `user_commands.ipc.test.ts`, `MessageContextMenu.commands.test.tsx`, `fileRefs.commands.test.tsx` (clickable spans and blocks, selection and double-click, keys), `RunScriptModal.test.tsx` (command line keys, guard line, Stop press guard, rerun, collapse and close, ⋯ menu), `stores/runScript.store.test.ts` (`seq`, late answers, pending), `SessionActivityBadges.commands.test.tsx`, `utils/userCommands.test.ts`.
