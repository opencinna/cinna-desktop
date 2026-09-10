# The Agent Turn Runner — Technical Details

Implementation reference for [The Agent Turn Runner](agent_turn.md). The engine's HTTP and event contract is **not** restated here — see [The OpenCode Engine Contract](opencode_contract.md), which records what was watched against the real binary and what was not.

Path convention as in [engine.md](engine.md): `src/...` is this repository; `app-data/desktop.json` is inside an agent folder; `/api/...` is a path on the local engine, reachable only through `engineManager.request`.

## Read this first if you are working next to the runner

Six things here produce a silent, green-suite failure if changed carelessly. Each is argued in [agent_turn.md](agent_turn.md); this is the index.

1. **The subscription is opened and awaited *before* the prompt is posted.** `src/main/services/agentTurn/localAgentTurnRunner.ts:510-516`. The global stream takes no cursor, so events emitted before the socket is live are gone forever. Recorded call order alone cannot catch a regression here — `subscribe()` issues its transport call synchronously, so only a socket that does not resolve in a microtask distinguishes the two orderings (this is exactly the mutation that survived, see `localAgentTurnRunner.test.ts:404`)
2. **`TurnStream` maintains the *cumulative* message and hands the whole thing back.** `turnStream.ts` — `appendText()` (`:346`) and `setText()` (`:369`). `StreamPartsAccumulator` computes `text.slice(prior.length)` itself; feeding it a raw engine delta duplicates every character from the second chunk onward — and passed 19/19 assertions when it was wrong
3. **Termination is the default; continuation is the enumerated exception.** `turnStream.ts:141-169`. `finish` is an unconstrained string in the OpenAPI document, so a `=== 'stop'` test hangs the turn on any other terminal value. A hang holds the per-agent lock for the life of the app and blocks engine reconciles for *every* folder agent
4. **`onClosed` is not `onDisconnect`.** `engineEventBus.ts:79-91`. A close means the session id died with the process; treating it as a disconnect waits for a reconnect that cannot come
5. **The `enabled` gate exists only at `localAgentTurnRunner.ts:260`.** `collectEngineAgents` (`src/main/engine/engineConfigSource.ts:130`) does not consult it — by design, so a disabled agent still gets a config entry and a prompt file on disk. Delete the check and a disabled agent is chattable. It is an obligation Phase 5 explicitly handed to Phase 6, and it is pinned by the named mutation "remove the `enabled` check" → `localAgentTurnRunner.test.ts:295` (mutation table, `:1577`)
6. **No engine response body is ever logged.** `localAgentTurnRunner.ts` — `readList` (`:876`) and `post` (`:965`). `GET /config` returns the *resolved* config with `{env:…}` substituted, and it is not the only endpoint behind that door that can carry a key

## File Locations

### Shared
- `src/shared/localAgentRequests.ts` — the whole request wire contract. `PERMISSION_ID_PREFIX`/`QUESTION_ID_PREFIX` (`:48-49`), `isEngineRequestId()` (`:70`), `REQUEST_PARK_TIMEOUT_MS` (`:90`), `PermissionReply` (`:380`), `RequestResolution` (`:388`), `LocalPermissionRequest` (`:423`), `parsePermissionRequest()` (`:432`). **Type-only plus pure functions** — imported from main and renderer alike, so it must pull in no runtime dependency. The grant types and matching rules also live here and belong to [Local Agent Permissions](permissions_tech.md), not to this slice
- `src/shared/messageParts.ts` — **no `permission` or `question` part kind, deliberately.** An ask is stored as a `tool` part; see [the convention](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind)
- `src/shared/runEvents.ts` — the stream vocabulary. A parked ask is also *announced* live as `needs_input { resume: 'reply' }` and settled as `input_resolved`, but neither event is persisted, so the part convention stays the only thing a replayed transcript has. `RequestResolution`, which `input_resolved` carries, is declared in `localAgentRequests.ts` for that reason. See [Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md)

#### The no-new-part-kind rule, and the five symbols that are its only enforcement

If you are about to add a `permission` or `question` part kind, these are the symbols that already do the job. There is nothing else — a contributor who cannot find them will add the kind [agent_turn.md argues against](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind).

| Symbol | Where | Role |
|---|---|---|
| `PERMISSION_TOOL_NAME` | `src/shared/localAgentRequests.ts:42` | `'cinna_permission_request'` — the reserved name a permission ask is emitted under. **Deliberately not a name any model would emit:** OpenCode's permission asks are *about* tools (`bash`, `edit`, `webfetch`) and carry the real tool name in `source`, so naming this after a tool would make an agent's own call to that tool indistinguishable from a request to run it |
| `QUESTION_TOOL_NAME` | `src/shared/localAgentRequests.ts:45` | `'askuserquestion'` — chosen to satisfy the renderer's pre-existing normalising match, so a local question needs no new detection path |
| `isPermissionRequestTool(toolName)` | `src/shared/localAgentRequests.ts:52` | Exact match on the reserved name. The **only** permission detector; used at `MessageStream.tsx:366`, `:611`, `:698`, `:908` |
| `isAskUserQuestionTool(toolName)` | `src/renderer/src/utils/askUserQuestion.ts:39` | `toLowerCase().replace(/[^a-z]/g,'') === 'askuserquestion'` — the existing normalising match, unchanged by this phase. Used at `MessageStream.tsx:382` |
| `isEngineRequestId(toolId)` | `src/shared/localAgentRequests.ts:70` | Separates a **live engine address** (`per_*` / `que_*`) from a cloud agent's question id, which is what makes a persisted local request block render read-only. `MessageStream.tsx:365` |

Emission side: `turnStream.ts:544` writes `PERMISSION_TOOL_NAME` into `cinna.tool_name` on the ask's `tool` part, and `turnStream.ts:573` writes `QUESTION_TOOL_NAME`. Both put the engine's request id in `cinna.tool_id`, which is *also* the address a reply is posted to. Asserted at `turnStream.test.ts:390` ("emits a permission ask as a tool part whose toolId is the reply address") and `:488`.

