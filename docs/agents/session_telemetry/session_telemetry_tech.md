# Session Telemetry — Technical Details

Implementation reference for [Session Telemetry](session_telemetry.md). The turn it rides on is in [The Agent Turn (tech)](../local_agents/agent_turn_tech.md); the sibling service it is modelled on is [Session Activity (tech)](../session_activity/session_activity_tech.md).

## Read this first

1. **One reducer, pure.** `applyTelemetryChange(state, chatId, change, now)` is the only place state moves. No clock, no I/O. Every counting, cache and context rule in the business doc is in it and pinned by `sessionTelemetryReducer.test.ts`
2. **Totals move only on a `turn` change**, and a `TurnTelemetry` emits exactly one (`settle` is idempotent: the first call reports, later ones answer the same value). `finish` settles, and `runFollowUp` settles before calling `finish` with a null session id, so the follow-up's own session is the one reported. `runtime`, `request`, `compaction`, `session`, `context` and `context_categories` changes never add
3. **Every running total is a delta against a reading, and only Codex's reading survives a restart.** Claude's cost, per-model cost and API time are cumulative per adapter query and start at 0 with a fresh query, so `TurnTelemetry.session(…, freshQuery)` seeds the connection's readings to 0 and nothing of Claude's is persisted. Codex restores its token total on resume, so it is kept per session in `bySession[id].lastTokenTotal` and read back through the reporter (`lastTokenTotal`). Persist a Claude reading and measure against it, and the first turn after a restart reads as free; drop Codex's and it is charged the whole session
4. **Raw frames are reduced at the door.** `readSdkMessage` turns a `_claude/sdkMessage` into an `AcpSdkFrame` of numbers and ids; nothing downstream sees the message. Nothing logs a frame; the per-turn traffic line logs counts, and byte sizes only under `CINNA_LOG_DEBUG=1`
5. **No account identity crosses into the shared module.** `readAuthStatus` reads `authStatus.kind`, `authStatus.label` and `authStatus.account.plan`, and `scrubbed()` runs over both strings. Nothing logs the notification body
6. **Replay is dropped by the caller, not here.** `runTurn`'s handlers ignore frames while `turn.replaying`; `TurnTelemetry` trusts what reaches it
7. **Derived values are pure functions of the state and `now`** (`sessionTelemetryDerived.ts`), shared so main and renderer answer the same, and never stored

## File Locations

### Shared
- `src/shared/sessionTelemetry.ts` — `SessionTelemetry` (with `context.breakdown` / `awaitingBaseline` / `categories` / `categoriesMeasuredAt` / `categoriesSessionId` / `maxOutput`, `totals.lastTurn`, `cache.invalidatedAt` / `invalidationReason`, `runtime`), `MessageTelemetry` (`requests`, `apiDurationMs`, `costSource`), `TokenTally`, `TokenScope`, `AuthKind`, `TelemetryEngine`, the capability tables `CACHE_TTL_KNOWN`, `CACHE_WRITES_REPORTED` and `CONTEXT_CATEGORIES_KNOWN` (each Claude true, Codex false), `SessionTelemetrySessionTotals` (`lastTokenTotal`, `fingerprint`; legacy rows may still carry `lastCostReading` / `modelCostReadings`), `CacheInvalidationReason`, `ContextBreakdown`, `ContextCategory`, `ContextCategories`, the change union (`…AuthChange`, `…ContextChange`, `…TurnChange`, `…ModelChange`, `…RuntimeChange`, `…RequestChange`, `…CompactionChange`, `…SessionChange`, `…ContextCategoriesChange`), `SessionTelemetryReporter`, `ContextMeasureCode`, `ContextMeasurement`, `SessionContextMeasurer`, `SessionTelemetryMeasureResult`, `SESSION_TELEMETRY_CHANGED_CHANNEL` (`session-telemetry:changed`), `SessionTelemetryChangedPayload`, `SessionTelemetryGetResult`, `EMPTY_TOKEN_TALLY`
- `src/shared/modelPricing.ts` — `PRICES_CHECKED_AT`, `MODEL_PRICES` (per MTok: `input`, `output`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, optional `longContext`, `unpricedAboveInputTokens`, `fast`), `canonicalPricingModel`, `priceOf`, `effectivePrices(price, {fast?, contextTokens?})`, `costOf(model, tokens, {ttl?, fast?, contextTokens?})`. Undefined, never a guess, for an unknown model or an unpriceable tier
- `src/shared/sessionTelemetryDerived.ts` — `cacheState(t, now)` → `{state: warm|cold|unknown, flipsAt?}`, `currentPrices(t)` → `{model, prices, fast, fastPriceUnknown, longContext, checkedAt}` (fast mode on a model with no fast rate keeps the base rates, flagged), `nextMessageEstimate(t, now)` → `{warmUsd?, coldUsd?, flipsAt?, basis: api|api_equivalent, note}` (no figure when `fastPriceUnknown`), `cacheHitRatio(t)` → `{session?, lastTurn?}`, `contextCategoryKind(name)` → `content | free | reserved` (`Free space`; `Autocompact buffer`, `Compact buffer`; exact, case-insensitive). Read by `SessionTelemetryBlock`
- `src/shared/engine.ts` — `CodexAuthStatus.method` (`chatgpt` / `api_key`), never the key

