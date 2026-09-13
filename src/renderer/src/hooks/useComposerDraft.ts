import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useAuthStore } from '../stores/auth.store'
import { composerDraftKey, EMPTY_COMPOSER_DRAFT, useComposerDraftStore, type ComposerDraft } from '../stores/composerDraft.store'

export function useComposerDraftKey(chatId: string | null, agentId?: string): string {
  const profileId = useAuthStore((s) => s.currentUser?.id)
  return composerDraftKey(profileId, chatId ? `chat:${chatId}` : agentId ? `agent:${agentId}` : 'dashboard')
}

export function useComposerDraftField<K extends keyof ComposerDraft>(
  key: string,
  field: K
): [ComposerDraft[K], Dispatch<SetStateAction<ComposerDraft[K]>>] {
  const value = useComposerDraftStore((s) => (s.drafts[key] ?? EMPTY_COMPOSER_DRAFT)[field])
  const setValue = useCallback((next: SetStateAction<ComposerDraft[K]>) => {
    useComposerDraftStore.getState().update(key, (draft) => ({
      [field]: typeof next === 'function' ? (next as (value: ComposerDraft[K]) => ComposerDraft[K])(draft[field]) : next
    }))
  }, [key, field])
  return [value, setValue]
}
