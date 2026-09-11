import { notesRepo, noteFoldersRepo } from '../db/notes'
import { jobsRepo, jobFoldersRepo } from '../db/jobs'
import { taskRepo } from '../db/tasks'
import { taskService } from '../services/taskService'
import { buildJobManifest, buildTaskAssigneeRef } from './manifest'
import {
  resolveMode,
  resolveMcp,
  resolveFolderAgent,
  resolveLocalAgent,
  resolveRemoteAgent,
  resolveTaskAssignee,
  profileServerUrl,
  newResolveCache,
  type ResolveCache
} from './resolvers'
import type { SyncCollection, JobDepDescriptor, JobSyncManifest } from '../../shared/sync'
import type { TaskStatus } from '../../shared/taskStatus'
import type {
  TaskArtifact,
  TaskAssignee,
  TaskBudget,
  TaskExecutor,
  TaskOrigin,
  TaskPriority,
  TaskRouter
} from '../../shared/tasks'
import { createLogger } from '../logger/logger'

/**
 * Per-collection encode/decode. `client_entity_id` is the row's existing
 * `nanoid` PK. Notes/folders carry their referenced rows' nanoids verbatim
 * (genuinely shared ids). Jobs carry a **portable dependency manifest**
 * (`{modeName, deps[]}`) instead of device-local agent/MCP/mode ids — see
 * `plans/data-sync-portable-deps.md`. The manifest is the synced truth; the
 * join rows + `modeId` are the materialized resolvable subset.
 *
 * All DB access goes through the domain repositories; every write is scoped to
 * the owning user there. This module is pure mapping: row → payload and
 * payload → repo call, with descriptor resolution delegated to `resolvers.ts`.
 */

/** A local row staged for push. */
export interface DirtyRecord {
  collection: SyncCollection
  clientEntityId: string
  /** Plaintext object to encrypt (canonical-JSON'd by the crypto layer). */
  plaintext: Record<string, unknown>
  /** Soft-deleted (deletedAt set) → carried as deleted=true upsert. */
  deleted: boolean
  /** ms epoch — drives LWW and the dirty watermark. */
  clientUpdatedAt: number
}

/**
 * Context threaded into `apply` for one sync drain pass. `clientUpdatedAt` is
 * the peer's timestamp (carried onto the row verbatim — no `new Date()` bump,
 * so an applied copy stays a passive replica). `cache` dedupes auto-created
 * dependencies across the pass so N jobs referencing the same missing MCP
 * create exactly one provider.
 */
const logger = createLogger('sync-collections')

export interface ApplyContext {
  clientUpdatedAt: number
  cache: ResolveCache
}

export { newResolveCache, type ResolveCache }

export interface CollectionMapper {
  collection: SyncCollection
  /** Rows changed since `sinceMs` (exclusive). */
  listDirty(userId: string, sinceMs: number): DirtyRecord[]
  /** Latest local updatedAt across this collection (for advancing the watermark). */
  maxUpdatedAt(userId: string): number
  /**
   * Apply a decoded record from a pull. `plaintext` is null for a hard-delete
   * (tombstone); otherwise upsert by PK. `deleted` reflects the wire flag.
   */
  apply(
    userId: string,
    clientEntityId: string,
    plaintext: Record<string, unknown> | null,
    deleted: boolean,
    ctx: ApplyContext
  ): void
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function dateOrNull(v: unknown): Date | null {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v) : null
}
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
function dateOr(v: unknown, fallback: Date): Date {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v) : fallback
}
function msOrNull(d: Date | null): number | null {
  return d ? d.getTime() : null
}
/**
 * A wire value carried into a JSON column **verbatim**, with only the shape
 * check the column's own type needs.
 *
 * The same reasoning as the job manifest's `deps` (see `apply` below): a peer
 * on a newer build may put a field in here this build has never heard of, and
 * re-deriving from a narrowed view on the way back out would change the bytes
 * and make the server report a change on every sync for ever.
 */
function jsonObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function jsonArray<T>(v: unknown): T[] | null {
  return Array.isArray(v) ? (v as T[]) : null
}

// ---------------- note ----------------

