import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { useReauthStore } from '../stores/reauth.store'
import { useChatStore } from '../stores/chat.store'
import { REMOTE_SYNC_STATUS_KEY, type RemoteSyncStatus } from './useAgents'

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => window.api.auth.listUsers()
  })
}

function toAuthUser(user: { id: string; type: string; username: string; displayName: string; hasPassword: boolean; cinnaFullName?: string; cinnaHostingType?: 'cloud' | 'self_hosted'; cinnaServerUrl?: string; hasCinnaTokens?: boolean }) {
  return {
    id: user.id,
    type: user.type,
    username: user.username,
    displayName: user.displayName,
    hasPassword: user.hasPassword,
    cinnaFullName: user.cinnaFullName,
    cinnaHostingType: user.cinnaHostingType,
    cinnaServerUrl: user.cinnaServerUrl,
    hasCinnaTokens: user.hasCinnaTokens
  }
}

export function useCurrentUser() {
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useQuery({
    queryKey: ['auth', 'current'],
    queryFn: async () => {
      const user = await window.api.auth.getCurrent()
      if (user) {
        setCurrentUser(toAuthUser(user))
      }
      return user
    }
  })
}

type StartupResult = Awaited<ReturnType<typeof window.api.auth.getStartup>>

export type StartupState =
  | { status: 'pending' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

/**
 * In-flight/settled startup call, memoised at module scope so it survives the
 * unmount/remount that StrictMode performs on mount effects. Reset on failure
 * so `retry()` can re-issue it.
 */
let startupPromise: Promise<StartupResult> | undefined

/**
 * Startup auth state.
 *
 * Deliberately NOT a `useQuery`: `auth:get-startup` is not a read, it activates
 * the session in the main process (reloading every LLM adapter and reconnecting
 * every MCP server). Query-cache semantics would re-issue it — the auth
 * mutations below call `queryClient.resetQueries()`, which refetches every
 * active query, so a login would re-activate the session and could bounce the
 * user back to the login screen. A module-scoped promise gives the exactly-once
 * guarantee this call needs while keeping the IPC out of the component layer.
 *
 * Store writes land before `status: 'ready'`, so a consumer branching on the
 * auth store can't flash the wrong screen for a frame.
 */
export function useStartup(): { state: StartupState; retry: () => void } {
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)
  const setNeedsPassword = useAuthStore((s) => s.setNeedsPassword)
  const setPendingUserId = useAuthStore((s) => s.setPendingUserId)
  const [state, setState] = useState<StartupState>({ status: 'pending' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    startupPromise ??= window.api.auth.getStartup()

    startupPromise
      .then((startup) => {
        if (cancelled) return
        if (startup.needsLogin && startup.pendingUser) {
          // Last user has a password — the login screen takes over.
          setPendingUserId(startup.pendingUser.id)
          setNeedsPassword(true)
        } else if (startup.user) {
          // Default or passwordless user — already activated in main.
          setCurrentUser(toAuthUser(startup.user))
        }
        setState({ status: 'ready' })
      })
      .catch((err: unknown) => {
        // Let a retry re-issue the call rather than replaying the failure.
        startupPromise = undefined
        if (cancelled) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      })

    return () => {
      cancelled = true
    }
  }, [attempt, setCurrentUser, setNeedsPassword, setPendingUserId])

  return {
    state,
    retry: () => {
      setState({ status: 'pending' })
      setAttempt((n) => n + 1)
    }
  }
}

export function useLogin() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: (data: { userId: string; password?: string }) =>
      window.api.auth.login(data),
    onSuccess: (result) => {
      if (result.success && result.user) {
        setCurrentUser(toAuthUser(result.user))
        // Reset chat state and refetch all queries for the new user
        useChatStore.getState().setActiveChatId(null)
        queryClient.resetQueries()
      }
    }
  })
}

export function useRegister() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: (data: {
      username?: string
      displayName?: string
      password?: string
      accountType: 'local' | 'cinna'
      cinnaHostingType?: 'cloud' | 'self_hosted'
      cinnaServerUrl?: string
    }) => window.api.auth.register(data),
    onSuccess: (result) => {
      if (result.success && result.user) {
        setCurrentUser(toAuthUser(result.user))
        useChatStore.getState().setActiveChatId(null)
        queryClient.resetQueries()
      }
    }
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: () => window.api.auth.logout(),
    onSuccess: async () => {
      // Fetch the default user info before resetting
      const defaultUser = await window.api.auth.getCurrent()
      if (defaultUser) {
        setCurrentUser(toAuthUser(defaultUser))
      } else {
        setCurrentUser(null)
      }
      useChatStore.getState().setActiveChatId(null)
      queryClient.resetQueries()
    }
  })
}

export function useCinnaOAuthAbort() {
  return useMutation({
    mutationFn: () => window.api.auth.cinnaOAuthAbort()
  })
}

/**
 * Re-link the active Cinna profile with fresh OAuth tokens — keeps local
 * data (chats, agents, settings) intact. The target user is resolved
 * main-side from the active profile, so the renderer can't target a
 * different account.
 *
 * Refreshes the auth queries and any agent caches so any "session expired"
 * banners clear automatically.
 */
export function useCinnaReauth() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: () => window.api.auth.cinnaReauth(),
    onSuccess: (result) => {
      if (!result.success || !result.user) return
      // Session restored — drop the global "session expired" prompt no matter
      // which surface (modal, catalog banner, Connection card) triggered it,
      // and clear any prior dismissal so a future expiry can prompt again.
      useReauthStore.getState().clearReauth()
      const current = useAuthStore.getState().currentUser
      if (current && current.id === result.user.id) {
        setCurrentUser(toAuthUser(result.user))
      }
      queryClient.invalidateQueries({ queryKey: ['users'] })
      queryClient.invalidateQueries({ queryKey: ['auth', 'current'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, {})
    }
  })
}

export function useUpdateUser() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: (data: {
      userId: string
      displayName?: string
      password?: string
      removePassword?: boolean
      currentPassword?: string
    }) => window.api.auth.updateUser(data),
    onSuccess: (result) => {
      if (result.success && result.user) {
        // If updating the current user, refresh the store
        const current = useAuthStore.getState().currentUser
        if (current && current.id === result.user.id) {
          setCurrentUser(toAuthUser(result.user))
        }
      }
      queryClient.invalidateQueries({ queryKey: ['users'] })
      queryClient.invalidateQueries({ queryKey: ['auth', 'current'] })
    }
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: (data: {
      userId: string
      password?: string
      signOut?: boolean
      removeDevice?: boolean
    }) => window.api.auth.deleteUser(data),
    onSuccess: async (result) => {
      if (result.success) {
        // Refresh current user (may have switched to default)
        const currentUser = await window.api.auth.getCurrent()
        if (currentUser) {
          setCurrentUser(toAuthUser(currentUser))
        }
        useChatStore.getState().setActiveChatId(null)
        queryClient.resetQueries()
      }
    }
  })
}
