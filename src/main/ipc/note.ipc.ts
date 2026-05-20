import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { notesService } from '../services/notesService'
import { ipcHandle } from './_wrap'
import type {
  NoteCreateInputDto,
  NotePatchDto,
  NoteFolderCreateInputDto,
  NoteFolderPatchDto
} from '../../shared/notes'

export function registerNoteHandlers(): void {
  ipcHandle('note:list', async () => {
    userActivation.requireActivated()
    return notesService.list(getProfileScopeUserId())
  })

  ipcHandle('note:get', async (_event, noteId: string) => {
    userActivation.requireActivated()
    return notesService.getById(getProfileScopeUserId(), noteId)
  })

  ipcHandle('note:create', async (_event, input: NoteCreateInputDto) => {
    userActivation.requireActivated()
    return notesService.create(getProfileScopeUserId(), input ?? {})
  })

  ipcHandle('note:update', async (_event, noteId: string, patch: NotePatchDto) => {
    userActivation.requireActivated()
    return notesService.update(getProfileScopeUserId(), noteId, patch)
  })

  ipcHandle('note:delete', async (_event, noteId: string) => {
    userActivation.requireActivated()
    notesService.softDelete(getProfileScopeUserId(), noteId)
    return { success: true }
  })

  ipcHandle('note:trash-list', async () => {
    userActivation.requireActivated()
    return notesService.listTrash(getProfileScopeUserId())
  })

  ipcHandle('note:restore', async (_event, noteId: string) => {
    userActivation.requireActivated()
    notesService.restore(getProfileScopeUserId(), noteId)
    return { success: true }
  })

  ipcHandle('note:permanent-delete', async (_event, noteId: string) => {
    userActivation.requireActivated()
    notesService.permanentDelete(getProfileScopeUserId(), noteId)
    return { success: true }
  })

  ipcHandle('note:empty-trash', async () => {
    userActivation.requireActivated()
    notesService.emptyTrash(getProfileScopeUserId())
    return { success: true }
  })

  // ---- Folders -----------------------------------------------------------

  ipcHandle('noteFolder:list', async () => {
    userActivation.requireActivated()
    return notesService.listFolders(getProfileScopeUserId())
  })

  ipcHandle('noteFolder:create', async (_event, input: NoteFolderCreateInputDto) => {
    userActivation.requireActivated()
    return notesService.createFolder(getProfileScopeUserId(), input)
  })

  ipcHandle(
    'noteFolder:update',
    async (_event, folderId: string, patch: NoteFolderPatchDto) => {
      userActivation.requireActivated()
      return notesService.updateFolder(getProfileScopeUserId(), folderId, patch)
    }
  )

  ipcHandle('noteFolder:delete', async (_event, folderId: string) => {
    userActivation.requireActivated()
    notesService.deleteFolder(getProfileScopeUserId(), folderId)
    return { success: true }
  })

  ipcHandle('noteFolder:reorder', async (_event, orderedIds: string[]) => {
    userActivation.requireActivated()
    notesService.reorderFolders(getProfileScopeUserId(), orderedIds)
    return { success: true }
  })

  ipcHandle(
    'note:reorder',
    async (_event, targetFolderId: string | null, orderedNoteIds: string[]) => {
      userActivation.requireActivated()
      notesService.reorderNotes(getProfileScopeUserId(), targetFolderId, orderedNoteIds)
      return { success: true }
    }
  )
}
