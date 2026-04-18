import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { agents, a2aSessions } from './schema'
import type { RemoteAgentMetadata } from '../../shared/agentMetadata'

export type AgentRow = typeof agents.$inferSelect
export type A2ASessionRow = typeof a2aSessions.$inferSelect

export interface CreateAgentInput {
  id?: string
  name: string
  description?: string | null
  protocol: string
  cardUrl?: string | null
  endpointUrl?: string | null
  protocolInterfaceUrl?: string | null
  protocolInterfaceVersion?: string | null
  accessTokenEncrypted?: Buffer | null
  cardData?: Record<string, unknown> | null
  skills?: Array<{ id: string; name: string; description?: string }> | null
  enabled?: boolean
}

export interface UpdateAgentInput {
  name?: string
  description?: string | null
  protocol?: string
  cardUrl?: string | null
  endpointUrl?: string | null
  protocolInterfaceUrl?: string | null
  protocolInterfaceVersion?: string | null
  accessTokenEncrypted?: Buffer | null
  cardData?: Record<string, unknown> | null
  skills?: Array<{ id: string; name: string; description?: string }> | null
  enabled?: boolean
}

export interface RemoteTarget {
  targetType: 'agent' | 'app_mcp_route' | 'identity'
  targetId: string
  name: string
  description: string | null
  cardUrl: string
  skills: Array<{ id: string; name: string; description?: string }> | null
  metadata: RemoteAgentMetadata
}

export interface SyncRemoteResult {
  synced: number
  removed: number
}

