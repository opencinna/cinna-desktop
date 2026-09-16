# Agents — Technical Details

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| A2A client wrapper | `src/main/agents/a2a-client.ts` |
| A2A stream parts accumulator | `src/main/agents/streamPartsAccumulator.ts` — per-part delta tracking, `cinna.content_kind` / `cinna.tool_name` metadata interpretation, structured `parts[]` build-up |
| Shared part types | `src/shared/messageParts.ts` — `ContentKind`, `MessagePart` (cross-process type contract) |
| Agent service | `src/main/services/agentService.ts` — CRUD, card preview, test, endpoint resolution, access-token resolution, remote sync |
| DB Repo (agents) | `src/main/db/agents.ts` — `agentRepo` (CRUD, `updateCardCache`, `updateResolvedEndpoint`, transactional `syncRemote`) |
| DB Repo (sessions) | `src/main/db/agents.ts` — `agentSessionRepo` (`getByChat`, `getByChatAndAgent`, `upsert`) |
| Errors | `src/main/errors.ts` — `AgentError` + `AgentErrorCode` (`not_found`, `unsupported_protocol`, `no_card_url`, `no_endpoint`, `remote_immutable`, `invalid_id`, `sync_reauth_required`, `sync_failed`) |
| IPC handlers (CRUD) | `src/main/ipc/agent.ipc.ts` — thin handlers delegating to `agentService` |
| IPC handlers (A2A protocol) | `src/main/ipc/agent_a2a.ipc.ts` — fetch-card, test, send-message (MessagePort), cancel-message, get-session. `send-message` is a thin controller — delegates persistence to `messageRoutingService` and the A2A pump to `a2aStreamingService` |
| A2A streaming service | `src/main/services/a2aStreamingService.ts` — A2A client init, stream pump, session save, cancel registry, in-flight marker and draft row |
| A2A turn collection | `src/main/agents/a2aTaskCollect.ts` — `collectTask()` polls `tasks/get` for a turn whose stream ended without `final`; `src/main/agents/a2aTransport.ts` — `isTransportDrop()`. See [Interrupted Turn Recovery](../turn_recovery/turn_recovery_tech.md) |
| Message routing service | `src/main/services/messageRoutingService.ts` — single chokepoint for user-message persistence + background title generation, used by runExecutionService for agent/model admission |
| IPC wrap | `src/main/ipc/_wrap.ts` — `ipcHandle()` used by all `agent:*` channels |
| IPC registration | `src/main/ipc/index.ts` — `registerAgentHandlers()` |
| DB schema (agents) | `src/main/db/schema.ts` — `agents` table |
| DB schema (sessions) | `src/main/db/schema.ts` — `a2aSessions` table |
| DB migration (agents) | `src/main/db/migrations/agents.ts` — `migrateAgents()` |
| DB migration (sessions) | `src/main/db/migrations/a2a-sessions.ts` — `migrateA2aSessions()` |
| Migration registration | `src/main/db/client.ts` — `runMigrations()` |
| Token encryption | `src/main/security/keystore.ts` — `encryptApiKey()`, `decryptApiKey()` |

### Preload

| Purpose | File |
|---------|------|
| Bridge API | `src/preload/index.ts` — `api.agents.*` namespace |
| Type definition | `src/preload/index.ts` — `AgentData` interface |

### Renderer

