import { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chat.store'

/**
 * Warnings already read out, by chat, turn and text. Module-level so that a
 * remount of the transcript (a chat switch and back, a live run replayed into
 * the store) never reads the same warning out again.
 */
const announced = new Set<string>()
const ANNOUNCED_KEPT = 200

/** The text of the last live warning notice block, or null. */
function lastLiveWarning(blocks: ReturnType<typeof useChatStore.getState>['streamingBlocks']): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'text' && block.kind === 'notice' && block.tone === 'warning' && block.content) return block.content
  }
  return null
}

/**
 * The transcript's one polite live region for warning notices (a provider
 * error, a turn gone silent). It is in the DOM from the start and empty, so
 * screen readers are already watching it when the first warning lands; each
 * distinct warning of a turn is put in it once. The warning rows themselves
 * carry no role: a saved one is history, not news.
 */
export function NoticeWarningAnnouncer({ chatId }: { chatId: string }): React.JSX.Element {
  const warning = useChatStore((state) => lastLiveWarning(state.streamingBlocks))
  const requestId = useChatStore((state) => state.activeRequestId)
  // Keyed by what was announced: the same words in a later turn are a new
  // node, so the region changes and is read again (an equal string alone would
  // leave the DOM as it was, and say nothing).
  const [said, setSaid] = useState<{ key: string; text: string } | null>(null)
  // Another chat's warning is not left in the region for a virtual cursor.
  useEffect(() => { setSaid(null) }, [chatId])
  useEffect(() => {
    if (!warning) return
    const key = `${chatId}\u0000${requestId ?? ''}\u0000${warning}`
    if (announced.has(key)) return
    announced.add(key)
    if (announced.size > ANNOUNCED_KEPT) announced.delete(announced.values().next().value!)
    setSaid({ key, text: warning })
  }, [chatId, requestId, warning])
  return (
    <div role="status" aria-live="polite" data-testid="notice-warning-announcer" className="sr-only">
      {said && <span key={said.key}>{said.text}</span>}
    </div>
  )
}

/** Test seam: forget what was announced. */
export function resetNoticeWarningAnnouncerForTest(): void {
  announced.clear()
}
