# Account-Provisioned Providers & Chat Modes — Technical

Implementation reference for [Account Provisioning](account_provisioning.md). The
feature mirrors the [Remote Agents](../../agents/remote_agents/remote_agents.md)
sync pattern: a profile-scoped, sync-owned, read-only resource fetched from
cinna-core on Cinna-user activation and every 5 minutes.

## File Locations

### Main process — data
- `src/main/db/schema.ts` — `llmProviders` (`baseUrl`, `availableModels`,
  `managed`, `adminManaged` columns), `chatModes` (`managed`, `adminManaged`), and
  the new `managedOverrides` table.
- `src/main/db/migrations/account-config.ts` — `migrateAccountConfig()`: ALTERs for
  the new columns + `CREATE TABLE managed_overrides`. Registered in
  `src/main/db/client.ts` `runMigrations()` (after chat-modes, before agents).
- `src/main/db/managedOverrides.ts` — `managedOverrideRepo` (`map`, `set`,
  `isEnabled`, `deleteForUser`).
- `src/main/db/llmProviders.ts` — `listByUserIds()`, `listManaged()`, and `upsert()`
  gained `baseUrl` / `managed` / `adminManaged` / `createIfMissing`.
- `src/main/db/chatModes.ts` — `listByUserIds()`, `listManaged()`; `insert()` now
  honors a caller-provided id (deterministic `managed-mode:` ids).
- `src/main/db/users.ts` — `deleteWithCascade()` also clears `managed_overrides`.
- `src/main/db/appSettings.ts` — `DEFAULTS.prioritizeAccountDefaults = false`.

### Main process — LLM + sync
- `src/main/llm/accountConfigTypes.ts` — wire contract (`AccountConfigResponse`,
  `AccountConfigProvider`), deterministic-id helpers (`managedProviderId`,
  `managedModeId`, `isManagedProviderId`, `isManagedModeId`), type mapping
  (`mapToDesktopProviderType`), `colorPresetForType`.
- `src/main/llm/factory.ts` — `ProviderType` gains `openai_compatible`;
  `createAdapter()` takes `CreateAdapterOptions` (`baseUrl`, `fallbackModels`).
- `src/main/llm/openai.ts` — `OpenAIAdapter` accepts `OpenAIAdapterOptions`
  (`baseURL`, `fallbackModels`); resilient `listModels()` for gateways.
- `src/main/services/accountConfigService.ts` — `syncAccountConfig(userId)` (fetch
  + upsert + adapter register + prune) and `loadManagedAdapters(profileUserId)`.
- `src/main/services/account-config-sync.ts` — periodic runner
  (`runAccountConfigSyncOnce`, `startAccountConfigPeriodicSync`,
  `stopAccountConfigPeriodicSync`, `notifyAccountConfigSynced`).
- `src/main/auth/activation.ts` — `_startRemoteSync()` also runs/starts account-config
  sync for Cinna users; `deactivate()` stops it.
- `src/main/auth/reload.ts` — `reloadUserProviders()` also calls
  `loadManagedAdapters()` for the active profile.
- `src/main/auth/scope.ts` — `getManagedResourceScopes()` (Default ∪ active Profile).

### Main process — services + IPC
- `src/main/services/providerService.ts` — `listMerged()`; `listModels()` overlays
  each managed provider's curated `availableModels` over the adapter list;
  `read_only` guards in `upsert`/`delete`.
- `src/main/services/chatModeService.ts` — `listMerged()`, `findMerged()`,
  `resolveEffectiveDefault()`, `setManagedEnabled()`; `read_only` guards.
- `src/main/services/aiFunctionsService.ts` — `tryResolve()` and the chat-mode
  candidate builders are managed-aware (scope union + `baseUrl` + effective default).
- `src/main/ipc/provider.ipc.ts`, `src/main/ipc/chatmode.ipc.ts` — handlers (below).
- `src/main/errors.ts` — `read_only` added to `ProviderErrorCode` / `ChatModeErrorCode`.

### Shared
- `src/shared/chatModeDefaults.ts` — `resolveDefaultModeId(modes, prioritizeAccount)`.
- `src/shared/modelDefaults.ts` — `pickDefaultModelId(ids)` / `isDefaultEligibleModelId`.
- `src/shared/appSettings.ts` — `AppSettingsSchema.prioritizeAccountDefaults`.

### Preload
- `src/preload/index.ts` — `providers.syncAccountConfig`,
  `providers.onAccountConfigSynced`, `chatModes.setManagedEnabled`; `ProviderData`
  gains `managed`/`adminManaged`; `ChatModeData` gains `managed`/`adminManaged`/`enabled`.

### Renderer
- `src/renderer/src/hooks/useProviders.ts` — `onAccountConfigSynced` subscription,
  `useSyncAccountConfig()`.
- `src/renderer/src/hooks/useChatModes.ts` — subscription, `useDefaultChatMode()`
  (uses the shared resolver + `prioritizeAccountDefaults`), `useSetManagedChatModeEnabled()`.
- `src/renderer/src/hooks/useNewChatFlow.ts` — `resolveModel()` empty-model fallback
  via `pickDefaultModelId`.
- `src/renderer/src/hooks/useJobs.ts` — job run default-mode resolution via the shared
  resolvers.
- `src/renderer/src/components/settings/ProfileLLMSection.tsx`,
  `ProfileChatModesSection.tsx`, `ManagedProviderCard.tsx`, `ManagedChatModeCard.tsx`.
