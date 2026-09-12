import type { AgentDriver } from '../driver'
import type { AgentRow } from '../../../db/agents'
import { capabilitiesFor } from '../capabilities'
import { runManagedSession, type ManagedRunBinding, type ManagedRunDeps } from './managedRun'

export interface ManagedDriverDeps extends ManagedRunDeps {
  prepare(ownerId: string, agent: AgentRow, chatId: string): ManagedRunBinding
  readiness(agent: AgentRow): void
}

export function createManagedDriver(deps: ManagedDriverDeps): AgentDriver {
  const running = new Set<string>()
  return {
    id: 'managed', capabilities: capabilitiesFor,
    async readiness(_ownerId, agent) {
      try { deps.readiness(agent); return { state: 'ok', reason: null } }
      catch (error) { return { state: 'credentials_needed', reason: error instanceof Error ? error.message : 'Choose an Anthropic API credential for this agent.' } }
    },
    async run(ownerId, agent, input) {
      if (input.signal.aborted) return { text: '', parts: [], notices: [], taskState: 'canceled' }
      const key = JSON.stringify([ownerId, input.chatId, agent.id])
      if (running.has(key)) return { text: '', parts: [], notices: [], error: { message: 'This Managed session already has a turn running.', raw: 'Managed session busy' } }
      running.add(key)
      try { return await runManagedSession(deps.prepare(ownerId, agent, input.chatId), agent.id, input, deps) }
      catch (error) {
        const message = error instanceof Error ? error.message : 'The Managed agent could not start.'
        return { text: '', parts: [], notices: [], error: { message, raw: message } }
      } finally { running.delete(key) }
    },
    // The registry's captured per-run binding owns asynchronous replies.
    respond: () => ({ delivered: false })
  }
}
