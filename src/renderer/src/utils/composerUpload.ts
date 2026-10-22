import { EMPTY_COMPOSER_DRAFT, useComposerDraftStore, type ComposerDraft } from '../stores/composerDraft.store'

/**
 * How files reach a composer draft: a pick, a drop, a paste — and anything
 * else that hands the draft a file, such as a command's output. A plain
 * function rather than the hook's, so a surface that is not the composer
 * (the Commands badge, the output panel) adds a file exactly as a drop does.
 *
 * Uploads finish into their originating draft, even after navigation or
 * unmount. Clearing the draft invalidates the token, so a late result cannot
 * resurrect it. A new-chat draft (`chatId: null`) holds paths until send; an
 * existing chat ingests at once.
 */

let uploadToken = 0

/**
 * Paths dropped or pasted while the draft was already uploading, per draft:
 * they go up as soon as the current upload ends, into the same draft. Clearing
 * the draft drops them.
 */
const queuedPaths = new Map<string, string[]>()

export interface ComposerUploadTarget {
  /** The draft's key (`useComposerDraftKey`). */
  key: string
  chatId: string | null
  /** Where the bytes go: the Cinna backend or the local store (`ChatInput`'s rule). */
  scope: 'cinna' | 'local'
  /** The files to add; none opens the picker. */
  paths?: string[]
}

/** Forget what was queued for a draft (it was cleared). */
export function dropQueuedComposerFiles(key: string): void {
  queuedPaths.delete(key)
}

export async function uploadComposerFiles({ key, chatId, scope, paths: first }: ComposerUploadTarget): Promise<void> {
  const update = (recipe: (files: ComposerDraft['files']) => ComposerDraft['files']): void => {
    useComposerDraftStore.getState().update(key, (draft) => ({ files: recipe(draft.files) }))
  }

  const uploadOnce = async (paths?: string[]): Promise<void> => {
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
  }

  let paths = first
  for (;;) {
    const current = useComposerDraftStore.getState().drafts[key]?.files ?? EMPTY_COMPOSER_DRAFT.files
    if (paths?.length === 0) return
    if (current.uploading) {
      // A second drop or paste waits its turn; a second picker open is ignored (the menu shows the upload).
      if (paths) queuedPaths.set(key, [...(queuedPaths.get(key) ?? []), ...paths])
      return
    }
    await uploadOnce(paths)
    const next = queuedPaths.get(key)
    queuedPaths.delete(key)
    if (!next?.length) return
    paths = next
  }
}
