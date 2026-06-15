import { net } from 'electron'
import { userRepo } from '../db/users'
import { llmProviderRepo } from '../db/llmProviders'
import { chatModeRepo } from '../db/chatModes'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { createAdapter } from '../llm/factory'
import { registerAdapter, unregisterAdapter } from '../llm/registry'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaApiError } from '../errors'
import {
  managedProviderId,
  managedModeId,
  mapToDesktopProviderType,
  colorPresetForType,
  managedDisplayName,
  type AccountConfigResponse,
  type AccountConfigProvider
} from '../llm/accountConfigTypes'
import { pickDefaultModelId, isChatCapableModelId } from '../../shared/modelDefaults'
import { createLogger } from '../logger/logger'

const logger = createLogger('account-config')

export interface SyncAccountConfigResult {
  providers: number
  modes: number
  removed: number
  /** Credentials present in the response but not materialized (no native adapter
   *  type, or a transiently-empty key/base_url — the row is kept, not pruned). */
  skipped: number
  /** Credentials materialized as a provider row but unusable for API calls (e.g.
   *  an anthropic `sk-ant-oat` token): kept + badged, no adapter, no chat mode. */
  unsupported: number
  /** Credentials that threw during materialization (logged, isolated, kept). */
  failed: number
}

/** Distinct fallback models for a gateway provider — credential model + suggestions. */
function fallbackModelsFor(p: AccountConfigProvider): string[] {
  const out = new Set<string>()
  if (p.model) out.add(p.model)
  for (const m of p.suggested_models ?? []) out.add(m)
  return [...out]
}

/**
 * Register the in-memory adapter for a managed provider. Managed providers are
 * always registered (they have no standalone on/off — usability is controlled by
 * the chat mode that references them, and a user mode may reference one too).
 */
function syncManagedAdapter(args: {
  providerId: string
  type: string
  apiKey: string
  baseUrl: string | null
  fallbackModels: string[]
}): void {
  const adapter = createAdapter(args.type, args.apiKey, args.providerId, {
    baseUrl: args.baseUrl,
    fallbackModels: args.fallbackModels
  })
  if (adapter) registerAdapter(args.providerId, adapter)
}

