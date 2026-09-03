import { and, eq, isNotNull } from 'drizzle-orm'
import { sep } from 'node:path'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import {
  agents,
  a2aSessions,
  agentOverrides,
  chatOnDemandAgents,
  chats,
  jobAgents,
  jobs,
  messages
} from './schema'
import type { RemoteAgentMetadata } from '../../shared/agentMetadata'
import { FOLDER_AGENT_PROTOCOL } from '../../shared/localAgents'

/** True when `child` is `parent` or sits beneath it, by path segment. */
function isUnder(parent: string, child: string): boolean {
  if (parent === '' || child === '') return false
  const base = parent.endsWith(sep) ? parent.slice(0, -1) : parent
  return child === base || child.startsWith(base + sep)
}

/** The transaction handle `db.transaction` hands a callback. */
type FolderIndexTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

export type AgentRow = typeof agents.$inferSelect
export type A2ASessionRow = typeof a2aSessions.$inferSelect
export type AgentOverrideRow = typeof agentOverrides.$inferSelect

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
  /** Marks a local agent auto-created from a synced job dependency descriptor. */
  createdBySync?: boolean
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

/**
 * One scanned folder agent, as the scanner derived it from the folder. The row
 * is a cache over the files (Invariant 1) — only what the agents list and the
 * chat surfaces need is stored; the manifest itself is re-read on demand.
 */
export interface FolderIndexEntry {
  /** `folder:<manifest id>`. */
  id: string
  name: string
  description: string | null
  /** Absolute path of the agent folder. */
  localPath: string
}

/** What {@link agentRepo.rekeyFolderRow} moved. */
export interface RekeyFolderRowResult {
  /** False when there was no such row, or the target id is already taken. */
  moved: boolean
  /** Rows repointed, per table — logged, and what the tests assert on. */
  repointed: Record<string, number>
}

export interface ReplaceFolderIndexResult {
  indexed: number
  pruned: number
}