### Main process — core (`src/main/agents/telemetry/`)
- `sessionTelemetryReducer.ts` — `applyTelemetryChange`, `emptySessionTelemetry(chatId, engine, now)`, `CACHE_TTL_5M_MS`, `CACHE_TTL_1H_MS`; internal `invalidate(next, reason, at)`, `withoutCategories`, `withSession`, `sessionTotals` (strips `LEGACY_SESSION_KEYS` — `lastCostReading`, `modelCostReadings` — from a session it writes)
- `sessionTelemetryService.ts` — `createSessionTelemetryService({store?, now?, isTrashed?})`, the `sessionTelemetryService` singleton (wired with `chatRepo.isTrashed`), `SessionTelemetryStore`, `SessionTelemetryListener`, `MeasureContextOutcome`. Methods: `report`, `get`, `onChange`, `lastTokenTotal`, `measureContext`, `installContextMeasurer`, `forget`

### Main process — ACP provider (`src/main/agents/drivers/acp/`)
- `acpSdkTelemetry.ts` — `SDK_MESSAGE_METHOD` (`_claude/sdkMessage`), `RAW_SDK_MESSAGE_FILTER` (`system/init`, `system/compact_boundary`, `assistant`, `result`), `readSdkMessage(params)` → `AcpSdkFrame | null`, `sdkUsageOf`, `sdkFrameLabel`
- `acpTelemetry.ts` — `telemetryEngineOf(launcher)` (Claude and Codex only), `costDelta`, `CostReadings` / `costReadings` and `ModelCostReadings` / `modelCostReadings` (`take`, `reset`; in memory, per connection), `ApiDurationReadings` / `apiDurationReadings`, `PriceCalibration` / `priceCalibration` / `CALIBRATION_TOLERANCE` (0.05), `sessionFingerprint` / `fingerprintDigest` / `noteSessionLive` / `isSessionLive`, `tokenDelta`, `TokenTotalReadings` / `tokenTotalReadings`, `readQuotaTotal`, `readContextCategories`, `parsePromptTelemetry(response, engine, selected?, {turnTokens?})`, `mainModel`, `canonicalModelId`, `addTally`, `readAuthStatus`, `scrubbed`, `authKindOf`, `telemetryAuthOf`, `codexTelemetryAuth`, `AUTH_STATUS_METHOD`, `noteConnectionAuth`, `watchConnectionAuth`, `connectionAuthOf`, `TurnTelemetry` (`model`, `session`, `frame`, `sdk`, `auth`, `started`, `answered`, `settle`)
- `acpMessages.ts` — `usage_update` → `{telemetry: AcpTelemetryFrame}`; `config_option_update` → `selectedModel` beside `modeId`; exported `selectedModelOf(configOptions)`; `applyExt` reads `_claude/sdkMessage` into `{sdk}` and every other extension into nothing
- `acpLaunchers.ts` — the Claude launcher's `session` sends `_meta.claudeCode.emitRawSDKMessages` from `RAW_SDK_MESSAGE_FILTER`; optional `AcpLauncher.telemetryAuth()`, implemented by `codexLauncher.ts` from `deps.auth()`
- `acpFollowUp.ts` — `HeldTraffic` gains `{type: 'ext'}`; the gate's sink holds `_claude/sdkMessage` from the trigger on under `FOLLOW_UP_BUFFER_LIMIT`, drops it when idle (it opens nothing), and `giveBack` returns it with the updates
- `acpSessionObserver.ts` — optional `SessionTrafficSink.ext(method, params)`; the observation counts every extension notification and passes it on, a throw logged
- `acpClient.ts` — `connectAcpClient` returns `onConnectionExt`: session-less extension notifications go to connection listeners; before the first listener the latest per method is held (at most 16 methods)
- `acpConnection.ts`, `acpWebSocketConnection.ts` — pass `onConnectionExt` through; `contextUsage(params)` requests `ACP_CONTEXT_USAGE_METHOD`
- `types.ts` — `ACP_CONTEXT_USAGE_METHOD` (`_cinna/contextUsage`), `AcpContextUsageRequest`, optional `AcpConnection.contextUsage`, `ConnectionExtListener`, optional `AcpConnection.onConnectionExt`, `AcpStreamUpdate.selectedModel` / `.telemetry` / `.sdk`, `AcpTelemetryFrame`, `AcpSdkUsage`, `AcpSdkModelUsage` (`costUsd`, `contextWindow`, `maxOutputTokens`, `costBasis`), `AcpSdkFrame` (`init` | `assistant` | `result` | `compact` | `other`)
- `acpDriver.ts` — `AcpDriverDeps.telemetry` / `.contextUsageTimeoutMs`, `ACP_CONTEXT_USAGE_TIMEOUT_MS` (30 s), `MeasurableSession`, `AcpDriver.measureContext`, `TurnContext.telemetry` / `.measurable`, `telemetrySink(deps, chatId)` (the reporter and `lastTokenTotal` only), `reportLauncherAuth`, `noteForeignAuth`, `refusalReason`, and the calls in `runTurn`, `runFollowUp` and `finish`
- `codexAuth.ts` — `parseCodexAuthStatus` keeps the login method, never what follows it on the line
- `claudeAdapterPatch.json`, `codexAdapterPatch.json` — adapter version and original/patched digests for the CommonJS hooks; repeat `RUNTIME_PINS` ([Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md))
- `src/main/agents/drivers/index.ts` — wiring: `telemetry: sessionTelemetryService`, and `sessionTelemetryService.installContextMeasurer((chatId) => acpDriver.measureContext(chatId))`

