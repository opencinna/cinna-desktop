import { useEffect, useId, useMemo, useState } from 'react'
import { useChatSearchStore } from '../../../stores/chatSearch.store'
import { ChatSearchBar } from './ChatSearchBar'
import { SearchHitCard } from './SearchHitCard'
import { SearchResultList } from './SearchResultList'
import { useSearchPause } from './useSearchPause'
import { clearHighlight, HIGHLIGHT, paintHighlight, searchChatMessages, searchTimeLabel, textRanges } from './chatSearchText'
import { jumpToMessage, messageNodeMap } from './jumpToMessage'

interface SearchableMessage {
  id: string
  role: string
  content: string
  createdAt: Date | string | number
}

interface ChatSearchInChatProps<M extends SearchableMessage> {
  /** The chat's persisted messages, as loaded for the transcript. */
  messages: readonly M[]
  containerRef: React.RefObject<HTMLElement | null>
  contentRef: React.RefObject<HTMLElement | null>
  /** Where "Jump to latest" sits, in px from the bottom: the bar takes its place. */
  bottom: number
  /** Who wrote an assistant message, by name. */
  authorOf: (message: M) => string
}

/** The bar's count slot, wide enough for "999 matches". */
const COUNT_WIDTH = 72

/** Cards shown at most, the newest; the transcript still highlights every match. */
export const CHAT_SEARCH_CARD_LIMIT = 30

/**
 * Search in the chat on screen (⌘F). The bar sits where "Jump to latest" does;
 * after a pause in typing the matching user and assistant messages show above
 * it as cards, newest nearest the bar, and every match is highlighted in the
 * transcript itself. Picking a card scrolls the transcript to it and closes.
 */
export function ChatSearchInChat<M extends SearchableMessage>({ messages, containerRef, contentRef, bottom, authorOf }: ChatSearchInChatProps<M>): React.JSX.Element {
  const query = useChatSearchStore((s) => s.query)
  const close = useChatSearchStore((s) => s.close)
  const { applied, pending, flush } = useSearchPause(query)
  const q = applied.trim()
  const allHits = useMemo(() => searchChatMessages(messages, q), [messages, q])
  const total = allHits.reduce((n, hit) => n + hit.count, 0)
  // The newest cards only: each is a rendered markdown snippet.
  const hits = useMemo(() => allHits.slice(-CHAT_SEARCH_CARD_LIMIT), [allHits])
  const older = allHits.length - hits.length
  const olderMatches = allHits.slice(0, older).reduce((n, hit) => n + hit.count, 0)
  const listId = useId()
  const optionId = (messageId: string): string => `${listId}-${messageId}`
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const resultsKey = `${q}|${hits.map((hit) => hit.message.id).join(',')}`
  // New results: the newest, nearest the bar, is the active one.
  useEffect(() => {
    const last = hits[hits.length - 1]
    setActiveId(last ? optionId(last.message.id) : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsKey])

  // Every match in the live transcript, painted over React's DOM without touching it.
  useEffect(() => {
    const content = contentRef.current
    if (!content || !q) {
      clearHighlight(HIGHLIGHT.all)
      return
    }
    const nodes = messageNodeMap(content)
    const ranges = allHits.flatMap((hit) => (nodes.get(hit.message.id) ?? []).flatMap((node) => textRanges(node, q)))
    paintHighlight(HIGHLIGHT.all, ranges)
  }, [allHits, q, contentRef])
  useEffect(() => () => clearHighlight(HIGHLIGHT.all), [])

  const pick = (messageId: string): void => {
    const container = containerRef.current
    const content = contentRef.current
    if (container && content) jumpToMessage(container, content, messageId, q)
    close()
  }

  const ids = hits.map((hit) => optionId(hit.message.id))
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (pending) {
        flush()
        return
      }
      const hit = hits.find((h) => optionId(h.message.id) === activeId)
      if (hit) pick(hit.message.id)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (ids.length === 0) return
      event.preventDefault()
      const at = activeId ? ids.indexOf(activeId) : ids.length
      const next = Math.max(0, Math.min(ids.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))
      setActiveId(ids[next])
    }
  }

  const now = new Date()
  const showList = q.length > 0
  const count = !q ? '' : total === 0 ? 'No matches' : `${total} match${total === 1 ? '' : 'es'}`
  return (
    <div className="chat-search-root" data-chat-search="chat" data-pending={pending || undefined}>
      {showList && <div className="chat-search-scrim" onMouseDown={close} />}
      <div className="chat-search-column" style={{ bottom, top: 'calc(var(--topbar-h) + 12px)' }}>
        {showList && (
          hits.length === 0 ? (
            <div className="chat-search-empty chat-search-glass">No matches for “{q}”</div>
          ) : (
            <SearchResultList
              id={listId}
              label="Search results"
              entries={ids.map((id) => ({ id, group: 'chat' }))}
              resultsKey={resultsKey}
              activeId={activeId}
              onActivate={setActiveId}
            >
              {older > 0 && (
                <div className="chat-search-empty chat-search-glass" data-chat-search-older>
                  {olderMatches} older match{olderMatches === 1 ? '' : 'es'}. Refine the search to see them.
                </div>
              )}
              {hits.map((hit) => {
                const role = hit.message.role === 'user' ? 'user' : 'assistant'
                return (
                  <SearchHitCard
                    key={hit.message.id}
                    id={optionId(hit.message.id)}
                    role={role}
                    who={role === 'user' ? 'You' : authorOf(hit.message)}
                    when={searchTimeLabel(new Date(hit.message.createdAt), now)}
                    count={hit.count}
                    content={hit.message.content}
                    query={q}
                    active={activeId === optionId(hit.message.id)}
                    onPick={() => pick(hit.message.id)}
                  />
                )
              })}
            </SearchResultList>
          )
        )}
        <ChatSearchBar
          scope="chat"
          chatAvailable
          count={count}
          countWidth={COUNT_WIDTH}
          listId={listId}
          activeId={showList ? activeId : undefined}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
