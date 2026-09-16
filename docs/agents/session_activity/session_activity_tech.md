# Session Activity — Technical Details

Implementation reference for [Session Activity](session_activity.md). Follow-up turns are documented with the driver, in [The Agent Turn (tech)](../local_agents/agent_turn_tech.md#between-turn-listening-and-follow-up-turns). The wire facts are in [the ACP contract](../local_agents/acp_contract.md#session-activity-over-the-air-extension).

## Read this first

1. **Drivers report; they never read.** `SessionActivityReporter.report(chatId, agentId, change)` is the only port a driver gets. The hub, the IPC push and the reaper are the app's concern. `src/shared/sessionActivity.ts` names no engine and no vendor
2. **Activity is read before the follow-up gate, not after it.** A task's end must not be lost with traffic the gate later drops. `SessionActivity.observe` skips a notification object it has already seen, because the same frame can reach both the between-turn listener and, replayed, the turn that took it
3. **The translator ignores every activity kind.** `AcpMessageStream.apply` returns `{}` for `async_task_*` and `subagent_*`. They are not transcript content
4. **A Claude subagent's `Agent` call is synthesized** (`SubagentFrames`), because with `nativeSubagentSessions` the parent never receives the `tool_call`. Removing it changes the saved transcript of every subagent turn, which the "transcript unchanged" tests in `acpActivity.driver.test.ts` catch
5. **`lost` is written by whoever loses sight:** the pool's `onStatus` (a process leaving `running`) and `releaseChatSessions` (a chat that no longer answers to the agent). Nothing else infers it

## File Locations

### Shared
- `src/shared/sessionActivity.ts` — `SessionActivityKind`, `SessionActivityState`, `SessionActivityItem`, `SessionActivitySnapshot`, the change union (`SessionActivityUpsert`, `SessionActivityEnd`), `SessionActivityReporter`, `SESSION_ACTIVITY_CHANGED_CHANNEL`, `SessionActivityGetResult`, `SessionActivityStopFailure` / `SessionActivityStopResult`, `SESSION_ACTIVITY_STOP_REASONS`, `sessionActivityStopRefusal()`
- `src/shared/tasks.ts` — `TaskListQuery.chatId`

### Main process — services and IPC
- `src/main/services/sessionActivityHub.ts` — `createSessionActivityHub(now?)`, the `sessionActivityHub` singleton, `ENDED_PER_KIND` (5)
- `src/main/services/sessionActivityStop.ts` — `installSessionActivityStopper(provider, stopper)`, `stopSessionActivity(chatId, itemId, hub?)`, `SessionActivityStopper`, `SessionActivityStopOutcome`
- `src/main/services/chatSessionRelease.ts` — `installChatSessionForgetter`, `forgetChatSessions(chatId, agentId?)`, `releaseChatSessions(chatId, agentId?)` (forget, then `endAll(…, 'lost')`)
- `src/main/services/chatService.ts` — `delete` / `permanentDelete` call `forgetChatSessions` and `hub.clear`; `update` (router or bound agent changed), `setRouter` and `removeOnDemandAgent` call `releaseChatSessions`
- `src/main/ipc/session_activity.ipc.ts` — `registerSessionActivityHandlers()`: the push listener and the two channels
- `src/main/db/chats.ts` — `chatRepo.isTrashed(chatId)`, profile-independent, for the push listener only
- `src/main/db/tasks.ts`, `src/main/ipc/task.ipc.ts` — the `chatId` filter on `task:list`

### Main process — ACP provider (`src/main/agents/drivers/acp/`)
- `acpActivity.ts` — `AirCapability`, `airClientMeta(capabilities)`, `translateActivity(notification, state, owner)`, `spawnedSubagent()`, `createSessionActivityRegistry(reporter?, options?)`, `ACP_SUBAGENT_FORGET_MS` (30 s), `SubagentFrames`
- `acpActivityStop.ts` — `stopAcpAsyncTask(target, timeoutMs?)`, `createAcpActivityStopper(registry)`, `ACP_ASYNC_TASK_STOP_TIMEOUT_MS` (5 s)
- `acpClient.ts` — the alias table (`aliases`, `ownerOf`) and `aliasSession(childId, parentId)`
- `acpConnection.ts`, `acpWebSocketConnection.ts` — `stopAsyncTask` and `aliasSession` on the connection
- `types.ts` — `ACP_ASYNC_TASK_STOP_METHOD` (`_session/async_task/stop`), `AcpAsyncTaskStopRequest` / `AcpAsyncTaskStopResponse`, `AcpConnection.stopAsyncTask` / `aliasSession`, `ACP_BUSY_REAP_CEILING_MS` (30 min)
- `acpPool.ts` — `activityReapDeps(hub)`, `wirePoolToActivity(pool, hub)`, and the production pool built with both
- `acpProcessPool.ts` — `isBusy` / `lastActivityAt` deps, `armReap` (the busy deferral), `idleSince`
- `acpLaunchers.ts` (Claude: both capabilities), `codexLauncher.ts` (`asyncTasks`), `customLauncher.ts` (`CUSTOM_CLIENT_CAPABILITIES`, `asyncTasks`)
- `acpDriver.ts` — `createSessionObservers` (the between-turn feed, see [agent_turn_tech.md](../local_agents/agent_turn_tech.md#between-turn-listening-and-follow-up-turns)), `observeActivity()`, and `AcpDriver.forgetChatSessions` / `activityStopper`
- `src/main/agents/drivers/index.ts` — wiring: `activity: sessionActivityHub`, `installChatSessionForgetter(…)`, `installSessionActivityStopper('acp', acpDriver.activityStopper)`

### Preload
- `src/preload/index.ts` — `window.api.sessionActivity.get(chatId)`, `.stop(chatId, itemId)`, `.onChanged(handler)` → unsubscribe

### Renderer
- `src/renderer/src/hooks/useSessionActivity.ts` — `useSessionActivity(chatId)`, `sessionActivityKey`
- `src/renderer/src/hooks/useSessionActivityStop.ts` — `useSessionActivityStop(chatId, items)` → `SessionActivityStopControl`, `STOP_SETTLE_FALLBACK_MS` (10 s)
- `src/renderer/src/hooks/useTaskList.ts` — `useTaskList(selection)`, `TaskListSelection`, `taskListKey()`
- `src/renderer/src/components/chat/SessionMetaBadges.tsx` — the strip; `SPLIT` / `COLLAPSED` container-query classes
- `src/renderer/src/components/chat/SessionActivityBadges.tsx` — `SessionActivityBadge`, `activityLabel()`, `formatActivityDuration()`, `metaBadgeClass`, `metaCountClass`, `metaPopoverClass`
- `src/renderer/src/components/chat/ChatTasksBadge.tsx` — `ChatTasksBadge`, `tasksLabel()`
- `src/renderer/src/components/tasks/TaskRow.tsx` — the row shared with `RecentTasks`, with `size: 'regular' | 'compact'` and `onOpened`
- `src/renderer/src/components/ui/useHoverPopover.ts` — `useHoverPopover(placement)`, `HOVER_CLOSE_DELAY_MS` (200 ms)
- `src/renderer/src/components/ui/usePopover.ts` — `usePopover(placement, {keepTopWhileOpen})`, `pinTopEdge(pos, top)`, `PopoverOptions`, `FixedPos`
- `src/renderer/src/components/chat/ChatInput.tsx` — `@container/composer` on the lower row, the non-wrapping `composer-chips` scroller, `SessionMetaBadges` before `RouterBadge`
- `src/renderer/src/components/chat/OnDemandAgentChips.tsx` — `agentChipClass` (4.5–12rem), shared with `ActiveMcpChips`

## Database Schema

**None.** The hub is memory-only on purpose. The only storage change is a read: `taskRepo.list` gained `filter.chatId`, an equality on the existing `tasks.chat_id`.

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `sessionActivity:get` | `(chatId) → SessionActivityGetResult` | Activation-gated. A chat the active profile does not own answers `{ok: false, code: 'chat_not_found'}`. The renderer reads that as an empty snapshot |
| `sessionActivity:stop` | `(chatId, itemId) → SessionActivityStopResult` | Activation-gated. Not owned or trashed → `chat_not_found`; a non-string or empty item id → `not_stoppable`. Never throws |
| `session-activity:changed` | main → renderer, `{chatId, snapshot}` | The chat's whole snapshot on every effective change |
| `task:list` | `TaskListQuery` gains `chatId` | A present but non-string or empty `chatId` **throws** rather than being dropped, because a dropped filter would widen one chat's list into every task the profile has |

The push listener (`registerSessionActivityHandlers`) reads `chatRepo.isTrashed` first, for any profile, and calls `hub.clear` for a trashed chat. That drops the report instead of keeping it, so a late report neither reaches the window nor holds the agent's process busy. Then it sends only for an activated profile that owns the chat.

## Services & Key Methods

### `createSessionActivityHub` (`sessionActivityHub.ts`)

| Method | Behaviour |
|---|---|
| `report(chatId, agentId, change)` | Applies one change. The first upsert for an id creates the item; if no item of that kind is running, the ended items of that kind are deleted first. Later upserts merge only fields they carry (`undefined` and `null` never overwrite), and `canStop` is forced false for an ended item. An end sets state, `endedAt`, `canStop: false`, and the summary when given; a repeated identical end is not a change. The ended items of the kind are trimmed to `ENDED_PER_KIND`. Emits only on an effective change, and records `lastChange` for the agent |
| `endAll(filter, state = 'lost')` | Ends every running item matching `{chatId?, agentId?}`, one emit per chat |
| `snapshot(chatId)` | Ordered copies (dates cloned) |
| `hasRunning(filter)` / `lastChangeAt(agentId)` | What the reaper reads |
| `onChange(listener)` | A throwing listener is logged and skipped |
| `clear(chatId)` | Forgets the chat; emits an empty snapshot if it held anything |

### ACP translation (`acpActivity.ts`)

`translateActivity` turns one notification into hub changes. Item ids are `<sessionId>:<wireId>`, so two sessions of one chat never collide.

| Wire | Change |
|---|---|
| `async_task_spawned` | upsert `background`: title = `name` ?? `description` ?? id; detail = `description` unless it repeats the title (Claude repeats it); `outputPath`; `canStop` |
| `async_task_progress` | upsert detail (`summary`) and `outputPath`, for a task this session announced. Claude's spawn has no `outputFilePath`; it arrives here |
| `async_task_state_update` | `running`/`stopping` → upsert; `completed` → completed; `failed` → failed; `stopped`/`killed`/`cancelled` → stopped; anything else → lost, with a warning |
| `subagent_spawned` | upsert `subagent`: title = `name` ?? "Subagent", detail = `task` |
| `subagent_state_update` | `completed`, `failed`, `cancelled` → stopped, `disconnected` → lost, unknown → lost |
| Codex `tool_call` / `tool_call_update` with `_meta.codex.subagent {threadId, path, activity}` | `started`/`interacted` → upsert, titled with the last path segment (a root path is ignored); `completed` / `interrupted` end the current run. A message to a subagent whose run ended starts run `#2`, `#3`… |
| Codex `_meta.codex.collaboration` (derived from adapter code) | `spawnAgent` (not failed) upserts each `receiverThreadIds` entry, with `rawInput.prompt` as its detail; `rawInput.agentsStates[thread].status` ends known threads (`completed`; `interrupted` → stopped; `errored`/`shutdown`/`notFound` → failed) |

`createSessionActivityRegistry(reporter)` holds one `SessionActivity` feed per `(connection, sessionId)`. A later scope replaces the earlier one. On `subagent_spawned` the feed calls `connection.aliasSession(child, parent)` and records the child's name and task. On a terminal subagent state it schedules forgetting the route, the spawn info and the call link after `ACP_SUBAGENT_FORGET_MS`, which is long enough for the parent's PostToolUse update that follows (watched 2 ms later) and for a corrected state. `lookup` answers the parent's feed for a child session id. `forgetChat` closes feeds; the hub items stay and end on their own messages or with the process. `asyncTask(chatId, agentId, itemId)` finds the connection, session and wire id for Stop, across every open session of the chat, not only the latest turn's. A connection's exit closes all of its feeds.

### Child-session routing (`acpClient.ts`)

`aliasSession(child, parent)` stores the child resolved to its root (a grandchild maps to the root). `deliver` and `handlersFor` route by `ownerOf(sessionId)`: a session that is itself bound or observed keeps its own traffic; otherwise an aliased child's traffic, **requests included**, goes to the parent's handlers unchanged, still naming the child. What the child sent before the alias existed is handed to the parent now, or moved into the parent's pre-bind pen in order. `clearRouting` clears the aliases.

### The synthesized `Agent` call (`SubagentFrames`)

One per turn (prompted or follow-up). `expand(notification)` returns the frames to fold, in order. What exists across turns is kept per session in `AgentCallMemory` (`announced`, `callOfChild`), because a subagent can outlive the turn that started it.

- A child frame whose `_meta.claudeCode.parentToolUseId` names a call nobody announced is preceded by a synthesized `tool_call` on the **parent** session id: `title` = the subagent name, `kind: think`, `rawInput {description, prompt}`, content = the task, `_meta.claudeCode.toolName: 'Agent'`
- A parent `tool_call_update` for an unannounced `Agent`/`Task` call gets the same start, from `subagent_spawned` (via `toolResponse.agentId`) or the response's own `description`/`prompt`
- After the PostToolUse update of a synthesized call: `status: completed` in `toolResponse` → a completed update carrying the report's text blocks; `async_launched` → completed with no content
- A subagent ending while its call is still open closes it: completed, or failed with "Subagent failed." / "Subagent stopped." / "Subagent disconnected."
- A subagent that **fails** before any call was linked gets a start and that end under `subagent:<child session id>`. A completed one does not, because a synchronous subagent's hook update follows its end and names the real call
- A call the agent did announce passes through untouched. Any exception returns the notification alone

### Stop (`sessionActivityStop.ts`, `acpActivityStop.ts`)

`stopSessionActivity` looks the item up in the hub: missing → `not_stoppable`; ended → `already_ended`; `canStop` false → `not_stoppable`. It then asks each installed stopper in turn. `null` means "not mine"; a throw counts as `unavailable`. An `unavailable` for an item that ended meanwhile becomes `already_ended`.

The ACP stopper handles only `background` items it can find in its registry. `stopAcpAsyncTask` sends `_session/async_task/stop {sessionId, asyncTaskId}` and races the answer against `ACP_ASYNC_TASK_STOP_TIMEOUT_MS` and the connection's exit. `{stopped: true}` → `stopped`; any other answer → `already_ended`; timeout, exit, a dead connection or a rejection → `unavailable`. Success needs no hub write: both engines send the task's `stopped` state update before they answer.

### Reaper (`acpProcessPool.ts`, `acpPool.ts`)

`scheduleReap` records `idleSince` and arms the timer (`ACP_IDLE_REAP_MS`). When it fires with no hold: if `isBusy(agentId)` (`hub.hasRunning({agentId})`), the quiet time is measured from `max(lastActivityAt ?? idleSince, idleSince)`. Under `ACP_BUSY_REAP_CEILING_MS` the timer is armed again; past it, the process is stopped with the reason `busy past ceiling`. `wirePoolToActivity` ends the agent's running items as `lost` on `stopped` or `exited`. `setState` guarantees each exit is heard once.

## Renderer Components

- **`useSessionActivity(chatId)`** — one `sessionActivity:get`, then every push is written straight into the cache. A per-query-client tick log keeps an older `get` reply from overwriting a snapshot pushed while that read was in flight. Without it, a running item could vanish until the next push. `staleTime: 0`, because pushes are heard only while a view of the chat is mounted, so a cached snapshot may have missed an end
- **`useSessionActivityStop(chatId, items)`** — the mutation's callbacks are on the hook, not on `mutate`, because `mutate`-level callbacks are dropped once the caller unmounts. The state is keyed by chat and item:
  - **Pending** from `onMutate` until one of three things. A refusal or a thrown error ends it. So does the item leaving the running set, which is derived from `items`. After an accepted answer, a `STOP_SETTLE_FALLBACK_MS` timer also ends it. If the item already stopped when the answer lands, pending ends at once
  - **A refusal** is written when an answer refuses (or the IPC throws, unwrapped into a sentence). An accepted answer clears it; a new click does not, so a retry leaves the old sentence up until its own answer. `refusal()` answers null for an item that is not running, and an effect prunes pending, refusals and timers for anything that left the running set. The timers are cleared on unmount
  - `SessionMetaBadges` passes a stable empty array (`NO_ITEMS`) while nothing is loaded, so the running set is not rebuilt on every render
- **`SessionMetaBadges`** — renders Subagents, Background, the collapsed `all` badge, then `ChatTasksBadge`. It owns the stop control so that it outlives the popovers. It is mounted only for a chat that exists
- **`SessionActivityBadge`** — renders nothing when none of its kind is running **and** its popover is closed. While the popover is open it stays, with the count at 0, no corner dot, and `activityLabel()` answering *"No background processes running"* (or *"No subagents or background processes running"*). `aria-label` is `activityLabel()` ("1 background process running", "2 subagents and 1 background process running"). The popover is portaled with `metaPopoverClass`, and its list is focusable for keyboard scrolling. `StopButton` stacks "Stop" and "Stopping…" in one grid cell so the width does not change. It uses `aria-disabled` rather than `disabled`, which would drop focus out of the popover. In `ActivityRow` the elastic duration comes last; the refusal (`role="alert"`) goes under everything
- **`ChatTasksBadge`** — `useTaskList({chatId, rootOnly: true})`, polled every 5 s. The row order is captured when the popover opens and held while it is open, as `RecentTasks` does. It shows ten `TaskRow size="compact"` rows, then "Open Inbox" (`setActiveView('inbox')`)
- **`useHoverPopover`** — opens on hover or focus, closes 200 ms after both leave. It passes `keepTopWhileOpen` to `usePopover`: once an `above-*` popover has been laid out, a layout effect in that same frame re-anchors it by its top edge (`pinTopEdge`). So a growing row extends it downward. It is re-anchored above the trigger on the next open or a resize. When the pointer leaves the trigger or the popover, the focus reason is checked against `document.activeElement`: a clicked Stop button whose row then left the DOM fires no blur, and would otherwise hold the popover open for good. Inside the popover only a real pointer *move* counts, so a popover appearing under a still pointer does not hold itself open. A click or Enter pins it open. Escape closes it, even when focus is in the composer

## Configuration

| Constant | Where | Value | Why |
|---|---|---|---|
| `ENDED_PER_KIND` | `sessionActivityHub.ts` | 5 | Enough for "2 finished, 1 running" without growing without bound |
| `ACP_BUSY_REAP_CEILING_MS` | `acp/types.ts` | 30 min | A background process that never reports again must not hold its process for ever |
| `ACP_ASYNC_TASK_STOP_TIMEOUT_MS` | `acpActivityStop.ts` | 5 s | Both engines answered in the same millisecond. Past five seconds the user is told to try again |
| `ACP_SUBAGENT_FORGET_MS` | `acpActivity.ts` | 30 s | Grace for the PostToolUse update and a corrected state after a subagent's end |
| `HOVER_CLOSE_DELAY_MS` | `useHoverPopover.ts` | 200 ms | Time for the pointer to cross from the badge into the popover |
| Composer split | `SessionMetaBadges.tsx` | 40rem | Measured: 473 px at the 800 px minimum window with the sidebar open, 780 px and more otherwise |

## Security

- **Ownership is checked in main on both channels**, and both are activation-gated. The push goes only to the active profile's own, non-trashed chats
- **Item ids are opaque to the renderer.** Stop is resolved from the hub and the driver's own registry. A renderer cannot name a session or a wire task id it was not shown
- **Output paths and task descriptions come from the agent** and are shown as text (truncated, with a `title`). They are never opened or followed

## Tests

| File | What it pins |
|---|---|
| `src/main/services/sessionActivityHub.test.ts` | Merge rules, retention per kind, corrections, ordering, `endAll`, `clear`, one emit per change |
| `src/main/services/sessionActivityStop.test.ts`, `acp/acpActivityStop.test.ts` | Every refusal, the timeout, exit during a stop, ended-meanwhile |
| `src/main/ipc/session_activity.ipc.test.ts` | Ownership, activation, the trashed-chat drop, stop refusals as data |
| `acp/acpActivity.test.ts` | The translation against the recorded Claude and Codex fixtures, Codex runs, the registry, aliasing, forgetting, `SubagentFrames` |
| `acp/acpActivity.driver.test.ts` | Through the driver: a Claude subagent turn's transcript equals the one before the capability (`testSupport/subagentFixtures.ts:beforeCapability`) |
| `acp/acpConnection.test.ts` | Alias routing, including requests and pre-alias traffic |
| `acp/acpProcessPool.test.ts`, `acp/acpPool.test.ts` | The busy deferral, the ceiling measured from the later of activity and idle, `lost` on exit |
| `acp/acpLaunchers.test.ts`, `codexLauncher.test.ts`, `customLauncher.contract.test.ts` | Which capabilities each launcher advertises |
| `src/main/ipc/task.ipc.test.ts`, `src/main/services/taskService.test.ts`, `src/renderer/src/hooks/useTaskList.test.tsx` | The `chatId` filter, and the malformed filter refused |
| `src/renderer/src/hooks/useSessionActivity.test.tsx` | Push into the cache; a stale read does not overwrite a push |
| `src/renderer/src/components/chat/SessionMetaBadges.test.tsx` | Badge presence, labels, popovers, Stop and refusal, the Tasks popover and Open Inbox, the badge kept up at 0 while its popover is open, the emptied collapsed badge's name, "Stopping…" held until the push (and its fallback), a refusal dropped once its item ended, and the popover closing after a clicked Stop left the DOM |
| `src/renderer/src/components/ui/usePopover.test.tsx` | `pinTopEdge`, the top edge kept while content grows, re-anchoring on the next open, other popovers unchanged, and `useHoverPopover` keeping its top edge |
| `src/renderer/src/components/chat/ChatInput.routing.test.tsx` | The badges left of the router badge, and a chip row that shrinks and scrolls instead of wrapping |
| `e2e/specs/session-activity.spec.ts` | Three scenarios in the built app, against a command-line ACP agent (`e2e/fixtures/scriptAcpAgent.mjs`, driven by `scriptAcpEngine.ts`) that replays the recorded Claude fixtures. (1) A background task's badge while it runs, and the turn it wakes landing as a new assistant message. (2) Stop reaching the agent, and the badge leaving. (3) The Tasks badge appearing once the chat has a task (`seedChatTask`), with its row opening the task page |

Fixtures: `acp/__fixtures__/claude/{async_task_background_shell,async_task_stop,followup_turn,subagent_background,subagent_sync}.json` and `acp/__fixtures__/codex/{async_task_background_terminal,async_task_stop,subagent,subagent_nocaps}.json` are recorded. `codex/subagent_collab.json` is **synthesized from the adapter's code** and says so in its `note`. Each fixture carries `promptReturnedAtIndex`, the first notification that arrived after `session/prompt` answered.
