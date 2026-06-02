import { jobsRepo, type JobRow } from '../db/jobs'
import { agentRepo } from '../db/agents'
import { mcpProviderRepo } from '../db/mcpProviders'
import { chatModeRepo } from '../db/chatModes'
import { getSettingsScopeUserId, getProfileScopeUserId } from '../auth/scope'
import {
  agentIdentityKey,
  agentRowToDescriptor,
  mcpIdentityKey,
  mcpRowToDescriptor
} from './identity'
import { profileServerUrl } from './resolvers'
import type { JobDepDescriptor, JobSyncManifest } from '../../shared/sync'

/**
 * Build a job's portable dependency manifest from its *current local state*
 * (plan: data-sync-portable-deps §2 "local edit" direction). Every locally
 * attached dependency is resolvable by construction, so it serializes to a
 * descriptor with full identity. Genuinely-unresolvable descriptors already in
 * the job's `sync_deps` (a remote agent from a server this device isn't on) are
 * carried forward so a local edit on this device doesn't drop them — they have
 * no join row to rebuild from and aren't user-selectable, so without this they
 * would be lost on the round trip.
 *
 * This is the ONE place descriptors are derived from join rows; the sync apply
 * path instead stores the wire manifest verbatim (see `collections.ts`).
 */
export function buildJobManifest(userId: string, job: JobRow): JobSyncManifest {
  const { agentRefs, mcpRefs } = jobsRepo.listRefs(job.id)
  const settingsScope = getSettingsScopeUserId()
  const serverUrl = profileServerUrl(userId)
  const deps: JobDepDescriptor[] = []
  const seen = new Set<string>()

  const remember = (desc: JobDepDescriptor): void => {
    const key =
      desc.kind === 'mcp' ? `m:${mcpIdentityKey(desc)}` : `a:${agentIdentityKey(desc)}`
    if (seen.has(key)) return
    seen.add(key)
    deps.push(desc)
  }

  // Agents: a job attachment is either a Default-Scope local agent or a
  // profile-scoped remote agent — try both lookups.
  for (const agentId of agentRefs) {
    const row =
      agentRepo.getOwned(settingsScope, agentId) ?? agentRepo.getOwned(userId, agentId)
    if (!row) continue
    const desc = agentRowToDescriptor(row, row.source === 'remote' ? serverUrl : null)
    if (desc) remember(desc)
  }

  // MCP providers live in Default Scope.
  for (const mcpId of mcpRefs) {
    const row = mcpProviderRepo.getOwned(settingsScope, mcpId)
    if (!row) continue
    remember(mcpRowToDescriptor(row))
  }

  // Carry forward unresolved remote-agent descriptors from the prior manifest.
  // (Local agents / MCPs auto-create on apply, so they always have a join row;
  // a remote agent on a foreign server is the only thing that can be in the
  // manifest yet have no join row to rebuild from.)
  const prior = job.syncDeps ?? null
  if (prior?.deps) {
    for (const desc of prior.deps) {
      if (desc.kind === 'agent' && desc.source === 'remote') remember(desc)
    }
  }

  const modeName = job.modeId
    ? chatModeRepo.getOwned(settingsScope, job.modeId)?.name ?? null
    : null

  return { modeName, deps }
}

/**
 * Rebuild and persist a job's `sync_deps` manifest from local state. Called
 * from the service layer after any local edit that changes a job's
 * agents/MCPs/mode. Does not bump `updatedAt` (the edit already did).
 */
export function rebuildJobManifest(userId: string, jobId: string): void {
  const job = jobsRepo.getById(userId, jobId)
  if (!job) return
  jobsRepo.setSyncDeps(userId, jobId, buildJobManifest(userId, job))
}

/** Convenience for IPC handlers that already know the active profile. */
export function rebuildActiveJobManifest(jobId: string): void {
  rebuildJobManifest(getProfileScopeUserId(), jobId)
}
