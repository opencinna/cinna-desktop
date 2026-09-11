import { chatModeService } from './chatModeService'
import { llmProviderRepo } from '../db/llmProviders'
import { mcpProviderRepo } from '../db/mcpProviders'
import { getAdapter } from '../llm/registry'
import { requiresApiKey } from '../../shared/credentials'
import { pickDefaultModelId } from '../../shared/modelDefaults'
import { TaskError } from '../errors'
import type { RunScope } from './runExecutionService'
import type { LLMAdapter, ModelInfo } from '../llm/types'

// A deadline releases the caller, not the raw adapter request. Retries join
// that request until it settles; replacing a registered adapter gets a new key.
const discoveries = new WeakMap<LLMAdapter, Promise<ModelInfo[]>>()
function discover(adapter: LLMAdapter): Promise<ModelInfo[]> {
  const pending = discoveries.get(adapter)
  if (pending) return pending
  const promise = Promise.resolve().then(() => adapter.listModels())
  discoveries.set(adapter, promise)
  void promise.finally(() => {
    if (discoveries.get(adapter) === promise) discoveries.delete(adapter)
  }).catch(() => {})
  return promise
}

/** Captured configuration plus a recheck for asynchronous preflight. */
export interface TaskModelConfig {
  modeId: string
  providerId: string
  modelId: string
  mcpIds: string[]
  assertCurrent(): void
}

export async function resolveTaskModelConfig(scope: RunScope, modeId?: string): Promise<TaskModelConfig> {
  const read = () => {
    const mode = modeId
      ? chatModeService.listMerged(scope).find((row) => row.id === modeId && row.enabled)
      : chatModeService.resolveEffectiveDefault(scope)
    if (!mode) throw new TaskError('invalid_input', modeId
      ? 'That chat mode is unavailable. Choose another mode.'
      : 'Choose a default chat mode in Settings before starting with the model.')
    const provider = llmProviderRepo.listByUserIds([...new Set([scope.settingsUserId, scope.profileUserId])])
      .find((row) => row.id === mode.providerId)
    if (!provider || !provider.enabled || provider.unsupported ||
      (requiresApiKey(provider.type) && !provider.apiKeyEncrypted)) {
      throw new TaskError('invalid_input', 'The chat mode needs an available AI credential. Check Settings.')
    }
    const adapter = getAdapter(provider.id)
    if (!adapter) throw new TaskError('invalid_input', 'The selected AI credential is unavailable. Check Settings.')
    const mcpIds = mode.mcpProviderIds ?? []
    const availableMcps = new Set(mcpProviderRepo.list(scope.settingsUserId).map((row) => row.id))
    if (mcpIds.some((id) => !availableMcps.has(id))) {
      throw new TaskError('invalid_input', 'The chat mode references a missing tool. Update the mode in Settings.')
    }
    return { mode, provider, adapter, mcpIds }
  }
  const snapshot = read()
  const fingerprint = JSON.stringify({ mode: snapshot.mode, provider: snapshot.provider })
  const assertCurrent = (): void => {
    const now = read()
    if (now.adapter !== snapshot.adapter || JSON.stringify({ mode: now.mode, provider: now.provider }) !== fingerprint) {
      throw new TaskError('invalid_input', 'The model configuration changed while starting. Try again.')
    }
  }
  // Explicit configuration works without live discovery. Only a missing model
  // needs the selected adapter's list; unrelated providers are never queried.
  let modelId = snapshot.mode.modelId ?? snapshot.provider.defaultModelId
  if (!modelId) {
    const curated = snapshot.provider.managed ? snapshot.provider.availableModels : null
    if (curated?.length) modelId = pickDefaultModelId(curated)
    else {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const models = await Promise.race([
          discover(snapshot.adapter),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TaskError('invalid_input',
              'The model list could not be read. Choose a model in the chat mode and try again.')), 10_000)
          })
        ])
        modelId = pickDefaultModelId(models.map((model) => model.id))
      } finally { clearTimeout(timer) }
    }
  }
  if (!modelId) throw new TaskError('invalid_input', 'Choose a model in the chat mode before starting this task.')
  assertCurrent()
  return { modeId: snapshot.mode.id, providerId: snapshot.provider.id, modelId,
    mcpIds: snapshot.mcpIds, assertCurrent }
}