### Adapter patches (postinstall, verified at packaging)
- `scripts/patch-claude-agent-acp.cjs` — `patchClaudeAgentAcp`, `verifyClaudeAgentAcpPatch`: adds the `_cinna/contextUsage` request route and handler to adapter 0.76.0's `dist/acp-agent.js`
- `scripts/patch-codex-acp.cjs` — adds `total_token_count: sessionState.totalTokenUsage` to the prompt response's `_meta.quota`, beside the earlier MCP-merge and session-instruction changes. `earlierPatches` reverses a checkout carrying the previous reviewed patch before patching again

### Main process — persistence, services, IPC, logging
- `src/main/db/sessionTelemetry.ts` — `sessionTelemetryRepo.get` / `save` (upsert) / `delete`
- `src/main/db/messages.ts` — `SaveAssistantMessage.telemetry`, `messageRepo.updateAssistantTelemetry(id, telemetry)` (assistant rows only)
- `src/main/services/a2aStreamingService.ts` — `RunAgentTurnResult.telemetry`, `PersistCursor.lastAssistantId`, `saveTurnRows` (the last-row rule), `turnUsage(telemetry)` → `TurnOutcome.usage`
- `src/main/services/chatService.ts` — trash calls `sessionTelemetryService.forget`; `src/main/services/chatRemoval.ts` — `chatHardDeleted` does too
- `src/main/ipc/session_telemetry.ipc.ts` — `registerSessionTelemetryHandlers()`: the push listener, `sessionTelemetry:get`, `sessionTelemetry:measureContext`
- `src/main/logger/logger.ts` — `isDebugEnabled()` / `setDebugEnabled()`, and `ScopedLogger.isDebugEnabled`: gates work done only to fill a debug line (sizing frames)

