# Account-Provisioned Providers & Chat Modes — Technical

Implementation reference for [Account Provisioning](account_provisioning.md). The
feature mirrors the [Remote Agents](../../agents/remote_agents/remote_agents.md)
sync pattern: a profile-scoped, sync-owned, read-only resource fetched from
cinna-core on Cinna-user activation and every 5 minutes.

## File Locations

### Main process — data
- `src/main/db/schema.ts` — `llmProviders` (`baseUrl`, `availableModels`,
  `managed`, `adminManaged`, `unsupported` columns), `chatModes` (`managed`,
  `adminManaged`), and the `managedOverrides` table (`enabled` + nullable `modelId`
  for the per-mode model override).
- `src/main/db/migrations/account-config.ts` — `migrateAccountConfig()`: ALTERs for
  the new columns + `CREATE TABLE managed_overrides` + an ALTER adding
  `managed_overrides.model_id`. Registered in `src/main/db/client.ts`
  `runMigrations()` (after chat-modes, before agents).
- `src/main/db/managedOverrides.ts` — `managedOverrideRepo` (`map` → returns
  `{enabled, modelId}` per resource, `set` (enable flag), `setModel` (model
  override), `isEnabled`, `getModel` (single-row model lookup used by
  `findMerged`), `deleteForUser`); `set`/`setModel` write independently so one
  preference never clobbers the other.
- `src/main/db/llmProviders.ts` — `listByUserIds()`, `listManaged()`, and `upsert()`
  gained `baseUrl` / `managed` / `adminManaged` / `createIfMissing`.
- `src/main/db/chatModes.ts` — `listByUserIds()`, `listManaged()`; `insert()` now
  honors a caller-provided id (deterministic `managed-mode:` ids).
- `src/main/db/users.ts` — `deleteWithCascade()` also clears `managed_overrides`.
- `src/main/db/appSettings.ts` — `DEFAULTS.prioritizeAccountDefaults = false`.

### Main process — LLM + sync
- `src/main/llm/accountConfigTypes.ts` — wire contract (`AccountConfigResponse`,
  `AccountConfigProvider`, incl. the optional `credential_name` and the optional
  `default_model` — the admin-curated authoritative default), deterministic-id
  helpers (`managedProviderId`, `managedModeId`, `isManagedProviderId`,
  `isManagedModeId`), type mapping (`mapToDesktopProviderType`),
  `colorPresetForType`, and `managedDisplayName` (appends `credential_name` to the
  provider-family name to disambiguate same-provider credentials).
- `src/shared/modelDefaults.ts` — `pickDefaultModelId` now prefers
  chat-capable + non-gated ids; `isChatCapableModelId` (new) filters non-chat
  families (embeddings/tts/audio/image/moderation) for both the auto-default and
  the managed model picker.
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
- `src/main/services/chatModeService.ts` — `listMerged()` / `findMerged()` overlay
  both the `enabled` flag and the `model_id` override onto managed modes;
  `resolveEffectiveDefault()`, `setManagedEnabled()`, `setManagedModel()`;
  `read_only` guards.
- `src/main/services/aiFunctionsService.ts` — `tryResolve()` and the chat-mode
  candidate builders are managed-aware (scope union + `baseUrl` + effective default).
- `src/main/ipc/provider.ipc.ts`, `src/main/ipc/chatmode.ipc.ts` — handlers (below).
- `src/main/errors.ts` — `read_only` added to `ProviderErrorCode` / `ChatModeErrorCode`.

### Shared
- `src/shared/chatModeDefaults.ts` — `resolveDefaultModeId(modes, prioritizeAccount)`.
- `src/shared/modelDefaults.ts` — `pickDefaultModelId(ids)` (chat-capable +
  non-gated preference), `isChatCapableModelId(id)`, `isDefaultEligibleModelId(id)`.
- `src/shared/appSettings.ts` — `AppSettingsSchema.prioritizeAccountDefaults`.

### Preload
- `src/preload/index.ts` — `providers.syncAccountConfig`,
  `providers.onAccountConfigSynced`, `chatModes.setManagedEnabled`,
  `chatModes.setManagedModel`, `providers.fetchModels`; `ProviderData` gains
  `managed`/`adminManaged`/`unsupported`; `ChatModeData` gains
  `managed`/`adminManaged`/`enabled`.

### Renderer
- `src/renderer/src/hooks/useProviders.ts` — `onAccountConfigSynced` subscription,
  `useSyncAccountConfig()`.
- `src/renderer/src/hooks/useModels.ts` — `useModels()` (aggregate) +
  `useProviderModels(providerId, enabled)` (on-demand live per-provider fetch).
- `src/renderer/src/hooks/useChatModes.ts` — subscription, `useDefaultChatMode()`
  (uses the shared resolver + `prioritizeAccountDefaults`),
  `useSetManagedChatModeEnabled()`, `useSetManagedChatModeModel()`.
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
  `suggested_models`), `managed` (bool, default 0), `admin_managed` (bool, default 0),
  `unsupported` (bool, default 0; managed credential unusable for API calls — e.g.
  an anthropic `sk-ant-oat` token — shown with a "Not supported" badge, no adapter,
  no chat mode).
- `chat_modes` — `managed` (bool, default 0), `admin_managed` (bool, default 0).
- `managed_overrides` — `(user_id, kind, resource_id, enabled, model_id,
  updated_at)`, PK `(user_id, kind, resource_id)`. `kind` ∈ `provider` | `mode`
  (only `mode` is written today). `model_id` (text, null) is the per-mode model
  override; null = use the synced default. No FK / cascade vs the managed rows —
  survives re-sync. Mirrors `agent_overrides`.

