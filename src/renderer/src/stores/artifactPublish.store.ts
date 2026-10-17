import { create } from 'zustand'
import type {
  ArtifactsProgressPhase,
  CreatedArtifactLink,
  PublishArtifactInput
} from '../../../shared/artifacts'
import { unwrapIpcError } from '../utils/ipcError'

/** What the Publish dialog was opened on: a file or folder reference in a chat. */
export interface PublishRequest {
  agentId: string
  path: string
  kind: 'file' | 'dir'
  /** The chat the card goes into; null outside a chat. */
  chatId: string | null
  /** The message whose reference opened it; null to anchor after the chat's newest. */
  messageId: string | null
  /**
   * Edit… on an agent's request (`art_…`): the dialog starts from what the
   * agent asked, and its Publish answers that request instead of publishing
   * on its own — the agent then gets the result.
   */
  /** Edit… on an agent's request: what it asked for, and whose request it is (the dialog's title). */
  approval?: { requestId: string; title: string; description: string | null; entry: string | null; agentName?: string }
}

interface ArtifactPublishState {
  request: PublishRequest | null
  /** Bumped on every open, so the dialog starts fresh. */
  openSeq: number
  publishing: boolean
  /** The publish's phase from main, for the button label. */
  phase: ArtifactsProgressPhase | null
  operationId: string | null
  error: string | null
  /** The artifact the last publish refused to update because it is gone. */
  goneArtifactId: string | null
  /** Public links created at publish, shown once on the card: never stored. */
  freshLinks: Record<string, CreatedArtifactLink>
  /** A publish that worked whose follow-up did not, said once on the card. */
  warnings: Record<string, string>
  open: (request: PublishRequest) => void
  /** Ignored while publishing: dismissing would cancel nothing and hide what is happening. */
  close: () => void
  publish: (input: Omit<PublishArtifactInput, 'operationId' | 'anchor' | 'agentId' | 'path'>) => Promise<void>
  setPhase: (operationId: string, phase: ArtifactsProgressPhase) => void
  dismissFreshLink: (artifactId: string) => void
  dismissWarning: (artifactId: string) => void
}

let sequence = 0

/**
 * The Publish dialog's state and its one mutation. The call lives here, not
 * in the dialog, so its result lands even if the dialog unmounted meanwhile
 * (a TanStack mutate-level callback would be dropped). The dialog closes on
 * success only; a refusal is said inside it.
 */
export const useArtifactPublishStore = create<ArtifactPublishState>((set, get) => ({
  request: null,
  openSeq: 0,
  publishing: false,
  phase: null,
  operationId: null,
  error: null,
  goneArtifactId: null,
  freshLinks: {},
  warnings: {},
  open: (request) => {
    if (get().publishing) return
    set((state) => ({ request, openSeq: state.openSeq + 1, error: null, phase: null, goneArtifactId: null }))
  },
  close: () => {
    if (get().publishing) return
    set({ request: null, error: null, phase: null, goneArtifactId: null })
  },
  publish: async (input) => {
    const { request, publishing } = get()
    if (!request || publishing) return
    const operationId = `publish-${Date.now()}-${++sequence}`
    set({ publishing: true, phase: null, operationId, error: null, goneArtifactId: null })
    try {
      if (request.approval) {
        const answer = await window.api.artifacts.answerApproval({
          requestId: request.approval.requestId,
          decision: 'publish',
          edits: {
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            entry: input.entry ?? null,
            artifactId: input.artifactId ?? null,
            visibility: input.visibility === 'keep' ? 'private' : input.visibility
          }
        })
        if (answer.ok) {
          const id = answer.artifact?.id
          set((state) => ({
            publishing: false,
            phase: null,
            operationId: null,
            request: null,
            freshLinks: id && answer.link ? { ...state.freshLinks, [id]: answer.link } : state.freshLinks,
            warnings: id && answer.warning ? { ...state.warnings, [id]: answer.warning } : state.warnings
          }))
        } else {
          set({ publishing: false, phase: null, operationId: null, error: answer.message, goneArtifactId: null })
        }
        return
      }
      const result = await window.api.artifacts.publish({
        ...input,
        agentId: request.agentId,
        path: request.path,
        operationId,
        anchor: request.chatId ? { chatId: request.chatId, messageId: request.messageId } : null
      })
      if (result.ok) {
        const id = result.artifact.id
        set((state) => ({
          publishing: false,
          phase: null,
          operationId: null,
          request: null,
          freshLinks: result.link ? { ...state.freshLinks, [id]: result.link } : state.freshLinks,
          warnings: result.warning ? { ...state.warnings, [id]: result.warning } : state.warnings
        }))
      } else {
        set({
          publishing: false,
          phase: null,
          operationId: null,
          error: result.message,
          goneArtifactId: result.code === 'gone' && input.artifactId ? input.artifactId : null
        })
      }
    } catch (err) {
      set({ publishing: false, phase: null, operationId: null, error: unwrapIpcError(err, 'Could not publish.') })
    }
  },
  setPhase: (operationId, phase) => {
    if (get().operationId === operationId) set({ phase })
  },
  dismissFreshLink: (artifactId) =>
    set((state) => {
      const { [artifactId]: _gone, ...rest } = state.freshLinks
      return { freshLinks: rest }
    }),
  dismissWarning: (artifactId) =>
    set((state) => {
      const { [artifactId]: _gone, ...rest } = state.warnings
      return { warnings: rest }
    })
}))
