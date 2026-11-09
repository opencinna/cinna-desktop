import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { useChatSearchStore, type ChatSearchScope } from '../../../stores/chatSearch.store'

interface ChatSearchBarProps {
  scope: ChatSearchScope
  /** A chat's transcript is on screen: the scope button can switch to it. */
  chatAvailable: boolean
  /** The count, or nothing; its slot keeps its width either way. */
  count: string
  /** The slot's width in px, fixed per scope so nothing beside it moves. */
  countWidth: number
  /** The listbox the arrows move through, and its active option. */
  listId: string
  activeId: string | undefined
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
}

/**
 * The search field, one pill: icon, query, count, the scope it searches
 * (a button that switches, keeping the query) and close. Focused and selected
 * on every open, so ⌘F over an open search selects the query.
 */
export function ChatSearchBar({ scope, chatAvailable, count, countWidth, listId, activeId, onKeyDown }: ChatSearchBarProps): React.JSX.Element {
  const query = useChatSearchStore((s) => s.query)
  const setQuery = useChatSearchStore((s) => s.setQuery)
  const open = useChatSearchStore((s) => s.open)
  const close = useChatSearchStore((s) => s.close)
  const focusNonce = useChatSearchStore((s) => s.focusNonce)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce, scope])
  const label = scope === 'chat' ? 'Search this chat' : 'Search all chats'
  const other = scope === 'chat' ? 'all' : 'chat'
  // Named for what it does, not the scope it shows: it is a switch.
  const switchLabel = `Search ${other === 'all' ? 'all chats' : 'this chat'} instead`
  return (
    <div role="search" className="chat-search-bar chat-search-glass">
      <Search size={15} className="chat-search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        data-chat-search-input
        className="chat-search-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        role="combobox"
        aria-expanded={!!activeId}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
      />
      <span className="chat-search-count" style={{ width: countWidth }} aria-live="polite">{count}</span>
      <span className="chat-search-sep" aria-hidden="true" />
      <button
        type="button"
        className="chat-search-scope"
        disabled={!chatAvailable}
        aria-label={switchLabel}
        title={chatAvailable ? switchLabel : 'No chat open'}
        onClick={() => open(other)}
      >
        {scope === 'chat' ? 'This chat' : 'All chats'}
      </button>
      <button type="button" className="chat-search-btn" title="Close (Esc)" aria-label="Close search" onClick={close}>
        <X size={14} />
      </button>
    </div>
  )
}
