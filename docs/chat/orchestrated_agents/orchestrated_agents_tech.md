# Runtime Orchestration — Technical Details

## File Locations

- Main transport: `src/main/services/conductorMcpServer.ts`, `src/main/services/conductorBridge.ts`, `src/main/services/conductorToolCorrelation.ts`.
- Runtime profile/history/media: `src/main/services/chatConductorService.ts`, `src/main/services/syntheticRuntimePooling.ts`, `src/main/services/conductorTranscript.ts`, `src/main/services/acpAttachments.ts`.
- Policy: `src/main/agents/drivers/acp/conductorToolPolicy.ts`, `codexConductorPolicy.ts` and `codexAdapterPatch.json` in the same directory; generated OpenCode permissions in `src/main/agents/drivers/index.ts`.
- Nested work: `src/main/services/a2aAsMcpProvider.ts`, `src/main/services/nestedAgentTurn.ts`, `src/main/services/nestedContinuationService.ts`, `src/main/services/inboxService.ts`.
- Driver lifecycle: `src/main/agents/drivers/acp/acpDriver.ts`, `acpProcessPool.ts`, `acpFollowUp.ts`; service wiring in `src/main/agents/drivers/index.ts`.
- Renderer: `src/renderer/src/components/chat/AgentToolSubThread.tsx`, `AgentContribution.tsx`, `MessageStream.tsx`; shared child event handling in `src/renderer/src/hooks/useChatStream.ts`.

## Database Schema

- `chat_on_demand_agents` and baseline/on-demand MCP tables own attachments; `a2a_sessions` retains each driver session.
- `conductor_sessions` stores descriptor/config hashes per chat/agent, through `src/main/db/conductorSessions.ts` and the guarded migration `src/main/db/migrations/conductor-sessions.ts`.
- `task_input_requests` retains the nested invocation's root-run/tool-call address. `task_runtime` stores coordinator identity, owner and tool-call count for autonomous continuations.
- Synthetic agents are profile-scoped, keyed by `driverConfig.conductorChatId`. Instructions are written to AGENTS.md and CLAUDE.md inside the app-owned chat directory, not a user's repository.

## IPC Channels

Existing run, agent-answer, child-cancel and Inbox APIs carry execution; the loopback server is main-only and is not exposed as a renderer API. `engine:model-catalog` returns the active profile's cached runtime model choices, without launching a process or returning a bearer token.

## Services & Key Methods

