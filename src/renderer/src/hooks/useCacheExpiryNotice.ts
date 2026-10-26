import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionTelemetry } from './useSessionTelemetry'
import { useComposerDraftStore, type ComposerDraft } from '../stores/composerDraft.store'
import { useCacheNoticeStore } from '../stores/cacheNotice.store'
import { cacheExpiryNotice, type CacheExpiryNotice } from '../../../shared/sessionTelemetryDerived'

/** Nothing typed or attached, and no send under way. */
function isEmptyDraft(draft: ComposerDraft): boolean {
  return !draft.sending && draft.text.trim() === '' && draft.files.attachments.length === 0 && !draft.files.uploading &&
    draft.notes.length === 0 && draft.pathRefs.length === 0 && draft.pastes.length === 0
}

export interface CacheExpiryNoticeModel {
  notice: CacheExpiryNotice
  /** The reading the notice is about; a dismissal is keyed by it. */
  lastRequestAt: number
  dismiss: () => void
}

/**
 * The prompt-cache notice for an open chat, or null.
 *
 * The clock is a snapshot, never a ticking one: taken when the chat opens
 * (`chatId` changes) and again when the window regains focus, the latter only
 * while the composer is empty (no text, file, note or path reference, no
 * upload) and no turn runs. A cache that expires while the user sits in the
 * chat therefore never inserts a panel above the composer under their cursor
 * (ux_rules rule 1); they see it the next time they come back to it.
 *
 * The same holds for the slot it shares with readiness (`blocked`: a readiness
 * or session notice is showing, and wins). Once that has shown since the last
 * snapshot, the strip stays hidden until the next one, so a readiness strip
 * that clears in place (Check again) never leaves New chat under the pointer
 * where its button was.
 *
 * Hidden while a turn streams (`streaming`), and gone from the moment a send
 * starts on `draftKey` (`beginSend`): that request rebuilds the cache, and its
 * telemetry moves `lastRequestAt` past the snapshot. Dismissed per chat and
 * `lastRequestAt` (`cacheNotice.store`), so it returns only after the chat has
 * been used and gone idle again. One telemetry reading per chat, so a chat with
 * several agents is judged on the session main reports for it.
 */
export function useCacheExpiryNotice(
  chatId: string | null,
  { draftKey, streaming, blocked = false }: { draftKey: string; streaming: boolean; blocked?: boolean }
): CacheExpiryNoticeModel | null {
  const { query } = useSessionTelemetry(chatId)
  const telemetry = query.data ?? null

  // `held`: the slot has been readiness's since this snapshot.
  const [snapshot, setSnapshot] = useState(() => ({ chatId, now: Date.now(), held: blocked }))
  if (snapshot.chatId !== chatId) setSnapshot({ chatId, now: Date.now(), held: blocked })
  else if (blocked && !snapshot.held) setSnapshot({ ...snapshot, held: true })

  // Read by the focus listener at the time of the event.
  const live = useRef({ chatId, draftKey, streaming, blocked })
  live.current = { chatId, draftKey, streaming, blocked }
  useEffect(() => {
    const onFocus = (): void => {
      const { chatId: current, draftKey: key, streaming: busy, blocked: blockedNow } = live.current
      const draft = useComposerDraftStore.getState().drafts[key]
      if (busy || (draft && !isEmptyDraft(draft))) return
      setSnapshot({ chatId: current, now: Date.now(), held: blockedNow })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const lastRequestAt = telemetry?.cache.lastRequestAt
  const readingKey = chatId && lastRequestAt !== undefined ? `${chatId}:${lastRequestAt}` : null
  // A send on this composer settles the notice for the reading it was shown on.
  const sending = useComposerDraftStore((s) => s.drafts[draftKey]?.sending ?? false)
  const [sentOn, setSentOn] = useState<string | null>(null)
  if (sending && readingKey && sentOn !== readingKey) setSentOn(readingKey)

  const dismissedAt = useCacheNoticeStore((s) => (chatId ? s.dismissed[chatId] : undefined))
  const dismissStore = useCacheNoticeStore((s) => s.dismiss)
  const dismiss = useCallback(() => {
    if (chatId && lastRequestAt !== undefined) dismissStore(chatId, lastRequestAt)
  }, [chatId, lastRequestAt, dismissStore])

  if (!chatId || !telemetry || lastRequestAt === undefined || streaming || sending || blocked || snapshot.held) return null
  if (sentOn === readingKey || dismissedAt === lastRequestAt) return null
  const notice = cacheExpiryNotice(telemetry, snapshot.chatId === chatId ? snapshot.now : Date.now())
  return notice ? { notice, lastRequestAt, dismiss } : null
}
