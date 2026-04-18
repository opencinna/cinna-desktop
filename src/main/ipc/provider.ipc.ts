import { ipcMain } from 'electron'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { providerService } from '../services/providerService'
import { ipcErrorShape } from '../errors'

export function registerProviderHandlers(): void {
  ipcMain.handle('provider:list', async () => {
    userActivation.requireActivated()
    return providerService.list(getCurrentUserId())
  })

  ipcMain.handle(
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

  ipcMain.handle('provider:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    providerService.delete(getCurrentUserId(), providerId)
    return { success: true }
  })

  ipcMain.handle('provider:test', async (_event, providerId: string) => {
    userActivation.requireActivated()
    try {
      const models = await providerService.test(getCurrentUserId(), providerId)
      return { success: true as const, models }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle(
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

  ipcMain.handle('provider:list-models', async () => {
    userActivation.requireActivated()
    return providerService.listModels()
  })
}
