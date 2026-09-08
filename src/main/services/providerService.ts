import { llmProviderRepo, LlmProviderRow } from '../db/llmProviders'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { createAdapter, isProviderType } from '../llm/factory'
import { isManagedProviderId } from '../llm/accountConfigTypes'
import { getManagedResourceScopes } from '../auth/scope'
import {
  registerAdapter,
  unregisterAdapter,
  getAdapter,
  getAllModels
} from '../llm/registry'
import { ProviderError } from '../errors'
import {
  requiresApiKey,
  storableOllamaHost,
  OLLAMA_DEFAULT_HOST
} from '../../shared/credentials'
import { ModelInfo, ModelCapability, NO_FILE_SUPPORT } from '../llm/types'
import { createLogger } from '../logger/logger'

const logger = createLogger('Providers')

export interface ProviderDto {
  id: string
  type: string
  name: string
  enabled: boolean
  defaultModelId: string | null
  hasApiKey: boolean
  /**
   * Where this credential's requests go, when it is not a first-party endpoint:
   * the gateway URL of an `openai_compatible` row, or the Ollama host.
   *
   * Crosses to the renderer, unlike every other per-credential detail here,
   * because for a keyless credential it *is* the credential — the Ollama card
   * has to show and edit it, and it is a loopback URL rather than a secret.
   */
  baseUrl: string | null
  /** True for account-provisioned (Cinna-managed) providers — read-only in the UI. */
  managed: boolean
  /** For managed rows: provisioned by an admin vs the user's own Cinna credential. */
  adminManaged: boolean
  /** Managed credential that can't make API calls (e.g. anthropic oauth token). */
  unsupported: boolean
  createdAt: Date
}

export interface UpsertProviderInput {
  id?: string
  type: string
  name: string
  apiKey?: string
  enabled?: boolean
  defaultModelId?: string | null
  /** Gateway / host URL. Undefined leaves an existing value alone. */
  baseUrl?: string | null
}

function toDto(row: LlmProviderRow): ProviderDto {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    defaultModelId: row.defaultModelId,
    hasApiKey: !!row.apiKeyEncrypted,
    baseUrl: row.baseUrl,
    managed: row.managed,
    adminManaged: row.adminManaged,
    unsupported: row.unsupported,
    createdAt: row.createdAt
  }
}

