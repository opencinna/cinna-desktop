# Agent Drivers & Readiness — Technical Details

Implementation reference for [Agent Drivers & Readiness](drivers.md). What the ACP driver does inside a turn is [The Agent Turn (tech)](../local_agents/agent_turn_tech.md) and [The Claude Engine (tech)](../local_agents/claude_engine_tech.md) and are not restated here.

## File Locations

### Shared
- `src/shared/agentDrivers.ts` — type-only plus one guard, so the renderer can import it (capabilities and readiness cross IPC on the agent DTO). Exports:
  - `AgentDriverId` (`'a2a' | 'acp'`), `AGENT_DRIVER_IDS`, `isAgentDriverId()`, `FOLDER_AGENT_DRIVER`
  - `AcpLauncherId` (`'opencode' | 'claude' | 'gemini' | 'codex'`), `ACP_LAUNCHER_IDS`, `isAcpLauncherId()`, `launcherConfig()`, `launcherOfConfig()` — the launcher lives here, and not beside the ACP code, because it is a **stored row value** and the row model may not import the ACP SDK
  - `AgentCapabilities` (`:32`)
  - `AgentReadinessState` (`:76`), `AgentReadiness` (`:85`)
  - `AGENT_READINESS_CHANGED_CHANNEL` (`:103`), `AgentReadinessChangedPayload` (`:106`)

### Main process — `src/main/agents/drivers/`
- `unsupportedDriver.ts` — inert capabilities, invalid readiness, unsupported_driver result without I/O, canceled outcome for an already aborted input, and refused reply delivery. It is a total registry fallback, not an executable driver kind.
- `driver.ts` — the interface, type-only:
  - `RunInput` (`:38`)
  - `RunResult` (`:54`) — `RunAgentTurnResult` unchanged, so the golden expectations stay byte-identical
  - `ParkedAsk` (`:57`), `RespondOutcome` (`:66`), `ReadinessOptions` (`:76`)
  - `AgentDriver` (`:86`)
