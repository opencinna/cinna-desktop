import { create } from 'zustand'
import type { PreviewRenderKind } from '../../../shared/filePreview'
import type { MessageAttachment } from '../../../shared/attachments'
import {
  agentFilePreviewKindFor,
  isCredentialFilePath,
  type AgentFileErrorCode,
  type AgentFilePathInput,
  type AgentFileRef,
  type AuthorizeAgentFileResult
} from '../../../shared/agentFiles'
import { unwrapIpcError } from '../utils/ipcError'
import { createLogger } from './logger.store'

const log = createLogger('file-preview')

/** Where the user clicked, in viewport coordinates — the modal expands from it. */
export interface PreviewOrigin {
  x: number
  y: number
}

/** What the modal shows: a message attachment, or a file in a folder agent's folder. */
export type PreviewTarget =
  | { type: 'attachment'; attachment: MessageAttachment }
  | { type: 'agentFile'; agentId: string; ref: AgentFileRef }

/** A body that is a sentence rather than content. */
export type PreviewNotice = 'credential' | 'unsupported'

/** Which step of an agent-file open failed; it decides how the body words the reason. */
export type AgentFileFailedStep = 'authorize' | 'preview' | 'reveal'

/** A header action (Open / Open folder) that failed, shown inline under the header. */
export interface PreviewActionError {
  action: 'open' | 'reveal'
  /** Null when the call itself threw rather than answering. */
  code: AgentFileErrorCode | null
  reason: string
}

/**
 * Drives the single global {@link FilePreviewModal}. Two ways in:
 *
 * - **Attachments** — a badge click for a previewable attachment calls
 *   {@link openPreview}; the content comes over `files:read-preview`.
 * - **Agent files** — a file reference in a folder agent's chat calls
 *   {@link openAgentFile}. Main authorizes every path first (asking the user
 *   natively for one outside the agent folder); a folder is revealed rather
 *   than previewed.
 *
 * Only one preview is open at a time — opening a second replaces the first.
 *
 * The attachment download action is intentionally NOT here — the modal's
 * Download button reuses `useFileDownloadStore`, one source of truth for
 * save-as.
 */
interface FilePreviewState {
  target: PreviewTarget | null
  /** The attachment being previewed; null for an agent file and when closed. */
  attachment: MessageAttachment | null
  /** How the modal should render the text; null when there is nothing to render. */
  kind: PreviewRenderKind | null
  text: string
  /** True while the content fetch is in flight. */
  isLoading: boolean
  /** True when the file exceeded the byte cap and only a prefix is shown. */
  truncated: boolean
  /** Why the body has nothing to show — the reason as main or the call gave it. */
  error: string | null
  /** An agent file's failure code; null for attachments and thrown calls. */
  errorCode: AgentFileErrorCode | null
  /** The agent-file step that failed; null for attachments. */
  failedStep: AgentFileFailedStep | null
  notice: PreviewNotice | null
  /** The click the modal expands from; null means its centre (keyboard). */
  origin: PreviewOrigin | null
  /** Bumped on every open, so the modal replays its entrance. */
  openSeq: number
  /** Monotonic token guarding against a stale fetch resolving after the user
   *  reopened a different file. */
  requestId: number
  /** The header action in flight for an agent file. */
  pendingAction: 'open' | 'reveal' | null
  /** Why the last Open / Open folder failed; shown inline, closes nothing. */
  actionError: PreviewActionError | null
  openPreview: (attachment: MessageAttachment, kind: PreviewRenderKind) => Promise<void>
  openAgentFile: (agentId: string, ref: AgentFileRef, origin?: PreviewOrigin | null) => Promise<void>
  openAgentFileExternally: () => Promise<void>
  revealAgentFile: () => Promise<void>
  close: () => void
}

/**
 * The last pointer-down anywhere in the window. An attachment badge's click
 * handler has no event to hand over, so the origin is captured here instead of
 * being threaded through every badge list. Too old means the open came from
 * the keyboard.
 */
