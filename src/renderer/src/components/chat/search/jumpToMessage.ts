import { leaveBottom } from '../../../hooks/useStickToBottom'
import { clearHighlight, HIGHLIGHT, paintHighlight, textRanges } from './chatSearchText'

/** How long the jumped-to match stays marked: the flash, and a little after. */
const CURRENT_MS = 1_800

let currentTimer: ReturnType<typeof setTimeout> | null = null

/** The rendered bodies of one persisted message (a reply with parts renders several). */
export function messageNodes(content: ParentNode, messageId: string): HTMLElement[] {
  return messageNodeMap(content).get(messageId) ?? []
}

/** Every message's rendered bodies, by message id, in one pass over the transcript. */
export function messageNodeMap(content: ParentNode): Map<string, HTMLElement[]> {
  const map = new Map<string, HTMLElement[]>()
  for (const node of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = node.getAttribute('data-message-id')
    if (!id) continue
    const nodes = map.get(id)
    if (nodes) nodes.push(node)
    else map.set(id, [node])
  }
  return map
}

/**
 * Scroll the transcript so the message's first match (or the message, when
 * the match is not in its rendered text) sits at ~40 % of the viewport, mark
 * that match and flash the block it is in. The view stops following the
 * bottom first, or the next chunk would pull it back down. False when the
 * message is not on screen.
 */
export function jumpToMessage(container: HTMLElement, content: ParentNode, messageId: string, query: string): boolean {
  const nodes = messageNodes(content, messageId)
  if (nodes.length === 0) return false
  let range: Range | undefined
  for (const node of nodes) {
    range = textRanges(node, query)[0]
    if (range) break
  }
  const target = range ?? nodes[0]
  leaveBottom(container)
  if (typeof target.getBoundingClientRect === 'function' && typeof container.scrollTo === 'function') {
    const at = target.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    container.scrollTo({ top: container.scrollTop + (at.top - box.top) - box.height * 0.4, behavior: 'smooth' })
  }
  if (currentTimer) clearTimeout(currentTimer)
  if (range) {
    paintHighlight(HIGHLIGHT.current, [range])
    currentTimer = setTimeout(() => {
      currentTimer = null
      clearHighlight(HIGHLIGHT.current)
    }, CURRENT_MS)
  }
  const block =
    (range?.startContainer.parentElement?.closest('p, li, pre, td, th, h1, h2, h3, h4, h5, h6, blockquote') as HTMLElement | null) ??
    nodes[0]
  block.classList.remove('chat-search-flash')
  void block.offsetWidth
  block.classList.add('chat-search-flash')
  block.addEventListener('animationend', () => block.classList.remove('chat-search-flash'), { once: true })
  return true
}
