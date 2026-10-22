import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FinderQuickActionResult, FinderQuickActionStatus } from '../../../shared/finderQuickAction'

const UNSUPPORTED: FinderQuickActionStatus = { supported: false, installed: false, outdated: false }

export const FINDER_QUICK_ACTION_QUERY_KEY = ['finder-quick-action', 'status'] as const

/** Main's answer, or unsupported: tests and older preloads have no `finderQuickAction` API. */
export async function fetchFinderQuickActionStatus(): Promise<FinderQuickActionStatus> {
  const api = (window.api as { finderQuickAction?: { status?: () => Promise<FinderQuickActionStatus> } } | undefined)
    ?.finderQuickAction
  if (typeof api?.status !== 'function') return UNSUPPORTED
  const status = await api.status()
  return status && typeof status === 'object' ? status : UNSUPPORTED
}

/**
 * The "Mention in Cinna" Quick Action's status. Prefetched at renderer start
 * (`App.tsx`) so the Features section is there on the first frame; refetched
 * on focus because the user can delete the workflow in Finder.
 */
export function useFinderQuickActionStatus(): FinderQuickActionStatus | undefined {
  const { data } = useQuery({
    queryKey: FINDER_QUICK_ACTION_QUERY_KEY,
    queryFn: fetchFinderQuickActionStatus,
    refetchOnWindowFocus: 'always',
    retry: false
  })
  return data
}

/** Install (also: update) or remove; the result carries the status after the attempt. */
export function useSetFinderQuickAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (install: boolean): Promise<FinderQuickActionResult> =>
      install ? window.api.finderQuickAction.install() : window.api.finderQuickAction.uninstall(),
    onSuccess: (result) => queryClient.setQueryData(FINDER_QUICK_ACTION_QUERY_KEY, result.status)
  })
}
