/**
 * The one predicate every Cinna channel asks before it lets an agent in or
 * out (D6): delegation, handovers, the conductor and its `cinna` tools,
 * on-demand attachment, schedules, Run commands, Open in, file preview,
 * credential files, Inbox tasks and generated titles.
 *
 * Backed by the `agents` rows with `source = 'vault'`, read once and kept in
 * memory; the vault service refreshes it whenever it writes such a row.
 */
import { DomainError } from '../errors'
import { agentRepo, type AgentRow } from '../db/agents'
import { chatVaultId } from '../db/chats'
import type { AgentReadiness } from '../../shared/agentDrivers'
import { vaultOtherChatReason } from '../../shared/vault/types'

let ids: Set<string> | null = null

function load(): Set<string> {
  ids = new Set(agentRepo.listVaultAgentIds())
  return ids
}

/** Re-read the vault agent ids (after a row became or stopped being a vault agent). */
export function refreshVaultAgents(): void {
  load()
}

/**
 * Read once at boot. Before it (a unit test with no database), a failed lazy
 * read answers "not a vault agent" and is retried on the next call.
 */
export function isVaultAgent(agentId: string | null | undefined): boolean {
  if (typeof agentId !== 'string' || agentId === '') return false
  if (ids) return ids.has(agentId)
  try {
    return load().has(agentId)
  } catch {
    return false
  }
}

/** Thrown when a channel is asked to act for a vault agent. Code `vault_agent`. */
export class VaultAgentRefused extends DomainError<'vault_agent'> {
  constructor(what: string) {
    super('vault_agent', `${what} is not available for an agent in a vault.`)
  }
}

/** Throws {@link VaultAgentRefused} for a vault agent; `what` names the refused channel ("Delegation"). */
export function refuseVaultAgent(agentId: string | null | undefined, what: string): void {
  if (isVaultAgent(agentId)) throw new VaultAgentRefused(what)
}

/** Test seam: forget the cached ids. */
export function resetVaultAgentsForTest(next?: Iterable<string>): void {
  ids = next ? new Set(next) : null
}

/**
 * Readiness `vault_other_chat` for `agent` in chat `chatId`, or null: a vault
 * agent answers only in a chat bound to its own vault. Any other chat (one
 * that started before the agent moved in, whose words are in this computer's
 * database) is refused before anything is saved, titled, or turned into a
 * task. Never throws; a chat lookup that fails refuses.
 */
export function vaultChatReadiness(
  agent: Pick<AgentRow, 'id' | 'name' | 'source' | 'driverConfig'>,
  chatId: string
): AgentReadiness | null {
  if (agent.source !== 'vault' && !isVaultAgent(agent.id)) return null
  const raw = agent.driverConfig?.['vault'] as { vaultId?: unknown } | undefined
  const vaultId = typeof raw?.vaultId === 'string' ? raw.vaultId : null
  let chatVault: string | null
  try {
    chatVault = chatVaultId(chatId)
  } catch {
    chatVault = null
  }
  if (vaultId && chatVault === vaultId) return null
  return { state: 'vault_other_chat', reason: vaultOtherChatReason(agent.name) }
}
