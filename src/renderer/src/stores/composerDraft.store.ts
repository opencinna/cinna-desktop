import { create } from 'zustand'
import type { ComposerAttachment } from '../../../shared/attachments'
import type { ComposerPathRef } from '../../../shared/pathMentions'
import type { ComposerPaste } from '../../../shared/pastedText'
import type { DefaultMultiAgentRouting } from '../../../shared/chatRouting'

export interface ComposerDraft {
  sending: boolean
  text: string
  notes: { id: string; title: string }[]
  /** Files and folders referenced by path (chips); sent as lines naming each path, never read. Unique by `path`. */
  pathRefs: ComposerPathRef[]
  /** Long plain-text pastes (chips); sent as `<pasted_text>` blocks before the typed text. Same text twice is two chips. */
  pastes: ComposerPaste[]
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
  /** The agent picked to conduct with "Set as Coordinator"; null for the default conductor. */
  conductorId: string | null
  /**
   * Who routes a chat of several agents with no MCP server, in place of the
   * Settings default; null is the default. Set by New chat from a `human` chat,
   * so the copy is not coordinated because the default is.
   */
  multiAgentRouting: DefaultMultiAgentRouting | null
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  sending: false,
  text: '', notes: [], pathRefs: [], pastes: [],
  files: { attachments: [], uploading: false, error: null, token: null },
  modeSelection: 'auto', pendingAgentIds: null, pendingMcpIds: [], coordinate: false, conductorId: null, multiAgentRouting: null
}

/**
 * The surface of the main new-chat screen (`ChatWorkspace` with no chat open),
 * where every "chat with this agent" landing arrives.
 */
export const NEW_CHAT_DRAFT_SURFACE = 'dashboard'

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