export const accountConfigService = {
  /**
   * Fetch the user's account-config bundle from cinna-core and materialize
   * managed LLM providers + a default chat mode per credential into Profile
   * scope. Sync owns these rows: it upserts the live set and prunes stale ones.
   * Re-throws {@link CinnaReauthRequired} (via getCinnaAccessToken) so the
   * periodic runner can stop hammering a revoked token.
   */
  async syncAccountConfig(userId: string): Promise<SyncAccountConfigResult> {
    const user = userRepo.get(userId)
    if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) {
      return { providers: 0, modes: 0, removed: 0, skipped: 0, unsupported: 0, failed: 0 }
    }

    const accessToken = await getCinnaAccessToken(userId)
    const baseUrl = user.cinnaServerUrl.replace(/\/$/, '')

    // Time the external call for the Logger UI. Never log the response body — it
    // carries decrypted API keys.
    logger.info('account-config request', { baseUrl })
    const started = Date.now()
    const response = await net.fetch(`${baseUrl}/api/v1/external/account-config`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    })
    if (!response.ok) {
      logger.warn('account-config request failed', {
        baseUrl,
        status: response.status,
        duration: Date.now() - started
      })
      throw new CinnaApiError(
        'request_failed',
        `Account-config request failed: ${response.status} ${response.statusText}`
      )
    }

    const data = (await response.json()) as AccountConfigResponse
    logger.info('account-config response', {
      baseUrl,
      status: response.status,
      duration: Date.now() - started,
      providerCount: (data.providers ?? []).length
    })
    const providers = data.providers ?? []
    const defaultCredId = data.default_provider_credential_id

    // Account-config rows are profile-scoped (visible only while this account is
    // active). The active profile === the user we just synced for.
    const profileUserId = userId

    const seenProviderIds = new Set<string>()
    const seenModeIds = new Set<string>()
    let skipped = 0
    let unsupported = 0
    let failed = 0
    let modeCount = 0

    for (const p of providers) {
      const type = mapToDesktopProviderType(p.provider_type)
      if (!type) {
        // No native adapter (minimax / unknown) — nothing was ever materialized
        // for this credential, so leaving it unseen lets the prune drop any stale
        // row. Skipped before "mark seen" on purpose.
        logger.warn('skipping provider with unsupported type', {
          type: p.provider_type,
          credentialId: p.credential_id
        })
        skipped += 1
        continue
      }

      const providerId = managedProviderId(p.credential_id)
      const modeId = managedModeId(p.credential_id)
      // Anthropic OAuth tokens (`sk-ant-oat…`) are valid for the Claude apps but
      // NOT the Messages API, so they can't drive a chat. We still keep the
      // provider row (shown with a "Not supported" badge) but materialize no
      // adapter and no chat mode — and we must NOT mark its mode seen, so any
      // mode created for it by an earlier build gets pruned below.
      const isUnsupportedKey =
        type === 'anthropic' && !!p.api_key && p.api_key.startsWith('sk-ant-oat')
      // Mark this credential seen BEFORE any validation/upsert so the prune pass
      // below can't delete a credential that is still provisioned server-side —
      // whether its upsert hits a transient error OR it arrives with a
      // transiently-empty key/base_url. Only credentials genuinely ABSENT from
      // the response get pruned.
      seenProviderIds.add(providerId)
      if (!isUnsupportedKey) seenModeIds.add(modeId)

      try {
        // A present-but-empty key / missing gateway base_url means "still
        // provisioned, temporarily unusable": skip materialization but KEEP the
        // last-good row (already marked seen) instead of pruning it.
        if (!p.api_key) {
          logger.warn('skipping provider with empty api_key', { credentialId: p.credential_id })
          skipped += 1
          continue
        }
        if (type === 'openai_compatible' && !p.base_url) {
          logger.warn('skipping openai_compatible provider without base_url', {
            credentialId: p.credential_id
          })
          skipped += 1
          continue
        }

        // Anthropic OAuth token: materialize the provider row so it appears in
        // the AI-credentials list (with a "Not supported" badge), but register no
        // adapter and create no chat mode — it can't make API calls. Its mode was
        // left unseen above, so the prune removes any stale one.
        if (isUnsupportedKey) {
          llmProviderRepo.upsert(profileUserId, {
            id: providerId,
            type,
            name: managedDisplayName(p.display_name, p.credential_name),
            apiKeyEncrypted: encryptApiKey(p.api_key),
            enabled: true,
            defaultModelId: null,
            availableModels: null,
            baseUrl: p.base_url,
            managed: true,
            adminManaged: p.is_admin_managed,
            unsupported: true,
            createIfMissing: true
          })
          unregisterAdapter(providerId)
          logger.warn('managed credential not usable for API calls (anthropic oauth token)', {
            credentialId: p.credential_id
          })
          unsupported += 1
          continue
        }

        const fallbackModels = fallbackModelsFor(p)
        // Resolve the seed default model. Precedence:
        //   1. `default_model` — the admin-curated explicit choice (authoritative).
        //   2. For `openai_compatible` only, the credential's required gateway
        //      model (`p.model`), which is legit for that type.
        //   3. A sane auto-pick from the curated/discovered list — chat-capable
        //      and non-gated, so we never seed an embedding/tts model or a tier
        //      the account can't call.
        // We deliberately do NOT trust `p.model` for the native providers: its
        // server-side fallback chain can land on `discovered_models[0]` (e.g. an
        // embedding). The user can override the result locally per mode.
        const suggested = p.suggested_models ?? []
        const curatedDefault = p.default_model?.trim() || null
        const requiredGatewayModel =
          type === 'openai_compatible' ? p.model?.trim() || null : null
        // cinna-core's auto-resolved `model` is unreliable (its chain can end on
        // `discovered_models[0]`, e.g. an embedding) — but when discovery is
        // empty it falls back to the provider's catalog default, a real chat
        // model and often the ONLY signal we have. Keep it as a last resort, but
        // only when it's chat-capable so the embedding case is still excluded.
        const legacyModel = p.model?.trim() || null
        const legacyChatModel = legacyModel && isChatCapableModelId(legacyModel) ? legacyModel : null
        const defaultModelId =
          curatedDefault ?? requiredGatewayModel ?? pickDefaultModelId(suggested) ?? legacyChatModel
        // Curated model list cinna-core resolved for this credential (admin
        // `available_models`, else the key's `discovered_models`). When present it
        // becomes the provider's picker list (providerService.listModels). Empty →
        // null so the adapter's own model list applies unchanged.
        const availableModels = suggested.length > 0 ? suggested : null

        // Upsert the managed provider row (profile scope). enabled stays true —
        // the local on/off preference lives in managed_overrides, not here.
        // createIfMissing seeds the row under its deterministic id on first sync.
        llmProviderRepo.upsert(profileUserId, {
          id: providerId,
          type,
          name: managedDisplayName(p.display_name, p.credential_name),
          apiKeyEncrypted: encryptApiKey(p.api_key),
          enabled: true,
          defaultModelId,
          availableModels,
          baseUrl: p.base_url,
          managed: true,
          adminManaged: p.is_admin_managed,
          unsupported: false,
          createIfMissing: true
        })

        syncManagedAdapter({
          providerId,
          type,
          apiKey: p.api_key,
          baseUrl: p.base_url,
          fallbackModels
        })

        // Upsert the per-credential default chat mode. isDefault is set on exactly
        // the credential cinna-core resolved as the conversation default.
        const existingMode = chatModeRepo.getOwned(profileUserId, modeId)
        const isDefault = defaultCredId != null && p.credential_id === defaultCredId
        const modeInput = {
          id: modeId,
          name: managedDisplayName(p.default_chat_mode_label || p.display_name, p.credential_name),
          providerId,
          modelId: defaultModelId,
          mcpProviderIds: [] as string[],
          colorPreset: colorPresetForType(type),
          isDefault,
          managed: true,
          adminManaged: p.is_admin_managed
        }
        if (existingMode) chatModeRepo.update(profileUserId, modeId, modeInput)
        else chatModeRepo.insert(profileUserId, modeInput)
        modeCount += 1
      } catch (err) {
        // Isolate per-credential failures: a single bad descriptor must not abort
        // the whole sync, or the prune below would never run and de-provisioned
        // credentials would linger forever (even across restarts). The row stays
        // (it's marked seen) so a transient failure doesn't drop a valid one.
        failed += 1
        logger.error('failed to materialize managed credential', {
          credentialId: p.credential_id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // Prune managed rows no longer present in the response (de-provisioned
    // server-side). Always runs on a successful fetch — even an empty response
    // clears every managed row — because a removed credential must disappear
    // locally too.
    let removed = 0
    for (const row of llmProviderRepo.listManaged(profileUserId)) {
      if (seenProviderIds.has(row.id)) continue
      llmProviderRepo.delete(profileUserId, row.id)
      unregisterAdapter(row.id)
      removed += 1
      logger.info('pruned de-provisioned managed provider', { providerId: row.id })
    }
    for (const row of chatModeRepo.listManaged(profileUserId)) {
      if (seenModeIds.has(row.id)) continue
      chatModeRepo.delete(profileUserId, row.id)
      logger.info('pruned de-provisioned managed mode', { modeId: row.id })
    }

    logger.info('account-config synced', {
      providers: seenProviderIds.size,
      modes: modeCount,
      removed,
      skipped,
      unsupported,
      failed
    })
    return {
      providers: seenProviderIds.size,
      modes: modeCount,
      removed,
      skipped,
      unsupported,
      failed
    }
  },

  /**
   * Load already-synced managed providers for a profile into the adapter
   * registry (used on activation, before the network sync completes, so managed
   * providers are usable offline / immediately). Honors local overrides.
   */
  loadManagedAdapters(profileUserId: string): void {
    for (const row of llmProviderRepo.listManaged(profileUserId)) {
      if (!row.apiKeyEncrypted) continue
      // Unsupported credentials (e.g. anthropic oauth tokens) can't make API
      // calls — they exist only to show in the list, so never register an adapter.
      if (row.unsupported) continue
      try {
        const apiKey = decryptApiKey(row.apiKeyEncrypted)
        // Prefer the curated list for the offline/gateway fallback; fall back to
        // just the default model when there is no curation.
        const fallbackModels =
          row.availableModels && row.availableModels.length > 0
            ? row.availableModels
            : row.defaultModelId
              ? [row.defaultModelId]
              : []
        const adapter = createAdapter(row.type, apiKey, row.id, {
          baseUrl: row.baseUrl,
          fallbackModels
        })
        if (adapter) registerAdapter(row.id, adapter)
      } catch (err) {
        logger.error(`failed to init managed provider ${row.name}`, err)
      }
    }
  }
}
