# The Agent Turn Runner — Technical Details

Implementation reference for [The Agent Turn Runner](agent_turn.md). The engine's HTTP and event contract is **not** restated here — see [The OpenCode Engine Contract](opencode_contract.md), which records what was watched against the real binary and what was not.

Path convention as in [engine.md](engine.md): `src/...` is this repository; `app-data/desktop.json` is inside an agent folder; `/api/...` is a path on the local engine, reachable only through `engineManager.request`.

## Read this first if you are working next to the runner

Six things here produce a silent, green-suite failure if changed carelessly. Each is argued in [agent_turn.md](agent_turn.md); this is the index.

1. **The subscription is opened and awaited *before* the prompt is posted.** `src/main/services/agentTurn/localAgentTurnRunner.ts:305-311`. The global stream takes no cursor, so events emitted before the socket is live are gone forever. Recorded call order alone cannot catch a regression here — `subscribe()` issues its transport call synchronously, so only a socket that does not resolve in a microtask distinguishes the two orderings (this is exactly the mutation that survived, see `localAgentTurnRunner.test.ts:298`)
2. **`TurnStream` maintains the *cumulative* message and hands the whole thing back.** `turnStream.ts:270-321`. `StreamPartsAccumulator` computes `text.slice(prior.length)` itself; feeding it a raw engine delta duplicates every character from the second chunk onward — and passed 19/19 assertions when it was wrong
3. **Termination is the default; continuation is the enumerated exception.** `turnStream.ts:135-141`. `finish` is an unconstrained string in the OpenAPI document, so a `=== 'stop'` test hangs the turn on any other terminal value. A hang holds the per-agent lock for the life of the app and blocks engine reconciles for *every* folder agent
4. **`onClosed` is not `onDisconnect`.** `engineEventBus.ts:79-91`. A close means the session id died with the process; treating it as a disconnect waits for a reconnect that cannot come
5. **The `enabled` gate exists only at `localAgentTurnRunner.ts:125`.** `collectEngineAgents` (`src/main/engine/engineConfigSource.ts:130`) does not consult it — by design, so a disabled agent still gets a config entry and a prompt file on disk. Delete the check and a disabled agent is chattable. It is an obligation Phase 5 explicitly handed to Phase 6, and it is pinned by the named mutation "remove the `enabled` check" → `localAgentTurnRunner.test.ts:244` (mutation table, `:734`)
6. **No engine response body is ever logged.** `localAgentTurnRunner.ts:521-546`. `GET /config` returns the *resolved* config with `{env:…}` substituted, and it is not the only endpoint behind that door that can carry a key

## File Locations

### Shared
- `src/shared/localAgentRequests.ts` — the whole request wire contract. `PERMISSION_ID_PREFIX`/`QUESTION_ID_PREFIX` (`:42-43`), `isEngineRequestId()` (`:64`), `REQUEST_PARK_TIMEOUT_MS` (`:84`), `ALWAYS_GRANTS_ENABLED` (`:135`, `false`), `PermissionReply` (`:144`), `LocalPermissionRequest` (`:159`), `parsePermissionRequest()` (`:168`). **Type-only plus constants** — imported from main and renderer alike, so it must pull in no runtime dependency
- `src/shared/messageParts.ts`, `src/shared/agentStreamEvents.ts` — **unchanged by this phase, deliberately.** No `permission` or `question` part kind was added; see [the convention](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind)

#### The no-new-part-kind rule, and the five symbols that are its only enforcement

If you are about to add a `permission` or `question` part kind, these are the symbols that already do the job. There is nothing else — a contributor who cannot find them will add the kind [agent_turn.md argues against](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind).

| Symbol | Where | Role |
|---|---|---|
| `PERMISSION_TOOL_NAME` | `src/shared/localAgentRequests.ts:36` | `'cinna_permission_request'` — the reserved name a permission ask is emitted under. **Deliberately not a name any model would emit:** OpenCode's permission asks are *about* tools (`bash`, `edit`, `webfetch`) and carry the real tool name in `source`, so naming this after a tool would make an agent's own call to that tool indistinguishable from a request to run it |
| `QUESTION_TOOL_NAME` | `src/shared/localAgentRequests.ts:39` | `'askuserquestion'` — chosen to satisfy the renderer's pre-existing normalising match, so a local question needs no new detection path |
| `isPermissionRequestTool(toolName)` | `src/shared/localAgentRequests.ts:46` | Exact match on the reserved name. The **only** permission detector; used at `MessageStream.tsx:343`, `:580`, `:667`, `:877` |
| `isAskUserQuestionTool(toolName)` | `src/renderer/src/utils/askUserQuestion.ts:39` | `toLowerCase().replace(/[^a-z]/g,'') === 'askuserquestion'` — the existing normalising match, unchanged by this phase. Used at `MessageStream.tsx:357` |
| `isEngineRequestId(toolId)` | `src/shared/localAgentRequests.ts:64` | Separates a **live engine address** (`per_*` / `que_*`) from a cloud agent's question id, which is what makes a persisted local request block render read-only. `MessageStream.tsx:342` |

