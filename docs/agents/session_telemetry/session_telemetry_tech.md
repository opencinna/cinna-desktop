# Session Telemetry — Technical Details

Implementation reference for [Session Telemetry](session_telemetry.md). The turn it rides on is in [The Agent Turn (tech)](../local_agents/agent_turn_tech.md); the sibling service it is modelled on is [Session Activity (tech)](../session_activity/session_activity_tech.md).

## Read this first

1. **One reducer, pure.** `applyTelemetryChange(state, chatId, change, now)` is the only place state moves. No clock, no I/O. Every counting rule in the business doc is in it and pinned by `sessionTelemetryReducer.test.ts`
2. **Totals move only on a `turn` change**, and a `TurnTelemetry` emits exactly one (`settle` is idempotent: the first call reports, later ones answer the same value). `finish` settles, and `runFollowUp` settles before calling `finish` with a null session id, so the follow-up's own session is the one reported
3. **Drivers report; they read back one thing.** `SessionTelemetryReporter.lastCostReading(chatId, sessionId)` exists because the CLI restores its running cost total on resume and the driver must measure the next reading against it. Drop it and the first turn after a restart is charged the whole session
4. **No account identity crosses into the shared module.** `readAuthStatus` reads `authStatus.kind`, `authStatus.label` and `authStatus.account.plan`, and `scrubbed()` runs over both strings. Nothing logs the notification body
5. **Replay is dropped by the caller, not here.** `runTurn`'s handlers ignore frames while `turn.replaying`; `TurnTelemetry` trusts what reaches it

## File Locations

### Shared
- `src/shared/sessionTelemetry.ts` — `SessionTelemetry`, `MessageTelemetry`, `TokenTally`, `TokenScope`, `AuthKind`, `TelemetryEngine`, `SessionTelemetrySessionTotals` (with `lastCostReading`), the change union (`SessionTelemetryAuthChange`, `…ContextChange`, `…TurnChange`, `…ModelChange`), `SessionTelemetryReporter`, `SESSION_TELEMETRY_CHANGED_CHANNEL` (`session-telemetry:changed`), `SessionTelemetryChangedPayload`, `SessionTelemetryGetResult`, `EMPTY_TOKEN_TALLY`
- `src/shared/engine.ts` — `CodexAuthStatus.method` (`chatgpt` / `api_key`), never the key

### Main process — core (`src/main/agents/telemetry/`)
- `sessionTelemetryReducer.ts` — `applyTelemetryChange`, `emptySessionTelemetry(chatId, engine, now)`
- `sessionTelemetryService.ts` — `createSessionTelemetryService({store?, now?, isTrashed?})`, the `sessionTelemetryService` singleton (wired with `chatRepo.isTrashed`), `SessionTelemetryStore`, `SessionTelemetryListener`. Methods: `report`, `get`, `onChange`, `lastCostReading`, `forget`

### Main process — ACP provider (`src/main/agents/drivers/acp/`)
- `acpTelemetry.ts` — `telemetryEngineOf(launcher)` (Claude and Codex only), `costDelta`, `CostReadings` / `costReadings` (per connection, per session), `sessionFingerprint` / `noteSessionLive` / `isSessionLive`, `parsePromptTelemetry(response, engine, selected?, {mainLoopOnly?})`, `mainModel`, `canonicalModelId`, `addTally`, `readAuthStatus`, `scrubbed`, `authKindOf`, `telemetryAuthOf`, `codexTelemetryAuth`, `AUTH_STATUS_METHOD`, `noteConnectionAuth`, `watchConnectionAuth`, `connectionAuthOf`, `TurnTelemetry` (`model`, `resumed`, `frame`, `auth`, `started`, `answered`, `settle`)
- `acpMessages.ts` — `usage_update` → `{telemetry: AcpTelemetryFrame}` and nothing else; `config_option_update` → `selectedModel` beside `modeId`; exported `selectedModelOf(configOptions)`
- `acpClient.ts` — `connectAcpClient` returns `onConnectionExt`: session-less extension notifications go to connection listeners; before the first listener the latest per method is held (at most 16 methods) and handed to it
- `acpConnection.ts`, `acpWebSocketConnection.ts` — pass `onConnectionExt` through on the connection
- `types.ts` — `ConnectionExtListener`, optional `AcpConnection.onConnectionExt`, `AcpStreamUpdate.selectedModel` / `.telemetry`, `AcpTelemetryFrame` (`used`, `size`, `costUsd`, `origin`, `rateLimit`)
- `acpDriver.ts` — `AcpDriverDeps.telemetry`, `TurnContext.telemetry`, `telemetrySink(deps, chatId)`, `reportLauncherAuth`, `noteForeignAuth` (once per chat, connection and login, `foreignAuthNoted`), and the calls in `runTurn`, `runFollowUp` and `finish`
- `acpLaunchers.ts` — optional `AcpLauncher.telemetryAuth()`; `codexLauncher.ts` implements it from `deps.auth()`
- `codexAuth.ts` — `parseCodexAuthStatus` keeps the login method, never what follows it on the line
- `src/main/agents/drivers/index.ts` — wiring: `telemetry: sessionTelemetryService`

