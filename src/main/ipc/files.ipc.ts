import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { basename, isAbsolute, join } from 'path'
import { fileService, assertFileScope, type FileScope } from '../services/fileService'
import { cinnaFileService } from '../services/cinnaFileService'
import { pathGuard } from '../services/pathGuard'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { ipcErrorShape } from '../errors'
import { ipcHandle } from './_wrap'
import { MAX_PREVIEW_BYTES } from '../../shared/filePreview'
import type { MessageAttachment, PendingAttachment } from '../../shared/attachments'

export type FilesPickAndUploadResult =
  | { success: true; canceled?: false; files: MessageAttachment[] }
  | { success: true; canceled: true; files: [] }
  | { success: false; canceled?: false; error: string; code?: string }

export type FilesDownloadResult =
  | { success: true; canceled?: false; savedPath: string }
  | { success: true; canceled: true }
  | { success: false; canceled?: false; error: string; code?: string }

/** Extensions the local-scope picker steers users toward. Mirrors the MIME
 *  map in `fileStore` + `textExtractor` — formats the adapters can actually
 *  consume after image bytes-through / native PDF / text extraction. */
const LOCAL_PICKER_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf',
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'ts', 'py', 'sh', 'log'
]

/**
 * Files IPC — thin controller layer. All business logic (scope routing,
 * ownership checks, store dispatch, stream pipelines) lives in
 * `fileService`; these handlers only translate between Electron dialog
 * UX and service calls.
 */
