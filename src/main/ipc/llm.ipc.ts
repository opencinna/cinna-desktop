import { userActivation } from '../auth/activation'
import { chatStreamingService } from '../services/chatStreamingService'
import { providerService } from '../services/providerService'
import { type ModelCapability } from '../llm/types'
import { ipcHandle } from './_wrap'

export function registerLlmHandlers(): void {
  ipcHandle('llm:cancel', async (_event, requestId: string) => {
    chatStreamingService.cancel(requestId)
    return { success: true }
  })

  /**
   * Reports a model's accepted MIME types + size envelope. Used by the
   * renderer to gate the attach button and filter the file picker by
   * capability.
   */
  ipcHandle(
    'llm:get-model-capability',
    async (
      _event,
      data: { providerId: string; modelId: string }
    ): Promise<ModelCapability> => {
      userActivation.requireActivated()
      return providerService.getModelCapability(data.providerId, data.modelId)
    }
  )
}