const noteMapper: CollectionMapper = {
  collection: 'note',
  listDirty(userId, sinceMs) {
    return notesRepo.listChangedSince(userId, sinceMs).map((r) => ({
      collection: 'note' as const,
      clientEntityId: r.id,
      plaintext: {
        title: r.title,
        body: r.body,
        folderId: r.folderId ?? null,
        position: r.position,
        deletedAt: r.deletedAt ? r.deletedAt.getTime() : null
      },
      deleted: !!r.deletedAt,
      clientUpdatedAt: r.updatedAt.getTime()
    }))
  },
  maxUpdatedAt: (userId) => notesRepo.maxUpdatedAt(userId),
  apply(userId, id, plaintext, _deleted, ctx) {
    if (!plaintext) {
      notesRepo.deleteOwned(userId, id)
      return
    }
    notesRepo.upsertFromSync(userId, {
      id,
      title: str(plaintext.title) || 'Untitled note',
      body: str(plaintext.body),
      folderId: strOrNull(plaintext.folderId),
      position: num(plaintext.position),
      updatedAt: new Date(ctx.clientUpdatedAt),
      deletedAt: dateOrNull(plaintext.deletedAt)
    })
  }
}

// ---------------- note_folder ----------------

const noteFolderMapper: CollectionMapper = {
  collection: 'note_folder',
  listDirty(userId, sinceMs) {
    return noteFoldersRepo.listChangedSince(userId, sinceMs).map((r) => ({
      collection: 'note_folder' as const,
      clientEntityId: r.id,
      plaintext: { name: r.name, collapsed: r.collapsed, position: r.position },
      deleted: false,
      clientUpdatedAt: r.updatedAt.getTime()
    }))
  },
  maxUpdatedAt: (userId) => noteFoldersRepo.maxUpdatedAt(userId),
  apply(userId, id, plaintext, _deleted, ctx) {
    if (!plaintext) {
      noteFoldersRepo.deleteOwnedWithDetach(userId, id)
      return
    }
    noteFoldersRepo.upsertFromSync(userId, {
      id,
      name: str(plaintext.name) || 'Folder',
      collapsed: !!plaintext.collapsed,
      position: num(plaintext.position),
      updatedAt: new Date(ctx.clientUpdatedAt)
    })
  }
}

// ---------------- job_folder ----------------

const jobFolderMapper: CollectionMapper = {
  collection: 'job_folder',
  listDirty(userId, sinceMs) {
    return jobFoldersRepo.listChangedSince(userId, sinceMs).map((r) => ({
      collection: 'job_folder' as const,
      clientEntityId: r.id,
      plaintext: { name: r.name, collapsed: r.collapsed, position: r.position },
      deleted: false,
      clientUpdatedAt: r.updatedAt.getTime()
    }))
  },
  maxUpdatedAt: (userId) => jobFoldersRepo.maxUpdatedAt(userId),
  apply(userId, id, plaintext, _deleted, ctx) {
    if (!plaintext) {
      jobFoldersRepo.deleteOwnedWithDetach(userId, id)
      return
    }
    jobFoldersRepo.upsertFromSync(userId, {
      id,
      name: str(plaintext.name) || 'Folder',
      collapsed: !!plaintext.collapsed,
      position: num(plaintext.position),
      updatedAt: new Date(ctx.clientUpdatedAt)
    })
  }
}

// ---------------- job ----------------

/**
 * Defensively type-check a wire `deps` array into descriptors for
 * materialization. (The raw array is stored verbatim into `sync_deps` for
 * byte-stable re-encode — this typed view is only used to resolve join rows.)
 */
