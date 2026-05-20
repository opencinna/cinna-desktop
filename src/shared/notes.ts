/**
 * Shared DTOs for the Notes feature. Notes are profile-scoped markdown
 * documents. The renderer edits raw markdown text inline; the rendered view
 * uses the same react-markdown stack as chat bubbles.
 */

import type { MessageAttachment } from './attachments'

export interface NoteData {
  id: string
  userId: string
  title: string
  body: string
  /** Sidebar folder this note belongs to; null = root. */
  folderId: string | null
  /** Sort key within its folder (or root). Lower = top. */
  position: number
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface NoteCreateInputDto {
  title?: string
  body?: string
}

export interface NotePatchDto {
  title?: string
  body?: string
}

/**
 * Sidebar folder grouping for notes. Mirrors `JobFolderData`. Profile-scoped.
 */
export interface NoteFolderData {
  id: string
  userId: string
  name: string
  position: number
  collapsed: boolean
  createdAt: Date
  updatedAt: Date
}

export interface NoteFolderCreateInputDto {
  name: string
}

export interface NoteFolderPatchDto {
  name?: string
  collapsed?: boolean
}

/**
 * Input for materializing a set of notes as real file attachments on a
 * pending message. The chat row must already exist for `local` scope (the
 * file ingest pipeline needs a chat to attach to); Cinna scope can target
 * a pre-creation buffer but the renderer always passes a non-null chatId
 * once the row is ready.
 */
export interface NoteAttachAsFilesInputDto {
  chatId: string | null
  scope: 'cinna' | 'local'
  noteIds: string[]
}

export type NoteAttachAsFilesResultDto =
  | { success: true; files: MessageAttachment[] }
  | { success: false; error: string; code?: string }
