# Cinna Desktop

Desktop client for remote agents (MCP, A2A, OpenCinna).

## Glossary

| Term | Definition |
|------|-----------|
| **Chat** | A conversation with an LLM, persisted in SQLite with messages and model/provider binding |
| **Chat Mode** | A named preset bundling an LLM provider/model, MCP servers, and a color — used to quickly start configured chats |
| **Provider** | An LLM service (Anthropic, OpenAI, Gemini) configured with an encrypted API key |
| **Adapter** | Implementation of the `LLMAdapter` interface that translates between our chat system and a provider's SDK |
| **MCP Server** | A Model Context Protocol server (local stdio or remote HTTP) that exposes tools to the LLM |
| **MCP Connection** | A live client session to an MCP server, managed by MCPManager |
| **On-Demand MCP** | An MCP server the user `@-mentions` into a chat so its tools are available only for that chat — tracked separately from the chat mode's baseline MCP set |
| **Tool Call** | LLM requests a tool -> main process calls MCP server -> result fed back to LLM |
| **MessagePort** | Electron's streaming channel used to send LLM response chunks from main to renderer |
| **safeStorage** | Electron's OS-keychain encryption used for API keys and OAuth tokens at rest |
| **Agent** | An external AI service (e.g. A2A agent) registered by the user, communicating via a standardized protocol |
| **A2A** | Agent-to-Agent Protocol v1.0 — open standard for AI agent interoperability (discovery, messaging, streaming) |
| **Agent Card** | A2A discovery metadata (JSON) fetched from a well-known URL, describing agent capabilities and endpoint |
| **Message Part** | A typed segment of an assistant message (`kind: 'text' \| 'thinking' \| 'tool' \| 'tool_result' \| 'command_result'`) — A2A messages may persist a structured `parts[]` list driven by the Cinna `cinna.content_kind` metadata convention. The sibling `'notice'` kind bypasses `parts[]` and lands on its own `agent_transition` row (agent-side system notice). The `'command_result'` kind carries the synchronous output of a platform slash-command and IS the assistant turn for that user message |
| **@-mention** | Typing `@` in the new-chat input to open a popup for selecting references (agents, and extensible for future types) |
| **Communication Pattern** | How a new chat will route, derived from the current selection: **A2A** (one agent, no on-demand MCPs → direct agent connection) or **AI** (anything else → local model orchestrates). Surfaced as a badge left of the composer Cog |
| **Orchestrated Mode** | An LLM-root chat where the local model is the conductor and each attached agent is exposed to it as an emulated MCP tool, unioned with the real MCP tools. The "AI" communication pattern |
| **On-Demand Agent** | An agent `@-mentioned` into a chat so the orchestrator can call it as a tool. Mirrors On-Demand MCP exactly (`chat_on_demand_agents`, sticky chips, one-shot announce) |
| **Tool Provider** | Polymorphic tool source the orchestrator unions — an MCP provider (`McpToolProvider`) or an agent provider (`A2AAsMcpProvider`). Tool calls route by provider type |
| **Agent Sub-thread** | An agent-backed tool call rendered as an expandable nested thread showing the agent's own parts (thinking/tool/tool_result/text) rather than an opaque result string |
| **cinna.mcp Descriptor** | Optional backend-supplied shape (tool name, description, input schema) describing how an agent appears as an emulated MCP tool. Synthesized from agent fields when absent |
| **Note Attachment** | A profile note attached to a user message via the composer's `?` mention popup. Materialized at send time into a synthetic `.md` riding the standard file-attachment pipeline |
| **Attachment** | A file attached to a single user turn. Three sources: `cinna` (bytes on the Cinna backend, A2A-referenced), `local` (bytes in `userData/files/<userId>/<chatId>/`, used for raw-LLM chats), or `pending` (composer-only, paths held on disk for the new-chat flow until scope is known) |
| **Media Part** (file) | Resolver output handed to an LLM adapter: `image`, `document` (native non-image bytes like PDF), or `text` (UTF-8 from extraction). Adapters translate to provider-native content blocks |
| **Path Guard** | TTL-based allowlist of OS paths the renderer is permitted to reference. Populated by file dialogs and `webUtils.getPathForFile` so a compromised renderer can't synthesize arbitrary absolute paths |
| **User Account** | A local profile (username + optional password) that scopes all data — chats, providers, agents, settings |
| **Default User** | Built-in guest account (`__default__`) with no password, always present |
| **Cinna Account** | A user account linked to a remote Cinna server (cloud or self-hosted) via OAuth 2.0 + PKCE |
| **Cinna Server** | Remote service (cloud at `opencinna.io` or self-hosted) providing agent orchestration and future features |
| **Default Scope** | Shared storage under `__default__` user id — LLM providers, MCP servers, chat modes, and local agents live here and are visible from every profile |
| **Profile Scope** | Per-account storage under the active user id — chats, remote agents, agent overrides, and Cinna tokens live here and swap on user switch |
| **Agent Override** | Per-profile boolean (`agent_overrides` table) that overlays a synced agent's `enabled` flag so user toggles survive resync |
| **Job** | A reusable, profile-scoped saved spec (title, prompt, execution config). Two execution types: `local` (spawns a chat) or `cinna_task` (creates a remote cinna-core task) |
| **Job Folder** | User-defined sidebar grouping for jobs (profile-scoped, name + collapsed-state + sort position). Thin collapsible separator — owns ordering, not execution config. A job lives in exactly one folder or at the root |
| **Job Run** | One execution of a Job. Local runs reference the spawned `chatId`; Cinna runs reference the remote task; status flips via stream completion (local) or polling (cinna) |
| **Cinna Task Job** | Job variant that calls cinna-core's `POST /api/v1/tasks/`. Only available on Cinna-linked profiles; conversation lives on cinna-core, desktop keeps a pointer |
| **Task Comment** | Authored content on a cinna task (`comment_type = message \| result`); see also Activity for system-generated entries |
| **Task Attachment** | A file attached to a cinna task or one of its comments. Distinct from `FileUpload` (chat attachments) — uses a task-scoped download URL (`/api/v1/tasks/{taskId}/attachments/{id}/download`) |
| **Task Activity** | UI grouping for system-generated comment types (`status_change`, `assignment`, `system`) — shown as a compact collapsible log separate from authored comments |
| **Note** | A profile-scoped markdown document (title + body) the user inline-edits in the Notes tab. Autosaves on debounce; rendered with the same `react-markdown` stack used for chat bubbles |
| **Note Folder** | User-defined sidebar grouping for notes (profile-scoped, name + collapsed-state + sort position). Mirrors Job Folder semantics — a thin collapsible separator that owns ordering, not content |