Emission side: `turnStream.ts:437` writes `PERMISSION_TOOL_NAME` into `cinna.tool_name` on the ask's `tool` part, and `turnStream.ts:465` writes `QUESTION_TOOL_NAME`. Both put the engine's request id in `cinna.tool_id`, which is *also* the address a reply is posted to. Asserted at `turnStream.test.ts:304` ("emits a permission ask as a tool part whose toolId is the reply address") and `:326`.

### Main process — `src/main/services/agentTurn/`
- `runner.ts` — the seam. `AgentTurnRunner` (`:33`), `isFolderAgent()` (`:45`). No IO, no imports beyond two types
- `index.ts` — production wiring and the one resolver. `engineEventBus` (`:35`), the engine-stopped hook (`:52`), `a2aTurnRunner` (`:63`), `localDeps` (`:80`), `localAgentTurnRunner` (`:146`), `resolveTurnRunner()` (`:156`). **The only place `engineManager`, `localAgentService`, `desktopStateService`, `turnLock` and `a2aSessionRepo` are named together**, which is what keeps the test files free of them
- `localAgentTurnRunner.ts` — the turn lifecycle. `TURN_CEILING_MS` (20 min), `ENGINE_READY_MS` (60 s), `LocalTurnDeps`, `LocalAgentTurnRunner`
- `engineEventBus.ts` — the one global SSE subscription. `RECONNECT_DELAYS_MS` (`:53`), `EngineStreamTransport` (`:62`), `SessionEventListener` (`:66`), `EngineEventBus` (`:99`)
- `engineEvents.ts` — the event vocabulary. `EngineEventDurable` (`:59`), `EngineEvent` (`:73`, open `type: string`), `ENGINE_EVENT` (`:82`), `eventSessionId()` (`:108`), `parseEngineEvent()` (`:114`)
- `turnStream.ts` — per-turn demultiplexing and the A2A-shaped fold. `PendingRequest` (`:56`), `TurnStreamUpdate` (`:63`), `engineErrorMessage()` (`:90`), `isTurnOver()` (`:138`), `TurnStream` (`:149`), `mapQuestions()` (`:497`), `permissionDecisionText()` (`:541`), `questionDecisionText()` (`:563`), `renderToolOutput()` (`:586`), `PART_METADATA_KEYS` (`:614`)
- `sseParser.ts` — line framing. `SseMessage` (`:26`), `SseParser` (`:30`) with `feed()` (`:42`), private `flush()` (`:99`), `reset()` (`:110`)
- `pendingRequests.ts` — the module-level ask/permission registry. `RequestResolution` (`:42`), `pendingRequests.{register:68, resolve:142, drop:179, owner:198, listForChat:204, clear:213}`

### Main process — elsewhere
- `src/main/ipc/agent_a2a.ipc.ts:146` — `ipcMain.on('agent:send-message')`, the dispatch seam (seam 4). `resolveTurnRunner(agent)` at `:194`, `isFolderAgent(agent)` at `:195`; `:196-203` is the card check that now runs **after** the source check; `:212` and `:251` short-circuit endpoint and token resolution for a folder agent; `:265` hands the runner to `streamToAgent`
- `src/main/ipc/agent_a2a.ipc.ts:304` — `agent:answer-request`; `:350` — `agent:pending-requests`
- `src/main/services/a2aStreamingService.ts` — **body unchanged.** `StreamToAgentInput.runner` (`:64`), `RunAgentTurnInput` (`:98`, with `endpointUrl`/`cardUrl` widened to optional at `:113-114`), `RunAgentTurnResult` (`:142`), `A2ARunAgentTurnInput` (`:174`, the re-narrowing), `runAgentTurn()` (`:190`), `streamToAgent()` (`:415`) calling `runner.runTurn` at `:437`, and the `catch` at `:500` that no longer trusts a runner to keep its own contract
- `src/main/services/a2aAsMcpProvider.ts:134` — the second call site of `resolveTurnRunner`; `:171` — `runner.runTurn`. A folder agent works as an orchestrated tool with no change of its own
- `src/main/engine/engineManager.ts` — `ensureRunning`, `agentKey`, `agentModel`, `lastSkips`, `request`, `onStateChange`. See [engine_tech.md](engine_tech.md)
- `src/main/engine/engineConfigSource.ts:130` — `collectEngineAgents`, which does **not** filter on `enabled`
- `src/main/services/localAgents/turnLock.ts:98` — `withLock()`; `:117` — `anyHeld()`, the engine-level predicate; `:58` — `isLocked()`, which is **not** the one that gates a restart
- `src/main/services/localAgents/desktopStateService.ts` — the durable per-folder session copy
- `src/main/db/agents.ts:703` — `a2aSessionRepo.getByChatAndAgent`; `:711` — `upsert` (seam 9)
- `src/main/agents/streamPartsAccumulator.ts` — reused verbatim (seam 8); this slice only produces `MessageLike`/`PartLike` with its `cinna.*` metadata keys

