import { realpath } from 'node:fs/promises'
import { agentRepo } from '../db/agents'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { localDevService } from './localDevService'
import { runCinnaCli, type CliRunOutcome } from './cliRunner'
import { configuredEnginePath, realBinaryResolverDeps, resolveEngineBinaryWith } from '../engine/binaryResolver'
import { customAgentService } from '../services/customAgentService'
import { isWithin } from '../services/localAgents/pathRules'
import { canDevelopAgent } from '../../shared/agentDevelopment'
import type { StdioAcpConfig } from '../../shared/customAgents'

/** Read workspace locations from cinna-cli; never infer its folder layout. */
export function syncedAgentPath(outcome: CliRunOutcome, targetId: string): string | null {
  if (outcome.exitCode !== 0 || outcome.result?.result !== 'ok') throw new Error('Could not read the Cinna account workspace. Repair Local Development in Settings and try again.')
  const agents = outcome.result.agents
  if (!Array.isArray(agents)) throw new Error('This cinna-cli cannot report agent workspaces. Update local development tooling and try again.')
  const item = agents.find((entry) => entry?.agent_id === targetId)
  return typeof item?.path === 'string' ? item.path : null
}

const inFlight = new Map<string, Promise<{ agentId: string }>>()

export function developAgent(agentId: string): Promise<{ agentId: string }> {
  const profileId = getProfileScopeUserId()
  const key = `${profileId}:${agentId}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const run = prepare(profileId, agentId).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

async function prepare(profileId: string, agentId: string): Promise<{ agentId: string }> {
  const agent = agentRepo.getOwned(profileId, agentId)
  if (!agent || !canDevelopAgent(agent)) throw new Error('This agent is not available for local development.')
  const validate = (): void => {
    if (getProfileScopeUserId() !== profileId) throw new Error('The active profile changed. Open Develop again in that profile.')
    const current = agentRepo.getOwned(profileId, agentId)
    if (!current || !canDevelopAgent(current) || current.remoteTargetId !== agent.remoteTargetId) throw new Error('This agent is no longer available for development.')
  }
  const context = await localDevService.executionContext(profileId)
  validate()
  const { workspacePath, cinnaBinPath } = context.state
  const env: NodeJS.ProcessEnv = { ...context.env, CINNA_NO_INPUT: '1' }
  const status = (): Promise<CliRunOutcome> => runCinnaCli({ bin: cinnaBinPath, args: ['account', 'status', '--json'], logArgs: ['account', 'status', '--json'], env, cwd: workspacePath })
  let path = syncedAgentPath(await status(), agent.remoteTargetId!)
  validate()
  if (!path) {
    // The CLI's account-token endpoint enforces can_build and developer roles.
    const args = ['agent', 'sync', agent.remoteTargetId!]
    const result = await runCinnaCli({ bin: cinnaBinPath, args, logArgs: args, env, cwd: workspacePath })
    validate()
    if (result.exitCode !== 0) throw new Error(result.result?.detail || 'Could not sync this agent. Check your development access and Local Development settings, then try again.')
    path = syncedAgentPath(await status(), agent.remoteTargetId!)
    validate()
  }
  if (!path) throw new Error('The agent was synced, but cinna-cli did not report its local workspace.')
  const [root, folder] = await Promise.all([realpath(workspacePath), realpath(path)])
  if (folder === root || !isWithin(root, folder)) throw new Error('The reported agent workspace is outside this account workspace.')
  validate()
  const engine = await resolveEngineBinaryWith(realBinaryResolverDeps(configuredEnginePath))
  validate()
  // The coding assistant starts inside the CLI-provisioned development workspace,
  // with Cinna's managed CLI and Mutagen available to its tools.
  const config: StdioAcpConfig = { launcher: 'custom', command: ['/usr/bin/env', `PATH=${env.PATH ?? ''}`, engine.path, 'acp'], cwd: folder, localCwd: folder }
  const developmentName = `Develop ${agent.name}`.slice(0, 200)
  const existing = agentRepo.list(getSettingsScopeUserId()).find((row) => row.driver === 'acp' && row.driverConfig?.launcher === 'custom' && row.driverConfig.cwd === folder && row.name === developmentName)
  if (existing) return { agentId: existing.id }
  const test = await customAgentService.test({ config })
  validate()
  const saved = customAgentService.save({ config, name: developmentName, testToken: test.token })
  return { agentId: saved.id }
}