## Domain Map

| Domain | Description |
|--------|-------------|
| [Core](core/resource_activation/resource_activation.md) | Cross-cutting architecture: account-scoped resources, activation gate |
| [Auth](auth/user_accounts/user_accounts.md) | Local user accounts, login/registration, user-scoped data |
| [Chat](chat/messaging/messaging.md) | Conversation CRUD, message streaming, tool-call loop |
| [Agents](agents/agents/agents.md) | External AI agent integration (A2A protocol), agent discovery, chat routing |
| [Jobs](jobs/jobs/jobs.md) | Reusable saved work specs (prompt + config) the user can execute repeatedly — local (spawns a chat) or Cinna Task |
| [Notes](notes/notes/notes.md) | Profile-scoped markdown notes with inline edit, folder organisation, and shared trash retention |
| [LLM](llm/adapters/adapters.md) | Provider management, adapter abstraction, model selection |
| [MCP](mcp/connections/connections.md) | MCP server connections, tool aggregation, OAuth DCR |
| [UI](ui/app_shell/app_shell.md) | App shell chrome (top bar, sidebar, footer menus), settings screen, theming |
| [Development](development/setup/setup.md) | Dev environment, commands, gotchas |

## Feature Registry

### Core
- [Resource Activation](core/resource_activation/resource_activation.md) — Account-scoped resource lifecycle: services only run after user authentication
- [Settings Scope](core/settings_scope/settings_scope.md) — Default (shared) vs Profile (per-account) scope: which settings follow the user across profiles, which stay account-bound
- [Boot Resilience](core/boot_resilience/boot_resilience.md) — Fatal-startup dialog instead of ghost windows, renderer-crash detection, migration ordering safety for fresh installs

### Auth
- [User Accounts](auth/user_accounts/user_accounts.md) — Local user profiles with optional password auth, user-scoped data isolation, session management
- [Cinna Accounts](auth/cinna_accounts/cinna_accounts.md) — OAuth 2.0 + PKCE connection to remote Cinna servers (cloud or self-hosted), token rotation
- [Cinna Re-authentication](auth/cinna_accounts/reauthentication.md) — In-place re-auth when a Cinna session expires. Four entry points (Settings → Connection card, settings banner, agent-status overlay, chat error chip) re-run OAuth against the stored server URL, verify the OAuth-returned email matches the local user, and overwrite only the token columns — local data is preserved
- [Onboarding](auth/onboarding/onboarding.md) — First-launch welcome screen: pick API key (validate + auto-create default chat mode) or Cinna Server (reuses self-hosted OAuth flow); force-on-restart toggle in Development settings for QA

