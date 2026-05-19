import { useState, useEffect, useRef, useCallback } from 'react'
import type { MessageAttachment } from '../../../shared/attachments'

export interface ChatAttachmentsAPI {
  attachments: MessageAttachment[]
  isUploading: boolean
  error: string | null
  /** Open the native picker and upload chosen files into the pending list. */
  pick: () => Promise<void>
  /** Remove a pending attachment (soft-deletes on the backend too). */
  remove: (fileId: string) => void
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
 * Pass `null` as `chatId` for the new-chat screen — the same staleness
 * logic still works because picking a file then navigating to a different
 * destination flushes the buffer.
 */
export function useChatAttachments(chatId: string | null): ChatAttachmentsAPI {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
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

  const pick = useCallback(async () => {
    if (isUploading) return
    const gen = ++generationRef.current
    setError(null)
    setIsUploading(true)
    try {
      const result = await window.api.files.pickAndUpload()
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
  }, [isUploading])

  const remove = useCallback((fileId: string) => {
    setAttachments((curr) => curr.filter((a) => a.id !== fileId))
    // Fire-and-forget: if a race makes the file already-attached server-side,
    // the backend rejects the delete and the 24h GC takes over. We don't
    // surface delete errors here because the user already moved on.
    void window.api.files.remove(fileId).catch(() => {})
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
    remove,
    clear,
    setError: setExternalError,
    dismissError
  }
}
