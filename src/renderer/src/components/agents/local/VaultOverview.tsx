import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { DescriptionCard, ExamplePromptsCard } from './ManifestCards'
import { KIT_PROMPT_CARDS, PromptDocCard } from './PromptDocCard'
import { StatusCard } from './ReadOnlyCards'
import { VaultDetailsGate } from './security/VaultLockedCard'

/**
 * The Overview of an agent in a vault: the kit cards a folder agent's
 * Overview has, fed from what its vault holds (`vault:agent-details`) instead
 * of a folder on this Mac, and read-only. Locked, the one card that says its
 * details are inside, with Unlock; reading, one line, not a spinner per card.
 */
export function VaultOverview({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  return (
    <VaultDetailsGate agent={agent}>
      {(details) => {
        // The page's agent, with what its vault says in place of the scan's blanks.
        const view: LocalAgentDto = { ...agent, manifest: details.manifest, description: details.description, status: details.status }
        return (
          <>
            <p className="text-xs text-[var(--color-text-muted)]">Read-only while the agent is in a vault.</p>
            <StatusCard agent={view} readOnly />
            <DescriptionCard agent={view} readOnly />
            <ExamplePromptsCard agent={view} readOnly />
            {KIT_PROMPT_CARDS.map((card) => (
              <PromptDocCard key={`${agent.id}:${card.prompt}`} agentId={agent.id} {...card} readOnlyDoc={details.docs[card.prompt]} />
            ))}
          </>
        )
      }}
    </VaultDetailsGate>
  )
}
