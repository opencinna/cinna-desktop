import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SkillPublishInput, SkillPublishOutcome } from '../../../shared/skillPublish'
import { LOCAL_AGENTS_KEY, localAgentKey } from './useLocalAgents'
import { readCatalogItemsFromCache } from './useCatalog'

/**
 * Share an agent's own skill to the catalog (`window.api.skillPublish.publish`).
 * Every answer is data — a refusal is `{ok: false, code, message}` with main's
 * sentence — so the dialog shows it beside its Share button (ux_rules rule 6).
 *
 * The re-reads live at the hook level, not in a `mutate` callback: they must
 * run even when the dialog that asked has closed (a TanStack mutate-level
 * callback is dropped on unmount). A share writes `SKILL.md` and
 * `publications.json` (the row's "Version N" and Shared badge) and adds a skill to the
 * catalog, so the agent and the catalog listing are both read again.
 */
export function usePublishSkill() {
  const queryClient = useQueryClient()
  return useMutation<SkillPublishOutcome, Error, SkillPublishInput>({
    mutationFn: (input) => window.api.skillPublish.publish(input),
    onSettled: (_result, _error, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
      void readCatalogItemsFromCache(queryClient)
    }
  })
}