### Main process — `src/main/services/agentTurn/`
- `runner.ts` — the seam. `AgentTurnRunner` (`:37`) and nothing else: no IO, two type imports. It no longer decides which agents a runner serves
- The production wiring lives in `src/main/agents/drivers/index.ts`, beside the drivers that wrap each runner: `engineEventBus` (`:70`), the engine-stopped hook (`:87`), `localDeps` (`:91`), `localAgentTurnRunner` (`:174`), `claudeAgentTurnRunner`, `driverFor()` (`:365`). **It is the only place `engineManager`, `localAgentService`, `desktopStateService`, `turnLock` and `a2aSessionRepo` are named together**, which is what keeps the test files free of them. See [Agent Drivers — Technical Details](../drivers/drivers_tech.md)
- `localAgentTurnRunner.ts` — the turn lifecycle. `TURN_CEILING_MS` (20 min), `ENGINE_READY_MS` (60 s), `LocalTurnDeps`, `LocalAgentTurnRunner`. Per turn, `stream()` builds an `AskReporter`: `park()` posts `needs_input` after the registration, and the answer path — or an ask the engine settled while this turn was parked on it, read through `engineResolution` — posts `input_resolved`, deduped by `resolvedIds` because the engine echoes our own reply. Both are gated by `open`, which closes before `/interrupt` on a stop and before the `finally` sweep, so teardown reports nothing
- `engineEventBus.ts` — the one global SSE subscription. `RECONNECT_DELAYS_MS` (`:53`), `EngineStreamTransport` (`:62`), `SessionEventListener` (`:66`), `EngineEventBus` (`:99`)
- `engineEvents.ts` — the event vocabulary. `EngineEventDurable` (`:59`), `EngineEvent` (`:73`, open `type: string`), `ENGINE_EVENT` (`:82`), `eventSessionId()` (`:108`), `parseEngineEvent()` (`:114`)
- `turnStream.ts` — per-turn demultiplexing and the A2A-shaped fold. `PendingRequest` (`:58`, carrying the ask itself, the normalised `questions` for a question — what `needs_input` is built from — and the `auto` flag), `TurnStreamUpdate` (`:91`), `engineErrorMessage()` (`:118`), `isTurnOver()` (`:166`), `TurnStreamOptions` (`:178`, the `isGranted` predicate), `TurnStream` (`:191`), `noteRemembered()` (`:207`), `permissionAsked()` (`:493`), `questionAsked()` (`:559`), `mapQuestions()` (`:605`), `permissionDecisionText()` (`:651`), `questionDecisionText()` (`:671`), `renderToolOutput()` (`:694`), `PART_METADATA_KEYS` (`:722`)
- `sseParser.ts` — line framing. `SseMessage` (`:26`), `SseParser` (`:30`) with `feed()` (`:42`), private `flush()` (`:99`), `reset()` (`:110`)
- `pendingRequests.ts` — the module-level ask/permission registry. `RequestResolution` (re-exported from `src/shared/localAgentRequests.ts`, whose permission variant carries `remembered?`), `pendingRequests.{register:76, resolve:152, drop:189, owner:208, listForChat:221, clear:230}`. An `Entry` now also holds the engine's own ask, so an answer can be scoped to what the **engine** named rather than to what a renderer sends back with it

### Main process — elsewhere
- `src/main/ipc/agent_a2a.ipc.ts:145` — `ipcMain.on('agent:send-message')`, the dispatch seam (seam 4). `driverFor(agent)` at `:188`; `:207` lets `resolveCommandRunner` swap a catalog command in for `driver.run`; `:222` hands the bound `run` to `streamToAgent`. There is no kind-specific pre-flight here any more: the card check and endpoint/token resolution run inside the A2A driver, whose failures come back as `result.error`
- `src/main/ipc/agent_a2a.ipc.ts:245` — `agent:answer-request`, which answers through `driverFor(row).respond` (or `respondToOrphanedAsk` for a pruned row, `:313`); the `always` conversion is `rememberIfAlways` in `src/main/agents/drivers/folderDriver.ts:244`; `:328` — `agent:pending-requests`
- `src/main/services/a2aStreamingService.ts` — the A2A runner, and the direct-chat wrapper every turn passes through:
  - A2A task states become `RunState` in `toRunState()` (`:53`)
  - `a2aInputRequestOf()` (`:82`, falling back to `A2A_AUTH_REQUIRED_FALLBACK` at `:71`) turns an `input-required` / `auth-required` status-update into the `needs_input { resume: 'next_message' }` event posted after the `status` (`:340`)
  - `streamToAgent` posts `done` with a `stopReason`
  - `TurnIO` (`:108`), `TurnRun` (`:114`) and `StreamToAgentInput.run` (`:116`)
  - `RunAgentTurnInput` (`:141`, with `endpointUrl`/`cardUrl` widened to optional at `:156-157`), `RunAgentTurnResult` (`:185`), `A2ARunAgentTurnInput` (`:218`, the re-narrowing), `runAgentTurn()` (`:234`)
  - `streamToAgent()` (`:484`) calls `run` at `:493`; its `catch` at `:556` does not trust a turn to keep its own contract
- `src/main/services/a2aAsMcpProvider.ts:133` — the orchestrated-tool call site: `driverFor(this.agent).run(…)`. A folder agent works as an orchestrated tool with no change of its own
- `src/main/engine/engineManager.ts` — `ensureRunning`, `agentKey`, `agentModel`, `lastSkips`, `request`, `onStateChange`. See [engine_tech.md](engine_tech.md)
- `src/main/engine/engineConfigSource.ts:130` — `collectEngineAgents`, which does **not** filter on `enabled`
- `src/main/services/localAgents/turnLock.ts:98` — `withLock()`; `:117` — `anyHeld()`, the engine-level predicate; `:58` — `isLocked()`, which is **not** the one that gates a restart
- `src/main/services/localAgents/desktopStateService.ts` — the durable per-folder session copy
- `src/main/db/agents.ts:786` — `a2aSessionRepo.getByChatAndAgent`; `:794` — `upsert` (seam 9). `agentSessionRepo` (`:846`) is the same object under a driver-neutral name
- `src/main/agents/streamPartsAccumulator.ts` — reused verbatim (seam 8); this slice only produces `MessageLike`/`PartLike` with its `cinna.*` metadata keys

### Preload
- `src/preload/index.ts:626` — `window.api.agents.answerRequest({requestId, reply?, answers?})`; `:635` — `window.api.agents.pendingRequests(chatId)`. Typed by inference (seam 16)

