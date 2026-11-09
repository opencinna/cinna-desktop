import { useEffect } from 'react'
import { useChatSearchStore } from '../../../stores/chatSearch.store'

/**
 * ⌘F / Ctrl+F: search the chat on screen, or all chats when none is. Pressed
 * in an open search's field, it selects the query instead. Escape outside the
 * field (after a click on a result's chrome, say) closes an open search.
 * Nothing under an open modal: the search would open behind it.
 *
 * In the renderer, not the application menu: the app has no Find item, and
 * whether a chat is on screen is the renderer's to know. Mount once.
 */
export function useChatSearchShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const search = useChatSearchStore.getState()
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        if (document.querySelector('[aria-modal="true"]')) return
        event.preventDefault()
        event.stopPropagation()
        const field = document.activeElement
        if (search.scope && field instanceof HTMLInputElement && field.hasAttribute('data-chat-search-input')) {
          field.select()
          return
        }
        search.open(search.searchableChatId ? 'chat' : 'all')
        return
      }
      if (event.key === 'Escape' && search.scope && !event.defaultPrevented) {
        const active = document.activeElement
        const outside = !active || active === document.body || !!active.closest('[data-chat-search]')
        if (outside && !(active instanceof HTMLInputElement && active.hasAttribute('data-chat-search-input'))) search.close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
