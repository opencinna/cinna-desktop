# Account-Provisioned Providers & Chat Modes

## Purpose

Deliver a **"ready on login"** experience for Cinna users: when a company DevOps
admin provisions AI credentials centrally on cinna-core, the desktop app
auto-materializes matching **LLM providers** and a **default chat mode per
credential** the moment the user signs in — no manual key entry, no Settings
detour. The user logs in and can immediately chat with the LLM (and, combined
with [Remote Agents](../../agents/remote_agents/remote_agents.md) + the
[Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md), with agents).

> **UI naming note:** What this doc calls **"LLM providers"** is labeled **"AI Credentials"** in the UI (sidebar section, page title) — the canonical/technical name stays "LLM Provider", "AI Credentials" is the friendlier user-facing label that matches the cinna-core term. See the glossary in [docs/README.md](../../README.md#glossary).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Managed Provider** | An LLM provider auto-created from a Cinna account-config descriptor (`managed = true`). Profile-scoped, sync-owned, read-only in the user's UI. Deterministic id `managed:{credentialId}`. |
| **Managed Chat Mode** | A default chat mode auto-created per managed credential (`managed = true`). Deterministic id `managed-mode:{credentialId}`. Bound to its managed provider. |
| **Account Config Sync** | The process that fetches the user's provider bundle from cinna-core's `GET /api/v1/external/account-config` and upserts managed providers/modes into Profile scope — mirrors [Remote Agents](../../agents/remote_agents/remote_agents.md) sync. |
| **Account-Config Endpoint** | cinna-core native endpoint returning, per usable AI credential, a descriptor **including the decrypted `api_key`**, the resolved default, and a chat-mode label. Desktop/mobile-token-gated on the server. |
| **Managed Override** | Per-profile local preferences for a managed **chat mode** (`managed_overrides` table, `kind='mode'`): the enable/disable flag **and** a `model_id` choice that overrides the synced default model. Sync never writes the table, so both survive re-sync — mirrors [Agent Override](../../core/settings_scope/settings_scope.md). Managed *providers* have no toggle — they're always active. |
| **Unsupported Credential** | A managed credential that exists but can't make API calls in the app (today: an Anthropic OAuth token, key prefix `sk-ant-oat`, valid for the Claude apps but not the Messages API). Materialized as a provider row (`llm_providers.unsupported = true`) so it shows in the list with a "Not supported" badge, but gets no adapter and no chat mode. |

## User Stories / Flows

### Ready on login

1. Admin provisions an Anthropic (and/or OpenAI/Gemini/OpenAI-compatible)
   credential **for** the user on cinna-core.
2. User signs in to the desktop app with their Cinna account → activation starts
   the usual remote-agent sync **and** account-config sync.
3. Account-config sync fetches the bundle, re-encrypts each `api_key` locally
   (safeStorage), and upserts a managed provider + a default managed chat mode
   per credential into Profile scope; the matching adapters register immediately.
4. The renderer's `useProviders` / `useChatModes` refetch on the
   `providers:account-config-synced` broadcast. The managed default mode is
   pre-applied on the new-chat screen — the user types and sends right away.

### Offline / immediate availability

On every activation, already-synced managed providers are loaded into the adapter
registry **before** the network sync completes (`accountConfigService.loadManagedAdapters`),
so a returning user is ready even before (or without) a fresh fetch.

### Locally disabling a managed provider/mode

1. Managed providers/modes live under the Settings **Profile {name}** group — its
   own "LLM Providers" and "Chats" entries, mirroring the Default group's names
   and ordering (the same way Remote Agents sit beside local agents).
2. The user toggles a managed provider/mode off. A row is written to `managed_overrides`
   keyed by `(profileUserId, kind, resourceId)`; the provider's adapter unloads,
   the mode drops out of the composer picker.
3. The choice survives subsequent syncs and app restarts (sync never touches the
   overrides table). The synced row content is never editable/deletable.

### Choosing a model for a managed credential

1. A managed chat mode opens with the synced default model (see *Default model
   selection*). The user expands its card in Settings → Profile → Chats and picks
   a different model from the dropdown (chat-capable models only).
2. The choice is stored locally in `managed_overrides.model_id` and overlays the
   mode's model everywhere it's used (composer, chat start, AI functions). It
   survives re-sync; picking again changes it.
3. When the credential exposes no model list (server sent none and the registry is
   empty), the expanded card fetches the list live from the provider using the
   key. If that call fails, the provider's own error (e.g. "invalid x-api-key") is
   shown with a Retry.

### OAuth-token credential (not supported)

1. The user (or admin) provisions an Anthropic credential that is actually a
   Claude-apps OAuth token (`sk-ant-oat…`).
2. Sync materializes it as a provider row shown in the AI-credentials list with a
   **"Not supported"** badge, but creates no adapter and no chat mode — it can't
   make API calls. It's also hidden from the provider picker when building a user
   chat mode.
3. If the credential is later replaced with a real API key, the next sync clears
   the flag and materializes the adapter + default chat mode normally.

### Switching profiles

Managed providers/modes are Profile-scoped, so switching to another profile (or
the guest) hides them and stops the periodic sync; switching back reloads them.

## Business Rules

- **Cinna-only** — sync runs only for `cinna_user` accounts with a valid
  `cinnaServerUrl`, alongside the remote-agent sync (activation + every 5 min).
- **Profile-scoped** — managed rows live under the active profile id and are
  unioned into the Default-scope provider/mode lists via
  `getManagedResourceScopes()`; they surface only while their account is active.
- **Independent defaults + precedence toggle** — Default-profile modes and
  account (managed) modes each keep their own `isDefault` flag (`listMerged` never
  mutates it). One effective default is resolved by `resolveDefaultModeId`
  (`shared/chatModeDefaults.ts`): the **local default wins by default**, with the
  account default applying only when there's no local default. The
  `prioritizeAccountDefaults` setting (Settings → Features → AI Functions, off by
  default) flips precedence so the account default wins. A disabled managed
  default is ignored; when neither side has a default, nothing auto-applies. Both
  the renderer (`useDefaultChatMode`, jobs) and main
  (`chatModeService.resolveEffectiveDefault`) use the same shared resolver.
- **Admin-managed vs own** — the endpoint returns every credential the user
  *owns*, both admin-provisioned (`is_admin_managed = true`) and the user's own
  Cinna-account credentials (`is_admin_managed = false`). Both become read-only
  managed rows on desktop (cinna-core owns their lifecycle); the `adminManaged`
  flag is persisted and surfaced so the cards read "Managed by your
  administrator" (shield) vs "From your Cinna account" (cloud).
- **Read-only content, two local overrides** — the user cannot edit/delete/re-key
  the synced content of managed rows. The Default-scope write paths can't see them
  (scope mismatch), and explicit `read_only` guards in `providerService` /
  `chatModeService` reject managed ids for upsert/delete. The exceptions are the
  two per-profile `managed_overrides` preferences on a managed **chat mode**: the
  enable toggle and the model choice (see below) — neither mutates the synced row.
- **Local enable/disable + model choice on modes** — managed providers are always
  active (registered on sync/activation); they have no standalone on/off because a
  provider is only ever reached through a chat mode (managed or user-built). The
  user-controllable bits both live on the managed **chat mode**
  (`managed_overrides`, `kind='mode'`): the **enable toggle** (gates picker
  visibility + default eligibility) and the **model override** (`model_id` — which
  model the mode uses, see *Per-mode model override*).
- **Unsupported Anthropic OAuth tokens** — an Anthropic credential whose key
  starts with `sk-ant-oat` is a Claude-apps OAuth token, valid for the Claude apps
  but **not** the Messages API, so it can't drive a chat. Such a credential is
  still materialized as a managed provider (so it shows in the AI-credentials
  list, with a **"Not supported"** badge — `llm_providers.unsupported = true`) but
  gets **no adapter** (never registered, including on offline `loadManagedAdapters`)
  and **no auto-created chat mode** (its mode is left *unseen* by the sync so any
  previously-created one is pruned). It's also filtered out of the
  provider picker when building a user chat mode. The provider row is kept (not
  pruned) so it stays visible; flipping the credential to a real key on a later
  sync clears the flag and materializes the adapter + mode normally.
- **Provider type mapping** — `anthropic`→anthropic, `openai`→openai,
  `google`→gemini, `openai_compatible`→openai adapter with a `base_url` (and the
  credential model seeded as a fallback when the gateway has no `/models`).
  `minimax` and unknown types are skipped with a warning (no native adapter) and
  are eligible for pruning — nothing was ever materialized for them. A descriptor
  with an empty `api_key`, or `openai_compatible` without a `base_url`, skips
  *materialization* but is **kept, not pruned**: it's treated as "still
  provisioned, temporarily unusable", so the last-good row survives a transient
  blank rather than disappearing (see *Stale pruning*).
- **Per-credential naming** — cinna-core's `display_name` /
  `default_chat_mode_label` are the provider *family* only ("Claude", "OpenAI",
  "Gemini"), so multiple credentials of one provider would otherwise materialize
  identically-named managed providers and chat modes. The descriptor also carries
  the credential's own free-form `credential_name`; the managed provider and chat
  mode names append it as `"Claude (Work Key)"` (`managedDisplayName`). It's
  appended only when distinct — blank, absent (older servers), or equal to the
  base (e.g. `openai_compatible`, whose `display_name` already *is* the credential
  name) leaves the base unchanged, so single-key setups stay clean ("Claude").
- **Default model selection** — the seed default model for a managed
  mode/provider resolves, in order: (1) the descriptor's **`default_model`** —
  the admin-curated explicit choice on cinna-core, authoritative when present;
  (2) for `openai_compatible` only, the credential's required gateway model
  (`model`); (3) a sane auto-pick from `suggested_models` via
  `pickDefaultModelId` (`shared/modelDefaults.ts`); (4) as a last resort,
  cinna-core's auto-resolved `model` **only when it is chat-capable**. The desktop
  does **not** blindly trust that auto-resolved `model`: its server-side fallback
  chain can land on `discovered_models[0]`, which for an OpenAI key is often a
  non-chat model like `text-embedding-ada-002` — filtered out by
  `isChatCapableModelId`. But when discovery is empty that same field falls back
  to the provider's *catalog default* (a real chat model, and often the only
  signal we have), so keeping it chat-capable-filtered preserves a usable default
  instead of leaving the mode model-less. `pickDefaultModelId` likewise skips both
  **non-chat models** (embeddings/tts/audio/image/moderation) and **access-gated
  tiers** (Anthropic Fable/Mythos — `models.list()` returns those even when the
  account can only see, not call them, so a naive "newest" default would 404).
  Gated/non-chat models stay explicitly selectable for accounts that want them.