### Chat
- [Messaging](chat/messaging/messaging.md) — Chat CRUD, MessagePort streaming, multi-provider tool-call loop
- [Conversation UI](chat/conversation_ui/conversation_ui.md) — Message rendering: user bubbles, assistant plain text, tool blocks, system errors
- [Chat Modes](chat/chat_modes/chat_modes.md) — Named presets bundling LLM provider/model, MCP servers, and color scheme for one-click chat setup
- [Example Prompts](chat/example_prompts/example_prompts.md) — Remote-agent starter prompts shown as an animated tag cloud and surfaced via `#` in the chat input
- [CLI Commands](chat/cli_commands/cli_commands.md) — `/` picker surfacing an agent's `cinna.run.*` shell commands; selecting one inserts the `/run:<slug>` invocation string
- [Mention Popups](chat/mention_popups/mention_popups.md) — Shared trigger-driven listbox primitive (`@`, `#`, `/`) backing the agent, example-prompt, and CLI-command pickers
- [Orchestrated Agents](chat/orchestrated_agents/orchestrated_agents.md) — Agents-as-MCP, the engine for multi-counterparty chats: when a chat mixes ≥2 counterparties (LLM + agent, two agents, or agents + MCPs) the local model conducts and calls each agent as an emulated MCP tool, rendering each as an expandable sub-thread; a lone agent still talks direct A2A. Bringing a 2nd counterparty into a one-on-one chat promotes it in-chat (with agent-attributed history handoff). `A2A`/`AI` badge on the composer
- [File Attachments](chat/file_attachments/file_attachments.md) — `[+]` menu + drag-drop with deferred ingest on new-chat; per-model capability picks native pass-through (images, PDF on Anthropic/Gemini) vs text extraction (CSV/JSON/code via UTF-8, DOCX/XLSX/PPTX/PDF-on-OpenAI via `officeparser`); local store under `userData/files/<userId>/<chatId>/` for raw-LLM chats, Cinna backend for remote agents; path-guard allowlist + chat-ownership check + `basename` filename sanitization
- [Note Attachments](chat/note_attachments/note_attachments.md) — `?` mention popup attaches profile notes as composer badges (click to preview); at send time each note's live body is materialized as a `<safe-title>.md` routed through the existing file-attachment pipeline (`fileService.ingestSyntheticContent` → `fileService.ingest`). Double-Enter shortcut: picking a note then pressing Enter on an empty composer expands the note body inline as text instead of sending — prompt-template paste without leaving the keyboard.
- [Agent Notices](chat/agent_notices/agent_notices.md) — Agent-side system messages (`cinna.content_kind: 'notice'` TextParts) stream live as muted system pills, then collapse to a clickable accent dot once persisted as `agent_transition` rows. Excluded from LLM history rebuilds
- [Command Results](chat/command_results/command_results.md) — Synchronous platform slash-command output (`cinna.content_kind: 'command_result'` TextParts from `/files`, `/agent-status`, `/run:*` variants, …) renders as a bordered terminal-style "Command output" block. The agent stream never runs — the part IS the assistant turn and persists into the message's `parts[]` so chat previews and titles work
- [Auto Chat Titles](chat/auto_titles/auto_titles.md) — Opt-in background AI function: on the first user message in a new chat, generates a concise (≤ 40 char) title via the user's default chat mode LLM provider; replaces the renderer's truncated-message fallback. Fire-and-forget, fully fail-tolerant, no UI surface beyond a Settings → Features toggle

### Agents
- [Agents](agents/agents/agents.md) — A2A protocol agent management, card discovery, streaming chat via external agents
- [A2A Streaming Pipeline](agents/agents/streaming_pipeline.md) — Per-part delta computation, `cinna.content_kind` / `cinna.tool_name` metadata contract (text, thinking, tool, tool_result, notice, command_result), structured `parts[]` persistence
- [Remote Agents](agents/remote_agents/remote_agents.md) — Auto-sync agents from Cinna backend, categorized display, JWT-based A2A communication
- [Bundles Catalog](agents/bundles_catalog/bundles_catalog.md) — Settings → Profile → Catalog: browse cinna-server agent bundles, one-click Quick Install, post-install setup modal that deep-links missing credentials to the cinna-server web pages and polls until the runtime gate clears
- [Agent Status](agents/agent_status/agent_status.md) — Title-bar activity indicator + frosted-glass modal surfacing per-agent self-reported status (severity, summary, markdown body) with one-click "Start chat"

### Jobs
- [Jobs](jobs/jobs/jobs.md) — Reusable saved work specs (prompt + agents/mode/MCP config) with a sidebar Chats/Jobs tab strip and drag-and-drop folders for organising jobs; local runs route through the shared `derivePattern` (single agent → direct A2A, otherwise an orchestrated LLM-root chat) and spawn a chat, Cinna Task runs hit cinna-core and poll for status
- [Cinna Task Run View](jobs/cinna_task_view/cinna_task_view.md) — Read-only in-app view of a `cinna_task` run: comments + standalone/inline attachments fetched from cinna-core, markdown-rendered, with task-scoped attachment download; reached by clicking a cinna_task row in a job's run history

