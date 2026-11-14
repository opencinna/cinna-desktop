import { create } from 'zustand'
import { previewKindFor, type PreviewRenderKind } from '../../../shared/filePreview'
import type { MessageAttachment } from '../../../shared/attachments'
import {
  agentFilePreviewKindFor,
  agentFileRefActions,
  isCredentialFileRef,
  type AgentFileErrorCode,
  type AgentFileRef,
  type AuthorizeAgentFileResult
} from '../../../shared/agentFiles'
import { authorizeAgentFile as authorize } from '../utils/agentFileAccess'
import { unwrapIpcError } from '../utils/ipcError'
import { loadImage, type ImageRef } from '../utils/imageDataCache'
import { createLogger } from './logger.store'
import { useRunScriptStore } from './runScript.store'

const log = createLogger('file-preview')

/** Where the user clicked, in viewport coordinates — the modal expands from it. */
export interface PreviewOrigin {
  x: number
  y: number
}

/**
 * What the modal shows: a message attachment, a file in a folder agent's
 * folder, or a composer file not sent yet (a new chat holds its files as
 * paths). `composer` marks an attachment opened from the composer, whose
 * preview offers no Download: the file is the user's own and not yet sent.
 */
export type PreviewTarget =
  | { type: 'attachment'; attachment: MessageAttachment; composer?: boolean }
  | { type: 'agentFile'; agentId: string; ref: AgentFileRef; messageId?: string | null }
  | { type: 'path'; path: string; filename: string; mimeType: string }

/** A composer file not sent yet, previewed by its path. */
export interface PathPreviewFile {
  path: string
  filename: string
  mimeType: string
}

/** A decoded image: its `data:` URL and natural size (0 when the size could not be read). */
export interface PreviewImage {
  url: string
  width: number
  height: number
}

/** A body that is a sentence rather than content. `folder`: a folder that cannot be shown in its folder (a vault's). */
export type PreviewNotice = 'credential' | 'unsupported' | 'folder'

/** Which step of an agent-file open failed; it decides how the body words the reason. */
export type AgentFileFailedStep = 'authorize' | 'preview' | 'reveal'

/** A header action: Open, Open folder, Open in browser, Run…, Download. */
export type PreviewAction = 'open' | 'reveal' | 'browser' | 'run' | 'download'

/**
 * Where a Run… from the preview resolves its agent and folder: the message
 * the reference was in, or — with none — the active chat, whose agent must be
 * the file's (main checks it again).
 */
export type PreviewRunSource =
  | { chatId: string; messageId: string }
  | { chatId: string; agentId: string }

/**
 * The source of a Run… on `target`, or null for none (no Run…): the target's
 * message in the active chat, else the active chat when its agent is the
 * file's agent. No active chat, no source.
 */
export function previewRunSource(
  target: PreviewTarget | null,
  activeChatId: string | null,
  activeChatAgentId: string | null | undefined
): PreviewRunSource | null {
  if (target?.type !== 'agentFile' || !activeChatId) return null
  if (target.messageId) return { chatId: activeChatId, messageId: target.messageId }
  return activeChatAgentId === target.agentId ? { chatId: activeChatId, agentId: target.agentId } : null
}

/**
 * Whether the preview offers Run… for an agent file: a file inside the
 * agent's folder, not a credential file, and a script — `.py`, `.sh`, or a
 * first line that is a `#!` shebang (`text`, once loaded). Main decides the
 * command, and may still refuse.
 */
export function isRunnableScriptRef(ref: AgentFileRef, text: string): boolean {
  if (ref.kind !== 'file' || !ref.inside || isCredentialFileRef(ref)) return false
  const name = ref.path.replace(/\\/g, '/').split('/').pop() ?? ''
  if ((name.endsWith('.py') && name !== '.py') || (name.endsWith('.sh') && name !== '.sh')) return true
  // A `#!` file is offered only with an extension: a bare name (`bin/tool`) is left out.
  return /[^.]\.[^./]+$/.test(name) && text.startsWith('#!')
}