let lastPointer: { x: number; y: number; at: number } | null = null
const POINTER_ORIGIN_MAX_AGE_MS = 1000
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY, at: Date.now() }
    },
    true
  )
}

function recentPointer(): PreviewOrigin | null {
  if (!lastPointer || Date.now() - lastPointer.at > POINTER_ORIGIN_MAX_AGE_MS) return null
  return { x: lastPointer.x, y: lastPointer.y }
}

/** Guards an agent-file open across the consent dialog: a newer open wins. */
let agentOpenToken = 0

const closedState = {
  target: null,
  attachment: null,
  kind: null,
  text: '',
  isLoading: false,
  truncated: false,
  error: null,
  errorCode: null,
  failedStep: null,
  notice: null,
  origin: null,
  pendingAction: null,
  actionError: null
} satisfies Partial<FilePreviewState>

/**
 * Whether the renderer may act on `ref`. Always main's answer, inside the
 * agent folder too: the renderer's `inside` flag was true when the transcript
 * resolved and may not be now (the file became a symlink out of the folder).
 * Main answers an inside path without a dialog.
 */
function authorize(input: AgentFilePathInput): Promise<AuthorizeAgentFileResult> {
  return window.api.agentFiles.authorize(input)
}

/**
 * The body sentence for an agent file that could not be shown. A folder that
 * has gone says so in its own words (main's `not_found` speaks of a file); a
 * failure of a named step names it; anything else is main's reason as is.
 */
export function agentFileErrorText(
  ref: AgentFileRef,
  step: AgentFileFailedStep | null,
  code: AgentFileErrorCode | null,
  reason: string
): string {
  if (code === 'not_found') return ref.kind === 'dir' ? 'That folder is no longer there.' : reason
  if (code === 'launch_failed') return reason
  if (step === 'reveal') return `Couldn't show it in its folder: ${reason}`
  if (step === 'preview') return `Couldn't load preview: ${reason}`
  return reason
}

/**
 * The action row's sentence: it names the action that failed. Main's
 * `launch_failed` reason already does ("No app could open this file."), so it
 * is shown as is rather than prefixed a second time.
 */
export function actionErrorText(actionError: PreviewActionError): string {
  if (actionError.code === 'launch_failed') return actionError.reason
  return actionError.action === 'open'
    ? `Couldn't open it: ${actionError.reason}`
    : `Couldn't show it in its folder: ${actionError.reason}`
}

/**
 * Whether the action row would repeat what the body already says — the same
 * underlying failure, e.g. a file that has gone. Then the row is not shown.
 */