export const agentRepo = {
  list(userId: string): AgentRow[] {
    return getDb().select().from(agents).where(eq(agents.userId, userId)).all()
  },

  /** Remote-synced agents that carry a backend UUID (`remoteTargetId`). */
  listRemote(userId: string): AgentRow[] {
    return getDb()
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.userId, userId),
          eq(agents.source, 'remote'),
          isNotNull(agents.remoteTargetId)
        )
      )
      .all()
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
        createdBySync: input.createdBySync ?? false,
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
  },

  /** Folder agents (`source = 'folder'`) for a user, across every root. */
  listFolder(userId: string): AgentRow[] {
    return getDb()
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.source, 'folder')))
      .all()
  },

  /**
   * Rebuild the folder-agent index for one root: upsert every scanned folder
   * and drop the rows for that root that are no longer on disk — in a single
   * transaction, so a rescan is atomic and a mid-scan failure leaves the old
   * index intact. Same shape as {@link syncRemote}, with two differences that
   * matter:
   *
   * * **`enabled` is never overwritten.** It is the user's toggle, not
   *   something the folder states, so it survives every rescan.
   * * **Pruning is scoped to `rootId`.** An agent folder moved between roots
   *   keeps its row (its `localRootId` is repointed by the upsert), so its
   *   chats and A2A sessions stay attached.
   *
   * `unresolvedPaths` lists folders that are **on disk but whose identity could
   * not be read** — an unparseable manifest, or one with no `id` yet. They
   * cannot appear in `entries` (there is no id to key them by), and pruning
   * their rows would be destructive rather than merely wrong: `a2a_sessions`
   * and `job_agents` both cascade from `agents.id`, so dropping the row takes
   * the engine session with it and no later fix brings it back. A manifest is
   * briefly unparseable every time an assistant edits the folder — the designed
   * workflow — so this is the common case, not the exotic one. Their rows are
   * held back from the prune; readiness is what changes, never identity.
   *
   * The caller must not hand in an empty `entries` list for a root it could not
   * read — that would prune every agent of a temporarily-unavailable root and
   * cascade-delete their sessions. `scannerService` refuses that case.
   */
  replaceFolderIndex(
    userId: string,
    rootId: string,
    entries: FolderIndexEntry[],
    unresolvedPaths: readonly string[] = [],
    rootPath?: string
  ): ReplaceFolderIndexResult {
    const db = getDb()
    return db.transaction((tx) => {
      const protectedPaths = new Set(unresolvedPaths)
      const seen = new Set<string>()
      let indexed = 0

      for (const entry of entries) {
        seen.add(entry.id)
        const existing = tx
          .select()
          .from(agents)
          .where(and(eq(agents.id, entry.id), eq(agents.userId, userId)))
          .get()

        if (existing) {
          tx.update(agents)
            .set({
              name: entry.name,
              description: entry.description,
              source: 'folder',
              localPath: entry.localPath,
              localRootId: rootId
            })
            .where(and(eq(agents.id, entry.id), eq(agents.userId, userId)))
            .run()
        } else {
          tx.insert(agents)
            .values({
              id: entry.id,
              userId,
              name: entry.name,
              description: entry.description,
              protocol: FOLDER_AGENT_PROTOCOL,
              cardUrl: null,
              endpointUrl: null,
              protocolInterfaceUrl: null,
              protocolInterfaceVersion: null,
              accessTokenEncrypted: null,
              cardData: null,
              skills: null,
              // `enabled` means one thing only: the user's toggle. It is never
              // overwritten by a rescan, and it must not be borrowed to express
              // "no runner exists yet" — the two would be indistinguishable the
              // moment one does, so nothing could safely turn them back on.
              // That restriction lives in the two pickers that present agents
              // as counterparties, where it can be deleted rather than migrated.
              enabled: true,
              source: 'folder',
              localPath: entry.localPath,
              localRootId: rootId,
              createdAt: new Date()
            })
            .run()
        }
        indexed++
      }

      const pruned = pruneFolderRows(tx, userId, rootId, seen, protectedPaths, rootPath)
      return { indexed, pruned }
    })
  },

  /**
   * Update one folder row's index fields. The single-folder counterpart of
   * {@link replaceFolderIndex}, for a rescan that knows exactly which agent
   * changed. `enabled` is untouched, as everywhere else.
   */
  updateFolderIndex(
    userId: string,
    agentId: string,
    patch: {
      name: string
      description: string | null
      localPath: string
      localRootId: string
    }
  ): void {
    getDb()
      .update(agents)
      .set({
        name: patch.name,
        description: patch.description,
        localPath: patch.localPath,
        localRootId: patch.localRootId
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .run()
  },

  /**
   * Move a folder agent's row — and everything that points at it — to a new id.
   *
   * The one caller is "Stamp identity": a legacy folder gains a durable
   * `id`, so `folder:legacy:<rootId>:<name>` becomes `folder:<uuid>`. Letting
   * the ordinary scan do that is an insert plus a prune, and the prune cascades
   * `a2a_sessions`, `chat_on_demand_agents` and `job_agents` away while leaving
   * `chats.agent_id` and `jobs.agent_id` dangling, because neither declares a
   * foreign key. That is precisely backwards: the action is *offered* as the
   * cure for "this folder loses its chats if you rename it", so performing it
   * must not lose them.
   *
   * **This is not the same event as a manifest id changing on disk.** An
   * assistant editing `id` is a new identity claim about the folder, and the
   * scanner is right to treat it as a different agent. Stamping is the desktop
   * completing an identity the folder always had; the rows follow it.
   *
   * Written as insert-copy → repoint → delete rather than `UPDATE agents SET
   * id`, so it needs no `defer_foreign_keys`: while both rows exist the children
   * are moved onto the new one, and by the time the old row is deleted nothing
   * references it, so its `ON DELETE CASCADE` removes nothing.
   */
  rekeyFolderRow(userId: string, oldId: string, newId: string): RekeyFolderRowResult {
    if (oldId === newId) return { moved: false, repointed: {} }
    const db = getDb()
    return db.transaction((tx) => {
      const row = tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, oldId), eq(agents.userId, userId)))
        .get()
      if (!row) return { moved: false, repointed: {} }
      // Astronomically unlikely (the id is a fresh UUID), but a collision here
      // would merge two agents' histories. Refuse and let the caller fall back
      // to the ordinary rescan, which is lossy but never wrong.
      const clash = tx.select().from(agents).where(eq(agents.id, newId)).get()
      if (clash) return { moved: false, repointed: {} }

      tx.insert(agents).values({ ...row, id: newId }).run()

      const repointed: Record<string, number> = {}
      const count = (table: string, changes: number): void => {
        if (changes > 0) repointed[table] = changes
      }
      // Foreign-key children first, while both parent rows exist.
      count(
        'a2a_sessions',
        tx.update(a2aSessions).set({ agentId: newId }).where(eq(a2aSessions.agentId, oldId)).run()
          .changes
      )
      count(
        'chat_on_demand_agents',
        tx
          .update(chatOnDemandAgents)
          .set({ agentId: newId })
          .where(eq(chatOnDemandAgents.agentId, oldId))
          .run().changes
      )
      count(
        'job_agents',
        tx.update(jobAgents).set({ agentId: newId }).where(eq(jobAgents.agentId, oldId)).run()
          .changes
      )
      // Columns that name an agent with no foreign key behind them. These are
      // the ones a cascade would have missed entirely: they do not disappear
      // when the row does, they just stop resolving.
      count(
        'chats',
        tx
          .update(chats)
          .set({ agentId: newId })
          .where(and(eq(chats.agentId, oldId), eq(chats.userId, userId)))
          .run().changes
      )
      count(
        'jobs',
        tx
          .update(jobs)
          .set({ agentId: newId })
          .where(and(eq(jobs.agentId, oldId), eq(jobs.userId, userId)))
          .run().changes
      )
      count(
        'agent_overrides',
        tx
          .update(agentOverrides)
          .set({ agentId: newId })
          .where(and(eq(agentOverrides.agentId, oldId), eq(agentOverrides.userId, userId)))
          .run().changes
      )
      // Message-level attributions: which agent a turn was addressed to, which
      // produced it, which backs an orchestrated tool call. They drive the
      // per-agent colour and the sub-thread grouping, so a stale id here is a
      // visibly broken transcript rather than a lost row.
      count(
        'messages.addressed_agent_id',
        tx
          .update(messages)
          .set({ addressedAgentId: newId })
          .where(eq(messages.addressedAgentId, oldId))
          .run().changes
      )
      count(
        'messages.source_agent_id',
        tx
          .update(messages)
          .set({ sourceAgentId: newId })
          .where(eq(messages.sourceAgentId, oldId))
          .run().changes
      )
      count(
        'messages.tool_agent_id',
        tx.update(messages).set({ toolAgentId: newId }).where(eq(messages.toolAgentId, oldId)).run()
          .changes
      )

      tx.delete(agents)
        .where(and(eq(agents.id, oldId), eq(agents.userId, userId)))
        .run()
      return { moved: true, repointed }
    })
  },

  /**
   * Drop every folder-agent row belonging to a root — what removing a root
   * does. The folder itself is never touched; only the index is.
   */
  pruneFolderIndexForRoot(userId: string, rootId: string): number {
    const db = getDb()
    return db.transaction((tx) => pruneFolderRows(tx, userId, rootId, new Set(), new Set()))
  }
}