Managed rows are stored under the **active profile user id** (not `__default__`);
deterministic ids are `managed:{credentialId}` and `managed-mode:{credentialId}`.

## IPC Channels

- `provider:list` — returns `providerService.listMerged()` (Default ∪ Profile-managed).
- `provider:fetch-models` — `providerService.fetchModels(id)`: live, scope-aware
  per-provider model fetch (works for managed providers); throws on failure so the
  renderer query can show loading/retry.
- `provider:sync-account-config` — `runAccountConfigSyncOnce(getProfileScopeUserId())`.
- `chatmode:list` — `chatModeService.listMerged()` (enabled overlay; `isDefault` raw).
- `chatmode:get` — `chatModeService.findMerged(id)` (managed-aware lookup).
- `chatmode:set-managed-enabled` — `{ id, enabled }` → `setManagedEnabled` + broadcast.
- `chatmode:set-managed-model` — `{ id, modelId }` (`modelId` null clears the
  override) → `setManagedModel` + broadcast.
- Broadcast `providers:account-config-synced` (`{ error? }`) — emitted by the runner
  on every sync (activation, 5-min tick, manual sync, mode toggle); preload exposes
  `providers.onAccountConfigSynced`.

All handlers call `userActivation.requireActivated()` first.

## Services & Key Methods

- `accountConfigService.syncAccountConfig(userId)` — guards `cinna_user` +
  `cinnaServerUrl`, `getCinnaAccessToken`, `net.fetch` the endpoint (timed; body
  never logged), maps each provider type, upserts managed provider + mode, registers
  adapters, prunes stale rows. The seed default model resolves
  `default_model` → (`openai_compatible`) gateway `model` → `pickDefaultModelId` →
  the auto-resolved `model` **only if chat-capable** (its catalog-default branch is
  a valid last resort; its `discovered_models[0]` branch — e.g. an embedding — is
  filtered out by `isChatCapableModelId`). Anthropic `sk-ant-oat` tokens upsert a
  provider row with `unsupported: true` (no adapter, no mode; mode left unseen so a
  stale one prunes). Each credential is marked *seen* before its upsert
  and the upsert is wrapped in try/catch, so a single bad descriptor can't abort
  the sync (and skip the prune) or get itself wrongly pruned on a transient error;
  the prune then runs unconditionally on a successful fetch. Returns
  `SyncAccountConfigResult` (`{ providers, modes, removed, skipped, unsupported,
  failed }` — `unsupported` counts kept-but-badged OAuth-token rows separately
  from `skipped`).
  Throws `CinnaApiError('request_failed')` on non-OK; `CinnaReauthRequired` propagates.
- `accountConfigService.loadManagedAdapters(profileUserId)` — registers already-synced
  managed adapters on activation (offline readiness).
- `chatModeService.resolveEffectiveDefault()` — reads `prioritizeAccountDefaults`,
  calls `resolveDefaultModeId` over `listMerged()`.
- `providerService.listMerged()` / `chatModeService.listMerged()` — union via
  `getManagedResourceScopes()`; the mode list overlays effective `enabled` AND the
  `model_id` override from `managedOverrideRepo` onto managed modes (`findMerged`
  applies the model overlay too, so chat start uses the chosen model).
- `chatModeService.setManagedModel(id, modelId)` — writes the per-mode model
  override (`managedOverrideRepo.setModel`, `kind='mode'`); null clears it.
- `providerService.listModels()` — for managed providers emits a
  guaranteed-non-empty list: the curated `availableModels` when present
  (admin-ordered, replaces the adapter list), otherwise the adapter's live list —
  always with the resolved `defaultModelId` prepended so the default stays
  selectable when the live `models.list()`/gateway call is empty or fails (OAuth/
  restricted keys). Unknown ids are synthesized; ids deduped. Non-managed (local)
  providers pass through `registry.getAllModels()` unchanged.
- `providerService.fetchModels(providerId)` — on-demand LIVE model fetch for one
  provider, scope-aware (`getManagedResourceScopes()` → reaches managed rows in
  Profile scope, unlike Default-scoped `test()`), decrypting the row's key and
  calling `adapter.listModels()`. Backs the picker's empty-registry fallback. On
  adapter failure it runs `adapter.parseError` and throws
  `ProviderError('list_models_failed', short, detail)` so the renderer shows the
  provider's real error (e.g. "invalid x-api-key"), not a generic message.

## Renderer Components

- `ProfileLLMSection` / `ProfileChatModesSection` — Profile-group Settings panels;
  filter `useProviders`/`useChatModes` to `managed` rows; empty states; LLM panel has
  a Sync button (`useSyncAccountConfig`).
- `ManagedProviderCard` — read-only (no toggle); shield/cloud badge by
  `adminManaged`; a red "Not supported" badge + muted status dot when
  `unsupported` (anthropic `sk-ant-oat` token).
- `ManagedChatModeCard` — read-only content + two local overrides: the
  enable/disable toggle in the header (`useSetManagedChatModeEnabled`) and, in an
  `AnimatedCollapse` expand panel (mirroring `ChatModeCard`), a **model picker**
  (`useSetManagedChatModeModel`) listing the credential's chat-capable models
  (`useModels` filtered by `providerId` + `isChatCapableModelId`, current selection
  always kept visible); when the registry has no models it falls back to a live
  per-provider fetch (`useProviderModels` → `provider:fetch-models`) with
  loading / error (provider's parsed message + raw detail) / retry states;
  default star from raw `isDefault`.
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
