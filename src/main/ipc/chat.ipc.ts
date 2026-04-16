import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, desc, isNull, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { chats, messages } from '../db/schema'

export function registerChatHandlers(): void {
  ipcMain.handle('chat:list', async () => {
    const db = getDb()
    return db.select().from(chats).where(isNull(chats.deletedAt)).orderBy(desc(chats.updatedAt))
  })

  ipcMain.handle('chat:get', async (_event, chatId: string) => {
    const db = getDb()
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat) return null

    const msgs = db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(messages.sortOrder)
      .all()

    return { ...chat, messages: msgs }
  })

  ipcMain.handle('chat:create', async () => {
    const db = getDb()
    const id = nanoid()
    const now = new Date()
    const chat = {
      id,
      title: 'New Chat',
      modelId: null,
      providerId: null,
      createdAt: now,
      updatedAt: now
    }
    db.insert(chats).values(chat).run()
    return chat
  })

  // Soft delete — move to trash
  ipcMain.handle('chat:delete', async (_event, chatId: string) => {
    const db = getDb()
    db.update(chats)
      .set({ deletedAt: new Date() })
      .where(eq(chats.id, chatId))
      .run()
    return { success: true }
  })

  // Trash: list soft-deleted chats
  ipcMain.handle('chat:trash-list', async () => {
    const db = getDb()
    return db.select().from(chats).where(isNotNull(chats.deletedAt)).orderBy(desc(chats.deletedAt))
  })

  // Trash: restore a chat
  ipcMain.handle('chat:restore', async (_event, chatId: string) => {
    const db = getDb()
    db.update(chats)
      .set({ deletedAt: null })
      .where(eq(chats.id, chatId))
      .run()
    return { success: true }
  })

  // Trash: permanently delete a single chat
  ipcMain.handle('chat:permanent-delete', async (_event, chatId: string) => {
    const db = getDb()
    db.delete(chats).where(eq(chats.id, chatId)).run()
    return { success: true }
  })

  // Trash: empty all trashed chats
  ipcMain.handle('chat:empty-trash', async () => {
    const db = getDb()
    db.delete(chats).where(isNotNull(chats.deletedAt)).run()
    return { success: true }
  })

  ipcMain.handle(
    'chat:update',
    async (
      _event,
      chatId: string,
      updates: { title?: string; modelId?: string; providerId?: string; modeId?: string; agentId?: string }
    ) => {
      const db = getDb()
      db.update(chats)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(chats.id, chatId))
        .run()
      return { success: true }
    }
  )

  ipcMain.handle(
    'chat:add-message',
    async (
      _event,
      chatId: string,
      message: {
        role: string
        content: string
        toolCallId?: string
        toolName?: string
        toolInput?: Record<string, unknown>
      }
    ) => {
      const db = getDb()

      // Get next sort order
      const lastMsg = db
        .select({ sortOrder: messages.sortOrder })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.sortOrder))
        .limit(1)
        .get()

      const sortOrder = lastMsg ? lastMsg.sortOrder + 1 : 0
      const id = nanoid()

      const msg = {
        id,
        chatId,
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId ?? null,
        toolName: message.toolName ?? null,
        toolInput: message.toolInput ?? null,
        sortOrder,
        createdAt: new Date()
      }

      db.insert(messages).values(msg).run()
      db.update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, chatId))
        .run()

      return msg
    }
  )
}