export const providerService = {
  list(userId: string): ProviderDto[] {
    return llmProviderRepo.list(userId).map((r) => toDto(r))
  },

  /**
   * Providers visible to the active session: user-created (Default scope) plus
   * account-provisioned managed rows (active Profile scope). Managed providers
   * are always active — they have no standalone on/off (usability is gated by
   * the chat mode that references them). Backs the `provider:list` IPC.
   */
  listMerged(): ProviderDto[] {
    return llmProviderRepo.listByUserIds(getManagedResourceScopes()).map((row) => toDto(row))
  },

  upsert(userId: string, input: UpsertProviderInput): { id: string; row: ProviderDto } {
    if (input.id && isManagedProviderId(input.id)) {
      throw new ProviderError(
        'read_only',
        'This provider is managed by your account and cannot be modified.'
      )
    }
    if (!isProviderType(input.type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${input.type}`)
    }

    /**
     * A credential's **type is fixed at creation**, and this is a security
     * boundary rather than a tidiness rule.
     *
     * The repo writes `type` unconditionally on update and *preserves* the
     * stored encrypted key when no new one is supplied. So without this check a
     * renderer could re-type an existing Anthropic row as something else while
     * it kept the Anthropic key — and the key would then be spent under the
     * other type's transport and endpoint. Combined with a renderer-supplied
     * `baseUrl` (below) that is a decrypted key sent to an address the renderer
     * chose, which is exactly what "API keys never leave the main process" is
     * there to prevent.
     *
     * No caller legitimately does this: the card always sends the row's own
     * type, the Add form only creates. Account-config sync is unaffected — it
     * writes through `llmProviderRepo` directly and never through here.
     */
    const existing = input.id ? llmProviderRepo.getOwned(userId, input.id) : undefined
    if (existing && existing.type !== input.type) {
      throw new ProviderError(
        'type_immutable',
        "A credential's provider type cannot be changed. Delete it and add a new one."
      )
    }

    /**
     * `baseUrl` is accepted from this entry point **only for a keyless type**,
     * and normalised on the way in.
     *
     * The restriction is the other half of the boundary above. A keyed
     * credential's endpoint is not something the renderer may set: pointing a
     * row that holds a real API key at an arbitrary URL is key exfiltration with
     * extra steps. The one place a keyed credential legitimately gets a base URL
     * — an `openai_compatible` gateway — is account-config sync, which writes
     * through the repo directly and is untouched by this.
     *
     * Normalising here rather than in the renderer means every writer inherits
     * it: the Add form, the card's Host field, the one-click offer row. It was
     * only being done on the *probe* path, so Test and Save disagreed about what
     * the host was — a pasted `…:11434/v1` probed green against the origin and
     * then stored verbatim, which made the adapter fetch `…/v1/api/tags` and the
     * engine emit `…/v1/v1`.
     *
     * `undefined` stays `undefined`: it means "leave the stored value alone",
     * which is what the enable toggle and the default-model writer both send.
     */
    let baseUrl: string | null | undefined = undefined
    if (requiresApiKey(input.type) && input.baseUrl != null) {
      // Dropped rather than refused, and then logged. A guard that has to tell a
      // legitimate `null` from a hostile string is a guard reasoning about
      // intent, which is how they come to be wrong — so it drops unconditionally.
      // But a silent drop would also be the *only* trace an attempt left, so it
      // leaves one. Loose `!=`, so a caller clearing the field with an explicit
      // null stays quiet.
      logger.warn('baseUrl ignored for a credential that has an API key', {
        providerId: input.id,
        type: input.type
      })
    }
    if (!requiresApiKey(input.type) && input.baseUrl !== undefined) {
      const storable = storableOllamaHost(input.baseUrl)
      if (!storable) {
        throw new ProviderError(
          'invalid_host',
          `“${String(input.baseUrl).trim()}” is not a host address. Use something like ${OLLAMA_DEFAULT_HOST}.`
        )
      }
      baseUrl = storable
    }

    const { id, created, row } = llmProviderRepo.upsert(userId, {
      id: input.id,
      type: input.type,
      name: input.name,
      apiKeyEncrypted: input.apiKey ? encryptApiKey(input.apiKey) : undefined,
      enabled: input.enabled,
      defaultModelId: input.defaultModelId,
      baseUrl
    })

    logger.info(created ? 'provider created' : 'provider updated', {
      providerId: id,
      type: row.type,
      enabled: row.enabled
    })

    // A keyless type (Ollama) registers on `enabled` alone — there is no key to
    // wait for, and requiring one would make a saved Ollama credential invisible
    // to the model picker forever. `baseUrl` is passed through, which it was
    // not before: an `openai_compatible` row saved here used to lose its gateway
    // and register against the default OpenAI endpoint.
    if (row.enabled && (row.apiKeyEncrypted || !requiresApiKey(row.type))) {
      const adapter = createAdapter(
        row.type,
        row.apiKeyEncrypted ? decryptApiKey(row.apiKeyEncrypted) : '',
        row.id,
        { baseUrl: row.baseUrl }
      )
      if (adapter) registerAdapter(row.id, adapter)
    } else {
      unregisterAdapter(row.id)
    }

    return { id, row: toDto(row) }
  },

  delete(userId: string, id: string): void {
    if (isManagedProviderId(id)) {
      throw new ProviderError(
        'read_only',
        'This provider is managed by your account and cannot be deleted.'
      )
    }
    const removed = llmProviderRepo.delete(userId, id)
    if (!removed) {
      throw new ProviderError('not_found', 'Provider not found')
    }
    unregisterAdapter(id)
    logger.info('provider deleted', { providerId: id })
  },

  async test(userId: string, id: string): Promise<ModelInfo[]> {
    const provider = llmProviderRepo.getOwned(userId, id)
    if (!provider) throw new ProviderError('not_found', 'Provider not found')
    if (!provider.apiKeyEncrypted && requiresApiKey(provider.type)) {
      throw new ProviderError('missing_api_key', 'No API key configured')
    }
    if (!isProviderType(provider.type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${provider.type}`)
    }

    const apiKey = provider.apiKeyEncrypted ? decryptApiKey(provider.apiKeyEncrypted) : ''
    const adapter = createAdapter(provider.type, apiKey, provider.id, {
      baseUrl: provider.baseUrl
    })
    if (!adapter) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${provider.type}`)
    }

    logger.info('test provider: listModels', { providerId: id, type: provider.type })
    const started = Date.now()
    try {
      const models = await adapter.listModels()
      logger.info('test provider: ok', {
        providerId: id,
        type: provider.type,
        duration: Date.now() - started,
        modelCount: models.length
      })
      return models
    } catch (err) {
      // Through the adapter's own `parseError`, exactly as {@link fetchModels}
      // does. Rethrowing raw is what made "Test Connection" on a stopped Ollama
      // read `fetch failed` — while `OllamaAdapter.parseError` held the sentence
      // that actually helps ("Ollama isn't answering at … — start it with
      // 'ollama serve'"), reachable from no path a user could take.
      const parsed = adapter.parseError(err instanceof Error ? err : new Error(String(err)))
      logger.error('test provider: failed', {
        providerId: id,
        type: provider.type,
        duration: Date.now() - started,
        error: parsed.detail
      })
      throw new ProviderError('list_models_failed', parsed.short, parsed.detail)
    }
  },

  /**
   * Fetch a provider's model list LIVE from its API, on demand, using the
   * stored (encrypted) key. Scope-aware (searches `getManagedResourceScopes()`),
   * so it works for account-provisioned **managed** providers in Profile scope,
   * not just Default-scope user providers (unlike {@link test}, which is
   * Default-scoped). Used by the managed chat-mode model picker when the
   * background `getAllModels()` registry has no models for a credential — the
   * server provided no curated list and/or the registry didn't capture the live
   * list — so the user can pull the models directly in the app, exactly like a
   * default-account provider. Throws `ProviderError` on missing row/key or an
   * unsupported type; propagates adapter errors so the renderer can show a
   * "couldn't load" state.
   */
  async fetchModels(providerId: string): Promise<ModelInfo[]> {
    let row: LlmProviderRow | undefined
    for (const scope of getManagedResourceScopes()) {
      row = llmProviderRepo.getOwned(scope, providerId)
      if (row) break
    }
    if (!row) throw new ProviderError('not_found', 'Provider not found')
    if (!row.apiKeyEncrypted && requiresApiKey(row.type)) {
      throw new ProviderError('missing_api_key', 'No API key configured')
    }
    if (!isProviderType(row.type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${row.type}`)
    }
    const apiKey = row.apiKeyEncrypted ? decryptApiKey(row.apiKeyEncrypted) : ''
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
    if (!adapter) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${row.type}`)
    }
    const providerId_ = row.id
    logger.info('fetch models for provider', { providerId: providerId_, type: row.type })
    try {
      const models = await adapter.listModels()
      return models.map((m) => ({ ...m, providerId: providerId_ }))
    } catch (err) {
      // Surface the provider's own error (e.g. "invalid x-api-key") instead of a
      // generic failure: `parseError` yields a friendly `short` + the raw
      // `detail`, both carried to the renderer via the ProviderError (DomainError
      // code/detail survive the IPC boundary).
      const parsed = adapter.parseError(err instanceof Error ? err : new Error(String(err)))
      logger.error('fetch models failed', {
        providerId: providerId_,
        type: row.type,
        error: parsed.detail
      })
      throw new ProviderError('list_models_failed', parsed.short, parsed.detail)
    }
  },

  /**
   * Probe a credential the user is still typing, before any row exists.
   *
   * Takes an object rather than two positional strings because what identifies a
   * credential is no longer always a key: an Ollama credential is a **host**,
   * and `testKey('ollama', '')` would have been a call whose meaningful argument
   * was the one it did not have.
   */
  async testKey(input: {
    type: string
    apiKey?: string
    baseUrl?: string | null
  }): Promise<ModelInfo[]> {
    const { type } = input
    if (!isProviderType(type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${type}`)
    }
    if (!input.apiKey && requiresApiKey(type)) {
      throw new ProviderError('missing_api_key', 'No API key provided')
    }
    /**
     * The same rule as {@link upsert}, one function over, for a related reason
     * rather than the identical one.
     *
     * Nothing stored is exfiltrated here — the key on this path is
     * renderer-supplied too — but forwarding a renderer's `baseUrl` for an
     * arbitrary type makes the **main process** issue a request to any http(s)
     * address and hand the result back as either a model list or the endpoint's
     * own error text. That is a loopback and LAN port probe with a readable
     * answer, and it is a primitive this feature would have introduced: before
     * it, a keyed type could only reach a fixed set of vendor endpoints.
     *
     * A keyless type keeps it, because probing a host the user just typed is the
     * entire purpose of the Add form's Test button. No caller loses anything —
     * the card, the Add form and onboarding all send `{type, apiKey}` and none
     * sends a `baseUrl` for a keyed type.
     */
    const probeBaseUrl = requiresApiKey(type) ? null : (input.baseUrl ?? null)
    const adapter = createAdapter(type, input.apiKey ?? '', '__probe__', {
      baseUrl: probeBaseUrl
    })
    if (!adapter) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${type}`)
    }

    logger.info('test key: listModels', { type })
    const started = Date.now()
    try {
      const models = await adapter.listModels()
      logger.info('test key: ok', {
        type,
        duration: Date.now() - started,
        modelCount: models.length
      })
      return models
    } catch (err) {
      // Same reasoning as {@link test} above: the adapter knows how to say what
      // went wrong, and a raw rethrow puts `fetch failed` on the screen instead.
      const parsed = adapter.parseError(err instanceof Error ? err : new Error(String(err)))
      logger.error('test key: failed', {
        type,
        duration: Date.now() - started,
        error: parsed.detail
      })
      throw new ProviderError('list_models_failed', parsed.short, parsed.detail)
    }
  },

  /**
   * Models offered in the picker across all registered adapters.
   *
   * Managed providers are handled so the picker is never empty even when the
   * live model API can't be reached (an OAuth token / restricted key that can't
   * `models.list()`, or a gateway with no `/models`):
   *   - **Curated** (non-empty `availableModels` = account-config
   *     `suggested_models`): that admin-ordered list REPLACES the adapter list —
   *     the user sees only the offered models, in order.
   *   - **Non-curated**: the adapter's live list, but the synced `defaultModelId`
   *     is always prepended so the default stays selectable when the live call
   *     returns nothing or fails.
   * In both cases the resolved default is guaranteed present, ids the adapter
   * doesn't surface are synthesized so they stay selectable, and ids are deduped
   * (`suggested_models` is untrusted wire input). Non-managed (local) providers
   * pass through `getAllModels()` unchanged.
   */
  async listModels(): Promise<ModelInfo[]> {
    const all = await getAllModels()
    const managedRows = llmProviderRepo
      .listByUserIds(getManagedResourceScopes())
      .filter((r) => r.managed)
    if (managedRows.length === 0) return all

    const adapterModel = new Map(all.map((m) => [`${m.providerId} ${m.id}`, m]))
    const liveByProvider = new Map<string, ModelInfo[]>()
    for (const m of all) {
      const arr = liveByProvider.get(m.providerId)
      if (arr) arr.push(m)
      else liveByProvider.set(m.providerId, [m])
    }
    const managedProviderIds = new Set(managedRows.map((r) => r.id))

    const result: ModelInfo[] = []
    // For each managed provider emit a guaranteed-non-empty list: the curated
    // `availableModels` when present (admin-ordered, replaces the adapter list),
    // otherwise the adapter's live list — and always with the resolved default
    // prepended so something stays selectable when the live call is empty/failed.
    for (const row of managedRows) {
      const curated = (row.availableModels?.length ?? 0) > 0
      const ids = curated
        ? [...(row.availableModels as string[])]
        : (liveByProvider.get(row.id) ?? []).map((m) => m.id)
      if (row.defaultModelId && !ids.includes(row.defaultModelId)) ids.unshift(row.defaultModelId)
      // Dedupe — `suggested_models` is untrusted wire input; a repeated id would
      // otherwise yield duplicate picker rows.
      const seen = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        const existing = adapterModel.get(`${row.id} ${id}`)
        result.push(
          existing ?? { id, name: id, providerId: row.id, providerType: row.type }
        )
      }
    }
    // Then every non-managed (local) provider's models, unchanged.
    for (const m of all) {
      if (!managedProviderIds.has(m.providerId)) result.push(m)
    }
    return result
  },

  /**
   * Resolve a model's accepted MIME types + size envelope. Degrades to
   * {@link NO_FILE_SUPPORT} when the provider isn't registered (missing
   * API key, disabled, deleted) so the renderer-side capability gate
   * fails closed rather than throwing.
   */
  getModelCapability(providerId: string, modelId: string): ModelCapability {
    const adapter = getAdapter(providerId)
    if (!adapter) return NO_FILE_SUPPORT
    return adapter.modelCapability(modelId)
  }
}
