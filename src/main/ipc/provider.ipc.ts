import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { providerService } from '../services/providerService'
import { ipcErrorShape } from '../errors'
import { ipcHandle } from './_wrap'

export function registerProviderHandlers(): void {
  ipcHandle('provider:list', async () => {
    userActivation.requireActivated()
    return providerService.list(getCurrentUserId())
  })

  ipcHandle(
    'provider:upsert',
    async (
      _event,
      data: {
        id?: string
        type: string
        name: string
        apiKey?: string
        enabled?: boolean
        isDefault?: boolean
        defaultModelId?: string | null
      }
    ) => {
      userActivation.requireActivated()
      const { id } = providerService.upsert(getCurrentUserId(), data)
      return { id, success: true }
    }
  )

  ipcHandle('provider:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    providerService.delete(getCurrentUserId(), providerId)
    return { success: true }
  })

  // provider:test and provider:test-key catch their own errors and return
  // them as a discriminated-union shape — the renderer's settings UI renders
  // the error inline rather than letting React Query enter an error state.
  ipcHandle('provider:test', async (_event, providerId: string) => {
    userActivation.requireActivated()
    try {
      const models = await providerService.test(getCurrentUserId(), providerId)
      return { success: true as const, models }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  ipcHandle(
    'provider:test-key',
    async (_event, data: { type: string; apiKey: string }) => {
      userActivation.requireActivated()
      try {
        const models = await providerService.testKey(data.type, data.apiKey)
        return { success: true as const, models }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false as const, error: e.message }
      }
    }
  )

  ipcHandle('provider:list-models', async () => {
    userActivation.requireActivated()
    return providerService.listModels()
  })
}