### Preload
- `src/preload/index.ts` — `window.api.sessionTelemetry.get(chatId)`, `.measureContext(chatId)`, `.onChanged(handler)` → unsubscribe; `MessageData.telemetry`

### Renderer
- `src/renderer/src/hooks/useSessionTelemetry.ts` — `useSessionTelemetry(chatId)` → `UseSessionTelemetryResult {query, measureContext}`, `sessionTelemetryKey`. Used by `useSessionTelemetryBlock`
- `src/renderer/src/components/chat/SessionTelemetryBlock.tsx` — `useSessionTelemetryBlock(chatId)` → `SessionTelemetryBlockModel | null`, `SessionTelemetryBlock({model})`, and exported `DETAILS_MAX_HEIGHT`, `popoverMaxHeight(anchorTop)`, `contextRowValue(t)`, `contextRowLabel(t)`, `costQualifier(t)`; internal `SessionDetails`, `ContextSection`, `MeasureButton`, `SpentSection`, `CacheSection`, `NextMessageSection`, `PricesSection`, `RuntimeBlock`, the `REFUSAL` lines
- `src/renderer/src/components/chat/RouterBadge.tsx` — `RouterBadge({chatId?, …})`: with a `chatId` it renders `ChatRouterBadge`, which calls `useSessionTelemetryBlock` and hands the model to `RouterBadgeView`, along with the context health line and the budget-crossing toast of the [AI spending level](../../llm/ai_spending_level/ai_spending_level.md); without one (the job pages) no telemetry is read. `ChatInput` passes the chat's id
- `src/renderer/src/utils/telemetryFormat.ts` — `formatTokens`, `formatContextPercent`, `formatUsd`, `formatPrice`, `formatCountdown`, `formatAgo`, `formatTtl`, `formatRatio`, `formatAuth`: pure, so the badge, its tests and the E2E spec spell a figure the same way
- `src/renderer/src/components/chat/MessageMetaFooter.tsx` — `buildMeta` (exported) adds the `telemetry` block

## Database Schema

