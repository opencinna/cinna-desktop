import { create } from 'zustand'

/**
 * Where a chat's composer puts a file right now: its draft key and its upload
 * scope, as `ChatInput` decides them (the routing rule beside its
 * `useChatAttachments`). Published by the composer, so a surface outside it —
 * the Commands badge, the command output panel — adds a file exactly where a
 * drop would, without deciding the scope a second time.
 */
export interface ComposerAttachTarget {
  draftKey: string
  scope: 'cinna' | 'local'
}

interface ComposerAttachTargetState {
  targets: Record<string, ComposerAttachTarget>
  set: (chatId: string, target: ComposerAttachTarget) => void
}

export const useComposerAttachTargetStore = create<ComposerAttachTargetState>((set) => ({
  targets: {},
  set: (chatId, target) => set((state) => {
    const current = state.targets[chatId]
    if (current && current.draftKey === target.draftKey && current.scope === target.scope) return state
    return { targets: { ...state.targets, [chatId]: target } }
  })
}))
