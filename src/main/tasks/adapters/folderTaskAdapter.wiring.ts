/**
 * The production world for {@link createFolderTaskAdapter}: the real
 * filesystem and the enabled bare folder agents.
 *
 * Bare folders only, as for file handovers: a kit folder is *published*, so a
 * `.cinna/tasks/` there would travel to whoever installed the kit. The agent
 * list is the same `localAgentService.list` the handover intake reads, from
 * the settings scope where folder agents live — imported on first use, because
 * this registry sits under `taskSyncService` and the local-agent stack must
 * not load behind every module that reaches a task.
 */

import { randomBytes } from 'node:crypto'
import { getSettingsScopeUserId } from '../../auth/scope'
import { taskRepo } from '../../db/tasks'
import { createFolderTaskAdapter, FOLDER_ADAPTER_ID, type FolderAgentRef, type FolderTaskWorld } from './folderTaskAdapter'
import { folderTaskFs } from './folderTaskFs'
import type { RemoteTaskAdapter } from './adapter'

const world: FolderTaskWorld = {
  async agents(): Promise<FolderAgentRef[]> {
    const { localAgentService } = await import('../../services/localAgents/localAgentService')
    return localAgentService
      .list(getSettingsScopeUserId())
      .agents.filter((agent) => agent.kind === 'bare' && agent.enabled && agent.path)
      .map((agent) => ({ id: agent.id, name: agent.name, path: agent.path }))
  },
  /** The profile's stored folder bindings, so a pull knows what Cinna last wrote. */
  async states(userId) {
    const states = new Map<string, Record<string, unknown>>()
    for (const row of taskRepo.list(userId, { remoteAdapter: FOLDER_ADAPTER_ID, includeArchived: true })) {
      if (row.remoteId && row.remoteState) states.set(row.remoteId, row.remoteState)
    }
    return states
  },
  fs: folderTaskFs,
  randomBytes: (size) => randomBytes(size)
}

export const folderTaskAdapter: RemoteTaskAdapter = createFolderTaskAdapter(world)