### Renderer
- `src/renderer/src/hooks/useAgentRequests.ts` — `useAgentRequests(chatId, isStreaming)` → `{pending, isPending, answerPermission, answerQuestion}`, both answer functions resolving with an `AnswerOutcome` (`{remembered?}`). **Polls** (`POLL_MS = 700`) while streaming, with one final read after the stream ends. The poll is not the only source — a `needs_input` on the stream makes a block live at once, and both answer functions also call the chat store's `resolveInputRequest` — but it stays, because a reloaded renderer has no port and an ask raised before the renderer subscribed never arrives as an event; a failed lookup keeps the last known list rather than blanking a prompt mid-answer. **The optimistic removal happens after the refusal check, not before it** — it used to run first, so an answer main refused took the buttons with it: the block greyed out, the error line said the request had expired, and there was no way to answer it any other way
- `src/renderer/src/components/chat/MessageStream.tsx:328` — the hook mounted; `renderRequestBlock` decides an engine id's liveness from the registry poll **or** the stream's `reply` asks (`isLiveInputRequest`), with the stream's settled ids (`isSettledInputRequest`) overriding both, because the poll can lag the stream by a tick — never from `activeQuestionMsgId`; `PermissionRequestBlock` always receives `requestId={part.toolId}`, and `interactive` alone says whether it is live; `:366` — the permission branch; `:382` — the question branch. `:54`, `:611`, `:698`, `:908` are the sites that treat a request part like a command/tool block
- `src/renderer/src/components/chat/PermissionRequestBlock.tsx` — the permission widget. All three answers are offered; `request.savable` is deliberately **not** consulted, because it describes what OpenCode's own store would keep and this button does not write there. Detailed in [permissions_tech.md](permissions_tech.md)
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` — the existing question widget, given `liveRequestId` + `onAnswerLocal` for the local path
- `src/renderer/src/utils/askUserQuestion.ts:39` — `isAskUserQuestionTool()`, the normalising match (`toLowerCase().replace(/[^a-z]/g,'') === 'askuserquestion'`) that the reserved question tool name is chosen to satisfy

### Tests
- `src/main/services/agentTurn/localAgentTurnRunner.test.ts` — **the whole main-side turn path with only HTTP faked.** The real bus, the real `TurnStream`, the real `StreamPartsAccumulator` and the real registry are wired together; what is replaced is the socket to `opencode` and the three things needing a database or a disk. Header records what real turns later confirmed and what they contradicted
- `src/main/services/agentTurn/engineEventBus.test.ts` — fan-out, `ready()` ordering, disconnect/reconnect/close, backoff reset, unattributed errors, a throwing listener, unsubscribe-from-inside-handler, and the parser-`reset()` case
- `src/main/services/agentTurn/turnStream.test.ts` — the event→part mapping in full, including the cumulative-vs-delta trap, `text.ended` idempotence, never-shrink, request asks and paired decisions
- `src/main/services/agentTurn/pendingRequests.test.ts`, `sseParser.test.ts`
- `src/main/services/agentTurn/golden.{a2a,opencode,claude}.test.ts` <!-- nocheck --> with `__golden__/` — golden streams for all three runners, and the driver contract run through the driver that wraps each one. See [Characterization tests](#characterization-tests)
- `src/renderer/src/components/chat/PermissionRequestBlock.test.tsx`, `src/renderer/src/utils/localAgentRequests.test.ts`

## Database Schema

**No new table and no new column.** Session continuity reuses `a2a_sessions` (seam 9): one row per `(chat, agent)`, and a folder agent's engine session id goes in **`context_id`**. Columns stay A2A-named on purpose — `agent:get-session` reads `context_id` to decide a chat is an agent chat, so a parallel table would mean teaching every existing reader about it. `task_id` and `task_state` are written `null` for a folder agent.

Uniqueness is enforced in `a2aSessionRepo.upsert` by select-then-insert; there is no unique index.

The second, durable copy is `sessions[chatId] = {sessionId, updatedAt}` in the agent folder's `app-data/desktop.json`, written through `desktopStateService.patch`. Invariant 1 makes the SQLite row a cache, so a failure to write the folder copy is logged and the turn continues (`src/main/agents/drivers/index.ts:145-158`).

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `agent:send-message` | `(AgentSendPayload)` + a MessagePort on `event.ports[0]` | Unchanged shape. The handler resolves `driverFor(agent)` and hands `streamToAgent` a bound `run`. Endpoint and token resolution live inside the A2A driver, so a folder agent never meets them |
| `agent:cancel-message` | `(requestId) → {success}` | Unchanged. Reaches the runner through the turn's `AbortSignal` |
| `agent:answer-request` | `({requestId, reply?, answers?}) → {ok, reason?, remembered?}` | Activation-gated, chat-ownership checked **before** the request is consumed, and the answer shape validated against the engine's own enum. `remembered` is present only for a permission answered `always`, and says whether the grant reached disk — see [permissions_tech.md](permissions_tech.md#ordering-constraint-on-the-answer-path) for the synchronous-window constraint that makes writing it before `resolve()` safe |
| `agent:pending-requests` | `(chatId) → {requestId, kind}[]` | New. Synchronous map read; returns `[]` for a chat the caller does not own |

Three properties of `agent:answer-request` are deliberate and each closes a specific lie to the user:

- **It returns an outcome as data, never a rejection.** `ipcMain.handle` serialises a rejection to message + stack and `contextBridge` re-clones it, so a renderer branch on `err.code` silently never fires (`src/main/ipc/_wrap.ts`)
- **Ownership is read with `pendingRequests.owner()`, not `resolve()`.** `resolve` settles as a side effect, so checking ownership from its return value would have already delivered the answer by the time the check failed (`pendingRequests.ts:208-219`)
- **The answer is validated against the engine's enum, not against TypeScript's belief about it.** A renderer bug or a stale preload could otherwise send `'allow'`, or a flat `string[]`, and the first anyone would know is a 400 the runner logs at warn *after* the dialog told the user their answer landed

## Services & Key Methods

### `src/main/services/agentTurn/runner.ts`

`AgentTurnRunner.runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult>` — one method, **never throws**; a failed turn is a result carrying `error`. Which agents a runner serves is not decided here — see [Agent Drivers](../drivers/drivers.md).

### `src/main/agents/drivers/index.ts` — the runners' production wiring

| Symbol | Purpose |
|---|---|
| `engineEventBus` (`:70`) | The one bus, constructed over `engineManager.request('/api/event', {Accept: 'text/event-stream'})`. Costs nothing at module load — it connects on the first subscriber |
| `engineManager.onStateChange` (`:87`) | Any non-`running` status calls `engineEventBus.shutdown()`. This is what turns "the engine stopped" into turn errors instead of hangs |
| `localDeps` (`:91`) | Every injection point: `ensureEngineRunning`, `agentKey`, `agentModel`, `skipReason`, `request`, `bus`, `getAgent` (`not_found` caught and rendered as a turn error, `:107-127`), `readSession`, `saveSession` (both stores, `:130-159`), `isGranted` (`:168`, the reading half of *Always allow*), `withLock`, `userId` |
| `rememberGrant()` (`:300`) | The writing half, called from a folder driver's `respond`. It lives here for two reasons: this module already names `localAgentService` and the folder's own state together, and reaching into the local-agent services from the chat IPC module would pull the whole folder stack (Electron `shell`, the scaffolder, the watcher) into its import graph. Returns `false` rather than throwing: the user's action still goes ahead |
| `driverFor(agent)` (`:365`) | The one dispatch point, used by the direct-chat handler, `A2AAsMcpProvider` and the answer path. Each driver's pre-flight, reconcile and readiness are in [Agent Drivers — Technical Details](../drivers/drivers_tech.md#services--key-methods) |

Narrowing `endpointUrl`/`cardUrl` back to required happens in the A2A driver's `run` (`src/main/agents/drivers/a2aDriver.ts:74`). A missing card or endpoint is returned as a turn error, not thrown.

### `src/main/services/agentTurn/localAgentTurnRunner.ts`

`runTurn` (`:251`) — the guards, in order, and the order is load-bearing:

1. `getAgent` → folder gone from disk (`:255-256`)
2. **`!agent.enabled`** (`:260`) — the gate Phase 5 left to this phase, and the **only** place it exists. Pinned by the named mutation "remove the `enabled` check" → `localAgentTurnRunner.test.ts:295`, which asserts not just the error but `engine.calls === []` and `order === []`: a turn against a disabled agent must reconcile nothing and open nothing
3. `readiness === 'invalid' | 'contract_too_new'` (`:263`)
4. `ensureEngineRunning` (`:271`) — **before the lock**, because a reconcile that restarts here ends no turn
5. `agentKey` (`:276`) — null covers all three ways an agent is unaddressable; `skipReason` is the only one of them that can say what to fix
5b. `agentModel` — the `{providerID, id}` the session is opened with. Null is tolerated and means "as before": the engine picks its own default
6. `withLock(agentId, 'turn', …)` (`:295`), wrapped in a `catch` (`:298-310`) because `turnLock.acquire` **throws and never queues**

`stream` (`:313`) — the lifecycle:

| Step | Line | Notes |
|---|---|---|
| `awaitEngineReady` | impl below `heal` | `GET /api/agent` must list the agent key and `GET /api/model` must list the model, polled at 1 s up to `ENGINE_READY_MS`. **Both carry `?location[directory]=<the agent folder>`**: the engine's catalog and agent registry are per-location and boot lazily, so an unscoped probe answers for the engine's own cwd — always warm, and silent about the folder the turn will run in ([contract](opencode_contract.md) §9.5.6). The probe is also what warms that location. A probe that cannot be read (non-OK, unparseable, thrown) returns "ready" and the turn proceeds — a diagnostic must not refuse a turn on its own trouble |
| `openSession` | impl after `readList` | Verify a remembered id with `GET /api/session/{id}`; on hit, re-point it with `POST …/agent` **and `POST …/model`** (both best-effort) so a conversation survives an agent-key or runtime move; on miss, `POST /api/session {agent, model?, location:{directory}}` and require a `ses`-prefixed id |
| Build `TurnStream` + `StreamPartsAccumulator` | `:353-364` | `deltaPort.postMessage` forwards to `input.onEvent?.()` — direct chat sends it to the MessagePort, orchestrated mode wraps it, a buffered turn passes no sink |
| `settle` / `finished` | `:366-374` | Idempotent: first outcome wins |
| Turn ceiling | `:390-401` | `TURN_CEILING_MS`, `unref`'d. The backstop for doors not yet found |
| `ingest` | `:450-482` | Counts event types; captures `admittedSeq` from `session.next.prompt.admitted`'s `durable.seq`; applies to the `TurnStream`; re-ingests `update.message`; `parked.delete` **and** `pendingRequests.drop` on `update.settled`; parks on `update.asked`; settles on `update.error` / `update.idle` |
| `listener` | `:484-508` | `onDisconnect` sets a flag; `onReconnect` fires `heal`; `onClosed` settles with "The local engine stopped while the agent was answering." |
| `subscribe` → `ready()` → `prompt` | `:510`, `:515`, `:516` | **This order is the rule.** See item 1 above |
| Abort | `:511-512`, `:519-530` | On abort, `POST /api/session/{id}/interrupt` — an agent loop nobody reads keeps spending tokens |
| Settle | `:532-563` | Logs `{sessionId, agentId, admittedSeq, durationMs, outcome, lastSeq, parts, eventTypeCounts}`; saves the session in both stores; returns `parts` **even on the error branch** |
| `finally` | `:567-578` | Clear the ceiling, remove the abort listener, unsubscribe, close `open` so the sweep reports nothing, and `cancel()` every still-parked request |

Other methods: `park` (`:589`, fire-and-forget so awaiting cannot stall the event loop still delivering this turn's other events; it also calls `turn.noteRemembered` before posting, so the transcript's decision line cannot claim a rule the store refused), `autoAllow` (`:643`) and `deliverAutomatic` (`:673`) for an ask a standing grant covers, `reply` (`:704`, `…/permission/{id}/reply {reply}`, `…/question/{id}/reply {answers}`, the two rejection shapes, and the `always` → `once` downgrade), `heal`, `replayDurable` (`GET /api/session/{id}/event?after=<lastSeq>` read to the end through an `SseParser`), `prompt`, `post` (JSON POST that tolerates 204 and empty bodies and **never logs a response body**).

`ingest` branches on `update.asked?.auto` (`:478`) to `autoAllow` instead of `park`. See [permissions_tech.md](permissions_tech.md#the-auto-answer-path-end-to-end) for that path end to end.

### `src/main/services/agentTurn/engineEventBus.ts`

State: `listeners: Map<sessionId, Set<listener>>`, `controller`, `pumping`, `pumpGeneration`, `readyPromise`/`readyResolve`/`readyReject`, `connected`, `stopped`.

| Method | Line | Notes |
|---|---|---|
| `subscribe(sessionId, listener)` | `:135` | Registering starts the stream; the **last** unsubscribe stops it |
| `ready()` | `:160` | Resolves when a socket is live, **rejects** if it cannot be opened. Carries an `honest note` at `:170-180`: the throw is currently unreachable and no test pins it — kept as defence behind the generation fix, and explicitly not to be given a test claiming coverage |
| `isConnected()` | `:187` | Diagnostics and tests only; **not** a turn gate |
| `shutdown()` | `:198` | `onClosed` to every listener, clear the map, `stop()` |
| `start()` / `isDead()` / `stop()` | `:206`, `:226`, `:230` | `pumpGeneration` is why `start()` cannot early-return on a stopped-but-still-unwinding pump. That bug left `readyPromise` null, so `ready()` did `await null`, resolved, and a turn prompted into a socket nobody was reading |
| `armReady` / `resetReady` / `settleReady` | `:239`, `:259`, `:266` | `armReady` is a no-op while a promise exists, so a disconnect must **clear before re-arming** or `ready()` answers "connected" for a dead socket |
| `pump()` | `:281` | Attempt counter resets on every *successful* connection. `parser.reset()` on each new body. `hadDisconnect` gates `onReconnect`, so a pump's first connection is never reported as one. A clean end-of-body is still a disconnect |
| `read()` | `:334` | `decoder.decode(value, {stream: true})` — the agent's own prose streams through here, so a multi-byte character split across chunks must be held, not emitted as replacement characters. `releaseLock()` in `finally`, never `cancel()` |
| `dispatch()` | `:360` | Unparseable → debug-dropped. No session id → the error variant is warn-logged, everything else debug-dropped; **never broadcast**. Iterates the live `Set` deliberately (`:380-388`) — a listener routinely unsubscribes from inside its own handler, and a `Set` iterator tolerates that where an index loop over an array would skip a neighbour |
| `safely()` | `:408` | Every listener callback is guarded; the bus is shared, so an unguarded throw would make one bad turn a global outage |

`RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 5000]` (`:53`), capped rather than unbounded.

### `src/main/services/agentTurn/turnStream.ts`

State per turn: `messages: Map<messageId, {parts, index}>`, `requestMessage: Map<requestId, messageId>` (`:218`), `streamOwner: Map<'kind:streamId', messageId>` (`:249`), `highestSeq` (`:251`), and `remembered: Set<requestId>` — the requests the user answered with *Always allow*, so the decision line can say what was actually decided rather than the `once` the engine was sent.

Constructed with `TurnStreamOptions` (`:178`), whose single member is an `isGranted` **predicate**. It is a predicate and not a store on purpose: what a folder has granted is `permissionGrantService`'s decision, and what to do about it is this class's, because this class is where the block would otherwise be written. Auto-answering anywhere later would mean the block had already reached the renderer.

`apply(event)` (`:265`) → `TurnStreamUpdate {message?, asked?, settled?, idle?, error?}`. Tracks `durable.seq` into `highestSeq` first, then switches on `event.type`; **an unknown type returns `{}` rather than throwing** — 88 variants today and more in a later OpenCode.

| Event | Handler | Line |
|---|---|---|
| `session.next.text.delta` | `appendText(…, 'text')` | `:346` |
| `session.next.text.ended` | `setText(…, 'text')` — **cumulative, idempotent, never shrinks** | `:369` |
| `session.next.reasoning.delta` | `appendText(…, 'thinking')` | `:346` |
| `session.next.tool.called` | `toolCalled` | `:399` |
| `session.next.tool.success` / `.failed` | `toolResult` with `stdout` / `stderr` | `:431` |
| `session.next.step.ended` | `isTurnOver(finish)` → `{idle:true}` | `:166` |
| `session.next.step.failed` | `{error: engineErrorMessage(...)}` | `:292` |
| `permission.v2.asked` / `question.v2.asked` | `permissionAsked` / `questionAsked` | `:493`, `:559` |
| `permission.v2.replied`, `question.v2.replied`, `question.v2.rejected` | `settleRequest` | `:473` |
| `session.idle` | `{idle:true}` — **never emitted by 1.18.27**, kept as belt and braces | `:307` |
| `session.error` | `{error: …}` | `:312` |

`permissionAsked` (`:493`) builds the `LocalPermissionRequest` and consults `isGranted` **before it touches `messageState`**. `messageState` creates a message entry as a side effect, so an ask that renders nothing must return above it or leave an empty message behind for the accumulator to carry. On a hit it returns `{asked: {…, auto: true}}` and nothing else.

Part identity: `slot()` (`:337`) assigns an index on first sight of a stream id and never reassigns; parts are appended, never spliced. Keys are `text:<textID>`, `thinking:<reasoningID>`, `tool:<callID>`, `result:<callID>:<stream>`, `perm:<requestID>`, `question:<requestID>`, `decision:<requestID>`.

Message identity: `streamOwner` records the **first** owner of a stream id, so a later event naming a different (or absent) `assistantMessageID` files the block where it already lives rather than duplicating the answer. It covers text and reasoning (`textID` / `reasoningID`) and, since the Phase 6 audit, tool events too — keyed `tool:${callId}` in `toolCalled` and `result:${callId}:${stream}` in `toolResult`. `requestMessage` exists because `permission.v2.replied` / `question.v2.replied` carry only `{sessionID, requestID, reply|answers}` and could not otherwise be filed next to the ask they answer; it doubles as the first-owner map for requests, which is why `permissionAsked` / `questionAsked` consult it rather than adding a second mechanism.

**The tool keys are hardening against a named unknown, not a repair of an observed defect.** Nothing has been seen duplicating a tool block. What is known is that `tool.called` / `tool.success` / `tool.failed` **are** among the durable variants the heal path replays, that the durable stream's field set on them has never been watched ([contract §7.3](opencode_contract.md#7-still-unverified)), and that the text path was defended against that unknown while the tool path was not. Removing that asymmetry is the point: a reader who saw first-owner-wins on text would reasonably conclude the file had the whole question handled. It is also the semantically right key regardless — a `callID` names one tool invocation, and one invocation does not migrate to a different assistant message. By contrast `permission.v2.*` / `question.v2.*` are **not** durable variants and cannot be replayed at all, so first-owner-wins there is internal consistency rather than defence.

A missing identifier cannot degrade the key, because there is no path to one: all four handlers return `{}` before the key is built — `toolCalled` on `!callId || !tool`, `toolResult` on `!callId || text === ''`, `permissionAsked` on `!requestId || !action`, `questionAsked` on `!requestId || !Array.isArray(data.questions)`. A dropped event is the failure mode, never two calls merged into one block.

Metadata written on parts (all from `streamPartsAccumulator`, re-exported as `PART_METADATA_KEYS` at `:722`): `cinna.kind` (`text` | `thinking` | `tool` | `tool_result`), `cinna.tool_name`, `cinna.tool_id`, `cinna.tool_input`, `cinna.tool_stream`.

Helpers: `engineErrorMessage` (`:118`) reads **both** engine error shapes — `{name, data:{message}}` and `SessionErrorUnknown`'s `{type:'unknown', message}` — and prefixes a provider id when one is named, because a rotated key is the failure a user is most likely to hit. `mapQuestions` (`:605`) normalises OpenCode's `multiple` → the desktop's `multiSelect` and drops `custom`. `renderToolOutput` (`:694`) prefers `content[]` over `structured` and names files rather than inlining them. `permissionDecisionText` (`:651`) / `questionDecisionText` (`:671`) produce the transcript's decision record — the first takes a `remembered` flag, because the engine's reply says `once` for a decision the user made permanently.

Every text-bearing writer carries a `length >=` guard, which is what makes a durable replay tolerant of re-delivered events whether `?after=` turns out to be inclusive or exclusive.

### `src/main/services/agentTurn/sseParser.ts`

`feed(chunk)` (`:42`) → completed blocks. Normalises `\r\n` / `\r` / `\n` to `\n`, keeps the trailing partial line in `pending`, accumulates `data:` values, completes a block on a blank line, strips exactly one leading space from a value, and discards `event:` / `id:` / `retry:` — the engine puts its own discriminator inside the JSON, so branching on the SSE `event:` name would be reading a weaker second copy.

`reset()` (`:110`) is called by the bus on **every new body** (`engineEventBus.ts:306`) so a half-line from a dead socket cannot be glued onto the first line of the new one.

The comment-line skip at `:73` carries an *honest note*: it is behaviourally redundant under the current field split (a comment's colon is at index 0, so `field === ''` and the line is dropped anyway) and no test pins it. Kept as an explicit statement of the SSE rule and because it stops being redundant the moment the field split changes.

### `src/main/services/agentTurn/pendingRequests.ts`

Module-level `entries: Map<requestId, Entry>` and `timers: Map<requestId, Timeout>`. `Entry` is `{chatId, agentId, kind, request?, settle}` — `request` is the **engine's** ask, held so the IPC layer can scope a grant to what the engine named rather than to what a renderer sends back with the answer. The renderer is the user's own window, so this is not a trust boundary; it is that an answer sent from a stale block would otherwise store a rule for resources the engine never asked about.

| Method | Line | Contract |
|---|---|---|
| `register(…)` | `:76` | Returns `{answered: Promise<RequestResolution>, cancel}`. A second registration under the same id **settles the first as rejected** so a replayed ask cannot leave an orphan promise. Arms an `unref`'d `REQUEST_PARK_TIMEOUT_MS` timer whose expiry sends a real rejection rather than abandoning the request. `settle` checks `entries.get(id)?.settle === settle` so a stale handle cannot delete the entry that replaced it |
| `resolve(id, resolution)` | `:152` | The renderer's path. Returns `{chatId, agentId}` or `null`; refuses a mismatched kind rather than posting a permission answer to a question endpoint. A permission resolution may carry `remembered`, set by whoever wrote the grant |
| `drop(id)` | `:189` | The **engine's** path — used when `permission.v2.replied` / `question.v2.*` says the engine already settled it. Deliberately not `resolve()`, which would make the runner POST a redundant reject |
| `owner(id)` | `:208` | Ownership without consuming — and it returns the recorded ask, which is what `rememberIfAlways` builds a grant from |
| `listForChat(chatId)` | `:221` | What `agent:pending-requests` returns |
| `clear()` | `:230` | Tests and shutdown only |

Nothing in this module speaks HTTP. It holds *resolvers*; the runner owns the request that posts a reply, because the runner is what knows the session id and holds `engineManager.request` — the same "one door to the engine" rule Phase 5 set.

## Data Shapes

### `RunAgentTurnInput` → `RunAgentTurnResult`

The shared turn primitive (`a2aStreamingService.ts:141` and `:185`). Two fields are widened to optional for a folder agent (`endpointUrl`, `cardUrl`), and the `onEvent` sink takes `RunEvent`.

**In:** `chatId`, `agentId`, `agentName`, `endpointUrl?`, `cardUrl?`, `accessToken?`, `wireContent`, `fileIds?`, `isCinnaTokenAuth?`, `signal: AbortSignal`, `onEvent?`, `onClient?`, `onTaskId?`.

**Out:** `text` (compact, for an orchestrator LLM), `parts: MessagePart[]` (full fidelity, for the UI), `notices: AccumulatedNotice[]`, `contextId?`, `taskId?`, `taskState?`, `error?: {message, raw, code?}`.

The local runner fills `text`, `parts`, `notices`, `contextId` (the engine session id) and `error`. It never sets `taskId` / `taskState` — those are A2A task bookkeeping — and it ignores `onClient` / `onTaskId`, which exist for the A2A SDK's cancel path (a local cancel goes to `POST …/interrupt` instead). `fileIds` and `isCinnaTokenAuth` are inert on this path.

### `EngineEvent`

`{type: string, id?, durable?: {aggregateID, seq, version}, location?, data?: Record<string, unknown>}` (`engineEvents.ts:73`). `type` is an **open string**, not a closed union, and `data` is deliberately loose — every field is read through a per-variant accessor that validates as it goes, because this JSON crossed a socket from a separately-versioned binary.

`eventSessionId` (`:108`) is total by construction: it runs on every event off a stream shared by every agent, so a malformed or unattributed event must be `null`, never a throw and never a wrong id. It requires the value to be a string starting `ses`.

### `TurnStreamUpdate`

`{message?, asked?, settled?, idle?, error?}` (`turnStream.ts:91`). The runner acts on each field independently; `message` is the **whole cumulative message**, for re-ingestion.

## Flow

```
runTurn(input)
 ├ getAgent → enabled → readiness            [no engine contact yet]
 ├ ensureEngineRunning(userId)               [BEFORE the lock]
 ├ agentKey(agentId) ?? skipReason
 ├ agentModel(agentId)
 └ withLock(agentId, 'turn')
    └ stream()
       ├ awaitEngineReady → GET /api/agent?location[directory]=<folder>
       │                  → GET /api/model?location[directory]=<folder>
       │                    neither is true for ~30-60s after a healthy start,
       │                    and the location scoping is what makes the answer
       │                    about the folder rather than the engine's own cwd
       ├ openSession → GET /api/session/{remembered}       (verify)
       │              → POST /api/session/{id}/agent       (re-point)
       │              → POST /api/session/{id}/model       (re-point)
       │              → POST /api/session {agent, model, location} (or create)
       ├ bus.subscribe(sessionId, listener)
       ├ bus.ready()                                    ← rejects if unopenable
       ├ POST /api/session/{id}/prompt {prompt:{text}}  → admission ack
       │
       ├ per event:  TurnStream.apply → StreamPartsAccumulator → onEvent
       │             asked   → pendingRequests.register → (await) → POST reply
       │             settled → pendingRequests.drop
       │             step.ended(terminal) | session.error | onClosed | abort | ceiling → settle
       │
       ├ on reconnect: GET /api/session/{id}/event?after=<turn.lastSeq()>
       │               → same ingest → fills the hole AND delivers step.ended
       │
       ├ if aborted: POST /api/session/{id}/interrupt
       ├ saveSession → a2a_sessions.context_id + app-data/desktop.json
       └ finally: clear ceiling, unsubscribe, reject every still-parked request
