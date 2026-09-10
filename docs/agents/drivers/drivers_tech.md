# Agent Drivers & Readiness — Technical Details

Implementation reference for [Agent Drivers & Readiness](drivers.md). The runners each driver wraps are documented in [The Agent Turn Runner (tech)](../local_agents/agent_turn_tech.md) and [The Claude Engine (tech)](../local_agents/claude_engine_tech.md) and are not restated here.

## File Locations

### Shared
- `src/shared/agentDrivers.ts` — type-only plus one guard, so the renderer can import it (capabilities and readiness cross IPC on the agent DTO). Exports:
  - `AgentDriverId` (`:23`), `AGENT_DRIVER_IDS` (`:25`), `isAgentDriverId()` (`:28`)
  - `AgentCapabilities` (`:32`)
  - `AgentReadinessState` (`:76`), `AgentReadiness` (`:85`)
  - `AGENT_READINESS_CHANGED_CHANNEL` (`:103`), `AgentReadinessChangedPayload` (`:106`)

### Main process — `src/main/agents/drivers/`
- `driver.ts` — the interface, type-only:
  - `RunInput` (`:38`)
  - `RunResult` (`:54`) — `RunAgentTurnResult` unchanged, so the golden expectations stay byte-identical
  - `ParkedAsk` (`:57`), `RespondOutcome` (`:66`), `ReadinessOptions` (`:76`)
  - `AgentDriver` (`:86`)
- `capabilities.ts` — `capabilitiesFor()` (`:20`), the private `folderCapabilities()` (`:66`), `hasRunConfig()` (`:90`). Pure and import-light: `agentService` maps it into every DTO and the readiness service picks a TTL with it, so it must not pull the production wiring in `index.ts` into the service layer
- `driverOf.ts` — `driverOfFolder(runtime)` (`:19`), `driverOfRow(agent)` (`:32`). It imports nothing but shared types, so the scanner and the DTO mapper can use it
- `folderDriver.ts` — what `opencode` and `claude` share:
  - `FOLDER_NOT_FOUND` (`:39`), `FolderView`, `FolderDriverDeps`, `FolderDriver`
  - `createFolderDriver()` (`:82`), with `run` (`:110`) and `runHere` (`:134`)
  - the private `reconcile()` (`:163`)
  - `folderReadiness()` (`:171`)
  - `respondToParkedAsk()` (`:206`) and the private `rememberIfAlways()` (`:244`)
- `opencodeDriver.ts` — `createOpencodeDriver()`: `createFolderDriver('opencode', deps)`, with no readiness step beyond the folder's
- `claudeDriver.ts` — `createClaudeDriver()` (`:24`). Its extra readiness step (`:26`) adds `not_installed` and `not_logged_in`
- `a2aDriver.ts` —
  - `AGENT_NOT_CONFIGURED` (`:33`), `NO_ENDPOINT_CONFIGURED` (`:35`), `A2A_READINESS_TIMEOUT_MS` (`:38`)
  - `createA2aDriver()` (`:68`), with `run` (`:74`), `readiness` (`:188`) and `respond` (`:234`)
  - the private `cardFailure()` (`:253`) and `withTimeout()`
