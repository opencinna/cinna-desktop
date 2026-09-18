# Chat Routing — Technical Details

## File Locations

- Shared: `src/shared/chatRouting.ts` — `routingOf`, `answererOf`, `newChatRouter`, `canConduct`, router validation and the default multi-agent preference type.
- Main: `src/main/services/chatService.ts` — validates ownership, normalizes roots and participants, refreshes conductor tools. `src/main/services/chatConductorService.ts` — creates/reuses the hidden per-chat ACP root and captures runtime configuration.
- Execution: `src/main/services/runExecutionService.ts` — binds missing runtime roots before driver dispatch; `src/main/services/threadContextService.ts` — per-agent catch-up; `src/main/services/conductorTranscript.ts` — full replacement-session replay.
- Renderer: `src/renderer/src/hooks/useNewChatFlow.ts`, `src/renderer/src/hooks/useChat.ts`, `src/renderer/src/hooks/useAgents.ts`; `src/renderer/src/components/layout/ChatWorkspace.tsx`; `src/renderer/src/components/chat/ChatInput.tsx`, `RouterBadge.tsx`, `OnDemandAgentChips.tsx`, `ComposerPlusMenu.tsx`.

## Database Schema

- `chats.router`: direct, human or coordinator. `agent_id` is the root for direct/coordinator and null for human.
- `chat_on_demand_agents`: participants. `chat_agent_cursors`: last message shown to each agent. `a2a_sessions`: driver session continuity per chat/agent.
- A synthetic agent is profile-owned and marked by `driverConfig.conductorChatId`; its public DTO exposes only `conductor: true`, not the bridge bearer token.
- `app_settings.defaultMultiAgentRouting`: human by default, coordinator for AI routes. Existing chat rows are not migrated by changing the preference.

## IPC Channels

- `chat:set-router(chatId, router)` validates the transition and returns success; normal chat reads return the normalized root.
- `chat:update` applies mode/runtime changes. `chat:on-demand-agent-add/remove/list` manages the participant set.
- `run:start` admits a main-owned turn; `run:watch` observes it. `run:send` shares the same executor. The renderer submits the addressed agent, not an alternative execution channel.

## Services & Key Methods

- `chatService.setRouter`: keep an eligible Local root; otherwise attach a remote root and bind an eligible Local participant or synthetic Default runtime. Existing sessions survive promotion.
- `chatConductorService.ensure/bind`: capture engine, credential, model, instructions and tool policy; write instructions into a chat-owned directory under userData.
- `runExecutionService`: normal sends and resends build per-agent catch-up for human/coordinator routing or an explicit different participant. Only completed turns advance the recipient cursor; its own replies and addressed inputs remain excluded. Normalize a rootless non-human chat before choosing its driver. SDK adapter streaming is no longer an execution branch.
- `routingOf`: root duality for direct/coordinator, sticky addressing for human; reports nominal attachment scope which the concrete agent's local attachment capability can override.

## Renderer Components

- `ChatWorkspace` previews the initial router with the preference and explicit coordinate intent retained in the per-surface composer draft.
- `useNewChatFlow` prepares participants/MCPs, applies the root/mode, reads the normalized chat and fresh agent list, publishes that agent list to the query cache and resolves files under the actual root's capability.
- `useUpdateChat` and `useSetChatRouter` invalidate affected detail, agent and participant caches. Optimistic coordinator state retains the current root until main normalizes it.
- `RouterBadge` shows conductor details and the one-way Coordinate action; the plus menu exposes the same action. Role labels/rings do not reorder chips.
- `AgentConnectionDetails.tsx` retains transport details with safe hosts and credential presence only. Synthetic/runtime IDs remain resolvable even though their agents are hidden from selection lists.

## Configuration

`defaultMultiAgentRouting` is installation-wide. Runtime defaults live in Agents settings; chat-mode overrides are described in [Chat Modes](../chat_modes/chat_modes_tech.md).

## Security

Chat/participant mutations require activation and ownership. Remote participants never become conductors solely because their registration is local. Secrets remain in main. ACP injection, no-native-tools restrictions and endpoint lifetime are covered by [Orchestration](../orchestrated_agents/orchestrated_agents_tech.md).

Routing to a chat-owned Codex root does not bypass launch compatibility: its [restricted policy](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy) validates the installed CLI/adapter and effective model before prompting. A saved mode or a detected CLI is not proof that this synthetic policy is supported.
