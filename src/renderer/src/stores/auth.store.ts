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
  /** User IDs that have entered their password this session (reset on app restart) */
  unlockedUserIds: Set<string>
  markUnlocked: (userId: string) => void
  markLocked: (userId: string) => void
  isUnlocked: (userId: string) => boolean
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  currentUser: null,
  isAuthenticated: false,
  needsPassword: false,
  pendingUserId: null,
  unlockedUserIds: new Set(),
  setCurrentUser: (user) =>
    set({
      currentUser: user,
      isAuthenticated: !!user,
      needsPassword: false,
      pendingUserId: null
    }),
  setNeedsPassword: (needs) => set({ needsPassword: needs }),
  setPendingUserId: (id) => set({ pendingUserId: id }),
  markUnlocked: (userId) =>
    set((state) => {
      const next = new Set(state.unlockedUserIds)
      next.add(userId)
      return { unlockedUserIds: next }
    }),
  markLocked: (userId) =>
    set((state) => {
      const next = new Set(state.unlockedUserIds)
      next.delete(userId)
      return { unlockedUserIds: next }
    }),
  isUnlocked: (userId) => get().unlockedUserIds.has(userId)
}))
