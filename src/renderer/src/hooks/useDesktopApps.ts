import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DesktopAppConnectResult, DesktopAppId } from '../../../shared/desktopApps'
import { DEFAULT_RUNTIME_KEY } from './useEngine'
import { AGENT_CREDENTIAL_BINDINGS_KEY, LOCAL_AGENTS_KEY } from './useLocalAgents'
import { CLAUDE_AUTH_KEY, CODEX_AUTH_KEY, ENGINE_LOGIN_RUNNING_KEY } from './useLocalTools'
import { useDesktopAppsStore } from '../stores/desktopApps.store'

export const DESKTOP_APPS_KEY = ['desktop-apps'] as const
export const DESKTOP_APP_RUNNING_KEY = ['desktop-app-running'] as const
export const DESKTOP_APP_CONNECT_KEY = ['desktop-app-connect'] as const

/** How often a pending connect is re-asked for its phase. */
export const DESKTOP_APP_RUNNING_POLL_MS = 1_000

/** The vendor desktop apps main found on this Mac. Detected once per launch there, so never stale here. */
export function useDesktopApps() {
  return useQuery({
    queryKey: DESKTOP_APPS_KEY,
    queryFn: () => window.api.localTools.desktopApps(),
    staleTime: Infinity
  })
}

/**
 * The connect main is running, and its phase. Asked on mount — a connect
 * outlives the banner that started it — and polled only while one runs (or
 * while this renderer is waiting on one).
 */
export function useDesktopAppRunning(pending: boolean) {
  return useQuery({
    queryKey: DESKTOP_APP_RUNNING_KEY,
    queryFn: () => window.api.localTools.desktopAppRunning(),
    refetchInterval: (query) => (pending || query.state.data ? DESKTOP_APP_RUNNING_POLL_MS : false)
  })
}

export interface DesktopAppConnectVariables {
  appId: DesktopAppId
  /** The ids the banner offered when it was pressed — all dismissed on success. */
  shownIds: DesktopAppId[]
}

/**
 * Install, sign in and adopt one desktop app's engine.
 *
 * **What happens when it ends is in the `useMutation` options**, not a
 * `mutate` callback: a sign-in takes minutes in a browser, the new-chat screen
 * may be gone by then, and a mutate-level callback would be dropped with it.
 * On `enabled` everything derived from the default runtime is re-read, and the
 * offered apps are dismissed so the banner goes away.
 */
export function useDesktopAppConnect() {
  const queryClient = useQueryClient()
  return useMutation<DesktopAppConnectResult, Error, DesktopAppConnectVariables>({
    mutationKey: DESKTOP_APP_CONNECT_KEY,
    mutationFn: ({ appId }) => {
      const result = window.api.localTools.desktopAppConnect(appId)
      // Asked after the connect is queued, so main answers with it running.
      void queryClient.invalidateQueries({ queryKey: DESKTOP_APP_RUNNING_KEY })
      return result
    },
    onSuccess: (result, { shownIds }) => {
      if (result.outcome !== 'enabled') return
      useDesktopAppsStore.getState().dismiss(shownIds)
      void queryClient.invalidateQueries({ queryKey: DEFAULT_RUNTIME_KEY })
      void queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
      // A new default mode moves the credential agents on the Default runtime bind to.
      void queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['app-settings'] })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['local-development-context'] })
    },
    onSettled: () => {
      // A sign-in may have happened even when the connect did not finish.
      void queryClient.invalidateQueries({ queryKey: CLAUDE_AUTH_KEY })
      void queryClient.invalidateQueries({ queryKey: CODEX_AUTH_KEY })
      void queryClient.invalidateQueries({ queryKey: ENGINE_LOGIN_RUNNING_KEY })
      void queryClient.invalidateQueries({ queryKey: DESKTOP_APP_RUNNING_KEY })
    }
  })
}