- **Per-mode model override** — the synced default is only a default. Each
  managed chat mode card (`ManagedChatModeCard`) expands to a **local, per-profile
  model picker** (mirroring the regular chat-mode edit panel) listing the
  credential's chat-capable models (`providerService.listModels` filtered by
  `isChatCapableModelId`); the chosen id is stored in `managed_overrides.model_id`
  (`kind='mode'`) and **overlays the mode's `modelId`** at read time in
  `chatModeService.listMerged`/`findMerged`. `providerService.listModels` always
  surfaces the provider's synced default (and its curated `availableModels`). When
  the aggregate registry has **no** models for a credential (the server provided
  no list and the background `getAllModels()` came up empty), the expanded card
  fetches the model list **live from the provider API using the credential's key**
  (`providerService.fetchModels` via `useProviderModels`), exactly like a
  default-account provider — with loading / retry states — rather than telling the
  user to wait. On failure the **provider's own error is shown** (e.g. "Invalid
  Anthropic API key" + the raw "invalid x-api-key" detail): `fetchModels` runs the
  adapter's `parseError` and throws a `ProviderError('list_models_failed', short,
  detail)`, whose `code`/`detail` survive the IPC boundary for the card to render.
  Like the enable toggle it survives re-sync, so a user can provision a plain key
  server-side and pick whichever model they want to use with it in the desktop
  app. `null` clears the override (reverts to the synced default). The server's
  `default_model` is currently populated only for managed credentials; support
  for self-created credentials is planned.
- **Curated available models** — when cinna-core returns a non-empty
  `suggested_models` for a credential (the admin's `available_models`, else the
  key's `discovered_models`), it is persisted on the managed provider row
  (`llm_providers.available_models`) and **replaces the adapter's model list in
  the picker** (`providerService.listModels`): the user sees only the offered
  models, in the admin's order. Curated ids the desktop adapter doesn't hardcode
  are synthesized so they stay selectable, and the provider's resolved default
  model is always included. Empty/absent curation falls back to the adapter's live
  list **with the synced default prepended** (so the default is selectable even if
  the live call returns nothing/fails). For `openai_compatible` the list also seeds
  the gateway fallback so an unreachable `/models` still yields the curated picker.
- **Stale pruning** — managed rows for the profile not present in the latest
  response are deleted (admin de-provisioned) and their adapters unregistered.
  Pruning is **decoupled from per-credential materialization**: each descriptor's
  upsert is isolated in try/catch and the credential is marked *seen* before any
  write, so (a) one failing descriptor can't abort the sync and skip the prune —
  which would otherwise leave a de-provisioned credential lingering across
  restarts — and (b) a credential present in the response is never pruned just
  because its own upsert hit a transient error. Only credentials genuinely absent
  from a *successful* fetch are pruned (an empty response clears everything);
  prune never runs on a failed fetch. Each prune logs the resource id, and the
  sync result tallies `removed` / `skipped` / `unsupported` / `failed` for the
  Logger UI.
- **Keys** — the decrypted `api_key` arrives over HTTPS and is immediately
  re-encrypted via safeStorage like any user key; it is never logged.
- **Graceful degradation** — an unreachable server or failed fetch leaves the
  previously-synced managed rows intact; `CinnaReauthRequired` stops the timer.
- **Onboarding** — managed providers make `providers.length > 0`, so the
  onboarding gate auto-dismisses for provisioned users (the broadcast re-renders
  it). The brief first-login window before the initial sync lands is acceptable.

## Architecture Overview

```
Activation (cinna_user)
  → reloadUserProviders() → load Default-scope providers + loadManagedAdapters(profile)
  → runAccountConfigSyncOnce(userId) + startAccountConfigPeriodicSync (5 min)
      → accountConfigService.syncAccountConfig(userId)
          → getCinnaAccessToken(userId) → JWT (carries client_kind=desktop)
          → GET {cinnaServerUrl}/api/v1/external/account-config (Bearer JWT)
          → per provider: map type (skip minimax/unknown)
              → if anthropic sk-ant-oat token: upsert provider {unsupported:true},
                no adapter, no mode (leave mode unseen → pruned)
              → else: llmProviderRepo.upsert(profile, {managed:true, baseUrl, apiKeyEnc})
              → register adapter (managed providers are always active)
              → chatModeRepo upsert managed mode (modelId = resolved default,
                isDefault = resolved default)
          → prune managed providers/modes not in the response
      → notifyAccountConfigSynced() → webContents.send('providers:account-config-synced')
  → deactivate(): stopAccountConfigPeriodicSync()

