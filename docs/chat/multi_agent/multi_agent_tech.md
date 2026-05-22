# Multi-Agent Chats — Technical Details

> **Status:** implemented. File paths and method names reflect the shipped code.

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| Schema (new columns + new table) | `src/main/db/schema.ts` |
| Message migrations (new columns) | `src/main/db/migrations/messages.ts` |
| Chat migrations (new columns) | `src/main/db/migrations/chats.ts` |
| `chat_agent_sessions` migration | `src/main/db/migrations/chat-agent-sessions.ts` |
| Migration registration | `src/main/db/client.ts` |
| Message repo (`saveUser` accepts multi-agent fields, `saveAssistant` accepts `sourceAgentId`) | `src/main/db/messages.ts` |
| Chat repo — split `updateMeta` (free-form via `chat:update`) vs `updateRouting` (privileged, multi-agent only) | `src/main/db/chats.ts` |
| Chat-agent sessions repo (atomic `INSERT … ON CONFLICT … DO UPDATE`) | `src/main/db/chatAgentSessions.ts` |
| Multi-agent service (rewrite, catch-up build, cursor advance, active-agent / smart-assist toggles) | `src/main/services/multiAgentService.ts` |
| **Message routing service** — single chokepoint for the user-message persistence + wire-content assembly + catch-up cursor advance | `src/main/services/messageRoutingService.ts` |
| **A2A streaming service** — extracted A2A client init + stream pump + session save + cancel registry | `src/main/services/a2aStreamingService.ts` |
| AI-functions service (shared one-shot LLM primitive) | `src/main/services/aiFunctionsService.ts` |
| Chat streaming service — receives pre-assembled `wireContent`, drives only the LLM tool-call loop (no longer persists the user message) | `src/main/services/chatStreamingService.ts` |
| Multi-agent IPC | `src/main/ipc/multi_agent.ipc.ts` |
| Agent IPC (`agent:send-message`) — thin controller: ownership/endpoint resolution then `messageRoutingService.prepareAgentSend` → `a2aStreamingService.streamToAgent` | `src/main/ipc/agent_a2a.ipc.ts` |
| LLM IPC (`llm:send-message`) — thin controller: `messageRoutingService.prepareLlmSend` → `chatStreamingService.stream` | `src/main/ipc/llm.ipc.ts` |
| Chat update IPC — accepts `ChatMetaUpdate` only; routing fields are a compile-time error here | `src/main/ipc/chat.ipc.ts` |
| IPC registration | `src/main/ipc/index.ts` |

### Shared (cross-process types)

| Purpose | File |
|---------|------|
| Streaming-channel payload types (`AgentSendPayload`, `LlmSendPayload`) — named-object payloads replacing the legacy positional tuples | `src/shared/ipcPayloads.ts` |

### Preload

| Purpose | File |
|---------|------|
| `api.multiAgent.*` namespace, `agents.sendMessage` / `llm.sendMessage` construct typed `AgentSendPayload` / `LlmSendPayload` objects; `ChatData` / `MessageData` carry the multi-agent fields | `src/preload/index.ts` |

### Renderer

| Purpose | File |
|---------|------|
| Composer hook — routing decisions, switching, rewrite trigger, dispatch | `src/renderer/src/hooks/useChatComposer.ts` |
| Rewrite UX state-machine hook — `idle` → `rewriting` → `confirming` → `idle`, textarea side-effects, Esc-to-revert, clear-to-abandon | `src/renderer/src/hooks/useRewriteUX.ts` |
| Multi-agent React Query mutations (rewrite, set-active-agent, build-catchup, disable-smart-assist) | `src/renderer/src/hooks/useMultiAgent.ts` |
| Chat-stream hook (extended `startLlm` / `startAgent` opts) | `src/renderer/src/hooks/useChatStream.ts` |
| Chat input — layout shell: textarea + autosize, the three `@` / `#` / `/` trigger popups, the `~` tilde popup, send/cancel buttons | `src/renderer/src/components/chat/ChatInput.tsx` |
| Rewrite hint bar — "Rewriting…" / "Rewritten. Press Enter…" single-line status | `src/renderer/src/components/chat/RewriteHintBar.tsx` |
| Rewrite failure modal — portaled dialog with per-error-code copy, technical details, Cancel / Disable / Send-anyway | `src/renderer/src/components/chat/RewriteFailureModal.tsx` |
| Active-agent chip + inline switch-back button | `src/renderer/src/components/chat/ActiveAgentChip.tsx` |
| Message bubble (agent label + color) | `src/renderer/src/components/chat/MessageBubble.tsx` |
| Message stream (renders `agent_transition` rows via `NoticeBlock` — collapsed info-tone dot in compact mode, expanded `Info`+text row in verbose mode; threads `agentName` / `agentId` into bubbles) | `src/renderer/src/components/chat/MessageStream.tsx` |
| Main area (just passes `chatId` to `ChatInput`) | `src/renderer/src/components/layout/MainArea.tsx` |
| Agent color helper (hash → palette preset) | `src/renderer/src/utils/agentColors.ts` |
| Shared `@<slug>` parser (slug or id match) used by the composer | `src/renderer/src/utils/agentSlug.ts` |