/**
 * Delete the folder rows of `rootId` whose ids are not in `keep` and whose
 * folder is not in `protectedPaths`. Written as a select-then-delete (rather
 * than one `NOT IN` statement) so the count is exact and the deletes stay
 * row-at-a-time — the same shape `syncRemote` uses.
 *
 * A row survives on either ground: its id was scanned (the folder is there and
 * readable), or its folder is there but unreadable. Only a folder that is
 * genuinely gone from disk satisfies neither.
 *
 * The rule underneath all three conditions: **a scan can only speak for the
 * folder it walked.** It has evidence about the agents under `rootPath` at this
 * moment and about nothing else — not a folder it could not parse, and not a
 * location the root used to have.
 */
function pruneFolderRows(
  tx: FolderIndexTx,
  userId: string,
  rootId: string,
  keep: ReadonlySet<string>,
  protectedPaths: ReadonlySet<string>,
  rootPath?: string
): number {
  const rows = tx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.source, 'folder'),
        eq(agents.localRootId, rootId)
      )
    )
    .all()

  let pruned = 0
  for (const row of rows) {
    if (keep.has(row.id)) continue
    if (row.localPath !== null && protectedPaths.has(row.localPath)) continue
    // A scan can only speak for the folder it walked. When the root's path has
    // moved, rows still pointing under the old location were not examined by
    // this scan, so it has no evidence they are gone — and deleting them would
    // cascade their sessions away for a condition that is merely "the setting
    // changed". They are re-adopted by the upsert if the home moves back, and
    // removed outright by `pruneFolderIndexForRoot` when the root is.
    if (rootPath !== undefined && row.localPath !== null && !isUnder(rootPath, row.localPath)) {
      continue
    }
    tx.delete(agents)
      .where(and(eq(agents.id, row.id), eq(agents.userId, userId)))
      .run()
    pruned++
  }
  return pruned
}

/**
 * Per-profile enable/disable overrides for sync-managed agents. Sync owns the
 * `agents` row, so we keep the user's manual toggle here — survives sync
 * rewrites and only impacts whether the agent appears in selectors.
 */
export const agentOverrideRepo = {
  listForUser(userId: string): AgentOverrideRow[] {
    return getDb()
      .select()
      .from(agentOverrides)
      .where(eq(agentOverrides.userId, userId))
      .all()
  },

  get(userId: string, agentId: string): AgentOverrideRow | undefined {
    return getDb()
      .select()
      .from(agentOverrides)
      .where(and(eq(agentOverrides.userId, userId), eq(agentOverrides.agentId, agentId)))
      .get()
  },

  set(userId: string, agentId: string, enabled: boolean): void {
    const db = getDb()
    const existing = this.get(userId, agentId)
    const now = new Date()
    if (existing) {
      db.update(agentOverrides)
        .set({ enabled, updatedAt: now })
        .where(and(eq(agentOverrides.userId, userId), eq(agentOverrides.agentId, agentId)))
        .run()
    } else {
      db.insert(agentOverrides)
        .values({ userId, agentId, enabled, updatedAt: now })
        .run()
    }
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