### Main process — persistence, services, IPC
- `src/main/db/sessionTelemetry.ts` — `sessionTelemetryRepo.get` / `save` (upsert) / `delete`
- `src/main/db/messages.ts` — `SaveAssistantMessage.telemetry`, `messageRepo.updateAssistantTelemetry(id, telemetry)` (assistant rows only)
- `src/main/services/a2aStreamingService.ts` — `RunAgentTurnResult.telemetry`, `PersistCursor.lastAssistantId`, `saveTurnRows` (the last-row rule), `turnUsage(telemetry)` → `TurnOutcome.usage`
- `src/main/services/chatService.ts` — trash calls `sessionTelemetryService.forget`; `src/main/services/chatRemoval.ts` — `chatHardDeleted` does too
- `src/main/ipc/session_telemetry.ipc.ts` — `registerSessionTelemetryHandlers()`: the push listener and `sessionTelemetry:get`

### Preload
- `src/preload/index.ts` — `window.api.sessionTelemetry.get(chatId)`, `.onChanged(handler)` → unsubscribe; `MessageData.telemetry`

### Renderer
- `src/renderer/src/hooks/useSessionTelemetry.ts` — `useSessionTelemetry(chatId)`, `sessionTelemetryKey`. No component uses it yet
- `src/renderer/src/components/chat/MessageMetaFooter.tsx` — `buildMeta` (now exported) adds the `telemetry` block

## Database Schema

- **`session_telemetry`** (`src/main/db/migrations/chats.ts`, `schema.ts:sessionTelemetry`) — `chat_id` (PK, `ON DELETE CASCADE` from `chats`), `json` (the whole `SessionTelemetry`), `updated_at` (ms). Created before the trash cleanup in `migrateChats`, whose cascade reaches it. One JSON document rather than columns because the shape is still growing and nothing queries inside it
- **`messages.telemetry`** (`src/main/db/migrations/messages.ts`) — nullable JSON `MessageTelemetry`, on the turn's last assistant row. Read back with the chat's messages, so it reaches the renderer through the existing `chat:get`
- Both are additive and idempotent; `migrations.test.ts` ("session telemetry") covers a fresh install, an older one and the cascade

## IPC Channels

- `sessionTelemetry:get` — `(chatId) → SessionTelemetryGetResult`: `{ok: true, telemetry | null}`, or `{ok: false, code: 'chat_not_found'}` for a non-string id, a chat the active profile cannot see, or a trashed one. `requireActivated()` first
- `session-telemetry:changed` (push, main → renderer) — `{chatId, telemetry}`, the whole state. Sent only when activated and the chat is visible to the active profile and not trashed

## Services & Key Methods

### Per turn (`TurnTelemetry`)
- Built in `runTurn` and `runFollowUp` only when `telemetryEngineOf(launcherId)` is non-null. A `nested` turn gets no reporter: its result carries telemetry, the chat's totals do not
- `model(selected)` — from `session/new` / `session/load` config options and every `config_option_update`; reports a `model` change when it differs from the last reported
- `resumed()` — called after a `session/load` of a session that `isSessionLive(connection, id, fingerprint)` does not know under this fingerprint. `sessionFingerprint` mirrors the adapter's `computeSessionFingerprint` (cwd plus MCP servers sorted by name); a load under another fingerprint is rebuilt by the adapter. Sessions are marked live, with their fingerprint, on `session/new` and when a prompt answers — never on the load itself, so a turn that failed before any result stays resumed. The adapter's other rebuilds (a signed-out query, a provider update) are not seen
- `frame(connection, sessionId, frame)` — only for the turn's own session id (`frame.sessionId === sessionId`), never a child session's. Reports a `context` change every time; a costed frame adds `costReadings.take(...)` to the turn's cost and carries `costReading` so the service records it
- `started()` — the prompt's `onSent` (beside `armSteering`); for a follow-up, at construction. `answered(response)` — on any prompt answer, cancelled included
- `settle(sessionId)` — parses the answer (`parsePromptTelemetry`), builds `MessageTelemetry`, reports one `turn` change with `byModel` and `selectedModel`, returns the message. Undefined when there were neither tokens nor cost