- `src/renderer/src/components/settings/SettingsPage.tsx` (routes `profile-llm` /
  `profile-chats`), `LLMSettingsSection.tsx` / `ChatModesSection.tsx` (filter to
  non-managed), `FeaturesSettingsSection.tsx` (precedence toggle).
- `src/renderer/src/components/layout/Sidebar.tsx` (Profile-group menu items),
  `MainArea.tsx` (derived `modeSelection` → `activeMode`).
- `src/renderer/src/stores/ui.store.ts` — `SettingsMenu` adds `profile-llm` /
  `profile-chats`; both added to `PROFILE_SCOPE_TABS`.

## Database Schema

See `src/main/db/migrations/account-config.ts`.

- `llm_providers` — `base_url` (text, null; `openai_compatible` endpoint),
  `available_models` (text/JSON array, null; curated picker list = account-config
  `suggested_models`), `managed` (bool, default 0), `admin_managed` (bool, default 0).
- `chat_modes` — `managed` (bool, default 0), `admin_managed` (bool, default 0).
- `managed_overrides` — `(user_id, kind, resource_id, enabled, updated_at)`, PK
  `(user_id, kind, resource_id)`. `kind` ∈ `provider` | `mode` (only `mode` is
  written today). No FK / cascade vs the managed rows — survives re-sync. Mirrors
  `agent_overrides`.

Managed rows are stored under the **active profile user id** (not `__default__`);
deterministic ids are `managed:{credentialId}` and `managed-mode:{credentialId}`.

## IPC Channels

- `provider:list` — returns `providerService.listMerged()` (Default ∪ Profile-managed).
- `provider:sync-account-config` — `runAccountConfigSyncOnce(getProfileScopeUserId())`.
- `chatmode:list` — `chatModeService.listMerged()` (enabled overlay; `isDefault` raw).
- `chatmode:get` — `chatModeService.findMerged(id)` (managed-aware lookup).
- `chatmode:set-managed-enabled` — `{ id, enabled }` → `setManagedEnabled` + broadcast.
- Broadcast `providers:account-config-synced` (`{ error? }`) — emitted by the runner
  on every sync (activation, 5-min tick, manual sync, mode toggle); preload exposes
  `providers.onAccountConfigSynced`.

All handlers call `userActivation.requireActivated()` first.

## Services & Key Methods

- `accountConfigService.syncAccountConfig(userId)` — guards `cinna_user` +
  `cinnaServerUrl`, `getCinnaAccessToken`, `net.fetch` the endpoint (timed; body
  never logged), maps each provider type, upserts managed provider + mode, registers
  adapters, prunes stale rows. Each credential is marked *seen* before its upsert
  and the upsert is wrapped in try/catch, so a single bad descriptor can't abort
  the sync (and skip the prune) or get itself wrongly pruned on a transient error;
  the prune then runs unconditionally on a successful fetch. Returns
  `SyncAccountConfigResult` (`{ providers, modes, removed, skipped, failed }`).
  Throws `CinnaApiError('request_failed')` on non-OK; `CinnaReauthRequired` propagates.
- `accountConfigService.loadManagedAdapters(profileUserId)` — registers already-synced
  managed adapters on activation (offline readiness).
- `chatModeService.resolveEffectiveDefault()` — reads `prioritizeAccountDefaults`,
  calls `resolveDefaultModeId` over `listMerged()`.
- `providerService.listMerged()` / `chatModeService.listMerged()` — union via
  `getManagedResourceScopes()`; mode list overlays effective `enabled` from
  `managedOverrideRepo`.
- `providerService.listModels()` — for managed providers with a non-empty
  `availableModels`, emits that admin-ordered curated list (default model always
  included, unknown ids synthesized) in place of the adapter list; other providers
  pass through `registry.getAllModels()` unchanged.

## Renderer Components

- `ProfileLLMSection` / `ProfileChatModesSection` — Profile-group Settings panels;
  filter `useProviders`/`useChatModes` to `managed` rows; empty states; LLM panel has
  a Sync button (`useSyncAccountConfig`).
- `ManagedProviderCard` — read-only (no toggle); shield/cloud badge by `adminManaged`.
- `ManagedChatModeCard` — read-only content + local enable/disable toggle
  (`useSetManagedChatModeEnabled`); default star from raw `isDefault`.
- `FeaturesSettingsSection` — AI Functions group; the
  "Prioritize 'Account' defaults over default profile" toggle.

## Configuration

- App setting `prioritizeAccountDefaults` (`app_settings`, default `false`) — flips
  local-vs-account default-mode precedence. Read in main
  (`appSettingsRepo.get`) and renderer (`useAppSettings`).
- Periodic sync interval: 5 minutes (`account-config-sync.ts`).

## Security

- Decrypted `api_key` from the endpoint is re-encrypted immediately via
  `src/main/security/keystore.ts` `encryptApiKey()` (safeStorage); never logged and
  never sent to the renderer (`hasApiKey`/`managed`/`adminManaged` only).
- Endpoint is desktop-token-gated server-side (the desktop JWT carries
  `client_kind=desktop`); see [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md).
- Managed rows are read-only for the user: Default-scope write paths can't see
  profile-scoped rows, and explicit `read_only` guards in
  `providerService`/`chatModeService` reject `managed:` / `managed-mode:` ids.
- Reads are profile-scoped via `getManagedResourceScopes()`; a guest / non-Cinna
  profile sees no managed rows.
