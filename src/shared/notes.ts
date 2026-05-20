/**
 * Shared DTOs for the Notes feature. Notes are profile-scoped markdown
 * documents. The renderer edits raw markdown text inline; the rendered view
 * uses the same react-markdown stack as chat bubbles.
 */

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
