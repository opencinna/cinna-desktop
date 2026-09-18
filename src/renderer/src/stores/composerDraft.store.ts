import { create } from 'zustand'
import type { ComposerAttachment } from '../../../shared/attachments'

export interface ComposerDraft {
  sending: boolean
  text: string
  notes: { id: string; title: string }[]
  files: {
    attachments: ComposerAttachment[]
    uploading: boolean
    error: string | null
    token: number | null
  }
  modeSelection: 'auto' | 'none' | { id: string }
  pendingAgentIds: string[] | null
  pendingMcpIds: string[]
  coordinate: boolean
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  sending: false,
  text: '', notes: [],
  files: { attachments: [], uploading: false, error: null, token: null },
  modeSelection: 'auto', pendingAgentIds: null, pendingMcpIds: [], coordinate: false
}

/** Session-only drafts. Profiles and entry surfaces never share a buffer. */
export function composerDraftKey(profileId: string | undefined, surface: string): string {
  return JSON.stringify([profileId ?? null, surface])
}

export const useComposerDraftStore = create<{
  drafts: Record<string, ComposerDraft>
  beginSend: (key: string) => boolean
  endSend: (key: string) => void
  update: (key: string, recipe: (draft: ComposerDraft) => Partial<ComposerDraft>) => void
}>((set, get) => ({
  drafts: {},
  beginSend: (key) => {
    if (get().drafts[key]?.sending) return false
    get().update(key, () => ({ sending: true }))
    return true
  },
  endSend: (key) => get().update(key, () => ({ sending: false })),
  update: (key, recipe) => set((state) => {
    const previous = state.drafts[key] ?? EMPTY_COMPOSER_DRAFT
    const patch = recipe(previous)
    if (Object.entries(patch).every(([field, value]) => previous[field as keyof ComposerDraft] === value)) return state
    return { drafts: { ...state.drafts, [key]: { ...previous, ...patch } } }
  })
}))
