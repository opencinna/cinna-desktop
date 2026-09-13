# Chat Routing — Technical Details

## File Locations

### Shared (main + renderer, pure)
- `src/shared/chatRouting.ts` — the whole rule. `ChatRouter` (`'direct' | 'human' | 'coordinator'`), `CHAT_ROUTERS`, `DEFAULT_CHAT_ROUTER`, `isChatRouter`, `routerOf(chat)`, `routingOf(chat)`, `newChatRouter({ agentIds, mcpIds, coordinate? })`, `RunTarget`, `Addressing`, `RoutableChat`. No React, no I/O, no Electron — imported by main and the renderer so neither keeps its own copy of the sentence
- `src/shared/ipcPayloads.ts` — `RunSendPayload` (`chatId`, `content`, `attachments?`, `addressedAgentId?`); one payload serves start and lower-level send

### Main process
- `src/main/ipc/run.ipc.ts` — `registerRunHandlers()`: activated `run:start` command, owned `run:watch`, chat cancellation and legacy native-port forwards; passes explicit scopes, observation and transactional acceptance callbacks to the shared executor.
- `src/main/services/runExecutionService.ts` — main-owned `start`, `isRunning`, `RunHandle`; private routing/agent preparation, catch-up, slash-command dispatch and terminal/refusal handling shared by IPC sends, Inbox continuations and explicit task starts.
- `src/main/services/threadContextService.ts` — `buildCatchUpPacket(input)`, `withCatchUp(packet, userContent)`, `CATCH_UP_CAP`. Pure over `MessageRow[]`
- `src/main/db/chatAgentCursors.ts` — `chatAgentCursorRepo.{get,list,advance}`
- `src/main/db/migrations/chat-router.ts` — `migrateChatRouter(sqlite)`: `chats.router` + backfill, `CREATE TABLE IF NOT EXISTS chat_agent_cursors`
- `src/main/db/migrations/index.ts` — registers it after the agent-driver migrations
- `src/main/db/schema.ts` — `chats.router`, `chatAgentCursors` table
- `src/main/db/chats.ts` — `chatRepo.setRouter(userId, chatId, router, { detachRoot?, bindRoot?, providerId?, modelId? })` (transaction), `updateMeta` (writes router directly), `create({ router })`
- `src/main/db/messages.ts` — `lastId(chatId)` (where a cursor lands), `lastAddressedAgentId(chatId)` (the sticky default)
- `src/main/db/chatOnDemandAgent.ts` — `list` is now explicitly ordered `created_at, agent_id`
- `src/main/services/chatService.ts` — `setRouter(userId, chatId, router)` (replaces `promoteToOrchestrated`)
- `src/main/services/a2aStreamingService.ts` — `streamToAgent({ …, onCompleted })`
- `src/main/ipc/chat.ipc.ts` — `chat:set-router`; `chat:update` validates `router` too
- `src/main/errors.ts` — `ChatErrorCode` gains `invalid_router`
- `src/main/services/jobService.ts` — `executeLocal` routes through `newChatRouter` / `routingOf`
- `src/main/db/jobs.ts` — `jobRunsRepo.createLocalChatAndRun({ router, … })`; `jobAgentRepo.listAgentIds` sorted

### Preload
- `src/preload/index.ts` — `window.api.run.start(payload)`, `watch(chatId, onMessage)` returning an unsubscribe function, and `cancelChat(chatId)`; legacy `send` / request-ID `cancel` remain. `window.api.chat.setRouter` and chat updates retain the same routing contract.

