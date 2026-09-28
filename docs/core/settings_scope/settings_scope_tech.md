# Settings Scope — Technical

## File Locations

### Shared
- `src/shared/userIds.ts` — `DEFAULT_USER_ID = '__default__'`. Imported by both main and renderer; no other hardcoded literals should appear.

### Main process
- `src/main/auth/scope.ts` — `DEFAULT_SCOPE_USER_ID`, `getSettingsScopeUserId()`, `getProfileScopeUserId()`, `getAgentLookupScope()`.
- `src/main/auth/chatScope.ts` — which owners' chats a profile sees and who owns a given chat; its header states the owner-versus-profile invariant. `localDataInAllProfiles()`, `chatScopesFor(profile)` / `getChatScopes()`, `visibleChat(profile, chatId)`, `ownerOfVisible(profile, chat)`, `chatOwnerFor(profile, chatId)` / `resolveChatOwner(chatId)`, `visibleChatFile(profile, fileId)`. Kept out of `scope.ts` because it reads the database, and `scope.ts` is the session-only answer many modules and their test doubles depend on.
- `src/main/auth/session.ts` — `getCurrentUserId()` primitive; consumed only by `scope.ts` and the session-identity check in `authService`.
- `src/main/auth/reload.ts` — `reloadUserProviders()` now loads via `getSettingsScopeUserId()` so the LLM + MCP set is identical across profiles.
- `src/main/auth/activation.ts` — `userActivation.activate(userId)` calls `reloadUserProviders()` (Default scope) and starts `runSyncOnce(userId)` / `startPeriodicSync(userId)` for Cinna users (Profile scope).
- `src/main/db/agents.ts` — `agentOverrideRepo.{listForUser, get, set}`; `agentRepo` unchanged.
- `src/main/db/agents.ts` — `agentShortcutRepo.{listForUser, set, deleteForAgent}` for the per-profile `⌘1`–`⌘9` bindings.
- `src/main/db/users.ts` — `deleteWithCascade(id)` includes `agent_overrides` and `agent_shortcuts` in the same transaction as the other Profile-scope deletions.
- `src/main/db/schema.ts` — `agentOverrides` table; composite primary key `(userId, agentId)`.
- `src/main/db/migrations/agent-overrides.ts` — table creation with documented absence of FK/cascade.
- `src/main/services/agentService.ts` — `listMerged()`, `findAgent()`, `setEnabled()`. `agentService.list(userId)` removed.
- `src/main/ipc/agent.ipc.ts` — `agent:list` calls `listMerged`; `agent:upsert` / `agent:delete` target Default scope; `agent:sync-remote` targets Profile scope; `agent:set-enabled` routes local rows versus profile overrides.
- `src/main/ipc/agent_a2a.ipc.ts` — all agent lookups via `agentService.findAgent(default, profile, id)`.
- `src/main/ipc/chatmode.ipc.ts`, `provider.ipc.ts`, `mcp.ipc.ts` — all use `getSettingsScopeUserId()`.
- `src/main/ipc/chat.ipc.ts`, `agent_status.ipc.ts`, `llm.ipc.ts`, `auth.ipc.ts` (`auth:get-current`) — use `getProfileScopeUserId()`.
- `src/main/services/chatService.ts` — every method takes the active profile and resolves the owner itself: `requireOwnedChat` uses `visibleChat`, list reads pass `listOwners(profile)` (a lone owner stays a string), writes go to `chat.userId`. `ownerForBinding` and `settleNewChatOwner` decide a new chat's owner inside `update`, before any conductor is made for it.
- `src/main/services/handoverOrigin.ts:handoverOriginProfile(brief, activeProfile)` — the profile a found handover belongs to; a guest-owned origin chat the active profile sees resolves to the active profile.
- `src/main/services/runExecutionService.ts` — `RunScope.profileUserId` is always the active profile; the chat row and the `liveRunHub` key resolve the owner through `visibleChat` / `ownerOfVisible`. `run.ipc.ts` watches by the same owner key.
- `src/main/services/runQueueService.ts` — queues keyed by `(chat owner, chatId)`; `clear` drops by chat id alone (a hard-deleted chat no longer says who owned it); `clearProfile` also drops what a profile queued into a shared chat.
- `src/main/services/chatRemoval.ts:chatHardDeleted(userId, chatId, ownerUserId)` — task runners by profile, conductor runtime by owner.
- Every other chat-ownership check in main (`askDelivery`, `chatRouting`, `chatTitleService`, `conductorBridge`, `conductorTranscript`, `customAgentService`, `delegationService`, `fileService`, `fileStore`, `inboxService`, `jobService`, `managedAgentService`, `messageRoutingService`, `nestedContinuationService`, `scriptRuntimeService`, `taskExecutionService`, `taskRunnerService`, `taskService`, `taskSyncService`, `agent_a2a.ipc.ts`, `session_activity.ipc.ts`) uses `visibleChat` instead of `chatRepo.getOwned`. A new check that calls `chatRepo.getOwned(profile, chatId)` directly refuses every shared chat.

