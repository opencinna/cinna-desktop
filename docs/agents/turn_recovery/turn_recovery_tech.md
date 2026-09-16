# Interrupted Turn Recovery: Technical Details

## File Locations

**Main process: storage**
- `src/main/db/inflightTurns.ts`: `inflightTurnRepo` (markers, the draft row, row replacement and notice placement), `markLiveMarker` / `isLiveMarker`, `TurnUserRowGone`
- `src/main/db/migrations/inflight-turns.ts`: `migrateInflightTurns()`, registered in `src/main/db/migrations/index.ts` right after `migrateChatRunResults`
- `src/main/db/schema.ts`: `inflightTurns`. `managedAgentSessions` gains `kickoffEventId` / `kickoffMessageId`
- `src/main/db/migrations/a2a-sessions.ts`: the two `managed_agent_sessions` kickoff columns
- `src/main/db/managedAgentSessions.ts`: kickoff fields on `ManagedCheckpoint`, which are stored only with `inflight`
- `src/main/db/messages.ts`: `saveAssistant` now returns the id, plus `updateAssistantParts()` and `deleteById()` for the draft
- `src/main/db/jobs.ts`: `jobRunsRepo.listUnfinishedChatTurnRuns()` for the orphan sweep

**Main process: the live turn**
- `src/main/services/a2aStreamingService.ts`: `streamToAgent` (`marker`, `touchChat`, draft timer, `save`/`flush` through `inflightTurnRepo.replaceDraft`), `saveInFlight()` (flush with `touch: false`), `runAgentTurn` (`messageId`, `renewAccessToken`, `saveFirstIds`, `sawFinal`, `collectFromServer`, `finishTurn`), `a2aInputRequestOf()` / `askToolQuestionsOf()`
- `src/main/agents/a2aTaskCollect.ts`: `collectTask()`, `readTask()`, `replyLost()`, `isCutOff()`, `serverCopyWins()`, `collectPollDelays`, `COLLECT_HISTORY_LENGTH`, the `cinna.*` history keys
- `src/main/agents/outputSize.ts`: `outputSizeOf()`, `isAtLeastAsRich()`, `NO_OUTPUT`. Free of Electron and the database, so the live turn and recovery share it
- `src/main/agents/a2aTransport.ts`: `isTransportDrop()`, `isTransientHttpStatus()`, shared by the stream, the collector and the recoverer
- `src/main/agents/streamPartsAccumulator.ts`: `ingestMessage(…, { replay })`, `replayMatch()`
- `src/main/agents/a2a-client.ts`: `buildSendParams(…, messageId)`. `createA2AClient`'s `turnFetch` gives `tasks/cancel`, and a `tasks/get` sent after the turn's signal aborted, their own 10 s signal
- `src/main/agents/drivers/driver.ts`: `RunInput.messageId`
- `src/main/agents/drivers/a2aDriver.ts`: forwards `messageId`, passes `renewAccessToken`, and confirms a stop (`answeredState()`, `CANCEL_ANSWER_WAIT_MS`, `CANCEL_READ_WAIT_MS`, `A2aDriverDeps.saveTaskState`)
- `src/main/agents/drivers/index.ts`: wires `saveTaskState` to `agentSessionRepo.upsert`
- `src/main/services/runExecutionService.ts`: `runAgentTurn` passes the user row id and the marker (not for `runnerOwned`), `bindTurn()`, `resendAgentTurn()`, `runExecutionService.adopt()`

