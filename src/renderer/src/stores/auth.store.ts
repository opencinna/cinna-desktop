import { create } from 'zustand'

export interface AuthUser {
  id: string
  type: string
  username: string
  displayName: string
  hasPassword: boolean
  cinnaHostingType?: 'cloud' | 'self_hosted'
  cinnaServerUrl?: string
  hasCinnaTokens?: boolean
}

interface AuthStore {
  currentUser: AuthUser | null
  isAuthenticated: boolean
  needsPassword: boolean
  setCurrentUser: (user: AuthUser | null) => void
  setNeedsPassword: (needs: boolean) => void
  pendingUserId: string | null
  setPendingUserId: (id: string | null) => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  currentUser: null,
  isAuthenticated: false,
  needsPassword: false,
  pendingUserId: null,
  setCurrentUser: (user) =>
    set({
      currentUser: user,
      isAuthenticated: !!user,
      needsPassword: false,
      pendingUserId: null
    }),
  setNeedsPassword: (needs) => set({ needsPassword: needs }),
  setPendingUserId: (id) => set({ pendingUserId: id })
}))
