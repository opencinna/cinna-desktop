import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { agents, chats, managedAgentSessions } from './schema'
import { agentSessionRepo } from './agents'

export interface ManagedCheckpoint {
  sessionId: string
  state: 'ready' | 'inflight' | 'uncertain' | 'budget'
}

export const managedAgentSessionRepo = {
  get(profileId: string, chatId: string, agentId: string, binding: string): ManagedCheckpoint | null {
    const row = getDb().select({ session: managedAgentSessions }).from(managedAgentSessions)
      .innerJoin(chats, eq(chats.id, managedAgentSessions.chatId))
      .where(and(eq(chats.userId, profileId), eq(managedAgentSessions.chatId, chatId), eq(managedAgentSessions.agentId, agentId))).get()?.session
    if (!row) return null
    if (row.binding !== binding) throw new Error('This chat’s Managed session belongs to a different configuration or credential. Start a new chat.')
    if (!['ready', 'inflight', 'uncertain', 'budget'].includes(row.state)) throw new Error('This Managed session has an unsupported saved state. Start a new chat.')
    return { sessionId: row.sessionId, state: row.state as ManagedCheckpoint['state'] }
  },

  save(profileId: string, ownerId: string, chatId: string, agentId: string, binding: string, checkpoint: ManagedCheckpoint): void {
    getDb().transaction((tx) => {
      if (!tx.select({ id: chats.id }).from(chats).where(and(eq(chats.id, chatId), eq(chats.userId, profileId))).get() ||
        !tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.userId, ownerId))).get()) {
        throw new Error('This Managed conversation is no longer available.')
      }
      const existing = tx.select().from(managedAgentSessions).where(and(eq(managedAgentSessions.chatId, chatId), eq(managedAgentSessions.agentId, agentId))).get()
      if (existing && (existing.binding !== binding || existing.sessionId !== checkpoint.sessionId)) throw new Error('This Managed session binding changed.')
      if (existing) tx.update(managedAgentSessions).set({ state: checkpoint.state, updatedAt: new Date() }).where(eq(managedAgentSessions.id, existing.id)).run()
      else tx.insert(managedAgentSessions).values({ id: nanoid(), chatId, agentId, binding, ...checkpoint }).run()
      agentSessionRepo.upsert({ chatId, agentId, contextId: checkpoint.sessionId, taskId: null, taskState: null })
    })
  }
}