export const agentRepo = {
  list(userId: string): AgentRow[] {
    return getDb().select().from(agents).where(eq(agents.userId, userId)).all()
  },

  getOwned(userId: string, agentId: string): AgentRow | undefined {
    return getDb()
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .get()
  },

  create(userId: string, input: CreateAgentInput): AgentRow {
    const db = getDb()
    const id = input.id ?? nanoid()
    db.insert(agents)
      .values({
        id,
        userId,
        name: input.name,
        description: input.description ?? null,
        protocol: input.protocol,
        cardUrl: input.cardUrl ?? null,
        endpointUrl: input.endpointUrl ?? null,
        protocolInterfaceUrl: input.protocolInterfaceUrl ?? null,
        protocolInterfaceVersion: input.protocolInterfaceVersion ?? null,
        accessTokenEncrypted: input.accessTokenEncrypted ?? null,
        cardData: input.cardData ?? null,
        skills: input.skills ?? null,
        enabled: input.enabled ?? true,
        source: 'local',
        createdAt: new Date()
      })
      .run()
    const row = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, userId)))
      .get()
    if (!row) throw new Error('Failed to load agent after insert')
    return row
  },

  update(userId: string, agentId: string, input: UpdateAgentInput): AgentRow | undefined {
    const db = getDb()
    const existing = this.getOwned(userId, agentId)
    if (!existing) return undefined
    db.update(agents)
      .set({
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        protocol: input.protocol ?? existing.protocol,
        cardUrl: input.cardUrl !== undefined ? input.cardUrl : existing.cardUrl,
        endpointUrl: input.endpointUrl !== undefined ? input.endpointUrl : existing.endpointUrl,
        protocolInterfaceUrl:
          input.protocolInterfaceUrl !== undefined
            ? input.protocolInterfaceUrl
            : existing.protocolInterfaceUrl,
        protocolInterfaceVersion:
          input.protocolInterfaceVersion !== undefined
            ? input.protocolInterfaceVersion
            : existing.protocolInterfaceVersion,
        accessTokenEncrypted:
          input.accessTokenEncrypted !== undefined
            ? input.accessTokenEncrypted
            : existing.accessTokenEncrypted,
        cardData: input.cardData !== undefined ? input.cardData : existing.cardData,
        skills: input.skills !== undefined ? input.skills : existing.skills,
        enabled: input.enabled ?? existing.enabled
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .run()
    return this.getOwned(userId, agentId)
  },

  delete(userId: string, agentId: string): boolean {
    const result = getDb()
      .delete(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .run()
    return result.changes > 0
  },

  updateResolvedEndpoint(
    userId: string,
    agentId: string,
    patch: {
      endpointUrl: string
      protocolInterfaceUrl: string
      protocolInterfaceVersion: string
    }
  ): void {
    getDb()
      .update(agents)
      .set({
        endpointUrl: patch.endpointUrl,
        protocolInterfaceUrl: patch.protocolInterfaceUrl,
        protocolInterfaceVersion: patch.protocolInterfaceVersion
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .run()
  },

  updateCardCache(
    userId: string,
    agentId: string,
    patch: {
      cardData: Record<string, unknown>
      skills: Array<{ id: string; name: string; description?: string }> | null
      endpointUrl: string
      protocolInterfaceUrl: string
      protocolInterfaceVersion: string
    }
  ): void {
    getDb()
      .update(agents)
      .set({
        cardData: patch.cardData,
        skills: patch.skills,
        endpointUrl: patch.endpointUrl,
        protocolInterfaceUrl: patch.protocolInterfaceUrl,
        protocolInterfaceVersion: patch.protocolInterfaceVersion
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .run()
  },

  /**
   * Sync remote agents from a backend listing. Upserts each target and prunes
   * local remote agents no longer in the listing — all inside a single
   * transaction so a mid-sync failure rolls the whole change back.
   */
  syncRemote(userId: string, targets: RemoteTarget[]): SyncRemoteResult {
    const db = getDb()
    return db.transaction((tx) => {
      const remoteIds = new Set<string>()
      let synced = 0

      for (const target of targets) {
        const localId = `remote:${target.targetType}:${target.targetId}`
        remoteIds.add(localId)

        const existing = tx
          .select()
          .from(agents)
          .where(and(eq(agents.id, localId), eq(agents.userId, userId)))
          .get()

        if (existing) {
          tx.update(agents)
            .set({
              name: target.name,
              description: target.description,
              cardUrl: target.cardUrl,
              skills: target.skills,
              remoteTargetType: target.targetType,
              remoteTargetId: target.targetId,
              remoteMetadata: target.metadata
            })
            .where(and(eq(agents.id, localId), eq(agents.userId, userId)))
            .run()
        } else {
          tx.insert(agents)
            .values({
              id: localId,
              userId,
              name: target.name,
              description: target.description,
              protocol: 'a2a',
              cardUrl: target.cardUrl,
              endpointUrl: null,
              protocolInterfaceUrl: null,
              protocolInterfaceVersion: null,
              accessTokenEncrypted: null,
              cardData: null,
              skills: target.skills,
              enabled: true,
              source: 'remote',
              remoteTargetType: target.targetType,
              remoteTargetId: target.targetId,
              remoteMetadata: target.metadata,
              createdAt: new Date()
            })
            .run()
        }
        synced++
      }

      const localRemote = tx
        .select()
        .from(agents)
        .where(and(eq(agents.userId, userId), eq(agents.source, 'remote')))
        .all()

      let removed = 0
      for (const agent of localRemote) {
        if (!remoteIds.has(agent.id)) {
          tx.delete(agents)
            .where(and(eq(agents.id, agent.id), eq(agents.userId, userId)))
            .run()
          removed++
        }
      }

      return { synced, removed }
    })
  }
}

/**
 * A2A session state is tied to a chat — callers must pre-verify chat
 * ownership (via {@link chatRepo.getOwned}) before using these methods.
 */
export const a2aSessionRepo = {
  getByChat(chatId: string): A2ASessionRow | undefined {
    return getDb()
      .select()
      .from(a2aSessions)
      .where(eq(a2aSessions.chatId, chatId))
      .get()
  },

  getByChatAndAgent(chatId: string, agentId: string): A2ASessionRow | undefined {
    return getDb()
      .select()
      .from(a2aSessions)
      .where(and(eq(a2aSessions.chatId, chatId), eq(a2aSessions.agentId, agentId)))
      .get()
  },

  upsert(patch: {
    chatId: string
    agentId: string
    contextId: string | null
    taskId: string | null
    taskState: string | null
  }): void {
    const db = getDb()
    const existing = db
      .select()
      .from(a2aSessions)
      .where(
        and(eq(a2aSessions.chatId, patch.chatId), eq(a2aSessions.agentId, patch.agentId))
      )
      .get()
    const now = new Date()
    if (existing) {
      db.update(a2aSessions)
        .set({
          contextId: patch.contextId ?? existing.contextId,
          taskId: patch.taskId ?? existing.taskId,
          taskState: patch.taskState ?? existing.taskState,
          updatedAt: now
        })
        .where(eq(a2aSessions.id, existing.id))
        .run()
    } else {
      db.insert(a2aSessions)
        .values({
          id: nanoid(),
          chatId: patch.chatId,
          agentId: patch.agentId,
          contextId: patch.contextId,
          taskId: patch.taskId,
          taskState: patch.taskState,
          createdAt: now,
          updatedAt: now
        })
        .run()
    }
  }
}
