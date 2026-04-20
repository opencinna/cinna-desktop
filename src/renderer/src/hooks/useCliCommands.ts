import { useQuery } from '@tanstack/react-query'
import type { CliCommand } from '../../../shared/cliCommands'

export type { CliCommand }

/**
 * Fetch CLI commands (`cinna.run.*` skills) from an agent's card on demand.
 * Returns [] whenever no agent is selected, the card fetch fails, or the agent
 * declares no commands. A short staleTime covers the case where the user
 * toggles between agents quickly while the YAML file is being edited.
 */
export function useCliCommands(agentId: string | null | undefined) {
  return useQuery<CliCommand[]>({
    queryKey: ['agents', 'cli-commands', agentId ?? null],
    queryFn: async () => {
      if (!agentId) return []
      const res = await window.api.agents.listCliCommands(agentId)
      return res.commands ?? []
    },
    enabled: !!agentId,
    staleTime: 15_000,
    // One retry covers a transient blip; more just amplifies backend outages.
    retry: 1,
    // Doc: "re-fetch the card when the user returns to the agent screen".
    refetchOnWindowFocus: true
  })
}