```

## Configuration

| Constant | Where | Value | Why |
|---|---|---|---|
| `TURN_CEILING_MS` | `localAgentTurnRunner.ts:78` | 20 min | Not a model timeout — a ceiling on *never settling*. Generous because a ceiling that fires on a working turn is worse than none. Overridable via `LocalTurnDeps.turnCeilingMs` **in tests only** |
| `ENGINE_READY_MS` | `localAgentTurnRunner.ts` | 60 s | A cold `opencode serve` answers `GET /api/health` **30–60 s** before `GET /api/model` returns anything or a config-defined agent is addressable ([contract](opencode_contract.md) §9.5.6). Both failures in that window are silent: an unresolvable model raises `ModelUnavailableError` **on no event at all**, so the turn ran to `TURN_CEILING_MS`; an unloaded agent runs the turn **with no system prompt**. Overridable via `LocalTurnDeps.engineReadyMs` **in tests only** |
| `REQUEST_PARK_TIMEOUT_MS` | `src/shared/localAgentRequests.ts:90` | 10 min | Bounds an abandoned dialog. The turn holds its lock while parked and a config change defers while *any* lock is held, so unbounded this turns one open modal into an app-wide stall |
| `RECONNECT_DELAYS_MS` | `engineEventBus.ts:53` | 250/500/1000/2000/5000 ms | Capped backoff; the counter resets on every successful connection |
| `POLL_MS` | `useAgentRequests.ts` | 700 ms | Renderer poll while streaming. One synchronous main-process map lookup per tick |
| `AUTO_REPLY_RETRY_MS` | `localAgentTurnRunner.ts:113` | 500 ms | Gap before the one retry of an **automatic** allow. That path has no `pendingRequests` entry and therefore no park timer, so a lost reply would hold the turn to `TURN_CEILING_MS`. After the retry it posts `reject` rather than hang. Overridable via `LocalTurnDeps.autoReplyRetryMs` **in tests only** |

## Security

- **Invariant 4 — no secret crosses to the renderer.** The engine's base URL and per-start Basic-auth password stay inside `engineManager`; this slice reaches the engine only through `engineManager.request`, and no IPC channel exposes that seam. What the renderer receives is stream events and message parts, exactly as for a remote agent
- **No engine response body is ever logged** (`localAgentTurnRunner.ts:876`, `:965`). `GET /config` returns the resolved config with `{env:…}` substituted, so its body contains live API keys — and it is not the only endpoint that can carry one
- **Chat ownership is checked on both new channels** (`agent_a2a.ipc.ts:256`, `:330`) with `chatRepo.getOwned(getProfileScopeUserId(), chatId)`, and on `answer-request` it is checked **before** the request is consumed
- **Both new channels are activation-gated** (`userActivation.requireActivated()`)
- **Answer shapes are validated against the engine's own enum**, not against the renderer's word for it — a wrong shape is refused before any driver sees it rather than delivered to the wrong endpoint (`agent_a2a.ipc.ts:269-280`, plus the kind check in `pendingRequests.resolve`)
- **A persisted request block is read-only.** `isEngineRequestId` (`src/shared/localAgentRequests.ts:70`) separates a live engine address from a cloud agent's question id, and the main-process registry is the only authority on whether it is still answerable — so a reopened chat cannot re-answer a dead request
- **The permission tool name is reserved and un-model-emittable** (`cinna_permission_request`), so an agent's own call to `bash` or `edit` can never be mistaken for a request to run one

## Testing notes

**Every test in this slice fakes the socket to `opencode`.** What is *not* faked is as important: the real `EngineEventBus`, the real `TurnStream`, the real `StreamPartsAccumulator` and the real `pendingRequests` registry are wired together in `localAgentTurnRunner.test.ts`. Only HTTP and the three deps needing a database or disk are replaced. The split is deliberate — every defect this slice can still have is a defect of *sequence*, and a test that stubs the bus sees none of them.

The fakes were **corrected against real turns** run with a live credential. Confirmed on real data: deltas are true deltas and `text.ended` is cumulative; `session.next.text.delta` carries no `durable` block at all; `admittedSeq` matches `session.next.prompt.admitted`'s `durable.seq`; tool failures use the `{type:'unknown', message}` shape; the permission flow fires headless. Contradicted outright — and the fakes had implemented both *faithfully from the OpenAPI document* — `session.idle` is never emitted and `POST …/wait` answers 503. A fake can only be as right as the contract you believed when you wrote it.

Ordering assertions need care. `bus.subscribe()` issues its transport call **synchronously**, so recorded call order is identical whether or not `ready()` was awaited; only a socket that does not resolve in a microtask distinguishes them (`localAgentTurnRunner.test.ts:404`). This was one of five mutation survivors in the phase, every one the same shape: a test that only exercised the easy input.

Two lines carry an explicit *honest note* saying no test pins them and none should claim to: `engineEventBus.ts:170-180` (currently unreachable, kept as defence behind the generation fix) and `sseParser.ts:73` (behaviourally redundant under the current field split). A `[...set]` snapshot in `dispatch` was written and then **removed** once the mutation meant to justify it passed the whole suite (`engineEventBus.ts:380-388`) — do not add it back without a test that fails without it.

## What is not verified

See [agent_turn.md § What is not verified](agent_turn.md#what-is-not-verified) for the argued list, and [opencode_contract.md §7](opencode_contract.md#7-still-unverified) for the engine-side gaps. In short, from this slice's side:

- No turn has been watched through a **real** reconnect. The heal path is covered against a fake that drops and restores a stream (`localAgentTurnRunner.test.ts:1149`), but the durable stream's own field set on a replayed `text.ended` is unobserved — `streamOwner` exists because of that
- Whether a global-stream `durable.seq` is a valid `?after=` cursor on the per-session stream is unverified and **silent when wrong**; the never-shrink guards absorb a replay that starts too early, nothing reports one that starts too late
- Which `finish` values actually occur beyond `stop` and `tool-calls`. Mitigated by terminate-by-default plus the per-turn `eventTypeCounts` line the runner logs (`localAgentTurnRunner.ts:534-543`), so the question can be answered from a user's log
- Where a permission or question falls relative to the text stream
- **The independent mutation audit has now been run** (3 September) on `engineEventBus.test.ts`, `turnStream.test.ts` and `localAgentTurnRunner.test.ts`. 45 mutations, **13 survivors, all fixed** — each re-run with the identical mutation afterwards to confirm it then fails a named test; suite 758 → 771. A further 13 survivors are **deliberately uncovered**, each shielded by a second mechanism such that no input separates the code from its absence; each is recorded in its file with the reason and a note that the guard remains load-bearing. Of the 13 fixed: three were a test named for a contract whose branch it never executed, nine were plain holes with no test at all, one was reachable only across a seam. It hardened the tests, **not** the engine contract — all 771 still run against a fake at the HTTP boundary

The plan's "Phase 6 debt" entry claiming the reconnect path has **no test** was stale — it described a design that used `POST /wait`, removed once the binary showed it returns 503 — and has since been corrected. The heal path has a test; what it does not have is a *real* reconnect.

**The fixture behind that test had to be corrected before the claim could stand**, and the correction is the part worth remembering. It gave its `session.next.text.delta` a fabricated `durable` block, which the verified contract says a real delta never carries — so the fixture contradicted the contract, the same failure mode that made the `session.idle` and `POST /wait` fakes confidently wrong. The cursor now rides `session.next.text.started` (seq 7), matching the observed trace `admitted(1) → prompted(2) → step.started(3) → text.started(4) → deltas (no durable) → text.ended(5) → step.ended(6)`. The test passes with unchanged assertions, still asserting `?after=7`, and all three named mutations still fail it. The old version proved `?after=` works when a cursor happens to sit on a delta — a shape production never emits.

That also split the coverage into two genuinely distinct branches: `heals a mid-turn stream drop from the durable stream alone` is the drop-*after*-`text.started` case, and `replays the whole durable stream when the socket dies before any cursor exists` is the drop-*before*-any-durable-event case. Neither is reachable from the other's input — the `const query = ''` mutation fails the first and **passes** the second, which structurally cannot distinguish it.

## Characterization tests

These pin what the three runners and the renderer's stream handler **currently do**, not what they should do, so the agent runtime refactor can show it changed nothing it did not mean to. Behaviour that looks wrong is pinned as it is, with the reason written beside it; a fix is a separate change that edits the expectation on purpose. The rationale for each file is in its header comment and is not repeated here.

### Golden streams

- **One test file per runner**: `src/main/services/agentTurn/golden.a2a.test.ts`, `golden.opencode.test.ts`, `golden.claude.test.ts`. Not one shared file, because each runner needs its own `vi.mock`s. Each scenario replays one recorded input and compares the **whole** output: every `onEvent` call in order, plus the returned `RunAgentTurnResult`
- **Data**, under `src/main/services/agentTurn/__golden__/<runner>/`: `<scenario>.fixture.json` (the input), `<scenario>.expected.json` (`{events, result}`), and one sidecar per scenario (below). Every fixture names its origin in `recorded_from`; all are currently `"hand-written"`, and one taken from a real binary would carry `"<binary> <version>"` <!-- nocheck -->
- **The per-runner driver** is in the same folder: `a2a/fakeAgent.ts` fakes global `fetch` rather than the SDK client, so the card fetch, the 401/403 intercept and the SDK's SSE parser run over real bytes. `opencode/goldenEngine.ts` is a *copy* of the world in `localAgentTurnRunner.test.ts`, because importing a test file registers its tests and would make the count lie; keep the two in step by hand. `claude/script.ts` is a stub SDK that plays a step script, and its header lists which CLI behaviours it reproduces and why
- **Shared plumbing** is `__golden__/harness.ts`: `readFixture`, `normalise` (wall-clock keys become `<time>`; UUIDs and runner-minted ids become `<label#n>` in order of first appearance, so two fields that carried the same id still match), `expectGolden` and `expectGoldenSidecar`

