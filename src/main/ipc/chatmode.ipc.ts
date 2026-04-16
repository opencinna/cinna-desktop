import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { chatModes } from '../db/schema'

export function registerChatModeHandlers(): void {
  ipcMain.handle('chatmode:list', async () => {
    const db = getDb()
    return db.select().from(chatModes).all()
  })

  ipcMain.handle('chatmode:get', async (_event, id: string) => {
    const db = getDb()
    return db.select().from(chatModes).where(eq(chatModes.id, id)).get() ?? null
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
      const db = getDb()
      const id = data.id ?? nanoid()

      if (data.id) {
        db.update(chatModes)
          .set({
            name: data.name,
            providerId: data.providerId ?? null,
            modelId: data.modelId ?? null,
            mcpProviderIds: data.mcpProviderIds ?? [],
            colorPreset: data.colorPreset ?? 'slate'
          })
          .where(eq(chatModes.id, data.id))
          .run()
      } else {
        db.insert(chatModes)
          .values({
            id,
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
    const db = getDb()
    db.delete(chatModes).where(eq(chatModes.id, id)).run()
    return { success: true }
  })
}