| Purpose | File |
|---------|------|
| React Query hooks | `src/renderer/src/hooks/useAgents.ts` |
| Settings section | `src/renderer/src/components/settings/AgentsSettingsSection.tsx` |
| Add agent form | `src/renderer/src/components/settings/A2AAgentForm.tsx` |
| Agent settings card | `src/renderer/src/components/settings/AgentCard.tsx` |
| Chat agent selector | `src/renderer/src/components/chat/ComposerPlusMenu.tsx` (the `[+]` menu) → `src/renderer/src/components/agents/AgentPickerModal.tsx` (the picker); the standalone `AgentSelector` dropdown was folded into these — see [Composer Menu](../../chat/composer_menu/composer_menu.md) |
| @-mention popup | `src/renderer/src/components/chat/AgentMentionPopup.tsx` |
| Chat input (mention detection) | `src/renderer/src/components/chat/ChatInput.tsx` — `findMentionToken()`, `@`-mention state, `forwardRef` with `ChatInputHandle` |
| Chat integration | `src/renderer/src/components/layout/ChatWorkspace.tsx` — shared dashboard/agent composer and new-chat creation; `src/renderer/src/components/layout/MainArea.tsx` routes views |
| Sidebar menu | `src/renderer/src/components/layout/Sidebar.tsx` — `'agents'` menu item |
| Settings routing | `src/renderer/src/components/settings/SettingsPage.tsx` — `AgentsSettingsSection` |
| UI store | `src/renderer/src/stores/ui.store.ts` — external-agent selection, chat/settings page mode, and settings routing |

- `src/renderer/src/components/agents/ExternalAgentPage.tsx` — chat/settings landing and Overview/Connection tabs.
- `src/renderer/src/components/agents/ExternalAgentActionsMenu.tsx` — visibility, delete and uninstall confirmations.
- `src/renderer/src/components/agents/AgentTypeIcon.tsx` — shared agent identity icon.

## Database Schema

