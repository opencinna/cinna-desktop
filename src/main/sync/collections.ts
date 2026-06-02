import { notesRepo, noteFoldersRepo } from '../db/notes'
import { jobsRepo, jobFoldersRepo } from '../db/jobs'
import { buildJobManifest } from './manifest'
import {
  resolveMode,
  resolveMcp,
  resolveLocalAgent,
  resolveRemoteAgent,
  profileServerUrl,
  newResolveCache,
  type ResolveCache
} from './resolvers'
import type { SyncCollection, JobDepDescriptor, JobSyncManifest } from '../../shared/sync'

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
      } else {
        agentIds.push(resolveLocalAgent(desc, ctx.cache))
      }
    }
    jobsRepo.setRefsFromSync(userId, id, agentIds, mcpIds)
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
  jobMapper
]

export const MAPPERS_BY_COLLECTION: Record<SyncCollection, CollectionMapper> = {
  note: noteMapper,
  note_folder: noteFolderMapper,
  job: jobMapper,
  job_folder: jobFolderMapper
}