function parseDeps(v: unknown): JobDepDescriptor[] {
  if (!Array.isArray(v)) return []
  const out: JobDepDescriptor[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const d = item as Record<string, unknown>
    if (d.kind === 'mcp') {
      const t = d.transport
      if (t !== 'stdio' && t !== 'sse' && t !== 'streamable-http') continue
      out.push({
        kind: 'mcp',
        transport: t,
        url: strOrNull(d.url),
        command: strOrNull(d.command),
        args: Array.isArray(d.args) ? stringList(d.args) : null,
        name: str(d.name) || 'MCP',
        envKeys: Array.isArray(d.envKeys) ? stringList(d.envKeys) : undefined
      })
    } else if (d.kind === 'agent') {
      if (d.source === 'remote') {
        const remoteTargetId = str(d.remoteTargetId)
        const remoteTargetType = str(d.remoteTargetType)
        if (!remoteTargetId || !remoteTargetType) continue
        out.push({
          kind: 'agent',
          source: 'remote',
          remoteTargetType,
          remoteTargetId,
          serverUrl: strOrNull(d.serverUrl),
          name: typeof d.name === 'string' ? d.name : undefined
        })
      } else if (d.source === 'local') {
        const cardUrl = str(d.cardUrl)
        if (!cardUrl) continue
        out.push({
          kind: 'agent',
          source: 'local',
          cardUrl,
          name: typeof d.name === 'string' ? d.name : undefined
        })
      } else if (d.source === 'folder') {
        const manifestId = str(d.manifestId)
        if (!manifestId) continue
        out.push({
          kind: 'agent',
          source: 'folder',
          manifestId,
          name: typeof d.name === 'string' ? d.name : undefined
        })
      }
    }
  }
  return out
}

const jobMapper: CollectionMapper = {
  collection: 'job',
  listDirty(userId, sinceMs) {
    return jobsRepo.listChangedSince(userId, sinceMs).map((r) => {
      // Emit the stored manifest verbatim (byte-stable across the round trip).
      // Fall back to deriving it for any row that predates a manifest write.
      const manifest = r.syncDeps ?? buildJobManifest(userId, r)
      return {
        collection: 'job' as const,
        clientEntityId: r.id,
        plaintext: {
          title: r.title,
          description: r.description ?? null,
          prompt: r.prompt,
          type: r.type,
          colorPreset: r.colorPreset ?? null,
          iconName: r.iconName ?? null,
          folderId: r.folderId ?? null,
          position: r.position,
          cinnaAgentId: r.cinnaAgentId ?? null,
          cinnaPriority: r.cinnaPriority ?? null,
          modeName: manifest.modeName,
          deps: manifest.deps,
          deletedAt: r.deletedAt ? r.deletedAt.getTime() : null
        },
        deleted: !!r.deletedAt,
        clientUpdatedAt: r.updatedAt.getTime()
      }
    })
  },
  maxUpdatedAt: (userId) => jobsRepo.maxUpdatedAt(userId),
  apply(userId, id, plaintext, _deleted, ctx) {
    if (!plaintext) {
      jobsRepo.deleteOwned(userId, id)
      return
    }
    // Store the manifest VERBATIM (raw wire values) so a re-encode is
    // byte-identical to the sender's payload and the server returns `unchanged`.
    const manifest: JobSyncManifest = {
      modeName: strOrNull(plaintext.modeName),
      deps: (Array.isArray(plaintext.deps) ? plaintext.deps : []) as JobDepDescriptor[]
    }
    const modeId = resolveMode(manifest.modeName)
    const deletedAt = dateOrNull(plaintext.deletedAt)
    jobsRepo.upsertFromSync(userId, {
      id,
      type: str(plaintext.type) || 'local',
      title: str(plaintext.title) || 'Untitled job',
      description: strOrNull(plaintext.description),
      prompt: str(plaintext.prompt),
      modeId,
      cinnaAgentId: strOrNull(plaintext.cinnaAgentId),
      cinnaPriority: strOrNull(plaintext.cinnaPriority),
      colorPreset: strOrNull(plaintext.colorPreset),
      iconName: strOrNull(plaintext.iconName),
      folderId: strOrNull(plaintext.folderId),
      position: num(plaintext.position),
      syncDeps: manifest,
      updatedAt: new Date(ctx.clientUpdatedAt),
      deletedAt
    })

    // A trashed job needn't materialize anything (and must not auto-create
    // dependency shells). Otherwise resolve each descriptor → local join row,
    // auto-creating disabled MCP/local-agent shells on a miss.
    if (deletedAt) {
      jobsRepo.setRefsFromSync(userId, id, [], [])
      return
    }
    const agentIds: string[] = []
    const mcpIds: string[] = []
    for (const desc of parseDeps(manifest.deps)) {
      if (desc.kind === 'mcp') {
        mcpIds.push(resolveMcp(desc, ctx.cache))
      } else if (desc.source === 'remote') {
        const aid = resolveRemoteAgent(userId, desc, profileServerUrl(userId))
        if (aid) agentIds.push(aid) // foreign-server agent stays unresolved
      } else if (desc.source === 'folder') {
        // No auto-create, unlike the local-agent arm below: a folder agent is a
        // directory on disk, and a shell row would assert one exists here. A
        // miss stays out of the join rows and shows up as `manifestNeedsSetup`.
        const aid = resolveFolderAgent(desc)
        if (aid) {
          agentIds.push(aid)
        } else {
          // The single point at which a folder dependency stops being part of
          // this job on this device. The local-agent arm below logs its
          // auto-create, so without this the one arm of the three that drops
          // something — and the only one that cannot recover on its own — is
          // also the only one that leaves no trace.
          logger.warn('job depends on a folder agent this device does not have', {
            jobId: id,
            manifestId: desc.manifestId
          })
        }
      } else {
        agentIds.push(resolveLocalAgent(desc, ctx.cache))
      }
    }
    jobsRepo.setRefsFromSync(userId, id, agentIds, mcpIds)
  }
}