**Table:** `agents` (migration: `src/main/db/migrations/agents.ts`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | nanoid-generated |
| `name` | TEXT NOT NULL | From agent card or user input |
| `description` | TEXT | From agent card |
| `protocol` | TEXT NOT NULL | `'a2a'` (discriminator for future protocols) |
| `card_url` | TEXT | Base URL or direct card URL |
| `endpoint_url` | TEXT | Resolved from agent card (may be top-level `url` or from `supportedInterfaces`) |
| `protocol_interface_url` | TEXT | Resolved 0.3.x-compatible endpoint URL from protocol negotiation |
| `protocol_interface_version` | TEXT | Matched protocol version string (e.g. `"0.3.0"`) |
| `access_token_enc` | BLOB | Encrypted via safeStorage |
| `card_data` | TEXT (JSON) | Full cached agent card object |
| `skills` | TEXT (JSON) | `Array<{ id, name, description? }>` |
| `enabled` | INTEGER (boolean) | Default: true |
| `created_at` | INTEGER (timestamp) | |

**Table:** `a2a_sessions` (migration: `src/main/db/migrations/a2a-sessions.ts`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | nanoid-generated |
| `chat_id` | TEXT NOT NULL | FK → `chats(id)` ON DELETE CASCADE |
| `agent_id` | TEXT NOT NULL | FK → `agents(id)` ON DELETE CASCADE |
| `context_id` | TEXT | Server-assigned context for conversation continuity |
| `task_id` | TEXT | Server-assigned task ID for the current/last task |
| `task_state` | TEXT | Last known task state (`working`, `completed`, `canceled`, etc.). Null after the early save from the stream's first task event, until the turn's end-of-turn save |
| `created_at` | INTEGER (timestamp) | |
| `updated_at` | INTEGER (timestamp) | |

The `chats` table also has an `agent_id` column (migration: `src/main/db/migrations/chats.ts`) for identifying agent chats at the chat level, while `a2a_sessions` stores the protocol-level session state.

## IPC Channels

| Channel | Type | Params | Returns |
|---------|------|--------|---------|
| `agent:list` | handle | — | `AgentData[]` (token masked as `hasAccessToken`) |
| `agent:upsert` | handle | `{ id?, name, description?, protocol, cardUrl?, endpointUrl?, protocolInterfaceUrl?, protocolInterfaceVersion?, accessToken?, cardData?, skills?, enabled? }` | `{ id, success }` |
| `agent:delete` | handle | `agentId: string` | `{ success }` |
| `agent:fetch-card` | handle | `{ cardUrl, accessToken? }` | `{ success, card?, protocol?: { url, version }, error? }` |
| `agent:test` | handle | `agentId: string` | `{ success, card?, error? }` — also updates DB cached metadata + protocol interface |
| run:start / run:watch | invoke / MessagePort | RunSendPayload / owned chat | Main-owned execution plus independent snapshot/live event observation. Lower-level run:send uses the same executor. |
| `agent:cancel-message` | handle | `requestId: string` | `{ success }` |
| `agent:get-session` | handle | `chatId: string` | `{ id, chatId, agentId, contextId, taskId, taskState } \| null` |
| `agent:check-readiness` | handle | `agentId: string` | `AgentReadiness \| null` — a fresh readiness check of one agent; `null` when it is not found. See [Agent Drivers](../drivers/drivers_tech.md#ipc-channels) |
| `agent:readiness-changed` | main → renderer | `{ agentId, readiness }` | Pushed when a refusal appears, goes away or changes; the renderer re-reads `agent:list` |

## Services & Key Methods

### A2A Client — `src/main/agents/a2a-client.ts`

- `fetchAgentCard(cardUrl, accessToken?)` — Fetches raw card JSON, runs protocol negotiation via `resolveProtocol()`, patches the card with a top-level `url` for SDK compatibility. Returns `{ card, protocol: { url, version } }`.
- `resolveProtocol(card)` — Protocol version negotiation logic. Checks for top-level `url` (v0.3 style), then scans `supportedInterfaces` for a `0.3.x` entry. Throws with a descriptive error if no compatible version found.
- `createA2AClient(endpointUrl, cardUrl, accessToken?, signal?)` — Fetches the raw card, patches `url` with the pre-resolved `endpointUrl`, then instantiates the legacy `A2AClient` from `@a2a-js/sdk` with the patched card object. The optional signal binds raw-card and SDK fetches; `tasks/cancel`, and a `tasks/get` sent once the signal has aborted (the one a Stop reads when the cancel answered no state), get an independent ten-second signal. This legacy client has no per-call signal options. See [A2A driver](../drivers/drivers_tech.md#the-a2a-driver).
- `buildSendParams(content, contextId?, taskId?, metadata?, messageId?)` — Constructs `MessageSendParams` with `role: 'user'` and a text part. The message ID is `messageId` (the stored user row's id, which the Cinna backend echoes as `cinna.client_message_id`) or a fresh nanoid.
- `humanizeA2AError(err)` — Maps undici/Node socket-layer failures (`TypeError: terminated`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `UND_ERR_SOCKET`, "socket hang up", "other side closed") to short user-readable messages. Falls back to `err.message`. Checks both `err.message`/`err.cause.message` via a lower-cased haystack and `err.cause.code`. Consumed by the `a2aStreamingService` catch block and by the SSE log-tee warn path.

### Stream Parts Accumulator — `src/main/agents/streamPartsAccumulator.ts`

- `StreamPartsAccumulator` — Stateful per-stream object. `ingestMessage(message, port)` and `ingestArtifact(artifact, port)` walk each `TextPart`, compute the delta vs the prior text seen for that `(messageId, partIndex)` key, classify the part via `cinna.content_kind` metadata (`text` / `thinking` / `tool` / `tool_result` / `notice` / `command_result`, unknown values fall back to `text`), post a `{ type: 'delta', kind, text, toolName? }` event to the port, and merge the delta into the running structured `parts[]` list (through `continuesPart` in `src/shared/partMerge.ts`, the rule the renderer's live blocks share: `text` / `thinking` / `command_result` merge on `kind`; `tool` on `kind` + `toolName`, never across two different `toolId`s; `tool_result` on `toolId` AND `toolStream` — see [A2A Streaming Pipeline](streaming_pipeline.md#renderer-routing)). `snapshotParts()` returns the structured list for persistence; `answerText()` returns the concat of `text` + `command_result` parts — used as the `messages.content` fallback so chat previews / titles / search work for slash-command turns too. `notice` parts bypass `parts[]` / `answerText()` entirely and accumulate into `snapshotNotices()` for separate `agent_transition` persistence.
- `partKindOf(part)` / `partToolNameOf(part)` — Read `metadata['cinna.content_kind']` and `metadata['cinna.tool_name']` respectively, with safe defaults.
- `KIND_METADATA_KEY`, `TOOL_NAME_METADATA_KEY` — Exported constants documenting the Cinna-backend contract (counterpart: `a2a_event_mapper.py`).

### Agent Service — `src/main/services/agentService.ts`

- `agentService.list(userId)` — Returns `AgentDto[]` (token masked as `hasAccessToken`).
- `agentService.upsert(userId, input)` — Rejects renderer-supplied IDs starting with `remote:` (sync owns those). For updates, requires existing owned row; throws `AgentError('not_found', ...)` otherwise. Encrypts access token via `encryptApiKey()` if provided.
- `agentService.delete(userId, agentId)` — Throws `AgentError('remote_immutable', ...)` for `source='remote'` rows.
- `agentService.fetchCardPreview({ cardUrl, accessToken? })` — User-id-less card fetch, used by the "add agent" form.
- `agentService.testAgent(userId, agentId)` — Resolves access token, fetches card with protocol negotiation, calls `agentRepo.updateCardCache()` to cache `cardData`, `skills`, `endpointUrl`, `protocolInterfaceUrl`, `protocolInterfaceVersion`.
- `resolveEndpointIfNeeded(userId, agent)` / `resolveAccessToken(userId, agent)` — **moved out of `agentService`** to `src/main/agents/drivers/a2aConnection.ts`, and decided by the row's capabilities (`auth`, `cwd`) rather than by `source`. The endpoint is the cached `protocolInterfaceUrl ?? endpointUrl`; a Cinna-synced agent with none fetches the card and caches it via `agentRepo.updateResolvedEndpoint()`, a hand-added one must be tested first. The token is `getCinnaAccessToken(userId)` for a synced agent and the decrypted stored token for a hand-added one. `testAgent` and `listCliCommands` still import them; the turn's pre-flight runs them inside the A2A driver — see [Agent Drivers — Technical Details](../drivers/drivers_tech.md#the-a2a-driver).
- Every `AgentDto` also carries `driver`, `capabilities` and `readiness` (the driver's last answer, `null` when not checked yet); `listMerged` starts background readiness checks without waiting for them. See [Agent Drivers & Readiness](../drivers/drivers.md).
- `agentService.syncRemoteAgents(userId)` — See [Remote Agents Tech](../remote_agents/remote_agents_tech.md).

### IPC Agent Handler — `src/main/ipc/agent.ipc.ts`

- `registerAgentHandlers()` — Registers CRUD + sync `agent:*` channels using `ipcHandle()`. All handlers `requireActivated()`; CRUD delegates to `agentService`, while `agent:delete-remote` delegates to `remoteAgentActions.deleteRemoteAgent` (see [Remote Agents](../remote_agents/remote_agents_tech.md)). `agent:upsert`, `agent:delete`, `agent:sync-remote` catch errors via `ipcErrorShape()` and return `{ success: false, error }` for inline display in the settings UI. Delegates to `registerA2AHandlers()`.

### IPC A2A Handler — `src/main/ipc/agent_a2a.ipc.ts`

- registerA2AHandlers retains agent discovery/test/session/answer/cancel and custom/Managed configuration handlers. Run dispatch belongs to src/main/ipc/run.ipc.ts and runExecutionService.
- The executor resolves routing, prepares the user message once, chooses driverFor and supplies a bound run to streamToAgent. Folder catalog commands are intercepted by capability before driver.run; endpoint/token resolution stays inside A2A.
- `agent:fetch-card` handler — Calls `agentService.fetchCardPreview()`, returns `{ success, card?, protocol?, error? }`.
- `agent:test` handler — Calls `agentService.testAgent()`, which updates cached card metadata in DB.
- `agent:get-session` handler — Verifies chat ownership via `chatRepo.getOwned()`, returns `agentSessionRepo.getByChat(chatId) ?? null`. Returns continuity metadata; routing is resolved by main from the chat and addressed agent.
- `agent:cancel-message` handler — Delegates to `a2aStreamingService.cancel(requestId)`.

### A2A Streaming Service — `src/main/services/a2aStreamingService.ts`

- `streamToAgent({ run, chatId, agentId, port, marker?, touchChat? })` — The direct-chat wrapper: opens the turn's in-flight marker when given one (every non-runner direct turn), keeps its draft row while it runs, registers the turn for cancellation and the quit flush, calls `run`, persists the result past the turn's persist cursor (`persistTurn`: notices, then assistant rows split around steers) and pumps the port. For an A2A agent, `run` is the A2A driver calling `runAgentTurn`, which owns the A2A turn itself: creates the A2A client, checks streaming capability on the card, loads the existing `a2a_sessions` row for the (chat, agent) pair and passes stored `contextId`/`taskId` to `buildSendParams()` for conversation continuity, with `RunInput.messageId` (the user row id) as the message's `messageId`. Constructs a `StreamPartsAccumulator` and forwards each event's message/artifacts to it (`ingestMessage`, `ingestArtifact`) — the accumulator handles delta computation, kind routing, and structured-parts build-up. Extracts `contextId`/`taskId`/`taskState` from all response event types (`status-update`, `artifact-update`, `task`, `message`). Upserts the session row from the first stream event carrying a task id (`taskState: null`), and again whenever the stream completes, a failed task state included; a throw skips only the second. A stream that ends without `final`, or drops after its first event, is collected from `tasks/get` on a backend that supports it; see [A stream that ends without saying so](streaming_pipeline.md#a-stream-that-ends-without-saying-so). Stop preserves partial output and leaves the prior checkpoint unchanged; see [Cancellation and session checkpoints](streaming_pipeline.md#cancellation-and-session-checkpoints). On stream completion it persists nothing itself: it returns `text = accumulator.answerText()`, `parts = accumulator.snapshotParts()` and the notices, and the wrapper saves them (`messageRepo.saveAssistant({ sourceAgentId: agentId })`). Same accumulator pattern is used for the non-streaming branch (single response). A throw inside `runAgentTurn` is caught there and returned, never rethrown: the message goes through `humanizeA2AError()` (or becomes the session-expired sentence with the re-auth code for a rejected cinna token) and comes back as `result.error` with the raw `String(err)` as `raw`, beside whatever the accumulator already held (stopped or not); the wrapper saves those parts above the error row, posts the error, saves it as `short` with `raw` as `detail`, and the job run records it. Uses `AbortController` tracked by an internal `activeRequests` map, each entry also holding the turn's `flush`. The wrapper's own `catch` is only for a runner that breaks its never-throws contract: it flushes the turn's registered snapshot first, then (non-aborted) posts the error's own `message` unchanged — no humanizing — stores it as `short` on the saved error message, and stores the raw `String(err)` as `detail`.
- `streamToAgent` also accepts `onFinished`, a once-only typed completion callback after persistence and before close. The executor supplies it to separate a turn ending from whole-task/job completion; standalone callers retain job reporting. A2A failed/rejected/unfinished task endings and nonstream JSON-RPC errors are failures, not empty successes. See [turn outcomes](../../chat/messaging/turn_completion.md).
- `saveInFlight()` — Called first in `will-quit`. Synchronously persists what every active request's registered snapshot holds past its cursor, replacing its draft row, without moving the chat in the list; records no outcome, leaves the in-flight marker for the next launch, never throws. See [What a direct turn keeps when it never returns](streaming_pipeline.md#what-a-direct-turn-keeps-when-it-never-returns).
- `cancel(requestId)` — Aborts the turn's `AbortController`, and nothing more; the `activeRequests` entry stays until the turn returns, so the quit flush still finds a turn that is unwinding. The A2A driver's listener and late client/task callbacks send `cancelTask` at most once once both identities exist. Its independent deadline allows the request after turn abort; local completion never waits for remote acknowledgement.

## Renderer Components

- `AgentsSettingsSection` — Profile-only visibility list for `source === 'remote'`; direct connection creation is in the sidebar chooser.
- `A2AAgentForm` — Portalled dialog opened by `NewLocalAgentModal` through `LocalAgentsList`. Escape/close and inputs are disabled while saving; rejected IPC and returned `{success:false}` keep the form open with an error. Card URL + access token inputs, test connection shows card preview: name, description, agent version, resolved protocol version + transport (e.g. "A2A v0.3.0 · JSONRPC"), all supported versions, endpoint URL, streaming badge, skills. Passes `protocolInterfaceUrl` and `protocolInterfaceVersion` on save.
- `ExternalAgentPage` — Shared non-folder page; keeps `ChatWorkspace` mounted behind `hidden` in Settings mode, keyed by profile/agent to preserve mode-switch drafts without sharing them between agents. Overview owns description/readiness/skills. ACP/Managed Connection opens the corresponding edit modal; A2A uses `AgentCard(connectionOnly)`. The server host opens via `system.openExternal`.
- `ExternalAgentActionsMenu` — Header lifecycle actions and guarded confirmation dialogs; see [Remote Agents](../remote_agents/remote_agents_tech.md).
- `AgentCard` — Its routed use passes `connectionOnly`, hiding the legacy expandable header, status dot, toggle, delete button and duplicated skills. Visible sections are Connection details, Authentication and Connection test; bundle update banner remains above them. Transport matches `protocolInterfaceUrl` against `cardData.supportedInterfaces`. **Readiness:**
  - The reason renders beside Test Connection (`readinessText`, `title={readinessTitle}`) — `AlertTriangle` for a warning state, `XCircle` for a danger one — while `readinessIssue && !testAgent.data?.success`. A failed test never replaces it and a passing test shows *Connected*; a failed test's error (with itself as its `title`) renders only when there is no refusal
  - `handleTest` also calls `useCheckAgentReadiness().mutate(agent.id)`

  See [Agent Drivers — Technical Details](../drivers/drivers_tech.md#readiness-and-renderer-behavior).
- `ComposerPlusMenu` / `AgentPickerModal` — The composer capability picker replaces the standalone AgentSelector. Agent picks join the ordered pending capability set; the first selected agent supplies example prompts and direct-agent presentation.
- `AgentMentionPopup` — Popup rendered above the text input when user types `@`. Shows filtered enabled agents with name, protocol tag, and description. Supports keyboard navigation (Arrow keys, Enter/Tab to select, Escape to dismiss) and outside-click dismissal.
- `ChatInput` — Exposes `ChatInputHandle` via `forwardRef`/`useImperativeHandle` with a `focus()` method. Contains `@`-mention detection: `findMentionToken()` walks backwards from cursor to find `@` preceded by whitespace or at start of input; extracts filter text. Manages mention popup state (open, filter, selected index). On agent selection, removes the mention token and updates pending agents for a new chat or uses `useAttachAgentToChat` for an existing one. For active agent chats, resolves the bound agent via `useChatDetail(chatId).agentId` + `useAgents()` lookup, and renders a read-only agent badge (Bot icon + name) with separate capability and routing controls.
- `ChatWorkspace` — Owns pending agent/MCP IDs, chat-mode intent and composer reference. Embedded agent pages force a new-chat context and seed `pendingAgentIds` from their agent ID. `useNewChatFlow.startNewChat` owns creation; the shared `newChatRouter` predicts the same routing shown by the composer badge. Page mode switching keeps this component mounted; sending changes to the created conversation.
- **Routing a subsequent message is not the renderer's job.** `useSendMessage`, which looked up an A2A session and picked the agent channel over the LLM one, is gone: every send goes out on `run:send`, and main reads `chats.router` to decide who answers. The session lookup was one of five copies of that decision. See [Chat Routing](../../chat/chat_routing/chat_routing.md).

## Dependencies

- **`@a2a-js/sdk`** (v0.3.13) — Official A2A protocol SDK, speaks protocol v0.3. Used for JSON-RPC transport and SSE streaming. Only the client sub-package is used (`@a2a-js/sdk/client`). Note: agent card fetching is done manually (not via `A2AClient.fromCardUrl()`) to support protocol version negotiation with v1.0 servers.

## Security

- **Access tokens** encrypted at rest using `safeStorage` (same mechanism as LLM API keys)
- **Renderer isolation** — Token never sent to renderer; only `hasAccessToken: boolean` exposed
- **Auth injection** — Custom `fetchImpl` wraps standard `fetch` with `Authorization: Bearer` header, passed to A2A SDK client