- `ConductorMcpServer.ensureSession` returns a stable in-process HTTP descriptor with an isolated random path/token; reconnects create independent MCP transport connections. `refreshTools` broadcasts list changes; `abortCalls` joins wire cancellation with main abort controllers.
- `conductorBridge.prepare` excludes nested/remote sessions, injects the descriptor from the first Local turn, checks the saved fingerprint and supplies a lease. The driver records the hash (`sessionReady`) only after the session's first prompt returned an answer, so a failed replay is repeated. A driver that has to create a session clears the saved hash first (`sessionLost`). For a launch plan marked `sessionToolsFixed` (Codex) the fingerprint also covers the sorted tool names: an authenticated Codex 0.154.0-alpha.6.2 session ignored `tools/list_changed`, so a specialist attached mid-chat is met by a new session with the transcript replayed. Claude and OpenCode adopt the change in the live session and keep theirs.
- Bridge providers combine connected baseline/on-demand MCPs with agents, excluding the conductor. Runner controls take precedence over colliding MCP names and replace ordinary per-agent tools.
- Each call persists its result and publishes tool/child events. `ConductorToolCorrelation` matches Claude's explicit tool-use metadata where present and observed ACP tool names/order otherwise, preventing duplicate native and bridge transcript rows. Tool-name spelling per engine lives in `conductorToolPolicy.ts:cinnaToolName`, shared with `acpDriver.ts:isCinnaToolAsk`, the chat-owned runtime's permission gate. The silent allow for a conducting session reads a stricter source: `AcpMessageStream.cinnaTool(toolCallId)` (`acpMessages.ts`), built from adapter-set fields only, so a title the model wrote can never settle an ask; `TurnContext.conducting` records that the turn holds a conductor lease.
- `conductorBridge.prepare` resolves one budget per binding: the run's `toolCallBudget`, else `taskToolCallBudgetForChat(chatId, profileUserId, agentId)` (`src/main/tasks/toolCallBudget.ts`) — the task budget when an autonomous task holds the chat and this agent is its current coordinator, which is what a follow-up opened between turns (no budget of its own) now gets. `executeTool` skips the task budget for a provider's `budgetExempt(name)` tools (`CoordinatorToolProvider`: `RUNNER_CONTROL_TOOL_NAMES` = `update_task`, `finish`); those, and every call of an unbudgeted run, count against `MAX_CALLS` (100) per turn instead.
- A `needsInput` result marks the run binding instead of stopping at once; the stop fires when the binding's pending-call count reaches zero, so parallel siblings are not cancelled mid-flight.
- An ACP `RequestError` with `data.errorKind: 'rate_limit'` retains its diagnostic and partial output and becomes a budget stop. A nested provider forwards that stop before its generic error handling, so the first shared-login limit pauses the conductor. Message text alone never triggers this classification.
- A between-turn call wakes the existing follow-up listener and waits for a run binding. A dead listener refuses rather than executing without ownership. A follow-up the gate drops reports through `acpFollowUp.ts` `onAbandon` → `conductorBridge.abandonWaiters`, which rejects the unbound entry's waiters.
- A failed loopback listen clears the cached start so the next conductor retries it, rather than every conductor failing until restart.
- `runNestedAgentTurn` retains live permission decisions but converts questions to durable next-message requests before releasing a parked child. `nestedAgentTurns` gives Stop a chat-scoped cancellation address.
- `completeNestedContinuation` awaits specialist completion and an available chat, rechecks task authority and sends an attributed follow-up naming the tool call. Runner-owned continuations instead restore the captured coordinator in the durable runner state machine.
- `chatConductorService.remove` removes profile-owned rows marked with the deleted chat ID and its generated userData/chat-conductors directory. `chatService.permanentDelete` and `emptyTrash` call it; soft deletion retains the profile for restore.
- `replayTranscript` reconstructs saved text and attachments into a fresh ACP session, and returns nothing unless the agent is the chat's root; errors/transitions are excluded. `buildAcpPrompt` negotiates images/embedded resources and extracted text fallback.
- `syntheticRuntimePoolKey` groups only compatible profile/runtime/policy configurations. Pool aliases track individual owners/holds so stopping or retiring one owner cannot kill another active session.
- `recordRuntimeModelCatalog` consumes session/new, session/load and config-option updates. It recognizes model option groups and legacy availableModels; unrelated updates do not erase the cache. The cache is memory-only, keyed by active profile and engine. Settings uses advertised names, fallback aliases/manual IDs before discovery, and never labels the cache a live fetch.

## Renderer Components

Agent tool rows render rich child parts and actionable permission controls. Durable questions use the existing Inbox. Coordinator/Participant chips retain selection order; synthetic conductors are visible as the root but excluded from pickers.

## Configuration

Routing and AI Functions preferences are installation-wide. Chat modes store engine, credential/model, instructions and tools policy. Ordinary bridge turns are limited to 100 calls; runner limits come from its checkpoint.

## Security

The HTTP listener binds only 127.0.0.1, checks Host/Origin before parsing, validates bearer tokens with constant-time comparison, and rejects another session's token. Dispose aborts calls and destroys tokens. MCP results preserve valid structured content, but trusted control fields remain main-only. Synthetic native tools are restricted before prompt dispatch. Codex requires a main-only verified plan seal; startup and thread configuration both exclude native actions and inherited MCPs because auxiliary requests can bypass thread-only restrictions. Its exact version/model/platform checks, adapter patch and per-session instructions are described in [Codex policy](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy).

## Evidence

`conductorMcpServer.test.ts` uses real SDK HTTP clients with synthetic tools; bridge, correlation, nested-turn/continuation, transcript, policy and process-pool suites test their own boundaries. `e2e/specs/runtime-conductor.spec.ts` exercises the built sandboxed Electron UI and scripted ACP peers. These do not prove authenticated Claude/Codex/OpenCode tool execution. The exact isolated CLI/protocol evidence is in [the ACP contract](../../agents/local_agents/acp_contract.md).
