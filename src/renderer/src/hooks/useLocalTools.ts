import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DetectedTool, LocalToolKind, OpenInRequest } from '../../../shared/localTools'

export const LOCAL_TOOLS_KEY = ['local-tools'] as const

/**
 * The developer tools detected on this machine. Detection is cached in the
 * main process for the app's lifetime, so this query is cheap after the first
 * call — `staleTime: Infinity` keeps the renderer from re-asking on every mount
 * of the agent page. {@link useRefreshLocalTools} is the only invalidation.
 */
export function useLocalTools() {
  return useQuery({
    queryKey: LOCAL_TOOLS_KEY,
    queryFn: () => window.api.localTools.list(),
    staleTime: Infinity
  })
}

/** Only the installed tools of a given kind — what the Open-in row renders. */
export function useAvailableTools(kind: LocalToolKind): DetectedTool[] {
  const { data } = useLocalTools()
  return (data ?? []).filter((tool) => tool.available && tool.kind === kind)
}

/** Settings → Local Agents "Refresh" — re-detects after the user installs something. */
export function useRefreshLocalTools() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.localTools.refresh(),
    onSuccess: (tools) => {
      queryClient.setQueryData<DetectedTool[]>(LOCAL_TOOLS_KEY, tools)
    }
  })
}

/**
 * Launch a tool against an agent folder. The main process re-validates the
 * folder against the registered agents roots, so a rejection here is expected
 * and must be surfaced, not swallowed.
 */
export function useOpenIn() {
  return useMutation({
    mutationFn: (request: OpenInRequest) => window.api.localTools.openIn(request)
  })
}
