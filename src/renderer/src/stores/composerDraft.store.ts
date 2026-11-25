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
export const NEW_CHAT_DRAFT_SURFACE = 'new-chat'

/** Session-only drafts. Profiles and entry surfaces never share a buffer. */
export function composerDraftKey(profileId: string | undefined, surface: string): string {
  return JSON.stringify([profileId ?? null, surface])
}

/** The surface a draft key names (`chat:<id>`, `agent:<id>`, …), or null for a key not made by {@link composerDraftKey}. */
export function composerDraftSurface(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : null
  } catch {
    return null
  }
}

/** The surface a profile switch lands on: a chat's id means nothing in another profile, so its draft goes to the new-chat screen. */
function landingSurface(surface: string): string {
  return surface.startsWith('chat:') ? NEW_CHAT_DRAFT_SURFACE : surface
}

/**
 * Moves the message typed under `fromKey` to the same surface of the profile switched to (a chat's
 * to the new-chat screen, where the switch lands), so a Switch to <name> from the composer does not
 * leave it behind. Only the message travels — its text, pasted blocks and path chips; notes and
 * uploads belong to the old profile and stay. Joined after what the target already holds, and taken
 * out of the old draft so it is not sent twice. Nothing moves while the old draft is sending.
 *
 * Landing on the new-chat screen, the agent it was addressed to goes along as that screen's agent
 * pick (`pendingAgentIds`), so Send there reaches the agent and not the default mode: a chat's
 * `agentIds` (the composer's direct target), or the new-chat draft's own pick. It replaces what the
 * target had picked, since the message was written for this agent; mode and MCP picks stay as they
 * are. It goes even when nothing is typed, since the switch was made for this agent.
 */
export function carryComposerDraft(fromKey: string, toProfileId: string, options: { agentIds?: readonly string[] } = {}): void {
  const surface = composerDraftSurface(fromKey)
  if (surface === null) return
  const store = useComposerDraftStore.getState()
  const from = store.drafts[fromKey]
  if (from?.sending) return
  const landing = landingSurface(surface)
  const toKey = composerDraftKey(toProfileId, landing)
  if (toKey === fromKey) return
  const picked = landing !== NEW_CHAT_DRAFT_SURFACE ? []
    : surface === NEW_CHAT_DRAFT_SURFACE ? from?.pendingAgentIds ?? options.agentIds ?? []
      : options.agentIds ?? []
  if (picked.length > 0) store.update(toKey, () => ({ pendingAgentIds: [...picked] }))
  if (!from || (from.text.trim() === '' && from.pastes.length === 0 && from.pathRefs.length === 0)) return
  store.update(toKey, (to) => ({
    text: to.text.trim() === '' ? from.text : from.text.trim() === '' ? to.text : `${to.text.replace(/\s+$/, '')}\n\n${from.text}`,
    pastes: [...to.pastes, ...from.pastes],
    pathRefs: [...to.pathRefs, ...from.pathRefs.filter((ref) => !to.pathRefs.some((own) => own.path === ref.path))]
  }))
  store.update(fromKey, () => ({ text: '', pastes: [], pathRefs: [] }))
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
