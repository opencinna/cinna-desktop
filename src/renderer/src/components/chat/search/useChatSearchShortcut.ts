import { useEffect } from 'react'
import { useChatSearchStore } from '../../../stores/chatSearch.store'

/**
 * ⌘F / Ctrl+F: search the chat on screen, or all chats when none is. Pressed
 * in an open search's field, it selects the query instead. Escape outside the
 * field (after a click on a result's chrome, say) closes an open search.
 * Nothing while a modal dialog is open: the search would open behind it and
 * take its focus.
 *
 * In the renderer, not the application menu: the app has no Find item, and
 * whether a chat is on screen is the renderer's to know. Mount once.
 */
export function useChatSearchShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const search = useChatSearchStore.getState()
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        if (modalOpen()) return
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

/** What marks an open modal: not every dialog sets `aria-modal`, and some are only a scrim. */
const MODAL_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], .app-modal-scrim'

/** A modal dialog is open, other than the search's own elements. */
export function modalOpen(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll<HTMLElement>(MODAL_SELECTOR)) {
    if (el.closest('[data-chat-search]')) continue
    if (shown(el)) return true
  }
  return false
}

/** Drawn: not hidden, nor under a hidden ancestor where the engine can tell. */
function shown(el: HTMLElement): boolean {
  if (el.hidden || el.closest('[hidden]')) return false
  if (typeof el.checkVisibility === 'function') return el.checkVisibility()
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return !style || (style.display !== 'none' && style.visibility !== 'hidden')
}