- `capabilities.ts` — `capabilitiesFor()` (`:20`), the private `folderCapabilities()` (`:66`), `hasRunConfig()` (`:90`). Pure and import-light: `agentService` maps it into every DTO and the readiness service picks a TTL with it, so it must not pull the production wiring in `index.ts` into the service layer
- `driverOf.ts` — `driverOfRow(agent)`, `launcherOfRow(agent)` and `launcherOfFolder(runtime)`. It imports nothing but shared types, so the scanner and the DTO mapper can use it. **`launcherOfFolder` never returns null**: "the runtime names no engine" is an answer (the default), and only the scanner's `folderIndexLauncher` may say *keep the row's value*, which it does for an `unresolved` folder alone
- `acp/` — the one driver every local CLI agent runs on: `acpDriver.ts`, `acpConnection.ts`, `acpProcessPool.ts`, `acpMessages.ts`, `acpPermissions.ts`, `acpQuestions.ts`, `acpLaunchers.ts`, `types.ts`, plus `testSupport/` and `__fixtures__/`. Documented in [The Agent Turn (tech)](../local_agents/agent_turn_tech.md#file-locations); `respondToAcpAsk` and `folderReadiness` live in `acpDriver.ts` and are what `respondToOrphanedAsk` and the readiness path reuse
- `a2aDriver.ts` —
  - `AGENT_NOT_CONFIGURED` (`:33`), `NO_ENDPOINT_CONFIGURED` (`:35`), `A2A_READINESS_TIMEOUT_MS` (`:38`)
  - `createA2aDriver()` (`:68`), with `run` (`:74`), `readiness` (`:188`) and `respond` (`:234`)
  - the private `cardFailure()` (`:253`) and `withTimeout()`
- `a2aConnection.ts` — `rethrowAsReauthIfCinna401()` (`:41`), `resolveEndpointIfNeeded()` (`:66`), `resolveAccessToken()` (`:114`). Moved here from `agentService`; each decides by `capabilitiesFor(agent).cwd` / `.auth` rather than by `source`. `agentService.testAgent` and `listCliCommands` still use them for a card fetch
- `a2aErrors.ts` — `authRejectionStatus(err)`: a 401 or 403 from either `A2aHttpError` or `AgentCardFetchError`. It is its own module so the A2A driver can classify a rejection without importing `a2aConnection.ts`, which names the keystore and the Cinna OAuth flow
- `index.ts` — the production wiring and the resolver:
  - `acpProcessPool` (exported, so `will-quit` can shut it down) and `startAcpConnection`
  - `acpLaunchers` — `opencode` and `claude` only; `gemini` and `codex` have no entry, which is what makes the driver's refusal happen
  - `claudeAuthProbe`, `electronNodeRuntime()`, `claudeAdapterEntry()`
  - the private `readAcpFolder()`, `readSession` / `saveSession`, `isGranted` / `rememberGrant`
  - `acpDriver`, `drivers`, `driverFor()` and `respondToOrphanedAsk()`

  **It is the only file in this folder that imports Electron**, and the only one that names `engineBinaryService`, `localAgentService`, `desktopStateService` or `a2aSessionRepo`

### Main process — elsewhere
- `src/main/services/agentReadinessService.ts` — the cache:
  - the constants (`:43`–`:66`) and `AgentReadinessDeps`
  - `createAgentReadinessService()` (`:108`), with the private `run()` (`:126`) and `pump()` (`:208`), plus `kick` (`:241`) and `forget` (`:271`)
  - the module-private `changed()` (`:304`)
  - the singleton `agentReadinessService` (`:310`)

  It names neither the drivers' wiring nor Electron: its probe and broadcast are installed from outside
- `src/main/ipc/agent.ipc.ts` — installs `agentReadinessService.install({probe, broadcast})` at registration (`:18`), and handles `agent:check-readiness` (`:37`)
- `src/main/services/agentService.ts` —
  - `AgentDto.driver`, `.capabilities` and `.readiness`, filled in `toDto` (`:135`–`:137`)
  - `listMerged` calls `agentReadinessService.kick` (`:214`), each row with the scope it was listed from
  - `setEnabled` (`:263`, `:270`) and `delete` (`:360`) call `forget`
  - `listCliCommands` (`:453`) dispatches on `capabilitiesFor(agent).commands` (`:456`)
- `src/main/ipc/agent_a2a.ipc.ts` —
  - `agent:send-message` (`:145`): `driverFor(agent)` (`:188`); `resolveCommandRunner(driver.capabilities(agent).commands, …, (io) => driver.run(…))` (`:207`); `streamToAgent({run, chatId, agentId, port})` (`:222`)
  - `agent:answer-request` (`:245`): finds the row (`:293`), then calls `driverFor(row).respond` — or `respondToOrphanedAsk` when the row is gone (`:313`)
- `src/main/services/a2aStreamingService.ts` —
  - `TurnIO` (`:108`), `TurnRun` (`:114`)
  - `streamToAgent` (`:484`) takes an already-bound `run` and calls it (`:493`)
  - `cancel` (`:598`) only aborts. The A2A driver's abort listener is what sends `tasks/cancel`, so a user's Stop and an orchestrator abort cancel the same way and the request goes out once
- `src/main/services/a2aAsMcpProvider.ts` — `callTool` runs `driverFor(this.agent).run` (`:133`); `buildAgentToolProviders` skips a row only when `!hasRunConfig(row)` (`:171`)
- `src/main/services/localAgents/commandService.ts` — `resolveCommandRunner(commands, wireContent, agentOwnerId, agentId, fallback: TurnRun)` (`:473`)
- `src/main/services/localAgents/scannerService.ts` — `folderIndexLauncher(dto)`, passed on both index writes
- `src/main/services/localAgents/localAgentService.ts` — `reindexAgent` (`:622`, which is how a kit agent's `updateField` runtime save reaches the row) and `renameAgent` (`:1577`) pass `folderIndexDriver(dto)`; `setBareRuntime` calls `agentRepo.setFolderDriver` (`:1630`–`:1631`)
- `src/main/db/schema.ts` — `agents.driver` (`:251`), `agents.driverConfig` (`:253`)
- `src/main/db/migrations/agent-drivers.ts` — `migrateAgentDrivers()`; `src/main/db/migrations/acp-driver.ts` — `migrateAcpDriver()`, which runs after it. Both are called from `src/main/db/migrations/index.ts`
- `src/main/db/agents.ts` —
  - `FolderIndexEntry.launcher`
  - `driver: 'a2a'` on the hand-added insert (`:181`) and the sync insert (`:330`)
  - the folder writes in `replaceFolderIndex` (`:429` update, `:464` insert) and in `updateFolderIndex` (`:497`)
  - `setFolderLauncher()`
  - `agentSessionRepo` (`:846`) — the same object as `a2aSessionRepo`, under a driver-neutral name
- `src/main/db/client.ts` — `runConsistencyChecks()` runs the `agents-driver-populated` check (`:57`)
- `src/main/agents/drivers/pendingRequests.ts` — the parked-ask registry both the ACP driver and the answer path use. `runner.ts` — the seam that existed to hold three transports — is gone with them

### Preload
- `src/preload/index.ts` — `AgentData.driver` (`:219`), `.capabilities` and `.readiness` (`:227`); `window.api.agents.checkReadiness(agentId)` (`:664`); `onReadinessChanged(handler)` (`:667`)

### Renderer
- `src/renderer/src/components/chat/ComposerReadiness.tsx` — `readinessSeverity()` (`:36`), `readinessTone()` (`:41`), `readinessRefusal()` (`:52`), `readinessText()` (`:58`), `readinessTitle()` (`:63`), `isCatalogCommand()` (`:76`), `useComposerReadiness()` (`:108`), `ComposerReadinessLine`, `RefusableExamplePrompts`
- `src/renderer/src/components/chat/ChatInput.tsx` —
  - `targetTakesCinnaFiles` (`:405`) — `capabilities.attachments === 'cinna'`
  - `directTarget` (`:430`) and `useComposerReadiness` (`:437`)
  - `blocksSendRef` (`:441`), which `handleSend` reads before it sends
  - the effect that moves focus to the message box when a refusal clears while focus is on the page body
  - Send's `aria-label="Send"`, `aria-describedby`, `title` and `disabled`
  - `ComposerReadinessLine`, rendered under the controls row whenever `directTarget` is set
- `src/renderer/src/components/layout/MainArea.tsx` — `exampleRefusal` (`:145`), `RefusableExamplePrompts` (`:370`), and the comment marking the deliberately absent guard in `handleNewChat` (`:216`)
- `src/renderer/src/components/settings/AgentCard.tsx` — `handleTest` also runs `checkReadiness.mutate` (`:83`); `readinessIssue` (`:87`), `statusColor` (`:126`), `ReadinessIcon` (`:133`), and the reason span (`title={readinessTitle(…)}`), which a failed test result does not replace
- `src/renderer/src/hooks/useAgents.ts` — `useAgents` subscribes to the push (`:38`) and invalidates with `cancelRefetch: false` (`:39`); `useCheckAgentReadiness()` (`:57`)
- `src/renderer/src/hooks/useChatStream.ts` — when a direct agent turn ends in `error`, it calls `checkReadiness(agentId)` (`:234`–`:236`)

## Database Schema

`agents` gains two columns in `src/main/db/migrations/agent-drivers.ts`:

| Column | Notes |
|---|---|
| `driver` | TEXT, nullable in storage; known values select drivers. AgentDto/AgentData preserve the raw string or null. Migrations backfill legacy nulls, while unknown identities stay visible and refuse through unsupportedDriver. |
| `driver_config` | `TEXT`, JSON (`mode: 'json'` in Drizzle). The driver's own settings, opaque outside `src/main/agents/drivers/`. Since phase 3 it holds `{"launcher": …}` for every folder agent — which engine an ACP row runs |

The migration is placed after every table-creation migration, returns early without `hasTable('agents')`, and gates each `ADD COLUMN` with `hasColumn`. Its backfill is `UPDATE … WHERE driver IS NULL`: `a2a` for `source IN ('local', 'remote')`, and `opencode` for `source = 'folder'`. That predicate is also what makes it idempotent — a row that names a driver is never rewritten, so a scanner's correction of a Claude folder backfilled as `opencode` survives every later launch. See [Database Migrations](../../development/migrations/migrations_llm.md).

A second migration, `src/main/db/migrations/acp-driver.ts`, collapses `driver` from `opencode` / `claude` to `acp` and moves the engine into `driver_config.launcher`. **Idempotent by its predicate**: the launcher is written only where the column still names an engine, and a row already on `acp` is never rewritten, so a second boot cannot overwrite a launcher the scanner has since corrected. The order inside is load-bearing — the config is written *from* `driver` before `driver` is overwritten, both statements selecting on the same predicate, so an interrupted run re-runs cleanly. `json_object` rather than a string literal, because a hand-rolled `'{"launcher":"claude"}'` is one missed brace from a row whose config reads as null — which would put a Claude agent on the default engine until its next rescan. A row that already carries a `driver_config` is left alone: nothing wrote one before this migration, so a value there came from a newer build or a repair.

Who writes the column:

| Writer | Value |
|---|---|
| `agentRepo` hand-added insert | `a2a` |
| `agentRepo.syncRemote` insert | `a2a` |
| `replaceFolderIndex`, insert | `driver = 'acp'`, `driver_config = launcherConfig(entry.launcher ?? DEFAULT_AGENT_ENGINE)` |
| `replaceFolderIndex`, update | `driver = 'acp'`, launcher = `entry.launcher ?? launcherOfConfig(existing.driverConfig) ?? DEFAULT_AGENT_ENGINE` — a row that had none takes the default rather than staying unset |
| `updateFolderIndex` | `driver = 'acp'`; the launcher is written only when `entry.launcher` is not null, so an unreadable manifest keeps what the row had |
| `setFolderLauncher(userId, agentId, launcher)` | The write a watcher never sees — a bare agent's runtime lives outside its folder. Folder rows only (`source = 'folder'` is in the `WHERE`); returns whether a row changed |
| Driver migrations | agent-drivers backfills NULL by legacy ownership; acp-driver then converts old engine driver IDs and launcher config. No separate boot-time heal or read-time guess remains. |

`FolderIndexEntry.launcher` is `null` for exactly one state: an `unresolved` folder, whose manifest could not be read (`folderIndexLauncher`). Neither index writer reaches an `unresolved` folder today — `scanRoot` holds it back, and `reindexAgent` finds no row for its placeholder id — so the null is the rule written down where a future writer will meet it.

## IPC Channels

| Channel | Type | Signature | Notes |
|---|---|---|---|
| `agent:list` | invoke | `() → AgentData[]` | Each row gains `driver`, `capabilities` and `readiness`. Listing starts the background checks and returns without waiting for them |
| `agent:check-readiness` | invoke | `(agentId) → AgentReadiness \| null` | Activation-gated. Looks the agent up with `findAgent` across both scopes, answers `null` when it is not found, otherwise `refresh(userId, row, {fresh: true})`. `null` reads as "not known", never as a refusal |
| `agent:readiness-changed` | main → renderer | `AgentReadinessChangedPayload {agentId, readiness}` | Sent through `getMainWindow().webContents.send` when a refusal appears, goes away or changes. The renderer re-reads the list, which carries the new answer |
| `agent:send-message` | on (MessagePort) | `AgentSendPayload` — unchanged | Resolves the driver, lets `resolveCommandRunner` swap in a catalog command, then hands `streamToAgent` a bound `run` |
| `agent:answer-request` | invoke | unchanged shape | Answered by the parking agent's driver; an ask whose row is gone goes to `respondToOrphanedAsk` |

`src/main/ipc/registration.test.ts` also asserts that **every channel the preload invokes has a handler**. A readiness re-check the renderer fires and forgets would otherwise reject with "No handler registered", and nobody would see it.

## Services & Key Methods

### The `AgentDriver` interface (`driver.ts:86`)

| Member | Contract |
|---|---|
| `id` | The `AgentDriverId` |
| `capabilities(agent)` | Pure and stable for a row: no I/O, the same answer on every call |
| `readiness(userId, agent, options?)` | Never throws. May do I/O. `null` means "could not tell". `options.fresh` skips any answer a probe holds behind its own cache. For a synced agent it may refresh — or, when the refresh is refused, clear — the stored Cinna session |
| `run(userId, agent, input)` | Never throws. `userId` is the scope that owns the row. Every failure, including the pre-flight, is `result.error` |
| `respond(ask, resolution)` | **Synchronous on purpose** — see [Permissions: ordering](../local_agents/permissions_tech.md#ordering-constraint-on-the-answer-path). Answers `{delivered: false}` when nothing is waiting |

`RunInput` is `{chatId, wireContent, fileIds?, signal, onEvent?, queueWhenBusy?}`. The internal autonomous runner sets queueWhenBusy so ACP acquires the existing per-agent lock through abortable withQueuedLock; ordinary calls retain immediate lock refusal. Separate runner task/agent queues and budgets are documented in [autonomous execution](../../jobs/tasks/autonomous_tasks_tech.md). The row and its owner are separate arguments.

### Capabilities per driver

| | `a2a`, Cinna-synced | `a2a`, hand-added | `acp`, launcher `opencode` | `acp`, launcher `claude` |
|---|---|---|---|---|
| `streaming` / `cancel` | yes / yes | yes / yes | yes / yes | yes / yes |
| `sessions` | `context` | `context` | `resumable` | `resumable` |
| `input` (asks raised) | `question`, `auth` | `question`, `auth` | `permission` | `permission`, `question` |
| `inputResume` | `next_message` | `next_message` | `reply` | `reply` |
| `attachments` | `cinna` | `none` | `none` | `none` |
| `auth` | `cinna` | `token` when one is stored, else `none` | `none` | `cli` |
| `commands` | `card` | `card` | `catalog` | `catalog` |
| `mcpInjection` | no | no | no | no |
| `cwd` | no | no | yes | yes |

**One driver, and still two answers, because a capability is about what the *engine* can do rather than about the protocol.** Both differences are measured and both move opposite to what a transport change would suggest: Claude **gains** questions (the adapter enables `AskUserQuestion` because the launcher declares `elicitation.form`) while OpenCode **loses** them (its `question` tool is not registered under `OPENCODE_CLIENT=acp`, and its ACP layer bridges none to `elicitation/create`). A launcher this build has no implementation for — `gemini`, `codex` — is described as a CLI-authenticated agent **with no question path**, because nothing here has run one and a capability that pretends otherwise would have the composer offer an answer widget for an ask that never arrives.

Capabilities read the **stored** launcher (`launcherOfRow`), because a row is all they have and the answer must be the same on every call.

"Synced" means `source === 'remote'` on an `a2a` row. That check lives here, which is where the kind branch belongs. hasRunConfig first requires a supported driver, then requires a card URL only for A2A; a valid ACP agent legitimately has no card URL.

### `driverOf.ts`
- `driverOfRow(agent)` returns a supported explicit AgentDriverId or null. It never consults source. driverFor returns unsupportedDriver for null; capabilitiesFor returns inert capabilities and hasRunConfig returns false. toDto preserves row.driver and directly supplies unsupported readiness even when the readiness cache contains an older ok.
- `launcherOfRow(agent)` reads `driver_config.launcher`, falling back to the **default engine** rather than refusing: the value is a cache of what the folder said, and a stricter read would only produce a broken agent list while a rescan caught up
- `launcherOfFolder(runtime)` trims a string `runtime.engine`; an unrecognised or missing engine is the default engine. The same tolerant read `runtimeService` makes — and **never null**, which is the distinction `folderIndexLauncher` exists to keep

### The `acp` driver (`acp/acpDriver.ts`)

- **`run`** reads the folder (`readAcpFolder`), refuses on gone / switched off / `invalid` / `contract_too_new`, takes the launcher from `launcherOfFolder(folder.runtime)`, refuses a launcher this build does not have, asks the launcher to `plan()` — a refusal there is the turn's error — and only then takes the turn lock. Everything after the lock is [the turn](../local_agents/agent_turn_tech.md)
- **The stored launcher is not consulted by `run` at all.** It is a cache of the same read, and every state where the folder cannot speak for itself was already refused above. The one reader left for it is `capabilities()`
- **`readiness`** is `folderReadiness(readAcpFolder(…))`, then — only for an `ok` folder — the rungs of the launcher the **folder** names. Any throw becomes `invalid` with `ACP_FOLDER_NOT_FOUND`
- **`folderReadiness`**:
  - `null` → `invalid` with `ACP_FOLDER_NOT_FOUND`
  - `ok` → `ok`
  - the three folder states → that state, with the folder's `readinessReason` or a generic sentence
  - a readiness this build does not know → `invalid`, because it is not one this build can vouch for
- **`respond`** calls `respondToAcpAsk`, which writes an *Always allow* **first** and then settles the park — the resolution has to carry `remembered` into the transcript, so the write cannot move after the resolve. An `always` becomes `once` with `remembered` taken from `rememberGrant`, or `remembered: false` when the store refused: the user allowed the action, so a failed write must not cancel it
- **`respondToOrphanedAsk`** uses the same function with `rememberGrant: () => false`. An `always` for a row pruned mid-turn settles as `once`, `remembered: false` — there is no agent left to keep a rule beside

### The launchers (`acp/acpLaunchers.ts`)
- **`claudePath(options)`** — tool detection is memoized for the life of the app. A fresh check that finds no binary calls `toolDetectionService.refresh()` first, so a Claude Code installed a minute ago counts
- **`claudeAuth(options)`** — `claudeAuthProbe.refresh()` when fresh, otherwise `.status()`
- **The Claude rungs.** No path → `not_installed`, with `describeEngineSkip('claude_not_installed')`. A definite `logged_out` → `not_logged_in`, with `describeEngineSkip('claude_not_logged_in')`. Anything else, including a probe that could not answer, is `ok`
- **The OpenCode launcher has no `readiness`**, deliberately: its binary is one this app will download, so its absence is not a state a user has to fix, and a list must never start a download to answer a question about a row

### The `a2a` driver
`run` first returns an empty result with `taskState: 'canceled'` for an already-aborted signal. Otherwise, in order:
1. No `cardUrl` → `AGENT_NOT_CONFIGURED`
2. `resolveEndpoint` throws:
   - a re-auth → `CINNA_SESSION_EXPIRED_MESSAGE` with `CINNA_REAUTH_REQUIRED_CODE`
   - an `AgentError` → its message
   - anything else → `Failed to resolve agent endpoint: …`
3. `resolveEndpoint` returns `null` → `NO_ENDPOINT_CONFIGURED`
4. `resolveAccessToken` throws → the same re-auth mapping
5. Endpoint and token waits use `resolveForTurn`, which races the signal and checks it before entering deferred work. Abort returns the canceled result and sends nothing; late resolution or rejection is observed without starting the turn. It does not cancel a shared token refresh
6. Otherwise `runTurn(…)`, with `isCinnaTokenAuth: capabilitiesFor(agent).auth === 'cinna'`. The abort listener and both identity callbacks call the same cancellation check: once aborted and both client and task ID are known, send `client.cancelTask({id})` at most once. Late callbacks can still trigger that request; duplicate callbacks cannot repeat it. The driver does not await acknowledgement and logs failures

**Transport cancellation uses the legacy client's fetch seam.** The installed `@a2a-js/sdk` 0.3.13 exposes per-call `RequestOptions.signal` on its newer Client/Transport API, but the imported legacy `A2AClient` does not accept those options. `createA2AClient` in `src/main/agents/a2a-client.ts` binds the optional turn signal to raw-card fetch and the injected fetch implementation. This interrupts card and JSON headers/body waits and silent SSE reads, including logging clones/tees. Any existing request signal is combined with it. JSON-RPC `tasks/cancel` instead gets an independent ten-second deadline, because reusing the aborted turn signal would suppress the cancellation request itself. No SDK upgrade or new protocol is involved.

`runAgentTurn` in `src/main/services/a2aStreamingService.ts` checks abort around awaits, before/after each event callback, and before successful session persistence. Task identity is surfaced before the first message/artifact delta; artifact updates report only a changed ID. The accumulator records each part before forwarding, so a synchronous Stop inside a delta retains exactly that visible partial output and emits nothing afterward. Abort returns partial text/parts/notices with an error and performs no session upsert; the previous stored checkpoint remains unchanged. The direct-chat wrapper saves partial output, emits `done(canceled)`, reports cancellation and releases its active request. The tool caller receives the error-bearing result. See [Streaming Pipeline](../agents/streaming_pipeline.md#cancellation-and-session-checkpoints) for the persistence boundary.

`readiness` checks, all inside `withTimeout(…, A2A_READINESS_TIMEOUT_MS)`:
- No card → `invalid`, *"This agent has no card URL. Add one in Settings → Agents."*
- The token throws → `not_logged_in` for a re-auth; otherwise `invalid`
- Otherwise `fetchCard(cardUrl, token)`

It writes no resolved endpoint and raises no re-auth UI. A failure goes through `cardFailure`, whose `detail` is always `humanizeA2AError(err)`:
- the timeout → `null`
- a re-auth → `not_logged_in`
- 401/403 → `not_logged_in` for a synced agent, `credentials_needed` for a hand-added one (*"The agent refused its access token (401). Check it in Settings → Agents."*)
- an `AgentCardFetchError` of 500 or more → `unreachable` (*"The agent's server returned an error (502)."*); below 500 → `invalid` (*"There is no agent card at this address (404)."*)
- a `TypeError` (the socket never opened) → `unreachable`, *"Can't reach this agent."*
- anything else → `invalid`, *"This agent's card can't be used by this app."*

Its wiring: `createA2aDriver({runTurn: runAgentTurn, resolveEndpoint: resolveEndpointIfNeeded, resolveAccessToken, fetchCard: fetchAgentCard, isReauthRequired: (err) => err instanceof CinnaReauthRequired})`. The re-auth predicate arrives injected rather than imported because `cinna-oauth` names Electron, and the golden tests drive this driver without it.

### `agentReadinessService`
- **`install(deps)`** — the probe, the broadcast and an optional clock. Until it is installed nothing is probed and every answer is `null`, which is exactly the default that blocks nothing
- **`peek(agentId)`** — the last answer, or `null`
- **`refresh(userId, row, options)` → `run`:**
  - It joins a check already running for the agent, unless the check is `fresh`
  - It captures the agent's epoch and a start sequence (`++sequence`)
  - It starts the probe synchronously and turns a synchronous throw into a rejection, so the in-flight entry is set before the body's `finally` can clear it. A probe that threw synchronously once cleared the map before the entry was set, leaving a settled promise there that answered every later check without asking
  - A rejection keeps the last answer. An agent forgotten while its probe ran → `null`
  - `stored.seq > seq` keeps the newer answer
  - Otherwise it stores the answer and broadcasts when `changed`. A broadcast that throws is logged
- **`kick(rows)`:**
  - Not installed → nothing
  - A disabled row → `forget`
  - A row already in flight or queued is skipped
  - Otherwise the row rests for `REFUSAL_RECHECK_FLOOR_MS` if its answer refuses, else for `ttlFor(row)` — `capabilitiesFor(row).cwd` picks the local or remote TTL — and is queued once that has passed. Then `pump()`
- **`pump()`** — at most one `setTimeout(0)` pending. Each tick starts one queued check while `running < READINESS_CONCURRENCY`, and schedules the next. `generation` stops timers and completions from before a `reset` touching anything after it
- **`forget(agentId)`** — deletes the entry, bumps the epoch, and removes the agent from the queue
- **`changed(prev, next)`** — `false` when neither answer refuses; otherwise whether the state or the reason differs
- **`reset()`** — tests only

## Renderer Components

- **`useComposerReadiness(target, typed)`**
  - Clears the check's and the re-auth's earlier failure when the agent id, the refusal's state or its reason changes
  - `reauthable = refusal.state === 'not_logged_in' && target.capabilities.auth === 'cinna'` picks *Re-authenticate* (`Signing in…` while pending) over *Check again* (`Checking…`)
  - A failure of either action is appended as ` Couldn't re-authenticate — …` or ` Couldn't check again — …`
  - `blocksSend` is `!isCatalogCommand(target, typed)`
  - `text` is `readinessText` plus that suffix, and `title` is `readinessTitle` plus that suffix
- **`isCatalogCommand(agent, typed)`** — `agent.capabilities.commands === 'catalog'` and `RUN_REFERENCE_PATTERN.test(typed.trim())`, the same grammar as main's `matchRunCommand`
- **`readinessTitle(r)`** — `r.detail || readinessText(r)`. `readinessText(r)` is `r.reason ?? 'This agent is not ready to take a message.'`
- **`readinessSeverity`** — `credentials_needed`, `not_logged_in` and `not_installed` are `warning`; `unreachable`, `invalid` and `contract_too_new` are `danger`
- **`ComposerReadinessLine`** — a fixed-height (`h-4`) `data-readiness-line` row under the controls row. In an active chat it is rendered whenever the chat holds an agent **at all** — refused or not, and whoever is answering right now — so neither a refusal arriving nor a router change moves anything. Gating it on the agent that would *answer* lifted the whole composer 21px when the user handed the chat to the model, which is not an agent whose readiness there is anything to say about. On the new-chat screen it is rendered whenever a message would go straight to an agent. It holds:
  - a truncating `role="status"` `aria-live="polite"` span carrying `id={reasonId}`, which Send's `aria-describedby` points at
  - an `aria-hidden` `·` separator
  - an action button that is `aria-disabled` while pending, with `min-w-[6.5rem]` or `min-w-[5rem]` depending on its longer label

  It used to sit inline in the controls row, where the action and separator cost about 100px. There they wrapped two chips at the narrowest window and four at every width, moved the textarea when the refusal cleared, and squeezed the reason itself to nothing — leaving "· Check again" with no sentence before it
- **`RefusableExamplePrompts`** — two wrappers that are always rendered. The outer one carries `title={readinessTitle}`, `aria-disabled` and `cursor-not-allowed`; the inner one carries `inert` plus `opacity-50 pointer-events-none`. A refusal arriving or clearing swaps classes rather than the tree, so the tags keep their footprint and do not replay their entry animation
- **`ChatInput.directTarget`** — the agent a message goes *straight* to, which is the only agent the composer refuses a send to. An agent the local model calls as a tool is not refused here: its failure comes back as a tool call the model can read
  - In an existing chat: the router's own answer — `routingOf(chat).answerer({ addressed, lastAddressed, attached })` resolved to an agent row, so in a chat the user routes the refusal names **the addressed agent**
  - In a new chat: `selectedAgent`, when `routerInfo.router !== 'coordinator'`
  - See [Chat Routing](../../chat/chat_routing/chat_routing.md)
- **`AgentCard`**
  - `readinessIssue` requires `agent.enabled`, and a state that is not `ok`
  - The reason renders while `readinessIssue && !testAgent.data?.success`. A failed test does not replace it; a passing test shows *Connected*, since the re-check the same press started clears the reason moments later; a failed test's error, with itself as its `title`, renders only when there is no refusal
  - Test Connection is `min-w-[6.5rem]`, so its *Testing…* label does not slide the reason sideways
- **`useAgents`** — on a push it calls `invalidateQueries(['agents'], {cancelRefetch: false})`. Every mounted `useAgents` hears the push, and a plain invalidate cancels the fetch the previous listener just started and starts its own, so one push became one `agent:list` per mounted hook
- **`useCheckAgentReadiness`** — `onSettled` invalidates `['agents']` whatever the answer. The push fires only when an answer *changed*, and a check the user asked for should visibly finish even when it did not
- **`useChatStream`** — after `error` on a direct agent turn it calls `window.api.agents.checkReadiness(agentId).catch(() => undefined)` inside a `try`, so a re-check that cannot run leaves the turn's own ending untouched

## Optional status and tool-provider contracts

`src/main/agents/status/contract.ts` defines reported-status access independently of `AgentDriver`. `statusSourceFor` selects an optional owner from a fresh scoped row; caller intent controls what is requested while the source decides whether to read a file or refresh a Cinna environment. Only explicit per-agent manual intent runs a folder command. See [Agent Status technical details](../agent_status/agent_status_tech.md).

Agent-as-tool wrappers provide static history attribution and an event sink through `ToolProvider`. The wrapper frames driver events as children; the model loop does not choose this behavior from presentation type. Coordinator authority remains an explicit separate check. See [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents_tech.md).

## The kind-branch ratchet

`src/main/agents/kindBranches.test.ts` counts literal comparisons of these names against their kind values, across `src/main`, `src/shared` and `src/renderer/src`:
- `source` / `…Source`
- `engine` / `…Engine`
- `kind` / `…Kind`
- a job's bare `type`
- `providerType`

It also counts comparisons against `FOLDER_AGENT_SOURCE` and calls of the two folder-agent predicates its header names. Test files, `__golden__` and `__snapshots__` are skipped, and comments are blanked before matching. The walk runs in Node, never in shell `grep`.

- **`ALLOWLIST`** (`:108`) — `src/main/agents/drivers/` and four sync files. Their counts are printed but never held against a limit: a driver is where a kind branch belongs, and ownership is what sync decides
- **`OWNERSHIP`** — exact per-file/category pins for data ownership, schema authoring, presentation and trusted execution authority. The earlier source ownership examples include:
  - `agentService.ts` 7
  - `localAgentService.ts` 3
  - `jobService.ts` 4
  - `AgentsSettingsSection.tsx` 2
  - `AgentCard.tsx`, `CatalogSettingsSection.tsx`, `JobEditForm.tsx`, `JobDetail.tsx` — 1 each

  These files are not allowlisted, because a whole-file pass would hide the next behavioural branch added beside them. A count that moves in either direction fails until someone reads the branch and decides which kind it is; a behavioural one moves into a driver
- **`LIMITS`** — every category and aggregate `LIMIT` are zero for counted behavioral debt. The status/tool cleanup replaced six behavioral consumers, classified 42 existing kind/layout/authoring and one presentation comparison, and pinned two status-factory ownership sites plus one newly scanned coordinator-authority check. Job cleanup replaces eight behavioral consumers, classifies 22 existing provenance/schema comparisons, and pins two definition-policy comparisons plus one legacy-adoption site. Physical ownership/presentation comparisons remain visible with exact per-file counts; zero is not a claim that all branches disappeared. See [Job executor ownership](../../jobs/jobs/execution_tech.md).
- **`NOT_A_KIND_BRANCH`** (`:182`) — drops three named comparisons on unrelated `'local' | 'cinna'` unions
- **Blind spots**, listed in the file's header — none of these are counted:
  - a `switch` / `case` on a kind
  - membership tests and lookups (`.includes`, `LABELS[agent.kind]`)
  - any helper other than the two named; a new helper stays invisible until its call pattern is added
- Every allowlist, ownership and exclusion entry must name a path that exists

## Configuration

No app setting and no environment variable. Constants:

| Constant | Where | Value | Why |
|---|---|---|---|
| `REMOTE_READINESS_TTL_MS` | `agentReadinessService.ts:43` | 60 s | Each refresh is a card fetch, and for a synced agent a token resolve that may refresh the session |
| `LOCAL_READINESS_TTL_MS` | `agentReadinessService.ts:51` | 10 s | One folder read; a hand-made fix should be picked up without a click |
| `READINESS_CONCURRENCY` | `agentReadinessService.ts:54` | 4 | A list of many synced agents is many card fetches |
| `REFUSAL_RECHECK_FLOOR_MS` | `agentReadinessService.ts:66` | 5 s | Breaks a check → push → list → check loop on an answer that differs every time |
| `A2A_READINESS_TIMEOUT_MS` | `a2aDriver.ts:38` | 5 s | Bounds the whole check, token included. Overridable through `A2aDriverDeps.readinessTimeoutMs` **in tests only** |

The Claude login probe's own 30-second window (`CLAUDE_AUTH_TTL_MS`) is documented in [The Claude Engine (tech)](../local_agents/claude_engine_tech.md#claudeauthts--the-free-login-probe); a fresh check skips it.

## Security

- **No secret joins the DTO.** `capabilities.auth` says `token` when an access token is stored, never what the token is; token resolution stays in main (`a2aConnection.ts`)
- **`agent:check-readiness` takes an id, never a URL.** It is activation-gated and finds the row with `findAgent` in the caller's own scopes
- **A list never starts a process to answer readiness.** The OpenCode launcher has no readiness rungs at all, so nothing downloads or spawns. Claude readiness spawns only `claude auth status`, through the shared probe, which runs no turn and bills nothing
- **A grant is built only from the engine's recorded ask.** The ACP driver's `respond` builds it from the ask held in the pending registry, never from the renderer's payload. An answer for a row that has gone writes no rule

## Tests

- `src/main/agents/drivers/index.test.ts` — `driverFor` through the real wiring, with the module graph below it mocked:
  - an A2A row reaches the A2A driver without any folder being read
  - the same driver on every call
  - every folder row reaches the ACP driver, whatever its stored launcher
  - an unknown request is answered with nothing delivered, through the real registry
- `src/main/agents/drivers/capabilities.test.ts` — every assertion stands in for a `source` comparison that used to live elsewhere: the attach gate, the re-auth flag, the `/run:` interception, and the two per-launcher differences (Claude has a question path, OpenCode does not; an unbuilt launcher claims none)
- `src/main/agents/drivers/acp/acpDriver.test.ts` —
  - the launcher taken from the folder while the row still says the other engine, and a folder that names no engine running on the default
  - the refusals, in order and in their own words: folder gone, switched off, `invalid`, an engine this build cannot run, a launcher that refused
  - folder readiness never throwing, and the launcher's rungs asked only after the folder is `ok`
  - `respond`: nothing waiting; *Always* stored **first**, then `once`; a refusing store still allowing, with `remembered: false`; no grant without a recorded ask
  - the whole turn against the fake ACP agent, plus `describeDriverContract('acp', …)`
- `src/main/agents/drivers/acp/acpLaunchers.test.ts` — what each launcher writes, declares and refuses
- `src/main/agents/drivers/acp/shutdown.test.ts` — that `will-quit` really reaches the pool, read from the entry point the way `registration.test.ts` reads the IPC modules. The hook had no caller at all when it was first written, and every test passed
- `src/main/agents/drivers/a2aDriver.test.ts` —
  - `run`: the pre-flight handed through; a stream 401 treated as a re-auth only for a synced agent; a missing card refused before anything is resolved; no endpoint; a token failure; a stop during the pre-flight sending nothing; cancel sent once, and not before a task exists; `respond` never delivering
  - `readiness`: `ok`; a disabled row probed like any other; no card; an expired session as a state; a 401 for synced versus hand-added agents; unreachable, with `detail`; `null` when the card times out and when the token hangs; 4xx versus 5xx; an unusable card; never throwing, even synchronously
- `src/main/services/a2aCancellation.test.ts` — actual loopback HTTP through the installed SDK and logging fetch: stalled card/JSON headers and bodies, silent SSE, and Stop inside the first task-message or artifact delta. Requires prompt settlement, exact partial output, no checkpoint update and an actual cancel RPC after abort
- `src/main/agents/drivers/golden.a2a.test.ts` — held-stream abort must settle without another frame; its fake honors fetch signals and returns a distinct cancellation response. Cancel goldens retain partial output and do not advance sessions. Task-failed and nonstreaming JSON-RPC errors now require failed outcomes; their former known-failure exemptions are removed. See [typed completion](../../chat/messaging/turn_completion.md)
- `src/main/services/agentReadinessService.test.ts` — the cache:
  - nothing known before a check, and nothing probed before install
  - overlapping checks coalesced
  - the push rules; the remote and local TTLs; a refusal re-checked on the next list, and resting first
  - the start-order guard; the reset generation; a fresh check past a list check already running; a synchronous throw not stranded
  - the first list checking every agent; a disabled agent forgotten; the concurrency cap; one start per macrotask
  - `null` refusing nothing; no double queueing
  - a throwing driver or broadcast; a forgotten answer not coming back
- `src/main/services/agentService.readiness.test.ts` — readiness on the DTO; `kick` with each row's own scope; `forget` on delete and on switch-off, including a synced agent switched off by its profile
- `src/main/ipc/agent.ipc.checkReadiness.test.ts` — the check runs in the owning scope with `fresh: true`; `null` for an agent that is not found; the installed probe passes the options on to the driver
- `src/main/ipc/agent_a2a.answerRequest.test.ts` — *what reaches the driver*, including a gone row whose answer is still delivered with no rule; `src/main/ipc/run.commandDispatch.test.ts` — `streamToAgent` receives `resolveCommandRunner`'s turn rather than the driver's own (the dispatch moved with the send path onto `run:send`; the command is still matched on the *typed* text, never on the catch-up packet in front of it)
- **Persistence:**
  - `src/main/db/agents.test.ts` — *the driver a row names*
  - `src/main/db/migrations/migrations.test.ts` — *adds the driver columns*, and *agents.driver on an install that predates it*: mapped by source, a no-op on replay, never rewriting a row that names a driver
  - `src/main/services/localAgents/scannerService.test.ts` — *the driver a folder row names*: the manifest's engine; the default engine, following an edit; no answer for an unreadable manifest; staying on Claude while the manifest is unparseable; a bare folder's desktop state
  - `src/main/services/localAgents/localAgentService.test.ts` — *the driver follows an engine chosen in the app*, and moving the row to the engine an edit on disk names
- **Contract:** `src/main/agents/drivers/__golden__/driverContract.ts` — `describeDriverContract(name, makeSubject, options)`, called once at the bottom of `golden.a2a.test.ts` and once at the bottom of `acpDriver.test.ts`. It runs every turn through `driver.run`. Its three driver clauses are `capabilities.stable`, `readiness.never_throws` and `respond.unknown`, and its subjects are built with `__golden__/driverWorld.ts`. See [the driver contract](../local_agents/agent_turn_tech.md#the-driver-contract)
- **Renderer:**
  - `ChatInput.readiness.test.tsx` —
    - refused and not refused; the reason never moving while the user types; the tooltip
    - the reason on a line of its own under the controls row; that line reserved for a ready direct agent too, and absent where nothing can be refused
    - *a catalog /run: always runs*
    - Check again: its focus while running, focus handed to the message box when it clears the refusal (and taken from nowhere else), and its failure
    - Re-authenticate
  - `ComposerReadiness.test.tsx` — `isCatalogCommand`'s grammar, and `RefusableExamplePrompts`
  - `AgentCard.readiness.test.tsx` —
    - the dot, the glyph, the tooltip and the reserved width
    - a healthy card and a switched-off card
    - Test re-checking
    - a failed Test keeping the reason rather than its raw error; a failed test's error, with itself as tooltip, when readiness has nothing to say; *Connected* shown over a reason the re-check has not cleared yet
  - `useAgents.readinessPush.test.tsx` — one list read per push
  - `useChatStream.readinessRecheck.test.tsx` — a re-check after `error`, none after `done`, and a refused re-check leaving the turn's ending intact
- **E2E:** `e2e/specs/driver-readiness.spec.ts` — an unreachable hand-added A2A agent, end to end, with a negative control: deleting the refusal term from Send's `disabled` fails the spec at `toBeDisabled()`

## Compatibility cleanup boundaries

The shared pending registry and A2A golden/contract files live at the driver root; Claude auth, environment, permissions and subagent-reading helpers live under acp. All 75 former agent-turn helper/fixture files were relocated; golden bytes and runtime behavior are retained, with only relative imports changing. There is no services/agentTurn implementation directory.

ResolvedRuntime now calls its derived output launcher. It is not execution authority: current consumers use model/credential outputs, while drivers resolve their own configuration. The manifest still authors runtime.engine. The compatibility-only change did not reduce the counted ratchet. Status/tool cleanup brought it to 30; the owned Job execution/refresh seam brings counted behavioral debt to zero with the explicit classifications described above. Protocol upgrades and additional drivers remain separate work. Tests for unsupported identity cover direct refusal and raw DTO visibility despite stale ready cache; populated migration tests preserve old and unknown IDs.
