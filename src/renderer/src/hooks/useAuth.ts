import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'

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

export function useUpdateUser() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useMutation({
    mutationFn: (data: {
      userId: string
      displayName?: string
      password?: string
      removePassword?: boolean
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
    mutationFn: (data: { userId: string; password?: string }) =>
      window.api.auth.deleteUser(data),
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
