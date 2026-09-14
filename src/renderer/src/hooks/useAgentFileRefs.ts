import { useMemo, useRef } from 'react'
import { useQueries } from '@tanstack/react-query'
import { extractFileRefCandidates, type AgentFileRef } from '../../../shared/agentFiles'

/** The resolved refs for one agent's spans, looked up by span text. */
export interface FileRefScope {
  agentId: string
  refs: ReadonlyMap<string, AgentFileRef>
}

/** FNV-1a over the ordered candidates: a short, stable query-key part. */
export function hashCandidates(candidates: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const candidate of candidates) {
    for (let i = 0; i < candidate.length; i++) {
      hash ^= candidate.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `${candidates.length}:${(hash >>> 0).toString(36)}`
}

/**
 * Resolve the file references in each agent's markdown, in transcript order.
 *
 * One query per agent, keyed by a hash of its ordered candidates, so a new
 * message re-resolves and an unchanged transcript does not. A failed resolve
 * links nothing rather than retrying.
 *
 * Links must not flicker off when a message lands. `keepPreviousData` cannot
 * do that here: in `useQueries` a new key starts with no data and no
 * placeholder. So the hook remembers each agent's last answer itself and shows
 * it until the new one arrives. The memory lives as long as the hook, which is
 * one chat's transcript (`MessageStream` keys the resolver by chat).
 */
export function useAgentFileRefs(
  sources: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, FileRefScope> {
  const entries = useMemo(
    () =>
      [...sources].map(([agentId, markdowns]) => {
        const candidates = extractFileRefCandidates(markdowns)
        return { agentId, candidates, hash: hashCandidates(candidates) }
      }),
    [sources]
  )

  const results = useQueries({
    queries: entries.map((entry) => ({
      queryKey: ['agent-file-refs', entry.agentId, entry.hash],
      queryFn: async (): Promise<AgentFileRef[]> => {
        if (entry.candidates.length === 0) return []
        const result = await window.api.agentFiles.resolve({
          agentId: entry.agentId,
          candidates: entry.candidates
        })
        return result.success ? result.refs : []
      },
      staleTime: 30_000,
      retry: false
    }))
  })

  // Each agent's last successful answer, shown while its current query has none.
  const lastAnswer = useRef(new Map<string, AgentFileRef[]>())
  const data = results.map((result, i) => {
    const agentId = entries[i].agentId
    if (result.data !== undefined) {
      lastAnswer.current.set(agentId, result.data)
      return result.data
    }
    return lastAnswer.current.get(agentId)
  })

  // `useQueries` hands back a new array every render; keep the scopes' identity
  // while no agent's data changed, so the bubbles' context does not churn.
  const previous = useRef<{ data: Array<AgentFileRef[] | undefined>; ids: string[]; scopes: Map<string, FileRefScope> }>({
    data: [],
    ids: [],
    scopes: new Map()
  })
  const ids = entries.map((entry) => entry.agentId)
  const same =
    data.length === previous.current.data.length &&
    data.every((d, i) => d === previous.current.data[i] && ids[i] === previous.current.ids[i])
  if (!same) {
    const scopes = new Map<string, FileRefScope>()
    entries.forEach((entry, i) => {
      const refs = data[i]
      if (!refs || refs.length === 0) return
      scopes.set(entry.agentId, { agentId: entry.agentId, refs: new Map(refs.map((ref) => [ref.text, ref])) })
    })
    previous.current = { data, ids, scopes }
  }
  return previous.current.scopes
}
