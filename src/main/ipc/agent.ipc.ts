import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents } from '../db/schema'
import { encryptApiKey } from '../security/keystore'
import { registerA2AHandlers } from './agent_a2a.ipc'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { syncRemoteAgents } from '../agents/remote-sync'

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
      source: a.source,
      remoteTargetType: a.remoteTargetType,
      remoteTargetId: a.remoteTargetId,
      remoteMetadata: a.remoteMetadata,
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
      const userId = getCurrentUserId()

      const existing = data.id
        ? db
            .select()
            .from(agents)
            .where(and(eq(agents.id, data.id), eq(agents.userId, userId)))
            .get()
        : null

      if (data.id && !existing) {
        // Either no such agent, or it belongs to another user — don't leak the distinction.
        return { success: false, error: 'Agent not found' }
      }

      const tokenEnc = data.accessToken
        ? encryptApiKey(data.accessToken)
        : existing?.accessTokenEncrypted ?? null

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
    // Prevent deleting remote agents — they are managed by sync
    const agent = db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.userId, userId))).get()
    if (agent?.source === 'remote') {
      return { success: false, error: 'Remote agents cannot be deleted — they are managed by Cinna sync' }
    }
    db.delete(agents).where(and(eq(agents.id, agentId), eq(agents.userId, userId))).run()
    return { success: true }
  })

  // Sync remote agents from Cinna backend
  ipcMain.handle('agent:sync-remote', async () => {
    userActivation.requireActivated()
    const userId = getCurrentUserId()
    try {
      const result = await syncRemoteAgents(userId)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // A2A protocol-specific handlers
  registerA2AHandlers()
}