/** A header action (Open / Open folder / Open in browser / Run…) that failed, shown inline under the header. */
export interface PreviewActionError {
  /** `pin`: Pin file / Unpin file in the ⋯ menu, which has no pending state of its own. */
  action: PreviewAction | 'pin'
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
  /** The image, decoded, for `kind === 'image'`; null until then. */
  image: PreviewImage | null
  /** True while the content fetch is in flight. */
  isLoading: boolean
  /** True when the file exceeded the byte cap and only a prefix is shown. */
  truncated: boolean
  /** With `truncated`, how many bytes of an agent file the text is (its source's cap); null for the shipped preview cap. */
  shownBytes: number | null
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
  pendingAction: PreviewAction | null
  /** Why the last Open / Open folder failed; shown inline, closes nothing. */
  actionError: PreviewActionError | null
  openPreview: (
    attachment: MessageAttachment,
    kind: PreviewRenderKind,
    options?: { composer?: boolean }
  ) => Promise<void>
  /** A composer file not sent yet, read by its path. */
  openPathPreview: (file: PathPreviewFile, kind: PreviewRenderKind) => Promise<void>
  /** `messageId`: the persisted message the reference was in, where a publish from the preview anchors its card. */
  openAgentFile: (agentId: string, ref: AgentFileRef, origin?: PreviewOrigin | null, messageId?: string | null) => Promise<void>
  openAgentFileExternally: () => Promise<void>
  revealAgentFile: () => Promise<void>
  /**
   * **Download** an agent file or folder whose reference offers it: the
   * source's own prompt and the save dialog. Pending and a refusal stay with
   * the preview (`pendingAction`, `actionError`); a cancelled dialog says nothing.
   */
  downloadAgentFile: () => Promise<void>
  /** Read the open agent file again, in place (after its vault was unlocked). */
  reloadAgentFile: () => Promise<void>
  /**
   * The agent's files may have become unreachable or reachable again (its
   * vault locked or unlocked): asks main about the open file without reading
   * it. An answer of `locked` swaps the body for the locked one; a body that
   * was locked and now answers is read again. Anything else leaves it alone.
   */
  recheckAgentFile: (agentId: string) => Promise<void>
  /** An HTML agent file or attachment in the default web browser. */
  openInBrowser: () => Promise<void>
  /**
   * Run…: main builds the command for the script, then the preview steps
   * aside for the Run Script window on it. Nothing runs. A refusal stays in
   * the preview, under the header.
   */
  runAgentFile: (source: PreviewRunSource, origin: PreviewOrigin | null) => Promise<void>
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
  image: null,
  isLoading: false,
  truncated: false,
  shownBytes: null,
  error: null,
  errorCode: null,
  failedStep: null,
  notice: null,
  origin: null,
  pendingAction: null,
  actionError: null
} satisfies Partial<FilePreviewState>

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
  // Main's sentence for Run… already says what could not be done.
  if (actionError.code === 'launch_failed' || actionError.action === 'run' || actionError.action === 'pin' || actionError.action === 'download') return actionError.reason
  if (actionError.action === 'browser') return `Couldn't open it in the browser: ${actionError.reason}`
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

/** How an agent file's body starts: the kind to render, or a notice shown without reading. */
interface AgentFileBody {
  kind: PreviewRenderKind | null
  notice: PreviewNotice | null
  isLoading: boolean
}

/**
 * An agent file's body before anything is read. A kind its source does not
 * preview is a notice; an image only for a source that previews images. A
 * name that is plainly a credential file is not even asked for — `.env` has
 * no preview kind, and would otherwise read as "no preview for this type".
 * Main refuses the read regardless, and catches what a name hides.
 */
function agentFileBody(ref: AgentFileRef): AgentFileBody {
  const actions = agentFileRefActions(ref)
  const image = actions.previewImages && previewKindFor(ref.path) === 'image'
  const kind: PreviewRenderKind | null = !actions.preview ? null : image ? 'image' : agentFilePreviewKindFor(ref.path)
  const notice: PreviewNotice | null = isCredentialFileRef(ref) ? 'credential' : kind ? null : 'unsupported'
  return { kind, notice, isLoading: notice === null }
}

/**
 * The image decoded before the modal counts as settled, so its entrance
 * measures the card at its final size (the card never grows under the
 * pointer). Where `decode` is missing, the size is left to the `<img>`.
 */