### Preload
- `src/preload/index.ts:559` — `window.api.agents.answerRequest({requestId, reply?, answers?})`; `:565` — `window.api.agents.pendingRequests(chatId)`. Typed by inference (seam 16)

### Renderer
- `src/renderer/src/hooks/useAgentRequests.ts:35` — `useAgentRequests(chatId, isStreaming)` → `{pending, isPending, answerPermission, answerQuestion}`. **Polls** (`POLL_MS = 700`) while streaming, with one final read after the stream ends; a failed lookup keeps the last known list rather than blanking a prompt mid-answer
- `src/renderer/src/components/chat/MessageStream.tsx:313` — the hook mounted; `:342` — `isEngineRequestId(part.toolId)` decides liveness from the registry rather than from `activeQuestionMsgId`; `:343` — the permission branch; `:357` — the question branch. `:53`, `:580`, `:667`, `:877` are the sites that treat a request part like a command/tool block
- `src/renderer/src/components/chat/PermissionRequestBlock.tsx:39` — the permission widget. Renders *Always* only when `ALWAYS_GRANTS_ENABLED` (`:136`), which is `false`
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` — the existing question widget, given `liveRequestId` + `onAnswerLocal` for the local path
- `src/renderer/src/utils/askUserQuestion.ts:39` — `isAskUserQuestionTool()`, the normalising match (`toLowerCase().replace(/[^a-z]/g,'') === 'askuserquestion'`) that the reserved question tool name is chosen to satisfy

### Tests
- `src/main/services/agentTurn/localAgentTurnRunner.test.ts` — **the whole main-side turn path with only HTTP faked.** The real bus, the real `TurnStream`, the real `StreamPartsAccumulator` and the real registry are wired together; what is replaced is the socket to `opencode` and the three things needing a database or a disk. Header records what real turns later confirmed and what they contradicted
- `src/main/services/agentTurn/engineEventBus.test.ts` — fan-out, `ready()` ordering, disconnect/reconnect/close, backoff reset, unattributed errors, a throwing listener, unsubscribe-from-inside-handler, and the parser-`reset()` case
- `src/main/services/agentTurn/turnStream.test.ts` — the event→part mapping in full, including the cumulative-vs-delta trap, `text.ended` idempotence, never-shrink, request asks and paired decisions
- `src/main/services/agentTurn/pendingRequests.test.ts`, `sseParser.test.ts`
- `src/renderer/src/components/chat/PermissionRequestBlock.test.tsx`, `src/renderer/src/utils/localAgentRequests.test.ts`

## Database Schema

**No new table and no new column.** Session continuity reuses `a2a_sessions` (seam 9): one row per `(chat, agent)`, and a folder agent's engine session id goes in **`context_id`**. Columns stay A2A-named on purpose — `agent:get-session` reads `context_id` to decide a chat is an agent chat, so a parallel table would mean teaching every existing reader about it. `task_id` and `task_state` are written `null` for a folder agent.

Uniqueness is enforced in `a2aSessionRepo.upsert` by select-then-insert; there is no unique index.

The second, durable copy is `sessions[chatId] = {sessionId, updatedAt}` in the agent folder's `app-data/desktop.json`, written through `desktopStateService.patch`. Invariant 1 makes the SQLite row a cache, so a failure to write the folder copy is logged and the turn continues (`index.ts:127-140`).

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `agent:send-message` | `(AgentSendPayload)` + a MessagePort on `event.ports[0]` | Unchanged shape. The only new work is `resolveTurnRunner(agent)` and skipping endpoint/token resolution for a folder agent |
| `agent:cancel-message` | `(requestId) → {success}` | Unchanged. Reaches the runner through the turn's `AbortSignal` |
| `agent:answer-request` | `({requestId, reply?, answers?}) → {ok, reason?}` | New. Activation-gated, chat-ownership checked **before** the request is consumed, and the answer shape validated against the engine's own enum |
| `agent:pending-requests` | `(chatId) → {requestId, kind}[]` | New. Synchronous map read; returns `[]` for a chat the caller does not own |

Three properties of `agent:answer-request` are deliberate and each closes a specific lie to the user:

- **It returns an outcome as data, never a rejection.** `ipcMain.handle` serialises a rejection to message + stack and `contextBridge` re-clones it, so a renderer branch on `err.code` silently never fires (`src/main/ipc/_wrap.ts`)
- **Ownership is read with `pendingRequests.owner()`, not `resolve()`.** `resolve` settles as a side effect, so checking ownership from its return value would have already delivered the answer by the time the check failed (`pendingRequests.ts:190-201`)
- **The answer is validated against the engine's enum, not against TypeScript's belief about it.** A renderer bug or a stale preload could otherwise send `'allow'`, or a flat `string[]`, and the first anyone would know is a 400 the runner logs at warn *after* the dialog told the user their answer landed

## Services & Key Methods

### `src/main/services/agentTurn/runner.ts`

`AgentTurnRunner.runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult>` — one method, **never throws**; a failed turn is a result carrying `error`.

`isFolderAgent(agent: Pick<AgentRow,'source'>)` — `source === 'folder'`. The same discriminator `resolveEndpointIfNeeded` and `resolveAccessToken` already branch on.

### `src/main/services/agentTurn/index.ts`

| Symbol | Purpose |
|---|---|
| `engineEventBus` (`:35`) | The one bus, constructed over `engineManager.request('/api/event', {Accept: 'text/event-stream'})`. Costs nothing at module load — it connects on the first subscriber |
| `engineManager.onStateChange` (`:52`) | Any non-`running` status calls `engineEventBus.shutdown()`. This is what turns "the engine stopped" into turn errors instead of hangs |
| `a2aTurnRunner` (`:63`) | `runAgentTurn` behind the shared shape. **The single place that narrows** `endpointUrl`/`cardUrl` back to required; a missing one is returned as a turn error, not thrown |
| `localDeps` (`:80`) | Every injection point: `ensureEngineRunning`, `agentKey`, `agentModel`, `skipReason`, `request`, `bus`, `getAgent` (`not_found` caught and rendered as a turn error, `:100-108`), `readSession`, `saveSession` (both stores, `:112-141`), `withLock`, `userId` |
| `resolveTurnRunner(agent)` (`:156`) | The one dispatch point, used by the IPC handler and `A2AAsMcpProvider` |

### `src/main/services/agentTurn/localAgentTurnRunner.ts`

`runTurn` (`:116`) — the guards, in order, and the order is load-bearing:

1. `getAgent` → folder gone from disk (`:120-121`)
2. **`!agent.enabled`** (`:125`) — the gate Phase 5 left to this phase, and the **only** place it exists. Pinned by the named mutation "remove the `enabled` check" → `localAgentTurnRunner.test.ts:244`, which asserts not just the error but `engine.calls === []` and `order === []`: a turn against a disabled agent must reconcile nothing and open nothing
3. `readiness === 'invalid' | 'contract_too_new'` (`:128`)
4. `ensureEngineRunning` (`:136`) — **before the lock**, because a reconcile that restarts here ends no turn
5. `agentKey` (`:141`) — null covers all three ways an agent is unaddressable; `skipReason` is the only one of them that can say what to fix
5b. `agentModel` — the `{providerID, id}` the session is opened with. Null is tolerated and means "as before": the engine picks its own default
6. `withLock(agentId, 'turn', …)` (`:152`), wrapped in a `catch` (`:155-167`) because `turnLock.acquire` **throws and never queues**

`stream` (`:170`) — the lifecycle:

| Step | Line | Notes |
|---|---|---|
| `awaitEngineReady` | impl below `heal` | `GET /api/agent` must list the agent key and `GET /api/model` must list the model, polled at 1 s up to `ENGINE_READY_MS`. **Both carry `?location[directory]=<the agent folder>`**: the engine's catalog and agent registry are per-location and boot lazily, so an unscoped probe answers for the engine's own cwd — always warm, and silent about the folder the turn will run in ([contract](opencode_contract.md) §9.5.6). The probe is also what warms that location. A probe that cannot be read (non-OK, unparseable, thrown) returns "ready" and the turn proceeds — a diagnostic must not refuse a turn on its own trouble |
| `openSession` | impl after `readList` | Verify a remembered id with `GET /api/session/{id}`; on hit, re-point it with `POST …/agent` **and `POST …/model`** (both best-effort) so a conversation survives an agent-key or runtime move; on miss, `POST /api/session {agent, model?, location:{directory}}` and require a `ses`-prefixed id |
| Build `TurnStream` + `StreamPartsAccumulator` | `:190-199` | `deltaPort.postMessage` forwards to `input.onEvent?.()` — direct chat sends it to the MessagePort, orchestrated mode wraps it, a buffered turn passes no sink |
| `settle` / `finished` | `:201-209` | Idempotent: first outcome wins |
| Turn ceiling | `:225-236` | `TURN_CEILING_MS`, `unref`'d. The backstop for doors not yet found |
| `ingest` | `:253-277` | Counts event types; captures `admittedSeq` from `session.next.prompt.admitted`'s `durable.seq`; applies to the `TurnStream`; re-ingests `update.message`; `parked.delete` **and** `pendingRequests.drop` on `update.settled`; parks on `update.asked`; settles on `update.error` / `update.idle` |
| `listener` | `:279-303` | `onDisconnect` sets a flag; `onReconnect` fires `heal`; `onClosed` settles with "The local engine stopped while the agent was answering." |
| `subscribe` → `ready()` → `prompt` | `:305`, `:310`, `:311` | **This order is the rule.** See item 1 above |
| Abort | `:306-307`, `:314-320` | On abort, `POST /api/session/{id}/interrupt` — an agent loop nobody reads keeps spending tokens |
| Settle | `:322-347` | Logs `{sessionId, agentId, admittedSeq, durationMs, outcome, lastSeq, parts, eventTypeCounts}`; saves the session in both stores; returns `parts` **even on the error branch** |
| `finally` | `:351-360` | Clear the ceiling, remove the abort listener, unsubscribe, and `cancel()` every still-parked request |

Other methods: `park` (`:371`, fire-and-forget so awaiting cannot stall the event loop still delivering this turn's other events), `reply` (`:395`, `…/permission/{id}/reply {reply}`, `…/question/{id}/reply {answers}`, and the two rejection shapes), `heal` (`:434`), `replayDurable` (`:447`, `GET /api/session/{id}/event?after=<lastSeq>` read to the end through an `SseParser`), `prompt` (`:517`), `post` (`:528`, JSON POST that tolerates 204 and empty bodies and **never logs a response body**).

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

State per turn: `messages: Map<messageId, {parts, index}>`, `requestMessage: Map<requestId, messageId>` (`:159`), `streamOwner: Map<'kind:streamId', messageId>` (`:176`), `highestSeq` (`:178`).

`apply(event)` (`:192`) → `TurnStreamUpdate {message?, asked?, settled?, idle?, error?}`. Tracks `durable.seq` into `highestSeq` first, then switches on `event.type`; **an unknown type returns `{}` rather than throwing** — 88 variants today and more in a later OpenCode.

| Event | Handler | Line |
|---|---|---|
| `session.next.text.delta` | `appendText(…, 'text')` | `:270` |
| `session.next.text.ended` | `setText(…, 'text')` — **cumulative, idempotent, never shrinks** | `:293` |
| `session.next.reasoning.delta` | `appendText(…, 'thinking')` | `:270` |
| `session.next.tool.called` | `toolCalled` | `:323` |
| `session.next.tool.success` / `.failed` | `toolResult` with `stdout` / `stderr` | `:352` |
| `session.next.step.ended` | `isTurnOver(finish)` → `{idle:true}` | `:138` |
| `session.next.step.failed` | `{error: engineErrorMessage(...)}` | `:220` |
| `permission.v2.asked` / `question.v2.asked` | `permissionAsked` / `questionAsked` | `:411`, `:452` |
| `permission.v2.replied`, `question.v2.replied`, `question.v2.rejected` | `settleRequest` | `:391` |
| `session.idle` | `{idle:true}` — **never emitted by 1.18.27**, kept as belt and braces | `:231` |
| `session.error` | `{error: …}` | `:236` |

Part identity: `slot()` (`:261`) assigns an index on first sight of a stream id and never reassigns; parts are appended, never spliced. Keys are `text:<textID>`, `thinking:<reasoningID>`, `tool:<callID>`, `result:<callID>:<stream>`, `perm:<requestID>`, `question:<requestID>`, `decision:<requestID>`.

Message identity: `streamOwner` records the **first** owner of a stream id, so a later event naming a different (or absent) `assistantMessageID` files the block where it already lives rather than duplicating the answer. It covers text and reasoning (`textID` / `reasoningID`) and, since the Phase 6 audit, tool events too — keyed `tool:${callId}` in `toolCalled` and `result:${callId}:${stream}` in `toolResult`. `requestMessage` exists because `permission.v2.replied` / `question.v2.replied` carry only `{sessionID, requestID, reply|answers}` and could not otherwise be filed next to the ask they answer; it doubles as the first-owner map for requests, which is why `permissionAsked` / `questionAsked` consult it rather than adding a second mechanism.

**The tool keys are hardening against a named unknown, not a repair of an observed defect.** Nothing has been seen duplicating a tool block. What is known is that `tool.called` / `tool.success` / `tool.failed` **are** among the durable variants the heal path replays, that the durable stream's field set on them has never been watched ([contract §7.3](opencode_contract.md#7-still-unverified)), and that the text path was defended against that unknown while the tool path was not. Removing that asymmetry is the point: a reader who saw first-owner-wins on text would reasonably conclude the file had the whole question handled. It is also the semantically right key regardless — a `callID` names one tool invocation, and one invocation does not migrate to a different assistant message. By contrast `permission.v2.*` / `question.v2.*` are **not** durable variants and cannot be replayed at all, so first-owner-wins there is internal consistency rather than defence.

A missing identifier cannot degrade the key, because there is no path to one: all four handlers return `{}` before the key is built — `toolCalled` on `!callId || !tool`, `toolResult` on `!callId || text === ''`, `permissionAsked` on `!requestId || !action`, `questionAsked` on `!requestId || !Array.isArray(data.questions)`. A dropped event is the failure mode, never two calls merged into one block.

Metadata written on parts (all from `streamPartsAccumulator`, re-exported at `:614`): `cinna.kind` (`text` | `thinking` | `tool` | `tool_result`), `cinna.tool_name`, `cinna.tool_id`, `cinna.tool_input`, `cinna.tool_stream`.

Helpers: `engineErrorMessage` (`:90`) reads **both** engine error shapes — `{name, data:{message}}` and `SessionErrorUnknown`'s `{type:'unknown', message}` — and prefixes a provider id when one is named, because a rotated key is the failure a user is most likely to hit. `mapQuestions` (`:497`) normalises OpenCode's `multiple` → the desktop's `multiSelect` and drops `custom`. `renderToolOutput` (`:586`) prefers `content[]` over `structured` and names files rather than inlining them. `permissionDecisionText` (`:541`) / `questionDecisionText` (`:563`) produce the transcript's decision record.

Every text-bearing writer carries a `length >=` guard (`:318`, `:347`, `:370`, `:406`), which is what makes a durable replay tolerant of re-delivered events whether `?after=` turns out to be inclusive or exclusive.

### `src/main/services/agentTurn/sseParser.ts`

`feed(chunk)` (`:42`) → completed blocks. Normalises `\r\n` / `\r` / `\n` to `\n`, keeps the trailing partial line in `pending`, accumulates `data:` values, completes a block on a blank line, strips exactly one leading space from a value, and discards `event:` / `id:` / `retry:` — the engine puts its own discriminator inside the JSON, so branching on the SSE `event:` name would be reading a weaker second copy.

`reset()` (`:110`) is called by the bus on **every new body** (`engineEventBus.ts:306`) so a half-line from a dead socket cannot be glued onto the first line of the new one.

The comment-line skip at `:73` carries an *honest note*: it is behaviourally redundant under the current field split (a comment's colon is at index 0, so `field === ''` and the line is dropped anyway) and no test pins it. Kept as an explicit statement of the SSE rule and because it stops being redundant the moment the field split changes.

### `src/main/services/agentTurn/pendingRequests.ts`

Module-level `entries: Map<requestId, Entry>` and `timers: Map<requestId, Timeout>`. `Entry` is `{chatId, agentId, kind, settle}`.

| Method | Line | Contract |
|---|---|---|
| `register(…)` | `:68` | Returns `{answered: Promise<RequestResolution>, cancel}`. A second registration under the same id **settles the first as rejected** so a replayed ask cannot leave an orphan promise. Arms an `unref`'d `REQUEST_PARK_TIMEOUT_MS` timer whose expiry sends a real rejection rather than abandoning the request. `settle` checks `entries.get(id)?.settle === settle` (`:95`) so a stale handle cannot delete the entry that replaced it |
| `resolve(id, resolution)` | `:142` | The renderer's path. Returns `{chatId, agentId}` or `null`; refuses a mismatched kind (`:148`) rather than posting a permission answer to a question endpoint |
| `drop(id)` | `:179` | The **engine's** path — used when `permission.v2.replied` / `question.v2.*` says the engine already settled it. Deliberately not `resolve()`, which would make the runner POST a redundant reject |
| `owner(id)` | `:198` | Ownership without consuming |
| `listForChat(chatId)` | `:204` | What `agent:pending-requests` returns |
| `clear()` | `:213` | Tests and shutdown only |

Nothing in this module speaks HTTP. It holds *resolvers*; the runner owns the request that posts a reply, because the runner is what knows the session id and holds `engineManager.request` — the same "one door to the engine" rule Phase 5 set.

## Data Shapes

### `RunAgentTurnInput` → `RunAgentTurnResult`

The shared turn primitive (`a2aStreamingService.ts:98` and `:142`), unchanged except for two widened fields.

**In:** `chatId`, `agentId`, `agentName`, `endpointUrl?`, `cardUrl?`, `accessToken?`, `wireContent`, `fileIds?`, `isCinnaTokenAuth?`, `signal: AbortSignal`, `onEvent?`, `onClient?`, `onTaskId?`.

**Out:** `text` (compact, for an orchestrator LLM), `parts: MessagePart[]` (full fidelity, for the UI), `notices: AccumulatedNotice[]`, `contextId?`, `taskId?`, `taskState?`, `error?: {message, raw, code?}`.

The local runner fills `text`, `parts`, `notices`, `contextId` (the engine session id) and `error`. It never sets `taskId` / `taskState` — those are A2A task bookkeeping — and it ignores `onClient` / `onTaskId`, which exist for the A2A SDK's cancel path (a local cancel goes to `POST …/interrupt` instead). `fileIds` and `isCinnaTokenAuth` are inert on this path.

### `EngineEvent`

`{type: string, id?, durable?: {aggregateID, seq, version}, location?, data?: Record<string, unknown>}` (`engineEvents.ts:73`). `type` is an **open string**, not a closed union, and `data` is deliberately loose — every field is read through a per-variant accessor that validates as it goes, because this JSON crossed a socket from a separately-versioned binary.

`eventSessionId` (`:108`) is total by construction: it runs on every event off a stream shared by every agent, so a malformed or unattributed event must be `null`, never a throw and never a wrong id. It requires the value to be a string starting `ses`.

### `TurnStreamUpdate`

`{message?, asked?, settled?, idle?, error?}` (`turnStream.ts:63`). The runner acts on each field independently; `message` is the **whole cumulative message**, for re-ingestion.

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
| `TURN_CEILING_MS` | `localAgentTurnRunner.ts:68` | 20 min | Not a model timeout — a ceiling on *never settling*. Generous because a ceiling that fires on a working turn is worse than none. Overridable via `LocalTurnDeps.turnCeilingMs` **in tests only** |
| `ENGINE_READY_MS` | `localAgentTurnRunner.ts` | 60 s | A cold `opencode serve` answers `GET /api/health` **30–60 s** before `GET /api/model` returns anything or a config-defined agent is addressable ([contract](opencode_contract.md) §9.5.6). Both failures in that window are silent: an unresolvable model raises `ModelUnavailableError` **on no event at all**, so the turn ran to `TURN_CEILING_MS`; an unloaded agent runs the turn **with no system prompt**. Overridable via `LocalTurnDeps.engineReadyMs` **in tests only** |
| `REQUEST_PARK_TIMEOUT_MS` | `src/shared/localAgentRequests.ts:84` | 10 min | Bounds an abandoned dialog. The turn holds its lock while parked and a config change defers while *any* lock is held, so unbounded this turns one open modal into an app-wide stall |
| `RECONNECT_DELAYS_MS` | `engineEventBus.ts:53` | 250/500/1000/2000/5000 ms | Capped backoff; the counter resets on every successful connection |
| `POLL_MS` | `useAgentRequests.ts` | 700 ms | Renderer poll while streaming. One synchronous main-process map lookup per tick |
| `ALWAYS_GRANTS_ENABLED` | `src/shared/localAgentRequests.ts:135` | `false` | The *Always* button is withheld. **Do not flip this to ship Always** — the observation that would have justified it was done and its result is that flipping it is wrong. See [opencode_contract.md §4](opencode_contract.md#4-the-permission-scoping-defect--proven-end-to-end) |

## Security

- **Invariant 4 — no secret crosses to the renderer.** The engine's base URL and per-start Basic-auth password stay inside `engineManager`; this slice reaches the engine only through `engineManager.request`, and no IPC channel exposes that seam. What the renderer receives is stream events and message parts, exactly as for a remote agent
- **No engine response body is ever logged** (`localAgentTurnRunner.ts:521-546`). `GET /config` returns the resolved config with `{env:…}` substituted, so its body contains live API keys — and it is not the only endpoint that can carry one
- **Chat ownership is checked on both new channels** (`agent_a2a.ipc.ts:316`, `:352`) with `chatRepo.getOwned(getProfileScopeUserId(), chatId)`, and on `answer-request` it is checked **before** the request is consumed
- **Both new channels are activation-gated** (`userActivation.requireActivated()`)
- **Answer shapes are validated against the engine's own enum**, not against the renderer's word for it — a wrong shape is refused rather than delivered to the wrong endpoint (`agent_a2a.ipc.ts:329-341`, plus the kind check in `pendingRequests.resolve`)
- **A persisted request block is read-only.** `isEngineRequestId` (`src/shared/localAgentRequests.ts:64`) separates a live engine address from a cloud agent's question id, and the main-process registry is the only authority on whether it is still answerable — so a reopened chat cannot re-answer a dead request
- **The permission tool name is reserved and un-model-emittable** (`cinna_permission_request`), so an agent's own call to `bash` or `edit` can never be mistaken for a request to run one

## Testing notes

**Every test in this slice fakes the socket to `opencode`.** What is *not* faked is as important: the real `EngineEventBus`, the real `TurnStream`, the real `StreamPartsAccumulator` and the real `pendingRequests` registry are wired together in `localAgentTurnRunner.test.ts`. Only HTTP and the three deps needing a database or disk are replaced. The split is deliberate — every defect this slice can still have is a defect of *sequence*, and a test that stubs the bus sees none of them.

The fakes were **corrected against real turns** run with a live credential. Confirmed on real data: deltas are true deltas and `text.ended` is cumulative; `session.next.text.delta` carries no `durable` block at all; `admittedSeq` matches `session.next.prompt.admitted`'s `durable.seq`; tool failures use the `{type:'unknown', message}` shape; the permission flow fires headless. Contradicted outright — and the fakes had implemented both *faithfully from the OpenAPI document* — `session.idle` is never emitted and `POST …/wait` answers 503. A fake can only be as right as the contract you believed when you wrote it.

Ordering assertions need care. `bus.subscribe()` issues its transport call **synchronously**, so recorded call order is identical whether or not `ready()` was awaited; only a socket that does not resolve in a microtask distinguishes them (`localAgentTurnRunner.test.ts:298`). This was one of five mutation survivors in the phase, every one the same shape: a test that only exercised the easy input.

Two lines carry an explicit *honest note* saying no test pins them and none should claim to: `engineEventBus.ts:170-180` (currently unreachable, kept as defence behind the generation fix) and `sseParser.ts:73` (behaviourally redundant under the current field split). A `[...set]` snapshot in `dispatch` was written and then **removed** once the mutation meant to justify it passed the whole suite (`engineEventBus.ts:380-388`) — do not add it back without a test that fails without it.

## What is not verified

See [agent_turn.md § What is not verified](agent_turn.md#what-is-not-verified) for the argued list, and [opencode_contract.md §7](opencode_contract.md#7-still-unverified) for the engine-side gaps. In short, from this slice's side:

- No turn has been watched through a **real** reconnect. The heal path is covered against a fake that drops and restores a stream (`localAgentTurnRunner.test.ts:566`), but the durable stream's own field set on a replayed `text.ended` is unobserved — `streamOwner` exists because of that
- Whether a global-stream `durable.seq` is a valid `?after=` cursor on the per-session stream is unverified and **silent when wrong**; the never-shrink guards absorb a replay that starts too early, nothing reports one that starts too late
- Which `finish` values actually occur beyond `stop` and `tool-calls`. Mitigated by terminate-by-default plus the per-turn `eventTypeCounts` line the runner logs (`localAgentTurnRunner.ts:324-333`), so the question can be answered from a user's log
- Where a permission or question falls relative to the text stream
- **The independent mutation audit has now been run** (3 September) on `engineEventBus.test.ts`, `turnStream.test.ts` and `localAgentTurnRunner.test.ts`. 45 mutations, **13 survivors, all fixed** — each re-run with the identical mutation afterwards to confirm it then fails a named test; suite 758 → 771. A further 13 survivors are **deliberately uncovered**, each shielded by a second mechanism such that no input separates the code from its absence; each is recorded in its file with the reason and a note that the guard remains load-bearing. Of the 13 fixed: three were a test named for a contract whose branch it never executed, nine were plain holes with no test at all, one was reachable only across a seam. It hardened the tests, **not** the engine contract — all 771 still run against a fake at the HTTP boundary

The plan's "Phase 6 debt" entry claiming the reconnect path has **no test** was stale — it described a design that used `POST /wait`, removed once the binary showed it returns 503 — and has since been corrected. The heal path has a test; what it does not have is a *real* reconnect.

**The fixture behind that test had to be corrected before the claim could stand**, and the correction is the part worth remembering. It gave its `session.next.text.delta` a fabricated `durable` block, which the verified contract says a real delta never carries — so the fixture contradicted the contract, the same failure mode that made the `session.idle` and `POST /wait` fakes confidently wrong. The cursor now rides `session.next.text.started` (seq 7), matching the observed trace `admitted(1) → prompted(2) → step.started(3) → text.started(4) → deltas (no durable) → text.ended(5) → step.ended(6)`. The test passes with unchanged assertions, still asserting `?after=7`, and all three named mutations still fail it. The old version proved `?after=` works when a cursor happens to sit on a delta — a shape production never emits.

That also split the coverage into two genuinely distinct branches: `heals a mid-turn stream drop from the durable stream alone` is the drop-*after*-`text.started` case, and `replays the whole durable stream when the socket dies before any cursor exists` is the drop-*before*-any-durable-event case. Neither is reachable from the other's input — the `const query = ''` mutation fails the first and **passes** the second, which structurally cannot distinguish it.