**Main process: launch and recovery**
- `src/main/services/interruptedTurnService.ts`: `interruptedTurnService.finalizeLeftovers()`, `finalizeInterrupted()`, `isSuperseded()`, `isRecoverable()`, the interrupted notice and outcome constants
- `src/main/services/turnRecord.ts`: `recordTurnResult()`, `terminalEventOf()`, `runResultStatusOf()`
- `src/main/services/turnRecoverers.ts`: `TurnRecoverer`, `RecoveryPlan`, `RecoveryIO`, `RecoveryResult`, `DeferReason`, the registry (`registerRecoverer`, `hasRecoverer`, `recovererFor`) and the notice strings. Kept apart from the service so the boot pass can ask `hasRecoverer` without an import cycle
- `src/main/services/remoteTurnRecoveryService.ts`: `remoteTurnRecoveryService.resume()` / `onRetryDue()`, `RECOVERY_RETRY_MS`
- `src/main/agents/drivers/a2aTurnRecoverer.ts`: `createA2aTurnRecoverer()`, `PLAN_TIMEOUT_MS`
- `src/main/agents/drivers/managed/managedTurnRecoverer.ts`: `createManagedTurnRecoverer()`, `PROBE_TIMEOUT_MS`
- `src/main/agents/drivers/managed/managedRun.ts`: `followManagedSession()`, `unreachableReason()`, `ManagedRunResult.unreachable`, the kickoff save
- `src/main/agents/drivers/managed/managedEvents.ts`: `queuedConfirmationsAnswer`, `seen()`, and the split `assertReady` refusals
- `src/main/agents/drivers/index.ts`: `a2aTurnRecoverer`, `managedTurnRecoverer`, wired with the drivers' own credential and binding resolution
- `src/main/auth/activation.ts`: `userActivation.onProfileReady()`, `credentialsRenewed()`
- `src/main/services/authService.ts`: calls `credentialsRenewed` after a re-auth of the active profile
- `src/main/index.ts`: `startup()` wiring and the `powerMonitor` resume trigger

**Preload / renderer**: nothing new. An adopted run goes through the existing live-run watch.

## Database Schema

**`inflight_turns`** (`migrations/inflight-turns.ts`, creation only)

| Column | Notes |
|---|---|
| `id` | the wrapper's request id, which is also the adopted run's id |
| `profile_id` | the profile the turn belongs to. Recovery takes only the active profile's markers |
| `chat_id` | FK → `chats`, `ON DELETE CASCADE`. Indexed |
| `agent_id` | the agent that answers |
| `driver` | `a2a`, `managed`, `acp`, …, which selects the recoverer |
| `user_message_id` | the user row the turn answers. A runner-originated send is always runner-owned, so it never has a marker. A marker without this id is settled as interrupted by both recoverers |
| `draft_message_id` | the current draft row. It has no FK, because the draft is deleted and replaced while the marker only points at it |
| `started_at` | ms timestamp. `list()` returns oldest first |

**`managed_agent_sessions`**: new nullable columns `kickoff_event_id` and `kickoff_message_id`. `save()` keeps them only when the state is `inflight`. Saving any other state, or the first `inflight` save of a new turn (which has no id), clears both, so a finished turn is never followed again. `runManagedSession` clears a previous turn's kickoff before its first request.

**`a2a_sessions`**: no schema change. The row is now upserted from the first stream event that carries a task id (`taskState: null`) as well as at the end of the turn. `task_state` is also written by a confirmed live Stop (whose turn skips the end-of-turn save) and by a settled recovery. Stop passes a null context id and recovery passes null for both ids, which `upsert` reads as "keep".

## IPC Channels

None added. A recovered turn reaches the renderer as an ordinary active run: `chat:list` / `chat:get` report it through `activeRunsByChat`, and the run watch replays its events from `liveRunHub`.

## Services & Key Methods

