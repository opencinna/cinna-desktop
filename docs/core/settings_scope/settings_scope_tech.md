# Settings Scope — Technical

## File Locations

### Shared
- `src/shared/userIds.ts` — `DEFAULT_USER_ID = '__default__'`. Imported by both main and renderer; no other hardcoded literals should appear.

### Main process
- `src/main/auth/scope.ts` — `DEFAULT_SCOPE_USER_ID`, `getSettingsScopeUserId()`, `getProfileScopeUserId()`, `getAgentLookupScope()`.
- `src/main/auth/session.ts` — `getCurrentUserId()` primitive; consumed only by `scope.ts` and the session-identity check in `authService`.
- `src/main/auth/reload.ts` — `reloadUserProviders()` now loads via `getSettingsScopeUserId()` so the LLM + MCP set is identical across profiles.
- `src/main/auth/activation.ts` — `userActivation.activate(userId)` calls `reloadUserProviders()` (Default scope) and starts `runSyncOnce(userId)` / `startPeriodicSync(userId)` for Cinna users (Profile scope).
- `src/main/db/agents.ts` — `agentOverrideRepo.{listForUser, get, set}`; `agentRepo` unchanged.
- `src/main/db/users.ts` — `deleteWithCascade(id)` includes `agent_overrides` in the same transaction as the other Profile-scope deletions.
- `src/main/db/schema.ts` — `agentOverrides` table; composite primary key `(userId, agentId)`.
- `src/main/db/migrations/agent-overrides.ts` — table creation with documented absence of FK/cascade.
- `src/main/services/agentService.ts` — `listMerged()`, `findAgent()`, `setEnabled()`. `agentService.list(userId)` removed.
- `src/main/ipc/agent.ipc.ts` — `agent:list` calls `listMerged`; `agent:upsert` / `agent:delete` target Default scope; `agent:sync-remote` targets Profile scope; new `agent:set-enabled` channel.
- `src/main/ipc/agent_a2a.ipc.ts` — all agent lookups via `agentService.findAgent(default, profile, id)`.
- `src/main/ipc/chatmode.ipc.ts`, `provider.ipc.ts`, `mcp.ipc.ts` — all use `getSettingsScopeUserId()`.
- `src/main/ipc/chat.ipc.ts`, `agent_status.ipc.ts`, `llm.ipc.ts`, `auth.ipc.ts` (`auth:get-current`) — use `getProfileScopeUserId()`.

### Preload
- `src/preload/index.ts` — `window.api.agents.setEnabled(agentId, enabled)`.

### Renderer
- `src/renderer/src/stores/ui.store.ts` — `SettingsMenu` includes `'profile-agents'`; `PROFILE_SCOPE_TABS` constant lists Profile-only tabs.
- `src/renderer/src/components/layout/Sidebar.tsx` — renders Default + conditional Profile groups; auto-resets `settingsTab` via `useEffect` when Profile group disappears.
- `src/renderer/src/components/settings/SettingsPage.tsx` — routes `'profile-agents'` to `<AgentsSettingsSection scope="profile" />`.
- `src/renderer/src/components/settings/AgentsSettingsSection.tsx` — `scope: 'default' | 'profile'` prop; `DefaultAgentsSection` shows only local A2A agents, `ProfileAgentsSection` shows only Cinna-synced remote agents.
- `src/renderer/src/components/settings/AgentCard.tsx` — toggle calls `useSetAgentEnabled` (optimistic), surfaces mutation error via `title` + danger ring.
- `src/renderer/src/hooks/useAgents.ts` — `useSetAgentEnabled()` with optimistic update, rollback `onError`, refetch `onSettled`.

## Database Schema

- `agent_overrides` (migration: `src/main/db/migrations/agent-overrides.ts`)
  - Composite PK `(user_id, agent_id)`
  - Columns: `enabled` (bool), `updated_at` (int)
  - No FK to `agents.id` — overrides intentionally survive a sync remove+re-add cycle. Per-user cleanup happens in `userRepo.deleteWithCascade`.

All other tables (`llm_providers`, `mcp_providers`, `chat_modes`, `agents`, `chats`, `messages`, `a2a_sessions`, `users`) are unchanged structurally. The behavioral change is which scope the `user_id` column is filtered/written by — see `src/main/db/schema.ts`.

## IPC Channels

- `agent:list` — returns local agents from Default scope + remote agents from Profile scope, with `enabled` overlaid from overrides.
- `agent:upsert` — Default scope only; rejects remote ids.
- `agent:delete` — Default scope only; remote agents return inline `remote_immutable` error.
- `agent:set-enabled` — new channel; payload `{ agentId, enabled }`. Routes by id prefix (`remote:` → override table, else local row).
- `agent:sync-remote` — Profile scope (active Cinna user).
- `chatmode:*`, `provider:*`, `mcp:*` — all Default scope.
- `chat:*`, `agent-status:*`, `llm:send-message`, `auth:get-current` — Profile scope.

## Services & Key Methods

- `src/main/services/agentService.ts:listMerged(defaultUserId, profileUserId)` — merges local default rows with profile remote rows, overlays each remote row's `enabled` from `agentOverrideRepo.listForUser(profileUserId)`.
- `src/main/services/agentService.ts:findAgent(defaultUserId, profileUserId, agentId)` — id-prefix routing: `remote:*` looks up under profile, else under default. Returns `{ row, userId }` so callers know which scope to use for subsequent service calls.
- `src/main/services/agentService.ts:setEnabled(defaultUserId, profileUserId, agentId, enabled)` — verifies the row exists, then either updates the agent row (Default) or writes the override (Profile). Logs `agent enabled flag set` with `{ agentId, enabled, scope }`.
- `src/main/db/agents.ts` — `agentOverrideRepo.set(userId, agentId, enabled)` upsert helper; no ownership check (service is responsible).
- `src/main/auth/reload.ts:reloadUserProviders()` — clears adapter registry + MCP connections, then re-loads Default-scope `llm_providers` and `mcp_providers`.

## Renderer Components

- `Sidebar` (`src/renderer/src/components/layout/Sidebar.tsx`) — renders the two-group menu, holds the stale-tab guard `useEffect`.
- `SettingsPage` (`src/renderer/src/components/settings/SettingsPage.tsx`) — title map + section routing per `settingsTab`.
- `AgentsSettingsSection` (`src/renderer/src/components/settings/AgentsSettingsSection.tsx`) — switches between `DefaultAgentsSection` and `ProfileAgentsSection` based on `scope` prop.
- `AgentCard` (`src/renderer/src/components/settings/AgentCard.tsx`) — toggle + error surface (red ring + tooltip on mutation error).

## Configuration

No new env vars or settings. The model is purely behavioral.

## Security

- Default scope is shared by design — anyone with access to the OS user account sees the same settings regardless of which profile they sign into. This is the intended model; private credentials belonging to a specific profile (e.g. Cinna JWTs) stay strictly in Profile scope.
- API keys and OAuth tokens remain encrypted via `src/main/security/keystore.ts` regardless of scope; only the row's `user_id` column changed semantics.
- `agent_overrides` rows contain no secrets, only a boolean and timestamps.