### The expectation-file rule

- **Expectations are JSON files compared with `toEqual`, never Vitest snapshots.** A snapshot rewrites itself under `-u`, and a refactor that changes the stream is exactly when someone reaches for `-u`. A file only changes when a person edits it, so a difference in the diff is a decision somebody made
- **`GOLDEN_WRITE=1` writes a *missing* file only, and the test still fails on that run**, naming the path. A first run can never pass silently, and an existing file is never overwritten
- **To change a scenario on purpose**, edit its expectation, or delete it and re-run with `GOLDEN_WRITE=1`. Then read what was written before re-running: regenerating without reading turns the file back into a snapshot
- **To add a scenario**, add the fixture *and* its name to the file's `SCENARIOS` list. Only `golden.opencode.test.ts` checks that every fixture on disk is in the list. In the A2A and Claude files, a fixture missing from the list is silently never run
- **`golden.a2a.test.ts` stops at the first missing file.** A new A2A scenario therefore needs two `GOLDEN_WRITE=1` runs to write both files. The OpenCode and Claude files run both comparisons before throwing
- **`_notes`** (a string array at the top of any expectation or sidecar) is never compared. It is where a pin that looks wrong says why it was kept
- **`_phase1_note`** (a string beside `_notes`) is never compared either. The rewrite of the expectations into `RunEvent` left every `_notes` entry exactly as it was written, so where a note stopped being true — the stream now says something the note says it does not — the correction sits here, beside the note it corrects, instead of silently editing the original record