### The live turn
- `a2aStreamingService.streamToAgent({ marker, touchChat })`: before `run`, `inflightTurnRepo.open()` then `markLiveMarker()`. A failure is logged and the turn runs without a marker, and so without a draft (the draft timer and the forced write check the opened `markerId`). In `finally` it calls `inflightTurnRepo.delete()`. `writeDraft()` runs on a `DRAFT_INTERVAL_MS` (2 s) interval and is forced on a `needs_input` event. It fingerprints `cursor.parts`, the part count, text length and tool name/stream/input length, and skips an unchanged draft. It rate-limits past `DRAFT_LARGE_BYTES` (256 KB) to `DRAFT_LARGE_INTERVAL_MS` (10 s), and skips past `DRAFT_MAX_BYTES` (4 MB), measured by `Buffer.byteLength` only when the length estimate × 6 could pass it. `save()` wraps `persistTurn` in `inflightTurnRepo.replaceDraft()`. `touchChat: false` (used by resends) and `flush({ touch: false })` (used by `saveInFlight`) skip `messageRepo.touchChat`
- `runAgentTurn`: `setStreamTaskId()` records `streamTaskId` and calls `saveFirstIds()` once. A failed early upsert is logged, and the end-of-turn upsert tries again. `sawFinal` is set by a `final: true` status update, or by a bare message with no task id before any task id was seen. After the stream loop, `!sawFinal` → `finishTurn(await collectFromServer())`. In the `catch`, a non-aborted `isTransportDrop` error after at least one event is collected too: any supported answer replaces the drop's error, and an unsupported one leaves the error path as it was. `collectFromServer()` returns null unless there is a client, a `streamTaskId` (never the remembered id) and a `messageId`. It polls through a getter that uses the stream's client until `renewClient` drops it, then builds one with `renewAccessToken()` (the driver maps `CinnaReauthRequired` to a 401 `A2aHttpError`). `transientStatusUnreachable` and `rideOutFirstRead` are both `isCinnaTokenAuth` (a synced agent). The first `onPoll` posts one `delta` of kind `notice` with `STILL_RUNNING_NOTICE`, which is live only: persistence reads the result's notices, never the event stream. An `unauthorized` result on a Cinna agent throws a 401 `A2aHttpError`, so both call sites end in the `catch`'s re-auth outcome (`CINNA_REAUTH_REQUIRED_CODE`); any other unsupported result returns null. A supported one whose `replyLost()` holds is reported as `aborted`. It posts a `status` event and, for `input-required` / `auth-required`, a `needs_input` with `resume: 'next_message'`. `finishTurn()` reads the collected parts, text and notices when `serverCopyWins(collected, outputSizeOf(accumulator.snapshotParts()))`, otherwise the accumulator's, in both cases with the collected state. It upserts the session and maps `aborted` to `CUT_OFF_NOTICE` / `REPLY_CUT_OFF_CODE`; `streamToAgent` saves that error row without a `detail`. The non-streaming branch never collects
- Replayed status messages: a streamed `status-update` with `final: true`, and a streamed `task` whose state is past `submitted` / `working`, are ingested with `{ replay: true }`. `replayMatch()` skips a part that repeats an accumulated one: by `toolId` when both have one, otherwise by kind, tool name, stream, text and (when both have it) tool input, with each accumulated part matching at most once, and notices matched by text. `a2aInputRequestOf` still reads the whole message
- `a2aInputRequestOf(state, message)`: the `text` parts form one open question. With no text, `askToolQuestionsOf()` reads `cinna.tool_input.questions` from the last `askuserquestion` tool part (question, header, options with descriptions, `multiSelect`), dropping entries without question text. With neither, the question is *"What should the agent do next?"*. `auth-required` is unchanged
- `collectTask()`: the first read (or `initial`) must have a `cinna.client_message_id` or `cinna.message_state` key somewhere in its history, otherwise the result is `{ supported: false, reason: 'unsupported' }`. With `rideOutFirstRead` and no `initial`, an `unreachable` first read is asked again on the poll schedule (through `renewClient` on a refusal) until an answer arrives or `dropsForMs` passes from the first failure; a refusal or an unusable answer still ends it. `readTurn()` finds the last user message with our id and reads agent messages up to the next user message. The turn is over when the task is not `working` / `submitted`, or when a later user message follows and the last agent message is not `streaming`. `hasReply` is true when those messages rebuild into at least one part or notice. `answeredWithNext` is set when ours has no agent message but one follows the next user message. Polls wait `fastMs` 2 s for the first `fastForMs` 120 s, then `slowMs` 5 s. `unreachable` answers are ridden out for `dropsForMs` (10 min). With `transientStatusUnreachable` (recovery always; the live turn only for a synced Cinna agent), a 408, 429 or 5xx (`isTransientHttpStatus()`) counts as `unreachable` instead of `unsupported`. A 401/403 calls `renewClient` once and asks again. The function rejects only with the abort reason
- `replyLost(collected)`: found, no reply, not `answeredWithNext`, and a state that is neither running nor `canceled` / `input-required` / `auth-required`. `isCutOff(collected)`: the state is not `completed` / `input-required` / `auth-required`, or `lastAgentState` is `streaming` / `aborted` / `canceled`. `serverCopyWins(collected, local)`: false without `found` and `hasReply`; otherwise true unless `isCutOff`, in which case `isAtLeastAsRich(outputSizeOf(collected.parts), local)` decides (text length, then part count, a tie to the server)
- Live Stop (`a2aDriver.ts`): `onAbort` sends one `tasks/cancel` and reads its answer with `answeredState()`. A `canceled` or `completed` state confirms. An answer with a `result` but no state (older backend `{}`) starts one `tasks/get` on the same client, where only `canceled` confirms, because that backend still reports the previous turn's `completed` for a turn stopped before its first output. The turn waits `CANCEL_ANSWER_WAIT_MS` (500 ms) for the cancel and then `CANCEL_READ_WAIT_MS` (1 s) for that read. A confirmed stop calls `saveTaskState` (a failure is logged). Otherwise the unconfirmed-stop notice is added
- `isTransportDrop()`: positive classification. It matches undici/socket/DNS codes on the error or its `cause`, or a code-less `TypeError: fetch failed` / `terminated`. These are never drops: `A2aHttpError`, a JSON-RPC error frame, `AbortError` / `TimeoutError`, and any other code
- `isTransientHttpStatus()`: 408, 429 or 5xx, read from `AgentCardFetchError.status`, `A2aHttpError.status`, or the SDK's plain `Error` message `HTTP error for <method>! Status: <n>`
- `runExecutionService.adopt(scope, { chatId, agentId, runId, observe, hiddenMessageIds }, drive)`: refuses (throws) a busy chat, just as `start` does for an active run, runner, handoff or unresolved handoff. It opens `liveRunHub` with a baseline that leaves out `hiddenMessageIds` and registers the handle in `activeRunsByChat`. `AdoptedRunIO` offers `post` (live only), `observe` (inbox record, then post) and `resend(userMessageId)`. It saves nothing and records no result. `drive` does both. On close it posts `terminalEventOf(outcome)` if no terminal was posted and turns `completed` with open next-message or runner requests into `needs_input`. `cancel()` aborts `io.signal` and cancels a resend's request id
- `resendAgentTurn()`: rebuilds the send from the saved user row: its text, attachment ids and a catch-up packet of the rows before it. The row id is the `messageId`. It runs through `streamToAgent` with `touchChat: false` and no marker. A refusal before streaming saves an error row, because the turn's rows were removed for the resend. So does a `handOff` refusal (the stream threw after it owned the port), which posts no second error event: `handOff` has posted one