- `a2aConnection.ts` — `rethrowAsReauthIfCinna401()` (`:41`), `resolveEndpointIfNeeded()` (`:66`), `resolveAccessToken()` (`:114`). Moved here from `agentService`; each decides by `capabilitiesFor(agent).cwd` / `.auth` rather than by `source`. `agentService.testAgent` and `listCliCommands` still use them for a card fetch
- `a2aErrors.ts` — `authRejectionStatus(err)`: a 401 or 403 from either `A2aHttpError` or `AgentCardFetchError`. It is its own module so the A2A driver can classify a rejection without importing `a2aConnection.ts`, which names the keystore and the Cinna OAuth flow
- `index.ts` — the production wiring and the resolver:
  - `engineEventBus` (`:70`) and the engine-stopped hook (`:87`)
  - `localDeps` (`:91`) and `localAgentTurnRunner` (`:174`)
  - `claudeAuthProbe` (`:188`), `claudeDeps` (`:204`) and `claudeAgentTurnRunner`
  - the private `readFolder()` (`:267`) and `rememberGrant()` (`:300`)
  - `folderDrivers` (`:325`) and `drivers` (`:345`)
  - `driverFor()` (`:365`) and `respondToOrphanedAsk()` (`:379`)

  **It is the only file in this folder that imports Electron**, and the only one that names `engineManager`, `localAgentService`, `desktopStateService` or `a2aSessionRepo`

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
- `src/main/services/localAgents/scannerService.ts` — `folderIndexDriver(dto)` (`:427`), passed on both index writes (`:752`, `:872`)
- `src/main/services/localAgents/localAgentService.ts` — `reindexAgent` (`:622`, which is how a kit agent's `updateField` runtime save reaches the row) and `renameAgent` (`:1577`) pass `folderIndexDriver(dto)`; `setBareRuntime` calls `agentRepo.setFolderDriver` (`:1630`–`:1631`)
- `src/main/db/schema.ts` — `agents.driver` (`:251`), `agents.driverConfig` (`:253`)
- `src/main/db/migrations/agent-drivers.ts` — `migrateAgentDrivers()`, called from `src/main/db/migrations/index.ts:79`
- `src/main/db/agents.ts` —
  - `FolderIndexEntry.driver` (`:117`)
  - `driver: 'a2a'` on the hand-added insert (`:181`) and the sync insert (`:330`)
  - the folder writes in `replaceFolderIndex` (`:429` update, `:464` insert) and in `updateFolderIndex` (`:497`)
  - `setFolderDriver()` (`:509`), `healMissingDrivers()` (`:530`)
  - `agentSessionRepo` (`:846`) — the same object as `a2aSessionRepo`, under a driver-neutral name
- `src/main/db/client.ts` — `runConsistencyChecks()` runs the `agents-driver-populated` check (`:57`)
- `src/main/services/agentTurn/runner.ts` — `AgentTurnRunner` only. The runner no longer decides which agents it serves

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
| `driver` | `TEXT`, an `AgentDriverId`. Nullable in SQLite, but written on every insert and filled for existing rows by the migration's backfill. `driverOfRow` still falls back for a value this build does not recognise, which only a newer build can have written |
| `driver_config` | `TEXT`, JSON (`mode: 'json'` in Drizzle). The driver's own settings, opaque outside `src/main/agents/drivers/`. Nothing reads or writes it yet |

The migration is placed after every table-creation migration, returns early without `hasTable('agents')`, and gates each `ADD COLUMN` with `hasColumn`. Its backfill is `UPDATE … WHERE driver IS NULL`: `a2a` for `source IN ('local', 'remote')`, and `opencode` for `source = 'folder'`. That predicate is also what makes it idempotent — a row that names a driver is never rewritten, so a scanner's correction of a Claude folder backfilled as `opencode` survives every later launch. See [Database Migrations](../../development/migrations/migrations_llm.md).

Who writes the column:

| Writer | Value |
|---|---|
| `agentRepo` hand-added insert | `a2a` |
| `agentRepo.syncRemote` insert | `a2a` |
| `replaceFolderIndex`, insert | `entry.driver ?? DEFAULT_AGENT_ENGINE` |
| `replaceFolderIndex`, update | `entry.driver ?? existing.driver ?? DEFAULT_AGENT_ENGINE` — a row that had none takes the default rather than staying unset |
| `updateFolderIndex` | `entry.driver` when it is not null; otherwise the column is left alone |
| `setFolderDriver(userId, agentId, driver)` | Folder rows only (`source = 'folder'` is in the `WHERE`); returns whether a row changed |
| `healMissingDrivers()` | Rows where `driver IS NULL`, **across every user**, by the migration's own rule. A value this build does not recognise is left alone. Called by the `agents-driver-populated` boot check, which logs `boot-cleanup:filled-missing-agent-drivers` at `warn` when it fills anything |

`FolderIndexEntry.driver` is `null` for exactly one state: an `unresolved` folder, whose manifest could not be read (`folderIndexDriver`). Neither index writer reaches an `unresolved` folder today — `scanRoot` holds it back, and `reindexAgent` finds no row for its placeholder id — so the null is the rule written down where a future writer will meet it.

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

`RunInput` is `{chatId, wireContent, fileIds?, signal, onEvent?}`. The row and its owner are separate arguments.

### Capabilities per driver

| | `a2a`, Cinna-synced | `a2a`, hand-added | `opencode` | `claude` |
|---|---|---|---|---|
| `streaming` / `cancel` | yes / yes | yes / yes | yes / yes | yes / yes |
| `sessions` | `context` | `context` | `resumable` | `resumable` |
| `input` (asks raised) | `question`, `auth` | `question`, `auth` | `permission`, `question` | `permission` |
| `inputResume` | `next_message` | `next_message` | `reply` | `reply` |
| `attachments` | `cinna` | `none` | `none` | `none` |
| `auth` | `cinna` | `token` when one is stored, else `none` | `none` | `cli` |
| `commands` | `card` | `card` | `catalog` | `catalog` |
| `mcpInjection` | no | no | no | no |
| `cwd` | no | no | yes | yes |

"Synced" means `source === 'remote'` on an `a2a` row. That check lives here, which is where the kind branch belongs. `hasRunConfig(row)` is `driverOfRow(row) !== 'a2a' || !!row.cardUrl`: a folder agent legitimately has no card URL.

### `driverOf.ts`
- `driverOfRow(agent)` returns `agents.driver` when `isAgentDriverId` accepts it. Otherwise it falls back by ownership: a `folder` row gets `DEFAULT_AGENT_ENGINE`, anything else gets `a2a`. The fallback exists for a database a newer build touched; it is not a reason to leave the column empty
- `driverOfFolder(runtime)` trims a string `runtime.engine`; an unrecognised or missing engine becomes the default engine. This is the same tolerant read `runtimeService` makes, so a folder written by a newer tool keeps running

### Folder drivers (`folderDriver.ts`)
- **`run`** calls `reconcile(id, deps.readFolder(userId, agent.id))`. When the target differs from `id` and `deps.sibling(target)` exists, it runs `other.runHere(…)` and logs at `info` with both `stored` and `folder`. Otherwise it runs `runHere`
- **`reconcile`** keeps the stored driver when the folder is `null`, `invalid` or `contract_too_new`. Otherwise it returns `'claude'` when `driverOfFolder(runtime)` is `'claude'`, and `'opencode'` in every other case
- **`runHere`** maps `RunInput` onto the wrapped runner's `runTurn({chatId, agentId, agentName, wireContent, fileIds, signal, onEvent})`
- **`readiness`** is `folderReadiness(readFolder(…))`. Only an `ok` folder goes on to the driver's extra readiness steps. Any throw becomes `invalid` with `FOLDER_NOT_FOUND`, logged
- **`folderReadiness`**:
  - `null` → `invalid` with `FOLDER_NOT_FOUND`
  - `ok` → `ok`
  - the three folder states → that state, with the folder's `readinessReason` or a generic sentence
  - a readiness this build does not know → `invalid`, because it is not one this build can vouch for
- **`respond`** calls `respondToParkedAsk`. `rememberIfAlways` runs first: an `always` becomes `once`, with `remembered` taken from `rememberGrant` — or `remembered: false` when no ask was recorded. Then `resolveRequest` runs. The outcome is `{delivered: false}` when nothing is waiting; `remembered` is present only for a permission answered `always`
- **The production `readFolder`** (`index.ts:267`) turns `localAgentService.get` into a `FolderView`, and returns `null` (logged) when it throws
- **`sibling`** is `folderDrivers[id]`
- **`respondToOrphanedAsk`** uses the same registry with `rememberGrant: () => false`. An `always` for a row that was pruned mid-turn settles as `once`, `remembered: false`

### The `claude` driver
- **`claudePath(options)`** (`index.ts:333`) — tool detection is memoized for the life of the app. A fresh check that finds no binary calls `toolDetectionService.refresh()` and looks again; a check that finds a binary costs nothing extra
- **`claudeAuth(options)`** (`index.ts:341`) — `claudeAuthProbe.refresh()` when fresh, otherwise `.status()`
- **The steps.** No path → `not_installed`, with `describeEngineSkip('claude_not_installed')`. `logged_out` → `not_logged_in`, with `describeEngineSkip('claude_not_logged_in')`. Anything else → `ok`. A rejection from either probe is caught and read as no answer

### The `a2a` driver
`run`, in order:
1. No `cardUrl` → `AGENT_NOT_CONFIGURED`
2. `resolveEndpoint` throws:
   - a re-auth → `CINNA_SESSION_EXPIRED_MESSAGE` with `CINNA_REAUTH_REQUIRED_CODE`
   - an `AgentError` → its message
   - anything else → `Failed to resolve agent endpoint: …`
3. `resolveEndpoint` returns `null` → `NO_ENDPOINT_CONFIGURED`
4. `resolveAccessToken` throws → the same re-auth mapping
5. `signal.aborted` after the pre-flight → an empty success, and nothing is sent
6. Otherwise `runTurn(…)`, with `isCinnaTokenAuth: capabilitiesFor(agent).auth === 'cinna'`. An abort listener sends `client.cancelTask({id})` once, and only when `onClient` and `onTaskId` have both fired

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
- **`ComposerReadinessLine`** — a fixed-height (`h-4`) `data-readiness-line` row under the controls row. It is rendered whenever the composer has a direct target, refused or not, so a refusal arriving or clearing moves nothing. It holds:
  - a truncating `role="status"` `aria-live="polite"` span carrying `id={reasonId}`, which Send's `aria-describedby` points at
  - an `aria-hidden` `·` separator
  - an action button that is `aria-disabled` while pending, with `min-w-[6.5rem]` or `min-w-[5rem]` depending on its longer label

  It used to sit inline in the controls row, where the action and separator cost about 100px. There they wrapped two chips at the narrowest window and four at every width, moved the textarea when the refusal cleared, and squeezed the reason itself to nothing — leaving "· Check again" with no sentence before it
- **`RefusableExamplePrompts`** — two wrappers that are always rendered. The outer one carries `title={readinessTitle}`, `aria-disabled` and `cursor-not-allowed`; the inner one carries `inert` plus `opacity-50 pointer-events-none`. A refusal arriving or clearing swaps classes rather than the tree, so the tags keep their footprint and do not replay their entry animation
- **`ChatInput.directTarget`**
  - In an existing chat: the bound agent, unless `chatData.orchestrated`
  - In a new chat: `selectedAgent`, when `commPatternInfo.pattern === 'A2A'`
- **`AgentCard`**
  - `readinessIssue` requires `agent.enabled`, and a state that is not `ok`
  - The reason renders while `readinessIssue && !testAgent.data?.success`. A failed test does not replace it; a passing test shows *Connected*, since the re-check the same press started clears the reason moments later; a failed test's error, with itself as its `title`, renders only when there is no refusal
  - Test Connection is `min-w-[6.5rem]`, so its *Testing…* label does not slide the reason sideways
- **`useAgents`** — on a push it calls `invalidateQueries(['agents'], {cancelRefetch: false})`. Every mounted `useAgents` hears the push, and a plain invalidate cancels the fetch the previous listener just started and starts its own, so one push became one `agent:list` per mounted hook
- **`useCheckAgentReadiness`** — `onSettled` invalidates `['agents']` whatever the answer. The push fires only when an answer *changed*, and a check the user asked for should visibly finish even when it did not
- **`useChatStream`** — after `error` on a direct agent turn it calls `window.api.agents.checkReadiness(agentId).catch(() => undefined)` inside a `try`, so a re-check that cannot run leaves the turn's own ending untouched

## The kind-branch ratchet

`src/main/agents/kindBranches.test.ts` counts literal comparisons of these names against their kind values, across `src/main`, `src/shared` and `src/renderer/src`:
- `source` / `…Source`
- `engine` / `…Engine`
- `kind` / `…Kind`
- a job's bare `type`
- `providerType`

It also counts comparisons against `FOLDER_AGENT_SOURCE` and calls of the two folder-agent predicates its header names. Test files, `__golden__` and `__snapshots__` are skipped, and comments are blanked before matching. The walk runs in Node, never in shell `grep`.

- **`ALLOWLIST`** (`:108`) — `src/main/agents/drivers/` and four sync files. Their counts are printed but never held against a limit: a driver is where a kind branch belongs, and ownership is what sync decides
- **`OWNERSHIP`** (`:130`) — files whose `source` reads are about ownership (who may edit, delete or list a row, which account a synced job's dependency belongs to), each pinned to an **exact** count:
  - `agentService.ts` 7
  - `localAgentService.ts` 3
  - `jobService.ts` 4
  - `AgentsSettingsSection.tsx` 2
  - `AgentCard.tsx`, `CatalogSettingsSection.tsx`, `JobEditForm.tsx`, `JobDetail.tsx` — 1 each

  These files are not allowlisted, because a whole-file pass would hide the next behavioural branch added beside them. A count that moves in either direction fails until someone reads the branch and decides which kind it is; a behavioural one moves into a driver
- **`LIMITS`** (`:77`) — `source` 4, `engine` 5, `kind` 42, `jobType` 29, `providerType` 3, and `LIMIT` 83. **Each is asserted by equality, not as a ceiling**: a branch removed without lowering its limit would leave room for a new one to arrive unnoticed. Raising a limit needs a comment beside it naming what pays it back. The `source` branches that remain are how agent status refreshes (`agentStatusService`, `statusViews`, `useAgentStatus`, `useChatStream`), which no driver owns
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
- **A list never starts a process to answer readiness.** OpenCode readiness does not start the engine. Claude readiness spawns only `claude auth status`, through the shared probe, which runs no turn and bills nothing
- **A grant is built only from the engine's recorded ask.** The folder driver's `respond` builds it from the ask held in the pending registry, never from the renderer's payload. An answer for a row that has gone writes no rule

## Tests

- `src/main/agents/drivers/index.test.ts` — `driverFor` through the real wiring, with the module graph below it mocked. It replaced the resolver's dispatch test and keeps its scenarios:
  - an A2A row reaches the A2A driver without any folder being read
  - the same driver on every call
  - a folder that names no engine runs on OpenCode
  - a folder that names Claude runs on Claude **while its row still says OpenCode**
  - an unrecognised engine runs on the default runner
  - the row's driver is kept when the folder cannot be read
  - an unknown request is answered with nothing delivered, through the real registry
- `src/main/agents/drivers/capabilities.test.ts` — every assertion stands in for a `source` comparison that used to live elsewhere: the attach gate, the re-auth flag, the `/run:` interception, the catalog dispatch
- `src/main/agents/drivers/folderDriver.test.ts` —
  - reconcile, in both directions and back
  - the stored driver kept when the folder is unreadable or invalid
  - an unknown engine, and a driver with no sibling
  - folder readiness in the runners' own words, and never throwing
  - the Claude steps asked only after the folder is `ok`; OpenCode never asks them
  - `respond`: nothing waiting; *Always* stored first, then `once`; a refusing store still allowing, with `remembered: false`; no grant without a recorded ask; `once`, reject and answers passed through; both folder drivers answering alike
- `src/main/agents/drivers/claudeDriver.test.ts` —
  - `ok`
  - not installed, without asking the login probe
  - `not_logged_in` only on a definite logout; an `unknown` probe never refuses
  - the folder asked first
  - `fresh` reaching both probes
- `src/main/agents/drivers/a2aDriver.test.ts` —
  - `run`: the pre-flight handed through; a stream 401 treated as a re-auth only for a synced agent; a missing card refused before anything is resolved; no endpoint; a token failure; a stop during the pre-flight sending nothing; cancel sent once, and not before a task exists; `respond` never delivering
  - `readiness`: `ok`; a disabled row probed like any other; no card; an expired session as a state; a 401 for synced versus hand-added agents; unreachable, with `detail`; `null` when the card times out and when the token hangs; 4xx versus 5xx; an unusable card; never throwing, even synchronously
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
- `src/main/ipc/agent_a2a.answerRequest.test.ts` — *what reaches the driver*, including a gone row whose answer is still delivered with no rule; `src/main/ipc/agent_a2a.commandDispatch.test.ts` — `streamToAgent` receives `resolveCommandRunner`'s turn rather than the driver's own
- **Persistence:**
  - `src/main/db/agents.test.ts` — *the driver a row names*
  - `src/main/db/migrations/migrations.test.ts` — *adds the driver columns*, and *agents.driver on an install that predates it*: mapped by source, a no-op on replay, never rewriting a row that names a driver
  - `src/main/services/localAgents/scannerService.test.ts` — *the driver a folder row names*: the manifest's engine; the default engine, following an edit; no answer for an unreadable manifest; staying on Claude while the manifest is unparseable; a bare folder's desktop state
  - `src/main/services/localAgents/localAgentService.test.ts` — *the driver follows an engine chosen in the app*, and moving the row to the engine an edit on disk names
- **Golden:** `src/main/services/agentTurn/__golden__/driverContract.ts` — `describeDriverContract(name, makeSubject, options)` runs every turn through `driver.run`. Its three driver clauses are `capabilities.stable`, `readiness.never_throws` and `respond.unknown`, and its subjects are built with `__golden__/driverWorld.ts`. See [the driver contract](../local_agents/agent_turn_tech.md#the-driver-contract)
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
