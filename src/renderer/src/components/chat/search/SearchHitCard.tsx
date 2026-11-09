import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { MarkdownContent } from '../MessageBubble'
import { repairNestedFences } from '../../../utils/nestedFences'
import { setSnippetRanges, snippetMarkdown, textRanges } from './chatSearchText'

export interface SearchHitCardProps {
  /** The option's DOM id, for the input's `aria-activedescendant`. */
  id: string
  role: 'user' | 'assistant'
  /** "You", or who answered. */
  who: string
  /** When the message was sent ("Today 09:26"). */
  when: string
  /** Matches in the message. */
  count: number
  content: string
  query: string
  active: boolean
  onPick: () => void
  onHover?: () => void
}

/**
 * One result: a frosted window onto the rendered message, five lines of it,
 * scrolled so the first match sits on the middle line. An option of the
 * results listbox, picked by a click or by Enter in the search field.
 */
export function SearchHitCard({ id, role, who, when, count, content, query, active, onPick, onHover }: SearchHitCardProps): React.JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-search-hit
      data-active={active || undefined}
      data-role={role}
      className="chat-search-hit chat-search-glass"
      onClick={onPick}
      onMouseEnter={onHover}
    >
      <div className="chat-search-hit-meta">
        <span className="chat-search-role-dot" aria-hidden="true" />
        <span className="chat-search-hit-who">{who}</span>
        <span>· {when}</span>
        {count > 1 && <span>· {count} matches</span>}
        <span className="chat-search-hit-go" aria-hidden="true">
          <CornerDownLeft size={12} />
          Go to
        </span>
      </div>
      <SearchSnippet role={role} content={content} query={query} />
    </div>
  )
}

function SearchSnippet({ role, content, query }: { role: 'user' | 'assistant'; content: string; query: string }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [cut, setCut] = useState<string | undefined>(undefined)
  const markdown = useMemo(() => repairNestedFences(snippetMarkdown(role, content)), [role, content])
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const owner = {}
    const ranges = textRanges(box, query)
    setSnippetRanges(owner, ranges)
    const first = ranges[0]
    // jsdom has no layout: nothing to centre on there.
    if (first && typeof first.getBoundingClientRect === 'function') {
      const outer = box.getBoundingClientRect()
      const mark = first.getBoundingClientRect()
      box.scrollTop = Math.max(0, mark.top - outer.top + box.scrollTop - (box.clientHeight - mark.height) / 2)
    }
    const edges: string[] = []
    if (box.scrollTop > 1) edges.push('top')
    if (box.scrollTop + box.clientHeight < box.scrollHeight - 1) edges.push('bottom')
    setCut(edges.length > 0 ? edges.join(' ') : undefined)
    return () => setSnippetRanges(owner, null)
  }, [markdown, query])
  return (
    <div ref={boxRef} data-cut={cut} className="chat-search-snippet markdown-body text-sm leading-relaxed">
      <MarkdownContent content={markdown} highlight breaks={role === 'user'} />
    </div>
  )
}
