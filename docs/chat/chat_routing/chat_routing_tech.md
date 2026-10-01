# Chat Routing — Technical Details

## File Locations

- Shared: `src/shared/chatRouting.ts` — `routingOf`, `answererOf`, `newChatRouter`, `canConduct`, router validation and the default multi-agent preference type.
- Main: `src/main/services/chatService.ts` — validates ownership, normalizes roots and participants, refreshes conductor tools. `src/main/services/chatConductorService.ts` — creates/reuses the hidden per-chat ACP root and captures runtime configuration.
- Execution: `src/main/services/runExecutionService.ts` — binds missing runtime roots before driver dispatch; `src/main/services/threadContextService.ts` — per-agent catch-up; `src/main/services/conductorTranscript.ts` — full replacement-session replay, for the chat's root only.
- Renderer: `src/renderer/src/hooks/useNewChatFlow.ts`, `src/renderer/src/hooks/useChat.ts`, `src/renderer/src/hooks/useAgents.ts`; `src/renderer/src/components/layout/ChatWorkspace.tsx`; `src/renderer/src/components/chat/ChatInput.tsx`, `RouterBadge.tsx`, `OnDemandAgentChips.tsx`, `AgentChip.tsx`, `ComposerPlusMenu.tsx`; the menu shell `src/renderer/src/components/ui/ContextMenu.tsx`; the new-chat draft field in `src/renderer/src/stores/composerDraft.store.ts`.

## Database Schema

- `chats.router`: direct, human or coordinator. `agent_id` is the root for direct/coordinator and null for human.
- `chat_on_demand_agents`: participants. `chat_agent_cursors`: last message shown to each agent. `a2a_sessions`: driver session continuity per chat/agent.
- A synthetic agent is profile-owned and marked by `driverConfig.conductorChatId`; its public DTO exposes only `conductor: true`, not the bridge bearer token.
- `app_settings.defaultMultiAgentRouting`: human by default, coordinator for AI routes. Existing chat rows are not migrated by changing the preference.

## IPC Channels

- `chat:set-router(chatId, router)` validates the transition and returns success; normal chat reads return the normalized root.
- `chat:set-coordinator(chatId, agentId)` → `{ success }` (preload `window.api.chat.setCoordinator`) — make an agent already in the chat its conductor. Rejects with a standalone message: the agent is not in the chat, no longer exists, cannot conduct, a turn runs, or a task holds the chat.
- `chat:list` / `chat:get` rows carry `taskHeld: boolean` (an autonomous task runner holds the chat, from `taskRunnersByChat`) beside `activeRunId`, so the renderer can disable Set as Coordinator with main's reason before asking.
- `chat:update` applies mode/runtime changes. `chat:on-demand-agent-add/remove/list` manages the participant set.
- `run:start` admits a main-owned turn; `run:watch` observes it. `run:send` shares the same executor. The renderer submits the addressed agent, not an alternative execution channel.

## Services & Key Methods

- `chatService.setRouter` and `chatService.setCoordinator` share one module-private path, `applyRouter(userId, chat, router, conductorId?)`. It refuses a task-held chat, then an active run (`run_active`, "Interrupt the session before changing who answers."), then turning coordination off. With a `conductorId` it binds that agent as root; without one, `setRouter`'s rules below pick. When the root changes in a `direct` or `coordinator` chat, the old root is detached into the attached set, except a chat-owned runtime, which is only unbound. A coordinator root that changed has its `conductor_sessions` fingerprint saved as `''`, so its first turn as root is a fresh session with the transcript replayed rather than a load of the session it held as a participant. Release is a set difference: `chatMembers(root, attached)` before and after, `releaseChatSessions(chatId, agentId)` for each agent gone, plus the old root when it stays as a participant under a new conductor; then `refreshConductor`.
- `chatService.setCoordinator` checks membership (root or `chat_on_demand_agents`), existence and `canConduct`, then calls `applyRouter(…, 'coordinator', agentId)`. An unchanged router and root is a no-op.
- `chatService.setRouter`: keep an eligible Local root; otherwise attach a remote root and bind an eligible Local participant or synthetic Default runtime. Existing sessions survive promotion. A request for human routing on a direct chat whose root is a chat-owned runtime (`isChatConductor`) is rewritten to coordinator before anything is detached, so no caller can turn the hidden runtime into a participant.
- `chatConductorService.ensure/bind`: capture engine, credential, model, instructions and tool policy; write instructions into a chat-owned directory under userData.
- `runExecutionService`: normal sends and resends build per-agent catch-up for human/coordinator routing or an explicit different participant. Only completed turns advance the recipient cursor; its own replies and addressed inputs remain excluded. Normalize a rootless non-human chat before choosing its driver. SDK adapter streaming is no longer an execution branch.
- `routingOf`: root duality for direct/coordinator, sticky addressing for human; reports nominal attachment scope which the concrete agent's local attachment capability can override.