export function actionErrorRepeatsBody(
  state: Pick<FilePreviewState, 'actionError' | 'error' | 'errorCode' | 'isLoading'>
): boolean {
  const { actionError, error, errorCode } = state
  if (!actionError || state.isLoading || error === null) return false
  if (actionError.code !== null && actionError.code === errorCode) return true
  return actionError.reason === error
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => {
  const runAction = async (action: 'open' | 'reveal'): Promise<void> => {
    const target = get().target
    if (target?.type !== 'agentFile' || target.ref.kind !== 'file' || get().pendingAction) return
    const input = { agentId: target.agentId, path: target.ref.path }
    const fail = (code: AgentFileErrorCode | null, reason: string): void => {
      if (get().target !== target) return
      set({ pendingAction: null, actionError: { action, code, reason } })
    }
    set({ pendingAction: action, actionError: null })
    try {
      const access = await authorize(input)
      if (get().target !== target) return
      if (!access.success) return fail(access.code, access.error)
      // Denied: nothing launches and nothing is said — the user chose it.
      if (!access.approved) {
        set({ pendingAction: null })
        return
      }
      const result =
        action === 'open'
          ? await window.api.agentFiles.open(input)
          : await window.api.agentFiles.reveal(input)
      if (get().target !== target) return
      if (result.success) set({ pendingAction: null })
      else fail(result.code, result.error)
    } catch (err) {
      fail(null, unwrapIpcError(err))
    }
  }

  return {
    ...closedState,
    openSeq: 0,
    requestId: 0,
    openPreview: async (attachment, kind) => {
      // An agent-file open still waiting on its consent dialog must not
      // replace the attachment the user opened after it.
      agentOpenToken += 1
      const requestId = get().requestId + 1
      set({
        ...closedState,
        target: { type: 'attachment', attachment },
        attachment,
        kind,
        isLoading: true,
        origin: recentPointer(),
        openSeq: get().openSeq + 1,
        requestId
      })
      try {
        const result = await window.api.files.readPreview({
          fileId: attachment.id,
          source: attachment.source ?? 'cinna'
        })
        // A newer open (or a close) happened while we were fetching — drop this
        // result so we don't clobber the current modal.
        if (get().requestId !== requestId) return
        if (result.success) {
          set({ text: result.text, truncated: result.truncated, isLoading: false })
        } else {
          set({ error: result.error, isLoading: false })
        }
      } catch (err) {
        if (get().requestId !== requestId) return
        set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
      }
    },

    openAgentFile: async (agentId, ref, origin = null) => {
      const token = ++agentOpenToken
      const input = { agentId, path: ref.path }
      const target: PreviewTarget = { type: 'agentFile', agentId, ref }
      // A failure before there is anything to preview still opens the modal,
      // where the click was, saying why — a click that does nothing is worse.
      const openFailed = (step: AgentFileFailedStep, code: AgentFileErrorCode | null, reason: string): void => {
        if (token !== agentOpenToken) return
        set({
          ...closedState,
          target,
          error: reason,
          errorCode: code,
          failedStep: step,
          origin,
          openSeq: get().openSeq + 1,
          requestId: get().requestId + 1
        })
      }

      let access: AuthorizeAgentFileResult
      try {
        access = await authorize(input)
      } catch (err) {
        openFailed('authorize', null, unwrapIpcError(err))
        return
      }
      if (token !== agentOpenToken) return
      if (!access.success) {
        log.warn('could not authorize an agent file', { code: access.code })
        openFailed('authorize', access.code, access.error)
        return
      }
      // Denied: nothing opens and nothing is said — the user chose it.
      if (!access.approved) return

      if (ref.kind === 'dir') {
        try {
          const result = await window.api.agentFiles.reveal(input)
          if (result.success) return
          log.warn('could not reveal an agent folder', { code: result.code })
          openFailed('reveal', result.code, result.error)
        } catch (err) {
          openFailed('reveal', null, unwrapIpcError(err))
        }
        return
      }

      const kind = agentFilePreviewKindFor(ref.path)
      // A name that is plainly a credential file is not even asked for — `.env`
      // has no preview kind, and would otherwise read as "no preview for this
      // type". Main refuses the read regardless, and catches what a name hides.
      const credential = ref.inside
        ? isCredentialFilePath(`/${ref.displayPath}`, '/')
        : isCredentialFilePath(ref.path, null)
      const notice: PreviewNotice | null = credential ? 'credential' : kind ? null : 'unsupported'
      const requestId = get().requestId + 1
      set({
        ...closedState,
        target,
        kind,
        isLoading: notice === null,
        notice,
        origin,
        openSeq: get().openSeq + 1,
        requestId
      })
      if (notice) return
      try {
        const result = await window.api.agentFiles.readPreview(input)
        if (get().requestId !== requestId) return
        if (result.success) {
          set({ text: result.text, truncated: result.truncated, isLoading: false })
        } else if (result.code === 'credential_file') {
          set({ notice: 'credential', isLoading: false })
        } else if (result.code === 'not_previewable') {
          set({ notice: 'unsupported', isLoading: false })
        } else {
          set({ error: result.error, errorCode: result.code, failedStep: 'preview', isLoading: false })
        }
      } catch (err) {
        if (get().requestId !== requestId) return
        set({ error: unwrapIpcError(err), failedStep: 'preview', isLoading: false })
      }
    },

    openAgentFileExternally: () => runAction('open'),
    revealAgentFile: () => runAction('reveal'),

    close: () =>
      set((s) => ({
        ...closedState,
        // Bump so any in-flight fetch from the closed preview is discarded.
        requestId: s.requestId + 1
      }))
  }
})