### Sidecar expectations

`expectGolden` sees only `{events, result}`, and half of what a runner does never reaches `onEvent`. So each scenario has a second file, `<scenario>.<name>.expected.json`, compared through `expectGoldenSidecar` under the same rules.

| Runner | Sidecar | Holds | Helper |
|---|---|---|---|
| A2A | `effects` | Every HTTP request (including the remembered `contextId`/`taskId`, `cinna_file_ids` and the bearer), session reads and upserts, task ids surfaced through `onTaskId`, the `onClient` count | `__golden__/a2a/effects.ts` |
| OpenCode | `effects` | Every engine call (an allow is a `POST …/reply`, a stop is `/interrupt` plus a reject), the reconcile/lock order, `pendingRequests` registrations, `saveSession` inputs, and what the turn left behind: parked asks, the lock, the bus | `__golden__/opencode/goldenEngine.ts:Effects` <!-- nocheck --> |
| Claude | `boundary` | The options and prompt of each `query()`, what `canUseTool` **returned** to the SDK, stdin state where the script probed, `saveSession` inputs, and any `onEvent` that arrived after `runTurn` resolved | `__golden__/claude/script.ts:BoundaryCapture` <!-- nocheck --> |

The sidecars exist because the events golden was measurably blind. According to the mutation table in `golden.a2a.test.ts`'s header, skipping `a2aSessionRepo.upsert` on the success path failed the effects files and the contract's `session` clause, and **no** `{events, result}` golden. A vocabulary change rewrites `*.expected.json` and leaves the sidecars alone — a sidecar that changes during one is a behaviour change, not a rename. A transport change rewrites the sidecars.