### Files referenced in earlier design that were removed before ship

| File | Why removed |
|------|-------------|
| `AgentParticipationStrip.tsx` | The participation strip was scrapped — the chip + switch-back button in ChatInput is the single source of truth for routing state. <!-- nocheck --> |
| `AgentTransitionMessage.tsx` | Transition system messages in the transcript were dropped for the same reason — the banner above the input shows the current state without crowding the conversation. <!-- nocheck --> |
| `useChatParticipants` (hook) | Derived the participant list from `messages.addressedAgentId` + chat root, but no UI surface consumed it. Removed as dead code; reintroduce when an actual participant strip / hover lands. <!-- nocheck --> |

## Database Schema

### Additions to `messages`

| Column | Type | Notes |
|--------|------|-------|
| `addressed_agent_id` | TEXT (nullable) | The agent this user message was routed to. Always populated on the agent path; the LLM path no longer writes it (the field was accepted-but-never-set, removed end-to-end) |
| `rewritten_text` | TEXT (nullable) | The text actually sent after Smart Rewrite. Null when no rewrite happened |
| `original_text` | TEXT (nullable) | The user's literal input when rewrite happened. Null when no rewrite |
| `source_agent_id` | TEXT (nullable) | The agent that produced an assistant turn. Null for LLM-root turns |

Migration: `src/main/db/migrations/messages.ts`.

> `role: 'agent_transition'` is written by the A2A streaming service for `cinna.content_kind: 'notice'` TextParts (see [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md)). These rows render as muted system messages in the transcript and are excluded from catch-up replay + LLM history rebuilds.

### Additions to `chats`

| Column | Type | Notes |
|--------|------|-------|
| `active_agent_id` | TEXT (nullable) | The currently active routing target. Null = root. Distinct from `agent_id`, which is the chat's bound root for agent chats |
| `smart_assist_disabled` | INTEGER (boolean, NOT NULL DEFAULT 0) | If true, skip the rewrite step. Routing and catch-up still run |

Migration: `src/main/db/migrations/chats.ts`. The `chat:update` IPC accepts `ChatMetaUpdate` only — `activeAgentId` / `smartAssistDisabled` are a compile-time error here. They are writable exclusively through `multiAgentService.setActiveAgent` / `disableSmartAssist`, which route through `chatRepo.updateRouting` so the audit invariants (logging, future system messages) stay consistent.

### New table: `chat_agent_sessions`

| Column | Type | Notes |
|--------|------|-------|
| `chat_id` | TEXT NOT NULL | FK → `chats(id)` ON DELETE CASCADE |
| `agent_id` | TEXT NOT NULL | FK → `agents(id)` ON DELETE CASCADE |
| `last_replayed_message_id` | TEXT NOT NULL | The last user-message id routed to this agent. Next catch-up packet starts after this row |
| `created_at` | INTEGER (timestamp) | |
| `updated_at` | INTEGER (timestamp) | |
| PK | (chat_id, agent_id) | composite |

Migration: `src/main/db/migrations/chat-agent-sessions.ts`. `chatAgentSessionRepo.upsertCursor` uses an atomic `INSERT … ON CONFLICT(chat_id, agent_id) DO UPDATE` so two parallel sends to the same (chat, agent) cannot race the previous read-then-write path.