async function decodePreviewImage(url: string): Promise<PreviewImage> {
  if (typeof Image === 'undefined') return { url, width: 0, height: 0 }
  const img = new Image()
  if (typeof img.decode !== 'function') return { url, width: 0, height: 0 }
  img.src = url
  await img.decode()
  return { url, width: img.naturalWidth, height: img.naturalHeight }
}

/** How a {@link downloadAgentFileRef} ended. `done`: saved, or the save dialog was cancelled. */
export type AgentFileDownloadOutcome =
  | { status: 'done' }
  /** The user cancelled a prompt (consent, or the source's own): nothing is said. */
  | { status: 'cancelled' }
  /** `code` is null when a call threw rather than answering. */
  | { status: 'failed'; code: AgentFileErrorCode | null; error: string }

/**
 * **Download** one referenced file or folder whose source offers it: main's
 * authorize, then the source's own prompt and the save dialog. The preview's
 * Download and the message menu's both go through here. Never throws.
 */
export async function downloadAgentFileRef(agentId: string, ref: AgentFileRef): Promise<AgentFileDownloadOutcome> {
  const input = { agentId, path: ref.path }
  try {
    const access = await authorize({ ...input, purpose: 'read' })
    if (!access.success) return { status: 'failed', code: access.code, error: access.error }
    if (!access.approved) return { status: 'cancelled' }
    const result = await window.api.agentFiles.download(input)
    if (result.success) return { status: 'done' }
    if (result.code === 'denied') return { status: 'cancelled' }
    return { status: 'failed', code: result.code, error: result.error }
  } catch (err) {
    return { status: 'failed', code: null, error: unwrapIpcError(err, 'Could not save a copy of the file.') }
  }
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => {
  /**
   * Fill the open preview under `requestId`: an image through the shared
   * thumbnail cache and a decode, text through `readText`. A newer open or a
   * close in the meantime drops the result.
   */
  const fill = async (
    requestId: number,
    kind: PreviewRenderKind,
    image: ImageRef,
    readText: () => Promise<{ success: true; text: string; truncated: boolean } | { success: false; error: string }>
  ): Promise<void> => {
    try {
      if (kind === 'image') {
        const load = await loadImage(image)
        if (get().requestId !== requestId) return
        if (!load.ok) {
          set({ error: load.error, isLoading: false })
          return
        }
        let decoded: PreviewImage
        try {
          decoded = await decodePreviewImage(load.dataUrl)
        } catch {
          if (get().requestId !== requestId) return
          set({ error: 'The image could not be decoded.', isLoading: false })
          return
        }
        if (get().requestId !== requestId) return
        set({ image: decoded, isLoading: false })
        return
      }
      const result = await readText()
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
  }

  /** The open agent file's body becomes the locked one (Unlock); what it showed is dropped. */
  const showLocked = (reason: string): void => {
    set({
      requestId: get().requestId + 1,
      isLoading: false,
      text: '',
      image: null,
      truncated: false,
      shownBytes: null,
      error: reason,
      errorCode: 'locked',
      failedStep: 'preview',
      pendingAction: null,
      actionError: null
    })
  }

  const runAction = async (action: Exclude<PreviewAction, 'run'>): Promise<void> => {
    const target = get().target
    // Download takes a folder too (saved as a folder); the rest act on files.
    if (target?.type !== 'agentFile' || (target.ref.kind !== 'file' && action !== 'download') || get().pendingAction) return
    const input = { agentId: target.agentId, path: target.ref.path }
    const fail = (code: AgentFileErrorCode | null, reason: string): void => {
      if (get().target !== target) return
      // The files are out of reach (a locked vault): the body says so and offers to unlock.
      if (code === 'locked') return showLocked(reason)
      // Cancelled at a prompt: like a cancelled dialog, nothing is said.
      if (code === 'denied') return set({ pendingAction: null })
      set({ pendingAction: null, actionError: { action, code, reason } })
    }
    set({ pendingAction: action, actionError: null })
    if (action === 'download') {
      const outcome = await downloadAgentFileRef(target.agentId, target.ref)
      if (get().target !== target) return
      if (outcome.status === 'failed') fail(outcome.code, outcome.error)
      else set({ pendingAction: null })
      return
    }
    try {
      const purpose = action === 'browser' ? 'browser' : action === 'reveal' ? 'reveal' : 'show'
      const access = await authorize({ ...input, purpose })
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
          : action === 'browser'
            ? await window.api.agentFiles.openInBrowser(input)
            : await window.api.agentFiles.reveal(input)
      if (get().target !== target) return
      if (result.success) set({ pendingAction: null })
      else fail(result.code, result.error)
    } catch (err) {
      fail(null, unwrapIpcError(err))
    }
  }

  /**
   * Fill an agent file's body under `requestId`: a notice without reading
   * (a credential name, a kind its source cannot preview), an image through
   * `readImage` when the source previews images, else the text preview.
   */
  const loadAgentFile = async (
    target: Extract<PreviewTarget, { type: 'agentFile' }>,
    requestId: number,
    { kind, notice }: AgentFileBody
  ): Promise<void> => {
    if (notice) return
    const input = { agentId: target.agentId, path: target.ref.path }
    const failed = (code: AgentFileErrorCode, error: string): void => {
      if (code === 'credential_file') set({ notice: 'credential', isLoading: false })
      else if (code === 'not_previewable') set({ notice: 'unsupported', isLoading: false })
      else set({ error, errorCode: code, failedStep: 'preview', isLoading: false })
    }
    try {
      if (kind === 'image') {
        const result = await window.api.agentFiles.readImage(input)
        if (get().requestId !== requestId) return
        if (!result.success) return failed(result.code, result.error)
        let decoded: PreviewImage
        try {
          decoded = await decodePreviewImage(result.dataUrl)
        } catch {
          if (get().requestId !== requestId) return
          set({ error: 'The image could not be decoded.', failedStep: 'preview', isLoading: false })
          return
        }
        if (get().requestId !== requestId) return
        set({ image: decoded, isLoading: false })
        return
      }
      const result = await window.api.agentFiles.readPreview(input)
      if (get().requestId !== requestId) return
      if (result.success) {
        set({ text: result.text, truncated: result.truncated, shownBytes: result.shownBytes ?? null, isLoading: false })
      }
      else failed(result.code, result.error)
    } catch (err) {
      if (get().requestId !== requestId) return
      set({ error: unwrapIpcError(err), failedStep: 'preview', isLoading: false })
    }
  }

  return {
    ...closedState,
    openSeq: 0,
    requestId: 0,
    openPreview: async (attachment, kind, options) => {
      // An agent-file open still waiting on its consent dialog must not
      // replace the attachment the user opened after it.
      agentOpenToken += 1
      const requestId = get().requestId + 1
      const source = attachment.source ?? 'cinna'
      set({
        ...closedState,
        target: { type: 'attachment', attachment, ...(options?.composer ? { composer: true } : {}) },
        attachment,
        kind,
        isLoading: true,
        origin: recentPointer(),
        openSeq: get().openSeq + 1,
        requestId
      })
      await fill(requestId, kind, { type: 'attachment', fileId: attachment.id, source }, () =>
        window.api.files.readPreview({ fileId: attachment.id, source })
      )
    },

    openPathPreview: async (file, kind) => {
      agentOpenToken += 1
      const requestId = get().requestId + 1
      set({
        ...closedState,
        target: { type: 'path', path: file.path, filename: file.filename, mimeType: file.mimeType },
        kind,
        isLoading: true,
        origin: recentPointer(),
        openSeq: get().openSeq + 1,
        requestId
      })
      await fill(requestId, kind, { type: 'path', path: file.path }, () =>
        window.api.files.readPreviewPath({ path: file.path })
      )
    },

    openAgentFile: async (agentId, ref, origin = null, messageId = null) => {
      const token = ++agentOpenToken
      const input = { agentId, path: ref.path }
      const target: PreviewTarget = { type: 'agentFile', agentId, ref, messageId }
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

      const actions = agentFileRefActions(ref)
      if (ref.kind === 'dir') {
        // A folder whose source cannot show it in a file manager (a vault's)
        // opens the preview, which offers what it can (Download).
        if (!actions.reveal) {
          set({
            ...closedState,
            target,
            notice: 'folder',
            origin,
            openSeq: get().openSeq + 1,
            requestId: get().requestId + 1
          })
          return
        }
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

      const requestId = get().requestId + 1
      const body = agentFileBody(ref)
      set({
        ...closedState,
        target,
        ...body,
        origin,
        openSeq: get().openSeq + 1,
        requestId
      })
      await loadAgentFile(target, requestId, body)
    },

    openAgentFileExternally: () => runAction('open'),
    revealAgentFile: () => runAction('reveal'),
    downloadAgentFile: () => runAction('download'),
    reloadAgentFile: async () => {
      const target = get().target
      if (target?.type !== 'agentFile') return
      const requestId = get().requestId + 1
      const reset = { requestId, error: null, errorCode: null, failedStep: null, actionError: null, text: '', image: null, truncated: false, shownBytes: null }
      if (target.ref.kind === 'dir') {
        set({ ...reset, kind: null, isLoading: false, notice: agentFileRefActions(target.ref).reveal ? null : 'folder' })
        return
      }
      const body = agentFileBody(target.ref)
      set({ ...reset, ...body })
      await loadAgentFile(target, requestId, body)
    },
    recheckAgentFile: async (agentId) => {
      const target = get().target
      if (target?.type !== 'agentFile' || target.agentId !== agentId) return
      const wasLocked = get().errorCode === 'locked'
      let access: AuthorizeAgentFileResult
      try {
        access = await authorize({ agentId, path: target.ref.path })
      } catch {
        return
      }
      if (get().target !== target) return
      if (!access.success) {
        if (access.code === 'locked' && get().errorCode !== 'locked') showLocked(access.error)
        return
      }
      if (wasLocked && access.approved && get().errorCode === 'locked') await get().reloadAgentFile()
    },
    openInBrowser: async () => {
      const target = get().target
      if (target?.type === 'agentFile') return runAction('browser')
      if (target?.type !== 'attachment' || get().pendingAction) return
      const { attachment } = target
      // Main's `launch_failed` reason names the action itself; the row shows it as is.
      const fail = (reason: string, code: AgentFileErrorCode | null = null): void => {
        if (get().target !== target) return
        set({ pendingAction: null, actionError: { action: 'browser', code, reason } })
      }
      set({ pendingAction: 'browser', actionError: null })
      try {
        const result = await window.api.files.openInBrowser({
          fileId: attachment.id,
          filename: attachment.filename,
          source: attachment.source ?? 'cinna'
        })
        if (get().target !== target) return
        if (result.success) set({ pendingAction: null })
        else fail(result.error, result.code === 'launch_failed' ? 'launch_failed' : null)
      } catch (err) {
        fail(unwrapIpcError(err))
      }
    },

    runAgentFile: async (source, origin) => {
      const target = get().target
      if (target?.type !== 'agentFile' || target.ref.kind !== 'file' || get().pendingAction) return
      const fail = (reason: string): void => {
        if (get().target !== target) return
        set({ pendingAction: null, actionError: { action: 'run', code: null, reason } })
      }
      set({ pendingAction: 'run', actionError: null })
      try {
        const result = await window.api.userCommands.commandForFile({ ...source, path: target.ref.path })
        if (get().target !== target) return
        if (!result.ok) return fail(result.reason)
        // A start in flight in the window below holds it: opening now would open nothing.
        if (useRunScriptStore.getState().pending) return fail('A command is starting. Try again once it has.')
        const messageId = 'messageId' in source ? source.messageId : null
        get().close()
        void useRunScriptStore.getState().openFromCode({
          chatId: source.chatId,
          messageId,
          agentId: target.agentId,
          viaChatAgent: messageId === null,
          folder: result.folder,
          command: result.command,
          origin
        })
      } catch (err) {
        fail(unwrapIpcError(err, 'The command could not be prepared.'))
      }
    },

    close: () =>
      set((s) => ({
        ...closedState,
        // Bump so any in-flight fetch from the closed preview is discarded.
        requestId: s.requestId + 1
      }))
  }
})
