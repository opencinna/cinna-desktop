import { useCallback } from 'react'
import type { ComposerAttachment } from '../../../shared/attachments'
import { EMPTY_COMPOSER_DRAFT, useComposerDraftStore, type ComposerDraft } from '../stores/composerDraft.store'
import { useComposerDraftField, useComposerDraftKey } from './useComposerDraft'

export interface ChatAttachmentsAPI {
  attachments: ComposerAttachment[]
  isUploading: boolean
  error: string | null
  pick: () => Promise<void>
  pickFromPaths: (paths: string[]) => Promise<void>
  remove: (attachment: ComposerAttachment) => void
  /** Clear files and invalidate any upload already in flight for this draft. */
  clear: () => void
  setError: (msg: string | null) => void
  dismissError: () => void
}

let uploadToken = 0

/** Uploads finish into their originating draft, even after navigation/unmount.
 * Clearing the draft invalidates the token so a late result cannot resurrect it.
 * New-chat drafts hold paths until send; existing chats ingest immediately. */
export function useChatAttachments(
  chatId: string | null,
  scope: 'cinna' | 'local' = 'cinna',
  draftKey?: string
): ChatAttachmentsAPI {
  const defaultKey = useComposerDraftKey(chatId)
  const key = draftKey ?? defaultKey
  const [files, setFiles] = useComposerDraftField(key, 'files')
  const update = useCallback((recipe: (files: ComposerDraft['files']) => ComposerDraft['files']) => {
    useComposerDraftStore.getState().update(key, (draft) => ({ files: recipe(draft.files) }))
  }, [key])

  const upload = useCallback(async (paths?: string[]) => {
    const current = useComposerDraftStore.getState().drafts[key]?.files ?? EMPTY_COMPOSER_DRAFT.files
    if (current.uploading || paths?.length === 0) return
    const token = ++uploadToken
    update((state) => ({ ...state, uploading: true, error: null, token }))
    const apply = (recipe: (state: ComposerDraft['files']) => ComposerDraft['files']): void => {
      update((state) => state.token === token ? recipe(state) : state)
    }
    try {
      const result = paths
        ? chatId === null
          ? await window.api.files.resolvePaths({ paths })
          : await window.api.files.ingestPaths({ scope, chatId, paths })
        : chatId === null
          ? await window.api.files.pickPaths()
          : await window.api.files.pickAndUpload({ scope, chatId })
      if (!result.success) {
        apply((state) => ({ ...state, error: result.error }))
      } else if (!('canceled' in result && result.canceled)) {
        apply((state) => ({ ...state, attachments: [...state.attachments, ...result.files] }))
      }
    } catch (err) {
      apply((state) => ({ ...state, error: err instanceof Error ? err.message : String(err) }))
    } finally {
      apply((state) => ({ ...state, uploading: false, token: null }))
    }
  }, [key, chatId, scope, update])

  const pick = useCallback(() => upload(), [upload])
  const pickFromPaths = useCallback((paths: string[]) => upload(paths), [upload])
  const remove = useCallback((attachment: ComposerAttachment) => {
    update((state) => ({ ...state, attachments: state.attachments.filter((a) => a.id !== attachment.id) }))
    if (attachment.source === 'pending') return
    void window.api.files.remove({ id: attachment.id, source: attachment.source ?? 'cinna' }).catch(() => {})
  }, [update])
  const clear = useCallback(() => setFiles(EMPTY_COMPOSER_DRAFT.files), [setFiles])
  const setError = useCallback((error: string | null) => update((state) => ({ ...state, error })), [update])
  const dismissError = useCallback(() => setError(null), [setError])

  return { attachments: files.attachments, isUploading: files.uploading, error: files.error, pick, pickFromPaths, remove, clear, setError, dismissError }
}