### The driver contract

`src/main/services/agentTurn/__golden__/driverContract.ts` — `describeDriverContract(name, makeSubject, options)` is called once at the bottom of each golden file.
- **Every turn goes through `driver.run(userId, row, input)`**, the call production dispatches to
- **The subject's driver wraps the same runner the suite's fakes construct**, and its row and small world come from `__golden__/driverWorld.ts` (`goldenRow`, …). A golden therefore pins exactly the stream the runner produced, plus whatever the driver does around it
- **The suite owns every assertion** and the `pendingRequests` instrumentation. A subject only says how to *reach* a situation (`completes`, `failures`, `hangs`, `hangsServerAssisted?`, `parks?`, `session`), so a driver cannot pass by describing its own behaviour back
- **A subject's `run` must return the driver's promise untouched.** A `catch` there would make the never-rejects clause test the subject instead of the driver

What it asserts for every driver:

- `runTurn` never rejects, and every failure is `result.error` with a non-empty `message` and `raw`
- The first `onEvent` is never `done` or `error`
- On abort the turn settles by itself and emits nothing further (`abort.settles`), and carries `error` or `taskState: 'canceled'` (`abort.reports`)
- A parked ask is registered exactly once and released on answer, reject, abort and timeout. The timeout runs through the registry's real timer, shortened
- A parked ask is **announced**: exactly one `needs_input` for the registered id, `resume: 'reply'`, of the registration's kind, before anything is answered — a block the renderer learns is answerable only once it has been answered is one nobody could answer — and not again on the way out (`park.needs_input`)
- A parked ask settled while the turn is open says so **once**: one `input_resolved`, after its `needs_input`, carrying the answer that was posted (`park.input_resolved`), or `{kind: 'rejected'}` on a reject and on a timeout (asserted inside `park.reject` and `park.timeout`). Every `input_resolved` the turn posted is counted, not only this id's, because a runner can hear of one answer twice — its own and the engine's echo. An ask swept away by an abort gets **none** (asserted inside `park.abort`): nobody answered it, and the terminal event posted above the runner already says the park is gone
- A2A has no `parks()`, because `input-required` ends its turn instead of parking, so its six parked-ask clauses are skipped. Its `needs_input { resume: 'next_message' }` is pinned by the `input_required` and `auth_required_state` goldens instead — the second being the only way to reach the `auth` kind, since `auth_required_401` is a transport rejection that never gets that far
- A session id the turn produces reaches `saveSession`, and the next turn on the same chat gets it back through `readSession`
- `capabilities(row)` is the same answer on every call and for every subject built for that row, and a caller editing the object it was handed cannot change the next answer (`capabilities.stable`)
- `readiness` resolves — never rejects, never throws — with a state this build knows and a sentence when it is not `ok`, whatever its dependencies do (`readiness.never_throws`)
- `respond` to an ask nothing is waiting on answers `{delivered: false}` and writes no grant; where the driver parks, an ask already answered is one of those (`respond.unknown`)

