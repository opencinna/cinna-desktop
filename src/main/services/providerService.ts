import { llmProviderRepo, LlmProviderRow } from '../db/llmProviders'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { createAdapter, isProviderType } from '../llm/factory'
import {
  registerAdapter,
  unregisterAdapter,
  getAllModels
} from '../llm/registry'
import { ProviderError } from '../errors'
import { ModelInfo } from '../llm/types'
import { createLogger } from '../logger/logger'

const logger = createLogger('Providers')

export interface ProviderDto {
  id: string
  type: string
  name: string
  enabled: boolean
  isDefault: boolean
  defaultModelId: string | null
  hasApiKey: boolean
  createdAt: Date
}

export interface UpsertProviderInput {
  id?: string
  type: string
  name: string
  apiKey?: string
  enabled?: boolean
  isDefault?: boolean
  defaultModelId?: string | null
}

function toDto(row: LlmProviderRow): ProviderDto {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    isDefault: row.isDefault,
    defaultModelId: row.defaultModelId,
    hasApiKey: !!row.apiKeyEncrypted,
    createdAt: row.createdAt
  }
}

export const providerService = {
  list(userId: string): ProviderDto[] {
    return llmProviderRepo.list(userId).map(toDto)
  },

  upsert(userId: string, input: UpsertProviderInput): { id: string; row: ProviderDto } {
    if (!isProviderType(input.type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${input.type}`)
    }

    const { id, created, row } = llmProviderRepo.upsert(userId, {
      id: input.id,
      type: input.type,
      name: input.name,
      apiKeyEncrypted: input.apiKey ? encryptApiKey(input.apiKey) : undefined,
      enabled: input.enabled,
      isDefault: input.isDefault,
      defaultModelId: input.defaultModelId
    })

    logger.info(created ? 'provider created' : 'provider updated', {
      providerId: id,
      type: row.type,
      enabled: row.enabled,
      isDefault: row.isDefault
    })

    if (row.enabled && row.apiKeyEncrypted) {
      const adapter = createAdapter(row.type, decryptApiKey(row.apiKeyEncrypted), row.id)
      if (adapter) registerAdapter(row.id, adapter)
    } else {
      unregisterAdapter(row.id)
    }

    return { id, row: toDto(row) }
  },

  delete(userId: string, id: string): void {
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
    if (!provider.apiKeyEncrypted) {
      throw new ProviderError('missing_api_key', 'No API key configured')
    }
    if (!isProviderType(provider.type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${provider.type}`)
    }

    const apiKey = decryptApiKey(provider.apiKeyEncrypted)
    const adapter = createAdapter(provider.type, apiKey, provider.id)
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
      logger.error('test provider: failed', {
        providerId: id,
        type: provider.type,
        duration: Date.now() - started,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  },

  async testKey(type: string, apiKey: string): Promise<ModelInfo[]> {
    if (!isProviderType(type)) {
      throw new ProviderError('unsupported_type', `Unsupported provider type: ${type}`)
    }
    const adapter = createAdapter(type, apiKey, '__probe__')
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
      logger.error('test key: failed', {
        type,
        duration: Date.now() - started,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  },

  listModels(): Promise<ModelInfo[]> {
    return getAllModels()
  }
}
