/**
 * Files and folders mentioned from outside the app ("Mention in Cinna" in
 * Finder), resolved for the active profile: how each is shown, and which folder
 * agent the new chat should start with.
 *
 * The desktop host only collects the paths (`host/desktop/pathMentionIntentService`);
 * everything that depends on the profile — its folder agents, its chats — is
 * decided here, at the moment the renderer takes the buffer, so a profile
 * switch between the click in Finder and the take picks the right agent.
 *
 * Nothing is read: each path is stat'ed again (it may have gone since it was
 * collected) and only its realpath and kind cross to the renderer.
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { agentRepo, type AgentRow } from '../../db/agents'
import { chatRepo } from '../../db/chats'
import { chatScopesFor } from '../../auth/chatScope'
import { getSettingsScopeUserId } from '../../auth/scope'
import { capabilitiesFor } from '../../agents/drivers/capabilities'
import { homeDisplayPath } from '../agentFiles/resolver'
import { isWithin } from './pathRules'
import { createLogger } from '../../logger/logger'
import {
  mentionPathProblem,
  type ComposerPathRef,
  type ComposerPathRefKind,
  type PathMentionTake
} from '../../../shared/pathMentions'

const logger = createLogger('path-mentions')

/** A folder agent the mention may start a chat with: its id and its folder's realpath. */
export interface MentionAgentFolder {
  id: string
  folder: string
}

/**
 * The agent for a mention whose first path is `firstPath` (a realpath), and
 * how it was found:
 *
 * 1. `folder`: the agent whose folder contains it, the deepest folder winning
 *    when agents are nested;
 * 2. else `recent`: the first of `recentAgentIds` (most recent first) that is
 *    one of `agents` — a guess the renderer applies only to a new-chat draft
 *    with no agents yet, so it never replaces the user's own pick;
 * 3. else null.
 */
export function matchFolderAgent(
  firstPath: string,
  agents: readonly MentionAgentFolder[],
  recentAgentIds: readonly string[]
): Pick<PathMentionTake, 'agentId' | 'agentMatch'> {
  let best: MentionAgentFolder | null = null
  for (const agent of agents) {
    if (!isWithin(agent.folder, firstPath)) continue
    if (!best || agent.folder.length > best.folder.length) best = agent
  }
  if (best) return { agentId: best.id, agentMatch: 'folder' }
  const eligible = new Set(agents.map((agent) => agent.id))
  const recent = recentAgentIds.find((id) => eligible.has(id))
  return recent ? { agentId: recent, agentMatch: 'recent' } : { agentId: null, agentMatch: null }
}

export interface PathMentionDeps {
  home(): string
  realpath(path: string): Promise<string>
  kind(path: string): Promise<ComposerPathRefKind | null>
  /** The folder agents the profile may start a chat with. */
  folderAgents(profileUserId: string): AgentRow[]
  /** The agent ids of the profile's chats, most recent first. */
  recentChatAgentIds(profileUserId: string): (string | null)[]
}

/**
 * Folder agents in the shared scope that are switched on and, for a
 * development agent, belong to this profile — the same visibility rule as
 * `agentService.listMerged`.
 */
export function eligibleFolderAgents(profileUserId: string): AgentRow[] {
  return agentRepo
    .listFolder(getSettingsScopeUserId())
    .filter((row) =>
      row.enabled &&
      typeof row.localPath === 'string' && row.localPath.length > 0 &&
      capabilitiesFor(row).cwd &&
      (!row.driverConfig?.developmentProfileId || row.driverConfig.developmentProfileId === profileUserId))
}

const defaultDeps: PathMentionDeps = {
  home: homedir,
  realpath: (path) => realpath(path),
  async kind(path) {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
  },
  folderAgents: eligibleFolderAgents,
  recentChatAgentIds: (profileUserId) => chatRepo.list(chatScopesFor(profileUserId)).map((chat) => chat.agentId)
}

export function createPathMentionService(deps: PathMentionDeps = defaultDeps) {
  async function folders(profileUserId: string): Promise<MentionAgentFolder[]> {
    const out: MentionAgentFolder[] = []
    for (const row of deps.folderAgents(profileUserId)) {
      if (!row.localPath) continue
      try {
        out.push({ id: row.id, folder: await deps.realpath(row.localPath) })
      } catch {
        // A folder agent whose folder is gone cannot hold the path, and a chat
        // started with it would fail at its first turn.
      }
    }
    return out
  }

  return {
    /**
     * Resolve collected paths (realpaths, in arrival order) into chips and the
     * agent to start with. A path that no longer exists is dropped.
     */
    async resolve(paths: readonly string[], profileUserId: string): Promise<PathMentionTake> {
      const home = deps.home()
      const realHome = await deps.realpath(home).catch(() => resolve(home))
      const refs: ComposerPathRef[] = []
      const seen = new Set<string>()
      for (const path of paths) {
        try {
          const real = await deps.realpath(path)
          // Collected as a clean realpath, but the disk may have changed since.
          if (mentionPathProblem(real)) {
            logger.debug('a mentioned path now resolves to a refused name; dropped')
            continue
          }
          if (seen.has(real)) continue
          const kind = await deps.kind(real)
          if (!kind) continue
          seen.add(real)
          refs.push({ path: real, displayPath: homeDisplayPath(real, realHome), kind })
        } catch {
          logger.debug('a mentioned path is gone; dropped')
        }
      }
      if (refs.length === 0) return { refs, agentId: null, agentMatch: null }
      const recent = deps.recentChatAgentIds(profileUserId).filter((id): id is string => typeof id === 'string')
      return { refs, ...matchFolderAgent(refs[0].path, await folders(profileUserId), recent) }
    }
  }
}

export const pathMentionService = createPathMentionService()