### Renderer
- `src/renderer/src/components/chat/RouterBadge.tsx` — the three-value pill + tooltip; `RouterBadgeInfo` (`router`, `agentName?`, `answererName?`, `modelName?`). The tooltip opens upward and right-aligned, everywhere; there is no placement option, because the one surface that needed a different one stopped needing it and nobody noticed for months
- `src/renderer/src/components/chat/OnDemandAgentChips.tsx` — `ChipAddressing { addressedId, onAddress }`; a chip becomes a button only when addressing is supplied
- `src/renderer/src/components/chat/ComposerPlusMenu.tsx` — `PlusCoordinateToggle { coordinating, pending?, onToggle }` → the "Let the model coordinate" `menuitemcheckbox` row
- `src/renderer/src/components/chat/ChatInput.tsx` — one `routingOf(chatData)` read feeding the badge, chip addressing, the coordinate toggle, `attachScope`, `showsChatControls`, `directTarget` and `showsReadinessLine`
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — new-chat preview: `newChatRouter(...)` → `routerInfo`; the send-time model requirement; the example-prompt refusal
- `src/renderer/src/hooks/useChat.ts` — `useSetChatRouter()` (optimistic, replaces `usePromoteToOrchestrated`); `useUpdateChat` takes `router`
- `src/renderer/src/hooks/useAgents.ts` — `useAttachAgentToChat(chatId)` (the `@`/picker gesture and its router switch)
- `src/renderer/src/hooks/useChatComposer.ts` — `submit` + private `answererFor` (the renderer's own copy of the answer, for bookkeeping)
- `src/renderer/src/hooks/useChatStream.ts` — `startRun(chatId, content, { attachments?, target? })` and `cancel`
- `src/renderer/src/hooks/useNewChatFlow.ts` — `startNewChat` router decision, root binding, attachment scope, first-message target
- `src/renderer/src/stores/chat.store.ts` — `addressedAgentByChat: Record<string, string>` + `setAddressedAgent(chatId, agentId)`, cleared by `reset()`

### Tests worth reading before changing behaviour
- `src/shared/chatRouting.test.ts` — the rule itself, including the stale-address and no-agents-left cases
- `src/main/ipc/run.routing.test.ts` — who answers, the packet, the cursor, port ownership on a throw, and the absence of retired agent/model forwards
- `src/main/services/threadContextService.test.ts` — packet contents, drops, cap, unknown cursor
- `src/main/services/chatService.setRouter.test.ts` — every transition, the refusals, and the attached-agent ordering
- `src/main/ipc/chat.router.test.ts` — router validation on both channels
- `src/main/db/migrations/migrations.test.ts` — the backfill on an install that predates the column
- `src/renderer/src/components/chat/ChatInput.routing.test.tsx` — badge, chips, toggle, addressing, no-layout-shift
- `src/main/agents/kindBranches.test.ts` — the `routing` ratchet category, held at **0**

## Database Schema

Column: `chats.router` (TEXT NOT NULL DEFAULT `'direct'`; see `src/main/db/migrations/chat-router.ts`). Backfill is the old two values verbatim — `orchestrated = 1` → `'coordinator'`, everything else stays on the default. **No row becomes `'human'`**: that value is only ever reached by a gesture made after the migration, so nothing has to guess which of a chat's agents was being addressed. The backfill `UPDATE` is guarded by the `ADD COLUMN` rather than by a data predicate, so a chat the user has since moved off `coordinator` is never dragged back on a later boot.

The former chats.orchestrated column is removed by `src/main/db/migrations/retire-chat-mirror.ts`, immediately after guarded legacy router backfill. migrateChats no longer adds it on fresh/repeated startup. Tests preserve an already-routed populated chat even when the mirror disagrees and check foreign keys after repeat migration.

Table: `chat_agent_cursors`
- `chat_id` (TEXT, FK `chats.id ON DELETE CASCADE`)
- `agent_id` (TEXT, FK `agents.id ON DELETE CASCADE`)
- `last_message_id` (TEXT, nullable)
- `updated_at` (INTEGER, timestamp)
- Primary key `(chat_id, agent_id)`. A row exists only once the agent has completed a turn in the chat; **no row means "has seen nothing"**, which is what makes the first packet the whole thread. Created in `chat-router.ts` rather than in `chats.ts` because it references `agents`, and this migration runs after that table exists. It is the table the orphaned comment in `schema.ts` had described since the multi-agent switchboard was removed; its predecessor `chat_agent_sessions` is dropped by `migrateChats`.

## IPC Channels

- `run:start` — activated invoke with `RunSendPayload`, returning the run ID; main resolves the answerer. `run:watch` independently sends the owned chat’s snapshot and sequenced events over MessagePort. `run:send` remains the lower-level combined send/port route. See [live-run IPC](../messaging/live_runs.md#architecture-and-ipc).
- `chat:set-router` — `(chatId: string, router: string) => { success: true }`. Validates via `isChatRouter` and throws `ChatError('invalid_router', …)` otherwise
- `chat:update` — also accepts `router`, and validates it the same way, because a new chat sets several fields in one call
- The normal Stop path uses owned `run:cancel-chat`, so a watch snapshot can be stopped before the protocol request ID arrives. Legacy `window.api.run.cancel` still invokes both protocol cancellation channels for an existing request ID.

`run.ipc.ts` follows the project's `postMessage` convention: the payload is the **second argument** to the `ipcMain.on` listener, and the port is on `event.ports[0]`.

## Services & Key Methods

- `routingOf(chat)` (`src/shared/chatRouting.ts`) — returns `{ router, rootAgentId, attachmentTarget, needsModel, answerer }`. `answerer` is a function rather than a value because only `human` needs the addressing, and most callers want the rest without having it
- `routerOf(chat)` returns a known router or the direct default. Legacy migration happens before use; there is no runtime fallback to an older mirror-only DTO.
- `newChatRouter({ agentIds, mcpIds, coordinate })` — no agent → `direct`; any MCP alongside an agent → `coordinator`; one agent → `direct`; more → `human`; an explicit `coordinate` wins over all of it
- `dispatchRun(port, payload)` (`run.ipc.ts`) — native port/activation boundary. Passes `inboxService.recordRunEvent` as observer and `resumeChat` as transactional acceptance bookkeeping; pending next-message asks enable preservation on pre-acceptance refusal.
- `runExecutionService.start(scope, payload, options)` — synchronously reserves the chat, then resolves owned chat → routing → human addressing or validated internal continuation target → model/agent preparation. Returns a handle before execution finishes; see the lifetime contract below.
- The agent path — `agentService.findAgent` (a miss is written to the transcript as well as posted), `driverFor(agent)`, packet built **before** `messageRoutingService.prepareAgentSend` persists the user row, `resolveCommandRunner` intercepting `/run:<name>` on the *typed* text, then `a2aStreamingService.streamToAgent({ …, onCompleted })`. No kind-specific pre-flight: card checks, endpoint/token resolution and Cinna re-auth mapping all report as `result.error` from inside the driver
- `buildCatchUpPacket({ messages, agentId, cursorMessageId, names?, cap? })` — returns `string | null`; **null, not `''`**, because "nothing to catch up on" is the ordinary case and the caller must send the user's text unchanged. Per-message clip 600 chars, whole-packet cap 4000, dropped from the front under `[…earlier messages dropped to fit]`; if nothing fits, the newest line is kept truncated rather than returning a header and a marker
- `withCatchUp(packet, userContent)` — the packet, a blank line, then the text. The stored user message is what the user typed; the packet travels on the wire only
- `chatService.setRouter(userId, chatId, router)` — no-op on the current router; resolves a provider/model only for `coordinator` (the only refusable transition, `ChatError('not_configured', …)`); refuses `direct` with more than one attached agent; computes `detachRoot` (leaving `direct`) and `bindRoot` (arriving at `direct`)
- `chatRepo.setRouter(...)` — one transaction: re-expose the former root as a pending-announce on-demand agent / delete the newly-bound root's on-demand row, set `router`, null or set `agent_id`, apply a resolved provider/model. `a2a_sessions` is never touched
- `a2aStreamingService.streamToAgent(...).onCompleted` — fires once, after the rows are persisted and **only** after a successful or needs-input ending (not errored, not stopped). Anything it throws is logged and swallowed: a bookkeeping write must not turn a finished turn into a failed one

## Shared Turn Lifetime and Acceptance

- `src/main/services/runExecutionState.ts` owns the process-local `activeRunsByChat` map shared by the executor and owned chat detail reads; its handle import is type-only to avoid a service cycle. `chatService.get` adds `activeRunId`, which is never persisted. `runExecutionService.cancelChat(userId, chatId)` checks chat ownership then cancels its active handle; activated `run:cancel-chat` exposes this through preload.
- `RunScope` captures `profileUserId` and `settingsUserId` for the turn; the executor resolves agents with those scopes rather than a later active-profile choice. IPC still requires activation; internal Inbox continuation is reached through activated, profile-scoped `inbox:answer`.
- `start` takes a required event observer and optional `StreamPort`. It reserves one active handle per chat before dispatch; a second simultaneous send is refused. The sink records events before forwarding, and a missing/disconnected renderer cannot stop persistence or Inbox bookkeeping.
- `RunHandle.id` identifies this invocation independently of the protocol task id. `accepted` resolves after user-message persistence and acceptance bookkeeping, before the driver starts. `completed` resolves a typed `RunOutcome` when the stream closes, including the model service’s asynchronous loop and saved output. It reports execution state, final/partial text, acceptance and remaining durable next-message IDs; `inputRequestReadError` forbids treating the list as authoritative. See [turn completion](../messaging/turn_completion.md). `cancel()` remembers an early cancellation until the stream supplies its transport request id.
- `messageRoutingService.prepareAgentSend` / `prepareLlmSend` accept `onPersisted`. `messageRepo.saveUser(msg, onSaved)` runs the callback inside the same SQLite transaction. The executor’s `onAccepted` callback is invoked here, before its acceptance promise resolves. Inbox/typed continuation uses it to validate task status/device claim and settle only requests for the selected agent. Task start uses it to bind the already-created chat and selected assignee to the existing task, deferring the file export until after commit. A throw rolls back the user message and request settlement together; no network work belongs inside that callback.
- `preserveOnRefusal` suppresses pre-acceptance error observation/job finalization for a pending answer or explicit task start, so a setup/refused transaction leaves the question or original task retryable. Refusals before owned chat resolution do not write job outcomes. After acceptance, driver endpoint/card/token failures are normal failed-turn outcomes; acceptance does not promise successful remote delivery or completion.
- An Inbox continuation passes its verified asking `agentId` as an internal target override. This continues that agent even in a coordinator chat, without asking the model to choose who answers the human’s reply. Human routing and non-root internal continuations receive catch-up built before the new message is saved. Renderer `addressedAgentId` remains subject to ordinary attached-agent routing; it is not this override.
- Internal `runnerTaskId` requires a non-deleted, runnable task linked to this owned chat and device. Its per-execution callback and observed `completionOwner` suppress whole-task/job finalization while retaining request bookkeeping; it is never accepted from renderer payloads. Ordinary calls report their job once after the final close decision. See [completion ownership](../messaging/turn_completion.md#completion-owner).
- `inboxService.endTurn` preserves durable next-message requests after normal completion. Sibling requests restore blocked status at turn end and defer `jobService.reportRunCompletion`. A coordinator’s agent tool refuses re-entry while that agent awaits a human answer. See [Inbox continuation](../../jobs/tasks/inbox.md#durable-continuation-and-refusal).
- This service runs one turn and now feeds a profile/chat-scoped event hub. Selected-chat watches attach/replay and survive idle gaps; [Live Run Attachment and Replay](../messaging/live_runs.md) owns the bounded cache, transcript baseline and settlement rules. `useChatDetail` polling remains the fallback when replay is unavailable. `RunHandle.completed` carries the [typed outcome](../messaging/turn_completion.md), and internal callers can explicitly own task completion. [The autonomous runner](../../jobs/tasks/autonomous_tasks_tech.md) owns consecutive turns, time/turn limits and handoff/handback above this executor. [Script execution](../../jobs/tasks/script_execution.md) and [local schedules](../../jobs/tasks/local_schedules.md) use the shared executor. Complete token accounting remains unsupported.

## Renderer Components

- `ChatInput` — `chatRouting = routingOf(chatData ?? {})` is the single read. `answerTarget = chatRouting.answerer({ addressed, lastAddressed, attached })`, where `addressed` comes from the store, `lastAddressed` is scanned backwards out of the cached messages (the same rows main reads) and `attached` from `useChatOnDemandAgents`. It feeds:
  - `badgeInfo` — an active chat reads its own row; the new-chat screen is told by `ChatWorkspace`. A `direct` composer shows no badge until `chatId ? boundAgent : selectedAgent` resolves. It passes that actual agent as `connectionAgent`, avoiding a location claim from an id or name alone
  - `chipAddressing` — supplied only on `human`; the ring follows the *resolved* answerer, not the raw click
  - `coordinateToggle` — offered only where there is something to coordinate (an agent attached or bound). Uses `mutateAsync().catch(setSendError)` rather than a `mutate`-level `onError`, which is dropped if the caller has unmounted and would swallow the only explanation of a refusal
  - `attachScope = chatRouting.attachmentTarget`
  - `showsChatControls = chatRouting.needsModel && !modeId` — `needsModel`, not `!boundAgent`, so a `human` chat is not offered a model picker
  - `directTarget` — the router's own answer in an active chat; the first agent picked on the new-chat screen otherwise
  - `showsReadinessLine` — an active chat: whenever it holds an agent at all. Gating it on the agent that would *answer* lifted the whole composer by 21px when the user handed the chat to the model
- `ChatInput.selectAgent` (the `@` pick, active chat) — order matters. An agent already in a `human` chat is simply **addressed**; re-attaching it would be a no-op that also re-armed its announce flag. An agent that is not in the chat yet is attached *and* addressed. The address is computed from the router the pick **lands on**, not the one it started from: a `direct` chat with an agent becomes `human` the moment a second arrives, and reading the current router there meant the address was never set on exactly that transition, so the sticky default sent the message back to the old root
- `useSetChatRouter` — optimistic `onMutate` writes `router`, and nulls `agentId` only on the way *out* of `direct`. Without the optimism, picking an agent then immediately pressing Enter races the refetch. `onSettled` invalidates `['chat', id]`, `['chat-on-demand-agent', id]` and `['chats']`
- `useAttachAgentToChat` — `direct` + this same agent → no-op; `direct` + an agent → `'human'`; `direct` + none → `'coordinator'`; already `human`/`coordinator` → just add
- `useChatComposer.submit` — no longer decides where the message goes. `answererFor` produces the renderer's own `RunTarget` from caches it already holds, used for the post-turn bookkeeping in `useChatStream` (whose status and readiness to re-read) and for `addressedAgentId`. Both processes read the same helper, so they cannot drift into different rules — only onto a cache that is a moment stale, and main's answer is the one that runs
- `useChatStream.startRun` — one entry point, because there is one channel. `target` is optional: omit it and main still routes the message, the renderer just does no per-agent bookkeeping afterwards
- `RouterBadge` — `connectionAgent?: AgentData | null` changes only a `direct` badge into **Local** (`SquareTerminal`) or **Remote** (`Waypoints`); absent agent data retains **Direct** for generic callers. Other labels are **You route**, **Model routes**, **Script routes**. The label uses natural content width and `whitespace-nowrap`, with no reserved minimum. Separate hovered/focused/dismissed state keeps the tooltip available to keyboard users; Escape dismisses it. `useId`, `role="tooltip"` and conditional `aria-describedby` associate it with the one focusable status badge.
- `OnDemandAgentChips` — with `addressing`, the chip's name becomes a `button` (`aria-pressed`, explicit `cursor-pointer`, since preflight gives every button a default cursor) and the addressed one takes `ring-2 ring-[var(--color-text)]`. The ring is the **foreground** colour, not the agent's: two agents can hash to the same preset, and a ring in the chip's own colour then reads as a slightly thicker border
- `ComposerPlusMenu` — the toggle row is `role="menuitemcheckbox"` and uses `aria-disabled` while pending, never `disabled`: a row that disables itself while focused drops focus to the page body mid-switch. The tick's slot is always present so ticking it moves no text
- `ChatWorkspace` — the new-chat send requires a model only when `newRouter === 'coordinator'` or nothing is selected; the refusal for the agent case now names the way out ("Removing the MCP servers lets the agents answer you directly instead")

### Connection detail lookup

- `src/renderer/src/components/chat/AgentConnectionDetails.tsx` — `agentLocation()` returns Local exactly for `source === 'folder'` or `driver === 'acp' && acpTransport !== 'websocket'`; every other agent is Remote. This describes the spawned ACP process, not an inspection of its command.
- `domainOf()` parses URLs and returns the first nonempty `URL.host`, never the raw URL. A2A precedence is protocol interface URL, endpoint URL, card URL, then the active Cinna server for a remote registration. Authentication reads source and token-presence booleans only.
- Detail children mount only while the tooltip is open. The `agent.development` branch precedes folder/ACP branches and renders public builder metadata directly; it never mounts a configuration-query child. Folder details use `useLocalAgent` and `RuntimePanel compact`; ordinary ACP uses `window.api.customAgents.configuration`; Managed uses `window.api.managedAgents.configuration` plus `useProviders`. Configuration queries use `['agents', agent.id, 'connection', profileId]` so profile changes cannot reuse another profile's details. There is no new IPC channel.
- `agentService.toDto` in `src/main/services/agentService.ts` adds optional `developmentEngine` only for development rows and only when `isAgentEngine` in `src/shared/engine.ts` accepts the saved `driverConfig.developmentEngine`. `AgentData` in `src/preload/index.ts` carries the typed field without exposing driverConfig. The builder detail branch maps it through `DEVELOPMENT_RUNTIME_NAMES` in `src/shared/developmentSession.ts`, otherwise shows **Not recorded**, alongside ACP · stdio / This computer / Local Development. This avoids requesting the restricted custom-agent endpoint merely to open a tooltip.
- ACP shows transport, host for WebSocket, configured cwd and token presence or agent-managed authentication. Managed resolves the saved credential id to its name, host (`https://api.anthropic.com` when no base URL is set) and environment id. Missing folder/configuration data has loading/error copy. No secrets are rendered.
- `src/renderer/src/components/chat/RouterBadge.test.tsx` — classification, redacted domain detail, runtime/configuration states and keyboard tooltip coverage; builder hover/focus issues no configuration request and all three saved engines have explicit labels.

## Configuration

None. No settings, no env vars. `human` needs nothing configured at all — that is the point of it. `coordinator` needs a resolvable chat-mode provider + model.

## Security

- Ownership on every path: `run:send` calls `userActivation.isActivated()` then `chatRepo.getOwned(profileUserId, chatId)`; `chat:set-router` and `chat:update` call `requireActivated()` + `getProfileScopeUserId()` and route through `requireOwnedChat`
- The router value is **validated, not trusted**, on both channels that write it. A stale preload writing `'orchestrated'` would otherwise leave a chat whose router matches nothing and whose messages route to the model by the fallback, silently
- An `addressedAgentId` from the renderer is not authority: it is read only for a `human` chat and only if that agent is attached to it
- The catch-up packet is assembled main-side from rows the owner already has, and names tools and filenames only — never payloads or bytes. Credentials and endpoints stay main-side as before
- `chat_agent_cursors` cascades from both `chats` and `agents`, so no stale rows survive a delete
