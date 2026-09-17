# The Agent Turn — Technical Details

Implementation reference for [The Agent Turn](agent_turn.md). What a turn is *given* — the launcher, the generated config, the binary — is [The Local Engine (technical)](engine_tech.md).

## Read this first if you are working next to the driver

Six things here will produce a silent failure if changed carelessly. Each is argued in [agent_turn.md](agent_turn.md); this is the index.

1. **The replay gate closes before the bind, not after it.** `bindSession` flushes the pre-bind pen *synchronously*, and the pen for a session id can hold the tail of the previous turn
2. **`session/update` is consumed in the transport tap**, before the SDK's closed-union validator sees it. Route it through the SDK and one unknown kind is a silently dropped chunk of a message
3. **The translator hands back the *cumulative* message.** Passing a raw delta to `StreamPartsAccumulator` duplicates every character from the second chunk on, and looks correct in a one-chunk test
4. **`allow_always` is filtered out of the options before an answer is chosen**, never merely deprioritised. One `allow_always` writes a user-global rule in the engine's own store
5. **The abort is re-checked after the process is acquired.** Everything before that awaited; a Stop landing in that window has no session to cancel
6. **A released park is not a decision.** `rejected` covers expiry *and* a turn that ended underneath, and the transcript must not record either as a user's Deny
7. **A turn takes the session's observer down before anything that can produce traffic for it, and arms it again after it unbinds.** The pen keeps traffic only for a session nobody observes. An observer left up through a `session/load` would take the replay and the turn's opening frames. The turn arms it only after unbinding, because a bound turn outranks an observer

## File Locations
### Shared
- `src/shared/localAgentRequests.ts` — the whole request wire contract. `PERMISSION_ID_PREFIX`/`QUESTION_ID_PREFIX` (`:48-49`), `isEngineRequestId()` (`:70`), `questionCallId()` (`:83`, the call a question was raised from, read out of its `toolInput`), `REQUEST_PARK_TIMEOUT_MS` (`:103`), `PermissionReply` (`:380`), `RequestResolution` (`:388`), `LocalPermissionRequest` (`:423`), `parsePermissionRequest()` (`:432`). **Type-only plus pure functions** — imported from main and renderer alike, so it must pull in no runtime dependency. The grant types and matching rules also live here and belong to [Local Agent Permissions](permissions_tech.md), not to this slice
- `src/shared/messageParts.ts` — **no `permission` or `question` part kind, deliberately.** An ask is stored as a `tool` part; see [the convention](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind)
- `src/shared/runEvents.ts` — the stream vocabulary. A parked ask is also *announced* live as `needs_input { resume: 'reply' }` and settled as `input_resolved`, but neither event is persisted, so the part convention stays the only thing a replayed transcript has. `RequestResolution`, which `input_resolved` carries, is declared in `localAgentRequests.ts` for that reason. See [Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md)

#### The no-new-part-kind rule, and the five symbols that are its only enforcement

If you are about to add a `permission` or `question` part kind, these are the symbols that already do the job. There is nothing else — a contributor who cannot find them will add the kind [agent_turn.md argues against](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind).

| Symbol | Where | Role |
|---|---|---|
| `PERMISSION_TOOL_NAME` | `src/shared/localAgentRequests.ts:42` | `'cinna_permission_request'` — the reserved name a permission ask is emitted under. **Deliberately not a name any model would emit:** OpenCode's permission asks are *about* tools (`bash`, `edit`, `webfetch`) and carry the real tool name separately, so naming this after a tool would make an agent's own call to that tool indistinguishable from a request to run it |
| `QUESTION_TOOL_NAME` | `src/shared/localAgentRequests.ts:45` | `'askuserquestion'` — chosen to satisfy the renderer's pre-existing normalising match, so a local question needs no new detection path |
| `isPermissionRequestTool(toolName)` | `src/shared/localAgentRequests.ts:52` | Exact match on the reserved name. The **only** permission detector; used at `MessageStream.tsx:366`, `:621`, `:708` |
| `isAskUserQuestionTool(toolName)` | `src/renderer/src/utils/askUserQuestion.ts:39` | `toLowerCase().replace(/[^a-z]/g,'') === 'askuserquestion'` — the existing normalising match, unchanged by this phase. Used at `MessageStream.tsx:392` |
| `isEngineRequestId(toolId)` | `src/shared/localAgentRequests.ts:70` | Separates a **live engine address** (`per_*` / `que_*`) from a cloud agent's question id, which is what makes a persisted local request block render read-only. `MessageStream.tsx:365` |

Emission side: `acpMessages.ts` writes `PERMISSION_TOOL_NAME` into the ask part's tool-name metadata (`askPermission`, `:206`) and `QUESTION_TOOL_NAME` in `askQuestion` (`:255`). Both put the desktop-minted request id in the tool-id field, which is *also* the address a reply is posted to. Asserted in `acpMessages.test.ts` and end to end in `acpDriver.test.ts`.

Both asks are filed beside the call that raised them. `askPermission` takes the call from `LocalPermissionRequest.callId`. `askQuestion` takes an optional `callId`, which `answerElicitation` reads off the elicitation's `toolCallId` when it is a non-empty string. It files the part under that call's message ahead of the request's earlier message or the current one, and writes `{questions, callId}` into the tool input. **Only the `callId` in the input matters downstream.** The filing mirrors `askPermission` and changes nothing saved or rendered: `StreamPartsAccumulator` flattens every ACP message into one list in arrival order, and `accumulator.snapshotParts()` is what `finish` returns. `pairCommandTools` folds the Claude adapter's `AskUserQuestion` call and its result only when they share a saved row with the question naming them. They always do: `saveTurnRows` (`a2aStreamingService.ts`) splits a turn's parts only at a steer, and `trackToolCall` withdraws steering while any call is in flight, which covers the `AskUserQuestion` call from `tool_call` to completion.