## Renderer Components

- `ChatWorkspace` previews the initial router with the preference and explicit coordinate intent retained in the per-surface composer draft; the intent is cleared when the draft's last picked agent is removed.
- `useAttachAgentToChat` (`src/renderer/src/hooks/useAgents.ts`) asks for coordinator, not the preference, when the direct root carries `conductor: true`; `ChatInput` applies the same test to the Coordinate action and to sticky addressing. These mirror main's rule for an honest optimistic state — `chatService.setRouter` is the enforcement.
- `useNewChatFlow` prepares participants/MCPs, applies the root/mode, reads the normalized chat and fresh agent list, publishes that agent list to the query cache and resolves files under the actual root's capability.
- `useUpdateChat` and `useSetChatRouter` invalidate affected detail, agent and participant caches. Optimistic coordinator state retains the current root until main normalizes it.
- `useSetChatCoordinator` (`useChat.ts`) is optimistic: the chat row gets `router: 'coordinator'` and the new root, the attached set loses the new conductor and gains the old root — only when the cached agent list shows it is not a `conductor: true` runtime, since an unknown root might be one and would flash as a participant chip. Rolled back on error; settles by invalidating agents, the chat, its participants and the list.
- `useChatDetail` polls a `taskHeld` chat every 3 s (1 s while a run is active and unattached). Main releases a task's hold with no event to the renderer, often just after the last turn's refetch; without the poll, what the hold disables stays disabled.
- `ChatInput` builds `chipCoordinatorMenu`: in a chat, the conductor (root of a coordinator chat), a blocked reason (task-held first, then streaming / `activeRunId` / a pending mutation — main's own messages, word for word) and `onSet` → `useSetChatCoordinator().mutateAsync`, whose rejection the chip menu shows in place. On the new-chat screen it forwards `routerInfo.onSetCoordinator` with no blocked reason.
- New chat: `ChatWorkspace.setPendingCoordinator` stores the pick in the composer draft's `conductorId` and sets `coordinate`. `conductorAgent` is that pick while it is still among the picked agents and can conduct, else the first picked agent when it can conduct, else null (the Default runtime). The badge, the `[+]` row's name and `useNewChatFlow`'s `conductorId` all read it, so the preview cannot name another conductor than the send binds; `useNewChatFlow` roots a coordinator chat at `conductorId` when it is among the agents. The pick is cleared with the last picked agent and after a send that did not edit it meanwhile.
- `RouterBadge` shows conductor details only; the one-way Coordinate action lives in the `[+]` menu (`coordinateToggle` in `ChatInput`). The popover is a `dialog` only when it holds the telemetry control, a `tooltip` otherwise.
- `AgentChip.tsx:AgentChip` is the one chip for the bound agent (`ChatInput`) and every attached or pending agent (`OnDemandAgentChips`). Props carry the colours, `coordinator` (inset 1px side shadows via `--chip-border`, `data-coordinator`), `addressed` (`ring-2` in `--color-text`), the `label` used as `title` and accessible name, and an optional `menu`. `ACCENT_CHIP` is reserved for the hidden runtime; `agentChipClass` (also used by `ActiveMcpChips`) moved here. A chip with no inner button is itself focusable (`role="group"`, `aria-haspopup="menu"`) so the keyboard reaches its menu.
- `AgentChipMenuHost` (wrapping the chip row in `ChatInput`) owns the open menu above the chips: Set as Coordinator moves chips optimistically and unmounts the one the menu was opened on, and the menu must outlive it to show a refusal. A menu opened from the keyboard returns focus to the chip control on close. Items: Set as Coordinator (from `ChipCoordinatorAction`), Go to Agent (`hasAgentPage` → `useOpenAgentPage`), Open Agent Folder (membership in `useLocalAgents()` → `useOpenAgentPath`).
- `OnDemandAgentChips` puts the new chat's chosen conductor first and renders the Default runtime as a menu-less coordinator chip when nobody else conducts; `CANNOT_CONDUCT_REASON` is shared with `ChatInput`.
- `AgentConnectionDetails.tsx` retains transport details with safe hosts and credential presence only. Synthetic/runtime IDs remain resolvable even though their agents are hidden from selection lists.

## Configuration

`defaultMultiAgentRouting` is installation-wide. Runtime defaults live in Agents settings; chat-mode overrides are described in [Chat Modes](../chat_modes/chat_modes_tech.md).

## Security

Chat/participant mutations require activation and ownership. Remote participants never become conductors solely because their registration is local. Secrets remain in main. ACP injection, no-native-tools restrictions and endpoint lifetime are covered by [Orchestration](../orchestrated_agents/orchestrated_agents_tech.md).

Routing to a chat-owned Codex root does not bypass launch compatibility: its [restricted policy](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy) validates the installed CLI/adapter and effective model before prompting. A saved mode or a detected CLI is not proof that this synthetic policy is supported.
