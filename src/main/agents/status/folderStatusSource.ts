import type { AgentRow } from '../../db/agents'
import type { AgentStatusSnapshot } from '../../../shared/agentStatus'
import type { AgentStatusSource } from './contract'
import { AgentStatusError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { manifestPath, readManifest } from '../../kit/manifestIo'
import { localAgentService } from '../../services/localAgents/localAgentService'
import { readFolderAgentSnapshot, runStatusRefresh } from '../../services/localAgents/statusRefresh'

const logger = createLogger('folder-status')

/** Only an explicit single-agent refresh may execute the declared command. */
export function folderStatusSource(userId: string, agent: Pick<AgentRow, 'id' | 'name'>): AgentStatusSource {
  return { read: (intent) => folderStatus(userId, agent.id, agent.name, intent === 'manual') }
}

async function folderStatus(
  /** The captured owner of this folder row. */
  defaultUserId: string,
  agentId: string,
  name: string,
  forceRefresh: boolean
): Promise<AgentStatusSnapshot | null> {
  let located: ReturnType<typeof localAgentService.locate>
  try {
    located = localAgentService.locate(defaultUserId, agentId)
  } catch (err) {
    // **`null` means two different things here and only one of them is a
    // non-event.** The renderer treats `item: null` as the swallowed 429
    // (`useAgentStatus.ts`: `if (!result.success || !result.item) return`),
    // which is right for a rate limit and right for "this agent has never
    // written a STATUS.md" — the same nothing `list` deliberately omits rather
    // than showing a blank card. It is wrong for *the folder is gone*: the user
    // pressed Refresh on an agent whose directory has been moved or deleted,
    // and got a spinner that stopped and a stale card that sits there until the
    // next poll drops it. That failure is thrown so it reaches the surface;
    // everything else keeps the quiet semantics it should have.
    logger.warn('folder agent status: agent could not be located', { agentId, error: String(err) })
    throw new AgentStatusError(
      'not_found',
      err instanceof Error ? err.message : 'That agent is no longer in your agents folder.',
      agentId
    )
  }

  if (forceRefresh) {
    let refreshCommand: unknown = null
    try {
      refreshCommand = readManifest(manifestPath(located.agentDir)).status_refresh_command ?? null
    } catch (err) {
      // An unreadable manifest is the agent page's finding to report, not a
      // reason to withhold a STATUS.md that is sitting right there.
      logger.warn('folder agent status: manifest unreadable', { agentId, error: String(err) })
    }
    const outcome = await runStatusRefresh(defaultUserId, agentId, refreshCommand)
    if (outcome.error) throw new AgentStatusError('unknown', outcome.error, agentId)
  }

  return readFolderAgentSnapshot(agentId, name, located.root.path, located.agentDir)
}
