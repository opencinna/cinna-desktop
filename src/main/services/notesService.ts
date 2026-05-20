import {
  notesRepo,
  noteFoldersRepo,
  type NoteRow,
  type NoteFolderRow,
  type NoteCreateInput,
  type NotePatch,
  type NoteFolderCreateInput,
  type NoteFolderPatch
} from '../db/notes'
import { NoteError } from '../errors'
import { createLogger } from '../logger/logger'
import { fileService, type FileScope } from './fileService'
import type { MessageAttachment } from '../../shared/attachments'

const logger = createLogger('note')

function requireNote(userId: string, noteId: string): NoteRow {
  const note = notesRepo.getById(userId, noteId)
  if (!note || note.deletedAt) throw new NoteError('not_found', 'Note not found')
  return note
}

/**
 * Strip filesystem-hostile characters from a note title so it survives a
 * `basename` round-trip when the synthetic .md file lands in the local
 * store or the Cinna backend. Anything outside a small allowlist becomes
 * `_`; the suffix is fixed to `.md`.
 */
function safeNoteFilename(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[^a-zA-Z0-9 \-_.]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim()
  return `${cleaned || 'note'}.md`
}

export const notesService = {
  list(userId: string): NoteRow[] {
    return notesRepo.list(userId)
  },

  getById(userId: string, noteId: string): NoteRow {
    return requireNote(userId, noteId)
  },

  create(userId: string, input: NoteCreateInput): NoteRow {
    const note = notesRepo.create(userId, input)
    logger.info('note created', { noteId: note.id })
    return note
  },

  update(userId: string, noteId: string, patch: NotePatch): NoteRow {
    requireNote(userId, noteId)
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new NoteError('invalid_input', 'Title is required')
    }
    const ok = notesRepo.update(userId, noteId, patch)
    if (!ok) throw new NoteError('not_found', 'Note not found')
    const updated = notesRepo.getById(userId, noteId)
    if (!updated) throw new NoteError('not_found', 'Note not found after update')
    return updated
  },

  softDelete(userId: string, noteId: string): void {
    const ok = notesRepo.softDelete(userId, noteId)
    if (!ok) throw new NoteError('not_found', 'Note not found')
    logger.info('note moved to trash', { noteId })
  },

  listTrash(userId: string): NoteRow[] {
    return notesRepo.listTrash(userId)
  },

  restore(userId: string, noteId: string): void {
    const ok = notesRepo.restore(userId, noteId)
    if (!ok) throw new NoteError('not_found', 'Note not found')
    logger.info('note restored', { noteId })
  },

  permanentDelete(userId: string, noteId: string): void {
    const ok = notesRepo.permanentDelete(userId, noteId)
    if (!ok) throw new NoteError('not_found', 'Note not found')
    logger.info('note permanently deleted', { noteId })
  },

  emptyTrash(userId: string): void {
    const removed = notesRepo.emptyTrash(userId)
    logger.info('notes trash emptied', { removed })
  },

  // ---- Folders ------------------------------------------------------------

  listFolders(userId: string): NoteFolderRow[] {
    return noteFoldersRepo.list(userId)
  },

  createFolder(userId: string, input: NoteFolderCreateInput): NoteFolderRow {
    const name = input.name?.trim()
    if (!name) throw new NoteError('invalid_input', 'Folder name is required')
    const folder = noteFoldersRepo.create(userId, { name })
    logger.info('note folder created', { folderId: folder.id })
    return folder
  },

  updateFolder(
    userId: string,
    folderId: string,
    patch: NoteFolderPatch
  ): NoteFolderRow {
    const existing = noteFoldersRepo.getById(userId, folderId)
    if (!existing) throw new NoteError('not_found', 'Folder not found')
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new NoteError('invalid_input', 'Folder name is required')
    }
    const normalized: NoteFolderPatch = {}
    if (patch.name !== undefined) normalized.name = patch.name.trim()
    if (patch.collapsed !== undefined) normalized.collapsed = patch.collapsed
    if (Object.keys(normalized).length === 0) return existing
    const ok = noteFoldersRepo.update(userId, folderId, normalized)
    if (!ok) throw new NoteError('not_found', 'Folder not found')
    const updated = noteFoldersRepo.getById(userId, folderId)
    if (!updated) throw new NoteError('not_found', 'Folder not found after update')
    return updated
  },

  deleteFolder(userId: string, folderId: string): void {
    const existing = noteFoldersRepo.getById(userId, folderId)
    if (!existing) throw new NoteError('not_found', 'Folder not found')
    noteFoldersRepo.delete(userId, folderId)
    logger.info('note folder deleted', { folderId })
  },

  reorderFolders(userId: string, orderedIds: string[]): void {
    if (orderedIds.length > 0) {
      const matched = noteFoldersRepo.countOwned(userId, orderedIds)
      if (matched !== orderedIds.length) {
        throw new NoteError('not_found', 'One or more folders not found')
      }
    }
    noteFoldersRepo.reorder(userId, orderedIds)
    logger.info('note folders reordered', { count: orderedIds.length })
  },

  /**
   * Convert a list of profile-owned notes into real attachments by routing
   * each note's body through `fileService.ingestSyntheticContent` as a
   * `<safeTitle>.md` file. Ownership is enforced per-note via `requireNote`
   * before any file is materialized — a single missing/foreign id aborts
   * the whole call before the temp dir is even created.
   */
  async materializeAsAttachments(
    userId: string,
    input: { chatId: string | null; scope: FileScope; noteIds: string[] }
  ): Promise<MessageAttachment[]> {
    if (input.noteIds.length === 0) return []
    const items = input.noteIds.map((noteId) => {
      const note = requireNote(userId, noteId)
      return {
        filename: safeNoteFilename(note.title),
        content: note.body ?? ''
      }
    })
    logger.info('materializing notes as attachments', {
      scope: input.scope,
      chatId: input.chatId,
      count: items.length
    })
    return fileService.ingestSyntheticContent({
      userId,
      scope: input.scope,
      chatId: input.chatId,
      items
    })
  },

  reorderNotes(
    userId: string,
    targetFolderId: string | null,
    orderedNoteIds: string[]
  ): void {
    if (targetFolderId !== null) {
      const folder = noteFoldersRepo.getById(userId, targetFolderId)
      if (!folder) throw new NoteError('not_found', 'Folder not found')
    }
    // Single COUNT instead of N+1 reads — SQLite is single-writer so the
    // window between this check and `reorderInGroup`'s transaction is too
    // small to race in practice, and any mismatch (stale renderer view,
    // cross-profile id) is rejected before any write happens.
    if (orderedNoteIds.length > 0) {
      const matched = notesRepo.countOwned(userId, orderedNoteIds)
      if (matched !== orderedNoteIds.length) {
        throw new NoteError('not_found', 'One or more notes not found')
      }
    }
    notesRepo.reorderInGroup(userId, targetFolderId, orderedNoteIds)
    logger.info('notes reordered', {
      targetFolderId,
      count: orderedNoteIds.length
    })
  }
}