export function registerFilesHandlers(): void {
  // Preload's `webUtils.getPathForFile` wrapper fires this fire-and-forget
  // whenever the renderer resolves a dropped File to its OS path. The
  // recording happens on the same WebContents queue as the subsequent
  // resolve/ingest IPC, so by the time those handlers run the path is
  // already in the allowlist. Receiving a path here is itself evidence
  // of intent (the renderer can't construct a File pointing anywhere
  // it wants), so we don't gate this channel further.
  ipcMain.on('files:track-path', (_event, path: unknown) => {
    if (typeof path === 'string' && path.length > 0 && isAbsolute(path)) {
      pathGuard.record(path)
    }
  })

  ipcHandle(
    'files:pick-and-upload',
    async (
      event,
      opts?: { scope?: 'cinna' | 'local'; chatId?: string | null }
    ): Promise<FilesPickAndUploadResult> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()

      const scopeRaw = opts?.scope ?? 'cinna'
      assertFileScope(scopeRaw)
      const scope: FileScope = scopeRaw
      const chatId = opts?.chatId ?? null

      // Local scope is steered toward formats we can consume; Cinna scope
      // stays unfiltered because the backend's whitelist is authoritative
      // there.
      const filters =
        scope === 'local'
          ? [
              { name: 'Supported files', extensions: LOCAL_PICKER_EXTENSIONS },
              { name: 'All files', extensions: ['*'] }
            ]
          : undefined
      const dialogOpts = {
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        title: 'Attach files',
        ...(filters ? { filters } : {})
      }
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const picked = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, canceled: true, files: [] }
      }
      // OS dialog results are trustworthy by construction; record them
      // in case the renderer later round-trips a path through ingest.
      pathGuard.recordMany(picked.filePaths)

      try {
        const files = await fileService.ingest({
          userId,
          scope,
          chatId,
          filePaths: picked.filePaths
        })
        return { success: true, files }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * Picker-with-deferred-ingest. Opens the dialog like
   * `files:pick-and-upload`, but instead of uploading the picked files
   * it returns `{source: 'pending', id: <path>, …}` attachments — bytes
   * stay on disk. The new-chat composer uses this so a single
   * destination decision at send time picks the right scope.
   */
  ipcHandle(
    'files:pick-paths',
    async (
      event
    ): Promise<
      | { success: true; canceled?: false; files: PendingAttachment[] }
      | { success: true; canceled: true; files: [] }
      | { success: false; canceled?: false; error: string; code?: string }
    > => {
      userActivation.requireActivated()
      const dialogOpts = {
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        title: 'Attach files',
        filters: [
          { name: 'Supported files', extensions: LOCAL_PICKER_EXTENSIONS },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const picked = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, canceled: true, files: [] }
      }
      // OS dialog results are trustworthy; record before resolve so the
      // resolver's allowlist check passes for these paths.
      pathGuard.recordMany(picked.filePaths)
      try {
        const files = await fileService.resolvePaths(picked.filePaths)
        return { success: true, files }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * Drag-drop deferred-ingest variant. Used by the new-chat composer:
   * dropped paths get stat'd and returned as `pending` attachments
   * without ingesting. Same shape as the picker's deferred form so the
   * renderer can treat picker + drop uniformly.
   */
  ipcHandle(
    'files:resolve-paths',
    async (
      _event,
      data: { paths: string[] }
    ): Promise<
      | { success: true; files: PendingAttachment[] }
      | { success: false; error: string; code?: string }
    > => {
      userActivation.requireActivated()
      if (!Array.isArray(data.paths) || data.paths.length === 0) {
        return { success: true, files: [] }
      }
      const absolute = data.paths.filter(
        (p) => typeof p === 'string' && p.length > 0 && isAbsolute(p)
      )
      if (absolute.length === 0) {
        return { success: true, files: [] }
      }
      // Defense in depth — only allowlisted paths (legitimately surfaced
      // by the user via drop or picker) are accepted. A renderer
      // synthesizing arbitrary absolute paths gets filtered out here.
      const { allowed } = pathGuard.filterAllowed(absolute)
      if (allowed.length === 0) {
        return { success: true, files: [] }
      }
      try {
        const files = await fileService.resolvePaths(allowed)
        return { success: true, files }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * Drag-drop entry point. The renderer hands us paths already resolved
   * via `webUtils.getPathForFile` — no dialog. Wires straight into the
   * service so ownership / scope validation and partial-failure semantics
   * match the picker path.
   */
  ipcHandle(
    'files:ingest-paths',
    async (
      _event,
      data: { scope?: 'cinna' | 'local'; chatId?: string | null; paths: string[] }
    ): Promise<
      | { success: true; files: MessageAttachment[] }
      | { success: false; error: string; code?: string }
    > => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      const scopeRaw = data.scope ?? 'cinna'
      try {
        assertFileScope(scopeRaw)
        if (!Array.isArray(data.paths) || data.paths.length === 0) {
          return { success: true, files: [] }
        }
        // Defense-in-depth: reject anything that doesn't look like an
        // absolute path. `webUtils.getPathForFile` returns absolute paths
        // for legitimately-dropped files; a renderer crafting relative
        // paths would otherwise leak the main process's CWD into ingest.
        const absolute = data.paths.filter(
          (p) => typeof p === 'string' && p.length > 0 && isAbsolute(p)
        )
        // And further: only paths the user has actually surfaced via
        // drag/drop or a file dialog pass through. A renderer
        // synthesizing arbitrary absolute paths gets filtered out.
        const { allowed } = pathGuard.filterAllowed(absolute)
        if (allowed.length === 0) {
          return { success: true, files: [] }
        }
        const files = await fileService.ingest({
          userId,
          scope: scopeRaw,
          chatId: data.chatId ?? null,
          filePaths: allowed
        })
        return { success: true, files }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  ipcHandle(
    'files:remove',
    async (
      _event,
      arg: string | { id: string; source?: 'cinna' | 'local' }
    ): Promise<{ success: true } | { success: false; error: string; code?: string }> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      // Legacy callers send a bare fileId (always Cinna). Modern callers
      // send `{ id, source }` so the right store is targeted.
      const attachmentId = typeof arg === 'string' ? arg : arg.id
      const sourceRaw = typeof arg === 'string' ? 'cinna' : arg.source ?? 'cinna'
      try {
        assertFileScope(sourceRaw)
        await fileService.remove({ userId, attachmentId, source: sourceRaw })
        return { success: true }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * Save-as flow. Dispatches by attachment source so a `local` attachment
   * gets a disk-to-disk copy and a `cinna` attachment streams from the
   * backend — the controller just owns the dialog + reveal UX.
   */
  ipcHandle(
    'files:download',
    async (
      event,
      data: { fileId: string; filename: string; source?: 'cinna' | 'local' }
    ): Promise<FilesDownloadResult> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      const sourceRaw = data.source ?? 'cinna'
      try {
        assertFileScope(sourceRaw)
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }

      // `basename` strips any `..` / path separators the renderer might
      // sneak into the filename, keeping the dialog rooted in Downloads.
      const safeFilename = basename(data.filename) || 'download'
      const defaultPath = join(app.getPath('downloads'), safeFilename)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const saveResult = win
        ? await dialog.showSaveDialog(win, { defaultPath, title: 'Save attachment' })
        : await dialog.showSaveDialog({ defaultPath, title: 'Save attachment' })
      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true }
      }

      try {
        await fileService.downloadToPath({
          userId,
          attachmentId: data.fileId,
          source: sourceRaw,
          destPath: saveResult.filePath
        })
        try {
          shell.showItemInFolder(saveResult.filePath)
        } catch {
          // File is on disk; reveal is best-effort.
        }
        return { success: true, savedPath: saveResult.filePath }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * In-app preview. Reads a small text attachment's bytes into memory
   * (capped at {@link MAX_PREVIEW_BYTES}) and returns the decoded UTF-8 so
   * the renderer can show it in a modal without a save dialog. Only the
   * preview-supported text formats reach here — the renderer gates the call
   * on `previewKindFor`.
   */
  ipcHandle(
    'files:read-preview',
    async (
      _event,
      data: { fileId: string; source?: 'cinna' | 'local' }
    ): Promise<
      | { success: true; text: string; truncated: boolean }
      | { success: false; error: string; code?: string }
    > => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      const sourceRaw = data.source ?? 'cinna'
      try {
        assertFileScope(sourceRaw)
        const { text, truncated } = await fileService.readTextPreview({
          userId,
          attachmentId: data.fileId,
          source: sourceRaw,
          maxBytes: MAX_PREVIEW_BYTES
        })
        return { success: true, text, truncated }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * Task-scoped attachment download. Distinct from `files:download`
   * because cinna-core's task attachments live behind their own URL — we
   * delegate to `cinnaFileService` directly. No local equivalent exists.
   */
  ipcHandle(
    'files:download-task-attachment',
    async (
      event,
      data: { taskId: string; attachmentId: string; filename: string }
    ): Promise<FilesDownloadResult> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()

      const safeFilename = basename(data.filename) || 'download'
      const defaultPath = join(app.getPath('downloads'), safeFilename)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const saveResult = win
        ? await dialog.showSaveDialog(win, { defaultPath, title: 'Save attachment' })
        : await dialog.showSaveDialog({ defaultPath, title: 'Save attachment' })
      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true }
      }

      try {
        await cinnaFileService.downloadTaskAttachmentToPath(
          userId,
          data.taskId,
          data.attachmentId,
          saveResult.filePath
        )
        try {
          shell.showItemInFolder(saveResult.filePath)
        } catch {
          // Ignored — file is on disk.
        }
        return { success: true, savedPath: saveResult.filePath }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )
}