Read paths (active session)
  provider:list        → providerService.listMerged()  (Default ∪ Profile-managed)
  provider:fetch-models→ providerService.fetchModels(id) (live, scope-aware fallback)
  chatmode:list        → chatModeService.listMerged()  (+ enabled & model_id overlay; isDefault untouched)
  effective default    → resolveDefaultModeId(modes, prioritizeAccountDefaults)  (shared)
  chatmode:get         → chatModeService.findMerged(id) (managed-aware + model_id overlay)

Renderer
  useProviders / useChatModes → subscribe providers.onAccountConfigSynced → invalidate
  Settings → Profile {name} → "LLM Providers" / "Chats" (ProfileLLMSection /
    ProfileChatModesSection) → ManagedProviderCard (read-only, "Not supported"
    badge) / ManagedChatModeCard (expand → model picker) →
    chatModes.setManagedEnabled / chatModes.setManagedModel (managed_overrides)
  Composer mode picker (MainArea availableModes) lists managed modes too — they
    are usable exactly like Default-scope modes (disabled ones are filtered out).
```

Managed providers/modes are surfaced under the Settings **Profile {name}** sidebar
group (`profile-llm`, `profile-chats` tabs), not the Default-scope LLM/Chats tabs
— parity with how Remote Agents live in the Profile group beside local agents.

See [Account Provisioning — Technical](account_provisioning_tech.md) for file
locations, schema, IPC channels, and method references.

## Integration Points

- [Settings Scope](../../core/settings_scope/settings_scope.md) — introduces the
  first **Profile-scoped, sync-managed providers and chat modes** (previously
  Default-scope-only); managed-override overlay mirrors `agent_overrides`.
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — the sync pattern
  this mirrors (deterministic ids, 5-min periodic, broadcast-driven refresh,
  graceful degradation).
- [Resource Activation](../../core/resource_activation/resource_activation.md) —
  account-config sync starts on `activate()` for Cinna users, stops on `deactivate()`.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — JWT via
  `getCinnaAccessToken()`; the endpoint is desktop-token-gated server-side.
- [Adapters](../adapters/adapters.md) — adds the `openai_compatible` type
  (OpenAI adapter + `base_url` + fallback models).
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — managed modes are the
  per-credential defaults; local vs account default precedence is governed by the
  `prioritizeAccountDefaults` toggle (local wins by default).
- [Onboarding](../../auth/onboarding/onboarding.md) — provisioned users skip the
  zero-provider onboarding gate.
- **cinna-core** — `workflow-runner-core/docs/plans/admin_ai_credential_provisioning_plan.md`
  (Part B: native account-config endpoint).