### Launch
- `startup()` order: `initDatabase()` (whose `taskInputRequestRepo.expireOpen()` expires driver reply asks), `initSession()`, `taskRuntimeService.recover()`, `registerRecoverer('a2a' | 'managed')`, `interruptedTurnService.finalizeLeftovers()`, `userActivation.onProfileReady(resume)`, `remoteTurnRecoveryService.onRetryDue(…)` (checks the profile is still active), then IPC registration. `powerMonitor` resume calls `resume(getCurrentUserId())` when activated
- `finalizeLeftovers()`: for each marker that is not live and not recoverable, `finalizeInterrupted(marker, INTERRUPTED_OUTCOME, { notice: INTERRUPTED_NOTICE })`. Then `finalizeOrphanedRuns()` → `jobService.setRunStatus(…, 'failed', INTERRUPTED_RUN_MESSAGE)`
- `finalizeInterrupted(marker, outcome, { notice })`: when the turn is not superseded, it records `inboxService.recordRunEvent(terminalEventOf(outcome))` (skipped when parked on a next-message ask of this agent) and `recordTurnResult()` (`needs_input` when parked). It always calls `inflightTurnRepo.settle()`, which writes the notice and deletes the marker in one transaction. The notice row has no `detail` (`detail: null` to `saveError` / `errorContent`), so it shows no Details toggle; the A2A cut-off row is written the same way. For a superseded turn the notice goes through `insertUnderTurn()`
- `userActivation.onProfileReady()`: listeners are told after `activate()` opens the gate, and again from `credentialsRenewed()` when the re-authed user is the active one. A throwing listener is logged and skipped