### Preload
- `src/preload/index.ts` — `window.api.agents.setEnabled(agentId, enabled)`.

### Renderer
- `src/renderer/src/stores/ui.store.ts` — `SettingsMenu` includes `'profile-agents'`; `PROFILE_SCOPE_TABS` constant lists Profile-only tabs.
- `src/renderer/src/components/layout/Sidebar.tsx` — renders Default + conditional Profile groups; auto-resets `settingsTab` via `useEffect` when Profile group disappears.
- `src/renderer/src/components/settings/SettingsPage.tsx` — routes `'profile-agents'` to `<AgentsSettingsSection />`; `local-agents` routes to `LocalAgentsSettingsSection`, with visible title Agents.
- `src/renderer/src/components/settings/AgentsSettingsSection.tsx` — profile-only server-domain list of Cinna agents, including disabled rows; no default-scope A2A list or creation form.
- `src/renderer/src/components/settings/AgentCard.tsx` — connection details on external agent pages; visibility is owned by `AgentsSettingsSection` and `ExternalAgentActionsMenu` through `useAgentDesktopVisibility`.
- `src/renderer/src/hooks/useAppSettings.ts:useSetAppSetting()` — on a `showLocalDataInAllProfiles` write, invalidates `['chats']`, `['trash']` and `['chat']` as well, because main decides the listed owners from that key.
- `src/renderer/src/hooks/useAgents.ts` — `useSetAgentEnabled()` with optimistic update, rollback `onError`, refetch `onSettled`.

`src/renderer/src/hooks/useAgentDesktopVisibility.ts` snapshots the active profile and sidebar order before the optimistic update, invalidates status on success, and redirects only if the same profile and disabled agent page are still selected.

## Database Schema

- `agent_overrides` (migration: `src/main/db/migrations/agent-overrides.ts`)
  - Composite PK `(user_id, agent_id)`
  - Columns: `enabled` (bool), `updated_at` (int)
  - No FK to `agents.id` — overrides intentionally survive a sync remove+re-add cycle. Per-user cleanup happens in `userRepo.deleteWithCascade`.
- `agent_shortcuts` (migration: `src/main/db/migrations/agent-shortcuts.ts`)
  - PK `(user_id, slot)`, `UNIQUE (user_id, agent_id)`; columns `agent_id`, `updated_at`
  - Keyed by the profile that bound the digit, not by the agent row's owner. No FK to `agents.id`, same reason as `agent_overrides`. Details: [Keyboard Shortcuts — Technical Details](../../ui/keyboard_shortcuts/keyboard_shortcuts_tech.md#database-schema)

`chats.user_id` is the chat owner. `chatRepo` list reads (`list`, `listMessageStats`, `listMessageAgentIds`, `listOnDemandAgentIds`, `listTrash`, `emptyTrash`) and `chatRunResultRepo.list` accept `ChatOwners` — one id or an array — so the merged list is one statement with one ordering. `chatRepo.pin(userId, chatId, rankOwners)` ranks among `rankOwners`. `chatRepo.hasContent(chatId)` (any message or `chat_files` row) gates `chatRepo.reassignOwner(chatId, from, to, conductorAgentIds)`, which moves the chat row and its generated conductor `agents` rows in one transaction; nothing else is keyed by the chat owner while a chat is empty.

All other tables (`llm_providers`, `mcp_providers`, `chat_modes`, `agents`, `chats`, `messages`, `a2a_sessions`, `users`) are unchanged structurally. The behavioral change is which scope the `user_id` column is filtered/written by — see `src/main/db/schema.ts`.

## IPC Channels

- `agent:list` — returns local agents from Default scope + remote agents from Profile scope, with `enabled` overlaid from overrides.
- `agent:upsert` — Default scope only; rejects remote ids.
- `agent:delete` — Default scope only; remote agents return inline `remote_immutable` error.
- `agent:set-enabled` — payload `{ agentId, enabled }`. Routes by id prefix (`remote:` → override table, else local row).
- `agent:sync-remote` — Profile scope (active Cinna user).
- `agent:list-shortcuts` / `agent:set-shortcut` — Profile scope for the binding; `set-shortcut` resolves the agent through `findAgent(default, profile, id)`, so a local agent can be bound too.
- `chatmode:*`, `provider:*`, `mcp:*` — all Default scope.
- `chat:*`, `agent-status:*`, `run:start` / `run:watch`, `auth:get-current` — Profile scope, with chats resolved through `auth/chatScope.ts` (own chats, plus guest-owned ones while sharing is on).

## Services & Key Methods

