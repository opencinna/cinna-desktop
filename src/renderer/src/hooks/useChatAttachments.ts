import { useState, useEffect, useRef, useCallback } from 'react'
import type { ComposerAttachment } from '../../../shared/attachments'

export interface ChatAttachmentsAPI {
  attachments: ComposerAttachment[]
  isUploading: boolean
  error: string | null
  /** Open the native picker and upload chosen files into the pending list. */
  pick: () => Promise<void>
  /**
   * Skip the picker — ingest the given OS paths straight through. Used by
   * the drag-drop flow; renderer resolves paths via
   * `window.api.files.getPathForFile(file)`.
   */
  pickFromPaths: (paths: string[]) => Promise<void>
  /** Remove a pending attachment (soft-deletes on the backend too). */
  remove: (attachment: ComposerAttachment) => void
  /** Drop all pending attachments. Bumps the staleness generation so any
   *  upload still in flight from before the clear is silently discarded. */
  clear: () => void
  /** Surface a composer-level validation error in the same slot used for
   *  upload errors (e.g. "pick a Cinna agent to send these"). Pass null to
   *  clear. The label below the textarea reflects whichever error is set. */
  setError: (msg: string | null) => void
  dismissError: () => void
}

/**
 * Composer-local buffer of pending file attachments, scoped to a single
 * chat. Encapsulates:
 *
 *  - The `window.api.files.pickAndUpload` / `remove` IPC calls
 *  - The `isUploading` / `error` UI state
 *  - A staleness generation that ignores upload resolutions from a prior
 *    chat (or from before a manual `clear()`) — without this, switching
 *    chats mid-upload would cause files picked on chat A to land in chat
 *    B's composer when the upload eventually resolves.
 *
 * The hook itself doesn't know the difference between Cinna and local
 * scopes — the caller decides via `scope`. Routing the decision in the
 * caller keeps the hook a clean composer-local buffer regardless of how
 * many storage backends grow over time.
 *
 * Pass `null` as `chatId` for the new-chat screen — local-scope picks are
 * blocked there (the local store needs an existing chat row to attach to),
 * but Cinna-scope picks still work because the Cinna backend is global.
 */
export function useChatAttachments(
  chatId: string | null,
  scope: 'cinna' | 'local' = 'cinna'
): ChatAttachmentsAPI {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bumped on every chatId change AND on every manual clear. An async pick()
  // captures the generation at start and no-ops if it's been bumped by the
  // time the upload resolves.
  const generationRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    setAttachments([])
    setError(null)
    setIsUploading(false)
  }, [chatId])

  // New-chat composer holds paths only; ingest happens at send time once
  // the destination (and thus the scope) is known. Active chats keep the
  // eager-upload behavior so badges show up the instant they're picked.
  const deferred = chatId === null

  const pick = useCallback(async () => {
    if (isUploading) return
    const gen = ++generationRef.current
    setError(null)
    setIsUploading(true)
    try {
      const result = deferred
        ? await window.api.files.pickPaths()
        : await window.api.files.pickAndUpload({ scope, chatId })
      if (gen !== generationRef.current) return
      if (!result.success) {
        setError(result.error)
        return
      }
      if (result.canceled) return
      setAttachments((curr) => [...curr, ...result.files])
    } catch (err) {
      if (gen !== generationRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (gen === generationRef.current) setIsUploading(false)
    }
  }, [isUploading, scope, chatId, deferred])

  // Drag-drop path. Shares the same generation-counter staleness as the
  // picker so a drop that resolves after a chat-switch is silently
  // dropped instead of landing in the wrong composer. Routes through the
  // deferred resolver for new-chat, the immediate ingest otherwise.
  const pickFromPaths = useCallback(
    async (paths: string[]) => {
      if (isUploading || paths.length === 0) return
      const gen = ++generationRef.current
      setError(null)
      setIsUploading(true)
      try {
        const result = deferred
          ? await window.api.files.resolvePaths({ paths })
          : await window.api.files.ingestPaths({ scope, chatId, paths })
        if (gen !== generationRef.current) return
        if (!result.success) {
          setError(result.error)
          return
        }
        setAttachments((curr) => [...curr, ...result.files])
      } catch (err) {
        if (gen !== generationRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (gen === generationRef.current) setIsUploading(false)
      }
    },
    [isUploading, scope, chatId, deferred]
  )

  const remove = useCallback((attachment: ComposerAttachment) => {
    setAttachments((curr) => curr.filter((a) => a.id !== attachment.id))
    // Pending attachments never reached a backend, so there's nothing to
    // delete — dropping them from the local list is the full cleanup.
    if (attachment.source === 'pending') return
    // Fire-and-forget: if a race makes the file already-attached server-side,
    // the backend rejects the delete and the 24h GC takes over. We don't
    // surface delete errors here because the user already moved on.
    void window.api.files
      .remove({ id: attachment.id, source: attachment.source ?? 'cinna' })
      .catch(() => {})
  }, [])

  const clear = useCallback(() => {
    generationRef.current += 1
    setAttachments([])
    setError(null)
    setIsUploading(false)
  }, [])

  const setExternalError = useCallback((msg: string | null) => setError(msg), [])
  const dismissError = useCallback(() => setError(null), [])

  return {
    attachments,
    isUploading,
    error,
    pick,
    pickFromPaths,
    remove,
    clear,
    setError: setExternalError,
    dismissError
  }
}
