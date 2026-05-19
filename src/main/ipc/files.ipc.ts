import { BrowserWindow, app, dialog, shell } from 'electron'
import { join } from 'path'
import { cinnaFileService } from '../services/cinnaFileService'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { ipcErrorShape } from '../errors'
import { ipcHandle } from './_wrap'
import type { MessageAttachment } from '../../shared/attachments'

export type FilesPickAndUploadResult =
  | { success: true; canceled?: false; files: MessageAttachment[] }
  | { success: true; canceled: true; files: [] }
  | { success: false; canceled?: false; error: string; code?: string }

export type FilesDownloadResult =
  | { success: true; canceled?: false; savedPath: string }
  | { success: true; canceled: true }
  | { success: false; canceled?: false; error: string; code?: string }

/**
 * Files IPC: opens the native OS picker, uploads each chosen file to the
 * Cinna backend, returns the condensed {@link MessageAttachment} list to the
 * renderer. Renderer keeps the list in local state and ships it as extras on
 * the next agent send.
 *
 * Gated on `cinna_user` — local accounts have nowhere to upload to and the
 * service throws `not_cinna_user`.
 */
export function registerFilesHandlers(): void {
  ipcHandle('files:pick-and-upload', async (event): Promise<FilesPickAndUploadResult> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()

    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          title: 'Attach files'
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          title: 'Attach files'
        })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, canceled: true, files: [] }
    }

    try {
      const files = await cinnaFileService.uploadMany(userId, result.filePaths)
      return { success: true, files }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false, error: e.message, code: e.code }
    }
  })

  ipcHandle(
    'files:remove',
    async (
      _event,
      fileId: string
    ): Promise<{ success: true } | { success: false; error: string; code?: string }> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      try {
        await cinnaFileService.deleteFile(userId, fileId)
        return { success: true }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )

  /**
   * Save-as flow for an existing uploaded file. Opens the OS save dialog with
   * the original filename as the default, streams from the Cinna backend to
   * the chosen path, then reveals the file in Finder/Explorer so the user
   * can drag it out, open it, or copy elsewhere.
   */
  ipcHandle(
    'files:download',
    async (
      event,
      data: { fileId: string; filename: string }
    ): Promise<FilesDownloadResult> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()

      const defaultPath = join(app.getPath('downloads'), data.filename)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const saveResult = win
        ? await dialog.showSaveDialog(win, { defaultPath, title: 'Save attachment' })
        : await dialog.showSaveDialog({ defaultPath, title: 'Save attachment' })
      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true }
      }

      try {
        await cinnaFileService.downloadToPath(userId, data.fileId, saveResult.filePath)
        // Best-effort reveal — failure here doesn't undo the download.
        try {
          shell.showItemInFolder(saveResult.filePath)
        } catch {
          // Ignored — the file is on disk, the user can still find it.
        }
        return { success: true, savedPath: saveResult.filePath }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
    }
  )
}