### Prompt response parsing (`parsePromptTelemetry`)
- Claude: sum of `_meta.quota.model_usage[].token_count` (subagents and compaction included) → else `usage` → else `quota.token_count`. With `mainLoopOnly`: `usage` → `quota.token_count`, and no per-model rows. Scope `turn`
- Codex: `usage` → `quota.token_count` → summed rows. Scope `last_request`
- Field maps: `usage` uses `cachedReadTokens`; `quota` uses `cachedInputTokens`. Both use `cachedWriteTokens`

### Login
- `watchConnectionAuth(connection)` — right after `pool.acquire`, once per connection (`watched`). A session-named `_auth/status_update` reaching the turn's `onExtNotification` goes through the same `noteConnectionAuth`
- At the end of a prompted turn: `connectionAuthOf(connection)` → `noteForeignAuth` (Claude's transcript notice) and `TurnTelemetry.auth`
- `reportLauncherAuth` — fired without awaiting when the prompt goes out; calls `launcher.telemetryAuth()` (Codex only). Failures are debug-logged

### Service (`sessionTelemetryService`)
- `report` — trashed chat → `forget` and return; else lazy-load, reduce, compare ignoring `updatedAt` (no change → nothing), hold, `store.save` (a throw is logged, state kept), emit a `structuredClone` to each listener
- `get` returns a copy; `forget` drops held state and the row and announces nothing

### Persistence of a turn (`a2aStreamingService.saveTurnRows`)
- Mid-turn flushes carry no telemetry. The pass with the result writes it on the last slice's row; if that slice is empty, `updateAssistantTelemetry(cursor.lastAssistantId, …)`; with no assistant row, dropped
- `turnUsage` → `{usage: {inputTokens: input + cacheRead + cacheWrite, outputTokens}}`, absent for `tokenScope: 'none'` or no telemetry; spread into both the failed and the ordinary `finish` of the outcome

## Renderer Components

- `MessageMetaFooter.tsx:buildMeta` — when the row has telemetry, a `telemetry` key placed before `parts` (which can push it below the popup's fold): `model`, `tokens` (`{scope, input, output, cacheRead, cacheWrite}`, scope `turn` or `last request only (lower bound)`, or the string `not reported (follow-up turn)`), `cost` (`$` and four significant digits, `(estimated)` unless the runtime reported it), `durationMs`. Pinned by `MessageMetaFooter.test.tsx`
- `useSessionTelemetry` — `get` once, then the push; the same push-vs-reply guard as `useSessionActivity` (a `get` that resolves after a newer push does not overwrite it); `staleTime: 0` because pushes are heard only while a hook for the chat is mounted

## Configuration

None. There is no setting and no environment variable. Which engines report is `telemetryEngineOf`.

## Security

- The email and organisation in `_auth/status_update` are never kept, logged or sent: three fields are read and scrubbed. `acpClient.ts` logs only the method of a session-less notification
- `codex login status` output keeps only the method word; a key printed after it is discarded in `parseCodexAuthStatus`. `local-tools:codex-auth` therefore now carries `method` as well as `state`
- Profile scope: `visibleChat(getProfileScopeUserId(), chatId)` on both the reply and the push; nothing crosses while the activation gate is closed

## Tests

- `sessionTelemetryReducer.test.ts`, `sessionTelemetryService.test.ts` — counting, context authority, model switch, cost reading, trash, restart, write failure
- `acpTelemetry.test.ts` — parsing per engine, main-model choice, `costDelta` / `CostReadings`, auth mapping and scrubbing, `TurnTelemetry`
- `acpDriver.test.ts` ("session telemetry") — a whole turn against the fake agent child: Claude and Codex, cancelled, replay not counted, session-less login and the once-per-chat notice, the first turn after a restart, nested turns and non-reporting engines; plus a follow-up turn's cost
- `acpConnection.test.ts`, `acpMessages.test.ts` — connection-level extension routing and early holding; `usage_update` and model option translation
- `sessionTelemetry.test.ts` (db), `session_telemetry.ipc.test.ts`, `a2aStreamingService.test.ts`, `migrations.test.ts`
