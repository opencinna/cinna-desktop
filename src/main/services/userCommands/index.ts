/**
 * The production user command service: the chat, message and agent repos,
 * the login shell's environment and the session activity hub. The agent's
 * workspace comes from the drivers, installed by the composition root
 * (`hub/core.ts`), so this service never imports `agents/drivers`.
 */
import { runtimeHost } from '../../host/runtimeHost'
import { visibleChat } from '../../auth/chatScope'
import { getSettingsScopeUserId } from '../../auth/scope'
import { messageRepo } from '../../db/messages'
import type { AgentRow } from '../../db/agents'
import { agentService } from '../agentService'
import { sessionActivityHub } from '../sessionActivityHub'
import { installSessionActivityStopper } from '../sessionActivityStop'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { withManagedUvFallback } from '../../shell/managedUvPath'
import { uvUnavailableReason } from '../localAgents/uvPrewarm'
import { createUserCommandService, type UserCommandAgent, type UserCommandWorkspace } from './userCommandService'

export { createUserCommandService } from './userCommandService'
export type { UserCommandService } from './userCommandService'

interface RowAgent extends UserCommandAgent {
  row: AgentRow
}

type WorkspaceResolver = (userId: string, agent: AgentRow) => Promise<UserCommandWorkspace | 'missing' | null>

let workspaceResolver: WorkspaceResolver | null = null

/** Installed by `hub/core.ts`: where a turn's folder view is built. Without it no agent is local. */
export function installUserCommandWorkspace(resolver: WorkspaceResolver): () => void {
  workspaceResolver = resolver
  return () => { if (workspaceResolver === resolver) workspaceResolver = null }
}

export const userCommandService = createUserCommandService<RowAgent>({
  chat: (profileUserId, chatId) => visibleChat(profileUserId, chatId),
  message: (messageId) => messageRepo.getById(messageId),
  agent: (profileUserId, agentId) => {
    const found = agentService.findAgent(getSettingsScopeUserId(), profileUserId, agentId)
    return found ? { userId: found.userId, id: found.row.id, row: found.row } : null
  },
  workspace: (agent) => workspaceResolver ? workspaceResolver(agent.userId, agent.row) : Promise.resolve(null),
  // The managed uv last on PATH: a script's `uv run` works before the user installs one.
  shellEnv: async () => withManagedUvFallback(shellEnvForChild(await getShellEnv())),
  uvUnavailable: (command, outcome) => uvUnavailableReason(command, outcome),
  userData: () => runtimeHost.getPath('userData'),
  hub: sessionActivityHub
})

installSessionActivityStopper('user-commands', userCommandService.stopper)
