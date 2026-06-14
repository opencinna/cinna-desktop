# Account-Provisioned Providers & Chat Modes

## Purpose

Deliver a **"ready on login"** experience for Cinna users: when a company DevOps
admin provisions AI credentials centrally on cinna-core, the desktop app
auto-materializes matching **LLM providers** and a **default chat mode per
credential** the moment the user signs in — no manual key entry, no Settings
detour. The user logs in and can immediately chat with the LLM (and, combined
with [Remote Agents](../../agents/remote_agents/remote_agents.md) + the
[Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md), with agents).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Managed Provider** | An LLM provider auto-created from a Cinna account-config descriptor (`managed = true`). Profile-scoped, sync-owned, read-only in the user's UI. Deterministic id `managed:{credentialId}`. |
| **Managed Chat Mode** | A default chat mode auto-created per managed credential (`managed = true`). Deterministic id `managed-mode:{credentialId}`. Bound to its managed provider. |
| **Account Config Sync** | The process that fetches the user's provider bundle from cinna-core's `GET /api/v1/external/account-config` and upserts managed providers/modes into Profile scope — mirrors [Remote Agents](../../agents/remote_agents/remote_agents.md) sync. |
| **Account-Config Endpoint** | cinna-core native endpoint returning, per usable AI credential, a descriptor **including the decrypted `api_key`**, the resolved default, and a chat-mode label. Desktop/mobile-token-gated on the server. |
| **Managed Override** | Per-profile local enable/disable preference for a managed **chat mode** (`managed_overrides` table, `kind='mode'`). Sync never writes it, so it survives re-sync — mirrors [Agent Override](../../core/settings_scope/settings_scope.md). Managed *providers* have no toggle — they're always active. |

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
- **Read-only** — the user cannot edit/delete/re-key managed rows. The
  Default-scope write paths can't see them (scope mismatch), and explicit
  `read_only` guards in `providerService` / `chatModeService` reject managed ids.
- **Local enable/disable on modes only** — managed providers are always active
  (registered on sync/activation); they have no standalone on/off because a
  provider is only ever reached through a chat mode (managed or user-built). The
  one user-controllable bit is the managed **chat mode** toggle
  (`managed_overrides`, `kind='mode'`), which gates picker visibility + default
  eligibility.
- **Provider type mapping** — `anthropic`→anthropic, `openai`→openai,
  `google`→gemini, `openai_compatible`→openai adapter with a `base_url` (and the
  credential model seeded as a fallback when the gateway has no `/models`).
  `minimax` and unknown types are skipped with a warning (no native adapter) and
  are eligible for pruning — nothing was ever materialized for them. A descriptor
  with an empty `api_key`, or `openai_compatible` without a `base_url`, skips
  *materialization* but is **kept, not pruned**: it's treated as "still
  provisioned, temporarily unusable", so the last-good row survives a transient
  blank rather than disappearing (see *Stale pruning*).
- **Default model selection** — a managed mode/provider takes the credential's
  resolved `model` from cinna-core verbatim. When that's empty, the default is
  auto-picked from `suggested_models` (and at chat time from the live list) via
  `pickDefaultModelId` (`shared/modelDefaults.ts`), which **skips access-gated
  tiers** (Anthropic Fable/Mythos) — `models.list()` returns those even when the
  account can only see, not call them, so a naive "newest" default would 404.
  They stay explicitly selectable for accounts that have access.
- **Curated available models** — when cinna-core returns a non-empty
  `suggested_models` for a credential (the admin's `available_models`, else the
  key's `discovered_models`), it is persisted on the managed provider row
  (`llm_providers.available_models`) and **replaces the adapter's model list in
  the picker** (`providerService.listModels`): the user sees only the offered
  models, in the admin's order. Curated ids the desktop adapter doesn't hardcode
  are synthesized so they stay selectable, and the provider's resolved default
  model is always included. Empty/absent curation falls back to the adapter's own
  list (the prior behavior). For `openai_compatible` the list also seeds the
  gateway fallback so an unreachable `/models` still yields the curated picker.
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
  sync result tallies `removed` / `skipped` / `failed` for the Logger UI.
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
              → llmProviderRepo.upsert(profile, {managed:true, baseUrl, apiKeyEnc})
              → register adapter (managed providers are always active)
              → chatModeRepo upsert managed mode (isDefault = resolved default)
          → prune managed providers/modes not in the response
      → notifyAccountConfigSynced() → webContents.send('providers:account-config-synced')
  → deactivate(): stopAccountConfigPeriodicSync()

Read paths (active session)
  provider:list  → providerService.listMerged()  (Default ∪ Profile-managed)
  chatmode:list  → chatModeService.listMerged()  (+ mode enabled overlay; isDefault untouched)
  effective default → resolveDefaultModeId(modes, prioritizeAccountDefaults)  (shared)
  chatmode:get   → chatModeService.findMerged(id) (managed-aware lookup)

Renderer
  useProviders / useChatModes → subscribe providers.onAccountConfigSynced → invalidate
  Settings → Profile {name} → "LLM Providers" / "Chats" (ProfileLLMSection /
    ProfileChatModesSection) → ManagedProviderCard (read-only) /
    ManagedChatModeCard → chatModes.setManagedEnabled (managed_overrides)
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
