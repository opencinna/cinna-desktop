import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client'
import { llmProviders } from '../db/schema'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { registerAdapter, unregisterAdapter, getAllModels } from '../llm/registry'
import { createAdapter } from './llm.ipc'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'

export function registerProviderHandlers(): void {
  ipcMain.handle('provider:list', async () => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    const providers = db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.userId, userId))
      .all()
    // Never send encrypted keys to renderer - send masked version
    return providers.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      enabled: p.enabled,
      isDefault: p.isDefault,
      defaultModelId: p.defaultModelId,
      hasApiKey: !!p.apiKeyEncrypted,
      createdAt: p.createdAt
    }))
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
      const db = getDb()
      const id = data.id || nanoid()

      const existing = data.id
        ? db.select().from(llmProviders).where(eq(llmProviders.id, data.id)).get()
        : null

      const apiKeyEnc = data.apiKey
        ? encryptApiKey(data.apiKey)
        : existing?.apiKeyEncrypted ?? null

      // If setting as default, clear other defaults for this user
      const userId = getCurrentUserId()
      if (data.isDefault) {
        db.update(llmProviders)
          .set({ isDefault: false })
          .where(eq(llmProviders.userId, userId))
          .run()
      }

      if (existing) {
        db.update(llmProviders)
          .set({
            name: data.name,
            type: data.type,
            apiKeyEncrypted: apiKeyEnc,
            enabled: data.enabled ?? existing.enabled,
            isDefault: data.isDefault ?? existing.isDefault,
            defaultModelId: data.defaultModelId !== undefined ? data.defaultModelId : existing.defaultModelId
          })
          .where(eq(llmProviders.id, id))
          .run()
      } else {
        // If setting as default, already cleared above
        db.insert(llmProviders)
          .values({
            id,
            userId,
            type: data.type,
            name: data.name,
            apiKeyEncrypted: apiKeyEnc,
            enabled: data.enabled ?? true,
            isDefault: data.isDefault ?? false,
            defaultModelId: data.defaultModelId ?? null,
            createdAt: new Date()
          })
          .run()
      }

      // Re-register adapter if key is available and provider is enabled
      const provider = db.select().from(llmProviders).where(eq(llmProviders.id, id)).get()
      if (provider && provider.enabled && provider.apiKeyEncrypted) {
        const apiKey = decryptApiKey(provider.apiKeyEncrypted)
        const adapter = createAdapter(provider.type, apiKey, id)
        if (adapter) {
          registerAdapter(id, adapter)
        }
      } else {
        unregisterAdapter(id)
      }

      return { id, success: true }
    }
  )

  ipcMain.handle('provider:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    const db = getDb()
    unregisterAdapter(providerId)
    db.delete(llmProviders).where(eq(llmProviders.id, providerId)).run()
    return { success: true }
  })

  ipcMain.handle('provider:test', async (_event, providerId: string) => {
    userActivation.requireActivated()
    const db = getDb()
    const provider = db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.id, providerId))
      .get()

    if (!provider || !provider.apiKeyEncrypted) {
      return { success: false, error: 'No API key configured' }
    }

    try {
      const apiKey = decryptApiKey(provider.apiKeyEncrypted)
      const adapter = createAdapter(provider.type, apiKey, providerId)
      if (!adapter) {
        return { success: false, error: `Unsupported provider type: ${provider.type}` }
      }
      const models = await adapter.listModels()
      return { success: true, models }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(
    'provider:test-key',
    async (
      _event,
      data: { type: string; apiKey: string }
    ) => {
      try {
        const adapter = createAdapter(data.type, data.apiKey, '__test__')
        if (!adapter) {
          return { success: false, error: `Unsupported provider type: ${data.type}` }
        }
        const models = await adapter.listModels()
        return { success: true, models }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle('provider:list-models', async () => {
    userActivation.requireActivated()
    return getAllModels()
  })
}