**A clause a runner breaks is recorded, never bent.**

- `knownViolations: {clause: reason}` records a clause the runner breaks today. The clause passes only if it fails **the way the entry says** — an assertion, or `{ reason, by: 'timeout' }` for a turn that never settles — and fails outright once the runner keeps it, so whoever fixes the runner deletes the entry in the same change, along with the goldens the fix changes. Deliberately not `it.fails`, which passes on any throw, including the suite's own settle timeout. A wait that fails while *setting the clause up* — the turn never started, the ask was never registered — is a `ContractSetupError` and never matches an entry, so a runner that stops reaching its agent cannot satisfy a recorded `by: 'timeout'`
- `knownFailureViolations: {scenario: reason}` covers one failure scenario that comes back as a success. It is finer than `knownViolations.failures`, which would mark the whole clause over one bad scenario and stop checking the rest. The scenario is asserted to have *no* `error`, so it fails, and must be removed, once it gets one. Every name must exist in `failures()`, and that is asserted too

Currently recorded:

- **`abort.reports`, on all three runners.** An aborted turn returns success, with neither `error` nor a `canceled` task state. A2A returns the last streamed `taskState` (e.g. `working`); OpenCode and Claude return the parts with neither field. The comment beside each entry names the expectation file that shows it
- **A2A also does not settle on abort while the agent is silent.** `runAgentTurn` passes its signal to neither the SDK nor `fetch`, so the promise stays pending until the server ends the stream. This is pinned separately in the `a2a abort, characterised` test. It is recorded as `abort.settles` with `by: 'timeout'`: A2A's `hangs()` leaves the stream open, and only `hangsServerAssisted()` — used by `abort.reports` alone — closes it the way a server does after `tasks/cancel`
- **A2A `failures`:** `task_failed` and `nonstreaming_rpc_error` return success, and the job is reported as succeeded

### Kind-branch ratchet and receiver-side events

- `src/main/agents/kindBranches.test.ts` counts literal comparisons on an agent's `source`, `engine`, `kind`, job `type` and `providerType` — plus comparisons against `FOLDER_AGENT_SOURCE` and calls of the folder-agent predicates the header names — across `src/main`, `src/shared` and `src/renderer/src`.
  - **Each category must equal its entry in `LIMITS`, not merely stay under it.** A change that removes branches lowers the limit in the same commit; otherwise a new branch could later fill the freed room unnoticed
  - Raising a limit needs a comment beside it naming what pays it back
  - Limits are per category, so headroom freed in one category cannot be spent in another
  - `src/main/agents/drivers/` and four sync files are allowlisted. Files whose `source` reads are about ownership are pinned to exact counts in `OWNERSHIP` rather than held in `LIMITS`
  - The count runs in Node, not shell `grep`. Its blind spots (`switch`/`case`, `.includes`, lookups, an unnamed helper) are listed in the header

  Full account: [Agent Drivers — Technical Details](../drivers/drivers_tech.md#the-kind-branch-ratchet)
- `src/renderer/src/hooks/useChatStream.events.test.tsx` feeds every `RunEvent` variant through `useChatStream.handleRun`, in an agent table and an LLM table. Each row pins exactly which chat-store fields changed — `inputRequests` and `settledInputRequestIds` among them — and which queries were invalidated, and any field a row does not name is asserted unchanged. `Record<Union, true>` guards (`RUN_EVENT_TYPES`, `CONTENT_KINDS`, `ALL_RUN_STATES`) make a new variant, content kind or run state fail `npm run typecheck:web` until it has a row. Rows titled `PINNED:` record behaviour that looks wrong and is kept as it is