> **A2A session reuse:** the existing `a2a_sessions` table already keys on (chat_id, agent_id) and stores the A2A `contextId` / `taskId`. `chat_agent_sessions` only tracks Cinna's own catch-up cursor, not the A2A protocol session. See [Agents — Tech](../../agents/agents/agents_tech.md) for `a2aSessionRepo`.

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `multiAgent:rewrite` | invoke | Run the Smart Rewrite LLM call. Params: `{ chatId, targetAgentId, userText }`. Returns `{ rewrittenText: string \| null }` — `null` means the LLM emitted the keep-original sentinel and the composer should send the original text without confirmation. Throws `MultiAgentError` on failure |
| `multiAgent:set-active-agent` | invoke | Set `chats.active_agent_id`. Returns `{ changed }`. No transcript row is inserted |
| `multiAgent:disable-smart-assist` | invoke | Set `chats.smart_assist_disabled = true` |
| `multiAgent:build-catchup` | invoke | Build the catch-up replay packet for the (chat, agent) pair. Returns `{ packet }` (empty string when the agent has no cursor) |

Streaming channels now use **named-object payloads** (`src/shared/ipcPayloads.ts`) instead of the previous positional-tuple style:

- `agent:send-message` — `AgentSendPayload = { agentId, chatId, content, catchupPacket?, rewrittenText?, originalText? }`. Handler delegates to `messageRoutingService.prepareAgentSend` (persists the user message with all multi-agent metadata, assembles wire content, advances the catch-up cursor) and then `a2aStreamingService.streamToAgent` (A2A client + pump). Assistant turns are saved with `sourceAgentId = agentId` by the streaming service.
- `llm:send-message` — `LlmSendPayload = { chatId, content, catchupPacket? }`. Handler delegates to `messageRoutingService.prepareLlmSend` (persists the user message + assembles wire content) and then `chatStreamingService.stream` (driver of the tool-call loop only — no longer touches `messageRepo.saveUser`).

## Services & Key Methods

### Multi-agent service — `src/main/services/multiAgentService.ts`

