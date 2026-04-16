import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => window.api.auth.listUsers()
  })
}

export function useCurrentUser() {
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)

  return useQuery({
    queryKey: ['auth', 'current'],
    queryFn: async () => {
      const user = await window.api.auth.getCurrent()
      if (user) {
        setCurrentUser({
          id: user.id,
          type: user.type,
          username: user.username,
          displayName: user.displayName,
          hasPassword: user.hasPassword
        })
      }
      return user
    }
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)
  const markUnlocked = useAuthStore((s) => s.markUnlocked)

  return useMutation({
    mutationFn: (data: { userId: string; password?: string; skipPassword?: boolean }) =>
      window.api.auth.login(data),
    onSuccess: (result) => {
      if (result.success && result.user) {
        setCurrentUser({
          id: result.user.id,
          type: result.user.type,
          username: result.user.username,
          displayName: result.user.displayName,
          hasPassword: result.user.hasPassword
        })
        // Remember this user authenticated in this session
        markUnlocked(result.user.id)
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
    mutationFn: (data: { username: string; displayName: string; password: string }) =>
      window.api.auth.register(data),
    onSuccess: (result) => {
      if (result.success && result.user) {
        setCurrentUser({
          id: result.user.id,
          type: result.user.type,
          username: result.user.username,
          displayName: result.user.displayName,
          hasPassword: result.user.hasPassword
        })
        useChatStore.getState().setActiveChatId(null)
        queryClient.resetQueries()
      }
    }
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)
  const markLocked = useAuthStore((s) => s.markLocked)

  return useMutation({
    mutationFn: () => window.api.auth.logout(),
    onSuccess: async () => {
      // Re-lock the user so next sign-in requires password again
      const prev = useAuthStore.getState().currentUser
      if (prev) markLocked(prev.id)
      // Fetch the default user info before resetting
      const defaultUser = await window.api.auth.getCurrent()
      if (defaultUser) {
        setCurrentUser({
          id: defaultUser.id,
          type: defaultUser.type,
          username: defaultUser.username,
          displayName: defaultUser.displayName,
          hasPassword: defaultUser.hasPassword
        })
      } else {
        setCurrentUser(null)
      }
      useChatStore.getState().setActiveChatId(null)
      queryClient.resetQueries()
    }
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (userId: string) => window.api.auth.deleteUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      queryClient.invalidateQueries({ queryKey: ['auth', 'current'] })
    }
  })
}