- `src/main/services/agentService.ts:listMerged(defaultUserId, profileUserId)` — merges local default rows with profile remote rows, overlays each remote row's `enabled` from `agentOverrideRepo.listForUser(profileUserId)`.
- `src/main/services/agentService.ts:findAgent(defaultUserId, profileUserId, agentId)` — id-prefix routing: `remote:*` looks up under profile, else under default. Returns `{ row, userId }` so callers know which scope to use for subsequent service calls.
- `src/main/services/agentService.ts:setEnabled(defaultUserId, profileUserId, agentId, enabled)` — verifies the row exists, then either updates the agent row (Default) or writes the override (Profile). Logs `agent enabled flag set` with `{ agentId, enabled, scope }`.
- `src/main/db/agents.ts` — `agentOverrideRepo.set(userId, agentId, enabled)` upsert helper; no ownership check (service is responsible).
- `src/main/auth/reload.ts:reloadUserProviders()` — clears adapter registry + MCP connections, then re-loads Default-scope `llm_providers` and `mcp_providers`.

## Renderer Components

- `Sidebar` (`src/renderer/src/components/layout/Sidebar.tsx`) — renders the two-group menu, holds the stale-tab guard `useEffect`.
- `SettingsPage` (`src/renderer/src/components/settings/SettingsPage.tsx`) — title map + section routing per `settingsTab`.
- `AgentsSettingsSection` (`src/renderer/src/components/settings/AgentsSettingsSection.tsx`) — lists only profile-owned Cinna agents, with visibility controls, sync and reauthentication. Direct connections use the Agents sidebar and `ExternalAgentPage`.
- `AgentCard` (`src/renderer/src/components/settings/AgentCard.tsx`) — structured connection fields, authentication and testing for A2A pages; header actions live in `ExternalAgentActionsMenu`.

### Local Development ownership

`SettingsMenu` and `PROFILE_SCOPE_TABS` include `profile-local-dev`; `Sidebar` exposes it only for the Cinna profile group. `SettingsPage` routes that tab to `ProfileLocalDevSettingsSection`, keyed by active account ID. Default `local-dev` routes to `LocalDevSettingsSection` for shared managed tools, Developer Tools and the OpenCode override.

`src/shared/localDevState.ts` keeps `ManagedLocalDevCli` separate from active-profile `LocalDevState`. `localdev:get-managed-cli` is read-only and ungated; `localdev:add-to-path` requires activation but not workspace readiness. The existing `localDevConsent` app-setting JSON remains installation-wide and keyed by host, including declines; no table or migration makes it per-user. Every activation clears local-dev state synchronously; queued reconciles and renderer replies retain profile/generation ownership. See [Local Development technical details](../../agents/local_dev/local_dev_tech.md).

## Configuration

`showLocalDataInAllProfiles` is installation-wide (`src/shared/appSettings.ts`, `src/main/db/appSettings.ts`), defaults to true, and is read through `localDataInAllProfiles()` on each lookup — only when the chat is not the profile's own, so the common path stays one read. Edited in Settings → Features → Interface.

`showAgentSidebarSections` is installation-wide (`src/shared/appSettings.ts`, `src/main/db/appSettings.ts`), defaults to true, and is independent of profile resource ownership. No new environment variables.

## Security

- Default scope is shared by design — anyone with access to the OS user account sees the same settings regardless of which profile they sign into. This is the intended model; private credentials belonging to a specific profile (e.g. Cinna JWTs) stay strictly in Profile scope.
- API keys and OAuth tokens remain encrypted via `src/main/security/keystore.ts` regardless of scope; only the row's `user_id` column changed semantics.
- `agent_overrides` rows contain no secrets, only a boolean and timestamps.
- Sharing is one-way: a signed-in profile sees guest-owned chats, never another profile's, and the guest profile sees only its own. A password-protected profile's chats stay behind its password; a chat made with its account's agents, modes or credentials is kept in it. Anything made while signed out is readable from every profile while sharing is on.

## Tests

- `src/main/auth/chatScope.test.ts` — with sharing on: guest chats (live or trashed) visible as the guest's, other profiles' chats not, the guest never seeing a profile's; with it off, each profile only its own.
- `src/main/services/chatService.sharedChats.test.ts` — merged list order; rename/trash/restore/empty trash of a shared chat writing as the guest; Pinned ranked across both owners; a new chat's owner from local versus account agents, a human chat with an account agent attached, the chat mode (conductor made under the owner, moved by a rebinding while empty), the credential, the effective default mode; no move once something was said; no move with sharing off or in the guest profile; handover origin with sharing on and off.
- `src/main/ipc/run.routing.test.ts`, `runQueueService.test.ts`, `taskRunnerService.test.ts`, `managedAgentService.test.ts`, `agent_a2a.answerRequest.test.ts` — updated for owner-keyed live runs, queues, conductor binding and checkpoints.
