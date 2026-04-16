import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents } from '../db/schema'
import { encryptApiKey } from '../security/keystore'
import { registerA2AHandlers } from './agent_a2a.ipc'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:list', async () => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    const all = db.select().from(agents).where(eq(agents.userId, userId)).all()
    return all.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      protocol: a.protocol,
      cardUrl: a.cardUrl,
      endpointUrl: a.endpointUrl,
      protocolInterfaceUrl: a.protocolInterfaceUrl,
      protocolInterfaceVersion: a.protocolInterfaceVersion,
      hasAccessToken: !!a.accessTokenEncrypted,
      cardData: a.cardData,
      skills: a.skills,
      enabled: a.enabled,
      createdAt: a.createdAt
    }))
  })

  ipcMain.handle(
    'agent:upsert',
    async (
      _event,
      data: {
        id?: string
        name: string
        description?: string
        protocol: string
        cardUrl?: string
        endpointUrl?: string
        protocolInterfaceUrl?: string
        protocolInterfaceVersion?: string
        accessToken?: string
        cardData?: Record<string, unknown>
        skills?: Array<{ id: string; name: string; description?: string }>
        enabled?: boolean
      }
    ) => {
      userActivation.requireActivated()
      const db = getDb()
      const id = data.id || nanoid()

      const existing = data.id
        ? db.select().from(agents).where(eq(agents.id, data.id)).get()
        : null

      const tokenEnc = data.accessToken
        ? encryptApiKey(data.accessToken)
        : existing?.accessTokenEncrypted ?? null

      const userId = getCurrentUserId()

      if (existing) {
        db.update(agents)
          .set({
            name: data.name,
            description: data.description ?? existing.description,
            protocol: data.protocol,
            cardUrl: data.cardUrl ?? existing.cardUrl,
            endpointUrl: data.endpointUrl ?? existing.endpointUrl,
            protocolInterfaceUrl: data.protocolInterfaceUrl ?? existing.protocolInterfaceUrl,
            protocolInterfaceVersion: data.protocolInterfaceVersion ?? existing.protocolInterfaceVersion,
            accessTokenEncrypted: tokenEnc,
            cardData: data.cardData ?? existing.cardData,
            skills: data.skills ?? existing.skills,
            enabled: data.enabled ?? existing.enabled
          })
          .where(and(eq(agents.id, id), eq(agents.userId, userId)))
          .run()
      } else {
        db.insert(agents)
          .values({
            id,
            userId,
            name: data.name,
            description: data.description ?? null,
            protocol: data.protocol,
            cardUrl: data.cardUrl ?? null,
            endpointUrl: data.endpointUrl ?? null,
            protocolInterfaceUrl: data.protocolInterfaceUrl ?? null,
            protocolInterfaceVersion: data.protocolInterfaceVersion ?? null,
            accessTokenEncrypted: tokenEnc,
            cardData: data.cardData ?? null,
            skills: data.skills ?? null,
            enabled: data.enabled ?? true,
            createdAt: new Date()
          })
          .run()
      }

      return { id, success: true }
    }
  )

  ipcMain.handle('agent:delete', async (_event, agentId: string) => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    db.delete(agents).where(and(eq(agents.id, agentId), eq(agents.userId, userId))).run()
    return { success: true }
  })

  // A2A protocol-specific handlers
  registerA2AHandlers()
}