- `rewriteMessage({ userId, chatId, targetAgentId, userText })` — Verifies chat ownership, looks up the target agent, resolves an adapter via `aiFunctions.resolveAdapterFromChatMode`, composes the Smart Rewrite system prompt (target agent's name + description + the last N user/assistant lines of history + the keep-original sentinel contract), calls `aiFunctions.runSingleShot`. Returns `Promise<string | null>`: the trimmed rewrite, or `null` when the LLM output equals `KEEP_ORIGINAL_SENTINEL` after surrounding-quote/backtick stripping (signals "no rewrite needed — dispatch the original"). Logs `rewrite skipped: message already self-contained` on the sentinel path. Maps `AiFunctionError` codes to `MultiAgentError` codes (`no_provider` → `no_rewrite_provider`, `empty_output` → `rewrite_empty`, `llm_failed` → `rewrite_failed`).
- `buildCatchupPacket({ userId, chatId, targetAgentId })` — Verifies chat ownership. Reads the cursor from `chat_agent_sessions`. **Returns an empty string when no cursor exists** (the agent's first engagement — rewrite carries the context). Otherwise slices messages from after the cursor, filters to user/assistant rows AND drops messages with `sourceAgentId === targetAgentId` (the target agent's own prior outputs — the cursor only advances on user-message-send, so the agent's reply that followed sits in the slice; replaying it would feed the agent its own words back), caps by `CATCHUP_WINDOW_TURNS` (20), formats as a literal transcript. Logs the build under scope `multi-agent` with `cursor`, `turnCount`, `packetChars`. Note: the composer skips calling this entirely when the user message is a CLI command (see *CLI command bypass* in `useChatComposer.dispatchToAgent`).
- `advanceCatchupCursor({ userId, chatId, targetAgentId, lastMessageId })` — Verifies chat ownership, upserts the cursor. Called by `messageRoutingService.prepareAgentSend` immediately after persisting the user message.
- `setActiveAgent({ userId, chatId, agentId })` — Verifies chat ownership, calls `chatRepo.updateRouting({ activeAgentId })`. Returns `{ changed }`. No transcript row is inserted.
- `disableSmartAssist({ userId, chatId })` — Verifies chat ownership, calls `chatRepo.updateRouting({ smartAssistDisabled: true })`.

### Message routing service — `src/main/services/messageRoutingService.ts`

Single chokepoint for "the user just sent a routed message." Both streaming IPC handlers go through here so side-effects stay consistent regardless of channel.

- `prepareAgentSend({ userId, chatId, agentId, userContent, rewrittenText?, originalText?, catchupPacket? })` — Verifies chat ownership, assembles `wireContent = catchupPacket + userContent`, persists the user message via `messageRepo.saveUser` (with `addressedAgentId = agentId`, `rewrittenText`, `originalText`), advances the catch-up cursor for the (chat, agent) pair via `multiAgentService.advanceCatchupCursor`. Returns `{ wireContent, userMessageId }`.
- `prepareLlmSend({ userId, chatId, userContent, catchupPacket? })` — Verifies chat ownership, assembles wire content, persists a plain user message (no `addressedAgentId` — that field is no longer used on the LLM path). Returns `{ wireContent, userMessageId }`.

### A2A streaming service — `src/main/services/a2aStreamingService.ts`

- `streamToAgent({ chatId, agentId, agentName, endpointUrl, cardUrl, accessToken, wireContent, port })` — Owns the entire A2A turn: client init, capability check, session-id resolution from `a2aSessionRepo`, streaming or non-streaming RPC, `StreamPartsAccumulator`-driven part ingestion, assistant message persistence (with `sourceAgentId = agentId`), session save, port event fan-out, error handling (logged + persisted as `role: 'error'` + posted to port). Holds the `activeRequests` map for cancellation.
- `cancel(requestId)` — Aborts the local `AbortController` for the request and fires `cancelTask` at the agent in the background.

### AI-functions service — `src/main/services/aiFunctionsService.ts`

Shared one-shot LLM primitive — used by Smart Rewrite today and is the planned substrate for chat-title generation, chat summaries, and other "utility" LLM calls.

- `aiFunctions.runSingleShot({ adapter, modelId, systemPrompt, userText, label?, maxOutputChars?, signal? })` — Non-streaming, no-tools LLM call. Logs `single-shot complete` / `single-shot failed` with `label` so call sites are distinguishable in the logger overlay. Throws `AiFunctionError`.
- `aiFunctions.resolveAdapterFromChatMode(userId, chatId)` — Picks an `{ adapter, modelId }`. Tries, in order: chat's own chat mode → user's default chat mode → chat's bound provider/model (LLM chats only). Chat modes and providers are read under the settings scope (`getSettingsScopeUserId()`), not the active profile.
- `aiFunctions.resolveAdapterFromDefaultMode(userId)` — Default chat mode only. For features that run before a chat exists.
- `AiFunctionError` codes: `no_provider`, `llm_failed`, `empty_output`.

See [AI Functions](../../llm/ai_functions/ai_functions.md) for the general-purpose surface and how new features should compose it.

### Chat-agent sessions repo — `src/main/db/chatAgentSessions.ts`

- `chatAgentSessionRepo.getCursor(chatId, agentId)` — Returns `last_replayed_message_id` or `null`.
- `chatAgentSessionRepo.upsertCursor(chatId, agentId, lastMessageId)` — Single atomic `INSERT … ON CONFLICT … DO UPDATE`; safe for parallel sends.

### Chat streaming service — `src/main/services/chatStreamingService.ts`

- `stream({ userId, chatId, wireContent, port })` — The user message is already persisted by `messageRoutingService.prepareLlmSend` before this call. The service rebuilds the LLM history from `messages` (filtering `error` and `agent_transition` rows — the latter are agent-side system notices and must never reach the LLM), patches the most recent user turn with `wireContent` so the catch-up packet is in scope only for the current call (never persisted), then runs the tool-call loop.

### Chat repo — `src/main/db/chats.ts`

Two separate update entry points so the type system enforces the IPC whitelist:

- `chatRepo.updateMeta(userId, chatId, ChatMetaUpdate)` — `title`, `modelId`, `providerId`, `modeId`, `agentId`. Called from `chatService.update` via `chat:update`.
- `chatRepo.updateRouting(userId, chatId, ChatRoutingUpdate)` — `activeAgentId`, `smartAssistDisabled`. Called only from `multiAgentService` — the `chat:update` IPC cannot reach it.

## Renderer

### Composer hook — `src/renderer/src/hooks/useChatComposer.ts`

The single seam between the chat input and the routing/dispatch logic. Lives in a hook so it can be tested in isolation and so the same code path serves any future composer surface (e.g., a quick-action bar).

- `useChatComposer(chatId)` returns:
  - `activeAgent`, `rootAgent`, `rootLabel` — reactive view state for the chip and switch-back button. Subscribes to `useChatDetail` + `useAgents` so it re-renders on cache changes.
  - `switchActiveAgent(agentId | null)` — fires `multiAgent:set-active-agent` (with optimistic cache update — see `useSetActiveAgent` in `useMultiAgent.ts`).
  - `submit(input)` — the single entry point for sending. Reads a *fresh* snapshot from the React Query cache at call time via `queryClient.getQueryData`, so popup-select → quick-Enter routes correctly even before the optimistic update notifies subscribers. Parses optional leading `@<slug>` via the shared `findAgentMention` (in `utils/agentSlug.ts`), resolves target, decides root-vs-agent channel, decides rewrite trigger, dispatches. When the rewrite mutation returns `rewrittenText: null` (keep-original sentinel), dispatches the original text via `dispatchToAgent` and returns `{ kind: 'sent' }` — bypasses the confirmation UI entirely. Returns `{ kind: 'sent' }`, `{ kind: 'rewrite-pending', rewrittenText, pending }`, `{ kind: 'rewrite-failed', code, detail, pending }`, or `{ kind: 'noop' }`.
  - **CLI command bypass.** `submit` detects `/run:<slug>` invocations via `isCliCommand` (`src/shared/cliCommands.ts`) and forces `needsRewrite = false`. `dispatchToAgent` performs the same check and skips the `multiAgent:build-catchup` IPC call so the literal invocation reaches the agent unmodified — both transformations would otherwise break the cinna-backend's `/run:*` detection (rewrite mangles the syntax; catch-up shifts the invocation off the start of the wire content). The (chat, agent) cursor still advances inside `messageRoutingService.prepareAgentSend` so the next non-CLI engagement sees the correct catch-up window.
  - `confirmRewrite(text, pending)` — second-Enter confirm: dispatches the (possibly edited) rewritten text to the target agent.
  - `sendRaw(pending)` — "Send anyway" in the failure modal: dispatches the original text without rewrite metadata.
  - `disableSmartAssist()` — flips the per-chat flag.

### Rewrite UX hook — `src/renderer/src/hooks/useRewriteUX.ts`

Owns the Smart Rewrite UX state machine + textarea side-effects so `ChatInput.tsx` doesn't have to. Layered on top of `useChatComposer` — composer does routing/network, this hook does typing-and-confirm UX.

- `useRewriteUX({ textareaRef, setInput, clearComposer })` returns:
  - `state: 'idle' | 'rewriting' | 'confirming'`, `pending`, `error` — what `RewriteHintBar` / `RewriteFailureModal` render from.
  - `handleSubmitResult(result)` — drive the state machine forward from a `composer.submit()` result (clear on `sent`, swap text + focus on `rewrite-pending`, set modal on `rewrite-failed`).
  - `beginConfirmDispatch()` — second-Enter while confirming; returns `{ text, pending }` for the composer's `confirmRewrite`.
  - `handleEscape()` — Esc-to-revert while confirming. Returns `true` when handled.
  - `handleComposerCleared(value)` — clearing the composer mid-confirm abandons the pending rewrite.
  - `dismissError()` / `consumePendingForSendAnyway()` — failure-modal action helpers.
  - `beginRewriting()` / `reset()` — manual transitions used by ChatInput's send handler.

### React Query hooks — `src/renderer/src/hooks/useMultiAgent.ts`

- `useRewriteMessage()` — wraps `multiAgent:rewrite`.
- `useSetActiveAgent()` — wraps `multiAgent:set-active-agent` with an **optimistic update** that patches `activeAgentId` in the cached chat in `onMutate` so the chip and `composer.submit` see the new value immediately. Reconciles in `onSettled`.
- `useDisableSmartAssist()` — wraps `multiAgent:disable-smart-assist`; invalidates the chat query on success.
- `useBuildCatchup()` — wraps `multiAgent:build-catchup`.

### Renderer components

- `ChatInput` (`src/renderer/src/components/chat/ChatInput.tsx`) — Layout shell: textarea + autosize, the `@` / `#` / `/` popups, the `~` tilde popup, send/cancel buttons, and the active-agent chip slot. Owns no rewrite state itself — delegates to `useRewriteUX` and renders `RewriteHintBar` + `RewriteFailureModal` + `ActiveAgentChip`.
- `RewriteHintBar` (`src/renderer/src/components/chat/RewriteHintBar.tsx`) — Single-line status above the textarea. Pure props in.
- `RewriteFailureModal` (`src/renderer/src/components/chat/RewriteFailureModal.tsx`) — Portaled dialog: friendly copy, per-error-code line, technical-details disclosure, Cancel / Disable Smart Rewrite / Send anyway. Pure props in.
- `ActiveAgentChip` (`src/renderer/src/components/chat/ActiveAgentChip.tsx`) — Chip + inline "Switch back to `<root>`" button. Pure props in.
- `MessageBubble` — Assistant bubbles surface the agent's name + color label above the content when `sourceAgentId` is set and differs from the chat's root agent. Color from `presetForAgentId(agentId)` (hashed agent id → `COLOR_PRESETS` palette).
- `MessageStream` — Renders `agent_transition` rows via `NoticeBlock` (collapsed info-tone dot in compact mode, expanded `Info`+text row in verbose mode — see [Agent Notices](../agent_notices/agent_notices.md)); threads `agentName` / `agentId` into bubbles for each assistant message.
- `MainArea` — Does not own any multi-agent state. Just passes `chatId` to `ChatInput`.

### Shared utilities — `src/renderer/src/utils/agentSlug.ts`

- `slugForAgent(name)` — Lower-kebab the agent name. Canonical slug used by `@<slug>` mentions.
- `findAgentMention(text, agents)` — Parse a leading `@<slug>` and resolve the agent by slug or by id (case-insensitive). Returns the agent plus the remainder of the text, or `null`. The composer uses this for the optional power-user typed-prefix override.

## Configuration

- **Catch-up sliding window** — `CATCHUP_WINDOW_TURNS = 20` in `multiAgentService.ts`. Not user-settable.
- **Smart Rewrite max output** — `REWRITE_MAX_OUTPUT_CHARS = 4000` in `multiAgentService.ts`. Truncates the rewrite output to keep it composer-friendly.
- **Keep-original sentinel** — `KEEP_ORIGINAL_SENTINEL = '__KEEP_ORIGINAL__'` in `multiAgentService.ts`. The exact token the rewrite system prompt instructs the LLM to emit when the user's message is already self-contained. Detection trims and strips surrounding quotes/backticks before equality check, so a "polite" LLM that wraps the sentinel is still recognized.
- **Smart-assist disable** — Per-chat boolean. No global toggle. One-way for the first ship.

## Security

- The rewrite step uses the chat's chat-mode credentials (or the user's default chat mode), resolved through `aiFunctions.resolveAdapterFromChatMode`. No new credential handling — reuses the existing LLM adapter chain via the factory. Chat modes and LLM providers always look up under the **settings scope** (`getSettingsScopeUserId()`), regardless of which profile is calling — same convention as `chatmode.ipc.ts` / `provider.ipc.ts`.
- Catch-up replay packets concatenate prior turns from other agents and send them to the receiving agent. The feature is scoped to closed/private agent environments where the user controls all participating agents. Cross-tenant or public-agent scenarios are out of scope until a per-agent context-filter is added.
- `rewritten_text` and `original_text` are stored in plaintext alongside the existing `content` column — no new encryption surface.
- Ownership: every `multiAgentService` and `messageRoutingService` method that reads or writes chat data verifies `chatRepo.getOwned(userId, chatId)` first. Defense-in-depth even though the IPC layer already runs the auth gate.
- The split `chatRepo.updateMeta` / `updateRouting` API is the type-system enforcement for routing-field writes — `chat:update` cannot reach `updateRouting`, so renderer code cannot bypass `multiAgentService` to flip `activeAgentId` / `smartAssistDisabled`.
