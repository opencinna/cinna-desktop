import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client'
import { chatModes } from '../db/schema'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'

export function registerChatModeHandlers(): void {
  ipcMain.handle('chatmode:list', async () => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    return db.select().from(chatModes).where(eq(chatModes.userId, userId)).all()
  })

  ipcMain.handle('chatmode:get', async (_event, id: string) => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    return (
      db
        .select()
        .from(chatModes)
        .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
        .get() ?? null
    )
  })

  ipcMain.handle(
    'chatmode:upsert',
    async (
      _event,
      data: {
        id?: string
        name: string
        providerId?: string | null
        modelId?: string | null
        mcpProviderIds?: string[]
        colorPreset?: string
      }
    ) => {
      userActivation.requireActivated()
      const db = getDb()
      const id = data.id ?? nanoid()
      const userId = getCurrentUserId()

      if (data.id) {
        db.update(chatModes)
          .set({
            name: data.name,
            providerId: data.providerId ?? null,
            modelId: data.modelId ?? null,
            mcpProviderIds: data.mcpProviderIds ?? [],
            colorPreset: data.colorPreset ?? 'slate'
          })
          .where(and(eq(chatModes.id, data.id), eq(chatModes.userId, userId)))
          .run()
      } else {
        db.insert(chatModes)
          .values({
            id,
            userId,
            name: data.name,
            providerId: data.providerId ?? null,
            modelId: data.modelId ?? null,
            mcpProviderIds: data.mcpProviderIds ?? [],
            colorPreset: data.colorPreset ?? 'slate',
            createdAt: new Date()
          })
          .run()
      }

      return { id, success: true }
    }
  )

  ipcMain.handle('chatmode:delete', async (_event, id: string) => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    db.delete(chatModes).where(and(eq(chatModes.id, id), eq(chatModes.userId, userId))).run()
    return { success: true }
  })
}