// ---------------- task ----------------

/**
 * The `kind: 'agent'` arm of a dependency descriptor, off the wire. Reuses
 * {@link parseDeps} so a task's assignee and a job's agent dependency are
 * validated by exactly one function — they are the same descriptor, and two
 * parsers for one shape is how the two would come to disagree about it.
 */
function parseAssigneeRef(v: unknown): Extract<JobDepDescriptor, { kind: 'agent' }> | null {
  const [first] = parseDeps([v])
  return first && first.kind === 'agent' ? first : null
}

/**
 * A task on the wire.
 *
 * Four columns are **absent by design**, in three groups, and every absence is
 * load-bearing:
 *
 *  - **`chat_id`.** Chats are not a synced collection, so an id from another
 *    device would name a row that does not exist here — and the task page would
 *    offer "Open the conversation" over nothing. A replica opens with no thread.
 *  - **`assignee_agent_id`.** An `agents` row id is device-local. The portable
 *    descriptor in `assignee_ref` travels in its place and is resolved on the
 *    way in, exactly as a job's agent dependency is — this is the problem
 *    `JobDepDescriptor` was built for and it is reused rather than reinvented.
 *  - **`remote_synced_at` / `remote_dirty`.** Per-device bookkeeping. A peer
 *    that has never spoken to that service must not inherit a watermark saying
 *    it has, nor a list of fields *this* device still owes it.
 *
 * What does travel is the **binding** (`remote_adapter`, `remote_id`,
 * `remote_key`, `remote_url`, `remote_state`), so a peer opens the same remote
 * task rather than creating a second one; and `executor_device`, which is the
 * whole point of it — it is how the other device knows not to run this.
 *
 * `job_id` / `job_run_id` are carried as-is and tolerated as dangling: jobs
 * sync and job *runs* do not, so a replica knows which job a task came from and
 * shows that job's title, never the run.
 */
