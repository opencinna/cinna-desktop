import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'

export function useCinnaAgents() {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery({
    queryKey: ['cinna', 'agents'],
    queryFn: () => window.api.cinna.listAgents(),
    enabled: isCinnaUser,
    staleTime: 60_000
  })
}

export function useRefreshCinnaRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, force }: { runId: string; force?: boolean }) =>
      window.api.jobs.refreshRun(runId, force ? { force: true } : undefined),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['jobs', run.jobId, 'runs'] })
    }
  })
}

/**
 * Configured Cinna server URL for the active profile — used to build
 * /tasks/{short_code} deep links. Cached for 5 minutes; only fetched for
 * Cinna users.
 */
export function useCinnaServerUrl() {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery({
    queryKey: ['cinna', 'server-url'],
    queryFn: () => window.api.jobs.cinnaServerUrl(),
    enabled: isCinnaUser,
    staleTime: 5 * 60_000
  })
}