### Notes
- [Notes](notes/notes/notes.md) — Inline-edit markdown notes with folder organisation, drag-drop ordering, soft-delete to trash, and shared 30-day retention with chats

### LLM
- [Adapters](llm/adapters/adapters.md) — Custom LLM abstraction layer with Anthropic, OpenAI, Gemini adapters
- [Provider Integration](llm/adapters/provider_integration.md) — Cross-provider translation matrix (message history, tool schema, tool-call extraction, error parsing) and known per-provider quirks
- [AI Functions](llm/ai_functions/ai_functions.md) — Shared primitive for one-shot LLM calls (Auto Chat Titles today; chat-summary and similar utilities in the future) — adapter resolution + `runSingleShot`

### MCP
- [Connections](mcp/connections/connections.md) — MCP server lifecycle, stdio/SSE/streamable-http transports, OAuth DCR
- [On-Demand MCP](mcp/on_demand/on_demand.md) — `@-mention` MCP servers into a chat lazily so default chats don't pay token cost for tools they don't need; sticky chips + one-shot silent announce to the LLM
- [Registries](mcp/registries/registries.md) — Browse public MCP catalogs from Settings, one-click Connect into the standard MCP flow; built-in adapters for `registry.modelcontextprotocol.io` and the Cinna-curated catalog
- [Cinna Official Registry](mcp/registries/cinna_official.md) — Curated catalog of recommended remote MCP servers, served as a static JSON from `opencinna.io`; add/remove servers without a desktop release

### UI
- [App Shell](ui/app_shell/app_shell.md) — Window chrome: permanent top bar (traffic-light gutter, sidebar toggle, new chat), animated floating sidebar, profile/agent/interface footer menus
- [Settings](ui/settings/settings.md) — Settings screen with sidebar navigation, LLM provider and MCP server configuration
- [Verbose Mode](ui/verbose_mode/verbose_mode.md) — Compact/verbose display toggle: message timestamps, meta popup, streaming block auto-expand, and structured tool-call headers in tool narration
- [Keyboard Shortcuts](ui/keyboard_shortcuts/keyboard_shortcuts.md) — Registry of every shortcut: global menu accelerators (⌘`), context-scoped ESC, chord patterns (double-ESC) and input-popup navigation

### Development
- [Setup](development/setup/setup.md) — Dev commands, tech stack, gotchas, project status
- [UI Guidelines](development/ui_guidelines/ui_guidelines_llm.md) — Color system, expandable card pattern, button layout rules, form conventions (LLM reference)
- [Logger](development/logger/logger.md) — In-app debug logger with full-window overlay, scoped loggers for main/renderer, ⌘` keyboard shortcut
- [Main-Process Layering](development/main_layering/main_layering_llm.md) — `db → services → ipc` convention, `ipcHandle()` wrap, DomainError codes, DTO masking (LLM reference)
- [Stream Event Typing](development/stream_event_typing/stream_event_typing_llm.md) — Wire contract for the two MessagePort channels (agent A2A + LLM): shared `AgentStreamEvent` / `LlmStreamEvent` discriminated unions, typed `StreamPort` / `DeltaPort` interfaces, runtime guards at the contextBridge boundary, typed error helpers for IPC handlers (LLM reference)
- [Release & Distribution](development/distribution/release.md) — Full release cycle: macOS signing/notarization, Linux build via GitHub Actions, GitHub Releases, in-app auto-update
- [Auto-Update](development/auto_update/auto_update.md) — Runtime auto-update behavior: state machine, sidebar footer progress indicator, "Check for Updates…" menu, restart prompt

## Architecture

```
+------------------------------------------------+
|                 MAIN PROCESS                   |
|                                                |
|  SQLite (Drizzle)  LLM SDKs  MCP Clients  A2A |
|  User accounts (PBKDF2)  Session management    |
|  API keys & tokens encrypted via safeStorage   |
|                                                |
|  IPC Handlers (ipcMain.handle / .on)           |
|  + MessagePort for streaming                   |
+------------------+-----------------------------+
                   |  contextBridge (typed window.api)
+------------------+-----------------------------+
|              RENDERER (sandboxed)              |
|  contextIsolation: true, nodeIntegration: false|
|  React + Zustand + TanStack Query              |
|  window.api.auth.* / .chat.* / .providers.*    |
|  window.api.agents.* / .mcp.* / .llm.*        |
+------------------------------------------------+
```

**Security model**: API keys and OAuth tokens are encrypted at rest using Electron's `safeStorage` (OS keychain) and stored as blobs in SQLite. They are decrypted only in the main process. User passwords are hashed with PBKDF2-SHA512 (100k iterations). All data is user-scoped — every IPC query filters by the active user ID. The renderer is fully sandboxed — it can only access the typed `window.api.*` methods exposed via contextBridge.