const taskMapper: CollectionMapper = {
  collection: 'task',
  listDirty(userId, sinceMs) {
    return taskRepo.listChangedSince(userId, sinceMs).map((r) => ({
      collection: 'task' as const,
      clientEntityId: r.id,
      plaintext: {
        title: r.title,
        goal: r.goal,
        description: r.description ?? null,
        status: r.status,
        priority: r.priority,
        router: r.router,
        origin: r.origin,
        executor: r.executor,
        executorDevice: r.executorDevice ?? null,
        assigneeName: r.assigneeName ?? null,
        assigneeKind: r.assigneeKind,
        assigneeRef: buildTaskAssigneeRef(userId, r),
        parentTaskId: r.parentTaskId ?? null,
        jobId: r.jobId ?? null,
        jobRunId: r.jobRunId ?? null,
        remoteAdapter: r.remoteAdapter ?? null,
        remoteId: r.remoteId ?? null,
        remoteKey: r.remoteKey ?? null,
        remoteUrl: r.remoteUrl ?? null,
        remoteState: r.remoteState ?? null,
        handoffNote: r.handoffNote ?? null,
        artifacts: r.artifacts ?? null,
        budget: r.budget ?? null,
        errorMessage: r.errorMessage ?? null,
        // `createdAt` travels, unlike a job's. A task page prints it ("Created
        // three days ago") and so do `startedAt` / `finishedAt`; a replica that
        // stamped its own arrival time would say every task in the user's
        // history began the moment this device joined the account.
        createdAt: r.createdAt.getTime(),
        startedAt: msOrNull(r.startedAt),
        finishedAt: msOrNull(r.finishedAt),
        deletedAt: msOrNull(r.deletedAt)
      },
      deleted: !!r.deletedAt,
      clientUpdatedAt: r.updatedAt.getTime()
    }))
  },
  maxUpdatedAt: (userId) => taskRepo.maxUpdatedAt(userId),
  apply(userId, id, plaintext, _deleted, ctx) {
    if (!plaintext) {
      taskService.removeSyncedTask(userId, id)
      return
    }
    // Stored **verbatim**, then resolved separately — the same split the job
    // manifest makes, and for the same reason: what goes back on the wire must
    // be the bytes that arrived. Resolving to a local agent id and re-deriving
    // the descriptor from *that* would drop the assignee entirely on a device
    // that does not have the agent.
    const ref = jsonObject(plaintext.assigneeRef)
    const parsed = parseAssigneeRef(plaintext.assigneeRef)
    const arrived = new Date(ctx.clientUpdatedAt)
    taskService.applySyncedTask(userId, {
      id,
      title: str(plaintext.title) || 'Untitled task',
      goal: str(plaintext.goal),
      description: strOrNull(plaintext.description),
      // The five unions are carried raw rather than narrowed here. `toTaskDto`
      // parses every one of them on the way out (`parseTaskStatus` and its
      // four siblings exist for exactly this trip), so a value from a newer
      // build survives storage, re-encodes to the bytes it arrived as, and
      // still renders as something.
      status: str(plaintext.status) as TaskStatus,
      priority: str(plaintext.priority) as TaskPriority,
      router: str(plaintext.router) as TaskRouter,
      origin: str(plaintext.origin) as TaskOrigin,
      executor: str(plaintext.executor) as TaskExecutor,
      executorDevice: strOrNull(plaintext.executorDevice),
      assigneeAgentId: parsed ? resolveTaskAssignee(userId, parsed) : null,
      assigneeName: strOrNull(plaintext.assigneeName),
      assigneeKind: str(plaintext.assigneeKind) as TaskAssignee['kind'],
      assigneeRef: (ref as JobDepDescriptor | null) ?? null,
      parentTaskId: strOrNull(plaintext.parentTaskId),
      jobId: strOrNull(plaintext.jobId),
      jobRunId: strOrNull(plaintext.jobRunId),
      remoteAdapter: strOrNull(plaintext.remoteAdapter),
      remoteId: strOrNull(plaintext.remoteId),
      remoteKey: strOrNull(plaintext.remoteKey),
      remoteUrl: strOrNull(plaintext.remoteUrl),
      remoteState: jsonObject(plaintext.remoteState),
      handoffNote: strOrNull(plaintext.handoffNote),
      artifacts: jsonArray<TaskArtifact>(plaintext.artifacts),
      budget: jsonObject(plaintext.budget) as TaskBudget | null,
      errorMessage: strOrNull(plaintext.errorMessage),
      // A payload from a build that predates `createdAt` travelling would have
      // none; the peer's own modification time is the closest honest answer,
      // and it is never in the future.
      createdAt: dateOr(plaintext.createdAt, arrived),
      updatedAt: arrived,
      startedAt: dateOrNull(plaintext.startedAt),
      finishedAt: dateOrNull(plaintext.finishedAt),
      deletedAt: dateOrNull(plaintext.deletedAt)
    })
  }
}

// ---------------- registry ----------------

/**
 * Push order matters: folders before their children so a peer that applies
 * top-down sees parents first (pull tolerates either order, but this is tidier).
 */
export const COLLECTION_MAPPERS: CollectionMapper[] = [
  noteFolderMapper,
  jobFolderMapper,
  noteMapper,
  jobMapper,
  // Last, and after `job`: a task carries the `job_id` it came from, so a peer
  // applying top-down has the job's title to show above it. The dependency is
  // one-way and cosmetic — a dangling `job_id` is a supported state, since job
  // runs never sync at all — so this is tidiness, not correctness.
  taskMapper
]

export const MAPPERS_BY_COLLECTION: Record<SyncCollection, CollectionMapper> = {
  note: noteMapper,
  note_folder: noteFolderMapper,
  job: jobMapper,
  job_folder: jobFolderMapper,
  task: taskMapper
}