### Recovery
- `remoteTurnRecoveryService.resume(profileId)`: selects the markers of that profile that are not live and hands each to `enqueue()`. The per-chat `chains` run a chat's markers in order, and `inProgress` stops two triggers from taking one marker. A `network` defer calls `scheduleRetry()`: one unref'd `RECOVERY_RETRY_MS` (2 min) timer per profile. The method never rejects
- `recoverOne()`: `plan()` handles `defer` and `interrupted` first. The service then waits out `activeRunsByChat`, re-reads the marker, and calls `adopt()` with `hiddenMessageIds = turnRowIds(marker)` when the plan sets `replaysLive` (Managed), and none otherwise (A2A). Inside `drive`: `RecoveryIO.notice` posts one live `notice` delta, and `event` is `io.observe` with terminal events dropped. `resend` refuses (`ResendRefused` → interrupted) when the user row is gone, a later user row follows it, or `turnRowIds` is not empty. `hasRows` is `turnRowIds(marker)` not being empty. `savedOutputSize` is `outputSizeOf` over the parts of those rows that are assistant rows (a row without parts counts as one text part of its content; notices are left out). A `recover` that throws settles as interrupted. A `defer` from the plan or from `recover` settles as interrupted when `waitedTooLong()` (reason `network` and `startedAt` older than `RECOVERY_GIVE_UP_MS`, 24 h). Otherwise a `defer` result calls `abandonReplyAsks()` (`inboxService.recordRunEvent` with a `done` event and `completionOwner: 'runner'`: the run's reply asks are expired and the task leaves `needs_input`, its outcome unwritten), posts `{ type: 'done' }` and resolves `DEFERRED_OUTCOME` (`canceled`, which nothing records), so a queue behind the run is held
- `applyCollected()`: `inflightTurnRepo.replaceTurnRows()` deletes the draft and this agent's assistant/`agent_transition` rows between the user row and the next user row, shifts later rows down and inserts the recovered rows under the user row. A result with `keepRows` writes nothing (`keptTurnRows()` checks the user row and returns the rows as they are, the draft included). Unless the turn is superseded, it then runs `onSettled` (a throw is logged), opens the ask and advances `chatAgentCursorRepo` on `completed` / `needs_input`. Last, it calls `finalizeInterrupted(marker, outcome)` with `keepRows.notice` as the notice when there is one, and without a notice otherwise; `settle()` puts that card at the chat's end, or under the turn's rows when it is superseded. `TurnUserRowGone` settles the turn as interrupted
- `createA2aTurnRecoverer().plan()`: the turn is interrupted without a user row, an agent with a card URL, an endpoint or an `a2a_sessions.task_id`. `resolveEndpoint` / `resolveAccessToken` / `createA2AClient` run under `PLAN_TIMEOUT_MS` (30 s). A re-auth, or a 401/403 on a Cinna-auth agent, defers with `auth`. A transport drop, a 408/429/5xx (`isTransientHttpStatus`) or the timeout defers with `network`; `within()` races the endpoint and token resolution against the plan signal. The first `readTask()` (with `transientStatusUnreachable`) gives `unreachable` → `network`, `unauthorized` → `auth` (Cinna) or interrupted, and any other failure → interrupted. `recover()` polls through a lazily built client bound to `io.signal`, rebuilt after `renewClient`, and calls `io.notice(STILL_RUNNING_NOTICE)` on each poll. A client that cannot be built for a re-auth or an auth rejection reads as a 401, so a second refusal while polling goes through `refused()` like the plan's: `auth` for a Cinna agent, interrupted otherwise. A result that is not found is resent only when `historyFull` is false. A found one goes through `collectedResult()`: `replyLost` gives a failed outcome with `keepRows: { notice: CUT_OFF_CARD }` and saves `aborted`. `keepsRows()` (`io.hasRows()` and not `serverCopyWins(collected, io.savedOutputSize())`) gives the collected outcome with `rows: []` and `keptEnding()` (the cut-off card for `aborted`, the task-failed card for a failed outcome). Otherwise `rowsOf()` gives the rows. Each carries `onSettled: saveStateOf(session, state)`, an `agentSessionRepo.upsert` of the state alone. `stopTurn()` uses its own 30 s bound: `cancelTask`, then one `collectTask` aborted at its first poll. Not supported or not found gives `kept` with `canceled`. No reply, or `keepsRows`, gives `collected` with `keepRows` and the canceled outcome. Otherwise the server's rows are used. Both `collected` results save the state
- `createManagedTurnRecoverer().plan()`: the turn is interrupted without a user row, a `managed` agent row, a parseable config or a `prepare()`d binding. `readiness()` throwing defers with `auth`. `targetOf()` requires `inflight` + `kickoffEventId` + `kickoffMessageId === userMessageId`. `sessions.retrieve` is probed with `PROBE_TIMEOUT_MS` and no retries, and `unreachableReason` defers. `recover()` calls `prepare()` again and interrupts if the target moved, then calls `followManagedSession()` with `onStillRunning` → the notice. The plan sets `replaysLive`. `resultOf()`: an `unreachable` result that was not canceled defers. A cancel gives `collected` when there are rows, otherwise `kept`. An error without parts is interrupted, and an error with parts is `collected` with an error row. The `budget` stop reason gives `budget`
- `followManagedSession(binding, agentId, input, deps, { sessionId, kickoffEventId }, hooks)`: shares `managedSession()` with `runManagedSession` in `follow` mode. It sends and creates nothing, and `workMayExist` is true from the start, so Stop interrupts. It starts the reducer at the kickoff with `queuedConfirmationsAnswer`, attaches, reads full history (a finished turn returns here) and throws `UnknownKickoff` if the kickoff is not in that history. It calls `onStillRunning` before streaming. Two reconnects past a `StreamLost` or API failure return `{ unreachable }` without interrupting or saving anything. Any other failure saves `uncertain`; once `reducer.seen(kickoffEventId)`, it first interrupts the session, as a live turn's failure does
- `runManagedSession()` kickoff: after `events.send` it saves `inflight` with `{ eventId, messageId: input.messageId }`. A failed write is logged, not thrown, because the turn is already running
- `ManagedEvents.assertReady()`: refuses a session that is `terminated`, one paused at `budget_reached`, one that is not idle or is still `running` ("still working on an earlier message"), one with queued inputs ("still queued") or one at `requires_action` ("waiting for a permission decision"). `end_turn` and `retries_exhausted` are ready, and a `retries_exhausted` idle clears queued inputs, as the SDK documents

## Configuration

| Constant | Value | Where |
|---|---|---|
| `DRAFT_INTERVAL_MS` / `DRAFT_LARGE_INTERVAL_MS` | 2 s / 10 s | `a2aStreamingService.ts` |
| `DRAFT_LARGE_BYTES` / `DRAFT_MAX_BYTES` | 256 KB / 4 MB | `a2aStreamingService.ts` |
| `collectPollDelays` | 2 s for 120 s, then 5 s. Drops ridden out 10 min | `a2aTaskCollect.ts` |
| `COLLECT_HISTORY_LENGTH` | 50 | `a2aTaskCollect.ts` |
| `PLAN_TIMEOUT_MS`, stop bound | 30 s, 30 s | `a2aTurnRecoverer.ts` |
| `CANCEL_ANSWER_WAIT_MS` / `CANCEL_READ_WAIT_MS` | 500 ms / 1 s | `a2aDriver.ts` |
| `tasks/cancel` and post-stop `tasks/get` request bound | 10 s | `a2a-client.ts:createA2AClient()` |
| `PROBE_TIMEOUT_MS` | 30 s | `managedTurnRecoverer.ts` |
| `RECOVERY_RETRY_MS` | 2 min | `remoteTurnRecoveryService.ts` |
| `RECOVERY_GIVE_UP_MS` | 24 h (`network` defers only) | `remoteTurnRecoveryService.ts` |

No user setting or environment variable.

## Security

- Recoverers resolve credentials through the same functions as their drivers (`resolveEndpointIfNeeded`, `resolveAccessToken`, `managedAgentService.readiness` / `prepare`), and the credentials stay in main. The Managed follow re-checks the captured binding like a live turn does, so a changed credential, configuration or profile refuses to follow
- A marker is recovered only under its own profile, with the settings scope of the current session
- The `messageId` sent to the agent is the local user row id, a nanoid. It carries no content

## Verification

- `src/main/agents/a2aTaskCollect.test.ts`: gating, turn boundaries, states, poll schedule, drops, a first read ridden out with `rideOutFirstRead`, 408/429/5xx with and without `transientStatusUnreachable`, renewal, `replyLost` and `serverCopyWins`
- `src/main/agents/outputSize.test.ts`: the richness order and its tie
- `src/main/agents/streamPartsAccumulator.test.ts` ("replay"), `src/main/agents/drivers/golden.a2a.test.ts` with `__golden__/a2a/input_required_replayed_tool.*`: a replayed question tool part is not shown twice
- `src/main/services/a2aStreamingService.inflight.test.ts`: marker lifetime, draft writes and limits, draft replacement, quit flush without touch
- `src/main/services/a2aStreamingService.test.ts`, `src/main/agents/drivers/golden.a2a.test.ts` with its `__golden__/a2a` fixtures: early session upsert, collection on a missing `final` and on a drop
- `src/main/services/a2aCancellation.test.ts`: a stopped streaming turn keeps only the ids its first task event saved
- `src/main/services/interruptedTurnService.test.ts`: boot pass, parked and superseded turns, orphaned-run exclusions
- `src/main/services/remoteTurnRecoveryService.test.ts`: plans (including 502/503 and a slow endpoint or token), adopt and the visible baseline, row replacement, resend guards and a failed hand-off, Stop, defer and retry, the 24-hour give-up, the asks a deferred run leaves, a message sent during recovery
- `src/main/services/managedTurnRecovery.test.ts`, `src/main/agents/drivers/managed/managedRun.peer.test.ts`: follow against the SDK peer, kickoff storage, admission refusals
- `src/main/auth/activation.test.ts`, `src/main/services/authService.test.ts`: profile-ready notifications
- `src/main/ipc/run.routing.test.ts`: the A2A `messageId` is the stored user row's id, and a runner turn sends none
- `src/main/agents/drivers/golden.a2a.test.ts` ("a tasks/cancel answered %s shows the unconfirmed-stop notice"): a `tasks/cancel` answered `completed` or `canceled` counts as a confirmed stop (`a2aDriver.ts`)
- `src/main/agents/drivers/a2aDriver.test.ts`: a stop confirmed from the cancel's state, or from one `tasks/get` after an empty answer, saves the state; an unreadable or non-`canceled` read leaves the notice