- **`session_telemetry`** (`src/main/db/migrations/chats.ts`, `schema.ts:sessionTelemetry`) — `chat_id` (PK, `ON DELETE CASCADE` from `chats`), `json` (the whole `SessionTelemetry`), `updated_at` (ms). Created before the trash cleanup in `migrateChats`, whose cascade reaches it. One JSON document rather than columns because the shape is still growing and nothing queries inside it — the cache clock, runtime block, context split and categories, and the per-session readings were all added (and Claude's cost readings removed) without a migration; every new field is optional, so an older row reads as "not yet seen"
- **`messages.telemetry`** (`src/main/db/migrations/messages.ts`) — nullable JSON `MessageTelemetry`, on the turn's last assistant row. Read back with the chat's messages, so it reaches the renderer through the existing `chat:get`
- Both are additive and idempotent; `migrations.test.ts` ("session telemetry") covers a fresh install, an older one and the cascade

## IPC Channels

- `sessionTelemetry:get` — `(chatId) → SessionTelemetryGetResult`: `{ok: true, telemetry | null}`, or `{ok: false, code: 'chat_not_found'}` for a non-string id, a chat the active profile cannot see, or a trashed one. `requireActivated()` first
- `sessionTelemetry:measureContext` — `(chatId) → SessionTelemetryMeasureResult`: `{ok: true}` (the measurement arrives on the push), or `{ok: false, code}` with `chat_not_found` (same checks as `get`) or a `ContextMeasureCode` (`not_running`, `busy`, `unsupported`, `not_ready`, `failed`). Returned as data, never thrown: a thrown code does not survive the trip to the renderer. `requireActivated()` first
- `session-telemetry:changed` (push, main → renderer) — `{chatId, telemetry}`, the whole state. Sent only when activated and the chat is visible to the active profile and not trashed

## Services & Key Methods

### Per turn (`TurnTelemetry`)
- Built in `runTurn` and `runFollowUp` only when `telemetryEngineOf(launcherId)` is non-null. A `nested` turn gets no reporter: its result carries telemetry, the chat's totals do not
- `model(selected)` — from `session/new` / `session/load` config options and every `config_option_update`; reports a `model` change when it differs from the last reported
- `session(sessionId, fresh, fingerprint, connection?, freshQuery = fresh)` — after `session/new` (`fresh`) and after `session/load`, where the driver passes `freshQuery = !isSessionLive(connection, id, fingerprint)`. On a fresh query it resets `costReadings` and `modelCostReadings` and records API time 0 for the session on that connection, so the first turn's cost and API time are its own. Reports a `session` change carrying `fingerprintDigest(fingerprint)` (sha256, 16 hex), never the fingerprint. Marks a loaded session `restored` for the Codex total
- `isSessionLive` / `noteSessionLive` — `sessionFingerprint` mirrors the adapter's `computeSessionFingerprint` (cwd plus MCP servers sorted by name); a load under another fingerprint is rebuilt by the adapter. Sessions are marked live, with their fingerprint, on `session/new`, on the load itself (right after its readings were zeroed, or not) and when a prompt answers: from then on the connection's readings describe the adapter's query, so a turn that fails after taking a reading does not have the next load zero it again and count it twice. The adapter's other rebuilds (a signed-out query, a provider update) are not seen; `costDelta` taking a dropped reading whole covers them
- `frame(connection, sessionId, frame)` — only for the turn's own session id, never a child session's. Reports a `context` change every time, with `cacheTimed` once the turn has counted a raw request; a costed frame adds `costReadings.take(connection, sessionId, amount)` to the turn's cost
- `sdk(connection, sessionId, frame)` — the driver passes only frames whose `sessionId` is the turn's. Every frame is counted by label (and sized, when debug is on). `init` → `runtime` change (model, CLI version, betas, effort, fast mode, `authHint: 'api_key'` for an `apiKeySource` of `ANTHROPIC_API_KEY`, `apiKeyHelper` or `/login managed key`). `assistant` with `main` and a message id not seen this turn → `request` change (input = uncached + read + write, the 5m/1h write split), and the turn's TTL and largest request input. `result` → adds its `usage` to the turn's raw usage, sums `num_turns`, records API time and per-model cost through `apiDurationReadings` / `modelCostReadings`, and takes the main model's `contextWindow` / `maxOutputTokens` (the row matching the raw or selected model by canonical id, else the only row). `compact` → `compaction` change
- `started()` — the prompt's `onSent` (beside `armSteering`); for a follow-up, at construction. `answered(response, connection?, sessionId?)` — on any prompt answer, cancelled included; for Codex it reads `readQuotaTotal(response)` once and takes the turn's tokens from `tokenTotalReadings.take(connection, sessionId, reading, lastTokenTotal, restored)`, which answers undefined for a restored session with no earlier reading anywhere
- `settle(sessionId)` — logs the turn's raw traffic (debug), parses the answer (`parsePromptTelemetry`, with `turnTokens` when Codex's total was measured); with no answer, the raw `result` usage and model are the turn's (scope `turn`). Claude with a parsed answer: `calibrate` each row against its runtime cost delta, skipping rows whose `costBasis` is not `list`. Codex with no runtime cost, a model, and a login other than `cloud`: `costOf(model, tokens, {contextTokens: last request's input})` → `costSource: 'estimated'`. `requests` = summed `num_turns`, else counted requests. `apiDurationMs` only when the connection had a reading (or a fresh query's 0) before the turn's first result. Reports one `turn` change with `byModel`, `byModelCost`, `tokenTotalReading`, `contextWindow`, `maxOutputTokens`, `selectedModel`

### Prompt response parsing (`parsePromptTelemetry`)
- Claude: sum of `_meta.quota.model_usage[].token_count` (subagents and compaction included) → else `usage` → else `quota.token_count`, on a resumed session's first turn too (its rows are that turn's). Scope `turn`
- Codex with `turnTokens`: those tokens, one row for the main model, scope `turn`, and `lastRequest` (`usage` → `quota.token_count`) for the tier. Without: `usage` → `quota.token_count` → summed rows, scope `last_request`
- Field maps: `usage` uses `cachedReadTokens`; `quota` uses `cachedInputTokens`. Both use `cachedWriteTokens`

### Reducer — what each change does
- `request` (Claude TTL-known only past the model update) — resolved model with `source: 'init'`; TTL 1h over 5m over last seen over assumed 5m; `lastRequestAt`, `expiresAt`; with `awaitingBaseline` and input > 0, `breakdown = {baseline: input, conversation: 0}`
- `context` — `used`, `size`, authority (no cost reading is kept); categories dropped when from another session; `breakdown.conversation = max(0, used − baseline)`; without `cacheTimed`, the reading is the cache clock (TTL-known engines also get `ttlMs` / `expiresAt`)
- `model` (a switch, not the first report) — size a guess, resolved cleared, `invalidate('model_change')`
- `session` — `fresh` → `invalidate('new_session')`; a load whose digest differs from the saved one → `invalidate('session_params_change')`; saves the digest
- `compaction` → `invalidate('compaction')`
- `invalidate` — `new_session` and `compaction` drop categories (every engine) and, for TTL-known engines, drop the breakdown and set `awaitingBaseline`; TTL-known engines get `invalidatedAt` / `invalidationReason`
- `context_categories` — ignored when `context.sessionId` names another session; else kept with `categoriesMeasuredAt` / `categoriesSessionId`
- `runtime` — merges the runtime block; resolved model with `source: 'init'`; `authHint` only over an `unknown` login
- `turn` — totals, `byModel` tokens and `byModelCost`, `costSource: 'estimated'` once an estimated turn counts, `lastTurn`, `bySession` (replacing `lastTokenTotal`), resolved model with `source: 'quota'`, `contextWindow` → authoritative size, `maxOutputTokens` → `context.maxOutput`

### Context measurement (`acpDriver.measureContext`)
- `measurable` holds, per chat, the root session its last turn answered on (`MeasurableSession`: connection, session, fingerprint, agent, launcher, spec key, runtime view, `answered`). Set when a prompt answers; `answered` cleared right after `pool.acquire` of the next turn; entry dropped by `forgetChatSessions`. Nested turns never write it
- `enter(chatId)` wraps every `run` and follow-up: a running count (→ `busy`) and a generation bumped on each start
- Order of refusals: running → `busy`; no entry → `not_running`; an engine without `CONTEXT_CATEGORIES_KNOWN` → `unsupported` (the same table hides the renderer's Measure); `pool.peek` not the same live connection, or `runtime.readSession(chatId)` empty or throwing → `not_running`; session changed, not `answered`, or not live under its fingerprint → `not_ready`; no `connection.contextUsage` → `unsupported`
- The request races `ACP_CONTEXT_USAGE_TIMEOUT_MS`. Adapter refusals are read from `error.data.reason`: `busy` → `busy`, `closed` → `not_running`; anything else → `failed`, logged with the agent, the chat and the error code or timeout only. A turn that started meanwhile (count or generation moved) → `busy`. `readContextCategories` null → `failed`
- The service shares one in-flight measurement per chat, answers `unsupported` with no measurer installed and `failed` if the measurer throws, and reports a success as `context_categories`

### Login
- `watchConnectionAuth(connection)` — right after `pool.acquire`, once per connection (`watched`). A session-named `_auth/status_update` reaching the turn's `onExtNotification` goes through the same `noteConnectionAuth`
- At the end of a prompted turn: `connectionAuthOf(connection)` → `noteForeignAuth` (Claude's transcript notice) and `TurnTelemetry.auth`, which also remembers the kind for the Codex estimate
- `reportLauncherAuth` — fired without awaiting when the prompt goes out; calls `launcher.telemetryAuth()` (Codex only). Failures are debug-logged

### Service (`sessionTelemetryService`)
- `report` — trashed chat → `forget` and return; else lazy-load, reduce, compare ignoring `updatedAt` (no change → nothing), hold, `store.save` (a throw is logged, state kept), emit a `structuredClone` to each listener
- `get` and `lastTokenTotal` return copies; `forget` drops held state and the row and announces nothing

### Persistence of a turn (`a2aStreamingService.saveTurnRows`)
- Mid-turn flushes carry no telemetry. The pass with the result writes it on the last slice's row; if that slice is empty, `updateAssistantTelemetry(cursor.lastAssistantId, …)`; with no assistant row, dropped
- `turnUsage` → `{usage: {inputTokens: input + cacheRead + cacheWrite, outputTokens}}`, absent for `tokenScope: 'none'` or no telemetry; spread into both the failed and the ordinary `finish` of the outcome

## Renderer Components

- `MessageMetaFooter.tsx:buildMeta` — when the row has telemetry, a `telemetry` key placed before `parts` (which can push it below the popup's fold): `model`, `tokens` (`{scope, input, output, cacheRead, cacheWrite}`, scope `turn` or `last request only (lower bound)`, or the string `not reported (follow-up turn)`), `cost` (`$` and four significant digits, `(estimated)` unless the runtime reported it), `requests`, `durationMs`, `apiDurationMs`. Pinned by `MessageMetaFooter.test.tsx`
- `useSessionTelemetryBlock` / `SessionTelemetryBlock` — the hook returns null until the chat has telemetry, carries `fetching` (the query's `isFetching`: the reading may be the cache from before this view mounted, which the crossing toast must not count), and holds the state that must outlive the popover (which `RouterBadge` unmounts on every close): `expanded` (collapsed by default, reset during render when `chatId` changes, not persisted) and `unsupportedIn` (`chatId:sessionId`), so an `unsupported` answer outlasts popover closes but not a new session. With a model `RouterBadgeView` makes its popover `role="dialog"` (*Chat routing*), `w-80` and a flex column capped by `popoverMaxHeight` (the wrapper's measured top − 8 px, re-measured on resize while open) and appends the block last. The block is a hairline, then — only when expanded — `SessionDetails` (`-mx-3`, `min-h-0`, `DETAILS_MAX_HEIGHT`, `overflow-y-auto`, stable gutter), then the disclosure button (`aria-expanded`, `aria-controls`, name from `contextRowLabel`, text `Context` + `contextRowValue` + chevron) as the last row, so the popover grows upward from a row that stays put. Sections are `<section aria-label>` regions. `SessionDetails` mounts only while expanded in an open popover and is keyed by `chatId`, so its one-second clock, a pending Measure and a refusal end with it and never cross chats. `MeasureButton` stacks *Measure* and *Measuring…* in one grid cell and uses `aria-disabled`, not `disabled`, while pending so focus stays in the popover. `RuntimeBlock` renders only under `useUIStore.verboseMode`. Pinned by `SessionTelemetryBlock.test.tsx`
- `useSessionTelemetry` — `get` once, then the push; the same push-vs-reply guard as `useSessionActivity` (a `get` that resolves after a newer push does not overwrite it); `staleTime: 0` because pushes are heard only while a hook for the chat is mounted. Returns `{query, measureContext}` rather than spreading the query: spreading reads every property of TanStack's tracked result and re-renders the caller on changes it never looks at. `measureContext` with no chat answers `chat_not_found` without a call

## Configuration

- No setting of its own. Which engines report is `telemetryEngineOf`. `aiSpendingLevel` only sets the budget the badge reads the context against ([AI Spending Level](../../llm/ai_spending_level/ai_spending_level.md))
- `CINNA_LOG_DEBUG=1` — at process start, turns on `isDebugEnabled()`, so each raw frame is sized (`JSON.stringify` length) for the per-turn `raw SDK stream traffic for the turn` debug line. Off, the line carries frame counts only. `setDebugEnabled` exists; nothing calls it yet
- `RAW_SDK_MESSAGE_FILTER` — which raw messages Claude sessions ask for. Dropping `assistant` (the heavy one: each frame repeats a content block) is a one-line change; measured live, `assistant` frames were about 6–9% of a turn's ACP bytes, 5.8% on a tool-heavy turn, so they have been kept; the TTL then stays `assumed` and the cache clock falls back to `usage_update` readings
- `PRICES_CHECKED_AT` and `MODEL_PRICES` — the price table and its date; `CALIBRATION_TOLERANCE` — 5%
- `ACP_CONTEXT_USAGE_TIMEOUT_MS` — 30 s (`contextUsageTimeoutMs` overrides it in tests)

## Security

- The email and organisation in `_auth/status_update` are never kept, logged or sent: three fields are read and scrubbed. `acpClient.ts` logs only the method of a session-less notification
- Raw SDK frames repeat the turn's content; `readSdkMessage` keeps only numbers, ids, model names and runtime flags, and nothing logs a frame
- A session's fingerprint (cwd plus MCP servers, whose env and headers can be secrets) is stored only as `fingerprintDigest`
- A context measurement's `memoryFiles[].path` can name the user's home directory: kept in the telemetry and shown, never logged. The driver's failure log carries the error code only, since an answer or an error from the adapter can carry paths
- The price calibration log names the canonical model and two figures, nothing else
- `codex login status` output keeps only the method word; a key printed after it is discarded in `parseCodexAuthStatus`. `local-tools:codex-auth` therefore carries `method` as well as `state`
- The adapter patches are checksum-gated: each script refuses any source but the reviewed original (or, for Codex, the previous reviewed patch it can reverse to that original), and `beforePack` / `afterPack` verify the patched bytes in the installed and shipped trees. See [Packaged Runtime Dependencies](../../development/distribution/packaged_runtime.md)
- Profile scope: `visibleChat(getProfileScopeUserId(), chatId)` on both replies and the push; nothing crosses while the activation gate is closed

## Tests

- `sessionTelemetryReducer.test.ts`, `sessionTelemetryService.test.ts` — counting, context authority, model switch, Codex token-total readings and legacy Claude readings dropped, cache TTL and invalidations, baseline and categories, one shared measurement, trash, restart, write failure
- `acpTelemetry.test.ts` — parsing per engine, main-model choice, `costDelta` / the readings classes, `tokenDelta`, calibration, `readContextCategories`, auth mapping and scrubbing, `TurnTelemetry` (raw frames, Codex totals and estimates)
- `acpSdkTelemetry.test.ts` (fixtures in `testSupport/sdkMessageFixtures.ts`) — frame reading, defensive shapes, debug-gated sizing
- `acpDriver.test.ts` ("session telemetry") — a whole turn against the fake agent child: Claude and Codex, cancelled, replay not counted, raw frames, session-less login and the once-per-chat notice, the first turn after a restart and after a load under other params measured from 0, nested turns and non-reporting engines, a follow-up turn's cost and raw tokens, and `measureContext` refusals and stale discard
- `acpFollowUp.test.ts`, `acpSessionObserver.test.ts`, `acpLaunchers.test.ts` — raw frames held and given back, the observer's `ext`, the launcher's `emitRawSDKMessages`
- `modelPricing.test.ts`, `sessionTelemetryDerived.test.ts` — canonical ids, tiers, fast mode (and its unlisted-rate fallback), unknown models; cache state, next-message estimates, category kinds
- `SessionTelemetryBlock.test.tsx`, `telemetryFormat.test.ts` — through `RouterBadge`: no row without telemetry or without a chat, the dialog role, the collapsed row's text and name, expand/collapse with the details above the last-row toggle, focus keeping the popover open, expansion surviving a reopen and resetting on a chat change, each engine's details, cost qualifiers, category order, countdown, scroll cap, verbose-only runtime block, Measure and its refusals; the number spellings
- `e2e/specs/session-telemetry.spec.ts` — in the built app with a Codex agent: the verbose popup's per-turn block, then the badge and its popover (model, estimated cost; no Cache section, cache-write row or Measure)
- `useSessionTelemetry.test.tsx`, `MessageMetaFooter.test.tsx`, `session_telemetry.ipc.test.ts`, `sessionTelemetry.test.ts` (db), `a2aStreamingService.test.ts`, `migrations.test.ts`
- `scripts/patch-claude-agent-acp.test.cjs`, `scripts/patch-codex-acp.test.cjs`, `scripts/packaged-dependencies.test.cjs` (`npm run test:packaging`)
- Interface contract, against the real pinned CLIs (`make contract`): `claude.session.context-usage`, `codex.session.quota-running-total`, `codex.session.quota-total-on-resume` — [Claude](../local_agents/contracts/claude_interface.md), [Codex](../local_agents/contracts/codex_interface.md)
