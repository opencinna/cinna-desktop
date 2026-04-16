# Agents — Technical Details

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| A2A client wrapper | `src/main/agents/a2a-client.ts` |
| IPC handlers (CRUD) | `src/main/ipc/agent.ipc.ts` |
| IPC handlers (A2A protocol) | `src/main/ipc/agent_a2a.ipc.ts` |
| IPC registration | `src/main/ipc/index.ts` — `registerAgentHandlers()` |
| DB schema | `src/main/db/schema.ts` — `agents` table |
| DB migration | `src/main/db/migrations/agents.ts` — `migrateAgents()` |
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
| Chat agent selector | `src/renderer/src/components/chat/AgentSelector.tsx` |
| @-mention popup | `src/renderer/src/components/chat/AgentMentionPopup.tsx` |
| Chat input (mention detection) | `src/renderer/src/components/chat/ChatInput.tsx` — `findMentionToken()`, `@`-mention state, `forwardRef` with `ChatInputHandle` |
| Chat integration | `src/renderer/src/components/layout/MainArea.tsx` — `selectedAgent` state, `chatInputRef`, agent message flow |
| Sidebar menu | `src/renderer/src/components/layout/Sidebar.tsx` — `'agents'` menu item |
| Settings routing | `src/renderer/src/components/settings/SettingsPage.tsx` — `AgentsSettingsSection` |
| UI store | `src/renderer/src/stores/ui.store.ts` — `SettingsMenu` type includes `'agents'` |

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

## IPC Channels

| Channel | Type | Params | Returns |
|---------|------|--------|---------|
| `agent:list` | handle | — | `AgentData[]` (token masked as `hasAccessToken`) |
| `agent:upsert` | handle | `{ id?, name, description?, protocol, cardUrl?, endpointUrl?, protocolInterfaceUrl?, protocolInterfaceVersion?, accessToken?, cardData?, skills?, enabled? }` | `{ id, success }` |
| `agent:delete` | handle | `agentId: string` | `{ success }` |
| `agent:fetch-card` | handle | `{ cardUrl, accessToken? }` | `{ success, card?, protocol?: { url, version }, error? }` |
| `agent:test` | handle | `agentId: string` | `{ success, card?, error? }` — also updates DB cached metadata + protocol interface |
| `agent:send-message` | on (MessagePort) | `[agentId, chatId, content]` | Events via port: `request-id`, `delta`, `status`, `done`, `error` |
| `agent:cancel-message` | handle | `requestId: string` | `{ success }` |

## Services & Key Methods

### A2A Client — `src/main/agents/a2a-client.ts`

- `fetchAgentCard(cardUrl, accessToken?)` — Fetches raw card JSON, runs protocol negotiation via `resolveProtocol()`, patches the card with a top-level `url` for SDK compatibility. Returns `{ card, protocol: { url, version } }`.
- `resolveProtocol(card)` — Protocol version negotiation logic. Checks for top-level `url` (v0.3 style), then scans `supportedInterfaces` for a `0.3.x` entry. Throws with a descriptive error if no compatible version found.
- `createA2AClient(endpointUrl, cardUrl, accessToken?)` — Fetches the raw card, patches `url` with the pre-resolved `endpointUrl`, then instantiates `A2AClient` from `@a2a-js/sdk` with the patched card object.
- `buildSendParams(content, contextId?, taskId?)` — Constructs `MessageSendParams` with nanoid message ID, `role: 'user'`, text part.
- `extractTextFromResult(result)` — Extracts concatenated text from any A2A response type (`message`, `task`, `status-update`, `artifact-update`). Prioritizes artifact parts, then status message parts.

### IPC Agent Handler — `src/main/ipc/agent.ipc.ts`

- `registerAgentHandlers()` — Registers CRUD `agent:*` IPC channels (list, upsert, delete) and delegates to `registerA2AHandlers()`.

### IPC A2A Handler — `src/main/ipc/agent_a2a.ipc.ts`

- `registerA2AHandlers()` — Registers A2A protocol-specific IPC channels (fetch-card, test, send-message, cancel-message).
- `agent:send-message` handler — Uses `protocolInterfaceUrl` (falling back to `endpointUrl`) to create A2A client, detects streaming capability, saves user message, streams or fetches response, saves assistant message, updates chat timestamp. Uses `AbortController` for cancellation tracked by `activeAbortControllers` map.
- `agent:test` handler — Fetches card with protocol negotiation, updates cached `cardData`, `endpointUrl`, `protocolInterfaceUrl`, `protocolInterfaceVersion`, and `skills` in DB.

## Renderer Components

- `AgentsSettingsSection` — Filters agents by `protocol === 'a2a'`, renders `AgentCard` list + toggle for `A2AAgentForm`.
- `A2AAgentForm` — Card URL + access token inputs, test connection shows card preview: name, description, agent version, resolved protocol version + transport (e.g. "A2A v0.3.0 · JSONRPC"), all supported versions, endpoint URL, streaming badge, skills. Passes `protocolInterfaceUrl` and `protocolInterfaceVersion` on save.
- `AgentCard` — Expandable card. Collapsed: status dot, name, protocol label with version (e.g. "A2A v0.3.0"). Expanded: description, card URL, protocol version + transport + supported versions, resolved endpoint URL, agent version, streaming badge, skills list, token management, test connection. Transport is derived by matching `protocolInterfaceUrl` against `cardData.supportedInterfaces`.
- `AgentSelector` — Bot icon button in chat input area. Dropdown lists enabled agents. Click to toggle selection. Hidden when no agents are enabled. When an agent is selected, the button expands into a chip showing the agent name + X dismiss button (expand-in/shrink-out CSS animations). Fires `onCollapsed` callback after the shrink animation completes (used to return focus to text input).
- `AgentMentionPopup` — Popup rendered above the text input when user types `@`. Shows filtered enabled agents with name, protocol tag, and description. Supports keyboard navigation (Arrow keys, Enter/Tab to select, Escape to dismiss) and outside-click dismissal.
- `ChatInput` — Exposes `ChatInputHandle` via `forwardRef`/`useImperativeHandle` with a `focus()` method. Contains `@`-mention detection: `findMentionToken()` walks backwards from cursor to find `@` preceded by whitespace or at start of input; extracts filter text. Manages mention popup state (open, filter, selected index). On agent selection, removes the `@...` token from input and calls `onSelectAgent`. The mention popup is only active on the new chat screen (`chatId === null`).
- `MainArea` — Holds `selectedAgent` state and `chatInputRef` (ref to `ChatInputHandle`). Passes `onSelectAgent` to `ChatInput` and `onCollapsed={focusChatInput}` to `AgentSelector`. When agent is selected and user sends first message, creates chat and routes through `window.api.agents.sendMessage()` instead of `window.api.llm.sendMessage()`. Resets agent selection after chat creation.

## Dependencies

- **`@a2a-js/sdk`** (v0.3.13) — Official A2A protocol SDK, speaks protocol v0.3. Used for JSON-RPC transport and SSE streaming. Only the client sub-package is used (`@a2a-js/sdk/client`). Note: agent card fetching is done manually (not via `A2AClient.fromCardUrl()`) to support protocol version negotiation with v1.0 servers.

## Security

- **Access tokens** encrypted at rest using `safeStorage` (same mechanism as LLM API keys)
- **Renderer isolation** — Token never sent to renderer; only `hasAccessToken: boolean` exposed
- **Auth injection** — Custom `fetchImpl` wraps standard `fetch` with `Authorization: Bearer` header, passed to A2A SDK client