### Main process — `src/main/agents/drivers/acp/`
- `types.ts` — the seams, type-only plus constants: `AcpLaunchSpec` (command, args, whole `env`, `cwd`, `key`), `AcpExit`, `AcpSessionHandlers`, `AcpConnection`, `StartAcpConnection`, `AcpProcessState`, `AcpProcessPool`, `AcpStreamUpdate`, `ACP_PROTOCOL_VERSION` (1), `ACP_START_TIMEOUT_MS` (30 s), `ACP_IDLE_REAP_MS` (2 min), `ACP_STDERR_TAIL_LINES` (40), `ACP_STEER_METHOD` (`_session/steering`) with `AcpSteerRequest` / `AcpSteerResponse`, `ACP_BUSY_REAP_CEILING_MS` (30 min), `ACP_ASYNC_TASK_STOP_METHOD`, `AcpSessionObserver`, and `AcpConnection.observeSession` / `aliasSession` / `stopAsyncTask`. Re-exports `AcpLauncherId` from `src/shared/agentDrivers.ts`, which is where a **stored** value has to live
- `acpConnection.ts` — one child process and the ACP conversation over its stdio: `startAcpConnection(spec, init)`, the transport tap that intercepts `session/update`, the pre-bind holding pen, `bindSession`, `fs/*` and `terminal/*` answering `-32601`, the stderr tail, `steer` (a JSON-RPC request, which rejects like any other when the agent does not implement it; `acpWebSocketConnection.ts` has the same), and `dispose()` killing the process **group**
- `acpProcessPool.ts` — `createAcpProcessPool({start, now?, setTimer?, clearTimer?, idleReapMs?, isBusy?, lastActivityAt?})`: `acquire`, `hold`, `retire`, `held` (a hold or a start in flight — whether a retire now would wait), `status`, `onStatus`, `shutdown`. One entry per agent id, one shared in-flight start per spec key, no supervisor loop. The clock and timers are injected so the reap is testable without waiting two minutes. `isBusy` / `lastActivityAt` defer the reap while [session activity](../session_activity/session_activity_tech.md#reaper-acpprocesspoolts-acppoolts) runs; `acpPool.ts` wires them to the hub
- `acpSessionObserver.ts` — `createSessionObservation(scope, sink, burstMs?)`, `SessionTrafficScope`, `SessionTrafficSink`, `refusingSessionTrafficSink`, `SESSION_TRAFFIC_BURST_MS` (2 s): the between-turn observer, which counts and logs kinds and hands everything to a sink
- `acpFollowUp.ts` — `createFollowUpGate(scope, options)`, `FollowUpGate`, `HeldTraffic`, `HeldHandover`, `deliverHeld`, `refuseHeld`, `FOLLOW_UP_BUFFER_LIMIT` (2,000): what between-turn traffic opens a follow-up, and the buffer until it is taken
- `acpActivity.ts`, `acpActivityStop.ts` — the session-activity provider and the synthesized `Agent` call; see [Session Activity (tech)](../session_activity/session_activity_tech.md)
- `acpDriver.ts` — the driver: `createAcpDriver(deps)`, `respondToAcpAsk`, `folderReadiness`, `AcpFolderView`, `ACP_TURN_CEILING_MS` (80 min: the park window plus 20), `ACP_CANCEL_GRACE_MS` (3 s), `ACP_FOLDER_NOT_FOUND`, `ACP_FOLLOW_UP_QUIET_MS` (10 s), `ACP_FOLLOW_UP_EXITED`, `AcpDriver` (adds `forgetChatSessions` and `activityStopper`), `SessionObservers`, `ArmedTurn`. Module-private `createSessionObservers`, `runFollowUp`, `endsFollowUp`, `observeActivity`, `onConnectionExit`, `runTurn`, `promptWithCancelGrace` (its `onSent` arms the steering window), `TURN_CONTENT` (the update kinds that open it), `advertisesSteering`, `applySetup`, `answerPermission`, `answerElicitation`, `noteModeFallback`, `finish`, `rememberSession` (saves a session id at most once per turn, tracked in `TurnContext.savedSession`), `stopReasonError`, `startFailureMessage`
- `acpMessages.ts` — `AcpMessageStream`: `apply(notification)`, `applyExt(method, params)`, `askPermission`, `settlePermission`, `askQuestion(requestId, questions, callId?)`, `settleQuestion`, `note`, `toolName(toolCallId)`; plus `describeAcpToolCall` and `describeAcpPermission`. Pure — no Electron, no filesystem, no clock
- `acpPermissions.ts` — `toAcpPermissionRequest(launcher, params, toolName)`, `pickPermissionOption(options, decision)`, `mintAcpRequestId(kind)`, and the `OPENCODE_ACTION_BY_KIND` / `OPENCODE_RESOURCE_FIELDS` tables. Claude keeps its own tool names through `claudePermissions.toClaudePermissionRequest`, unchanged from the in-process runner
- `acpQuestions.ts` — `toInputQuestions(params)` → `AcpElicitationForm | null`, `toElicitationContent(form, answers)`. Reads Claude question/custom fields and Codex original-ID fields with `_meta.codex.isOtherAnswer` companions; maps a generic MCP elicitation as best it can; an unmappable one is `decline`, never a failed turn
- `acpLaunchers.ts` — the only engine-specific code left on the turn path. See [engine_tech.md](engine_tech.md#srcmainagentsdriversacpacplaunchersts--the-opencode-half)
- `testSupport/fakeAcp.ts`, `testSupport/fakeAcpAgent.mjs` — a scriptable ACP agent, run as a real child process over real stdio. `FakeAcpScript` says what `session/prompt` emits; a `permission` or `elicitation` step **blocks until the client answers**, which is what parks a turn. A `steer` handler script answers `_session/steering` (`injected` unless the script says otherwise), and an `awaitSteer` step blocks until a steering request arrives
- `__fixtures__/{opencode,claude}/*.json` — distilled from the spike recordings (which live outside this repository): a text turn, a tool call, a permission ask, a mode update, an MCP tool call, `available_commands`, a `session/load` replay, and the Claude adapter's tool-name metadata

### Main process — elsewhere
- `src/main/agents/drivers/index.ts` — production wiring: `acpProcessPool` (exported, so `will-quit` can reach it), `acpLaunchers` (opencode, claude, codex, custom; no Gemini implementation), `acpDriver`, `driverFor`, `respondToOrphanedAsk`, readAcpRuntime/readAcpFolder and captured session/grant closures, `electronNodeRuntime`, `claudeAdapterEntry`
- `src/main/index.ts` — `will-quit` first calls `a2aStreamingService.saveInFlight()`, synchronously and ahead of every kill, so a turn the kill ends keeps what it streamed ([streaming pipeline](../agents/streaming_pipeline.md#what-a-direct-turn-keeps-when-it-never-returns)). The turn's in-flight marker stays, and at the next launch `interruptedTurnService.finalizeLeftovers()` settles it: `acp` has no recoverer, so every ACP marker gets the interrupted error row and a failed result ([Interrupted Turn Recovery](../turn_recovery/turn_recovery_tech.md)). Then `void acpProcessPool.shutdown()`, **fired and not awaited**: Electron does not await that handler, so `shutdown` disposes every *running* process before its first `await` and only then waits out the starts in flight. A single pass that waited on each start before killing anything yielded on the first entry and left every running agent alive
- `src/main/agents/drivers/driver.ts` — `RunInput.runScope`, `FollowUpScope`, `FollowUpRequest` (`run`, `wanted`, `abandon(reason, {keepListening?})`), `FollowUpOpener`
- `src/main/services/followUpTurnService.ts` — `followUpTurnService.open(request)`, `FOLLOW_UP_BUSY_POLL_MS` (1 s), `FOLLOW_UP_MAX_WAIT_MS` (80 min): the guards, the wait for a busy chat, and the run
- `src/main/services/chatSessionRelease.ts` — `forgetChatSessions` / `releaseChatSessions`, which `chatService` calls when a chat is trashed or stops answering to an agent
- `src/main/services/runExecutionService.ts` — `runScope` passed into every chat turn (`runAgentTurn`, `resendAgentTurn`); `remainingRunRequests(chatId, runId)`, shared by `start`'s close and the follow-up run
- `src/main/services/interruptedTurnService.ts` — `interruptedNoticeFor(marker)`, `INTERRUPTED_FOLLOW_UP` for a marker with no user row
- `src/main/agents/drivers/pendingRequests.ts` — the module-level ask registry, unchanged. `REQUEST_PARK_TIMEOUT_MS` is 60 minutes
- `src/main/agents/drivers/acp/claudePermissions.ts`, `claudeAuth.ts`, `claudeEnv.ts`, `claudeAgents.ts` — what survives of the Claude runner: the permission vocabulary, the login probe, the stripped child environment and the folder's own subagent definitions. All four are now launcher inputs
- `src/main/ipc/run.ipc.ts` and `src/main/services/runExecutionService.ts` own command/watch/cancel and dispatch. `src/main/ipc/agent_a2a.ipc.ts` retains agent answer, pending-request and session channels; custom registration validation precedes the folder orphan fallback.
- `src/main/services/a2aStreamingService.ts` — the direct-chat wrapper every turn passes through, and the A2A implementation behind it. `RunAgentTurnInput` / `RunAgentTurnResult` are the shared shapes; its `catch` does not trust a driver to keep its own contract
- `src/main/services/a2aAsMcpProvider.ts` — the orchestrated-tool call site: `driverFor(this.agent).run(…)`. A folder agent works as an orchestrated tool with no change of its own
- `src/main/services/localAgents/turnLock.ts` — `withLock()`, `isLocked()`. `anyHeld()` still exists for the folder watcher; **no engine-level caller is left**
- `src/main/services/localAgents/desktopStateService.ts` — the durable per-folder session copy and the permission grants
- `src/main/db/agents.ts` — agentSessionRepo.getByChatAndAgent/upsert, the sole driver-neutral repository over the unchanged physical a2a_sessions table
- `src/main/agents/streamPartsAccumulator.ts` — reused verbatim; the ACP translator only produces `MessageLike` / `PartLike` with its metadata keys
- **Gone:** `services/agentTurn/{runner,localAgentTurnRunner,claudeAgentTurnRunner,engineEventBus,engineEvents,turnStream,sseParser,claudeMessages}.ts` and `agents/drivers/{folderDriver,opencodeDriver,claudeDriver}.ts`

### Preload
- `src/preload/index.ts` — `window.api.agents.answerRequest({requestId, reply?, answers?})` and `window.api.agents.pendingRequests(chatId)`. Unchanged by this phase

### Renderer
- `src/renderer/src/hooks/useAgentRequests.ts` — `useAgentRequests(chatId, isStreaming)` → `{pending, isPending, answerPermission, answerQuestion}`
- `src/renderer/src/components/chat/MessageStream.tsx` — the hook mounted; `renderRequestBlock` decides an engine id's liveness from the registry poll **or** the stream's `needs_input`, with *settled* winning
- `src/renderer/src/components/chat/PermissionRequestBlock.tsx`, `AskUserQuestionBlock.tsx` — the two widgets
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — the panel that reports the engine an agent runs on. It shows a **binary**, not a process; the per-agent process state is the pool's and is not on this screen

### Tests
- `src/main/agents/drivers/acp/acpDriver.test.ts` — the turn path end to end against the fake agent, plus `describeDriverContract('acp', …)`
- `src/main/agents/drivers/acp/acpConnection.test.ts` — framing, routing by session id, the pre-bind pen, `-32601` for `fs/*` and `terminal/*`, unknown update kinds surviving, the stderr tail, and disposal
- `src/main/agents/drivers/acp/acpProcessPool.test.ts` — lazy start, one shared start, the spec-key replacement, holds, the injected reap clock, restart-on-next-turn, `shutdown`, the busy deferral and its ceiling
- `src/main/agents/drivers/acp/acpSessionObserver.test.ts` — counting without content, the refusing default sink, a closed observation handing nothing on
- `src/main/agents/drivers/acp/acpFollowUp.test.ts` — what opens, what is dropped, the buffer and its limit, take/release/handOver/abandon/close, the process hold
- `src/main/services/followUpTurnService.test.ts` — the guards, the wait behind a busy chat, `wanted()` turning false, one chat at a time, the rows and the recorded result
- `src/main/services/chatService.setRouter.test.ts`, `src/main/services/interruptedTurnService.test.ts` — a trashed or deleted chat's activity forgotten, and old sessions released on a router change or a rebind; the follow-up notice for a marker with no user row
- `src/main/agents/drivers/acp/acpMessages.test.ts` — the fixtures folded into parts: tool names, the text/tool ordering rule, unknown kinds ignored
- `src/main/agents/drivers/acp/acpPermissions.test.ts`, `acpQuestions.test.ts`, `acpLaunchers.test.ts`, `shutdown.test.ts` (that `will-quit` really reaches the pool, and calls `saveInFlight()` before the pool shutdown and before any `await`, read the way `registration.test.ts` reads the IPC modules)
- `src/main/agents/drivers/golden.a2a.test.ts` with `__golden__/a2a/` — the one golden suite left
- `src/main/agents/kindBranches.test.ts` — the kind-branch ratchet
- `src/renderer/src/components/chat/PermissionRequestBlock.test.tsx`, `src/renderer/src/utils/localAgentRequests.test.ts`
- `src/renderer/src/components/chat/MessageStream.questionEcho.test.tsx` — which `AskUserQuestion` results a question folds away, and which it leaves
- `e2e/specs/run-events.spec.ts` with `e2e/fixtures/fakeAcpEngine.ts` — the same fake agent, driven through the built app
## Database Schema

**No new table and no new column.** Session continuity reuses `a2a_sessions` (seam 9): one row per `(chat, agent)`, and a folder agent's engine session id goes in **`context_id`**. Columns stay A2A-named on purpose — `agent:get-session` reads `context_id` to decide a chat is an agent chat, so a parallel table would mean teaching every existing reader about it. `task_id` and `task_state` are written `null` for a folder agent.

Uniqueness is enforced in `agentSessionRepo.upsert` by select-then-insert; there is no unique index.

Both copies are written through `runtime.saveSession`, as soon as `session/new` answers for a fresh session and in `finish` for a loaded one; `rememberSession` skips an id this turn already saved, so a fresh session is written once.

The second, durable copy is `sessions[chatId] = {sessionId, updatedAt}` in the agent folder's `app-data/desktop.json`, written through `desktopStateService.patch`. Invariant 1 makes the SQLite row a cache, so a failure to write the folder copy is logged and the turn continues (`src/main/agents/drivers/index.ts:145-158`).

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| run:start / run:watch | RunSendPayload command / owned chat watch | Main executor dispatches independently of the selected renderer view. Lower-level run:send remains available through the same executor. |
| `agent:cancel-message` | `(requestId) → {success}` | Unchanged. Reaches the runner through the turn's `AbortSignal` |
| `agent:answer-request` | `({requestId, reply?, answers?}) → {ok, reason?, remembered?}` | Activation-gated, chat-ownership checked **before** the request is consumed, and the answer shape validated against the engine's own enum. `remembered` is present only for a permission answered `always`, and says whether the grant reached disk — see [permissions_tech.md](permissions_tech.md#ordering-constraint-on-the-answer-path) for the synchronous-window constraint that makes writing it before `resolve()` safe |
| `agent:pending-requests` | `(chatId) → {requestId, kind}[]` | New. Synchronous map read; returns `[]` for a chat the caller does not own |

Three properties of `agent:answer-request` are deliberate and each closes a specific lie to the user:

- **It returns an outcome as data, never a rejection.** `ipcMain.handle` serialises a rejection to message + stack and `contextBridge` re-clones it, so a renderer branch on `err.code` silently never fires (`src/main/ipc/_wrap.ts`)
- **Ownership is read with `pendingRequests.owner()`, not `resolve()`.** `resolve` settles as a side effect, so checking ownership from its return value would have already delivered the answer by the time the check failed (`pendingRequests.ts:208-219`)
- **The answer is validated against the engine's enum, not against TypeScript's belief about it.** A renderer bug or a stale preload could otherwise send `'allow'`, or a flat `string[]`, and the first anyone would know is a 400 the runner logs at warn *after* the dialog told the user their answer landed


## Services & Key Methods

### `src/main/agents/drivers/acp/acpDriver.ts`

`createAcpDriver(deps)` takes its whole world by injection — `pool`, `launcher(id)`, readRuntime (captured metadata, validation, sessions and grants), `registerRequest`, `resolveRequest`, `withLock`, plus `turnCeilingMs` / `cancelGraceMs` for tests — so the driver runs with no process, no database and no Electron.

| Method | Behaviour |
|---|---|
| `capabilities(row)` | `capabilitiesFor(row)`: pure, row-only, and the same answer every time. Reads the **stored** launcher, because a row is all it has |
| `readiness(userId, row, options)` | The folder's own state first (`folderReadiness`), then the launcher's rungs — asked about the launcher the **folder** names, so an agent just switched to Claude in the Runtime card is answered about Claude. Never throws |
| `run(userId, row, input)` | Folder → `enabled` → readiness → launcher → `plan()` → `withLock` → `runTurn`. Every refusal is a `result.error`; `turnLock.acquire`'s throw is caught here |
| `respond(ask, resolution)` | Synchronous. Writes an *Always allow* grant **first**, then settles the park — the resolution has to carry `remembered` into the transcript, so the write cannot move after the resolve |

`runTurn` in order: build the translator and the accumulator → offer `input.registerSnapshot` a reader returning copies of the accumulator's parts and notices and of `ctx.steers` → arm the ceiling → take a pool hold → subscribe to the abort → **re-check `signal.aborted`** (a listener added to an already-aborted signal never fires) → `pool.acquire` → build the handlers → `session/load` behind the replay gate, or `session/new` → bind (a fresh session is saved here, `rememberSession`) → `applySetup` → **re-check the abort** → `promptWithCancelGrace` (its `onSent` arms steering; the `session/update` handler opens it at the first `TURN_CONTENT` update after the replay gate, and `trackToolCall`, run just before, withdraws and re-offers it while tool calls are in flight; `askAgentToStop` closes it first, and `settleSteering` in the prompt's `finally` closes it and waits up to `cancelGraceMs` for requests already sent) → `finish`. The `finally` clears the ceiling, releases the hold, closes the ask gate and sweeps every remaining park.

`promptWithCancelGrace` races the pending prompt against a timer that **only starts once a cancel has been asked for**: nothing is bounded while a turn is merely running, because an agent that takes ten minutes to think is working. A grace that expires retires the process and returns null; the pending promise is swallowed so a turn nobody is reading no longer reports an unhandled rejection.

### `src/main/agents/drivers/acp/acpConnection.ts`

`startAcpConnection(spec, init)` spawns with `spec.env` **verbatim** (no `process.env` spread anywhere in the file), `detached: true` on POSIX so the child leads its own process group, and `stdio: ['pipe','pipe','pipe']`; then completes `initialize` within `ACP_START_TIMEOUT_MS` or fails with a readable message. `dispose()` signals the group (`process.kill(-pid)`; `taskkill /T` on Windows) and resolves once the process has exited.

`bindSession(sessionId, handlers)` returns an unbind. Traffic for an unbound session is penned — up to 500 notifications for 10 s — and drained in order on bind; a permission or elicitation request for a session nobody binds in that window is answered `cancelled`.

`observeSession(sessionId, observer)` routes a session's traffic to an observer while no turn is bound to it; a bound turn outranks it. `aliasSession(child, parent)` routes a subagent's own session to whoever hears the parent ([Session Activity (tech)](../session_activity/session_activity_tech.md#child-session-routing-acpclientts)).

### `src/main/agents/drivers/acp/acpProcessPool.ts`

`acquire(agentId, spec, init)` returns the live connection when its spec key still matches, else starts one; concurrent callers for the same agent and key share one start. `hold(agentId)` returns a release and suspends reaping. `retire(agentId)` stops the process now if nothing holds it, else on the last release. `status` / `onStatus` are what an agent page would render. A process that exited is **not** restarted here — the next `acquire` starts a fresh one.

### `src/main/agents/drivers/pendingRequests.ts`

Unchanged, and still the one door: `register({requestId, chatId, agentId, kind, request?})` → `{answered, cancel}`, `resolve`, `owner`, `listForChat`, `drop`. The ACP driver's park **is** the unresolved `answered` promise, and the blocked JSON-RPC request is what waits on it.
## Between-turn listening and follow-up turns

### `createSessionObservers` (`acpDriver.ts`)

One `ObservedSession` per `(connection, sessionId)`, also indexed by chat.

- `arm(connection, scope, armed)` — called from `runTurn`'s `finally` through `listenBetweenTurns()`, after `unbind`. It arms the session the turn ended on, plus the remembered session it suspended unless `rememberedGone`. Nothing is armed on a dead connection. The sink the observer feeds is `heard`: `feed.observe()` (activity) first, then the gate's sink, or the plain activity sink when follow-ups are off. The session's `knownToolCalls` set is per connection and grows with `ArmedTurn.toolCalls` (every id the turn folded, synthesized ones included)
- `suspend(connection, sessionId)` — called right after the handlers are built and before `session/load` or the remote reuse. It returns the gate's `handOver()`. `runTurn` replays it once the session is this turn's again (after the load), refuses it if a different session resulted, and in the `finally` gives it back to the re-armed observer (`giveBack`) when the turn left before replaying
- `forgetChat(chatId, agentId?)` — closes the activity feeds and drops the observers. Installed as the chat-session forgetter in `drivers/index.ts`
- A connection's `exited` drops every observer on it; dropping closes the observation and the gate

### `createFollowUpGate` (`acpFollowUp.ts`)

The state is `idle → pending → running → idle`, or `closed`.

- **Idle.** An ask triggers. An update is classified: `opens` triggers; `late` (a `tool_call_update`, or a `tool_call` in `knownToolCalls`) and `synthetic` (a chunk without `messageId`) are dropped at debug level; `other` goes to `options.activity`. A trigger takes `options.hold()` (the pool hold), holds the item and calls `options.open()`
- **Pending / running.** Everything is held; updates past `limit` are counted and logged when the buffer resets
- **`take()`** (pending → running) releases the pool hold, because the turn holds the process itself, and returns the buffer
- **`release(leftover)`** (running → idle) re-classifies the leftover and anything held meanwhile, and may trigger again
- **`handOver()`** closes the gate. If a follow-up was running, its close listeners end it, because the user's turn replaces its binding
- **`abandon(reason, level)`** refuses asks, drops updates and goes idle. **`close()`** does the same and ends a running follow-up

### The factory in `createAcpDriver`

A gate is built only when `deps.openFollowUp` exists and `ArmedTurn.runScope` does. `open` calls `openFollowUp({chatId, agentId, driverId: 'acp', scope, run, wanted: () => gate.pending, abandon})`. `abandon` without `keepListening` also drops the observer. Production `openFollowUp` imports `followUpTurnService` lazily, because the service reaches the driver module back through the run service, and abandons the request if the import fails.

### `followUpTurnService.open` (`followUpTurnService.ts`)

Requests are chained per chat. `openOne` loops until the run is adopted:

1. Stop if `wanted()` is false
2. `refusal()`: owned under `scope.profileUserId`, not trashed, and `rootAgentId === agentId`, or a `human` router with the agent in `chatOnDemandAgentRepo`
3. Await `activeRunsByChat` if the chat has a run
4. Try `adopt`. A throw means a task runner, a handoff or a race; it retries every `FOLLOW_UP_BUSY_POLL_MS` up to `FOLLOW_UP_MAX_WAIT_MS`, then abandons with `keepListening`

`adopt` is `runExecutionService.adopt(scope, {chatId, agentId, runId, observe: inboxService.recordRunEvent}, drive)`. `drive` runs `a2aStreamingService.streamToAgent` with `run: request.run`, a marker whose `userMessageId` is `null`, and `onCompleted` advancing `chatAgentCursorRepo` to `messageRepo.lastId`. Then it posts a terminal event if none was seen, turns `completed` with open asks into `needs_input` (`remainingRunRequests`), and calls `recordTurnResult`.

### `runFollowUp` (`acpDriver.ts`)

It builds a `TurnContext` with `NO_OBSERVERS` and `savedSession` set to the session, so it arms and records nothing. It uses its own `AcpMessageStream`, accumulator, snapshot registration and `SubagentFrames`. It takes `pool.hold`, not the turn lock.

1. Nothing to do on a dead connection or a gate that is no longer pending
2. Otherwise it binds and calls `gate.take()` synchronously, then delivers the held items in order with `deliverHeld` (an ask is parked before the next update is folded)
3. It ends on `endsFollowUp` (a `usage_update` with non-null `cost`), `gate.onClose`, `onConnectionExit`, the grace after a Stop, or the ceiling. The quiet timer (`followUpQuietMs ?? ACP_FOLLOW_UP_QUIET_MS`) runs only when the launcher lacks `endsTurnsWithCostedUsage`, and it ends the turn only with no open tool call and no parked ask
4. `end()` unbinds at once, so later traffic is the observer's again. Items not yet delivered become `leftover` for `gate.release`
5. Stop: parks are released, `session/cancel` is sent, and the grace expiring ends the turn without retiring the process. The ceiling expiring retires it
6. `finish(ctx, accumulator, null, error, …, canceled)`: the error is `ceilingMessage()` at the ceiling, `ACP_FOLLOW_UP_EXITED` on an exit that was not a Stop, and none otherwise

`onConnectionExit` keeps one `exited.then` per connection and detachable listeners, so finished follow-ups do not stay reachable until the process exits (`exitListenerCount` is for tests).

### Launcher flag

`AcpLauncher.endsTurnsWithCostedUsage` is `true` on the Claude launcher only.

## Data Shapes

### `RunAgentTurnInput` → `RunAgentTurnResult`

The shared turn primitive (`a2aStreamingService.ts:141` and `:185`). Two fields are widened to optional for a folder agent (`endpointUrl`, `cardUrl`), and the `onEvent` sink takes `RunEvent`.

**In:** `chatId`, `agentId`, `agentName`, `endpointUrl?`, `cardUrl?`, `accessToken?`, `wireContent`, `fileIds?`, `isCinnaTokenAuth?`, `signal: AbortSignal`, `onEvent?`, `onClient?`, `onTaskId?`.

**Out:** `text` (compact, for an orchestrator LLM), `parts: MessagePart[]` (full fidelity, for the UI), `notices: AccumulatedNotice[]`, `contextId?`, `taskId?`, `taskState?`, `error?: {message, raw, code?}`, `steers?: TurnSteer[]` (`{afterPart, text}` for each user message the turn took in, in arrival order).

The ACP driver fills `text`, `parts`, `notices`, `contextId` (the ACP session id), `steers` and `error`. It never sets `taskId` / `taskState` — those are A2A task bookkeeping — and it ignores `onClient` / `onTaskId`, which exist for the A2A SDK's cancel path (a local cancel goes to `POST …/interrupt` instead). `fileIds` and `isCinnaTokenAuth` are inert on this path.

### What replaced `EngineEvent` and `TurnStreamUpdate`

There is no engine-event vocabulary any more. The wire type is the SDK's `SessionNotification`, and what the translator hands back is `AcpStreamUpdate` (`types.ts`):

`{message?, commands?, modeId?, title?}` — the cumulative message to re-ingest (when this notification changed one), the agent's slash commands from `available_commands_update` (replace semantics), the mode from `current_mode_update` or a `config_option_update` for `mode`, and the session title from `session_info_update`. Every field is optional and a notification the translator does not recognise produces an empty update rather than a throw.

Asks are not on this type at all: a permission or elicitation request arrives as a **blocking request** on the connection, not as a notification, so the driver answers it directly and asks the translator only to write the ask and its decision into the message.

## Configuration

| Constant | Where | Value | Why |
|---|---|---|---|
| `ACP_TURN_CEILING_MS` | `acpDriver.ts` | 80 min (`REQUEST_PARK_TIMEOUT_MS` + 20 min) | Not a model timeout — a ceiling on *never settling*. Generous because a ceiling that fires on a working turn is worse than none. Overridable per driver instance for tests |
| `ACP_CANCEL_GRACE_MS` | `acpDriver.ts` | 3 s | How long an aborted turn waits for the agent to answer `session/cancel`. Far longer than an acknowledgement takes, far shorter than a user's patience with a Stop button. Expiry **retires the process** |
| `ACP_IDLE_REAP_MS` | `types.ts` | 2 min | An idle `opencode acp` holding a session is 311 MB; a cold start is about a second. Two minutes is that trade, measured |
| `ACP_START_TIMEOUT_MS` | `types.ts` | 30 s | Spawn to `initialize`. Beyond it the start is a failure with a readable message rather than a turn that hangs |
| `ACP_PROTOCOL_VERSION` | `types.ts` | 1 | v1 is stable; v2 (draft) removes client `fs/*` and `terminal/*`, which this client never declared |
| `ACP_STDERR_TAIL_LINES` | `types.ts` | 40 | What a connection keeps of stderr for an error message |
| `REQUEST_PARK_TIMEOUT_MS` | `src/shared/localAgentRequests.ts` | 60 min | Bounds an abandoned dialog. The turn holds its agent's lock while parked |
| `ACP_FOLLOW_UP_QUIET_MS` | `acpDriver.ts` | 10 s | The end of a follow-up turn on an engine with no end marker, with no tool call open and no ask parked. Overridable (`followUpQuietMs`) for tests |
| `FOLLOW_UP_BUFFER_LIMIT` | `acpFollowUp.ts` | 2,000 updates | What a session holds while its follow-up is being opened. Asks are never counted or dropped |
| `FOLLOW_UP_MAX_WAIT_MS` | `followUpTurnService.ts` | 80 min | How long a follow-up waits for a busy chat; matches the turn ceiling |
| `SESSION_TRAFFIC_BURST_MS` | `acpSessionObserver.ts` | 2 s | One log line per burst of between-turn traffic |
| `POLL_MS` | `useAgentRequests.ts` | 700 ms | Renderer poll while streaming. One synchronous main-process map lookup per tick |

Gone with the runners: `ENGINE_READY_MS` (a cold shared server could answer its health check 30–60 s before it could address an agent — there is no shared server and no health check), `RECONNECT_DELAYS_MS` (no socket to reconnect), and `AUTO_REPLY_RETRY_MS` (an automatic allow is now the *return value* of the blocking request, so there is nothing to lose and nothing to retry).

## Security

- **Invariant 4 — no secret crosses to the renderer.** A credential reaches an engine only as the `CINNA_ENGINE_KEY_…` variable its generated config names, in the child's environment. There is no address and no password to withhold any more; the launch spec's `key`, which *is* logged, is a digest of the environment rather than the environment
- **No engine response is ever logged wholesale.** The rule outlived OpenCode's HTTP `/config`, which returned the resolved config with keys substituted
- **The child's environment is constructed, never inherited.** `spawn` receives `spec.env` verbatim. For Claude that environment is `buildClaudeEnv`'s: the shared child allowlist, then stripped by name of every API key, auth token, base URL, third-party-provider switch and `CINNA_ENGINE_KEY_*`
- **The child leads its own process group**, and app quit kills the group — otherwise a `claude` (~260 MB) outlives the app that started it
- **Chat ownership is checked on both request channels** with `chatRepo.getOwned(getProfileScopeUserId(), chatId)` **before** the request is consumed, and both are activation-gated
- **Answer shapes are validated**, not trusted from the renderer: a wrong shape is refused before it reaches a driver
- **A persisted request block is read-only.** `isEngineRequestId` separates a live desktop-minted address (`per_*` / `que_*`) from a cloud agent's question id
- **The permission tool name is reserved and un-model-emittable** (`cinna_permission_request`), so an agent's own call to `bash` or `edit` can never be mistaken for a request to run one
- **`allow_always` is unreachable**, by filtering rather than by ordering

## Testing notes

**The driver's suite drives a real child process.** `testSupport/fakeAcpAgent.mjs` is a small Node program speaking enough ACP to run the contract: `initialize`, `session/new`, `session/load` with a scripted replay, `session/set_mode` and `set_config_option` (including refusing one), `session/prompt` emitting scripted updates, blocking `session/request_permission` and `elicitation/create`, `session/cancel`, hangs, and an exit on start. So the framing, the ordering and the blocking are real; only the agent's judgement is scripted.

What that arrangement can prove, and what it cannot:

- **Proved:** the replay drop, the pre-bind pen, an unknown update kind surviving, the park/answer/release cycle in all four exits, the cancel ordering (parks before the notification) and its grace, the spec-key replacement, the reap, and every refusal's wording
- **Not proved, and checked by hand instead:** that killing the process group takes the agent's own children with it. Verified against the real Claude adapter — node plus its `claude` child before dispose, neither after
- **Not proved at all:** Gemini CLI, which has no launcher; live Codex model turns and sandbox/reviewer decisions; and the *shape* of a real engine's failure when a remembered session is gone, seen only on OpenCode. The [Codex adapter suite](codex_engine_tech.md#verification-and-limits) exercises native request/response translation against a scripted app-server peer

**Timers are injected, not waited on.** The reap window is two minutes and the park timeout sixty; a suite that waited for either would not be written, so the pool takes `setTimer`/`clearTimer`/`now` and the driver takes `turnCeilingMs`/`cancelGraceMs`. Each test asserts the *delay against the exported constant* rather than against a number copied into the test.

## What is not verified

- **`session/load` has been exercised against the real OpenCode**, where the replay was recorded, and against the fake. The Claude adapter's own load path is covered by a fixture rather than by a live run
- **A turn against a model the engine cannot drive fails at `session/prompt`**, as a JSON-RPC error, rather than being refused up front. The pre-flight that used to catch it went with the HTTP runner; the failure is late but loud, which is what the guard was originally protecting against
- **Interleaving of asks with text** — whether a permission can arrive before the first chunk, and how a parked ask interleaves with deltas — is covered by fixtures in both orders, but only the OpenCode order has been watched live
- **The generic e2e question path stands in for Claude.** OpenCode has no question path over ACP, so `run-events.spec.ts` scripts the fake agent to send an elicitation and says so. `e2e/specs/codex-engine.spec.ts` additionally exercises the production Codex launcher and real adapter with a scripted native question, cancellation and resume after app restart

## Characterization tests

These pin what the drivers and the renderer's stream handler **currently do**, not what they should do, so a refactor can show it changed nothing it did not mean to.

### Golden streams

- **One golden suite is left**, `src/main/agents/drivers/golden.a2a.test.ts` with `__golden__/a2a/`. The OpenCode and Claude suites went with their runners
- **They were diffed by content before deletion**, not merely deleted: all 32 cases reduced to their final text, part kinds, tool names, asks and notices, each matched to where the behaviour is asserted now. 26 map straight across; three are gone by construction (an SSE drop healed by a durable cursor, a shared server that could be cold, a mid-turn engine restart); and three that were **missing** are now covered in the ACP suite — an explicit Deny, an ask arriving after the agent has already replied (the "Stream closed" bug this phase fixes, kept as a named regression), and the notice that says the CLI fell back from automatic approvals
- **Data** for the surviving suite: `<scenario>.fixture.json` (input), `<scenario>.expected.json` (`{events, result}`), and an `effects` sidecar. Shared plumbing is `__golden__/harness.ts`, whose `normalise` turns wall-clock keys into `<time>` and minted ids into `<label#n>` in order of first appearance
- **Expectations are JSON compared with `toEqual`, never Vitest snapshots.** A snapshot rewrites itself under `-u`, and a refactor that changes the stream is exactly when someone reaches for `-u`. `GOLDEN_WRITE=1` writes a *missing* file only and the test still fails on that run, naming the path
- **`_notes`** (a string array at the top of any expectation) is never compared. It is where a pin that looks wrong says why it was kept

### The driver contract

`src/main/agents/drivers/__golden__/driverContract.ts` — `describeDriverContract(name, makeSubject, options)`, used by golden.a2a.test.ts, acpDriver.test.ts, customLauncher.contract.test.ts and managedDriver.contract.test.ts. Their subjects reach the driver through `driver.run(userId, row, input)`, the call production dispatches to, with the row and small world from `__golden__/driverWorld.ts`.

What it asserts for every driver:

- `run` never rejects, and every failure is `result.error` with a non-empty `message` and `raw`
- The first `onEvent` is never `done` or `error`
- On abort the turn settles by itself and emits nothing further, and carries `error` or `taskState: 'canceled'`
- A parked ask is registered exactly once and released on answer, reject, abort and timeout — the timeout through the registry's real timer, shortened
- A parked ask is **announced** exactly once (`needs_input`, `resume: 'reply'`, of the registration's kind, before anything is answered) and settled exactly once (`input_resolved`) while the turn is open
- A2A has no `parks()`, because `input-required` ends its turn instead of parking. Main persists its `needs_input { resume: 'next_message' }` as an Inbox continuation; streamed/nonstreaming task responses share this behavior. The row survives restart and acceptance starts another driver turn on the saved A2A context. ACP reply parks still expire with the process. See [the Inbox](../../jobs/tasks/inbox.md).
- A session id the turn produces reaches `saveSession`, and the next turn on the same chat gets it back through `readSession`
- `capabilities(row)` is the same answer on every call, and a caller editing the object it was handed cannot change the next answer
- `readiness` resolves — never rejects, never throws — with a state this build knows and a sentence when it is not `ok`, whatever its dependencies do
- `respond` to an ask nothing is waiting on answers `{delivered: false}` and writes no grant

**A clause a driver breaks must be explicit.** The old A2A failure/cancellation and ACP abort-result exceptions have been removed after fixes. A2A omits six live-park clauses because its next-message asks end a turn; folder ACP, custom ACP and Managed execute every common clause. Managed answers use the real asynchronous registration/acceptance/commit path; ACP answers use the captured synchronous driver runtime. Root request-id and done/error events belong to the wrapper, not the driver contract.

### Kind-branch ratchet and receiver-side events

- `src/main/agents/kindBranches.test.ts` counts literal comparisons on an agent's `source`, `engine`, `kind`, job `type` and `providerType`, plus calls of the retired helpers. **Each category must equal its entry in `LIMITS`, not merely stay under it** — a change that removes branches lowers the limit in the same commit, so freed headroom cannot be spent later without a reviewer seeing it. `src/main/agents/drivers/` and four sync files are allowlisted; the count runs in Node, not shell `grep`. Full account: [Agent Drivers — Technical Details](../drivers/drivers_tech.md#the-kind-branch-ratchet)
- `src/renderer/src/hooks/useChatStream.events.test.tsx` feeds every `RunEvent` variant through `useRunEventHandler` in an agent table and an LLM table, pinning exactly which chat-store fields each one moves

The old services/agentTurn directory is gone. The shared pending registry and A2A golden contract live under agents/drivers; the surviving Claude launcher helpers live under agents/drivers/acp. This is a module relocation with one registry identity, not a new answer-delivery protocol.
