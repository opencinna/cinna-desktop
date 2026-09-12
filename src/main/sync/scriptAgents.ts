import { agentRepo, agentOverrideRepo } from '../db/agents'
import { agentService } from '../services/agentService'
import { agentIdentityKey, agentRowToDescriptor, normalizeUrl } from './identity'
import { profileServerUrl } from './resolvers'
import type { RunScope } from '../services/runExecutionService'
import type { ScriptAgentRef, TaskScript } from '../../shared/taskScript'
import type { ScriptTarget } from '../tasks/scriptRuntimeTypes'

function identity(ref: ScriptAgentRef): string {
  return JSON.stringify([agentIdentityKey(ref), 'serverUrl' in ref ? normalizeUrl(ref.serverUrl ?? '') : null])
}

/** Lookup only, under captured scopes. Never install, enable or fetch an agent. */
export function resolveScriptTargets(scope: RunScope, script: TaskScript): Record<string, ScriptTarget> {
  const serverUrl = profileServerUrl(scope.profileUserId)
  const rows = [...new Set([scope.settingsUserId, scope.profileUserId])].flatMap((userId) => agentRepo.list(userId))
  const available = rows.flatMap((row) => {
    const located = agentService.findAgent(scope.settingsUserId, scope.profileUserId, row.id)
    if (!located || located.row.userId !== row.userId) return []
    const ref = agentRowToDescriptor(row, serverUrl)
    return ref ? [{ row, identity: identity(ref) }] : []
  })
  return Object.fromEntries(Object.entries(script.agents).map(([alias, ref]) => {
    const wanted = identity(ref)
    const matches = available.filter((entry) => entry.identity === wanted)
    if (matches.length !== 1) throw new Error(matches.length
      ? `Script agent ${alias} matches more than one configured agent. Resolve the duplicate before running.`
      : `Script agent ${alias} is not available on this device for this profile.`)
    const { row } = matches[0]
    if (!(agentOverrideRepo.get(scope.profileUserId, row.id)?.enabled ?? row.enabled)) throw new Error(`Enable script agent ${alias} before running.`)
    return [alias, { agentId: row.id, name: row.name, identity: wanted }]
  }))
}

export function assertScriptTargets(scope: RunScope, script: TaskScript, expected: Record<string, ScriptTarget>): void {
  const current = resolveScriptTargets(scope, script)
  for (const alias of Object.keys(script.agents)) {
    if (current[alias].agentId !== expected[alias]?.agentId || current[alias].identity !== expected[alias]?.identity) {
      throw new Error(`Script agent ${alias} changed after this attempt started. Stop this attempt and review its setup.`)
    }
  }
}
